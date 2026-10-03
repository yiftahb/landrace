/*
 * GitHub Issues as a project's tracker: the issue queries, GitHub's close
 * reasons, the sub-issue link, issue dependencies as `blocked-by`, and the
 * classic token's scope. Everything else a tracker does is `BaseTracker`'s.
 */
import { createHash } from "node:crypto";
import {
  type Closed, type ItemPatch, RELATIONS, type RuntimeContext, STAGE_LABEL_PREFIX, isItemId,
} from "landrace/hooks";
import {
  BaseTracker, DONE_WINDOW_MS, ISSUE_PAGE, MAX_ISSUE_PAGES, ITEM_PAGE,
  type ItemRecord, type OpenRelations, type TrackerComment,
} from "landrace/kit";
import { type Client, type Spare, clientFor, isIssueNumber, issueNumber, unseen, valueAt } from "./client.js";

/**
 * How many blockers one reading asks an issue for: all of them, since GitHub
 * relates at most 50 issues to one by each relationship type. A count past
 * it — a limit GitHub raised, say — reads as not whole, never as fewer.
 */
const BLOCKERS_PAGE = 50;

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A blocker as the walk reads it: which issue, where, and whether it is done — no title, no link. */
interface WalkBlocker {
  number: number;
  state: string;
  stateReason: string | null;
  repository: { name: string; owner: { login: string } };
}

/** A blocker as an issue's own reading answers it: the walk's fields, and enough to name it. */
interface BlockerNode extends WalkBlocker {
  title: string;
  url: string;
}

/** A connection of blockers: the first page of them, and how many there are. */
interface Blockers<N> { totalCount: number; nodes: Array<N | null> }

/** The blocker fields the walk reads, spelled once for both readings so the two map a blocker alike. */
const WALK_BLOCKER_FIELDS = "number state stateReason repository { name owner { login } }";

/** The repository the tracker reads, as configured. */
interface Here { owner: string; name: string }

/**
 * An issue as GraphQL answers `ISSUE_FIELDS`: the one reading of an issue that
 * becomes an item, whichever query asked for it.
 */
interface IssueNode {
  number: number;
  title: string;
  url: string;
  state: string;
  stateReason: string | null;
  labels: { nodes: Array<{ name: string }> };
  /**
   * Who the issue is assigned to — a list, and the only spelling of it read
   * here. REST also returns a singular `assignee`, that list's first element
   * under a second name, and two spellings of one fact disagree the moment an
   * issue has two assignees.
   */
  assignees: { nodes: Array<{ login: string } | null> };
  body: string | null;
  /** Null for an account GitHub has since deleted. */
  author: { login: string } | null;
  /** Who last edited the body, or null if nobody has since it was opened. */
  editor: { login: string } | null;
  /** ISO 8601. Optional because a reading without it draws no age, never NaN. */
  createdAt?: string;
  /** ISO 8601, when it last changed: the board's lane order. Optional likewise; null where GitHub answers none. */
  updatedAt?: string | null;
  /** Its blockers, the first page of them: a null node is one the token may not see. */
  blockedBy: Blockers<BlockerNode>;
}

/** A sub-issue's reading, in the issue list or a read's children: no blockers, which neither draws. */
type SubIssueNode = Omit<IssueNode, "blockedBy">;

/** A repository answer, naming the repository as GitHub does now. */
type Named<T> = T & { nameWithOwner?: string };

type Page<T> = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: T[] };

/**
 * The fields of an issue without its blockers, which a read's sub-issues are
 * asked for: a parent counting its children by stage reads their labels, and
 * a read draws only its own item's relationships.
 */
const ISSUE_BASE_FIELDS = `
  number title url state stateReason createdAt updatedAt
  labels(first: 100) { nodes { name } }
  assignees(first: 20) { nodes { login } }
  body author { login } editor { login }`;

/**
 * The fields every reading of an issue that keeps its blockers asks for,
 * spelled once so `IssueNode` has one shape whichever query it came back
 * from. Its blockers come with each their own title, link, state and
 * repository, so naming one costs no read of it.
 */
const ISSUE_FIELDS = `${ISSUE_BASE_FIELDS}
  blockedBy(first: ${BLOCKERS_PAGE}) { totalCount nodes { title url ${WALK_BLOCKER_FIELDS} } }`;

