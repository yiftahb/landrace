/*
 * What every tracker integration shares and none of them is: telling our own
 * comments from a stranger's, the `satisfied()` of each tracker effect, and
 * reading a ticket into the node the engine routes on. Published as part of
 * `landrace/kit`.
 *
 * Every `satisfied()` here is synchronous and reads only the snapshot, which
 * is its contract; an integration's `satisfied()` is a switch over the effect
 * types it handles that calls one of these per type. What stays with the
 * integration is its API: the queries, their shapes, their paging, and
 * mapping what they answer into the plain fields `ticketNode` takes.
 */
import {
  allClosed, LABELS, labelsOf, parseMarker, parseOrigin, sameLogin, TICKET_KIND,
} from "#conventions.js";
import type { Effect, Graph, Node, Snapshot, SnapshotComment, TicketRecord } from "#namespace.js";

export type { SnapshotComment } from "#namespace.js";

/**
 * A tracker's page size for a connection, and how many pages one read will
 * pay for. A count that stopped at the first page would read a 150-thread pull
 * request as having fewer findings than it has — and, with the first hundred
 * resolved, as having none at all, which is a ticket leaving the review loop
 * with open findings on it. Past the cap the honest answer is that the count
 * could not be read, not a number we know is short.
 */
export const THREAD_PAGE = 100;
export const MAX_THREAD_PAGES = 10;

/** The same bound on the issue and pull request lists, for the same reason: a list that stops at 100 without saying so. */
export const ISSUE_PAGE = 100;
export const MAX_ISSUE_PAGES = 10;

/**
 * How many sub-issues, and pull requests each way, one ticket read carries.
 * Every one of them is counted by the workflow — "every child closed", "every
 * pull request merged" — so a ticket with more than this is refused by
 * `read` rather than read as one with fewer.
 */
export const TICKET_PAGE = 50;

// ponytail: a constant, not a setting — tracker config if another window is ever wanted.
/** How far back the board's Done lane reaches. Display only: tick works open tickets alone. */
export const DONE_WINDOW_MS = 30 * 86_400_000;

/**
 * The most a comment body may carry: 65,536 characters, the bound of the
 * tracker this repository's own hook drives. A tracker whose bound is lower
 * (a Jira hook's is 32,767) refuses past its own instead.
 *
 * The engine's own bound is `recordBodyProblem` in src/conventions.ts, which
 * is lower and tracker-agnostic, and which rejects at the step boundary where
 * the refusal is *recorded* on the ticket. This is the backstop under it — for
 * the bodies the engine does not compose, an operator's own `landrace_reply`
 * among them — and it reports the size rather than letting the API answer 422
 * to a request that should never have gone out.
 */
export const MAX_COMMENT_CHARS = 65_536;

/** The ticket's comments, as the pre hook put them in the snapshot. */
export const commentsOf = (s: Snapshot): SnapshotComment[] =>
  ((s.ticket as { comments?: SnapshotComment[] })?.comments ?? []);

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
 * one reading of the ticket, which is the one the engine placed it from.
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
  // never planned by a stage — nothing on the ticket would say it had
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
 * `tracker.close`. Closed either way counts: a person who closed it as not
 * planned decided that, and re-closing it as completed would overrule them.
 */
export function closeSatisfied(snapshot: Snapshot): boolean {
  return ((snapshot.node as Node | undefined)?.closed ?? null) !== null;
}

const PRIORITY_LABEL = /^P([0-9])$/;

/**
 * `P0`..`P9`, the convention landrace's labels use. Two of them is a ticket
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

/**
 * The one mapping from a ticket, as an integration reads its tracker's, to a
 * ticket node. `bot` is the login we post as: an origin counts only in a body
 * we wrote, because a re-run closes whatever claims it. The parent is an
 * edge, not a field, so it is not asked for here.
 */
export function ticketNode(ticket: Omit<TicketRecord, "parent">, bot: string): Node {
  return {
    id: ticket.id,
    kind: TICKET_KIND,
    title: ticket.title,
    link: ticket.link,
    closed: ticket.closed,
    priority: ticket.priority !== undefined ? ticket.priority : priorityFromLabels(ticket.labels).priority,
    // Nobody but us may have touched the body since: a person keeps the
    // bot's authorship when they edit it, and could otherwise rewrite the
    // marker to claim another stage or round.
    origin: ticket.editor !== undefined && !sameLogin(ticket.editor, bot)
      ? null
      : parseOrigin(ticket.body, ticket.author, bot),
    // Always lists, and empty rather than absent: an eligibility rule reading
    // a path the node does not carry is one the tick cannot answer, and it
    // abstains on those — so an unassigned ticket would be worked by every
    // instance instead of none.
    state: { labels: ticket.labels, assignees: ticket.assignees },
    ...createdAtOf(ticket.createdAt),
  };
}
