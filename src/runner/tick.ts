import { keptItems, keptSlot, removeWorktree } from "#agent/worktree.js";
import { claimItems, closedIdle, eligibilityOfNode, locateNode, placedByState, waitsOnAPerson } from "#core/index.js";
import type {
  AgentSlot,
  Claims,
  ConvergeResult,
  Graph,
  HookContext,
  ListedWorkflow,
  LockOptions,
  Logger,
  Node,
  RunningItem,
  RuntimeContext,
  SeenAt,
  Snapshot,
  Source,
  TickRow,
  TickWait,
  TurnedAway,
  WorkflowRuntime,
  WorkspaceListing,
  WorkspaceRuntime,
  WorkspaceTickOptions,
} from "#namespace.js";
import { compareIds, compareWork, isItemNode, isOpenItem, itemIdProblem } from "#conventions.js";
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

/**
 * Who owns what, judged over these graphs: one per distinct source, at the
 * index `sourceOf` gives each workflow.
 */
export function claimsOf(workflows: readonly ListedWorkflow[], sourceOf: ReadonlyMap<string, number>, graphs: Graph[]): Claims {
  return claimItems(workflows.map((w) => ({
    id: w.id, workflow: w.deps.workflow, source: sourceOf.get(w.id) ?? -1,
    closedRun: w.deps.workflow.stages.some((s) => s.closed === "run"),
  })), graphs);
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
 * Unless the run started on a closed item: a `closed: run` stage's step, a
 * retro, runs because the item is closed, and its owner is judged as a
 * closed item's is, for as long as the item stays closed.
 *
 * An item its own source does not list is left running: a source may drop
 * what it cannot map (the shipped tracker integration does, and says so in
 * its log), and absent is not the same as stopped. The stopped converge
 * halts and writes nothing (see converge), so the round is still owed if the
 * item comes back.
 */
function whyStop(listing: WorkspaceListing, item: string, run: RunningItem, index: number): string | null {
  const { workflow } = run;
  const node = listing.graphs[index]?.nodes.find((n) => n.id === item && isItemNode(n));
  if (!node) return null;
  if (node.closed !== null && run.closed !== true) return "the item was closed";
  const owner = (node.closed === null ? listing.claims.owner : listing.claims.closed).get(item);
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
    const reason = whyStop(listing, item, run, index);
    if (reason === null) continue;
    run.controller.abort(new Error(reason));
    runtime.log("item.aborted", { item, workflow: run.workflow, reason });
    if (listing.claims.owner.has(item) || listing.claims.closed.has(item)) moved.set(item, run.done);
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
    if (!sameStage(before.get(node.id), at) && stage !== undefined && waitsOnAPerson(stage) && placedByState(stage)) arrived.set(node.id, at);
    else runtime.seen.set(node.id, at);
  }
  return arrived;
}

/**
 * Tell a person of an item that arrived at their turn by its own state, once
 * its converge has left it where it was listed: settled waiting on its first
 * pass, so no transition took it on and nothing ran — or not converged at
 * all, its lock held elsewhere. One a trigger moved on in the same tick never
 * waited on anyone. Through the workflow's notify, so by the board's rule for
 * who is waiting, and noted where it was told of, so no tick tells it again.
 *
 * Unless another tick has already told of it there: a later one lists while
 * this one's runs go on, finds it arriving too, and the first to tell is the
 * one tell.
 */