/**
 * The same reading, lighter, for a sub-issue in the issue list. GitHub prices
 * a query by the nodes it could return — every `first:` multiplied down its
 * path — and refuses one past 500,000 before running it: a page of 100 issues
 * each with 50 sub-issues carrying 100 labels was 617,100. A child needs its
 * stage label and state for a parent to count it, not a hundred labels; an
 * open child is also listed as an issue in its own right, and that fuller
 * reading is the one kept.
 */
const SUB_ISSUE_FIELDS = `
  number title url state stateReason createdAt updatedAt
  labels(first: 20) { nodes { name } }
  assignees(first: 5) { nodes { login } }
  body author { login } editor { login }`;

/** One issue, and the issue it is a sub-issue of. */
const ISSUE_QUERY = `
query LandraceIssue($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    issue(number: $number) { ${ISSUE_FIELDS} parent { number } }
  }
}`;

/** One issue's sub-issues, closed ones too: "every child closed" counts all of them. */
const SUB_ISSUES_QUERY = `
query LandraceSubIssues($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) { subIssues(first: ${ITEM_PAGE}) { totalCount nodes { ${ISSUE_BASE_FIELDS} } } }
  }
}`;

/**
 * Every open issue with its sub-issues (closed ones too, so a parent can count
 * a finished child), in one request per page.
 */
const ISSUES_QUERY = `
query LandraceIssues($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    issues(states: OPEN, first: ${ISSUE_PAGE}, after: $cursor, orderBy: { field: CREATED_AT, direction: ASC }) {
      pageInfo { hasNextPage endCursor }
      nodes { ${ISSUE_FIELDS} parent { number } subIssues(first: 50) { nodes { ${SUB_ISSUE_FIELDS} } } }
    }
  }
}`;

/**
 * Closed issues, most recently updated first, so the list stops at the first
 * issue last touched before the window: none can have closed after it last
 * changed, so nothing past it closed inside the window either.
 */
const CLOSED_QUERY = `
query LandraceClosed($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    issues(states: CLOSED, first: ${ISSUE_PAGE}, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { ${ISSUE_FIELDS} closedAt parent { number } }
    }
  }
}`;

/**
 * Every open issue's blockers and nothing else, for a read's cycle walk:
 * each waiting item is read every tick, and the issue list would cost every
 * open issue's labels, body and sub-issues per read for the blockers alone.
 * Ordered and paged as the issue list is, so the two hold the same issues.
 */
const OPEN_BLOCKERS_QUERY = `
query LandraceOpenBlockers($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    issues(states: OPEN, first: ${ISSUE_PAGE}, after: $cursor, orderBy: { field: CREATED_AT, direction: ASC }) {
      pageInfo { hasNextPage endCursor }
      nodes { number blockedBy(first: ${BLOCKERS_PAGE}) { totalCount nodes { ${WALK_BLOCKER_FIELDS} } } }
    }
  }
}`;

/** Every GraphQL document the tracker sends, so a test can cost each against GitHub's node limit. */
export const ISSUE_QUERIES = { ISSUE_QUERY, SUB_ISSUES_QUERY, ISSUES_QUERY, CLOSED_QUERY, OPEN_BLOCKERS_QUERY };

/** The refusal of a list of open issues past the pages one list may carry, the same whichever list it is. */
const tooMany = (repo: string): Error =>
  new Error(`${repo} has more than ${MAX_ISSUE_PAGES * ISSUE_PAGE} open issues, more than one list may carry`);

type Listed = IssueNode & { parent: { number: number } | null; subIssues: { nodes: SubIssueNode[] } };
type ClosedIssue = IssueNode & { closedAt: string | null; updatedAt: string | null; parent: { number: number } | null };

/**
 * GitHub's close reason, as the one piece of lifecycle the engine understands.
 *
 * Anything else is refused rather than guessed: `REOPENED` on a closed issue,
 * or a reason GitHub adds later, would otherwise read as finished and let a
 * parent count it done.
 */
function closedOf(issue: Pick<IssueNode, "number" | "state" | "stateReason">): Closed {
  if (issue.state === "OPEN") return null;
  // Closed with no reason is how every issue closed before GitHub had reasons reads.
  if (issue.stateReason === "COMPLETED" || issue.stateReason === null) return "done";
  if (issue.stateReason === "NOT_PLANNED" || issue.stateReason === "DUPLICATE") return "dropped";
  throw new Error(
    `#${issue.number} is closed for the reason "${String(issue.stateReason)}", which this integration does not map ` +
    "to done or dropped; it will not guess",
  );
}

