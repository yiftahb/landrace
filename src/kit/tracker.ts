/*
 * What every tracker integration shares and none of them is: telling our own
 * comments from a stranger's, the `satisfied()` of each tracker effect, and
 * reading an item into the node the engine routes on. Published as part of
 * `landrace/kit`.
 *
 * Every `satisfied()` here is synchronous and reads only the snapshot, which
 * is its contract; an integration's `satisfied()` is a switch over the effect
 * types it handles that calls one of these per type. What stays with the
 * integration is its API: the queries, their shapes, their paging, and
 * mapping what they answer into the plain fields `itemNode` takes.
 */
import {
  allClosed, CLOSE_EFFECT, COMMENT_VISIBILITIES, distinctRelations, entriesFromComments, itemIdProblem, LABEL_EFFECT, LABELS, labelsOf, MAX_SUBGRAPH_NODES,
  neutraliseMarkers, NODES_CLOSE_EFFECT, parseMarker, parseOrigin, RECORD_EFFECT, recordMarker, RELATED_FACTS, RELATIONS, renderMarker,
  renderOrigin, sameLogin, STAGE_LABEL_PREFIX, STATUS_EFFECT, stripMarker, ITEM_KIND,
} from "#conventions.js";
import { commentLine } from "#kit/forge.js";
import type {
  BriefTable, CommentVisibility, Effect, EffectTable, Graph, HistoryItem, HookContext, NewItem, Node, OpenRelations, RelatedRecord, RelationDecl, Relationship,
  RuntimeContext, Snapshot, SnapshotComment, ItemPatch, ItemRecord, TrackerComment,
} from "#namespace.js";

export type { SnapshotComment } from "#namespace.js";

/**
 * A tracker's page size for a connection, and how many pages one read will
 * pay for. A count that stopped at the first page would read a 150-thread pull
 * request as having fewer findings than it has — and, with the first hundred
 * resolved, as having none at all, which is an item leaving the review loop
 * with open findings on it. Past the cap the honest answer is that the count
 * could not be read, not a number we know is short.
 */
export const THREAD_PAGE = 100;
export const MAX_THREAD_PAGES = 10;

/** The same bound on the issue and pull request lists, for the same reason: a list that stops at 100 without saying so. */
export const ISSUE_PAGE = 100;
export const MAX_ISSUE_PAGES = 10;

/**
 * How many sub-issues, and pull requests each way, one item read carries.
 * Every one of them is counted by the workflow — "every child closed", "every
 * pull request merged" — so an item with more than this is refused by
 * `read` rather than read as one with fewer.
 */
export const ITEM_PAGE = 50;

// ponytail: a constant, not a setting — tracker config if another window is ever wanted.
/** How far back the board's Done lane reaches. Display only: tick works open items alone. */
export const DONE_WINDOW_MS = 30 * 86_400_000;

/**
 * How much of an item's own text a prompt is handed: the whole brief of a
 * step with no spec to work from. Beside the forge's `ci` briefing, which a
 * build that fixes a red pull request names too, the two stay inside the
 * engine's 32 KB per hook, so a long description never cuts the logs off.
 */
export const BRIEF_ITEM_CHARS = 16_000;

/** Said, so a prompt never shows a hole where the item's text would be. */
export const NO_ITEM_TEXT = "This item has no description beyond its title.";

/**
 * `{brief.project.body}`: the item's text as the tracker holds it, without
 * the marker Landrace stamps on an item it created, and cut at a bound that
 * says where and at what: these are requirements, and a cut a build or a
 * review cannot see is a requirement missed by both. Escaping it is the
 * engine's, on the way into the prompt.
 */
export function bodyBrief(body: string): string {
  const text = stripMarker(body);
  if (text === "") return NO_ITEM_TEXT;
  if (text.length <= BRIEF_ITEM_CHARS) return text;
  return `${text.slice(0, BRIEF_ITEM_CHARS)}\n\n[the item's text is cut here at ${BRIEF_ITEM_CHARS.toLocaleString("en-US")} characters]`;
}

/** The item's comments, as the pre hook put them in the snapshot. */
export const commentsOf = (s: Snapshot): SnapshotComment[] =>
  ((s.item as { comments?: SnapshotComment[] })?.comments ?? []);

/**
 * Who we post as, as the pre hook recorded it this tick. satisfied() is
 * synchronous by contract, so it cannot resolve the login itself; the
 * snapshot is where the state a decision reads belongs anyway.
 *
 * Absent means we cannot tell whether an effect has landed, and the two ways
 * of guessing are both wrong: "satisfied" silently drops the work, "not
 * satisfied" re-posts a comment on every tick. Halting is the third option,
 * and the dispatcher attributes the throw to the hook.
 */
