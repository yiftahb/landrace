import { keptItems, keptSlot, removeWorktree } from "#agent/worktree.js";
import { claimItems, eligibilityOfNode, locateNode, placedByState } from "#core/index.js";
import type {
  Claims,
  ConvergeResult,
  Graph,
  HookContext,
  ListedWorkflow,
  LockOptions,
  Logger,
  Node,
  RuntimeContext,
  SeenAt,
  Snapshot,
  Source,
  TickRow,
  WorkflowRuntime,
  WorkspaceListing,
  WorkspaceRuntime,
  WorkspaceTickOptions,
} from "#namespace.js";
import { compareIds, compareWork, isItemNode, isOpenItem, itemIdProblem } from "#conventions.js";
import { converge } from "#runner/converge.js";
import { messageOf } from "#runner/errors.js";
import { held, withLock } from "#runner/lock.js";
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

/**
 * Who owns what, judged over these graphs: one per distinct source, at the
 * index `sourceOf` gives each workflow.
 */
export function claimsOf(workflows: readonly ListedWorkflow[], sourceOf: ReadonlyMap<string, number>, graphs: Graph[]): Claims {
  return claimItems(workflows.map((w) => ({ id: w.id, workflow: w.deps.workflow, source: sourceOf.get(w.id) ?? -1 })), graphs);
}

/**
 * Why an item a working source listed is not worked while another source
 * could not list: a clash needs both sources' answers, and one of them is
 * unknown this tick.
 */
export function unknownClash(listing: WorkspaceListing, item: string): string {
  return [...listing.failed].map(([index, reason]) =>
    `whether the source of ${andList(workflowsOn(listing.sourceOf, index))} also reports #${item} is unknown: ${oneLine(reason)}`).join("; ");
}

/** One sentence per source whose `list` failed, naming the workflows it serves. Empty when every source listed. */
export function listingFailures(listing: WorkspaceListing): string[] {
  return [...listing.failed].map(([index, reason]) =>
    `could not list the source of ${andList(workflowsOn(listing.sourceOf, index))}: ${oneLine(reason)}`);
}

/**
 * Every distinct source, by identity, in the order the workflows first name
 * them, and the index of each workflow's: what every listing of one runtime
 * indexes its graphs by.
 */