/** The longest an item id may be: `itemIdProblem`'s bound. */
const ID_CHARS = 64;

/**
 * A blocker's id: its number, in this repository — GitHub's names are not
 * case-sensitive, and its answer spells them as they are now, not as
 * configured — and `x.<owner>.<name>.<number>` in another. An owner never
 * holds a "." (a login is letters, digits, "-", and "_" for a managed user),
 * so the first one ends it and the last begins the number: one id per issue,
 * never all digits, never another role's `pr-<n>` or `spec-<id>`. One too
 * long to spell out names its repository by a hash instead,
 * `x.<owner, cut>.<12 hex of sha1(owner/name)>.<number>` — the same every
 * time, one per repository. Null for one with an owner GitHub cannot have,
 * or a name no id may hold.
 */
function blockerId({ number, repository: { owner: { login: owner }, name } }: WalkBlocker, here: Here): string | null {
  if (owner.toLowerCase() === here.owner.toLowerCase() && name.toLowerCase() === here.name.toLowerCase()) return String(number);
  if (!/^[A-Za-z0-9_-]+$/.test(owner)) return null;
  const spelled = `x.${owner}.${name}.${number}`;
  if (spelled.length <= ID_CHARS) return isItemId(spelled) ? spelled : null;
  const tail = `.${createHash("sha1").update(`${owner}/${name}`.toLowerCase()).digest("hex").slice(0, 12)}.${number}`;
  const hashed = `x.${owner.slice(0, ID_CHARS - 2 - tail.length)}${tail}`;
  return isItemId(hashed) ? hashed : null;
}

/**
 * The blockers an answer could read, each by id and state, and whether that
 * was all of them. One that cannot be read — null where the token may not
 * see it, in a repository it cannot name — is left out and the rest said
 * not to be whole, as is a connection holding fewer than it counts: not
 * found is not missing. One closed for a reason this does not map is kept,
 * by the id GitHub gave it, as unreadable and open: which it is is known,
 * what state it is in is not. Both readings of an issue's blockers go
 * through this, so the walk and the list agree.
 */
function readBlockers<N extends WalkBlocker>(
  blockedBy: Blockers<N> | undefined, here: Here,
): { read: Array<{ node: N; to: string; closed: Closed; unreadable: boolean }>; whole: boolean } {
  if (!Array.isArray(blockedBy?.nodes)) return { read: [], whole: false };
  const read: Array<{ node: N; to: string; closed: Closed; unreadable: boolean }> = [];
  for (const node of blockedBy.nodes) {
    if (node === null) continue;
    const to = blockerId(node, here);
    if (to === null) continue;
    try {
      read.push({ node, to, closed: closedOf(node), unreadable: false });
    } catch {
      read.push({ node, to, closed: null, unreadable: true });
    }
  }
  return {
    read,
    whole: read.length === blockedBy.nodes.length && !read.some((r) => r.unreadable) && blockedBy.totalCount <= blockedBy.nodes.length,
  };
}

/** An issue's blockers, as the kit reads relationships. */
function blockersOf(blockedBy: Blockers<BlockerNode> | undefined, here: Here): Pick<ItemRecord, "related" | "relatedComplete"> {
  const { read, whole } = readBlockers(blockedBy, here);
  return {
    related: read.map(({ node, to, closed, unreadable }) => ({
      type: RELATIONS.blockedBy, to, title: node.title, link: node.url, closed, ...(unreadable ? { unreadable: true as const } : {}),
    })),
    relatedComplete: whole,
  };
}

/**
 * A blocker the token may not see: GitHub answers it — or a field of it —
 * null, with a FORBIDDEN or NOT_FOUND error at that place beside an
 * otherwise whole answer. That whole blocker reads as null, so as
 * unreadable, never as one missing a field, and the log says whose blocker
 * it is, which — by name where GitHub gave one, by its place among the
 * issue's blockers where it did not — and what GitHub said. Once in `said`:
 * the list, every read of the issue and every walk past it meet it again,
 * every tick. Any other error — a fault, a rate limit — fails the read as
 * ever, and the next tick reads it again.
 */