export function botLoginOf(s: Snapshot): string {
  const bot = (s.tracker as { bot?: unknown } | undefined)?.bot;
  if (typeof bot !== "string" || !bot.trim()) {
    throw new Error("the snapshot does not record the login landrace posts as, so no effect can be checked");
  }
  return bot.trim().toLowerCase();
}

/** sameLogin, for the reason entriesFromComments uses it: an app has two spellings. */
export const wroteIt = (c: SnapshotComment, bot: string): boolean =>
  typeof c.user?.login === "string" && sameLogin(c.user.login, bot);

/*
 * The labels the source read, not a second copy of them from the pre hook:
 * one reading of the item, which is the one the engine placed it from.
 *
 * The two label effects read labels, which only an account with write access
 * can set — unlike a comment, which anyone can post. Forging one is the
 * operator-tools problem (lr: labels are refused there), not an authorship
 * question a hook can answer.
 */

/** `tracker.label`: every label added is there, and every one removed is not. */
export function labelSatisfied(snapshot: Snapshot, effect: Effect): boolean {
  const present = labelsOf(snapshot.node as Node | undefined);
  const add = (effect.add as string[]) ?? [];
  const remove = (effect.remove as string[]) ?? [];
  return add.every((l) => present.includes(l)) && remove.every((l) => !present.includes(l));
}

/** `tracker.status`: on a tracker with no status field, position is a stage label. */
export function statusSatisfied(snapshot: Snapshot, effect: Effect): boolean {
  return labelsOf(snapshot.node as Node | undefined).includes(LABELS.stage(String(effect.value)));
}

/** `tracker.comment`: a comment we wrote, carrying exactly this effect's marker. */
export function commentSatisfied(snapshot: Snapshot, effect: Effect): boolean {
  // An unmarked comment is an operator's own turn, applied directly and
  // never planned by a stage — nothing on the item would say it had
  // already been posted, so reconciling one could only mean re-posting it
  // on every tick. Halting is the honest answer, and it is the rule that
  // every effect has a real satisfied() beside its apply().
  if (effect.marker === undefined) {
    throw new Error(
      "a tracker.comment effect with no marker cannot be reconciled: nothing would record that it had " +
      "already been posted, so it would be posted again on every tick",
    );
  }
  // Only a comment *we* wrote can mean our comment effect has landed.
  // Reading any comment let a stranger who guessed the marker string
  // suppress the effect for good, because reconcile drops it.
  //
  // And only the marker we stamped, parsed and compared whole — never
  // the token found somewhere in the body. A body is mostly the agent's
  // own prose, and an output comment now carries the agent's own words
  // inside the marker as well, so a substring scan hands the agent the
  // token that means "this already happened": one round's prose
  // containing "enter:spec:2" makes reconcile drop the next round's
  // entry record, and a stage with no new entry record reads as complete
  // and is never run again. The same scan also made "enter:x:1"
  // satisfied by a comment recording "enter:x:10".
  const bot = botLoginOf(snapshot);
  const marker = String(effect.marker);
  return commentsOf(snapshot).some((c) => wroteIt(c, bot) && parseMarker(c.body ?? "")?.marker === marker);
}

/** `nodes.close`: every node named is closed. */
export function nodesCloseSatisfied(snapshot: Snapshot, effect: Effect): boolean {
  return allClosed(snapshot.graph as Graph | undefined, (effect.ids as string[] | undefined) ?? []);
}

/**
 * How `tracker.close` closes the item: `done`, a finished item, unless the
 * effect says `how: dropped` — a person asked for it to be dropped, which a
 * tracker that keeps a reason reports as such. A value it does not know is
 * refused, never read as done.
 */
export function closeHow(effect: Effect): "done" | "dropped" {
  const how = effect.how ?? "done";
  if (how === "done" || how === "dropped") return how;
  throw new Error(`a tracker.close effect closes an item as "done" or "dropped", not ${JSON.stringify(how)}`);
}

/**
 * Who a `tracker.comment` is for, as it says, or undefined when it says
 * nothing. A value it does not know is refused, never read as either: a note
 * meant for the team posted where the requester reads it cannot be unsaid.
 */
export function visibilityOf(effect: Effect): CommentVisibility | undefined {
  const { visibility } = effect;
  if (visibility === undefined) return undefined;
  if (typeof visibility === "string" && COMMENT_VISIBILITIES.includes(visibility)) return visibility as CommentVisibility;
  throw new Error(`a tracker.comment effect is ${COMMENT_VISIBILITIES.map((v) => `"${v}"`).join(" or ")}, not ${JSON.stringify(visibility)}`);
}

/**
 * `tracker.close`. Closed either way counts: a person who closed it as not
 * planned decided that, and re-closing it as completed would overrule them.
 */
export function closeSatisfied(snapshot: Snapshot): boolean {
  return ((snapshot.node as Node | undefined)?.closed ?? null) !== null;
}

