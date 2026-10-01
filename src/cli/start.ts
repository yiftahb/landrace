import { basename, join, resolve } from "node:path";
import { repositoryRoot } from "#agent/worktree.js";
import { assertConfigUsable, loadConfig, redactionValues } from "#config/load.js";
import { defineExecutor } from "#hooks/contracts.js";
import { loadHooks } from "#hooks/load.js";
import { durationMs, RECORD_EFFECT } from "#conventions.js";
import { stepTimeoutMs } from "#runner/budget.js";
import type {
  ActivityLog,
  ArtifactHook,
  Board,
  BuildOptions,
  ConversationDeps,
  EventName,
  Executor,
  ExecutorContext,
  GotoDeps,
  GotoPath,
  Graph,
  LandraceEvent,
  LoadedWorkflow,
  Node,
  PairDeps,
  Preflight,
  Problem,
  RedactingLogger,
  Registry,
  Relationship,
  RuntimeConfig,
  RuntimeContext,
  Schedule,
  Screener,
  ServerCommand,
  Source,
  StartOptions,
  ItemPanel,
  UiServer,
  WakeResult,
  WorkflowRuntime,
  WorkspaceListing,
  WorkspaceRuntime,
} from "#namespace.js";
import { createConversation } from "#mcp/conversation.js";
import { postReply } from "#mcp/tools.js";
import { createActivityLog } from "#runner/activity.js";
import { createDispatcher } from "#runner/effects.js";
import { messageOf } from "#runner/errors.js";
import { createLogger, scrubberOf } from "#runner/events.js";
import { createNotify, notifyProblems } from "#runner/notify.js";
import { createOtelSink, telemetrySettings } from "#telemetry/otel.js";
import { held } from "#runner/lock.js";
import { runPreflights } from "#runner/preflight.js";
import { buildSnapshot, snapshotProvides } from "#runner/snapshot.js";
import { sandboxRoot } from "#sandbox.js";
import { oneLine } from "#runner/status.js";
import { claimedBy, claimsOf, listingFailures, listWorkspace, reportedBy, tickWorkspace, turnedAway } from "#runner/tick.js";
import { sendTo } from "#runner/goto.js";
import { finishPair, pairingView, releasePair, startPair } from "#runner/pair.js";
import { conversationOf, createBoard } from "#ui/board.js";
import { serveBoard } from "#ui/server.js";
import { admitProblems, branchIsolationProblems, validate } from "#workflow/validate.js";
import { loadWorkspace } from "#workflow/workspace.js";
import { watchWake, wakePath } from "#wake.js";
import { STOP_SIGNALS } from "#cli/reexec.js";

/**
 * "60s", "2m", "1h" — anything else is a configuration error, not a default.
 * A bare number is the likeliest typo and the two ways of reading it are both
 * wrong: as milliseconds it polls a tracker sixty times a second, as seconds
 * it quietly means something nobody wrote down.
 */
export function parseInterval(text: string): number {
  const ms = durationMs(text);
  if (ms === null) throw new Error(`tick.interval must look like "60s", "2m" or "1h", got "${text}"`);
  return ms;
}

export const DEFAULT_UI_PORT = 4545;

export function parsePort(text: string): number {
  const port = Number(text);
  if (!/^\d+$/.test(text) || port < 1 || port > 65535) {
    throw new Error(`--ui-port must be a whole number from 1 to 65535, got "${text}"`);
  }
  return port;
}

/**
 * The triage page, or null when nobody asked for one. A taken port refuses
 * the whole start rather than running without the page: an operator who
 * expected it would otherwise have to notice it is missing.
 */