const unseenBlockers = (ctx: RuntimeContext, said: Set<string>): Spare => ({
  at: ({ path, type }) => {
    if (type !== "FORBIDDEN" && type !== "NOT_FOUND") return null;
    for (let k = 0; k + 2 < path.length; k++) {
      if (path[k] === "blockedBy" && path[k + 1] === "nodes" && typeof path[k + 2] === "number") return path.slice(0, k + 3);
    }
    return null;
  },
  spared: ({ message }, { path, was, data }) => {
    const number = (valueAt(data, path.slice(0, -3)) as { number?: unknown } | null | undefined)?.number;
    const item = typeof number === "number" ? String(number) : null;
    const place = Number(path[path.length - 1]) + 1;
    const known = was as Partial<WalkBlocker> | null;
    const named = typeof known?.number === "number" && typeof known.repository?.name === "string" && typeof known.repository.owner?.login === "string"
      ? `${known.repository.owner.login}/${known.repository.name}#${known.number}`
      : null;
    const blocker = named ?? (item === null ? `blocker ${place}` : `#${item}'s blocker ${place}`);
    const key = JSON.stringify([item, place, blocker, String(message)]);
    if (said.has(key)) return;
    said.add(key);
    ctx.log("github.blocker.unreadable", { item, blocker, path: path.join("."), message: String(message) });
  },
});

/** The repository as an answer names it — following a rename the configuration may not have — or as configured, where it does not say. */
function hereOf(repository: { nameWithOwner?: string }, gh: Client): Here {
  const [owner, name, ...rest] = typeof repository.nameWithOwner === "string" ? repository.nameWithOwner.split("/") : [];
  return owner && name && rest.length === 0 ? { owner, name } : gh;
}

/** An issue as GraphQL answers it, as the kit reads an item: with its blockers, from a reading that asked for them. */
const recordOf = (issue: IssueNode, parent: string | null, here: Here): ItemRecord => ({
  ...subRecordOf(issue, parent),
  ...blockersOf(issue.blockedBy, here),
});

/** What every reading of an issue carries — all the lighter one a sub-issue in the issue list gets, which asks for no blockers. */
const subRecordOf = (issue: SubIssueNode, parent: string | null): ItemRecord => ({
  id: String(issue.number),
  title: issue.title,
  link: issue.url,
  closed: closedOf(issue),
  labels: issue.labels.nodes.map((l) => l.name),
  assignees: issue.assignees.nodes.map((a) => a?.login ?? "").filter(Boolean),
  body: issue.body ?? "",
  author: issue.author?.login,
  editor: issue.editor?.login,
  createdAt: issue.createdAt,
  updatedAt: issue.updatedAt ?? undefined,
  parent,
});

/**
 * GitHub Issues, over one client: the one handed in, or the one `ctx.config`
 * builds — shared with the forge and the docs roles either way.
 */
export class GitHubIssues extends BaseTracker {
  private readonly client: Client | undefined;
  /** The unseen blockers already logged this tick: a listing begins each one, and clears it. */
  private readonly unseenSaid = new Set<string>();

  constructor({ client }: { client?: Client } = {}) {
    super();
    this.client = client;
  }

  private gh(ctx: RuntimeContext): Client {
    return this.client ?? clientFor(ctx);
  }

  async login(ctx: RuntimeContext): Promise<string> {
    return this.gh(ctx).botLogin();
  }