const PRIORITY_LABEL = /^P([0-9])$/;

/**
 * `P0`..`P9`, the convention landrace's labels use. Two of them is an item
 * whose priority cannot be told — reported, like two stage labels, rather
 * than resolved by taking the first.
 */
export function priorityFromLabels(labels: string[]): { priority: number | null; found: string[] } {
  const found = labels.filter((l) => PRIORITY_LABEL.test(l));
  const only = found.length === 1 ? found[0] : undefined;
  return { priority: only === undefined ? null : Number(PRIORITY_LABEL.exec(only)?.[1]), found };
}

/** The board's "opened 3h ago": absent, not NaN, when the tracker gave no parseable time. */
export function createdAtOf(at: string | undefined): { createdAt?: number } {
  const ms = at === undefined ? NaN : Date.parse(at);
  return Number.isNaN(ms) ? {} : { createdAt: ms };
}

/** The board's lane order, from when the tracker says the item last changed: absent, not NaN, likewise. */
export function updatedAtOf(at: string | undefined): { updatedAt?: number } {
  const ms = at === undefined ? NaN : Date.parse(at);
  return Number.isNaN(ms) ? {} : { updatedAt: ms };
}

/**
 * The one mapping from an item, as an integration reads its tracker's, to an
 * item node. `bot` is the login we post as: an origin counts only in a body
 * we wrote, because a re-run closes whatever claims it. The parent is an
 * edge, not a field, so it is not asked for here.
 */
export function itemNode(item: Omit<ItemRecord, "parent">, bot: string): Node {
  return {
    id: item.id,
    kind: ITEM_KIND,
    title: item.title,
    link: item.link,
    closed: item.closed,
    priority: item.priority !== undefined ? item.priority : priorityFromLabels(item.labels).priority,
    // Nobody but us may have touched the body since: a person keeps the
    // bot's authorship when they edit it, and could otherwise rewrite the
    // marker to claim another stage or round.
    origin: item.editor !== undefined && !sameLogin(item.editor, bot)
      ? null
      : parseOrigin(item.body, item.author, bot),
    // Always lists, and empty rather than absent: an eligibility rule reading
    // a path the node does not carry is one the tick cannot answer, and it
    // abstains on those — so an unassigned item would be worked by every
    // instance instead of none.
    state: { labels: item.labels, assignees: item.assignees },
    ...createdAtOf(item.createdAt),
    ...updatedAtOf(item.updatedAt),
  };
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Past this, a read is refused rather than decided from: the words every bound on one read uses. */
const tooLarge = (id: string): Error =>
  new Error(`#${id} has more than the ${MAX_SUBGRAPH_NODES} nodes one read may carry; a graph known to be short is not one to decide from`);

/**
 * A related item the tracker reports nothing else of — closed long ago,
 * kept in another repository, or outside the neighbourhood read — as the far
 * end of its edge, from what the relationship said of it. Its labels are not
 * known, so they are empty: it is placed at no stage and claimed by nobody.
 */
export function placeholderNode(related: RelatedRecord): Node {
  return {
    id: related.to,
    kind: ITEM_KIND,
    title: related.title,
    link: related.link,
    // One whose state could not be read is open, never a guess at done.
    closed: related.unreadable === true ? null : related.closed,
    priority: null,
    origin: null,
    state: { labels: [], assignees: [] },
    placeholder: true,
    ...(related.unreadable === true ? { unreadable: true as const } : {}),
  };
}

/**
 * Which of two placeholders for one id is drawn: an open one over one that
 * could not be read, and either over a closed one — so nothing reads as
 * done that may not be, and a state one answer read is not hidden by
 * another that could not read it.
 */
const placeholderRank = (node: Node): number => (node.closed !== null ? 0 : node.unreadable === true ? 1 : 2);

/**
 * The relationships of an item a graph can carry, and whether it reported
 * any it cannot: one to an id no node may have is an item nobody can name,
 * and is read as one that could not be read — never as no relationship.
 */
export function relatedOf(item: ItemRecord): { related: RelatedRecord[]; whole: boolean } {
  const all = item.related ?? [];
  const related = all.filter((r) => itemIdProblem(r.to) === null);
  return {
    related,
    whole: item.relatedComplete !== false && related.length === all.length && !related.some((r) => r.unreadable === true),
  };
}

/**
 * The open items' relationships of `type`, as a full list of items holds
 * them: what `BaseTracker.openRelations` answers unless an integration asks
 * more cheaply, and what `list` judges from — so a list and a read agree by
 * construction whenever the two answers hold the same items.
 */
export function openRelationsOf(items: ReadonlyArray<ItemRecord>, type: string): OpenRelations {
  const open = items.filter((t) => t.closed === null);
  return {
    open: open.map((t) => t.id),
    edges: open.flatMap((t) => (t.related ?? []).filter((r) => r.type === type && r.closed === null).map((r) => ({ from: t.id, to: r.to }))),
    partial: open.filter((t) => t.relatedComplete === false || (t.related ?? []).some((r) => r.unreadable === true)).map((t) => t.id),
  };
}

/** Nothing open: the walk of an item with no open blocker of the tracker's own. */
const NO_RELATIONS: OpenRelations = { open: [], edges: [], partial: [] };

/** An answer indexed for walking, once: a listing walks it once per item. */
const indexes = new WeakMap<OpenRelations, { open: Set<string>; partial: Set<string>; out: Map<string, string[]> }>();
function indexOf(relations: OpenRelations): { open: Set<string>; partial: Set<string>; out: Map<string, string[]> } {
  const known = indexes.get(relations);
  if (known !== undefined) return known;
  const out = new Map<string, string[]>();
  for (const { from, to } of relations.edges) out.set(from, [...(out.get(from) ?? []), to]);
  const index = { open: new Set(relations.open), partial: new Set(relations.partial), out };
  indexes.set(relations, index);
  return index;
}

/**
 * Whether `root` waits on itself: its open blockers walked transitively over
 * `relations` — the tracker's open items and their open blockers, as one
 * answer has them, so a walk costs no read per blocker. The one judge of it
 * for `list` and `read` alike, so the two agree by construction.
 *
 * Only through the tracker's own items: a blocker it does not `own` (another
 * tracker's, another repository's) holds the item back by the state its
 * relationship reports, and a cycle through it goes unseen. One it owns that
 * the answer does not hold open is closed since, or gone: the walk stops
 * there, and nothing about it is unreadable.
 *
 * `whole` is false when a blocker the walk met had relationships the answer
 * could not read all of, so a cycle through them cannot be ruled out — the
 * root's own are `relatedOf`'s to judge. A walk past MAX_SUBGRAPH_NODES
 * items is refused, as a read that large is. A closed item waits on nothing.
 */
export function blockerCycle(
  root: ItemRecord, relations: OpenRelations, owns: (id: string) => boolean,
): { cycle: boolean; whole: boolean } {
  if (root.closed !== null) return { cycle: false, whole: true };
  const { open, partial, out } = indexOf(relations);
  const seen = new Set([root.id]);
  const queue: string[] = [];
  let cycle = false;
  let whole = true;
  const follow = (to: string): void => {
    if (to === root.id) cycle = true;
    else if (itemIdProblem(to) !== null) whole = false;
    else if (!seen.has(to) && owns(to) && open.has(to)) {
      seen.add(to);
      if (seen.size > MAX_SUBGRAPH_NODES) throw tooLarge(root.id);
      queue.push(to);
    }
  };
  for (const r of root.related ?? []) if (r.type === RELATIONS.blockedBy && r.closed === null) follow(r.to);
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i] as string;
    if (partial.has(at)) whole = false;
    for (const to of out.get(at) ?? []) follow(to);
  }
  return { cycle, whole };
}

