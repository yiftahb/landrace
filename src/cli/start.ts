import { createClaudeExecutor, DEFAULT_STEP_TIMEOUT_MS } from "#agent/claude.js";
import { repositoryRoot } from "#agent/worktree.js";
import { assertConfigUsable, loadConfig, redactionValues } from "#config/load.js";
import { loadHooks } from "#hooks/load.js";
import type {
  Board,
  BuildOptions,
  EventName,
  Executor,
  LandraceEvent,
  Logger,
  Problem,
  Registry,
  Runtime,
  RuntimeConfig,
  Schedule,
  StartOptions,
  UiServer,
  Workflow,
} from "#namespace.js";
import { createDispatcher } from "#runner/effects.js";
import { messageOf } from "#runner/errors.js";
import { createLogger } from "#runner/events.js";
import { held } from "#runner/lock.js";
import { snapshotProvides } from "#runner/snapshot.js";
import { oneLine } from "#runner/status.js";
import { tick } from "#runner/tick.js";
import { createBoard } from "#ui/board.js";
import { serveBoard } from "#ui/server.js";
import { loadWorkflow } from "#workflow/load.js";
import { validate } from "#workflow/validate.js";
import { STOP_SIGNALS } from "#cli/reexec.js";

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 };

/**
 * "60s", "2m", "1h" — anything else is a configuration error, not a default.
 * A bare number is the likeliest typo and the two ways of reading it are both
 * wrong: as milliseconds it polls a tracker sixty times a second, as seconds
 * it quietly means something nobody wrote down.
 */