export async function startUi(
  opts: {
    board: Board; ui: boolean; once: boolean; port: number; tick?: () => WakeResult; goto?: GotoPath | undefined;
    refresh?: (() => Promise<void>) | undefined; panel?: ItemPanel | undefined;
  },
): Promise<UiServer | null> {
  if (!opts.ui || opts.once) return null;
  try {
    return await serveBoard({
      port: opts.port,
      view: () => opts.board.view(),
      ...(opts.tick === undefined ? {} : { tick: opts.tick }),
      ...(opts.goto === undefined ? {} : { goto: opts.goto }),
      ...(opts.refresh === undefined ? {} : { refresh: opts.refresh }),
      ...(opts.panel === undefined ? {} : { panel: opts.panel }),
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new Error(`port ${opts.port} is taken; pick another with --ui-port, or turn the page off with --no-ui`);
    }
    throw e;
  }
}

/**
 * The page's Retry and "Go to step…": both send the item back through the
 * one path `landrace_goto` takes, read afresh when the request arrives.
 * Undefined when no hook can write a record, so the page's server answers
 * both routes with a 404 rather than a write that could only fail.
 */
export function gotoFor(deps: GotoDeps): GotoPath | undefined {
  if (!deps.dispatcher.handlerFor(RECORD_EFFECT)) return undefined;
  return { send: (item, target, opts) => sendTo(deps, item, target, opts) };
}

/**
 * The item panel: the conversation `landrace mcp` holds, held from the
 * page instead — the same postReply, the same createConversation over the
 * tick's own source, pre hooks and dispatcher, so what the page writes is
 * what the next tick re-derives. A turn asked here is held to its step's
 * declaration, screened and sandboxed exactly as one asked through the MCP.
 *
 * A failure is said with every secret taken out: the page shows it to the
 * person who asked, and an executor's error can quote what it was handed.
 */
export function panelFor(
  deps: ConversationDeps & {
    activity: ActivityLog;
    scrub?: (text: string, extra?: readonly string[]) => string;
    /** `landrace mcp` on this workflow, handed to a pairing's session. */
    server?: ServerCommand;
    artifacts?: ArtifactHook[];
  },
): ItemPanel {
  const conversation = createConversation(deps);
  const clean = scrubberOf(deps.ctx.secrets, deps.scrub);
  const scrubbed = <T>(p: Promise<T>): Promise<T> =>
    p.catch((e: unknown) => {
      throw new Error(clean(messageOf(e)));
    });
  // The Pairing section runs through the same runner `landrace_pair` does,
  // over the tick's own source, dispatcher and lock.
  const paired = <T>(fn: (p: PairDeps) => Promise<T>): Promise<T> => {
    const { workflow, steps } = deps;
    if (!workflow || !steps) return Promise.reject(new Error("cannot pair: this process was not given the workflow"));
    return scrubbed(fn({
      source: deps.source, pre: deps.pre, dispatcher: deps.dispatcher, ctx: deps.ctx, workflow, steps,
      executor: deps.executor,
      ...(deps.screen ? { screen: deps.screen } : {}),
      ...(deps.sandbox ? { sandbox: deps.sandbox } : {}),
      ...(deps.lock ? { lock: deps.lock } : {}),
      ...(deps.server ? { server: deps.server, childServer: deps.server } : {}),
      ...(deps.artifacts ? { artifacts: deps.artifacts } : {}),
      ...(deps.scrub ? { scrub: deps.scrub } : {}),
    }));
  };
  return {
    pairing: (item) => paired((p) => pairingView(p, item)),
    pair: (item, stage) => paired((p) => startPair(p, item, stage)),
    finish: (item, note) => paired((p) => finishPair(p, item, note)),
    release: (item) => paired((p) => releasePair(p, item)),
    activity: (item, after) => deps.activity.read(item, after),
    conversation: async (item) => {
      const snapshot = await buildSnapshot({ item, source: deps.source, hooks: deps.pre, ctx: { ...deps.ctx, item } });
      return conversationOf(snapshot.entries ?? []);
    },
    reply: (item, message) => scrubbed(postReply(deps, item, message)),
    ask: (item, message) => scrubbed(conversation.ask(item, message)),
    resolve: (item) => scrubbed(conversation.resolve(item)),
  };
}

/**
 * A display must never be able to stop the work it displays. The logger is
 * called from inside runStep outside any try, so a throw here would
 * otherwise abort a paid step mid-flight. `print` always gets the event;
 * the board is best-effort, and its failure is reported via console.error —
 * never through the logger, because this sink IS the logger's output, and
 * logging from it would recurse.
 */
export function boardSink(
  print: (e: LandraceEvent) => void,
  board: { current?: Board },
): (e: LandraceEvent) => void {
  return (e) => {
    print(e);
    try {
      board.current?.observe(e);
    } catch (boardError) {
      console.error(`landrace: triage page failed to record an event: ${messageOf(boardError)}`);
    }
  };
}

/**
 * This same process, started again as `landrace mcp`: the node binary, its
 * own flags (type stripping, --import), the CLI entry, and the workspace
 * directory made absolute so the agent's cwd cannot move it.
 */
export function childServerCommand(dir: string, workflowId: string): ServerCommand {
  return {
    command: process.execPath,
    args: [...process.execArgv, process.argv[1] ?? "landrace", "mcp", "--workspace", resolve(dir), "--workflow", workflowId],
  };
}

/**
 * Per runtime context, the executors already built, so each factory runs
 * once — a runtime whose steps and screener name the same executor reads its
 * settings, and registers its secrets, once. Keyed by the context object
 * itself rather than by anything in it: `executorFor` and `screenerFor` are
 * called from more than one process (the loop, `landrace mcp`), each with its
 * own context, and there is no other key that would not conflate them.
 */
const built = new WeakMap<ExecutorContext, Map<string, Promise<Executor>>>();

/**
 * The executor `agent.adapter` names, or the screener's own — resolved from
 * the loaded hooks alone, the engine having none of its own to fall back on.
 * A name nothing answers to is a startup error rather than a loop that runs
 * happily and then fails at its first invocation, hours in and one paid tick
 * at a time, on an item that has already been moved.
 */
export async function executorFor(
  config: RuntimeConfig,
  registry: Registry,
  ctx: ExecutorContext,
  opts: {
    /**
     * The id to resolve instead of `agent.adapter`, and the key it came from,
     * which is what a name nothing answers to is reported under. Only the
     * screener's: `security.adapter`, see `screenerFor`.
     */
    adapter?: { key: string; id: string };
  } = {},
): Promise<Executor> {
  const { key, id } = opts.adapter ?? { key: "agent.adapter", id: config.agent.adapter };
  const hook = registry.executors.get(id);

  // Only a factory's build is cached — and it has to be, because `create` is
  // async and may only be run once: the settings, the log and the secrets it
  // registers are registered once. A plain hook Executor is already built, so
  // returning it needs no cache of its own.
  if (hook && "create" in hook) {
    const cache = built.get(ctx) ?? new Map<string, Promise<Executor>>();
    built.set(ctx, cache);
    const cached = cache.get(id);
    if (cached) return cached;
    const made = (async () => {
      try {
        // Typed, but a hook is JavaScript by the time it runs: a factory that
        // returned nothing used to start the loop, and the first paid step
        // met "run is not a function" on an item it had already moved.
        const made: unknown = await hook.create(ctx);
        const run = (made as { run?: unknown } | null | undefined)?.run;
        if (typeof run !== "function") throw new Error("its factory returned no run function");
        // Optional, and only what the factory built: pairing is offered
        // where this is present, and nowhere else.
        const handoff = (made as { handoff?: unknown }).handoff;
        return {
          id, run: run as Executor["run"],
          ...(typeof handoff === "function" ? { handoff: handoff as NonNullable<Executor["handoff"]> } : {}),
        };
      } catch (e) {
        throw new Error(`executor "${id}" could not start: ${messageOf(e)}`);
      }
    })();
    cache.set(id, made);
    return made;
  }
  if (hook) return hook;
  throw new Error(unknownExecutor(key, id, registry));
}

const unknownExecutor = (key: string, id: string, registry: Registry): string => {
  const registered = [...registry.executors.keys()];
  return `${key} "${id}" names no executor: the loaded hooks register ` +
    (registered.length ? registered.map((r) => `"${r}"`).join(", ") : "none");
};

/** The id a read-only runtime would run steps with, checked but never built: `landrace status` starts no agent. */
export function registeredExecutor(config: RuntimeConfig, registry: Registry): string {
  const id = config.agent.adapter;
  if (!registry.executors.has(id)) throw new Error(unknownExecutor("agent.adapter", id, registry));
  return id;
}

/**
 * The screener, or none when `security.screen` is off.
 *
 * Resolved through `executorFor`'s own lookup, so a name nothing answers to
 * fails at startup here as it does for the steps. It used to construct the
 * engine's own executor unconditionally, so a workflow whose hook registers
 * an executor screened with something the operator never configured — or,
 * with no coding agent on the machine, did not screen at all while reporting
 * that it did. §15 calls screening a security control, and a security
 * control that silently ignores its configuration is the kind this codebase
 * refuses to ship: the model now travels on every run (`Screener`), and it
 * has no default — a model name is a provider's word, and the engine names
 * no provider.
 */
export async function screenerFor(config: RuntimeConfig, registry: Registry, ctx: ExecutorContext): Promise<Screener | undefined> {
  if (!config.security.screen) return undefined;
  const adapter = config.security.adapter;
  const executor = await executorFor(config, registry, ctx, adapter === undefined ? {} : { adapter: { key: "security.adapter", id: adapter } });
  return { executor, model: config.security.model };
}

/**
 * Where an agent runs, resolved before the first request goes out.
 *
 * `container` is refused rather than quietly downgraded to a worktree: an
 * operator who asked for process isolation and silently got filesystem
 * isolation is the exact shape of "declared but not enforced" this engine has
 * to refuse.
 *
 * Shared with the MCP plane rather than re-derived there. A conversation turn
 * is an agent invocation on the same session as a step, under the same
 * declared capabilities, and the sandbox is what makes those capabilities
 * checkable at all — two answers to "is there one" would mean one of the two
 * invocations running loose in the operator's own checkout.
 */
export async function sandboxFor(config: RuntimeConfig, dir: string): Promise<{ root: string } | null> {
  const { isolation } = config.agent;
  if (isolation === "container") {
    throw new Error(
      'agent.isolation: container is not implemented in v1. Use "worktree" for filesystem ' +
      'isolation, or "none" to run the agent in this checkout.',
    );
  }
  return isolation === "worktree" ? { root: await repositoryRoot(dir) } : null;
}

/**
 * The step executor of a runtime built only to read. Its id is still checked
 * against the registry through `registeredExecutor`, so `status` refuses an
 * adapter nothing answers to exactly as `start` does; it just never builds
 * one — a factory's `create` can read `.mcp.json` and run `git rev-parse`,
 * and `landrace status` must make neither write nor call while only reading.
 */
function readOnlyExecutor(id: string): Executor {
  return defineExecutor({
    id,
    run: () => Promise.reject(new Error("this runtime was built to read items, not to run steps")),
  });
}

/**
 * The triage page's header chip: the repository checkout landrace is
 * actually running in, and its own name.
 *
 * Falls back to `process.cwd()` outside a repository — a different answer
 * from `sandboxFor`/`repositoryRoot` above, which refuse instead, because a
 * worktree isolates a step against a *repository* and there is nothing to
 * isolate against without one. The page has nothing to isolate; it would
 * rather show the directory it is actually reading than refuse to render.
 */
export async function repoWorkspace(dir: string): Promise<{ folder: string; workspace: string }> {
  const workspace = await repositoryRoot(dir).catch(() => process.cwd());
  return { folder: basename(workspace), workspace };
}

/**
 * Every workflow's problems, or nothing: the refusal names each workflow by
 * its folder, so an operator knows which `workflow.yaml` to open.
 */
function refuseUnsound(dir: string, problems: Array<[id: string, problems: Problem[]]>): void {
  const lines = problems.flatMap(([id, found]) => found.map((p) => `  workflows/${id}: ${p.rule}: ${p.message}`));
  if (lines.length) throw new Error(`the workspace in ${dir} does not validate; run \`landrace validate ${dir}\`:\n${lines.join("\n")}`);
}

/**
 * Read the workspace and assemble a runnable loop out of every workflow in
 * it, or refuse with the reason.
 *
 * Everything that can be known before the first request goes out is checked
 * here — secrets resolve, the redaction list means something, each workflow
 * is sound, its hooks load, the executor the configuration names can start —
 * because the alternative is finding out one item at a time against a live
 * repository.
 *
 * One logger, one context, one stop signal and one map of runs for the
 * workspace; per workflow, its own deps. Two workflows that load one hook
 * module are handed the same objects by Node's module cache, and are left
 * sharing them: the tick lists a shared source once, and `runStart` runs a
 * shared preflight once.
 */
export async function buildWorkspaceRuntime(dir: string, opts: BuildOptions): Promise<WorkspaceRuntime> {
  const loaded = await loadConfig(dir);
  // Unresolved secrets, unresolved vars, and a var holding a secret's value —
  // worded once, in config/load.ts, because `landrace validate` reports the
  // same three and a daemon that checked fewer of them than the CLI would run
  // a configuration the CLI rejects.
  assertConfigUsable(dir, loaded);

  // Before anything else can log: redactionValues throws on a name no secret
  // defines and on a value too short to redact by, and both of those are the
  // operator believing the log is clean when it is not. What an executor's own
  // setup turns up — an allowlisted server's env and header values, say — is
  // not known this early; it joins the redaction set later, through
  // `ectx.redact`, once the executor factory that found it has actually run.
  //
  // Telemetry is built first so it sees the first event. Not for `landrace
  // status`, which must make no call beyond the ones reading requires.
  const otel = opts.readOnly ? null : telemetrySettings(loaded.telemetry, opts.otel);
  const telemetry = otel ? await createOtelSink(otel) : undefined;
  const log: RedactingLogger = createLogger({
    ...(opts.debug === undefined ? {} : { debug: opts.debug }),
    redactValues: redactionValues(loaded),
    ...(opts.sink === undefined ? {} : { sink: opts.sink }),
    ...(telemetry ? { exporter: telemetry.sink } : {}),
  });

  // With `vars` already substituted in: the graphs the daemon runs are the
  // graphs `landrace validate` checked, filled in from the same map.
  const ws = await loadWorkspace(dir, loaded.vars, loaded.config.workflows);

  // A workflow that cannot be proved sound must not be run against a live
  // repository: every problem validate reports is one an operator would
  // otherwise meet as a halted item with an effect already applied to it.
  // Every workflow, before any hook module is imported: importing one runs
  // its top level, and a workspace the engine has decided not to run must not
  // get that far. The isolation and admission rules only where the loop runs:
  // `landrace status` reads, and a workflow it cannot run is still one it can
  // describe.
  refuseUnsound(dir, ws.workflows.map(({ id, workflow, steps }): [string, Problem[]] => [id, [
    ...validate(workflow, steps),
    ...(opts.readOnly ? [] : [...branchIsolationProblems(workflow, loaded.config.agent.isolation), ...admitProblems(id, workflow)]),
  ]]));

  const hooked: Array<{ loaded: LoadedWorkflow; registry: Registry; source: Source }> = [];
  for (const w of ws.workflows) {
    // The hooks list lives in the workflow, not in landrace.yaml: which
    // integrations are needed is part of the workflow that needs them.
    const registry = await loadHooks({ dir: w.dir, modules: w.workflow.hooks ?? [], workspace: ws.dir });
    // A notify.via nothing answers to is a notification that silently never
    // comes; `validate` reports the same words.
    const unnotified = notifyProblems(loaded.config, registry);
    if (unnotified.length) throw new Error(unnotified.map((p) => `workflows/${w.id}: ${p.rule}: ${p.message}`).join("\n"));

    /*
     * §11.8, the one rule that cannot be answered until the hooks are loaded —
     * and the reason the load stays exactly where it is rather than moving up.
     *
     * `landrace validate` unions the hooks' `provides`; a daemon that did not
     * would run a workflow the CLI rejects and meet the same fact as a halted
     * item, one live repository at a time. `snapshotProvides` abstains — for
     * the whole graph — when any loaded hook declares no `provides` at all.
     */
    refuseUnsound(dir, [[w.id, validate(w.workflow, w.steps, snapshotProvides(registry.pre, registry.source) ?? undefined)]]);

    if (!registry.source) {
      throw new Error(
        "no source hook is configured, so there is nothing to enumerate. Add a module exporting " +
        `defineSource({ ... }) to the hooks list in ${join(w.dir, "workflow.yaml")}.`,
      );
    }
    hooked.push({ loaded: w, registry, source: registry.source });
  }

  const stop = new AbortController();
  const ctx: RuntimeContext = {
    config: loaded.config,
    secrets: loaded.secretValues,
    signal: stop.signal,
    // A hook names its own events, so its log is wider than the engine's own
    // vocabulary — otherwise adding an event to a hook would mean editing the
    // engine's EventName union.
    log: (event, data) => log(event as EventName, data),
  };

  // Resolved here, before the first poll, for the same reason everything else
  // in this function is: a loop started outside a repository would otherwise
  // assemble, run, and fail at its first paid step.
  const sandbox = await sandboxFor(loaded.config, dir);
  // What each step's agent is doing, for the page's item panel: one log for
  // the workspace, keyed by item as the locks are. Not for `landrace status`,
  // which runs no step and must write nothing.
  const activity = opts.readOnly ? undefined : createActivityLog(sandboxRoot(dir), scrubberOf(ctx.secrets, log.scrub));

  const preflights: Preflight[] = [];
  const workflows: WorkflowRuntime[] = [];
  for (const { loaded: { id, workflow, steps }, registry, source } of hooked) {
    for (const preflight of registry.preflights) if (!preflights.includes(preflight)) preflights.push(preflight);
    // An executor factory's own members, beyond what every hook gets: where its
    // repository is, a way to keep what its setup turns up out of every log
    // line from here on — an MCP server's env, say, which the configuration
    // never named and `redactionValues` above never saw — and this workflow's
    // steps, whose efforts it refuses now rather than at each step's first run.
    // A context of its own per workflow, so a factory two workflows share is
    // built once for each, against that workflow's steps (see `executorFor`).
    const ectx: ExecutorContext = { ...ctx, dir, redact: log.redact, steps };
    const screener = opts.readOnly ? undefined : await screenerFor(loaded.config, registry, ectx);
    workflows.push({
      id, name: workflow.name, description: workflow.description, source,
      deps: {
        workflow,
        steps,
        stepTimeoutMs: stepTimeoutMs(workflow),
        source,
        pre: registry.pre,
        artifacts: registry.artifacts,
        dispatcher: createDispatcher(registry.post),
        executor: opts.readOnly
          ? readOnlyExecutor(registeredExecutor(loaded.config, registry))
          : await executorFor(loaded.config, registry, ectx),
        childServer: childServerCommand(dir, id),
        ...(sandbox === null ? {} : { sandbox }),
        ...(screener ? { screen: screener } : {}),
        ctx,
        log,
        scrub: log.scrub,
        ...(activity ? { activity } : {}),
        // Not for `landrace status`: reading must not message anyone.
        ...(opts.readOnly || !loaded.config.notify ? {} : {
          notify: createNotify({
            workflow, notify: loaded.config.notify, notifiers: registry.notifiers, ctx, log, board: opts.board ?? (() => null),
          }),
        }),
      },
    });
  }

  return {
    dir,
    workflows,
    // `landrace status` builds its runtime through this same function to
    // enumerate items, and it must never write to the repository it is
    // diagnosing — so the preflights are handed back rather than run here,
    // and only `runStart` runs them.
    preflights,
    intervalMs: parseInterval(loaded.config.tick.interval),
    concurrency: loaded.config.tick.concurrency,
    stop,
    running: new Map(),
    log,
    ctx,
    ...(telemetry ? { telemetry } : {}),
  };
}

/**
 * What Ctrl-C does, and it is a choice worth stating: the work in flight is
 * cancelled and its locks released, not finished.
 *
 * A converge holds a per-item lock for as long as it runs, and a step can be
 * a ten-minute agent. "Finish the item" would mean an operator who asked to
 * stop watches it keep spending for another ten minutes; abandoning it costs
 * at most one re-invocation, because an item's whole state is re-derived from
 * the tracker on the next run and the aborted step recorded nothing. So the
 * first interrupt aborts, which stops the next pass from starting and kills
 * the agent's process group, and then waits for each item to unwind so its
 * lock comes off cleanly.
 *
 * The second one exits anyway. A lock left behind carries this pid, and
 * liveness is checked rather than waited out, so the next run reclaims it
 * immediately — but an operator pressing Ctrl-C twice wants the terminal back
 * now, and an aborted controller aborted again does nothing at all.
 */
export function createInterrupt(opts: {
  stop: AbortController;
  say?: (line: string) => void;
  exit?: (code: number) => void;
}): () => void {
  const say = opts.say ?? ((line: string) => console.error(line));
  const exit = opts.exit ?? ((code: number) => process.exit(code));

  return () => {
    if (opts.stop.signal.aborted) {
      say("landrace: stopping now. Locks this process holds are left behind; they name its pid, so the next run reclaims them.");
      exit(130);
      return;
    }
    opts.stop.abort();
    say(
      "landrace: stopping — nothing new starts, the agent runs in flight are cancelled, and each " +
      "item's lock comes off as it unwinds. Ctrl-C again to exit now.",
    );
  };
}

function onSignals(handler: () => void): () => void {
  for (const signal of STOP_SIGNALS) process.on(signal, handler);
  return () => {
    for (const signal of STOP_SIGNALS) process.off(signal, handler);
  };
}

/**
 * A self-rescheduling timer in place of `setInterval`, so a wake can restart
 * the countdown without leaving the old interval also armed.
 *
 * The next scheduled fire is armed the moment a tick *starts*, not when it
 * resolves — exactly what `setInterval` did, and what keeps a scheduled tick
 * landing on time even while an earlier one is still running. `run` is handed
 * to us already caught (`trackedRun` does that), so nothing here needs a
 * try/catch of its own.
 */
export function createSchedule(opts: {
  intervalMs: number;
  run: () => Promise<void>;
  now?: () => number;
}): Schedule {
  const now = opts.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let nextAtValue: number | null = null;
  // Every run this schedule started, scheduled or woken, still in flight. A
  // scheduled fire never looks at it — the "scheduled ticks may still
  // overlap" rule — but a wake does: a person's action lands in the pass
  // after the one in flight, which may have read the tracker before it.
  //
  // ponytail: a pass lasts as long as its longest step, so while any agent
  // runs, a wake waits for that pass to end — at worst a step's timeout, or
  // the next scheduled tick, which still overlaps. The upgrade is to queue
  // only behind a pass that has not listed the tracker yet, and start one
  // now once every pass in flight has.
  let running = 0;
  // Wakes that arrived while something ran, collapsed into one follow-up.
  let pending = false;
  // Once stop() has run, nothing here may arm a new timer again — not the
  // scheduled path, not a wake. Without this, a click on the page during
  // shutdown re-armed a schedule the daemon believed it had already torn
  // down: a fresh setTimeout kept the process alive until a second Ctrl-C.
  let stopped = false;

  const arm = (): void => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    nextAtValue = now() + opts.intervalMs;
    timer = setTimeout(fire, opts.intervalMs);
  };

  const begin = (): void => {
    running += 1;
    void opts.run().finally(() => {
      running -= 1;
      if (running === 0 && pending && !stopped) {
        pending = false;
        begin();
        arm();
      }
    });
  };

  const fire = (): void => {
    if (stopped) return;
    arm();
    begin();
  };

  return {
    start(): void {
      begin();
      arm();
    },
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      nextAtValue = null;
    },
    nextAt(): number | null {
      return nextAtValue;
    },
    wake() {
      if (stopped) return "stopped";
      if (running > 0) {
        pending = true;
        return "queued";
      }
      begin();
      arm();
      return "started";
    },
  };
}