/** Whether `blockerCycle` has anywhere to go from `root`: an open blocker of the tracker's own besides itself. */
export function waitsOnOwn(root: ItemRecord, owns: (id: string) => boolean): boolean {
  return root.closed === null && (root.related ?? []).some((r) =>
    r.type === RELATIONS.blockedBy && r.closed === null && r.to !== root.id && itemIdProblem(r.to) === null && owns(r.to));
}

/**
 * What the base reports of an item's relationships, on its own node and only
 * when true: a field present only when it holds keeps every other item's
 * state exactly what its tracker said. Facts, for a workflow to route on —
 * the base never decides anything from them.
 */
function withFacts(node: Node, { unreadable, cycle }: { unreadable: boolean; cycle: boolean }): Node {
  if (!unreadable && !cycle) return node;
  return {
    ...node,
    state: {
      ...node.state,
      ...(unreadable ? { [RELATED_FACTS.unreadable]: true } : {}),
      ...(cycle ? { [RELATED_FACTS.cycle]: true } : {}),
    },
  };
}

/** One edge per relationship, a repeat dropped; and a placeholder for an id `known` does not hold, by `placeholderRank`. */
function drawRelated(
  from: string, related: RelatedRecord[], known: (id: string) => boolean,
  edges: Map<string, Relationship>, placeholders: Map<string, Node>,
): void {
  for (const r of related) {
    edges.set(JSON.stringify([from, r.to, r.type]), { from, to: r.to, type: r.type });
    if (known(r.to)) continue;
    const had = placeholders.get(r.to);
    const next = placeholderNode(r);
    if (had === undefined || placeholderRank(next) > placeholderRank(had)) placeholders.set(r.to, next);
  }
}

