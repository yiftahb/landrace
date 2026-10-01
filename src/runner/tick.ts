import { eligibilityOfNode } from "#core/index.js";
import type {
  ConvergeResult,
  Graph,
  HookContext,
  Logger,
  TickOptions,
  TickRow,
  Workflow,
} from "#namespace.js";
import { compareIds, compareWork, isOpenItem, ITEM_KIND, itemIdProblem } from "#conventions.js";
import { converge } from "#runner/converge.js";
import { messageOf } from "#runner/errors.js";
import { withLock } from "#runner/lock.js";
import { oneLine } from "#runner/status.js";

/** Matches `tick.concurrency`'s own default, so the two cannot drift. */
const DEFAULT_CONCURRENCY = 3;

/** Claims and the tick judge eligibility through one function, so they cannot disagree. */
export const eligibilityOf = eligibilityOfNode;

/**
 * Stop the run of every item this tick lists as closed or no longer
 * eligible — how a person stops a step: close the item, or take off the
 * label its workflow admitted it with. #29's own merge closed it mid-build
 * and its agent ran on until it was killed by hand.
 *
 * An item missing from the list is left running: a source may drop what it
 * cannot map (the shipped tracker hook does), and absent is not the same as stopped.
 * The stopped converge halts and writes nothing (see converge), so the round
 * is still owed if the item comes back.
 */
function stopStopped(running: Map<string, AbortController>, graph: Graph, workflow: Workflow, log: Logger): void {
  for (const node of graph.nodes) {
    const controller = node.kind === ITEM_KIND ? running.get(node.id) : undefined;
    if (!controller || controller.signal.aborted) continue;
    const eligibility = node.closed === null ? eligibilityOf(workflow, node) : null;
    if (eligibility?.eligible) continue;
    const reason = eligibility ? eligibility.reason : "the item was closed";
    controller.abort(new Error(reason));
    log("item.aborted", { item: node.id, reason });
  }
}

/** A lock held elsewhere is a skip, not a failure: the item will still be there next tick. */
const isLocked = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: unknown }).code === "ELOCKED";

const outcomeOf = (result: ConvergeResult): string =>
  `${result.settled} after ${result.passes} pass(es)${result.why ? `: ${oneLine(result.why)}` : ""}`;

/**
 * Run `fn` over `items`, never more than `limit` at a time.
 *
 * A shared queue rather than fixed-size batches: a batch finishes at the pace
 * of its slowest member, which is the starvation this whole design exists to
 * avoid, one level down.
 */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const worker = async (): Promise<void> => {
    for (;;) {
      const next = queue.shift();
      if (next === undefined) return;
      await fn(next);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, worker));
}

/**
 * One pass over every item the source can see, most urgent first.
 *
 * Items are independent, so one item running a long agent must not hold up
 * the rest: mutual exclusion is per item, and ticks themselves are allowed
 * to overlap. A global "is a tick running" guard would let a single ten-minute
 * step starve every other item in the repository.
 *
 * A busy item is skipped, not queued. It will still be there next tick, and
 * forcing in would mean two invocations resuming the same agent session.
 */
export async function tick(opts: TickOptions): Promise<TickRow[]> {
  const { deps } = opts;
  const started = Date.now();
  deps.log("tick.started", {});

  // Deliberately not caught here: with no graph there are no rows to report
  // a failure against, so the caller decides whether one bad poll stops the
  // loop (it does not — see runStart) or fails a command.
  const graph = await opts.source.list(deps.ctx);

  // A display must never be able to stop the work it is displaying.
  try {
    opts.onList?.(graph);
  } catch (e) {
    deps.log("display.failed", { reason: messageOf(e) });
  }

  if (opts.running) stopStopped(opts.running, graph, deps.workflow, deps.log);

  // Open items only: a pull request in the list is context for an item,
  // and a closed item is there for its parent to count — neither is work.
  // Sorted before the pool takes from it, because with a concurrency limit
  // the order is who waits — ordering work is not choosing a transition, and
  // the id tie-break keeps it total.
  const work = graph.nodes.filter(isOpenItem).sort(compareWork);
  const rows: TickRow[] = [];

  await pool(work, opts.concurrency ?? DEFAULT_CONCURRENCY, async (node) => {
    const item = node.id;
    try {
      const problem = itemIdProblem(item);
      if (problem) {
        // A source is a hook, and a hook's output is outside input: this id is
        // about to become a lock file name and a worktree directory.
        deps.log("item.skipped", { item, reason: problem });
        rows.push({ item, outcome: `error: ${oneLine(problem)}` });
        return;
      }

      const eligibility = eligibilityOf(deps.workflow, node);
      if (!eligibility.eligible) {
        // Skipped, not absent: an item nobody is working is exactly what an
        // operator running `landrace status` is trying to find out about.
        deps.log("item.skipped", { item, reason: eligibility.reason });
        rows.push({ item, outcome: `skipped: ${oneLine(eligibility.reason)}` });
        return;
      }

      const result = await withLock(
        item,
        "tick",
        async () => {
          deps.log("lock.acquired", { item, kind: "tick" });
          // Its own controller, so a later tick can stop this item alone;
          // joined to the loop's, so Ctrl-C still stops every one.
          const own = new AbortController();
          opts.running?.set(item, own);
          // However the converge ends: the board waits on this before a list
          // may vouch for the labels a step it ran was about to change.
          try {
            return await converge(item, {
              ...deps,
              source: opts.source,
              ctx: { ...deps.ctx, item, signal: AbortSignal.any([deps.ctx.signal, own.signal]) } satisfies Omit<HookContext, "snapshot">,
            });
          } finally {
            if (opts.running?.get(item) === own) opts.running.delete(item);
            deps.log("lock.released", { item, kind: "tick" });
          }
        },
        opts.lock,
      );
      rows.push({ item, outcome: outcomeOf(result) });
    } catch (e) {
      if (isLocked(e)) {
        deps.log("lock.denied", { item, kind: "tick" });
        rows.push({ item, outcome: oneLine(messageOf(e)) });
        return;
      }
      // One item's failure is one item's row. `messageOf`, not
      // `(e as Error).message`: a hook is a plain interface and nothing stops
      // one rejecting with a shape that throws on a property read, which would
      // take the whole tick down from inside the handler meant to report it.
      deps.log("item.skipped", { item, reason: messageOf(e) });
      rows.push({ item, outcome: `error: ${oneLine(messageOf(e))}` });
    }
  });

  // Sorted rather than left in completion order: the same repository in the
  // same state should print the same thing twice running, and completion order
  // is whichever agent happened to answer first.
  rows.sort((a, b) => compareIds(a.item, b.item));

  deps.log("tick.finished", { items: rows.length, duration: Date.now() - started });
  return rows;
}