  /**
   * Every open issue, and every sub-issue of one, and the Done lane's closed
   * ones. An issue this integration cannot map is left out, said in the log:
   * one bad issue must not fail the tick for the rest, and `read` of anything
   * whose neighbourhood holds it halts, naming it.
   */
  async items(ctx: RuntimeContext): Promise<ItemRecord[]> {
    this.unseenSaid.clear();
    const gh = this.gh(ctx);
    const { owner, name } = gh;
    const records = new Map<string, ItemRecord>();
    const parentOf = new Map<string, string>();
    const keep = (issue: SubIssueNode, read: () => ItemRecord): void => {
      try {
        records.set(String(issue.number), read());
      } catch (e) {
        ctx.log("github.issue.skipped", { issue: issue.number, reason: e instanceof Error ? e.message : String(e) });
      }
    };

    let cursor: string | null = null;
    for (let page = 0; ; page++) {
      if (page === MAX_ISSUE_PAGES) throw tooMany(gh.repo);
      const data: { repository: Named<{ issues: Page<Listed> }> | null } =
        await gh.graphql(ISSUES_QUERY, { owner, name, cursor }, unseenBlockers(ctx, this.unseenSaid));
      if (!data.repository) throw unseen(gh.repo);
      const { issues } = data.repository;
      const here = hereOf(data.repository, gh);
      for (const issue of issues.nodes) {
        const id = String(issue.number);
        // An open sub-issue is listed twice — as an issue, and under its
        // parent. It is one item, and the reading as an issue is the full
        // one (SUB_ISSUE_FIELDS asks for fewer labels), so that one wins.
        records.delete(id);
        keep(issue, () => recordOf(issue, null, here));
        if (issue.parent) parentOf.set(id, String(issue.parent.number));
        for (const sub of issue.subIssues.nodes) {
          const child = String(sub.number);
          if (!records.has(child)) keep(sub, () => subRecordOf(sub, null));
          parentOf.set(child, id);
        }
      }
      if (!issues.pageInfo.hasNextPage) break;
      cursor = issues.pageInfo.endCursor;
    }

    // The board's Done lane: items Landrace moved — an lr:stage:* label says
    // it did — that closed inside the window. A closed issue nobody routed is
    // not Landrace's to show. Bounded like the rest, but past the bound it
    // stops quietly rather than failing the tick: this is for the page, not
    // the loop.
    const since = Date.now() - DONE_WINDOW_MS;
    cursor = null;
    closed: for (let page = 0; page < MAX_ISSUE_PAGES; page++) {
      const data: { repository: Named<{ issues: Page<ClosedIssue> }> | null } =
        await gh.graphql(CLOSED_QUERY, { owner, name, cursor }, unseenBlockers(ctx, this.unseenSaid));
      if (!data.repository) throw unseen(gh.repo);
      const { issues } = data.repository;
      const here = hereOf(data.repository, gh);
      for (const issue of issues.nodes) {
        if (issue.updatedAt !== null && Date.parse(issue.updatedAt) < since) break closed;
        if (issue.closedAt === null || Date.parse(issue.closedAt) < since) continue;
        if (!issue.labels.nodes.some((l) => l.name.startsWith(STAGE_LABEL_PREFIX))) continue;
        const id = String(issue.number);
        // A closed sub-issue is already here under its open parent, read lighter; this reading is the full one.
        records.delete(id);
        keep(issue, () => recordOf(issue, null, here));
        if (issue.parent) parentOf.set(id, String(issue.parent.number));
      }
      if (!issues.pageInfo.hasNextPage) break;
      cursor = issues.pageInfo.endCursor;
    }

    return [...records.values()].map((r) => ({ ...r, parent: parentOf.get(r.id) ?? null }));
  }

  async item(id: string, ctx: RuntimeContext): Promise<ItemRecord> {
    const number = issueNumber(id);
    const gh = this.gh(ctx);
    const data = await gh.graphql<{ repository: Named<{ issue: (IssueNode & { parent: { number: number } | null }) | null }> | null }>(
      ISSUE_QUERY, { owner: gh.owner, name: gh.name, number }, unseenBlockers(ctx, this.unseenSaid),
    );
    if (!data.repository) throw unseen(gh.repo);
    const issue = data.repository.issue;
    if (!issue) throw new Error(`#${number} is not an issue in ${gh.repo}`);
    return recordOf(issue, issue.parent ? String(issue.parent.number) : null, hereOf(data.repository, gh));
  }

  /**
   * The walk's own list: every open issue's blockers and nothing else,
   * bounded and refused as `items()` is. An issue whose blockers it could not
   * read all of is `partial`, as its full reading would say it is not whole.
   */
  protected override async openRelations(type: string, ctx: RuntimeContext): Promise<OpenRelations> {
    if (type !== RELATIONS.blockedBy) return super.openRelations(type, ctx);
    const gh = this.gh(ctx);
    const { owner, name } = gh;
    const answer: OpenRelations = { open: [], edges: [], partial: [] };
    let cursor: string | null = null;
    for (let page = 0; ; page++) {
      if (page === MAX_ISSUE_PAGES) throw tooMany(gh.repo);
      const data: { repository: Named<{ issues: Page<{ number: number; blockedBy: Blockers<WalkBlocker> }> }> | null } =
        await gh.graphql(OPEN_BLOCKERS_QUERY, { owner, name, cursor }, unseenBlockers(ctx, this.unseenSaid));
      if (!data.repository) throw unseen(gh.repo);
      const { issues } = data.repository;
      const here = hereOf(data.repository, gh);
      for (const issue of issues.nodes) {
        const id = String(issue.number);
        const { read, whole } = readBlockers(issue.blockedBy, here);
        answer.open.push(id);
        if (!whole) answer.partial.push(id);
        for (const { to, closed } of read) if (closed === null) answer.edges.push({ from: id, to });
      }
      if (!issues.pageInfo.hasNextPage) break;
      cursor = issues.pageInfo.endCursor;
    }
    return answer;
  }