/**
 * Every listed graph as one, for the page, which still draws a single board:
 * each node once by id, each edge once. An id two sources report is a clash
 * the tick works neither way; which of its two nodes the page draws is
 * display only, until the board learns workflows.
 */
export function unionOf(graphs: readonly Graph[]): Graph {
  const nodes = new Map<string, Node>();
  const edges = new Map<string, Relationship>();
  for (const graph of graphs) {
    for (const node of graph.nodes) if (!nodes.has(node.id)) nodes.set(node.id, node);
    for (const edge of graph.relationships) edges.set(JSON.stringify([edge.from, edge.to, edge.type]), edge);
  }
  return { nodes: [...nodes.values()], relationships: [...edges.values()] };
}

/**
 * What the page is shown of each listing. A source that could not list is
 * shown as it last listed: one tracker blip must not empty the board, and
 * `board.list` forgets every id it is not handed. Claims are judged again
 * over what is shown, for the page to route by — a tick's work is only ever
 * judged from the fresh listing. Null while a source that failed has never
 * listed at all: the page keeps the view it has.
 */
export function displayOf(workflows: readonly WorkflowRuntime[]): (listing: WorkspaceListing) => WorkspaceListing | null {
  // By source index, which every listing of one runtime shares.
  const lastGood = new Map<number, Graph>();
  return (listing) => {
    for (const [index, graph] of listing.graphs.entries()) if (!listing.failed.has(index)) lastGood.set(index, graph);
    if (listing.failed.size === 0) return listing;
    const graphs: Graph[] = [];
    for (const index of listing.graphs.keys()) {
      const graph = lastGood.get(index);
      if (!graph) return null;
      graphs.push(graph);
    }
    return { ...listing, graphs, claims: claimsOf(workflows, listing.sourceOf, graphs) };
  };
}