function tellIf(
  runtime: WorkspaceRuntime, workflow: WorkflowRuntime, node: Node, at: SeenAt, result: ConvergeResult | "locked",
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

/** Why a step did not start: its row, its event, and the converge's own answer. */
export const waitingForSlot = (concurrency: number): string => `waiting for a free agent slot (tick.concurrency ${concurrency})`;

/** Why a tick checked nothing. */
export const SKIPPED_CHECKING = "an earlier tick is still checking its items";

/**
 * Grant the slots asked for in one turn of the event loop, most urgent first,
 * while one is free. Together rather than as each ask lands: checks run side
 * by side, and the one whose read answered first is not the one most urgent.
 */
function grantAsks(runtime: WorkspaceRuntime): void {
  for (const ask of runtime.asking.splice(0).sort((a, b) => compareWork(a.node, b.node))) {
    const free = runtime.agents < runtime.concurrency;
    if (free) runtime.agents += 1;
    ask.grant(free);
  }
}

function askSlot(runtime: WorkspaceRuntime, node: Node): Promise<boolean> {
  return new Promise((grant) => {
    if (runtime.asking.push({ node, grant }) === 1) setImmediate(() => grantAsks(runtime));
  });
}

/**
 * Hand every free slot to the most urgent item a check turned away, which is
 * checked again holding it. Nothing once the loop is stopping: no new run
 * starts after Ctrl-C.
 */
function drain(runtime: WorkspaceRuntime, by: TickWait): void {
  while (runtime.agents < runtime.concurrency && !runtime.stop.signal.aborted) {
    const next = runtime.turnedAway.shift();
    if (next === undefined) return;
    runtime.agents += 1;
    next.start(by);
  }
}

/** Keep `turnedAway` most urgent first, one entry an item, and hand it a slot if one came free meanwhile. */
function turnAway(runtime: WorkspaceRuntime, entry: TurnedAway, by: TickWait): void {
  const queue = runtime.turnedAway.filter((t) => t.node.id !== entry.node.id);
  const at = queue.findIndex((t) => compareWork(entry.node, t.node) < 0);
  queue.splice(at === -1 ? queue.length : at, 0, entry);
  runtime.turnedAway = queue;
  drain(runtime, by);
}

/**
 * Run `fn` over `items`, never more than `limit` at a time, in order.
 *
 * A shared queue rather than fixed-size batches: a batch finishes at the pace
 * of its slowest member, which is the starvation this whole design exists to
 * avoid, one level down.
 */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) await fn(next);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, worker));
}

/**
 * One pass over every item every workflow's source can see, most urgent first.
 *
 * Each open item is worked by the one workflow that claims it, converged with
 * that workflow's own deps; one claimed twice, or reported by two sources, is
 * worked by neither and its row says who.
 *
 * Every claimed item is checked once, `tick.concurrency` at a time so the
 * tracker is not flooded. A check takes no agent slot: reading an item,
 * entering a stage and its effects, a merge, never wait behind running
 * agents. A slot is an agent, taken by converge just before a step starts and
 * held until it ends. From there the run carries on outside the checks,
 * holding its lock and its slot, and the checks move on to the next item; the
 * tick's promise waits for it. `tick.concurrency` bounds the agents over every
 * workflow and every tick, counted in `runtime.agents`.
 *
 * A step that finds no slot free is left owed, and its row says so. The next
 * slot a run of this process frees goes to the most urgent item the latest
 * checks turned away, checked again holding it; else a later tick runs it.
 *
 * A tick that starts while an earlier one is still checking is skipped.
 * Checking again from the top, the most urgent first, is what starved new
 * work behind slow reads (#136): each tick spent its time on items that only
 * waited, then a later one started over. Runs never cause a skip: one item's
 * ten-minute agent must not stop every other item moving, so mutual
 * exclusion of runs is per item.
 *
 * A busy item is skipped, not queued. It will still be there next tick, and
 * forcing in would mean two invocations resuming the same agent session.
 */