  /** A count over the first page is a number known to be short: past the page, the item halts saying so. */
  async children(id: string, ctx: RuntimeContext): Promise<ItemRecord[]> {
    const number = issueNumber(id);
    const gh = this.gh(ctx);
    const data = await gh.graphql<{ repository: { issue: { subIssues: { totalCount: number; nodes: SubIssueNode[] } } | null } | null }>(
      SUB_ISSUES_QUERY, { owner: gh.owner, name: gh.name, number },
    );
    if (!data.repository) throw unseen(gh.repo);
    const issue = data.repository.issue;
    if (!issue) throw new Error(`#${number} is not an issue in ${gh.repo}`);
    const { totalCount, nodes } = issue.subIssues;
    if (totalCount > nodes.length) {
      throw new Error(`#${id} has ${totalCount} sub-issues, more than the ${ITEM_PAGE} one read carries`);
    }
    return nodes.map((sub) => subRecordOf(sub, id));
  }

  /** Every page of them: a stage whose entry record sat on the second page would read as never entered. */
  async comments(id: string, ctx: RuntimeContext): Promise<TrackerComment[]> {
    const number = issueNumber(id);
    const all: TrackerComment[] = [];
    for (let page = 1; page <= MAX_ISSUE_PAGES; page++) {
      const batch = await this.gh(ctx).listComments(number, page);
      all.push(...batch);
      if (batch.length < ISSUE_PAGE) return all;
    }
    throw new Error(`#${id} has more than ${MAX_ISSUE_PAGES * ISSUE_PAGE} comments, more than one read carries`);
  }

  async comment(id: string, body: string, ctx: RuntimeContext): Promise<void> {
    await this.gh(ctx).createComment(issueNumber(id), body);
  }

  async addLabels(id: string, labels: string[], ctx: RuntimeContext): Promise<void> {
    await this.gh(ctx).addLabels(issueNumber(id), labels);
  }

  async removeLabel(id: string, label: string, ctx: RuntimeContext): Promise<void> {
    await this.gh(ctx).removeLabel(issueNumber(id), label);
  }

  async close(id: string, how: "done" | "dropped", ctx: RuntimeContext): Promise<void> {
    await this.gh(ctx).closeIssue(issueNumber(id), how === "done" ? "completed" : "not_planned");
  }

  /**
   * An issue, linked as a sub-issue of `parent` — and dropped again when it
   * cannot be: unlinked, it is outside the parent's subtree, and nothing
   * would ever see it to drop it. Its priority is the `P{n}` label the list
   * reads it from; the eligibility label follows from the base once it is
   * linked.
   */
  async create(
    { title, body, parent, priority }: { title: string; body: string; parent: string | undefined; priority: number | undefined },
    ctx: RuntimeContext,
  ): Promise<string> {
    const gh = this.gh(ctx);
    // Checked before anything is created, so a bad parent leaves nothing behind.
    const under = parent === undefined ? undefined : issueNumber(parent);
    const created = await gh.createIssue({ title, body, ...(priority === undefined ? {} : { labels: [`P${priority}`] }) });
    if (under !== undefined) {
      try {
        // GitHub links a sub-issue by the child's REST id, not its number.
        await gh.addSubIssue(under, created.id);
      } catch (e) {
        // It carries no eligibility label yet, so even if this close fails
        // too it is inert — nothing will work it.
        const linkError = e instanceof Error ? e.message : String(e);
        try {
          await gh.closeIssue(created.number, "not_planned");
        } catch (c) {
          throw new Error(
            `${linkError}; and closing the unlinked #${created.number} again failed too: ${c instanceof Error ? c.message : String(c)}`,
          );
        }
        throw e;
      }
    }
    return String(created.number);
  }

  async update(id: string, fields: Pick<ItemPatch, "title" | "body" | "state">, ctx: RuntimeContext): Promise<void> {
    await this.gh(ctx).updateIssue(issueNumber(id), fields);
  }