/**
 * The workflow the last listing gave `item` to, or the sentence refusing to
 * act on it. An item claimed twice, reported by two sources, turned away by
 * every workflow or not listed at all is refused — never routed to whichever
 * workflow happens to come first.
 */
export function ownerIn(
  rt: Pick<WorkspaceRuntime, "workflows">, listing: WorkspaceListing | undefined, item: string,
): WorkflowRuntime | { refused: string } {
  if (!listing) return { refused: `#${item} has not been listed yet; act on it after the first tick` };
  const { claims } = listing;
  const owner = claims.owner.get(item);
  const found = owner === undefined ? undefined : rt.workflows.find((w) => w.id === owner);
  if (found) return found;
  const clash = claims.clashes.get(item);
  const conflict = claims.conflicts.get(item);
  const why = clash ? reportedBy(clash) : conflict ? claimedBy(conflict) : undefined;
  if (why !== undefined) return { refused: `#${item} is ${why}; act on it after one workflow alone claims it` };
  const reasons = claims.unclaimed.get(item);
  if (reasons) return { refused: `#${item} is claimed by no workflow: ${turnedAway(reasons)}` };
  return { refused: `#${item} is not an open item the last tick listed` };
}

/** The page's Retry and "Go to step…", sent through the owning workflow's own goto. Undefined when no workflow can write a record. */
function gotoByClaim(rt: WorkspaceRuntime, ownerOf: (item: string) => WorkflowRuntime | { refused: string }): GotoPath | undefined {
  const paths = new Map(rt.workflows.map((w) => [w.id, gotoFor({
    source: w.source, pre: w.deps.pre, dispatcher: w.deps.dispatcher, ctx: w.deps.ctx, workflow: w.deps.workflow,
  })]));
  if (![...paths.values()].some((p) => p !== undefined)) return undefined;
  return {
    send: async (item, target, opts) => {
      const owner = ownerOf(item);
      if ("refused" in owner) return owner;
      const path = paths.get(owner.id);
      return path
        ? path.send(item, target, opts)
        : { refused: `#${item} belongs to ${owner.id}, which loads no hook that writes a record, so it cannot be sent back` };
    },
  };
}