export function parseInterval(text: string): number {
  const m = /^(\d+)(s|m|h)$/.exec(text.trim());
  const unit = m?.[2] === undefined ? undefined : UNITS[m[2]];
  if (!m || unit === undefined) {
    throw new Error(`tick.interval must look like "60s", "2m" or "1h", got "${text}"`);
  }
  return Number(m[1]) * unit;
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
export async function startUi(opts: { board: Board; ui: boolean; once: boolean; port: number }): Promise<UiServer | null> {
  if (!opts.ui || opts.once) return null;
  try {
    return await serveBoard({ port: opts.port, view: () => opts.board.view() });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new Error(`port ${opts.port} is taken; pick another with --ui-port, or turn the page off with --no-ui`);
    }
    throw e;
  }
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
 * How long one step may run, taken from the workflow that owns the process
 * rather than from a default that happens to match it.
 *
 * `budget.stepTimeout` is 10m in the shipped workflow and `createClaudeExecutor`'s
 * own default was 10m, so the two agreed by coincidence: editing the operator's
 * number changed nothing, and the file was decoration. A value that cannot be
 * read throws rather than falling back — `stepTimeout: 600` looks like it says
 * something, and quietly meaning ten minutes instead is how a cap nobody
 * applied goes on reading as applied.
 */
export function stepTimeoutMs(workflow: Workflow): number {
  const declared = workflow.budget?.["stepTimeout"];
  if (declared === undefined) return DEFAULT_STEP_TIMEOUT_MS;
  if (typeof declared !== "string") {
    throw new Error(`budget.stepTimeout must be a duration like "10m", got ${JSON.stringify(declared)}`);
  }
  try {
    return parseInterval(declared);
  } catch {
    throw new Error(`budget.stepTimeout must look like "60s", "2m" or "1h", got "${declared}"`);
  }
}

/**
 * The one id the engine still resolves by name.
 *
 * A hook module can register executors of its own, and the engine ships one.
 * A name nothing answers to is a startup error rather than a loop that runs
 * happily and then fails at its first invocation — hours in, one paid tick at
 * a time, on a ticket that has already been moved.
 */
export function executorFor(
  config: RuntimeConfig,
  workflow: Workflow,
  registry: Registry,
  log: Logger,
  /**
   * Which model the *engine's own* executor should use — `security.model` when
   * this is the screener. A hook's executor chose its model when the hook
   * built it, and no id here can change that; what matters is that screening
   * resolves through this same lookup at all. It used to construct a claude
   * executor unconditionally, so a workflow whose hook registers an executor
   * screened with something the operator never configured — or, with no claude
   * on the machine, did not screen at all while reporting that it did. §15
   * calls screening a security control, and a security control that silently
   * ignores its configuration is the kind this codebase refuses to ship.
   */
  model: string | undefined = config.agent.model,
): Executor {
  // A hook's executor is constructed by the hook, so the budget cannot reach
  // it: the engine has a number and no way to hand it over. Enforcing one out
  // here would mean holding a stopwatch over somebody else's subprocess with
  // no way to kill it — so a hook owns its own timeout, and says so.
  const fromHook = registry.executors.get(config.agent.adapter);
  if (fromHook) return fromHook;
  if (config.agent.adapter === "claude") {
    return createClaudeExecutor({
      ...(model === undefined ? {} : { model }),
      timeoutMs: stepTimeoutMs(workflow),
      log,
    });
  }
  const registered = [...registry.executors.keys()];
  throw new Error(
    `agent.adapter "${config.agent.adapter}" names no executor: the engine ships "claude", and the ` +
    `loaded hooks register ${registered.length ? registered.map((id) => `"${id}"`).join(", ") : "none"}`,
  );
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
 * Read the workflow directory and assemble a runnable loop out of it, or
 * refuse with the reason.
 *
 * Everything that can be known before the first request goes out is checked
 * here — secrets resolve, the redaction list means something, the workflow is
 * sound, the hooks load, the agent exists — because the alternative is finding
 * out one ticket at a time against a live repository.
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
  // operator believing the log is clean when it is not.
  const log = createLogger({
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

  const problems = validate(workflow, steps);
  if (problems.length) refuse(problems);

  // The hooks list lives in the workflow, not in landrace.yaml: which
  // integrations are needed is part of the workflow that needs them.
  const registry = await loadHooks({ dir, modules: workflow.hooks ?? [] });

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
  const uncovered = validate(workflow, steps, snapshotProvides(registry.pre) ?? undefined);
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

  const stop = new AbortController();

  return {
    source: registry.source,
    deps: {
      workflow,
      steps,
      pre: registry.pre,
      artifacts: registry.artifacts,
      dispatcher: createDispatcher(registry.post),
      executor: executorFor(loaded.config, workflow, registry, log),
      ...(sandbox === null ? {} : { sandbox }),
      ...(loaded.config.security.screen
        ? { screen: { executor: executorFor(loaded.config, workflow, registry, log, loaded.config.security.model) } }
        : {}),
      ctx: {
        config: loaded.config,
        secrets: loaded.secretValues,
        signal: stop.signal,
        // A hook names its own events, so its log is wider than the engine's
        // own vocabulary — otherwise adding an event to a hook would mean
        // editing the engine's EventName union.
        log: (event, data) => log(event as EventName, data),
      },
      log,
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

  const arm = (): void => {
    nextAtValue = now() + opts.intervalMs;
    timer = setTimeout(fire, opts.intervalMs);
  };

  const fire = (): void => {
    arm();
    void opts.run();
  };

  return {
    start(): void {
      void opts.run();
      arm();
    },
    stop(): void {
      if (timer) clearTimeout(timer);
      timer = null;
      nextAtValue = null;
    },
    nextAt(): number | null {
      return nextAtValue;
    },
    trigger(): boolean {
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

/** One pass over every candidate, with a line per ticket for the person watching. */
async function pass(rt: Runtime, board?: Board): Promise<void> {
  const rows = await tick({
    source: rt.source, deps: rt.deps, concurrency: rt.concurrency,
    ...(board ? { onList: (c) => board.list(c) } : {}),
  });
  for (const row of rows) console.log(`#${row.ticket} ${row.outcome}`);
}

/**
 * Poll until asked to stop.
 *
 * Ticks fire on schedule and are allowed to overlap: mutual exclusion is per
 * ticket, and a global "is a tick running" guard would let one ten-minute step
 * starve every other ticket in the repository.
 */
async function loop(rt: Runtime, board?: Board): Promise<void> {
  const inFlight = new Set<Promise<void>>();

  const begin = (): void => {
    if (rt.stop.signal.aborted) return;
    const running = pass(rt, board).catch((e: unknown) => {
      // A poll that failed is not a loop that should stop. The tracker being
      // unreachable for one tick is the ordinary case, and exiting would need
      // a person to notice and start the daemon again.
      console.error(`landrace: tick failed: ${oneLine(messageOf(e))}`);
    });
    inFlight.add(running);
    void running.finally(() => inFlight.delete(running));
  };

  begin();
  const timer = setInterval(begin, rt.intervalMs);
  try {
    await new Promise<void>((resolve) => {
      if (rt.stop.signal.aborted) return resolve();
      rt.stop.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  } finally {
    clearInterval(timer);
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
  const board = createBoard({ workflow: rt.deps.workflow, held: (t) => held(t) });
  boardRef.current = board;

  const ui = await startUi({ board, ui: opts.ui ?? true, once: opts.once ?? false, port: opts.uiPort ?? DEFAULT_UI_PORT });
  if (ui) console.error(`landrace: triage page at ${ui.url}`);

  const off = onSignals(createInterrupt({ stop: rt.stop }));
  try {
    // A single tick reports its own failure by throwing: one shot, one answer,
    // and the exit code is what a script that ran it will read.
    await (opts.once ? pass(rt, board) : loop(rt, board));
  } finally {
    off();
    await ui?.close();
  }
}