export function sourcesOf(workflows: ReadonlyArray<Pick<WorkflowRuntime, "id" | "source">>): { sources: Source[]; sourceOf: Map<string, number> } {
  const sources: Source[] = [];
  const sourceOf = new Map<string, number>();
  for (const w of workflows) {
    const known = sources.indexOf(w.source);
    sourceOf.set(w.id, known === -1 ? sources.push(w.source) - 1 : known);
  }
  return { sources, sourceOf };
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
export async function listWorkspace(runtime: { workflows: readonly ListedWorkflow[]; ctx: RuntimeContext; log: Logger }): Promise<WorkspaceListing> {
  const { sources, sourceOf } = sourcesOf(runtime.workflows);

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
  return { graphs, sourceOf, claims: claimsOf(runtime.workflows, sourceOf, graphs), failed };
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
  const node = listing.graphs[index]?.nodes.find((n) => n.id === item && isItemNode(n));
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

/**
 * Where `node` is under `workflow`, when it is at one stage. Asked of every
 * item before any is worked, so an identity that throws — an operator the
 * allowlist refuses — is that item not seen, never the whole tick: its own
 * converge meets the same refusal and reports it on its row.
 */
function seenAt(workflow: WorkflowRuntime, node: Node): SeenAt | null {
  try {
    const where = locateNode(workflow.deps.workflow, node);
    return where.kind === "at" ? { workflow: workflow.id, stage: where.stage.id } : null;
  } catch {
    return null;
  }
}

const sameStage = (a: SeenAt | undefined, b: SeenAt): boolean => a?.workflow === b.workflow && a.stage === b.stage;

/**
 * Note where every item this tick works is, and hand back the ones that have
 * just come to wait on a person by their own state, with where.
 *
 * Converge tells of an item that comes to rest at a person's turn after a
 * transition; an item placed by its own state makes none — it is at
 * `reviewing` because its labels say so, one tick and not the one before. So
 * an item at a stage that waits on a person, placed there by its own state,
 * that the last tick did not see there has arrived. Only such a stage: one a
 * label alone places an item at is reached by a transition, and converge
 * tells of it. The tell itself waits for the item's converge (see `tellIf`).
 *
 * An arrival is not noted here, only once it is told: a tick whose converge
 * halts, fails or moves the item on tells no one, and noted all the same, the
 * item was never told of until it left and came back. Left out, the next
 * tick that finds it there finds it arriving again.
 *
 * `runtime.seen` is the last tick's listing, in this process only. A restart
 * starts it empty, so every item already waiting is told of once more on the
 * first tick — the price of storing nothing. What this tick cannot see is
 * carried rather than forgotten: the items of a source that could not list,
 * and every item while a failed source leaves claims unjudged, so a tracker
 * coming back does not tell of everything again.
 */
function noteArrivals(
  runtime: WorkspaceRuntime, listing: WorkspaceListing, work: ReadonlyArray<{ node: Node; workflow: WorkflowRuntime }>, unjudged: boolean,
): Map<string, SeenAt> {
  const before = new Map(runtime.seen);
  runtime.seen.clear();
  for (const [item, at] of before) {
    const index = listing.sourceOf.get(at.workflow);
    if (unjudged || (index !== undefined && listing.failed.has(index))) runtime.seen.set(item, at);
  }
  const arrived = new Map<string, SeenAt>();
  for (const { node, workflow } of work) {
    const at = seenAt(workflow, node);
    if (at === null) continue;
    const stage = workflow.deps.workflow.stages.find((s) => s.id === at.stage);
    if (!sameStage(before.get(node.id), at) && stage?.waits === "person" && placedByState(stage)) arrived.set(node.id, at);
    else runtime.seen.set(node.id, at);
  }
  return arrived;
}

/**
 * Tell a person of an item that arrived at their turn by its own state, once
 * its converge has left it where it was listed: settled waiting on its first
 * pass, so no transition took it on and nothing ran — or not converged at
 * all, its lock held elsewhere or no slot free for it. One a trigger moved on
 * in the same tick never waited on anyone. Through the workflow's notify, so
 * by the board's rule for who is waiting, and noted where it was told of, so
 * no tick tells it again.
 *
 * Unless a tick overlapping this one has already told of it there: one that
 * listed before this one told finds it arriving too, and the first to tell is
 * the one tell.
 */
function tellIf(
  runtime: WorkspaceRuntime, workflow: WorkflowRuntime, node: Node, at: SeenAt, result: ConvergeResult | "locked" | "left",
): void {
  if (typeof result !== "string" && (result.settled !== "wait" || result.passes !== 1)) return;
  if (sameStage(runtime.seen.get(node.id), at)) return;
  runtime.seen.set(node.id, at);
  try {
    workflow.deps.notify?.({ node });
  } catch (e) {
    runtime.log("notify.failed", { item: node.id, reason: messageOf(e) });
  }
}

/**
 * The workflow's notify, noting where converge told a person the item came to
 * rest: the next tick's listing finds it there and does not tell again.
 */
function noting(runtime: WorkspaceRuntime, workflow: WorkflowRuntime, item: string): ((snapshot: Snapshot) => void) | undefined {
  const notify = workflow.deps.notify;
  if (!notify) return undefined;
  return (snapshot) => {
    const at = seenAt(workflow, snapshot.node as Node);
    if (at === null) runtime.seen.delete(item);
    else runtime.seen.set(item, at);
    notify(snapshot);
  };
}

/**
 * Remove the kept write worktree of every item that is no longer open work:
 * closed, listed by no source, or at a terminal stage. A converge removes it
 * as the item reaches the end, but the tick never converges a closed item —
 * and a merge that closes it with `Closes #n` gets there first — nor one a
 * crash stopped between its terminal transition and the removal. Left, the
 * worktree keeps its `node_modules` for good and holds the item's branch.
 *
 * Only when every source listed: an item a failed source would have listed is
 * not known to be finished. Under the item's lock, so a run in flight keeps
 * its own. One removed too many costs a rebuild and a setup, never work: what
 * a step committed is on its branch.
 */
async function sweepKept(runtime: WorkspaceRuntime, listing: WorkspaceListing, lock: LockOptions | undefined): Promise<void> {
  if (listing.failed.size > 0) return;
  const open = new Map(listing.graphs.flatMap((g) => g.nodes).filter(isOpenItem).map((n) => [n.id, n]));
  const workflows = new Map(runtime.workflows.map((w) => [w.id, w]));
  const finished = (item: string): boolean => {
    const node = open.get(item);
    if (node === undefined) return true;
    const owner = listing.claims.owner.get(item);
    const workflow = owner === undefined ? undefined : workflows.get(owner);
    const at = workflow === undefined ? null : seenAt(workflow, node);
    return at !== null && workflow?.deps.workflow.stages.find((s) => s.id === at.stage)?.terminal === true;
  };
  for (const root of new Set(runtime.workflows.flatMap((w) => w.deps.sandbox?.root ?? []))) {
    const kept = await keptItems(root).catch(() => []);
    for (const item of kept.filter((i) => itemIdProblem(i) === null && finished(i))) {
      // Held is skipped: the run holding it removes its own, or the next tick does.
      await withLock(item, "tick", () => removeWorktree(item, root, keptSlot(item)), lock).catch(() => undefined);
    }
  }
}

/** A lock held elsewhere is a skip, not a failure: the item will still be there next tick. */
const isLocked = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: unknown }).code === "ELOCKED";