/**
 * The item panel, each item's through its owning workflow's deps: a read by
 * `readOwner`, a write by `writeOwner`. Undefined for a runtime that keeps no
 * activity.
 */
function panelByClaim(
  rt: WorkspaceRuntime,
  readOwner: (item: string) => WorkflowRuntime | { refused: string },
  writeOwner: (item: string) => WorkflowRuntime | { refused: string },
): ItemPanel | undefined {
  const panels = new Map<string, ItemPanel>();
  // One log for the workspace, handed to every workflow alike and keyed by
  // item: what a step did stays readable whoever claims the item now.
  let activity: ActivityLog | undefined;
  for (const w of rt.workflows) {
    if (!w.deps.activity) continue;
    activity = w.deps.activity;
    panels.set(w.id, panelFor({
      source: w.source, pre: w.deps.pre, dispatcher: w.deps.dispatcher, ctx: w.deps.ctx,
      executor: w.deps.executor, workflow: w.deps.workflow, steps: w.deps.steps,
      ...(w.deps.sandbox ? { sandbox: w.deps.sandbox } : {}),
      ...(w.deps.screen ? { screen: w.deps.screen } : {}),
      scrub: w.deps.scrub,
      ...(w.deps.childServer ? { server: w.deps.childServer } : {}),
      ...(w.deps.artifacts ? { artifacts: w.deps.artifacts } : {}),
      activity: w.deps.activity,
    }));
  }
  const log = activity;
  if (!log) return undefined;
  const via = (ownerOf: (item: string) => WorkflowRuntime | { refused: string }) =>
    <T>(item: string, fn: (panel: ItemPanel) => Promise<T>): Promise<T> => {
      const owner = ownerOf(item);
      if ("refused" in owner) return Promise.reject(new Error(owner.refused));
      const panel = panels.get(owner.id);
      return panel ? fn(panel) : Promise.reject(new Error(`#${item} belongs to ${owner.id}, which keeps no panel`));
    };
  const read = via(readOwner);
  const write = via(writeOwner);
  return {
    activity: (item, after) => log.read(item, after),
    conversation: (item) => read(item, (p) => p.conversation(item)),
    pairing: (item) => read(item, (p) => p.pairing(item)),
    reply: (item, message) => write(item, (p) => p.reply(item, message)),
    ask: (item, message) => write(item, (p) => p.ask(item, message)),
    resolve: (item) => write(item, (p) => p.resolve(item)),
    pair: (item, stage) => write(item, (p) => p.pair(item, stage)),
    finish: (item, note) => write(item, (p) => p.finish(item, note)),
    release: (item) => write(item, (p) => p.release(item)),
  };
}

