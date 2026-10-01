import {
  isEngineLabel,
  LABEL_NAMESPACE,
  LABELS,
  labelsOf,
  neutraliseMarkers,
  RECORD_EFFECT,
  recordBodyProblem,
  stageFromLabels,
  isOpenItem,
  ITEM_KIND,
} from "#conventions.js";
import { cannotPlace, checkEligible, locateNode } from "#core/index.js";
import type { Claims, Graph, ItemSummary, Lane, ListedWorkflow, Node, PreHook, ReplyDeps, Snapshot, Source, StatusRow, WaitingItem, Workflow, WorkspaceListing } from "#namespace.js";
import type { Operator, RuntimeContext, ToolHands, ToolOptions, Tools, ToolWorkflow } from "#namespace.js";
import { createConversation } from "#mcp/conversation.js";
import { createDispatcher } from "#runner/effects.js";
import { messageOf, Refusal } from "#runner/errors.js";
import { sendTo } from "#runner/goto.js";
import { finishPair, pairingView, releasePair, startPair } from "#runner/pair.js";
import { editRoute, noSharedPre, readRoute, sharedPre, unownedWhy, writeRoute } from "#runner/route.js";
import { buildSnapshot } from "#runner/snapshot.js";
import { laneOf, statusRows, workspaceStatusRows } from "#runner/status.js";
import { claimsOf, listingFailures, listWorkspace, sourcesOf } from "#runner/tick.js";

/**
 * Position is a label, so an `lr:` label from the editor is not a label at
 * all — it is a write to workflow state. `lr:stage:done` skipped every stage
 * and `lr:approved` forged a human decision. The engine writes these through
 * effects, which have a satisfied() and can be reconciled; nothing reaches
 * them through here.
 */
function refuseEngineLabels(labels: string[], what: string): void {
  const offending = labels.filter(isEngineLabel);
  if (offending.length) {
    throw new Error(
      `cannot ${what} ${offending.map((l) => `"${l}"`).join(", ")}: ` +
      `"${LABEL_NAMESPACE}" labels are the workflow's own state, written by the engine`,
    );
  }
}

/**
 * An operator hook is optional, so the two tools that need one report its
 * absence — rather than crashing on a null, or quietly succeeding at nothing.
 */
function requireOperator(operator: Operator | null, what: string): Operator {
  if (!operator) {
    throw new Error(
      `cannot ${what}: no operator hook is configured. Add a module exporting ` +
      "defineOperator({ ... }) to the hooks list in workflow.yaml.",
    );
  }
  return operator;
}

/**
 * A source is optional here as an operator is, so what needs one reports its
 * absence when asked — not at startup, where a process with no source can
 * still create an item. Stood in for by one that refuses, so the listing
 * that meets it names the workflow that has none.
 */
const noSource = (): never => {
  throw new Error("no source hook is configured, so there is nothing to enumerate");
};
const sourceless = (): Source => ({ id: "none", relations: [], list: async () => noSource(), read: async () => noSource() });

/**
 * A person's reply on an item, posted as the operator: what `landrace_reply`
 * posts. The board's Retry is not a reply: it is a goto, and goes through
 * `sendTo`.
 *
 * Through the same dispatcher every other write goes through, so an
 * operator's reply reaches the tracker by the one path the engine knows how
 * to reason about — and a second tracker gets this for free.
 *
 * No marker, because it genuinely is a human turn: a marker separates our
 * writing from theirs, not who typed the request. Neutralised so a pasted
 * marker cannot forge state.
 *
 * And no lock, unlike `resolve`, which is a decision rather than an
 * oversight. `resolve` reads the item, decides from derived state whether it
 * is already handed back, and writes only if it is not: that
 * read-decide-write is what a per-item lock exists to make atomic. This
 * posts one comment unconditionally, so there is nothing to serialise — and
 * taking the lock would make a person's reply wait on, or fail against, the
 * ten-minute step they are replying to, which is the one moment a reply is
 * most wanted.
 *
 * The size, though, is the step path's rule and applies here too: a body the
 * tracker refuses throws with the API's own 422 instead of a sentence naming
 * the limit.
 */
