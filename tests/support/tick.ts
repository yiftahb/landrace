import type { ConvergeDeps, Graph, LockOptions, RunningItem, RuntimeContext, Source, TickRow } from "#namespace.js";
import { scrubberOf } from "#runner/events.js";
import { listingFailures, tickWorkspace } from "#runner/tick.js";

/** The workflow id a one-workflow tick runs its items under. */
export const ONLY = "main";

export interface TickOptions {
  source: Source;
  /** Without a source of its own: converge reads the tick's, so one tick cannot enumerate from one source and decide from another. */
  deps: Omit<ConvergeDeps, "ctx" | "source"> & { ctx: RuntimeContext };
  concurrency?: number;
  lock?: LockOptions;
  running?: Map<string, RunningItem>;
  onList?: (graph: Graph) => void;
}

/**
 * One workflow's tick, as a workspace of one: the tests written before
 * workspaces drive the shipped `tickWorkspace` through the shape they were
 * written against. A source that cannot list is this tick's failure, as it
 * is `landrace start --once`'s, and `onList` is not called for it, as the old
 * tick threw before it had anything to hand over. What the page shows of a
 * failed list is not this wrapper's: it is pinned through `runStart` in
 * tests/esm/cli-start.test.ts.
 */
export async function tick(opts: TickOptions): Promise<TickRow[]> {
  const { deps } = opts;
  const failures: string[] = [];
  const rows = await tickWorkspace({
    runtime: {
      dir: ".",
      workflows: [{
        id: ONLY, name: deps.workflow.name, description: deps.workflow.description, source: opts.source,
        // Converge redacts through scrub with the secrets as `extra`; this one
        // says the same with or without a scrub of the caller's own.
        deps: { ...deps, source: opts.source, scrub: deps.scrub ?? scrubberOf(deps.ctx.secrets) },
      }],
      preflights: [],
      intervalMs: 60_000,
      concurrency: opts.concurrency ?? 3,
      converging: 0,
      listed: 0,
      stop: new AbortController(),
      running: opts.running ?? new Map(),
      seen: new Map(),
      log: Object.assign((...args: Parameters<typeof deps.log>) => deps.log(...args), { redact: () => {}, scrub: (text: string) => text }),
      ctx: deps.ctx,
    },
    ...(opts.lock ? { lock: opts.lock } : {}),
    onList: (listing) => {
      failures.push(...listingFailures(listing));
      const [graph] = listing.graphs;
      if (graph && failures.length === 0) opts.onList?.(graph);
    },
  });
  if (failures.length) throw new Error(failures.join("; "));
  return rows;
}
