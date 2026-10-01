import { claimItems, eligibilityOfNode } from "#core/index.js";
import type {
  ClaimInput,
  Claims,
  ConvergeResult,
  Graph,
  HookContext,
  Node,
  Source,
  TickRow,
  WorkflowRuntime,
  WorkspaceListing,
  WorkspaceRuntime,
  WorkspaceTickOptions,
} from "#namespace.js";
import { compareIds, compareWork, isOpenItem, ITEM_KIND, itemIdProblem } from "#conventions.js";
import { converge } from "#runner/converge.js";
import { messageOf } from "#runner/errors.js";
import { withLock } from "#runner/lock.js";
import { oneLine } from "#runner/status.js";

/** Claims and the tick judge eligibility through one function, so they cannot disagree. */
export const eligibilityOf = eligibilityOfNode;

/** "a", "a and b", "a, b and c": names the way a sentence says them. */
export function andList(names: readonly string[]): string {
  const last = names.at(-1) ?? "";
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${last}` : last;
}

/*
 * The words for an item no one workflow owns, said once: the tick's row and
 * event, `landrace status` and the board's refusal all quote them, and two
 * wordings of one halt is how an operator comes to think they are two.
 */
export const claimedBy = (workflows: readonly string[]): string => `claimed by ${andList(workflows)}`;
export const reportedBy = (workflows: readonly string[]): string => `reported by the sources of ${andList(workflows)}`;
/** Each workflow's own `else`, said once however many workflows gave it. */
export const turnedAway = (reasons: readonly string[]): string => [...new Set(reasons)].join("; ");

/** The workflows whose source is the graph at `index`, in id order. */
const workflowsOn = (sourceOf: ReadonlyMap<string, number>, index: number): string[] =>
  [...sourceOf].filter(([, s]) => s === index).map(([id]) => id).sort(compareIds);

/** One sentence per source whose `list` failed, naming the workflows it serves. Empty when every source listed. */
export function listingFailures(listing: WorkspaceListing): string[] {
  return [...listing.failed].map(([index, reason]) =>
    `could not list the source of ${andList(workflowsOn(listing.sourceOf, index))}: ${oneLine(reason)}`);
}

/**
 * Every distinct source listed once, and every open item claimed for at most
 * one workflow.
 *
 * Distinct by identity: two workflows that load one hook module are handed
 * the same exported object (Node's module cache), and listing it twice would
 * double every tick's tracker traffic for no new fact.
 *
 * Never rejects. One tracker down is not every workflow down: a source that
 * fails is an empty graph here and an entry in `failed`, and what it would have
 * listed is unknown this tick — so its items are neither worked nor stopped.
 */
export async function listWorkspace(runtime: Pick<WorkspaceRuntime, "workflows" | "ctx" | "log">): Promise<WorkspaceListing> {
  const sources: Source[] = [];
  const sourceOf = new Map<string, number>();
  const inputs: ClaimInput[] = [];
  for (const w of runtime.workflows) {
    const known = sources.indexOf(w.source);
    const index = known === -1 ? sources.push(w.source) - 1 : known;
    sourceOf.set(w.id, index);
    inputs.push({ id: w.id, workflow: w.deps.workflow, source: index });
  }

  // Through a promise first: a source is a hook, and one that throws before
  // it returns a promise would otherwise take every other source down with it.
  const settled = await Promise.allSettled(sources.map((s) => Promise.resolve().then(() => s.list(runtime.ctx))));
  const graphs: Graph[] = [];
  const failed = new Map<number, string>();
  for (const [index, result] of settled.entries()) {
    if (result.status === "fulfilled") {
      graphs.push(result.value);
      continue;
    }
    const reason = messageOf(result.reason);
    graphs.push({ nodes: [], relationships: [] });
    failed.set(index, reason);
    runtime.log("source.failed", { source: sources[index]?.id, workflows: workflowsOn(sourceOf, index), reason });
  }
  return { graphs, sourceOf, claims: claimItems(inputs, graphs), failed };
}

/** Why an open item is worked by nobody, as an event's reason and a row's outcome; null when one workflow owns it. */
function unworked(claims: Claims, item: string): { reason: string; outcome: string; workflows?: string[] } | null {
  const clash = claims.clashes.get(item);
  if (clash) return { reason: reportedBy(clash), outcome: reportedBy(clash), workflows: clash };
  const conflict = claims.conflicts.get(item);
  if (conflict) return { reason: claimedBy(conflict), outcome: claimedBy(conflict), workflows: conflict };
  const reasons = claims.unclaimed.get(item);
  if (!reasons) return null;
  const reason = turnedAway(reasons);
  // Skipped, not absent: an item nobody is working is exactly what an
  // operator running `landrace status` is trying to find out about.
  return { reason, outcome: `skipped: ${oneLine(reason)}` };
}

/**
 * Why a run in flight under `workflow` must stop, by what its own source
 * listed this tick; null to leave it running.
 *
 * Closed or turned away is how a person stops a step: close the item, or
 * take off the label its workflow admitted it with — #29's own merge closed
 * it mid-build and its agent ran on until it was killed by hand. Claimed by
 * another workflow, by a second one too, or reported by a second source is
 * the same fact one level up: it is no longer this workflow's alone to work.
 *
 * An item its own source does not list is left running: a source may drop
 * what it cannot map (the shipped tracker integration does, and says so in
 * its log), and absent is not the same as stopped. The stopped converge
 * halts and writes nothing (see converge), so the round is still owed if the
 * item comes back.
 */
function whyStop(listing: WorkspaceListing, item: string, workflow: string, index: number): string | null {
  const node = listing.graphs[index]?.nodes.find((n) => n.id === item && n.kind === ITEM_KIND);
  if (!node) return null;
  if (node.closed !== null) return "the item was closed";
  const owner = listing.claims.owner.get(item);
  if (owner === workflow) return null;
  if (owner !== undefined) return `now claimed by ${owner}`;
  return unworked(listing.claims, item)?.reason ?? null;
}

/**
 * Stop the run of every item this listing says is no longer its workflow's,
 * and hand back, for each one another workflow now owns, the run to wait out
 * before that workflow may take it.
 */
function stopStopped(runtime: WorkspaceRuntime, listing: WorkspaceListing): Map<string, Promise<void>> {
  const moved = new Map<string, Promise<void>>();
  for (const [item, run] of runtime.running) {
    if (run.controller.signal.aborted) continue;
    const index = listing.sourceOf.get(run.workflow);
    // Its source could not list: nothing is known about the item this tick.
    if (index === undefined || listing.failed.has(index)) continue;
    const reason = whyStop(listing, item, run.workflow, index);
    if (reason === null) continue;
    run.controller.abort(new Error(reason));
    runtime.log("item.aborted", { item, workflow: run.workflow, reason });
    if (listing.claims.owner.has(item)) moved.set(item, run.done);
  }
  return moved;
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
 * One pass over every item every workflow's source can see, most urgent first.
 *
 * Each open item is worked by the one workflow that claims it, converged with
 * that workflow's own deps; one claimed twice, or reported by two sources, is
 * worked by neither and its row says who. Every workflow's items share one
 * pool: `tick.concurrency` bounds the workspace, not each workflow.
 *
 * Items are independent, so one item running a long agent must not hold up
 * the rest: mutual exclusion is per item, and ticks themselves are allowed
 * to overlap. A global "is a tick running" guard would let a single ten-minute
 * step starve every other item in the repository.
 *
 * A busy item is skipped, not queued. It will still be there next tick, and
 * forcing in would mean two invocations resuming the same agent session.
 */
export async function tickWorkspace(opts: WorkspaceTickOptions): Promise<TickRow[]> {
  const { runtime } = opts;
  const { log } = runtime;
  const started = Date.now();
  log("tick.started", {});

  const listing = await listWorkspace(runtime);

  // A display must never be able to stop the work it is displaying.
  try {
    opts.onList?.(listing);
  } catch (e) {
    log("display.failed", { reason: messageOf(e) });
  }

  const moved = stopStopped(runtime, listing);

  const workflows = new Map(runtime.workflows.map((w) => [w.id, w]));
  const rows: TickRow[] = [];
  const work: Array<{ node: Node; workflow: WorkflowRuntime }> = [];
  // Open items only: a pull request in the list is context for an item, and
  // a closed item is there for its parent to count — neither is work. An id
  // two sources report is one row: claims has already judged it a clash.
  const seen = new Set<string>();
  for (const node of listing.graphs.flatMap((g) => g.nodes)) {
    if (!isOpenItem(node) || seen.has(node.id)) continue;
    seen.add(node.id);
    const item = node.id;
    const problem = itemIdProblem(item);
    if (problem) {
      // A source is a hook, and a hook's output is outside input: this id is
      // about to become a lock file name and a worktree directory.
      log("item.skipped", { item, reason: problem });
      rows.push({ item, outcome: `error: ${oneLine(problem)}` });
      continue;
    }
    const owner = listing.claims.owner.get(item);
    const workflow = owner === undefined ? undefined : workflows.get(owner);
    if (workflow) {
      work.push({ node, workflow });
      continue;
    }
    const why = unworked(listing.claims, item);
    if (!why) continue;
    log("item.skipped", { item, reason: why.reason, ...(why.workflows ? { workflows: why.workflows } : {}) });
    rows.push({ item, outcome: why.outcome });
  }

  // Sorted before the pool takes from it, because with a concurrency limit
  // the order is who waits — ordering work is not choosing a transition, and
  // the id tie-break keeps it total.
  work.sort((a, b) => compareWork(a.node, b.node));

  await pool(work, runtime.concurrency, async ({ node, workflow: w }) => {
    const item = node.id;
    // Moved here from another workflow this tick: its stopped run lets go of
    // the item first, so the new owner works it now and never beside the old.
    await moved.get(item);
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    try {
      const result = await withLock(
        item,
        "tick",
        async () => {
          log("lock.acquired", { item, kind: "tick" });
          // Its own controller, so a later tick can stop this item alone;
          // joined to the loop's, so Ctrl-C still stops every one.
          const own = new AbortController();
          runtime.running.set(item, { controller: own, workflow: w.id, done });
          // However the converge ends: the board waits on this before a list
          // may vouch for the labels a step it ran was about to change.
          try {
            return await converge(item, {
              ...w.deps,
              source: w.source,
              ctx: { ...w.deps.ctx, item, signal: AbortSignal.any([w.deps.ctx.signal, own.signal]) } satisfies Omit<HookContext, "snapshot">,
            });
          } finally {
            if (runtime.running.get(item)?.controller === own) runtime.running.delete(item);
            log("lock.released", { item, kind: "tick" });
          }
        },
        opts.lock,
      );
      rows.push({ item, workflow: w.id, outcome: outcomeOf(result) });
    } catch (e) {
      if (isLocked(e)) {
        log("lock.denied", { item, kind: "tick" });
        rows.push({ item, workflow: w.id, outcome: oneLine(messageOf(e)) });
        return;
      }
      // One item's failure is one item's row. `messageOf`, not
      // `(e as Error).message`: a hook is a plain interface and nothing stops
      // one rejecting with a shape that throws on a property read, which would
      // take the whole tick down from inside the handler meant to report it.
      log("item.skipped", { item, reason: messageOf(e) });
      rows.push({ item, workflow: w.id, outcome: `error: ${oneLine(messageOf(e))}` });
    } finally {
      // After withLock has released: whoever waits on this may take the lock.
      settle();
    }
  });

  // Sorted rather than left in completion order: the same repository in the
  // same state should print the same thing twice running, and completion order
  // is whichever agent happened to answer first.
  rows.sort((a, b) => compareIds(a.item, b.item));

  log("tick.finished", { items: rows.length, duration: Date.now() - started });
  return rows;
}