export async function postReply(deps: ReplyDeps, item: string, message: string): Promise<void> {
  const tooLong = recordBodyProblem(message);
  if (tooLong) throw new Error(`cannot reply: the message ${tooLong}`);

  // Null: a reply decides nothing, and its snapshot only reaches the hook that writes it.
  const snapshot = await buildSnapshot({ item, source: deps.source, hooks: deps.pre, workflow: null, ctx: { ...deps.ctx, item } });
  await deps.dispatcher.apply(
    { type: RECORD_EFFECT, body: neutraliseMarkers(message) },
    { ...deps.ctx, item, snapshot },
  );
}

/**
 * The operator tools, over every workflow of the workspace.
 *
 * An item's workflow state is written through the one workflow that claims
 * it, found the way a tick finds it: every open item judged against every
 * workflow's `eligible`. The loop's process asks its last tick's listing;
 * this one judges on demand. An item two workflows claim, two sources
 * report, or none claims is refused with the reason — never routed through
 * whichever workflow comes first. Reads decide nothing, so they are refused
 * only where two sources report the id.
 */
export function createTools(workflows: readonly ToolWorkflow[], ctx: RuntimeContext, opts: ToolOptions = {}): Tools {
  const hands = new Map(workflows.map((w): [string, ToolHands] => {
    const source = w.registry.source ?? sourceless();
    // The tick's own pre hooks and the tick's own dispatcher, handed over rather
    // than rebuilt beside them: a conversation that read or wrote through a
    // second path would be writing state the tick cannot re-derive.
    const shared = {
      source, pre: w.registry.pre, dispatcher: createDispatcher(w.registry.post), ctx, executor: w.executor ?? null,
      // A turn is an agent invocation, so §15's screening reaches it the same
      // way it reaches a step — through the same option, carried rather than
      // accepted and dropped.
      ...(w.screen ? { screen: w.screen } : {}),
      ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
      ...(opts.lock ? { lock: opts.lock } : {}),
      // And for the same reason, the step's own declaration: a turn is held to
      // the capabilities and the model of the step it continues, which the
      // conversation can only read if the workflow reaches it. Carried rather
      // than loaded again here — a second read of the same directory is a second
      // answer, free to differ from the one the loop is actually running.
      workflow: w.workflow,
      steps: w.steps,
    };
    return [w.id, {
      workflow: w,
      deps: { ...shared, artifacts: w.registry.artifacts, ...(w.server ? { server: w.server, childServer: w.server } : {}) },
      conversation: createConversation({ ...shared, ...(opts.activity ? { activity: opts.activity } : {}) }),
    }];
  }));
  // What a listing asks of each workflow: the same the loop's runtime gives it.
  const listedAs: ListedWorkflow[] = [...hands.values()].map((h) => ({ id: h.workflow.id, source: h.deps.source, deps: { workflow: h.deps.workflow } }));
  const ids = (): string => workflows.map((w) => w.id).join(", ");

  const handsOf = (id: string): ToolHands => {
    const found = hands.get(id);
    if (!found) throw new Refusal(`no workflow "${id}"; the workspace has ${ids()}`);
    return found;
  };

  // Every distinct source, at the index each listing of these workflows gives it.
  const { sources: distinct } = sourcesOf(listedAs);

  /**
   * A listing whose every source listed. One that could not fails the call
   * by name, as `landrace status` does: an id the others list may be one it
   * reports too, and a list missing its items would read as a workspace with
   * none.
   */
  const whole = (listing: WorkspaceListing): WorkspaceListing => {
    const failures = listingFailures(listing);
    if (failures.length) throw new Error(failures.join("; "));
    return listing;
  };

  /** Every source listed once and every open item claimed, as a tick does. */
  const listed = async (): Promise<WorkspaceListing> => whole(await listWorkspace({ workflows: listedAs, ctx, log: ctx.log }));

  /**
   * What an action on one item is judged from; what could not list is left
   * in it, for the caller to judge. With one distinct source, that item read
   * alone: claims are per id, so a listing of every item would claim it
   * exactly the same, and one tracker has no other to clash with — listing
   * the whole repository to act on one item is paying for an answer already
   * known. With more, every source listed: a clash is between what two of
   * them list, and a read of one sees only its own.
   */
  const about = async (item: string): Promise<WorkspaceListing> => {
    const [only, ...more] = distinct;
    if (only === undefined || more.length > 0) return listWorkspace({ workflows: listedAs, ctx, log: ctx.log });
    let read: Graph;
    try {
      read = await only.read(item, ctx);
    } catch (e) {
      throw new Error(`source "${only.id}" could not read "${item}": ${messageOf(e)}`);
    }
    const graphs: Graph[] = [{ nodes: read.nodes.filter((n) => n.id === item && n.kind === ITEM_KIND), relationships: [] }];
    const sourceOf = new Map(listedAs.map((w) => [w.id, 0]));
    return { graphs, sourceOf, claims: claimsOf(listedAs, sourceOf, graphs), failed: new Map() };
  };

  /**
   * The workflow a listing or a create is about: the one named, checked, or
   * this server's own when it is bound to one; undefined for every workflow.
   */
  const within = (workflow: string | undefined): string | undefined => {
    if (workflow !== undefined) handsOf(workflow);
    if (opts.scope === undefined) return workflow;
    if (workflow !== undefined && workflow !== opts.scope) throw new Refusal(`this server acts for ${opts.scope} alone, not ${workflow}`);
    return opts.scope;
  };

  /** A claiming workflow's hands, unless this server is bound to another. */
  const ours = (item: string, id: string): ToolHands => {
    if (opts.scope !== undefined && id !== opts.scope) throw new Refusal(`#${item} belongs to ${id}; this server acts for ${opts.scope} alone`);
    return handsOf(id);
  };

  const unlisted = (item: string): string => `#${item} is not an item any source lists`;

  /** For a write to its workflow state: the hands of the one workflow that claims `item`, judged while every source lists. */
  const owner = async (item: string): Promise<ToolHands> => {
    const route = writeRoute(whole(await about(item)), item) ?? { refused: unlisted(item) };
    if ("refused" in route) throw new Refusal(route.refused);
    return ours(item, route.workflow);
  };

  /**
   * For an operator's edit, judged while every source lists: the owner's
   * operator, or the one operator every workflow that could own `item`
   * shares (see `editRoute`). A server bound to one workflow edits only what
   * no other claims, and only what its own source lists.
   */
  const editor = async (item: string): Promise<{ operator: Operator | null; workflow: string | null }> => {
    const listing = whole(await about(item));
    const route = editRoute(listing, item, (id) => handsOf(id).workflow.registry.operator);
    if ("refused" in route) throw new Refusal(route.refused);
    if ("workflow" in route) return { operator: ours(item, route.workflow).workflow.registry.operator, workflow: route.workflow };
    if (opts.scope !== undefined) {
      // Two claiming it are always one more than this server acts for.
      const conflict = writeRoute(listing, item);
      if (listing.claims.conflicts.has(item) && conflict && "refused" in conflict) throw new Refusal(conflict.refused);
      if (!route.workflows.includes(opts.scope)) {
        throw new Refusal(`#${item} is not listed by ${opts.scope}'s source; this server acts for ${opts.scope} alone`);
      }
    }
    const [any] = route.workflows;
    return { operator: any === undefined ? null : handsOf(any).workflow.registry.operator, workflow: null };
  };

  /**
   * For a read: an owned item through its owner, as `owner`; any other item
   * through the one source that lists it, with the pre hooks every workflow
   * on that source loads, and why no workflow works it. Reads decide
   * nothing, so a source that could not list stops none — but an id no
   * working source showed could be in the one that did not.
   */
  const reader = async (item: string): Promise<
    { hands: ToolHands; claims: Claims } | { source: Source; pre: PreHook[]; why: string | null; claims: Claims }
  > => {
    const listing = await about(item);
    const route = readRoute(listing, item) ?? { refused: [unlisted(item), ...listingFailures(listing)].join("; ") };
    if ("refused" in route) throw new Refusal(route.refused);
    const { claims } = listing;
    if ("workflow" in route) return { hands: ours(item, route.workflow), claims };
    if (opts.scope !== undefined && listing.sourceOf.get(opts.scope) !== route.source) {
      throw new Refusal(`#${item} is not listed by ${opts.scope}'s source; this server acts for ${opts.scope} alone`);
    }
    const source = distinct[route.source];
    if (!source) throw new Refusal(unlisted(item));
    const on = [...hands.values()].filter((h) => h.deps.source === source);
    const pre = sharedPre(on.map((h) => h.deps.pre));
    if (!pre) throw new Refusal(noSharedPre(item, on.map((h) => h.workflow.id)));
    return { source, pre, why: unownedWhy(claims, item), claims };
  };

  /**
   * The workflow a new item is started in: the one named, or the one that can
   * create items at all. Two that can is a question for the caller, never the
   * first of them: an item started there is worked by a workflow nobody chose.
   */
  const creator = (workflow: string | undefined): ToolHands => {
    const named = within(workflow);
    if (named !== undefined) return handsOf(named);
    const able = [...hands.values()].filter((h) => h.workflow.registry.operator !== null);
    if (able.length > 1) {
      throw new Refusal(`which workflow? ${able.map((h) => h.workflow.id).join(", ")}: more than one can create items, so name one`);
    }
    // None able: any one says there is no operator, in requireOperator's words.
    const [one] = able.length ? able : [...hands.values()];
    if (!one) throw new Error("cannot create an item: the workspace has no workflow");
    return one;
  };

  /** Read for its owner's workflow, which places it; an item no one workflow owns is placed by its label alone. */
  const snapshotIn = (deps: { source: Source; pre: PreHook[] }, workflow: Workflow | null, item: string): Promise<Snapshot> =>
    buildSnapshot({ item, source: deps.source, hooks: deps.pre, workflow, ctx: { ...ctx, item } });

  const summarise = (n: Node) => ({ item: n.id, title: n.title, url: n.link, labels: labelsOf(n) });

  // Called once a write has succeeded, never after a throw: a throw wrote
  // nothing a pass could pick up. And never at the answer's expense — the
  // write has happened, and a wake that failed only costs the wait for the
  // next scheduled tick.
  const wakeLoop = (): void => {
    try {
      opts.wake?.();
    } catch (e) {
      ctx.log("wake.failed", { reason: messageOf(e) });
    }
  };

  /** The workflows a halt on `item` names — two claiming it, or two sources' — or null for any other item. */
  const partiesTo = (claims: Claims, item: string): string[] | null => claims.conflicts.get(item) ?? claims.clashes.get(item) ?? null;

  /**
   * Whether `row` belongs in `only`'s list: an item it claims, or a halt it
   * is party to — a pairing's session has to see the conflict its own
   * workflow is in. Every row when no workflow is asked for.
   */
  const shows = (only: string | undefined, row: StatusRow, claims: Claims): boolean =>
    only === undefined || row.workflow === only || (row.workflow === undefined && (partiesTo(claims, row.item)?.includes(only) ?? false));

  /**
   * The board's lane for `row`, or null for an item every workflow turned
   * away, which is not anyone's to list. A halt is a person's to settle. The
   * one answer `items` and `waiting` both give, so neither list can disagree
   * with the other or with the page.
   */
  const laneIn = (row: StatusRow, claims: Claims): Lane | null => {
    if (row.workflow !== undefined) return laneOf(row, handsOf(row.workflow).deps.workflow);
    return partiesTo(claims, row.item) === null ? null : "needs-you";
  };

  return {
    // Said in every tool's description, so an agent holding this server knows before it asks.
    scope: opts.scope ?? null,

    async workflows() {
      const listing = await listed();
      const rows = workspaceStatusRows(listedAs, listing);
      return workflows.filter((w) => opts.scope === undefined || w.id === opts.scope).map((w) => {
        const mine = rows.filter((row) => row.workflow === w.id);
        return {
          id: w.id, name: w.workflow.name, description: w.workflow.description,
          // Whether `landrace_create_item` can start an item in it at all.
          creates: w.registry.operator !== null,
          claimed: mine.length,
          // In the board's own lanes, so the count and the page agree.
          needsYou: mine.filter((row) => laneOf(row, w.workflow) === "needs-you").length,
        };
      });
    },

    async items({ workflow } = {}) {
      const only = within(workflow);
      const listing = await listed();
      // `landrace status`'s own rows, so an agent is told what the table says.
      return workspaceStatusRows(listedAs, listing).flatMap((row): ItemSummary[] => {
        const lane = laneIn(row, listing.claims);
        if (lane === null || !shows(only, row, listing.claims)) return [];
        return [{
          item: row.item, title: row.title, workflow: row.workflow ?? null, stage: row.stage, lane,
          ...(row.workflow === undefined ? { why: row.note } : {}),
        }];
      });
    },

    async waiting({ workflow } = {}) {
      const only = within(workflow);
      const listing = await listed();
      // Filtered here, not in the hook: whose turn it is is the engine's own
      // vocabulary — the `waits` of the stage an item is at — and a source
      // that had to know it would be a source that had to know the workflow.
      // The board's Needs you, exactly: the same rows, in the same lane.
      const nodes = new Map<string, Node>();
      for (const node of listing.graphs.flatMap((g) => g.nodes)) if (isOpenItem(node) && !nodes.has(node.id)) nodes.set(node.id, node);
      return workspaceStatusRows(listedAs, listing).flatMap((row): WaitingItem[] => {
        const node = nodes.get(row.item);
        if (!node || laneIn(row, listing.claims) !== "needs-you" || !shows(only, row, listing.claims)) return [];
        return [{ item: row.item, title: row.title, url: node.link, workflow: row.workflow ?? null, ...(row.workflow === undefined ? { why: row.note } : {}) }];
      });
    },

    async status(item) {
      const route = await reader(item);
      // The same snapshot the tick builds, from the same pre hooks in the same
      // order, so what an operator is shown is what the engine would decide
      // on — not a second derivation free to drift from it.
      const snapshot = await ("hands" in route ? snapshotIn(route.hands.deps, route.hands.deps.workflow, item) : snapshotIn(route, null, item));
      const node = snapshot.node as Node;
      const labels = labelsOf(node);
      const { stage: labelled, ambiguous, found } = stageFromLabels(labels);
      const run = snapshot.run;
      // Where it is and whether it waits on you, from the row the board and
      // `landrace_waiting` read — the stage its owner's stages place it at,
      // and that stage's `waits` — never a second reading of its labels free
      // to disagree with them. An item no one workflow owns is placed by none
      // of their stages: its label is all there is to show.
      const owned = "hands" in route ? statusRows(route.hands.deps.workflow, [node])[0] : undefined;
      const row: StatusRow = owned && "hands" in route
        ? { ...owned, workflow: route.hands.workflow.id }
        : { item, title: node.title, stage: labelled, note: "" };
      const where = "hands" in route && !ambiguous ? locateNode(route.hands.deps.workflow, node) : null;

      return {
        item,
        // Null for an item no one workflow owns: closed, claimed twice, or turned away.
        workflow: "hands" in route ? route.hands.workflow.id : null,
        title: node.title,
        url: node.link,
        // The one piece of lifecycle every source reports the same way: open
        // is null, a closed item says whether it was finished or dropped.
        closed: node.closed,
        labels,
        stage: row.stage,
        // Which ones: taking one of them off is the fix, and the engine now
        // halts on this same fact rather than picking one and paying for it.
        ...(ambiguous
          ? { problem: `more than one lr:stage:* label (${found.join(", ")}) — the item cannot be placed` }
          : where?.kind === "ambiguous" ? { problem: cannotPlace(where.ids) } : {}),
        // The workflow's own rule, asked of the snapshot `decide` would gate
        // on — not a label name: the engine names none. An open item no one
        // workflow owns is worked by none, and says why; a closed one is no
        // workflow's, so nothing is asked.
        ...("hands" in route
          ? { eligible: checkEligible(route.hands.deps.workflow, snapshot).eligible }
          : node.closed === null ? { eligible: false, ...(route.why === null ? {} : { why: route.why }) } : {}),
        // Exactly when `landrace_waiting` lists it: an open item in the board's
        // Needs you — a person's turn, a block or a halt. `blocked` says whether
        // it is a block. Open asked of the node read here, not of the routing:
        // an item closed since is Done on the board, whatever stage it was at.
        waitingOnYou: node.closed === null && laneIn(row, route.claims) === "needs-you",
        blocked: labels.includes(LABELS.blocked),
        rounds: run?.counters ?? {},
        lastEvent: run?.lastEvent ?? null,
        lastOutputValid: run?.lastOutputValid ?? null,
      };
    },

    async createItem({ workflow, title, body = "", labels = [], start = true }) {
      const { workflow: w } = creator(workflow);
      const operator = requireOperator(w.registry.operator, "create an item");
      refuseEngineLabels(labels, "set");
      // `start` is the one exception, and it is ours to set, not the caller's:
      // the labels the workflow admits with, which the engine names none of.
      // Refused before anything is written, never filed unstarted instead —
      // the caller asked for it to be worked, and would be told it is.
      const admit = w.workflow.admit ?? [];
      if (start && admit.length === 0) {
        // The folder to edit, by its id: the display name is not a path.
        throw new Error(
          `workflow "${w.id}" admits nothing: add admit: [<labels>] to ` +
          `workflows/${w.id}/workflow.yaml, or create with start: false`,
        );
      }
      const wanted = [...new Set([...labels, ...(start ? admit : [])])];
      // A marker pasted into a body would read back as something we wrote.
      const created = await operator.createItem({ title, body: neutraliseMarkers(body), labels: wanted }, ctx);
      wakeLoop();
      return { ...summarise(created), workflow: w.id, started: admit.length > 0 && admit.every((l) => wanted.includes(l)) };
    },

    async updateItem(item, { title, body, state, addLabels = [], removeLabels = [] }) {
      // Before any listing: with no operator anywhere, there is nothing to
      // find the item's for.
      if (!workflows.some((w) => w.registry.operator !== null)) requireOperator(null, "update an item");
      // Both lists are checked before anything is written, so a rejected call
      // leaves the item exactly as it was.
      refuseEngineLabels(addLabels, "add");
      refuseEngineLabels(removeLabels, "remove");
      const edit = await editor(item);
      const operator = requireOperator(edit.operator, "update an item");

      const updated = await operator.updateItem(
        item,
        {
          ...(title === undefined ? {} : { title }),
          ...(body === undefined ? {} : { body: neutraliseMarkers(body) }),
          ...(state === undefined ? {} : { state }),
          addLabels,
          removeLabels,
        },
        ctx,
      );
      wakeLoop();
      // Null for an item no one workflow owns: its edit went through no workflow.
      return { ...summarise(updated), workflow: edit.workflow };
    },

    async reply(item, message) {
      await postReply((await owner(item)).deps, item, message);
      wakeLoop();
      return { item, posted: true };
    },

    async goto(item, stage) {
      // The claiming workflow is what says where a stage may send an item,
      // and its deps carry the lock this process was told the tick takes, as
      // the conversation's do: a goto has to wait on the tick that would take it.
      const r = await sendTo((await owner(item)).deps, item, stage);
      if ("refused" in r) throw new Error(r.refused);
      wakeLoop();
      return { item, to: r.to, posted: true };
    },

    async clear(item, stage) {
      const r = await sendTo((await owner(item)).deps, item, stage ?? null, { clear: true });
      if ("refused" in r) throw new Error(r.refused);
      wakeLoop();
      return { item, to: r.to, cleared: true, posted: true };
    },

    async ask(item, message, askOpts) {
      const answered = await (await owner(item)).conversation.ask(item, message, askOpts);
      wakeLoop();
      return answered;
    },

    async resolve(item, why) {
      const resolved = await (await owner(item)).conversation.resolve(item, why);
      wakeLoop();
      return resolved;
    },

    async pairing(item) {
      const route = await reader(item);
      if ("hands" in route) return pairingView(route.hands.deps, item);
      // An item no one workflow owns is no one's to pair on; only a pairing left open on it is said.
      return { open: (await snapshotIn(route, null, item)).run?.pairing ?? null, offers: [] };
    },

    async pair(item, stage) {
      const started = await startPair((await owner(item)).deps, item, stage);
      wakeLoop();
      return started;
    },

    async finish(item, note) {
      const { deps } = await owner(item);
      // Woken whichever way it ends: a refused hand-in has written the
      // rejected round, and the loop is what halts the item on it.
      try {
        return await finishPair(deps, item, note);
      } finally {
        wakeLoop();
      }
    },

    async release(item) {
      const released = await releasePair((await owner(item)).deps, item);
      wakeLoop();
      return released;
    },
  };
}
