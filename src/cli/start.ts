import { basename, resolve } from "node:path";
import { repositoryRoot } from "#agent/worktree.js";
import { assertConfigUsable, loadConfig, redactionValues } from "#config/load.js";
import { defineExecutor } from "#hooks/contracts.js";
import { loadHooks } from "#hooks/load.js";
import { durationMs, RECORD_EFFECT } from "#conventions.js";
import { stepTimeoutMs } from "#runner/budget.js";
import type {
  Board,
  BuildOptions,
  EventName,
  Executor,
  ExecutorContext,
  GotoDeps,
  GotoPath,
  LandraceEvent,
  Problem,
  RedactingLogger,
  Registry,
  Runtime,
  RuntimeConfig,
  RuntimeContext,
  Schedule,
  Screener,
  ServerCommand,
  StartOptions,
  UiServer,
} from "#namespace.js";
import { createDispatcher } from "#runner/effects.js";
import { messageOf } from "#runner/errors.js";
import { createLogger } from "#runner/events.js";
import { held } from "#runner/lock.js";
import { runPreflights } from "#runner/preflight.js";
import { snapshotProvides } from "#runner/snapshot.js";
import { oneLine } from "#runner/status.js";
import { tick } from "#runner/tick.js";
import { sendTo } from "#runner/goto.js";
import { createBoard } from "#ui/board.js";
import { serveBoard } from "#ui/server.js";
import { loadWorkflow } from "#workflow/load.js";
import { branchIsolationProblems, validate } from "#workflow/validate.js";
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
  opts: { board: Board; ui: boolean; once: boolean; port: number; tick?: () => boolean; goto?: GotoPath | undefined },
): Promise<UiServer | null> {
  if (!opts.ui || opts.once) return null;
  try {
    return await serveBoard({
      port: opts.port,
      view: () => opts.board.view(),
      ...(opts.tick === undefined ? {} : { tick: opts.tick }),
      ...(opts.goto === undefined ? {} : { goto: opts.goto }),
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new Error(`port ${opts.port} is taken; pick another with --ui-port, or turn the page off with --no-ui`);
    }
    throw e;
  }
}

/**
 * The page's Retry and "Go to step…": both send the ticket back through the
 * one path `landrace_goto` takes, read afresh when the request arrives.
 * Undefined when no hook can write a record, so the page's server answers
 * both routes with a 404 rather than a write that could only fail.
 */
export function gotoFor(deps: GotoDeps): GotoPath | undefined {
  if (!deps.dispatcher.handlerFor(RECORD_EFFECT)) return undefined;
  return { send: (ticket, target) => sendTo(deps, ticket, target) };
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
 * own flags (type stripping, --import), the CLI entry, and the workflow
 * directory made absolute so the agent's cwd cannot move it.
 */
export function childServerCommand(dir: string): ServerCommand {
  return {
    command: process.execPath,
    args: [...process.execArgv, process.argv[1] ?? "landrace", "mcp", "--workflow", resolve(dir)],
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
 * at a time, on a ticket that has already been moved.
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
        // met "run is not a function" on a ticket it had already moved.
        const made: unknown = await hook.create(ctx);
        const run = (made as { run?: unknown } | null | undefined)?.run;
        if (typeof run !== "function") throw new Error("its factory returned no run function");
        return { id, run: run as Executor["run"] };
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
    run: () => Promise.reject(new Error("this runtime was built to read tickets, not to run steps")),
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
 * Read the workflow directory and assemble a runnable loop out of it, or
 * refuse with the reason.
 *
 * Everything that can be known before the first request goes out is checked
 * here — secrets resolve, the redaction list means something, the workflow is
 * sound, the hooks load, the executor the configuration names can start —
 * because the alternative is finding out one ticket at a time against a live
 * repository.
 */
export async function buildRuntime(dir: string, opts: BuildOptions): Promise<Runtime> {
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
  const log: RedactingLogger = createLogger({
    ...(opts.debug === undefined ? {} : { debug: opts.debug }),
    redactValues: redactionValues(loaded),
    ...(opts.sink === undefined ? {} : { sink: opts.sink }),
  });

  // With `vars` already substituted in: the graph the daemon runs is the
  // graph `landrace validate` checked, filled in from the same map.
  const { workflow, steps } = await loadWorkflow(dir, loaded.vars);

  // A workflow that cannot be proved sound must not be run against a live
  // repository: every problem validate reports is one an operator would
  // otherwise meet as a halted ticket with an effect already applied to it.
  const refuse = (problems: Problem[]): never => {
    throw new Error(
      `the workflow in ${dir} does not validate; run \`landrace validate ${dir}\`:\n` +
      problems.map((p) => `  ${p.rule}: ${p.message}`).join("\n"),
    );
  };

  // The isolation rule only where a step can run: `landrace status` reads,
  // and a workflow it cannot run is still one it can describe.
  const problems = [
    ...validate(workflow, steps),
    ...(opts.readOnly ? [] : branchIsolationProblems(workflow, loaded.config.agent.isolation)),
  ];
  if (problems.length) refuse(problems);

  // The hooks list lives in the workflow, not in landrace.yaml: which
  // integrations are needed is part of the workflow that needs them.
  const registry = await loadHooks({ dir, modules: workflow.hooks ?? [] });

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
  // An executor factory's own two members, beyond what every hook gets: where
  // its repository is, and a way to keep what its setup turns up out of every
  // log line from here on — an MCP server's env, say, which the configuration
  // never named and `redactionValues` above never saw.
  const ectx: ExecutorContext = { ...ctx, dir, redact: log.redact };

  /*
   * §11.8, the one rule that cannot be answered until the hooks are loaded —
   * and the reason the load stays exactly where it is rather than moving up.
   *
   * `landrace validate` has unioned the hooks' `provides` since Task 14; the
   * daemon did not, so `start` would run a workflow the CLI rejects and meet
   * the same fact as a halted ticket, one live repository at a time. A
   * validator that checks less in the daemon than in the CLI is the "silently
   * stops checking" failure, one layer over.
   *
   * `snapshotProvides` abstains — for the whole graph — when any loaded hook
   * declares no `provides` at all, so this refuses nothing that started before
   * except a workflow whose hooks all say what they supply and still miss a
   * path a predicate reads.
   */
  const uncovered = validate(workflow, steps, snapshotProvides(registry.pre, registry.source) ?? undefined);
  if (uncovered.length) refuse(uncovered);

  if (!registry.source) {
    throw new Error(
      "no source hook is configured, so there is nothing to enumerate. Add a module exporting " +
      `defineSource({ ... }) to the hooks list in ${dir}/workflow.yaml.`,
    );
  }

  // Resolved here, before the first poll, for the same reason everything else
  // in this function is: a loop started outside a repository would otherwise
  // assemble, run, and fail at its first paid step.
  const sandbox = await sandboxFor(loaded.config, dir);
  const screener = opts.readOnly ? undefined : await screenerFor(loaded.config, registry, ectx);

  return {
    source: registry.source,
    // `landrace status` builds a Runtime through this same function to
    // enumerate tickets, and it must never write to the repository it is
    // diagnosing — so the preflights are handed back rather than run here,
    // and only `runStart` runs them. Left unrun, they are only a fact about
    // what the hooks declared: nothing has been checked yet.
    preflights: registry.preflights,
    deps: {
      workflow,
      steps,
      stepTimeoutMs: stepTimeoutMs(workflow),
      source: registry.source,
      pre: registry.pre,
      artifacts: registry.artifacts,
      dispatcher: createDispatcher(registry.post),
      executor: opts.readOnly
        ? readOnlyExecutor(registeredExecutor(loaded.config, registry))
        : await executorFor(loaded.config, registry, ectx),
      childServer: childServerCommand(dir),
      ...(sandbox === null ? {} : { sandbox }),
      ...(screener ? { screen: screener } : {}),
      ctx,
      log,
      scrub: log.scrub,
    },
    intervalMs: parseInterval(loaded.config.tick.interval),
    concurrency: loaded.config.tick.concurrency,
    stop,
  };
}

/**
 * What Ctrl-C does, and it is a choice worth stating: the work in flight is
 * cancelled and its locks released, not finished.
 *
 * A converge holds a per-ticket lock for as long as it runs, and a step can be
 * a ten-minute agent. "Finish the ticket" would mean an operator who asked to
 * stop watches it keep spending for another ten minutes; abandoning it costs
 * at most one re-invocation, because a ticket's whole state is re-derived from
 * the tracker on the next run and the aborted step recorded nothing. So the
 * first interrupt aborts, which stops the next pass from starting and kills
 * the agent's process group, and then waits for each ticket to unwind so its
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
      "ticket's lock comes off as it unwinds. Ctrl-C again to exit now.",
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
 * A self-rescheduling timer in place of `setInterval`, so a manual tick can
 * restart the countdown without leaving the old interval also armed.
 *
 * The next scheduled fire is armed the moment a tick *starts*, not when it
 * resolves — exactly what `setInterval` did, and what keeps a scheduled tick
 * landing on time even while an earlier one is still running. `run` is handed
 * to us already caught (`loop`'s `begin` does that), so nothing here needs a
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
  // Only a manual tick is exclusive with itself; a scheduled one never waits
  // on this, which is the "scheduled ticks may still overlap" rule.
  let manualInFlight: Promise<void> | null = null;
  // Once stop() has run, nothing here may arm a new timer again — not the
  // scheduled path, not a manual trigger(). Without this, a click on the
  // page during shutdown re-armed a schedule the daemon believed it had
  // already torn down: trigger() returned true, set a fresh setTimeout, and
  // the process stayed alive until a second Ctrl-C caught it.
  let stopped = false;

  const arm = (): void => {
    if (stopped) return;
    nextAtValue = now() + opts.intervalMs;
    timer = setTimeout(fire, opts.intervalMs);
  };

  const fire = (): void => {
    if (stopped) return;
    arm();
    void opts.run();
  };

  return {
    start(): void {
      void opts.run();
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
    trigger(): boolean {
      if (stopped) return false;
      if (manualInFlight) return false;
      if (timer) clearTimeout(timer);
      const running = opts.run().finally(() => {
        manualInFlight = null;
      });
      manualInFlight = running;
      arm();
      return true;
    },
  };
}

/** One pass over every ticket, with a line per ticket for the person watching. */
async function pass(rt: Runtime, board?: Board): Promise<void> {
  const rows = await tick({
    source: rt.source, deps: rt.deps, concurrency: rt.concurrency,
    ...(board ? { onList: (graph) => board.list(graph) } : {}),
  });
  // Printed beside the log, not through it: an outcome quotes a hook's or an
  // agent's failure, which can carry what the log itself would redact.
  for (const row of rows) console.log(`#${row.ticket} ${rt.deps.scrub(row.outcome)}`);
}

/**
 * A schedule's `run`: one pass, tracked in `inFlight` so `loop` can wait for
 * it out on shutdown, whether the schedule fired it on time or a manual
 * trigger() did. A poll that failed is not a loop that should stop — the
 * tracker being unreachable for one tick is the ordinary case, and exiting
 * would need a person to notice and start the daemon again.
 */
function trackedRun(rt: Runtime, board: { current?: Board }, inFlight: Set<Promise<void>>): () => Promise<void> {
  return () => {
    if (rt.stop.signal.aborted) return Promise.resolve();
    const running = pass(rt, board.current).catch((e: unknown) => {
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
 * ticket, and a global "is a tick running" guard would let one ten-minute step
 * starve every other ticket in the repository. `schedule` and `inFlight` are
 * built by the caller, not here — the page needs `schedule.nextAt`/`trigger`
 * wired to the board and the server before this ever starts.
 */
export async function loop(rt: Runtime, schedule: Schedule, inFlight: Set<Promise<void>>): Promise<void> {
  schedule.start();
  try {
    await new Promise<void>((resolve) => {
      if (rt.stop.signal.aborted) return resolve();
      rt.stop.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  } finally {
    schedule.stop();
  }

  // Each ticket in flight is holding its own lock, released by withLock as its
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
  // synchronously while buildRuntime runs, but `prefer-const` cannot see
  // that, and a mutable cell the closure reads through is the same fact
  // stated in a shape the linter can verify rather than one it has to trust.
  const boardRef: { current?: Board } = {};
  const print = (e: LandraceEvent): void => console.log(JSON.stringify(e));
  const rt = await buildRuntime(dir, {
    ...(opts.debug === undefined ? {} : { debug: opts.debug }),
    sink: boardSink(print, boardRef),
  });

  // Before anything else the hooks might do — including `--once`'s one tick
  // — a permission problem has to stop the process here, not after the first
  // paid agent has already run and a publish 403s with nothing durable
  // recorded to show for it. Run from here rather than from `buildRuntime`
  // itself so `landrace status`, which builds a Runtime the same way, never
  // makes this write while only trying to read.
  await runPreflights(rt.preflights, rt.deps.ctx);

  // Built before the board and the page, which both need to reach into it —
  // the board reads schedule.nextAt for the countdown, the page's one write
  // calls schedule.trigger. `--once` never starts it: one tick and no page
  // means nothing here is ever armed.
  const inFlight = new Set<Promise<void>>();
  const schedule = createSchedule({ intervalMs: rt.intervalMs, run: trackedRun(rt, boardRef, inFlight) });

  const { folder, workspace } = await repoWorkspace(dir);
  const board = createBoard({
    workflow: rt.deps.workflow, held: (t) => held(t), nextTickAt: schedule.nextAt, folder, workspace,
    // The tree nests along exactly what the source says is one-per-node — a
    // parent, the ticket a pull request implements — and nothing configured.
    nest: rt.source.relations.filter((r) => r.singular).map((r) => r.type),
  });
  boardRef.current = board;

  const ui = await startUi({
    board, ui: opts.ui ?? true, once: opts.once ?? false, port: opts.uiPort ?? DEFAULT_UI_PORT,
    tick: schedule.trigger,
    goto: gotoFor({ source: rt.source, pre: rt.deps.pre, dispatcher: rt.deps.dispatcher, ctx: rt.deps.ctx, workflow: rt.deps.workflow }),
  });
  if (ui) console.error(`landrace: triage page at ${ui.url}`);

  const off = onSignals(createInterrupt({ stop: rt.stop }));
  try {
    // A single tick reports its own failure by throwing: one shot, one answer,
    // and the exit code is what a script that ran it will read.
    await (opts.once ? pass(rt, board) : loop(rt, schedule, inFlight));
  } finally {
    off();
    await ui?.close();
  }
}