/** The types a tracker writes, as a refusal names them. */
const writtenTypes = (types: string[]): string =>
  types.length === 0 ? "no relationship" : `only ${types.map((t) => `"${t}"`).join(", ")}`;

/**
 * The ids a `nodes.close` names that the snapshot's graph does not already
 * show closed. Already closed is left alone: a merged pull request cannot be
 * un-merged, and an item closed as done must not be re-closed as dropped.
 */
export function stillOpen(snapshot: Snapshot, effect: Effect): string[] {
  const closed = new Map(((snapshot.graph as Graph | undefined)?.nodes ?? []).map((n) => [n.id, n.closed]));
  return strings(effect.ids).filter((id) => (closed.get(id) ?? null) === null);
}

/**
 * A tracker integration: its vendor's calls, and nothing else.
 *
 * An integration extends this and writes the abstract methods — each one a
 * request to its tracker, answered in the plain shapes of `src/namespace.ts`.
 * Everything a tracker does that is not its vendor's is here: the item
 * graph and its bounds, the pre hook's fragment, the five tracker effects
 * with their `satisfied()`, the history's comments, and the operator's two
 * writes. `compose` makes the hooks out of it.
 *
 * To change one piece, subclass and override it: an effect by spreading
 * `super.effects()` and replacing or adding an entry, a briefing the same way
 * with `briefs()`.
 */
export abstract class BaseTracker {
  /** The login we post as: what tells our comments and markers from a stranger's. */
  abstract login(ctx: RuntimeContext): Promise<string>;
  /** Every open item, and any closed one the board should still show, each with its parent. */
  abstract items(ctx: RuntimeContext): Promise<ItemRecord[]>;
  /** One item. Throws when there is none: a missing item is not an empty one. */
  abstract item(id: string, ctx: RuntimeContext): Promise<ItemRecord>;
  /** An item's children, closed ones too: "every child closed" counts all of them. */
  abstract children(id: string, ctx: RuntimeContext): Promise<ItemRecord[]>;
  /** Every comment on an item, oldest first, every page — or a refusal, never a short list. */
  abstract comments(id: string, ctx: RuntimeContext): Promise<TrackerComment[]>;
  /**
   * Post a comment exactly as given: the base has already escaped it and
   * stamped its marker. `visibility` is the effect's own, absent when it names
   * none; a tracker that cannot tell the team's notes from what a requester
   * reads ignores it.
   */
  abstract comment(id: string, body: string, ctx: RuntimeContext, opts?: { visibility?: CommentVisibility }): Promise<void>;
  abstract addLabels(id: string, labels: string[], ctx: RuntimeContext): Promise<void>;
  abstract removeLabel(id: string, label: string, ctx: RuntimeContext): Promise<void>;
  /** Close an item as done (completed) or dropped (not planned). */
  abstract close(id: string, how: "done" | "dropped", ctx: RuntimeContext): Promise<void>;
  /**
   * Create an item — linked under `parent`, with `priority` in whatever form
   * the tracker keeps it — and answer its id. The body is already escaped and
   * stamped; the labels follow from the base once it is linked, because the
   * eligibility label is what lets a tick work it.
   */
  abstract create(
    item: { title: string; body: string; parent: string | undefined; priority: number | undefined },
    ctx: RuntimeContext,
  ): Promise<string>;
  /** Change an item's title, body or state; labels go through `addLabels` and `removeLabel`. */
  abstract update(id: string, fields: Pick<ItemPatch, "title" | "body" | "state">, ctx: RuntimeContext): Promise<void>;

  /** Run once at startup, before anything is paid for: a permission the workflow needs and the token lacks, say. */
  check?(ctx: RuntimeContext): Promise<void>;

  /** Relate `item` to `other` as `type`, one of `writableRelations()`; the base has checked the type. */
  protected abstract addRelation(item: string, type: string, other: string, ctx: RuntimeContext): Promise<void>;
  protected abstract removeRelation(item: string, type: string, other: string, ctx: RuntimeContext): Promise<void>;

  /**
   * Every open item's relationships of `type`, for a read's blocker walk:
   * from `items()`, unless an integration has a cheaper way to ask for them
   * alone. An override answers every open item or refuses, as `items()`
   * does, and names in `partial` each one whose relationships it could not
   * read all of — never a shorter answer read as no relationship.
   */
  protected async openRelations(type: string, ctx: RuntimeContext): Promise<OpenRelations> {
    return openRelationsOf(await this.items(ctx), type);
  }

  /** The relationship types this tracker writes: none, until an integration says which. */
  protected writableRelations(): string[] {
    return [];
  }

