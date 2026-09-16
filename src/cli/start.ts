import { createClaudeExecutor } from "../agent/claude.js";
import { loadConfig, redactionValues } from "../config/load.js";
import type { RuntimeConfig } from "../config/schema.js";
import { loadHooks, type Registry } from "../hooks/load.js";
import type { Executor, RuntimeContext, Source } from "../hooks/types.js";
import type { ConvergeDeps } from "../runner/converge.js";
import { createDispatcher } from "../runner/effects.js";
import { messageOf } from "../runner/errors.js";
import { createLogger, type EventName, type LandraceEvent, type Logger } from "../runner/events.js";
import { oneLine } from "../runner/status.js";
import { tick } from "../runner/tick.js";
import { loadWorkflow } from "../workflow/load.js";
import { validate } from "../workflow/validate.js";
import { STOP_SIGNALS } from "./reexec.js";

/** Everything the loop needs, assembled once, so a tick is only a call. */
export interface Runtime {
  /** Where the work comes from. Required: a loop with nothing to enumerate can never do anything. */
  source: Source;
  deps: Omit<ConvergeDeps, "ctx"> & { ctx: RuntimeContext };
  intervalMs: number;
  concurrency: number;
  /**
   * Ctrl-C. The same signal every hook and executor is handed, so aborting it
   * stops the agent subprocess, stops the next pass from starting, and lets
   * each ticket unwind through the lock it holds.
   */
  stop: AbortController;
}

export interface StartOptions {
  once?: boolean;
  debug?: boolean;
}

export interface BuildOptions {
  debug?: boolean;
  /** Where events go. `landrace status` sends them to stderr, because stdout is its report. */
  sink?: (event: LandraceEvent) => void;
}

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

/**
 * The one id the engine still resolves by name.
 *
 * A hook module can register executors of its own, and the engine ships one.
 * A name nothing answers to is a startup error rather than a loop that runs
 * happily and then fails at its first invocation — hours in, one paid tick at
 * a time, on a ticket that has already been moved.
 */
function executorFor(config: RuntimeConfig, registry: Registry, log: Logger): Executor {
  const fromHook = registry.executors.get(config.agent.adapter);
  if (fromHook) return fromHook;
  if (config.agent.adapter === "claude") {
    return createClaudeExecutor({ ...(config.agent.model === undefined ? {} : { model: config.agent.model }), log });
  }
  const registered = [...registry.executors.keys()];
  throw new Error(
    `agent.adapter "${config.agent.adapter}" names no executor: the engine ships "claude", and the ` +
    `loaded hooks register ${registered.length ? registered.map((id) => `"${id}"`).join(", ") : "none"}`,
  );
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
  if (loaded.missing.length) {
    throw new Error(`secret(s) do not resolve: ${loaded.missing.join(", ")}. Set them in ${dir}/.env`);
  }

  // Before anything else can log: redactionValues throws on a name no secret
  // defines and on a value too short to redact by, and both of those are the
  // operator believing the log is clean when it is not.
  const log = createLogger({
    ...(opts.debug === undefined ? {} : { debug: opts.debug }),
    redactValues: redactionValues(loaded),
    ...(opts.sink === undefined ? {} : { sink: opts.sink }),
  });

  const { workflow, steps } = await loadWorkflow(dir);
  const problems = validate(workflow, steps);
  if (problems.length) {
    // A workflow that cannot be proved sound must not be run against a live
    // repository: every problem validate reports is one an operator would
    // otherwise meet as a halted ticket with an effect already applied to it.
    throw new Error(
      `the workflow in ${dir} does not validate; run \`landrace validate ${dir}\`:\n` +
      problems.map((p) => `  ${p.rule}: ${p.message}`).join("\n"),
    );
  }

  // The hooks list lives in the workflow, not in landrace.yaml: which
  // integrations are needed is part of the workflow that needs them.
  const registry = await loadHooks({ dir, modules: workflow.hooks ?? [] });
  if (!registry.source) {
    throw new Error(
      "no source hook is configured, so there is nothing to enumerate. Add a module exporting " +
      `defineSource({ ... }) to the hooks list in ${dir}/workflow.yaml.`,
    );
  }

  const stop = new AbortController();

  return {
    source: registry.source,
    deps: {
      workflow,
      steps,
      pre: registry.pre,
      dispatcher: createDispatcher(registry.post),
      executor: executorFor(loaded.config, registry, log),
      ...(loaded.config.security.screen
        ? { screen: { executor: createClaudeExecutor({ model: loaded.config.security.model, log }) } }
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

/** One pass over every candidate, with a line per ticket for the person watching. */
async function pass(rt: Runtime): Promise<void> {
  const rows = await tick({ source: rt.source, deps: rt.deps, concurrency: rt.concurrency });
  for (const row of rows) console.log(`#${row.ticket} ${row.outcome}`);
}

/**
 * Poll until asked to stop.
 *
 * Ticks fire on schedule and are allowed to overlap: mutual exclusion is per
 * ticket, and a global "is a tick running" guard would let one ten-minute step
 * starve every other ticket in the repository.
 */
async function loop(rt: Runtime): Promise<void> {
  const inFlight = new Set<Promise<void>>();

  const begin = (): void => {
    if (rt.stop.signal.aborted) return;
    const running = pass(rt).catch((e: unknown) => {
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
  const rt = await buildRuntime(dir, opts.debug === undefined ? {} : { debug: opts.debug });
  const off = onSignals(createInterrupt({ stop: rt.stop }));
  try {
    // A single tick reports its own failure by throwing: one shot, one answer,
    // and the exit code is what a script that ran it will read.
    await (opts.once ? pass(rt) : loop(rt));
  } finally {
    off();
  }
}