  /** GitHub's issue dependencies, "blocked by", read off each issue's `blockedBy`. */
  protected override readRelations(): string[] {
    return [RELATIONS.blockedBy];
  }

  /** GitHub's issue dependencies, "blocked by". */
  protected override writableRelations(): string[] {
    return [RELATIONS.blockedBy];
  }

  /** This repository's issues are its numbers; an issue elsewhere is never all digits. */
  protected override ownsId(id: string): boolean {
    return isIssueNumber(id);
  }

  /**
   * GitHub writes a dependency by the blocker's REST id, not its number —
   * read first, as a sub-issue is linked by the child's. Writing one already
   * there, or removing one already gone, is done; anything else fails,
   * saying what was asked.
   */
  protected async addRelation(item: string, type: string, other: string, ctx: RuntimeContext): Promise<void> {
    await this.dependency(`relate #${item} to #${other}`, item, type, other, ctx, (gh, n, blocker) => gh.addBlockedBy(n, blocker));
  }

  protected async removeRelation(item: string, type: string, other: string, ctx: RuntimeContext): Promise<void> {
    await this.dependency(`unrelate #${item} from #${other}`, item, type, other, ctx, (gh, n, blocker) => gh.removeBlockedBy(n, blocker));
  }

  /**
   * What a dependency write would refuse, asked before anything is written
   * — by the very lookup the write makes, so the two cannot disagree about
   * what the other end is.
   */
  protected override async relationProblem(item: string | null, type: string, other: string, ctx: RuntimeContext): Promise<string | null> {
    try {
      await this.blockerOf(item, type, other, ctx);
      return null;
    } catch (e) {
      return messageOf(e);
    }
  }

  /** One dependency write between two issues here, by the blocker's REST id — or a refusal saying why there is none. */
  private async dependency(
    what: string, item: string, type: string, other: string, ctx: RuntimeContext,
    write: (gh: Client, n: number, blocker: number) => Promise<void>,
  ): Promise<void> {
    try {
      const blocker = await this.blockerOf(item, type, other, ctx);
      await write(this.gh(ctx), issueNumber(item), blocker);
    } catch (e) {
      throw new Error(`cannot ${what} as "${type}": ${messageOf(e)}`);
    }
  }

  /**
   * The REST id a dependency on `other` is written by, or a refusal saying
   * why there is none. A blocker in another repository is read, never
   * written: landrace's token is the configured repository's, and an item
   * elsewhere is not one it works.
   */
  private async blockerOf(item: string | null, type: string, other: string, ctx: RuntimeContext): Promise<number> {
    if (type !== RELATIONS.blockedBy) throw new Error(`GitHub writes only "${RELATIONS.blockedBy}"`);
    const gh = this.gh(ctx);
    const elsewhere = [item, other].find((id): id is string => id !== null && !this.ownsId(id));
    if (elsewhere !== undefined) throw new Error(`landrace writes relationships only within ${gh.repo}, and #${elsewhere} is not an issue there`);
    let blocker: Awaited<ReturnType<Client["issue"]>>;
    try {
      blocker = await gh.issue(issueNumber(other));
    } catch (e) {
      throw new Error(`#${other} could not be read: ${messageOf(e)}`);
    }
    // REST answers a pull request as an issue; GitHub's dependencies are between issues.
    if (blocker.pull_request !== undefined && blocker.pull_request !== null) {
      throw new Error(`#${other} is a pull request, not an issue: only an issue blocks another`);
    }
    if (!Number.isSafeInteger(blocker.id)) throw new Error(`GitHub answered #${other} with no usable id`);
    return blocker.id;
  }

  /**
   * A classic token carries its scopes on every response; a fine-grained one
   * carries none, so the header's presence is what tells the two apart — an
   * empty one counts as absent. "repo" only skips the immediate failure a
   * missing scope already is: a read-only collaborator, a token not
   * SSO-authorised for its org, or an org blocking classic tokens all carry
   * "repo" and still 403 on a write, so the forge's and the docs' probes run
   * whatever this says.
   */
  async check(ctx: RuntimeContext): Promise<void> {
    const scopes = await this.gh(ctx).oauthScopes();
    if (scopes !== null && !scopes.includes("repo")) throw new Error('classic token is missing the "repo" scope');
  }
}