/**
 * One pass over every item, with a line per item for the person watching.
 *
 * A source that could not list fails the pass once the rest have been
 * worked: `--once` reports it by its exit code, and the loop says it on
 * stderr and carries on.
 */
async function pass(rt: WorkspaceRuntime, seen?: (listing: WorkspaceListing) => void): Promise<void> {
  let failures: string[] = [];
  const rows = await tickWorkspace({
    runtime: rt,
    onList: (listing) => {
      failures = listingFailures(listing);
      seen?.(listing);
    },
  });
  // Printed beside the log, not through it: an outcome quotes a hook's or an
  // agent's failure, which can carry what the log itself would redact.
  for (const row of rows) console.log(`#${row.item}${row.workflow === undefined ? "" : ` [${row.workflow}]`} ${rt.log.scrub(row.outcome)}`);
  if (failures.length) throw new Error(rt.log.scrub(failures.join("; ")));
}

/**
 * A schedule's `run`: one pass, tracked in `inFlight` so `loop` can wait for
 * it out on shutdown, whether the schedule fired it on time or a wake did. A
 * poll that failed is not a loop that should stop — the tracker being
 * unreachable for one tick is the ordinary case, and exiting
 * would need a person to notice and start the daemon again.
 */
function trackedRun(
  rt: WorkspaceRuntime, seen: (listing: WorkspaceListing) => void, inFlight: Set<Promise<void>>,
): () => Promise<void> {
  return () => {
    if (rt.stop.signal.aborted) return Promise.resolve();
    const running = pass(rt, seen).catch((e: unknown) => {
      console.error(`landrace: tick failed: ${oneLine(messageOf(e))}`);
    });
    inFlight.add(running);
    void running.finally(() => inFlight.delete(running));
    return running;
  };
}