const outcomeOf = (result: ConvergeResult): string =>
  `${result.settled} after ${result.passes} pass(es)${result.why ? `: ${oneLine(result.why)}` : ""}`;

/**
 * Run `fn` over `items`, never more than `limit` at a time, and hand back the
 * items it never ran, in order.
 *
 * A shared queue rather than fixed-size batches: a batch finishes at the pace
 * of its slowest member, which is the starvation this whole design exists to
 * avoid, one level down.
 *
 * A worker whose `fn` answers false puts that item back where it was and
 * stops: the rest of the queue goes to the workers still running, or back to
 * the caller once none is. Where it was, not at the front — workers turned
 * away in one round resume in no order of the items', and each putting its
 * own first would hand the next free slot to the least urgent of them.
 */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<boolean>): Promise<T[]> {
  const queue = items.map((_, i) => i);
  const worker = async (): Promise<void> => {
    for (;;) {
      const next = queue.shift();
      if (next === undefined) return;
      if (!(await fn(items[next] as T))) {
        const after = queue.findIndex((i) => i > next);
        queue.splice(after === -1 ? queue.length : after, 0, next);
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, worker));
  return queue.map((i) => items[i] as T);
}

/**
 * One pass over every item every workflow's source can see, most urgent first.
 *
 * Each open item is worked by the one workflow that claims it, converged with
 * that workflow's own deps; one claimed twice, or reported by two sources, is
 * worked by neither and its row says who. `tick.concurrency` bounds the
 * workspace, not each workflow and not each tick: the converges in flight
 * over every workflow and every tick still running, counted in
 * `runtime.converging`. Each tick's pool is that size too, so a tick alone
 * works its list as it always did, its own runs queueing the rest — until a
 * later tick lists, which from then on hands out every slot that frees.
 *
 * Items are independent, so one item running a long agent must not hold up
 * the rest: mutual exclusion is per item, and ticks themselves are allowed
 * to overlap. A global "is a tick running" guard would let a single ten-minute
 * step starve every other item in the repository.
 *
 * A busy item is skipped, not queued. It will still be there next tick, and
 * forcing in would mean two invocations resuming the same agent session. So
 * is what this tick has not started once no slot is free and no run of its
 * own is left to free one, or once a later tick has listed.
 */
export async function tickWorkspace(opts: WorkspaceTickOptions): Promise<TickRow[]> {
  const { runtime } = opts;
  const { log } = runtime;
  const started = Date.now();
  log("tick.started", {});

  const listing = await listWorkspace(runtime);
  const listed = ++runtime.listed;

  // A display must never be able to stop the work it is displaying.
  try {
    opts.onList?.(listing);
  } catch (e) {
    log("display.failed", { reason: messageOf(e) });
  }

  const moved = stopStopped(runtime, listing);

  // With two sources or more, one that could not list leaves every clash
  // unjudged: an id the others list may be one it reports too. Nothing is
  // worked until it lists again, rather than settling a clash for whichever
  // source answered. Runs are not stopped for it — what stops one is judged
  // above, and a clash would only stop it too. One source has no one to clash
  // with, and its own items are simply absent.
  const unjudged = listing.failed.size > 0 && listing.graphs.length > 1;

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
    if (workflow && unjudged) {
      const reason = unknownClash(listing, item);
      log("item.skipped", { item, reason });
      rows.push({ item, outcome: reason });
      continue;
    }
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

  // Before the pool, and in one synchronous step after the listing: a tick
  // overlapping this one reads what this one noted, never the same old map.
  const arrived = noteArrivals(runtime, listing, work, unjudged);

  let overtaken = false;
  const left = await pool(work, runtime.concurrency, async ({ node, workflow: w }) => {
    const item = node.id;
    // Moved here from another workflow this tick: its stopped run lets go of
    // the item first, so the new owner works it in this same tick and never
    // beside the old. The wait holds a pool slot, deliberately — the handoff
    // is this slot's work — and is bounded by the old run honouring the abort
    // it was just sent, as Ctrl-C's own wait for every run is.
    await moved.get(item);
    // A slot of the workspace's, taken here in compareWork order before the
    // lock, because a slot taken after an awaited lock goes to whichever lock
    // came back first. None free, or a later tick has listed since: this
    // worker stops, and the item waits for another of this tick's own workers
    // or a later tick, never for another tick's runs. An item running in this
    // process takes none, since its run holds one and its lock turns it away;
    // one another process holds takes one only until its lock says so.
    let slot = false;
    const take = (): boolean => {
      // Once a later tick lists, every take after says so: the last refusal
      // is the reason this tick leaves what it has not started.
      overtaken = runtime.listed !== listed;
      if (overtaken || runtime.converging >= runtime.concurrency) return false;
      runtime.converging += 1;
      return (slot = true);
    };
    if (!runtime.running.has(item) && !take()) return false;
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    try {
      const result = await withLock(
        item,
        "tick",
        async () => {
          // Its run of an earlier tick ended while this one asked for the lock.
          if (!slot && !take()) return null;
          log("lock.acquired", { item, kind: "tick" });
          // Its own controller, so a later tick can stop this item alone;
          // joined to the loop's, so Ctrl-C still stops every one.
          const own = new AbortController();
          runtime.running.set(item, { controller: own, workflow: w.id, done });
          // However the converge ends: the board waits on this before a list
          // may vouch for the labels a step it ran was about to change.
          const notify = noting(runtime, w, item);
          try {
            return await converge(item, {
              ...w.deps,
              source: w.source,
              ctx: { ...w.deps.ctx, item, signal: AbortSignal.any([w.deps.ctx.signal, own.signal]) } satisfies Omit<HookContext, "snapshot">,
              ...(notify ? { notify } : {}),
            });
          } finally {
            if (runtime.running.get(item)?.controller === own) runtime.running.delete(item);
            log("lock.released", { item, kind: "tick" });
          }
        },
        opts.lock,
      );
      if (result === null) return false;
      rows.push({ item, workflow: w.id, outcome: outcomeOf(result) });
      const at = arrived.get(item);
      if (at) tellIf(runtime, w, node, at, result);
    } catch (e) {
      if (isLocked(e)) {
        log("lock.denied", { item, kind: "tick" });
        rows.push({ item, workflow: w.id, outcome: oneLine(messageOf(e)) });
        const at = arrived.get(item);
        if (at) tellIf(runtime, w, node, at, "locked");
        return true;
      }
      // One item's failure is one item's row. `messageOf`, not
      // `(e as Error).message`: a hook is a plain interface and nothing stops
      // one rejecting with a shape that throws on a property read, which would
      // take the whole tick down from inside the handler meant to report it.
      log("item.skipped", { item, reason: messageOf(e) });
      rows.push({ item, workflow: w.id, outcome: `error: ${oneLine(messageOf(e))}` });
    } finally {
      // Before settling: a handoff waiting on this takes the slot it frees.
      if (slot) runtime.converging -= 1;
      // After withLock has released: whoever waits on this may take the lock.
      settle();
    }
    return true;
  });

  // Skipped as a busy item is, not queued behind runs another tick started:
  // by the time one ends this listing is stale, and a later tick lists anew.
  // A busy one queued behind the first refusal says who holds it, as it would
  // had a worker reached it: looked up, never taken.
  const reason = overtaken
    ? "left for a later tick: a later tick has listed"
    : `no free slot of tick.concurrency (${runtime.concurrency}): left for a later tick`;
  for (const { node, workflow: w } of left) {
    const by = await held(node.id, opts.lock);
    if (by) {
      log("lock.denied", { item: node.id, kind: "tick" });
      rows.push({ item: node.id, workflow: w.id, outcome: `#${node.id} is locked by ${by.holder}` });
      const at = arrived.get(node.id);
      if (at) tellIf(runtime, w, node, at, "locked");
      continue;
    }
    log("item.skipped", { item: node.id, workflow: w.id, reason });
    rows.push({ item: node.id, workflow: w.id, outcome: reason });
    const at = arrived.get(node.id);
    if (at) tellIf(runtime, w, node, at, "left");
  }

  await sweepKept(runtime, listing, opts.lock);

  // Sorted rather than left in completion order: the same repository in the
  // same state should print the same thing twice running, and completion order
  // is whichever agent happened to answer first.
  rows.sort((a, b) => compareIds(a.item, b.item));

  log("tick.finished", { items: rows.length, duration: Date.now() - started });
  return rows;
}