export async function tickWorkspace(opts: WorkspaceTickOptions): Promise<TickRow[]> {
  const { runtime } = opts;
  const { log } = runtime;
  if (runtime.checking) {
    log("tick.skipped", { reason: SKIPPED_CHECKING });
    return [];
  }
  runtime.checking = true;
  const started = Date.now();
  const rows = new Map<string, TickRow>();
  const runs = new Set<Promise<void>>();
  const tick: TickWait = {
    track: (run) => {
      runs.add(run);
      void run.finally(() => runs.delete(run));
    },
    rows,
  };
  let arrived = new Map<string, SeenAt>();

  /*
   * Converge one item under its lock; resolves once its check is over — the
   * converge ended, or it took a slot and carries on. `holding` is a slot
   * already taken for it: an item turned away, started again by the run that
   * freed one. `by` is the tick that waits for the run and prints its row,
   * which is not this one when a slot an earlier tick's run freed started it:
   * this tick may have printed long ago.
   */
  const work = (node: Node, w: WorkflowRuntime, holding: boolean, by: TickWait): Promise<void> =>
    new Promise<void>((checked) => {
      const item = node.id;
      const handedOn = holding;
      let refused: string | null = null;
      const slot: AgentSlot = {
        take: async () => {
          if (!holding) {
            if (!(await askSlot(runtime, node))) return (refused = waitingForSlot(runtime.concurrency));
            holding = true;
          }
          checked();
          return null;
        },
        // However the run ends, once: converge gives back the slot it took,
        // and the run gives back one handed to it that converge never took.
        give: () => {
          if (!holding) return;
          holding = false;
          runtime.agents -= 1;
          drain(runtime, by);
        },
      };
      const tell = (result: ConvergeResult | "locked"): void => {
        const at = handedOn ? undefined : arrived.get(item);
        if (at) tellIf(runtime, w, node, at, result);
      };
      const run = (async (): Promise<void> => {
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
              runtime.running.set(item, { controller: own, workflow: w.id, done, closed: node.closed !== null });
              // However the converge ends: the board waits on this before a list
              // may vouch for the labels a step it ran was about to change.
              const notify = noting(runtime, w, item);
              try {
                return await converge(item, {
                  ...w.deps,
                  source: w.source,
                  ctx: { ...w.deps.ctx, item, signal: AbortSignal.any([w.deps.ctx.signal, own.signal]) } satisfies Omit<HookContext, "snapshot">,
                  ...(notify ? { notify } : {}),
                  slot,
                });
              } finally {
                if (runtime.running.get(item)?.controller === own) runtime.running.delete(item);
                log("lock.released", { item, kind: "tick" });
              }
            },
            opts.lock,
          );
          if (refused !== null) {
            // Owed, not waiting on anyone: no person is told of it.
            log("item.skipped", { item, workflow: w.id, reason: refused });
            by.rows.set(item, { item, workflow: w.id, outcome: refused });
            turnAway(runtime, { node, start: (next) => void work(node, w, true, next) }, by);
            return;
          }
          by.rows.set(item, { item, workflow: w.id, outcome: outcomeOf(result) });
          tell(result);
        } catch (e) {
          if (isLocked(e)) {
            log("lock.denied", { item, kind: "tick" });
            by.rows.set(item, { item, workflow: w.id, outcome: oneLine(messageOf(e)) });
            tell("locked");
            return;
          }
          // One item's failure is one item's row. `messageOf`, not
          // `(e as Error).message`: a hook is a plain interface and nothing stops
          // one rejecting with a shape that throws on a property read, which would
          // take the whole tick down from inside the handler meant to report it.
          log("item.skipped", { item, reason: messageOf(e) });
          by.rows.set(item, { item, workflow: w.id, outcome: `error: ${oneLine(messageOf(e))}` });
        } finally {
          slot.give();
          // After withLock has released: whoever waits on this may take the lock.
          settle();
        }
      })();
      by.track(run);
      void run.finally(checked);
    });

  let listing: WorkspaceListing | undefined;
  try {
    log("tick.started", {});
    listing = await listWorkspace(runtime);
    const listed = listing;

    // A display must never be able to stop the work it is displaying.
    try {
      opts.onList?.(listed);
    } catch (e) {
      log("display.failed", { reason: messageOf(e) });
    }

    const moved = stopStopped(runtime, listed);

    // With two sources or more, one that could not list leaves every clash
    // unjudged: an id the others list may be one it reports too. Nothing is
    // worked until it lists again, rather than settling a clash for whichever
    // source answered. Runs are not stopped for it — what stops one is judged
    // above, and a clash would only stop it too. One source has no one to clash
    // with, and its own items are simply absent.
    const unjudged = listed.failed.size > 0 && listed.graphs.length > 1;

    const workflows = new Map(runtime.workflows.map((w) => [w.id, w]));
    const claimed: Array<{ node: Node; workflow: WorkflowRuntime }> = [];
    // Items only: a pull request in the list is context for an item. A closed
    // item is there for its parent to count, and is work only where a workflow
    // with a `closed: run` stage claims it, or two halt over it — and then only
    // when its node shows it could move or run, so a tracker's every recently
    // closed item is not read again on every tick. Open ones first, so an id
    // one source reports open is judged as open. An id two sources report is
    // one row: claims has already judged it a clash.
    const items = listed.graphs.flatMap((g) => g.nodes).filter(isItemNode);
    const seen = new Set<string>();
    for (const node of [...items.filter(isOpenItem), ...items.filter((n) => !isOpenItem(n))]) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      const item = node.id;
      const closed = node.closed !== null;
      const closedOwner = closed ? listed.claims.closed.get(item) : undefined;
      if (closed && !listed.claims.conflicts.has(item) && !listed.claims.clashes.has(item)) {
        const owning = closedOwner === undefined ? undefined : workflows.get(closedOwner);
        if (owning === undefined || closedIdle(owning.deps.workflow, node)) continue;
      }
      const problem = itemIdProblem(item);
      if (problem) {
        // A source is a hook, and a hook's output is outside input: this id is
        // about to become a lock file name and a worktree directory.
        log("item.skipped", { item, reason: problem });
        rows.set(item, { item, outcome: `error: ${oneLine(problem)}` });
        continue;
      }
      const owner = closed ? closedOwner : listed.claims.owner.get(item);
      const workflow = owner === undefined ? undefined : workflows.get(owner);
      if (workflow && unjudged) {
        const reason = unknownClash(listed, item);
        log("item.skipped", { item, reason });
        rows.set(item, { item, outcome: reason });
        continue;
      }
      if (workflow) {
        claimed.push({ node, workflow });
        continue;
      }
      const why = unworked(listed.claims, item);
      if (!why) continue;
      log("item.skipped", { item, reason: why.reason, ...(why.workflows ? { workflows: why.workflows } : {}) });
      rows.set(item, { item, outcome: why.outcome });
    }

    // Sorted before the pool takes from it, because the order is who is
    // checked first, and so who asks for a slot first — ordering work is not
    // choosing a transition, and the id tie-break keeps it total.
    claimed.sort((a, b) => compareWork(a.node, b.node));

    // Before the pool, and in one synchronous step after the listing: a run
    // still going from an earlier tick reads what this one noted.
    arrived = noteArrivals(runtime, listed, claimed, unjudged);

    // This tick checks every item again: what an earlier check turned away is
    // turned away again, or worked, by this one.
    runtime.turnedAway = [];

    await pool(claimed, runtime.concurrency, async ({ node, workflow: w }) => {
      // Moved here from another workflow this tick: its stopped run lets go of
      // the item first, so the new owner works it in this same tick and never
      // beside the old. Bounded by the old run honouring the abort it was just
      // sent, as Ctrl-C's own wait for every run is.
      await moved.get(node.id);
      await work(node, w, false, tick);
    });
  } finally {
    runtime.checking = false;
  }

  // The runs this tick's checks started, and the ones a slot they freed
  // started in turn: `landrace start --once` and Ctrl-C wait on this.
  while (runs.size > 0) await Promise.all([...runs]);

  await sweepKept(runtime, listing, opts.lock);

  // Sorted rather than left in completion order: the same repository in the
  // same state should print the same thing twice running, and completion order
  // is whichever agent happened to answer first.
  const out = [...rows.values()].sort((a, b) => compareIds(a.item, b.item));

  log("tick.finished", { items: out.length, duration: Date.now() - started });
  return out;
}