/**
 * Run the schedule until asked to stop.
 *
 * Ticks fire on schedule and are allowed to overlap: mutual exclusion is per
 * item, and a global "is a tick running" guard would let one ten-minute step
 * starve every other item in the repository. `schedule` and `inFlight` are
 * built by the caller, not here — the page needs `schedule.nextAt`/`wake`
 * wired to the board and the server before this ever starts.
 */
export async function loop(rt: Pick<WorkspaceRuntime, "stop">, schedule: Schedule, inFlight: Set<Promise<void>>): Promise<void> {
  schedule.start();
  try {
    await new Promise<void>((resolve) => {
      if (rt.stop.signal.aborted) return resolve();
      rt.stop.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  } finally {
    schedule.stop();
  }

  // Each item in flight is holding its own lock, released by withLock as its
  // converge unwinds. Waiting here is the whole difference between "released"
  // and "stale until something else checks this pid".
  await Promise.all(inFlight);
}

export async function runStart(dir: string, opts: StartOptions): Promise<void> {
  // The board has to exist before the runtime does, because it listens to
  // the runtime's events. Its workflow is filled in once the runtime has
  // loaded one; until then it has nothing listed and renders nothing.
  //
  // A boxed reference, not a reassigned `let board`: nothing calls the sink
  // synchronously while the runtime is built, but `prefer-const` cannot see
  // that, and a mutable cell the closure reads through is the same fact
  // stated in a shape the linter can verify rather than one it has to trust.
  const boardRef: { current?: Board } = {};
  const print = (e: LandraceEvent): void => console.log(JSON.stringify(e));
  // What a notification links to, once the page below is up; null without one.
  const pageRef: { url: string | null } = { url: null };
  const rt = await buildWorkspaceRuntime(dir, {
    ...(opts.debug === undefined ? {} : { debug: opts.debug }),
    ...(opts.otel === undefined ? {} : { otel: opts.otel }),
    sink: boardSink(print, boardRef),
    board: () => pageRef.url,
  });

  // Before anything else the hooks might do — including `--once`'s one tick
  // — a permission problem has to stop the process here, not after the first
  // paid agent has already run and a publish 403s with nothing durable
  // recorded to show for it. Run from here rather than from the runtime's
  // build so `landrace status`, which builds one the same way, never makes
  // this write while only trying to read.
  await runPreflights(rt.preflights, rt.ctx);

  // The last listing a tick or a Refresh made, and what the page was shown
  // of it: the page's actions find an item's workflow by the second, and
  // write only when the first judged it.
  const last: { fresh?: WorkspaceListing; shown?: WorkspaceListing } = {};
  const display = displayOf(rt.workflows);
  const seen = (listing: WorkspaceListing): void => {
    last.fresh = listing;
    const shown = display(listing);
    if (!shown) return;
    last.shown = shown;
    boardRef.current?.list(unionOf(shown.graphs));
  };

  // Built before the board and the page, which both need to reach into it —
  // the board reads schedule.nextAt for the countdown, the page's writes and
  // the wake file call schedule.wake. `--once` never starts it: one tick and
  // no page means nothing here is ever armed.
  const inFlight = new Set<Promise<void>>();
  const schedule = createSchedule({ intervalMs: rt.intervalMs, run: trackedRun(rt, seen, inFlight) });

  const { folder, workspace } = await repoWorkspace(dir);
  // `loadWorkspace` refuses a workspace with none, so this is never undefined.
  const [first] = rt.workflows;
  if (!first) throw new Error(`${dir} has no workflows`);
  const board = createBoard({
    // One page, whose rows are placed by the first workflow's stages until the
    // board learns which workflow each item is in.
    workflow: first.deps.workflow, held: (t) => held(t), nextTickAt: schedule.nextAt, folder, workspace,
    // The tree nests along exactly what a source says is one-per-node — a
    // parent, the item a pull request implements — and nothing configured.
    nest: [...new Set(rt.workflows.flatMap((w) => w.source.relations.filter((r) => r.singular).map((r) => r.type)))],
  });
  boardRef.current = board;

  const readOwner = (item: string): WorkflowRuntime | { refused: string } => ownerIn(rt, last.shown, item);
  // A write needs the last listing to have judged the item itself: what a
  // failed source is shown as is its last good listing, which may be stale.
  const writeOwner = (item: string): WorkflowRuntime | { refused: string } => {
    const owner = readOwner(item);
    const failures = last.fresh ? listingFailures(last.fresh) : [];
    if ("refused" in owner || failures.length === 0) return owner;
    return { refused: rt.log.scrub(`#${item} is not written to until every source lists again: ${failures.join("; ")}`) };
  };
  const ui = await startUi({
    board, ui: opts.ui ?? true, once: opts.once ?? false, port: opts.uiPort ?? DEFAULT_UI_PORT,
    tick: schedule.wake,
    goto: gotoByClaim(rt, writeOwner),
    // Re-list every source and reload the board from it: no converge, no
    // step, no agent — the page's Refresh button.
    refresh: async () => {
      const listing = await listWorkspace(rt);
      seen(listing);
      const failures = listingFailures(listing);
      if (failures.length) throw new Error(rt.log.scrub(failures.join("; ")));
    },
    panel: panelByClaim(rt, readOwner, writeOwner),
  });
  if (ui) {
    console.error(`landrace: triage page at ${ui.url}`);
    pageRef.url = ui.url;
  }

  // What `landrace mcp` touches after a person's write, in its own process:
  // watched only where there is a loop to wake.
  const unwatch = opts.once ? null : watchWake(wakePath(dir), schedule.wake);
  const off = onSignals(createInterrupt({ stop: rt.stop }));
  try {
    // A single tick reports its own failure by throwing: one shot, one answer,
    // and the exit code is what a script that ran it will read.
    await (opts.once ? pass(rt, seen) : loop(rt, schedule, inFlight));
  } finally {
    unwatch?.();
    off();
    await ui?.close();
    // --once, a normal stop and the first Ctrl-C all come through here; the
    // batch would otherwise lose up to its whole export interval of records.
    await rt.telemetry?.shutdown();
  }
}
