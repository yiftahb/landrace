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
  allClosed, CLOSE_EFFECT, entriesFromComments, LABEL_EFFECT, LABELS, labelsOf, MAX_SUBGRAPH_NODES, neutraliseMarkers,
  NODES_CLOSE_EFFECT, parseMarker, parseOrigin, RECORD_EFFECT, recordMarker, RELATIONS, renderMarker, renderOrigin, sameLogin,
  STAGE_LABEL_PREFIX, STATUS_EFFECT, stripMarker, ITEM_KIND,
} from "#conventions.js";
import { commentLine } from "#kit/forge.js";
import type {
  BriefTable, Effect, EffectTable, Graph, HistoryItem, HookContext, NewItem, Node, RelationDecl, Relationship,
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
 * The most a comment body may carry: 65,536 characters, the bound of the
 * tracker this repository's own hook drives. A tracker whose bound is lower
 * (a Jira hook's is 32,767) refuses past its own instead.
 *
 * The engine's own bound is `recordBodyProblem` in src/conventions.ts, which
 * is lower and tracker-agnostic, and which rejects at the step boundary where
 * the refusal is *recorded* on the item. This is the backstop under it — for
 * the bodies the engine does not compose, an operator's own `landrace_reply`
 * among them — and it reports the size rather than letting the API answer 422
 * to a request that should never have gone out.
 */
export const MAX_COMMENT_CHARS = 65_536;

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
  /** Post a comment exactly as given: the base has already escaped it and stamped its marker. */
  abstract comment(id: string, body: string, ctx: RuntimeContext): Promise<void>;
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

  relations(): RelationDecl[] {
    return [{ type: RELATIONS.childOf, singular: true }];
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
          // No kind, no marker: an operator's reply is genuinely a human turn,
          // and stamping it would read a person's words as our own record.
          await this.comment(ctx.item, effect.kind === undefined ? body : body + renderMarker(recordMarker(effect)), ctx);
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

  /** Every item the tracker lists, and each child's edge to a parent the list carries: none dangles. */
  async list(ctx: RuntimeContext): Promise<Graph> {
    const bot = await this.login(ctx);
    const items = await this.items(ctx);
    const listed = new Set(items.map((t) => t.id));
    return {
      nodes: items.map((t) => itemNode(t, bot)),
      relationships: items.flatMap((t) =>
        t.parent !== null && listed.has(t.parent) ? [{ from: t.id, to: t.parent, type: RELATIONS.childOf }] : []),
    };
  }

  /**
   * One item's neighbourhood: itself, its parent, and every descendant,
   * breadth first — the whole subtree, because a re-run's cascade closes what
   * hangs off a stale child and can close only what the graph shows it. The
   * parent's other children are its business, not this item's. The read
   * stops past MAX_SUBGRAPH_NODES rather than paying for a graph the engine
   * would refuse.
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
        if (read.length > MAX_SUBGRAPH_NODES) {
          throw new Error(
            `#${id} has more than the ${MAX_SUBGRAPH_NODES} nodes one read may carry; a graph known to be short is not one to decide from`,
          );
        }
      }
    }
    return { nodes: read.map((t) => itemNode(t, bot)), relationships };
  }

  /**
   * The operator's create, read back as the node `read` would report. Marked
   * under our own login, so the origin reads back as ours and only ours; the
   * body is escaped first, so an agent cannot bring a marker of its own.
   */
  async createItem({ title, body, labels, parent, origin, priority }: NewItem, ctx: RuntimeContext): Promise<Node> {
    const stamped = neutraliseMarkers(body ?? "") + (origin ? renderOrigin(origin) : "");
    const id = await this.create({ title, body: stamped, parent, priority }, ctx);
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
