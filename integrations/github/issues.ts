/*
 * GitHub Issues as a project's tracker: the issue queries, GitHub's close
 * reasons, the sub-issue link, and the classic token's scope. Everything else
 * a tracker does is `BaseTracker`'s.
 */
import { type Closed, type RuntimeContext, STAGE_LABEL_PREFIX, type TicketPatch } from "landrace/hooks";
import {
  BaseTracker, DONE_WINDOW_MS, ISSUE_PAGE, MAX_ISSUE_PAGES, TICKET_PAGE,
  type TicketRecord, type TrackerComment,
} from "landrace/kit";
import { type Client, clientFor, issueNumber, unseen } from "./client.js";

/**
 * An issue as GraphQL answers `ISSUE_FIELDS`: the one reading of an issue that
 * becomes a ticket, whichever query asked for it.
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
}

type Page<T> = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: T[] };

/**
 * The fields every issue query asks for, spelled once so `IssueNode` has one
 * shape whichever query it came back from. Sub-issues are asked for with these
 * too: a parent counting its children by stage reads their labels.
 */
const ISSUE_FIELDS = `
  number title url state stateReason createdAt
  labels(first: 100) { nodes { name } }
  assignees(first: 20) { nodes { login } }
  body author { login } editor { login }`;

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
  number title url state stateReason createdAt
  labels(first: 20) { nodes { name } }
  assignees(first: 5) { nodes { login } }
  body author { login } editor { login }`;

/** One issue, and the issue it is a sub-issue of. */
const ISSUE_QUERY = `
query LandraceIssue($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) { ${ISSUE_FIELDS} parent { number } }
  }
}`;

/** One issue's sub-issues, closed ones too: "every child closed" counts all of them. */
const SUB_ISSUES_QUERY = `
query LandraceSubIssues($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) { subIssues(first: ${TICKET_PAGE}) { totalCount nodes { ${ISSUE_FIELDS} } } }
  }
}`;

/**
 * Every open issue with its sub-issues (closed ones too, so a parent can count
 * a finished child), in one request per page.
 */
const ISSUES_QUERY = `
query LandraceIssues($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
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
    issues(states: CLOSED, first: ${ISSUE_PAGE}, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { ${ISSUE_FIELDS} closedAt updatedAt parent { number } }
    }
  }
}`;

/** Every GraphQL document the tracker sends, so a test can cost each against GitHub's node limit. */
export const ISSUE_QUERIES = { ISSUE_QUERY, SUB_ISSUES_QUERY, ISSUES_QUERY, CLOSED_QUERY };

type Listed = IssueNode & { parent: { number: number } | null; subIssues: { nodes: IssueNode[] } };
type ClosedIssue = IssueNode & { closedAt: string | null; updatedAt: string | null; parent: { number: number } | null };

/**
 * GitHub's close reason, as the one piece of lifecycle the engine understands.
 *
 * Anything else is refused rather than guessed: `REOPENED` on a closed issue,
 * or a reason GitHub adds later, would otherwise read as finished and let a
 * parent count it done.
 */
function closedOf(issue: IssueNode): Closed {
  if (issue.state === "OPEN") return null;
  // Closed with no reason is how every issue closed before GitHub had reasons reads.
  if (issue.stateReason === "COMPLETED" || issue.stateReason === null) return "done";
  if (issue.stateReason === "NOT_PLANNED" || issue.stateReason === "DUPLICATE") return "dropped";
  throw new Error(
    `#${issue.number} is closed for the reason "${String(issue.stateReason)}", which this integration does not map ` +
    "to done or dropped; it will not guess",
  );
}

/** An issue as GraphQL answers it, as the kit reads a ticket. */
const recordOf = (issue: IssueNode, parent: string | null): TicketRecord => ({
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
  parent,
});

/**
 * GitHub Issues, over one client: the one handed in, or the one `ctx.config`
 * builds — shared with the forge and the docs roles either way.
 */