  /**
   * Whether a related id is one of this tracker's own items, which the
   * blocker walk reads through — rather than another tracker's or another
   * repository's, which it never reads. Every id, until an integration
   * whose relationships reach elsewhere says which are its own.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the id is what an override judges; the default owns every one
  protected ownsId(id: string): boolean {
    return true;
  }

  /**
   * The relationship types beside `child-of` this tracker's
   * `ItemRecord.related` reports: none, until an integration says which it
   * reads. A type it never reads is never declared, so a workflow routing
   * on one fails `validate` rather than reading "none" of what it cannot see.
   */
  protected readRelations(): string[] {
    return [];
  }

  /**
   * An item's parent, and whatever else it relates to — `blocked-by`, say.
   * Not singular: an item may wait on many. Drawn outward only by a read,
   * which reads the item's own relationships and never another's toward it.
   */
  relations(): RelationDecl[] {
    return [
      { type: RELATIONS.childOf, singular: true },
      ...this.readRelations().map((type): RelationDecl => ({ type, singular: false, outwardOnly: true })),
    ];
  }

  /** The operator's: the types `relate` and `unrelate` take. */
  relates(): string[] {
    return [...this.writableRelations()];
  }

  async relate(item: string, type: string, other: string, ctx: RuntimeContext): Promise<void> {
    this.writable(type, `relate #${item} to #${other}`);
    // A tracker's own UI may allow one, and a read of it still says the item
    // waits on itself; landrace never writes one.
    if (item === other) throw new Error(`cannot relate #${item} to itself as "${type}"`);
    await this.addRelation(item, type, other, ctx);
  }

  async unrelate(item: string, type: string, other: string, ctx: RuntimeContext): Promise<void> {
    this.writable(type, `unrelate #${item} from #${other}`);
    await this.removeRelation(item, type, other, ctx);
  }

  /** The operator's: what `relate` or `unrelate` would refuse, asked before anything is written. */
  async checkRelate(item: string, type: string, other: string, ctx: RuntimeContext): Promise<string | null> {
    const types = this.writableRelations();
    if (!types.includes(type)) return `this tracker writes ${writtenTypes(types)}`;
    if (item === other) return "an item is never related to itself";
    return this.relationProblem(item, type, other, ctx);
  }

  /**
   * Why `item` — null for one not yet created — cannot be related to
   * `other` as `type`, or null: asked of every entry before the first write
   * of `createItem` and of the operator's lists. By default, a relationship
   * runs only between this tracker's own items, the other end one it can
   * read: an item elsewhere is read, never written, and one it cannot read
   * is not one it can say exists. An integration whose tracker refuses more
   * — a kind of item that cannot be related — says so here, read as its
   * write would read it.
   */
  protected async relationProblem(item: string | null, type: string, other: string, ctx: RuntimeContext): Promise<string | null> {
    const elsewhere = [item, other].find((id): id is string => id !== null && !this.ownsId(id));
    if (elsewhere !== undefined) return `#${elsewhere} is not one of this tracker's own items, and landrace relates only those`;
    try {
      await this.item(other, ctx);
    } catch (e) {
      return `#${other} could not be read: ${messageOf(e)}`;
    }
    return null;
  }

  private writable(type: string, what: string): void {
    const types = this.writableRelations();
    if (!types.includes(type)) throw new Error(`cannot ${what} as "${type}": this tracker writes ${writtenTypes(types)}`);
  }

  /**
   * Exactly what `observe` puts in the snapshot — `landrace validate` answers
   * its path-coverage rule from this list, so a path declared and not
   * provided passes a workflow that reads nothing. Only what a graph cannot
   * hold: the title, labels and assignees are the node's.
   */
  provides(): string[] {
    return ["item", "item.body", "item.comments", "entries", "tracker", "tracker.bot"];
  }

  /**
   * The item's body and records, and the login we post as — recorded
   * because `satisfied()` is synchronous and must know which comments are ours.
   */
  async observe(ctx: HookContext): Promise<Record<string, unknown>> {
    const item = await this.item(ctx.item, ctx);
    const comments = await this.comments(ctx.item, ctx);
    const bot = await this.login(ctx);
    return { item: { body: item.body, comments }, entries: entriesFromComments(comments, bot), tracker: { bot } };
  }