export class GitHubIssues extends BaseTracker {
  private readonly client: Client | undefined;

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
  async tickets(ctx: RuntimeContext): Promise<TicketRecord[]> {
    const gh = this.gh(ctx);
    const { owner, name } = gh;
    const records = new Map<string, TicketRecord>();
    const parentOf = new Map<string, string>();
    const keep = (issue: IssueNode): void => {
      try {
        records.set(String(issue.number), recordOf(issue, null));
      } catch (e) {
        ctx.log("github.issue.skipped", { issue: issue.number, reason: e instanceof Error ? e.message : String(e) });
      }
    };

    let cursor: string | null = null;
    for (let page = 0; ; page++) {
      if (page === MAX_ISSUE_PAGES) {
        throw new Error(`${gh.repo} has more than ${MAX_ISSUE_PAGES * ISSUE_PAGE} open issues, more than one list may carry`);
      }
      const data: { repository: { issues: Page<Listed> } | null } = await gh.graphql(ISSUES_QUERY, { owner, name, cursor });
      if (!data.repository) throw unseen(gh.repo);
      const { issues } = data.repository;
      for (const issue of issues.nodes) {
        const id = String(issue.number);
        // An open sub-issue is listed twice — as an issue, and under its
        // parent. It is one ticket, and the reading as an issue is the full
        // one (SUB_ISSUE_FIELDS asks for fewer labels), so that one wins.
        records.delete(id);
        keep(issue);
        if (issue.parent) parentOf.set(id, String(issue.parent.number));
        for (const sub of issue.subIssues.nodes) {
          const child = String(sub.number);
          if (!records.has(child)) keep(sub);
          parentOf.set(child, id);
        }
      }
      if (!issues.pageInfo.hasNextPage) break;
      cursor = issues.pageInfo.endCursor;
    }

    // The board's Done lane: tickets Landrace moved — an lr:stage:* label says
    // it did — that closed inside the window. A closed issue nobody routed is
    // not Landrace's to show. Bounded like the rest, but past the bound it
    // stops quietly rather than failing the tick: this is for the page, not
    // the loop.
    const since = Date.now() - DONE_WINDOW_MS;
    cursor = null;
    closed: for (let page = 0; page < MAX_ISSUE_PAGES; page++) {
      const data: { repository: { issues: Page<ClosedIssue> } | null } = await gh.graphql(CLOSED_QUERY, { owner, name, cursor });
      if (!data.repository) throw unseen(gh.repo);
      const { issues } = data.repository;
      for (const issue of issues.nodes) {
        if (issue.updatedAt !== null && Date.parse(issue.updatedAt) < since) break closed;
        if (issue.closedAt === null || Date.parse(issue.closedAt) < since) continue;
        if (!issue.labels.nodes.some((l) => l.name.startsWith(STAGE_LABEL_PREFIX))) continue;
        const id = String(issue.number);
        // A closed sub-issue is already here under its open parent, read lighter; this reading is the full one.
        records.delete(id);
        keep(issue);
        if (issue.parent) parentOf.set(id, String(issue.parent.number));
      }
      if (!issues.pageInfo.hasNextPage) break;
      cursor = issues.pageInfo.endCursor;
    }

    return [...records.values()].map((r) => ({ ...r, parent: parentOf.get(r.id) ?? null }));
  }

  async ticket(id: string, ctx: RuntimeContext): Promise<TicketRecord> {
    const number = issueNumber(id);
    const gh = this.gh(ctx);
    const data = await gh.graphql<{ repository: { issue: (IssueNode & { parent: { number: number } | null }) | null } | null }>(
      ISSUE_QUERY, { owner: gh.owner, name: gh.name, number },
    );
    if (!data.repository) throw unseen(gh.repo);
    const issue = data.repository.issue;
    if (!issue) throw new Error(`#${number} is not an issue in ${gh.repo}`);
    return recordOf(issue, issue.parent ? String(issue.parent.number) : null);
  }

  /** A count over the first page is a number known to be short: past the page, the ticket halts saying so. */
  async children(id: string, ctx: RuntimeContext): Promise<TicketRecord[]> {
    const number = issueNumber(id);
    const gh = this.gh(ctx);
    const data = await gh.graphql<{ repository: { issue: { subIssues: { totalCount: number; nodes: IssueNode[] } } | null } | null }>(
      SUB_ISSUES_QUERY, { owner: gh.owner, name: gh.name, number },
    );
    if (!data.repository) throw unseen(gh.repo);
    const issue = data.repository.issue;
    if (!issue) throw new Error(`#${number} is not an issue in ${gh.repo}`);
    const { totalCount, nodes } = issue.subIssues;
    if (totalCount > nodes.length) {
      throw new Error(`#${id} has ${totalCount} sub-issues, more than the ${TICKET_PAGE} one read carries`);
    }
    return nodes.map((sub) => recordOf(sub, id));
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

  async update(id: string, fields: Pick<TicketPatch, "title" | "body" | "state">, ctx: RuntimeContext): Promise<void> {
    await this.gh(ctx).updateIssue(issueNumber(id), fields);
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