  effects(): EffectTable {
    return {
      [LABEL_EFFECT]: {
        satisfied: labelSatisfied,
        apply: async (effect, ctx) => {
          for (const label of strings(effect.remove)) await this.removeLabel(ctx.item, label, ctx);
          const add = strings(effect.add);
          if (add.length > 0) await this.addLabels(ctx.item, add, ctx);
        },
      },
      [STATUS_EFFECT]: {
        satisfied: statusSatisfied,
        apply: async (effect, ctx) => {
          // Position is one label, and moving it is more than one request, so
          // there is a window in the middle. Removing first left zero stage
          // labels in it, and an item with no position reads as a new one:
          // a crash there restarted a finished item from its entry step.
          // Adding first leaves two, which the engine refuses to place rather
          // than places wrongly — and the next status apply removes the
          // loser, because what it removes is read off the item.
          const want = LABELS.stage(String(effect.value));
          await this.addLabels(ctx.item, [want], ctx);
          const { labels } = await this.item(ctx.item, ctx);
          for (const stale of labels.filter((l) => l.startsWith(STAGE_LABEL_PREFIX) && l !== want)) {
            await this.removeLabel(ctx.item, stale, ctx);
          }
        },
      },
      [RECORD_EFFECT]: {
        satisfied: commentSatisfied,
        apply: async (effect, ctx) => {
          const body = neutraliseMarkers(String(effect.body ?? ""));
          const visibility = visibilityOf(effect);
          // No kind, no marker: an operator's reply is genuinely a human turn,
          // and stamping it would read a person's words as our own record.
          await this.comment(
            ctx.item, effect.kind === undefined ? body : body + renderMarker(recordMarker(effect)), ctx,
            visibility === undefined ? {} : { visibility },
          );
        },
      },
      [CLOSE_EFFECT]: {
        satisfied: (snapshot) => closeSatisfied(snapshot),
        apply: async (effect, ctx) => {
          const how = closeHow(effect);
          // Closed either way is closed: a person who dropped it decided
          // that, and closing it again as done would overrule them.
          if (ctx.snapshot !== undefined && closeSatisfied(ctx.snapshot)) return;
          await this.close(ctx.item, how, ctx);
        },
      },
      [NODES_CLOSE_EFFECT]: {
        satisfied: nodesCloseSatisfied,
        apply: async (effect, ctx) => {
          for (const id of stillOpen(ctx.snapshot, effect)) await this.close(id, "dropped", ctx);
        },
      },
    };
  }

  /**
   * Prompt text under `{brief.project.<key>}`: `body`, the item's own text.
   * Its comments reach a step through `history`, which the composition owns.
   */
  briefs(): BriefTable {
    return { body: async (ctx) => bodyBrief((await this.item(ctx.item, ctx)).body) };
  }

  /** The item's comments, for the history's one timeline. */
  async history(ctx: HookContext): Promise<HistoryItem[]> {
    const bot = await this.login(ctx);
    return (await this.comments(ctx.item, ctx)).map((c) => ({ at: c.created_at, text: commentLine(c, bot) }));
  }

  /**
   * Every item the tracker lists, and each child's edge to a parent the list
   * carries: none dangles. Each item's relationships are edges too, to a
   * placeholder for an item the list does not carry, so the board can name
   * every one. Whether an item is on a cycle of blockers is judged over this
   * same list, as `read` judges it, so the two agree — but where `read`
   * refuses a walk past its bound, the listing says the item's relationships
   * cannot be read: one item's walk does not fail every item's listing.
   */
  async list(ctx: RuntimeContext): Promise<Graph> {
    const bot = await this.login(ctx);
    const items = await this.items(ctx);
    const listed = new Map(items.map((t) => [t.id, t]));
    const relations = openRelationsOf(items, RELATIONS.blockedBy);
    const owns = (id: string): boolean => this.ownsId(id);
    const nodes: Node[] = [];
    const edges = new Map<string, Relationship>();
    const placeholders = new Map<string, Node>();
    for (const t of items) {
      if (t.parent !== null && listed.has(t.parent)) {
        edges.set(JSON.stringify([t.id, t.parent, RELATIONS.childOf]), { from: t.id, to: t.parent, type: RELATIONS.childOf });
      }
      const { related, whole } = relatedOf(t);
      drawRelated(t.id, related, (id) => listed.has(id), edges, placeholders);
      let walk: { cycle: boolean; whole: boolean };
      try {
        walk = blockerCycle(t, relations, owns);
      } catch {
        walk = { cycle: false, whole: false };
      }
      nodes.push(withFacts(itemNode(t, bot), { unreadable: !whole || !walk.whole, cycle: walk.cycle }));
    }
    return { nodes: [...nodes, ...placeholders.values()], relationships: [...edges.values()] };
  }

  /**
   * One item's neighbourhood: itself, its parent, and every descendant,
   * breadth first — the whole subtree, because a re-run's cascade closes what
   * hangs off a stale child and can close only what the graph shows it. The
   * parent's other children are its business, not this item's. The read
   * stops past MAX_SUBGRAPH_NODES rather than paying for a graph the engine
   * would refuse.
   *
   * And the item's own relationships, each an edge — to a placeholder built
   * from the relationship for a related item outside the neighbourhood, never
   * a read of it. Its blockers are walked further, through the tracker's own
   * open items, only to say whether it is on a cycle of them — over one
   * `openRelations` answer, asked only when it has an open blocker of the
   * tracker's own, and refused with that answer when it cannot be had.
   * Nothing the walk meets becomes a node.
   */
  async read(id: string, ctx: RuntimeContext): Promise<Graph> {
    const bot = await this.login(ctx);
    const root = await this.item(id, ctx);
    if (root.priority === undefined) {
      const { found } = priorityFromLabels(root.labels);
      if (found.length > 1) throw new Error(`#${id} carries ${found.join(" and ")}; priority is one`);
    }
    const read: ItemRecord[] = [root];
    const relationships: Relationship[] = [];
    if (root.parent !== null) {
      read.push(await this.item(root.parent, ctx));
      relationships.push({ from: id, to: root.parent, type: RELATIONS.childOf });
    }
    const seen = new Set(read.map((t) => t.id));
    const queue = [root];
    for (let i = 0; i < queue.length; i++) {
      const at = queue[i] as ItemRecord;
      for (const child of await this.children(at.id, ctx)) {
        // A tracker keeps a tree; this only stops a read that is not one from walking in circles.
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        read.push(child);
        queue.push(child);
        relationships.push({ from: child.id, to: at.id, type: RELATIONS.childOf });
        if (read.length > MAX_SUBGRAPH_NODES) throw tooLarge(id);
      }
    }
    const edges = new Map<string, Relationship>();
    const placeholders = new Map<string, Node>();
    const { related, whole } = relatedOf(root);
    drawRelated(id, related, (other) => seen.has(other), edges, placeholders);
    if (read.length + placeholders.size > MAX_SUBGRAPH_NODES) throw tooLarge(id);
    const owns = (other: string): boolean => this.ownsId(other);
    const relations = waitsOnOwn(root, owns) ? await this.openRelations(RELATIONS.blockedBy, ctx) : NO_RELATIONS;
    const walk = blockerCycle(root, relations, owns);
    return {
      nodes: [
        withFacts(itemNode(root, bot), { unreadable: !whole || !walk.whole, cycle: walk.cycle }),
        ...read.slice(1).map((t) => itemNode(t, bot)),
        ...placeholders.values(),
      ],
      relationships: [...relationships, ...edges.values()],
    };
  }

  /**
   * The operator's create, read back as the node `read` would report. Marked
   * under our own login, so the origin reads back as ours and only ours; the
   * body is escaped first, so an agent cannot bring a marker of its own.
   */
  async createItem({ title, body, labels, parent, origin, priority, relate }: NewItem, ctx: RuntimeContext): Promise<Node> {
    const relations = distinctRelations(relate ?? []);
    // Every type, and every item it names, checked before anything is
    // written: a refusal leaves nothing behind.
    for (const { type, item } of relations) this.writable(type, `relate a new item to #${item}`);
    for (const { type, item } of relations) {
      const problem = await this.relationProblem(null, type, item, ctx);
      if (problem !== null) throw new Error(`cannot relate a new item to #${item} as "${type}": ${problem}`);
    }
    const stamped = neutraliseMarkers(body ?? "") + (origin ? renderOrigin(origin) : "");
    const id = await this.create({ title, body: stamped, parent, priority }, ctx);
    // Related before it is labelled: the label is what lets a tick work it,
    // and one worked before its blockers are on it is one that does not wait.
    const failed: string[] = [];
    for (const { type, item } of relations) {
      try {
        await this.addRelation(id, type, item, ctx);
      } catch (e) {
        failed.push(`${type} #${item}: ${messageOf(e)}`);
      }
    }
    if (failed.length > 0) {
      // Closed as dropped, as a sub-item that cannot be linked is: open and
      // unlabelled, nothing would work it, and a parent waiting on every
      // child closed would wait on it for ever. Dropped, it counts only in
      // the parent's `dropped`. Never deleted: a person can still see it.
      let closing = "it was closed as dropped, so it holds nothing up";
      try {
        await this.close(id, "dropped", ctx);
      } catch (e) {
        closing = `and closing it as dropped failed too, so it is still open, and unlabelled so nothing works it: ${messageOf(e)}`;
      }
      throw new Error(`#${id} was created, but relating it failed: ${failed.join("; ")}; ${closing}`);
    }
    if ((labels ?? []).length > 0) await this.addLabels(id, labels ?? [], ctx);
    return itemNode(await this.item(id, ctx), await this.login(ctx));
  }

  async updateItem(id: string, { title, body, state, addLabels, removeLabels }: ItemPatch, ctx: RuntimeContext): Promise<Node> {
    for (const label of removeLabels ?? []) await this.removeLabel(id, label, ctx);
    if ((addLabels ?? []).length > 0) await this.addLabels(id, addLabels ?? [], ctx);
    const fields = {
      ...(title === undefined ? {} : { title }),
      ...(body === undefined ? {} : { body }),
      ...(state === undefined ? {} : { state }),
    };
    if (Object.keys(fields).length > 0) await this.update(id, fields, ctx);
    return itemNode(await this.item(id, ctx), await this.login(ctx));
  }
}
