/*
 * GitHub pull requests as a project's forge: the pull request and review
 * thread queries, the push URLs it trusts with a token, and the pull request
 * probe. Everything else a forge does is `BaseForge`'s.
 *
 * Thread resolution is GraphQL-only: REST exposes review comments but not
 * `isResolved`. That is a hard requirement rather than an optimisation,
 * because the review loop's gate is a *count* of unresolved threads — a
 * structural fact nobody can write — and not a judge's verdict.
 */
import type { HookContext, RuntimeContext } from "landrace/hooks";
import {
  BaseForge, branchHeads, DONE_WINDOW_MS, ISSUE_PAGE, MAX_ISSUE_PAGES, MAX_THREAD_PAGES, nothingCommitted, originPushUrl,
  ownGit, prBranch, pushBranch, repositoryOf, THREAD_PAGE, TICKET_PAGE,
  type BranchHeads, type ChangedFile, type Git, type PullRecord, type ReviewThread, type ThreadComment,
} from "landrace/kit";
import { type Client, clientFor, issueNumber, tokenRejected, unseen } from "./client.js";

/**
 * What a pull request is asked for, wherever it is found: enough to know
 * whether it is open, merged or abandoned, the head a fix round moves, and —
 * with closing references on — the issues it closes. No thread in it and no
 * body.
 */
const pullFields = (refs: boolean): string => `
  number title url state merged headRefName headRefOid isCrossRepository createdAt${refs ? `
  closingIssuesReferences(first: 20) { nodes { number } }` : ""}`;

/**
 * Every open pull request, paged on its own cursor. Merged ones are not
 * listed here: the board shows what is live, and routing reads `read`, which
 * does include them.
 */
const pullsQuery = (refs: boolean): string => `
query LandracePulls($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: ${ISSUE_PAGE}, after: $cursor, orderBy: { field: CREATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { ${pullFields(refs)} }
    }
  }
}`;

/**
 * Merged and closed pull requests, most recently updated first, so the list
 * stops at the first one last touched before the window: none past it can
 * have been updated inside the window either. A Done ticket's merged pull
 * request never answers the open-only query above.
 */
const closedPullsQuery = (refs: boolean): string => `
query LandraceClosedPulls($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: [MERGED, CLOSED], first: ${ISSUE_PAGE}, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { ${pullFields(refs)} updatedAt }
    }
  }
}`;

/**
 * Every pull request tied to one ticket: the ones on its `landrace/{ticket}`
 * head, and — with closing references on — the ones that close its issue.
 */
const ticketQuery = (refs: boolean): string => refs
  ? `
query LandraceTicket($owner: String!, $name: String!, $number: Int!, $head: String!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      closedByPullRequestsReferences(first: ${TICKET_PAGE}, includeClosedPrs: true) { totalCount nodes { ${pullFields(true)} } }
    }
    pullRequests(headRefName: $head, states: [OPEN, MERGED, CLOSED], first: ${TICKET_PAGE},
                 orderBy: { field: CREATED_AT, direction: DESC }) {
      totalCount
      nodes { ${pullFields(true)} }
    }
  }
}`
  : `
query LandraceTicket($owner: String!, $name: String!, $head: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $head, states: [OPEN, MERGED, CLOSED], first: ${TICKET_PAGE},
                 orderBy: { field: CREATED_AT, direction: DESC }) {
      totalCount
      nodes { ${pullFields(false)} }
    }
  }
}`;

/**
 * Every review thread on one pull request, a page at a time — the one query
 * the count the graph carries and the text a prompt is briefed both read.
 *
 * `comments(first: 1)` is the finding itself, the thread's opening comment,
 * and when it was said places the thread in the ticket's history.
 * `lastReply` is the thread's last word, which says whose turn it is.
 * `totalCount` says whether there was a reply at all. Only the counts reach
 * the graph: a body is written by anyone with comment access.
 */
const THREADS_QUERY = `
query LandraceThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: ${THREAD_PAGE}, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          path
          line
          comments(first: 1) { totalCount nodes { body createdAt author { login } } }
          lastReply: comments(last: 1) { nodes { body author { login } } }
        }
      }
    }
  }
}`;

const RESOLVE_THREAD = `
mutation LandraceResolve($id: ID!) {
  resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } }
}`;

/**
 * A reply on a thread, by the thread's GraphQL id — the one the briefing
 * names. REST's reply endpoint wants a comment id nothing here reads.
 */
const REPLY_THREAD = `
mutation LandraceReply($id: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { comment { id } }
}`;

/** One minimal GraphQL read, cheap enough to cost nothing beyond what the thread reads already pay for. */
const PREFLIGHT_PR_QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 1) { totalCount }
  }
}`;

/**
 * Every GraphQL document the forge sends, so a test can cost each against
 * GitHub's node limit. With closing references off, each pull request query
 * asks for a subset of these, so costing these costs those.
 */
export const FORGE_QUERIES = {
  PULLS_QUERY: pullsQuery(true),
  CLOSED_PULLS_QUERY: closedPullsQuery(true),
  TICKET_QUERY: ticketQuery(true),
  THREADS_QUERY,
  PREFLIGHT_PR_QUERY,
  RESOLVE_THREAD,
  REPLY_THREAD,
};

interface PullNode {
  number: number;
  title: string;
  url: string;
  state: string;
  merged: boolean;
  headRefName: string;
  headRefOid: string;
  /** From a fork, whose head branch is named in somebody else's repository — and so could be named anything. */
  isCrossRepository: boolean;
  /** Absent when closing references are off. */
  closingIssuesReferences?: { nodes: Array<{ number: number }> };
  /** ISO 8601. Optional because a reading without it draws no age, never NaN. */
  createdAt?: string;
}

type Page<T> = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: T[] };

/** `author` is null for a deleted account, which GitHub shows as "ghost". */
interface ThreadNodeComment {
  body: string | null;
  createdAt?: string;
  author: { login: string } | null;
}

interface ThreadNode {
  id: string;
  isResolved: boolean;
  path: string | null;
  line: number | null;
  comments: { totalCount: number; nodes: ThreadNodeComment[] };
  lastReply: { nodes: ThreadNodeComment[] };
}

/**
 * A pull request as GraphQL answers it, as the kit reads one: a fork's head
 * branch is not named, and with closing references off it names no ticket
 * whatever the answer carried.
 */
const recordOf = (pull: PullNode, refs: boolean): PullRecord => ({
  number: pull.number,
  title: pull.title,
  link: pull.url,
  merged: pull.merged,
  closed: pull.state === "CLOSED",
  headSha: pull.headRefOid,
  branch: pull.isCrossRepository ? undefined : pull.headRefName,
  createdAt: pull.createdAt,
  tickets: refs ? (pull.closingIssuesReferences?.nodes ?? []).map((i) => String(i.number)) : [],
});

/** A thread comment as GraphQL answers it, as the kit reads one: a deleted account is no author at all. */
const commentOf = (c: ThreadNodeComment | undefined): ThreadComment | null =>
  c === undefined ? null : { body: c.body ?? "", author: c.author?.login ?? null };

/** A review thread as GraphQL answers it, as the kit reads one, placed in time by its opening comment. */
const threadOf = (t: ThreadNode): ReviewThread => ({
  id: t.id,
  resolved: t.isResolved,
  path: t.path,
  line: t.line,
  first: commentOf(t.comments.nodes[0]),
  last: commentOf(t.lastReply.nodes[0]),
  comments: t.comments.totalCount,
  at: t.comments.nodes[0]?.createdAt,
});

/** An owner or a repository name, as `tracker.repo` itself is validated: nothing a parser could read two ways. */
const NAME = "[A-Za-z0-9_-][A-Za-z0-9._-]*";

/**
 * The only forms of a GitHub push URL this integration will act on, matched
 * against the exact string git will use — never a parsed reading of it.
 *
 * git and curl parse a URL themselves, and a string two parsers read
 * differently — `https://github.com\@evil.com/…`, a percent-encoded `@` or
 * `/`, userinfo, a port — could have one of them see github.com while the
 * other sends the header somewhere else. So the decision is not a parse at
 * all: a URL in exactly one of these shapes, with github.com as its whole
 * host (case aside), or no GitHub decision is made from it.
 */
const GITHUB_URLS: Array<{ pattern: RegExp; https: boolean }> = [
  { pattern: new RegExp(`^https://([^/]+)/(${NAME})/(${NAME}?)(?:\\.git)?/?$`), https: true },
  { pattern: new RegExp(`^git@([^:/]+):(${NAME})/(${NAME}?)(?:\\.git)?/?$`), https: false },
  { pattern: new RegExp(`^ssh://git@([^/]+)/(${NAME})/(${NAME}?)(?:\\.git)?/?$`), https: false },
];

/**
 * Which repository a push URL names on GitHub, and whether it is the https
 * form the token may go to — or null for a URL that is not one of those
 * forms. `looksLikeGithub` says whether such a URL mentions github.com at
 * all: one that does and is not in a verifiable form is refused rather than
 * pushed to, since it might be another repository.
 */
function githubRemote(url: string): { repo: string; https: boolean } | null {
  for (const { pattern, https } of GITHUB_URLS) {
    const m = pattern.exec(url);
    if (m && m[1]?.toLowerCase() === "github.com") return { repo: `${m[2]}/${m[3]}`.toLowerCase(), https };
  }
  return null;
}
const looksLikeGithub = (url: string): boolean => /github\.com/i.test(url);

/**
 * A URL fit to name in a message: everything up to the last "@" before the
 * host is left out, because a password may itself carry a raw "@".
 */
const shown = (url: string): string => url.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/]*@/, "$1");

/**
 * Publish one branch to origin, fast-forward only — `pushBranch`, to the one
 * push URL `originPushUrl` allows, once it has been checked here.
 *
 * The token goes into the push's environment only when that one URL is an
 * https URL on github.com naming this very repository. An ssh origin, one
 * whose URL carries its own credentials, or one on another host is pushed
 * with the operator's own credentials and no token at all; a GitHub origin
 * naming some other repository is refused, since its branch could never be
 * the head of a pull request here.
 *
 * With the token, it rides in git's environment as configuration and never
 * on its command line. The header is scoped to that exact URL, not to
 * github.com, so no other destination that slipped in would be handed it;
 * an empty value first clears a header some other tool left configured (a CI
 * checkout does), and credential helpers and askpass are cleared so nothing
 * git would start to ask for credentials sees the token either. Whatever git
 * says back is scrubbed of both spellings of the token before it becomes an
 * error, a log line or a comment.
 */
async function push(git: Git, { token, repo }: Client, branch: string, ticket: string, signal: AbortSignal): Promise<void> {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  const scrub = (text: string): string => text.replaceAll(token, "[redacted]").replaceAll(basic, "[redacted]");
  const url = await originPushUrl(git, branch, signal);
  const remote = githubRemote(url);
  if (remote === null && looksLikeGithub(url)) {
    throw new Error(
      `refusing to push ${branch}: origin's push URL ${shown(url)} mentions github.com but is not in a form ` +
      "landrace can verify — https://github.com/<owner>/<repo>(.git), git@github.com:<owner>/<repo>.git or " +
      "ssh://git@github.com/<owner>/<repo>.git. A URL git could read differently from how it reads here is " +
      "not one to push to, or hand a token to; set it in one of those forms and the ticket carries on",
    );
  }
  if (remote && remote.repo !== repo.toLowerCase()) {
    throw new Error(
      `refusing to push ${branch}: origin pushes to ${shown(url)}, which is not ${repo}, the repository ` +
      "this workflow's tracker is — a pull request here could never be opened from it",
    );
  }
  const header = `http.${url}.extraheader`;
  const auth: Array<[string, string]> = remote?.https === true
    ? [[header, ""], [header, `AUTHORIZATION: basic ${basic}`], ["credential.helper", ""], ["core.askPass", ""]]
    : [];

  try {
    await pushBranch(git, branch, ticket, signal, auth);
  } catch (e) {
    throw new Error(scrub(e instanceof Error ? e.message : String(e)));
  }
}

/**
 * Only the shapes that actually mean "this token cannot read pull requests"
 * get the permission's own name: a GraphQL error typed `FORBIDDEN`, one whose
 * message says the resource is not accessible, or a bare HTTP 403 mentioning
 * permission or access. A rate limit, a repository GraphQL cannot resolve, or
 * anything else still fails closed — but with its own cause, rather than a
 * misdiagnosis that sends someone to fix a permission that was never the
 * problem.
 */
function prReadFailure(e: unknown, repo: string): Error {
  const rejected = tokenRejected(e);
  if (rejected) return rejected;

  const status = (e as { status?: unknown } | null)?.status;
  const errors = (e as { errors?: unknown } | null)?.errors;
  const message = e instanceof Error ? e.message : String(e);

  const forbiddenType = Array.isArray(errors) && errors.some(
    (err) => typeof err === "object" && err !== null && (err as { type?: unknown }).type === "FORBIDDEN",
  );
  const notAccessible = /not accessible/i.test(message);
  const deniedByStatus = status === 403 && /permission|access/i.test(message);

  return forbiddenType || notAccessible || deniedByStatus
    ? new Error(`token needs "Pull requests: Read" on ${repo}`)
    : new Error(`pull request check failed: ${message}`);
}

/**
 * The file that said `new`: past this module's own frames, and past the
 * constructors of any subclass, wherever those are defined — a subclass in a
 * shared package is still constructed by the project's hook file. A frame
 * read anywhere in here would name this module instead, and an integration
 * run against a linked landrace would read landrace's repository rather than
 * the project's.
 *
 * `import.meta` cannot be the caller's anyway, and ts-jest's default pass
 * compiles CommonJS, where it is refused outright. The file name V8 records
 * for a frame is the same fact in either module system — a path under jest, a
 * file: URL under node.
 */
function constructedIn(): string | null {
  const saved = Error.prepareStackTrace;
  try {
    Error.prepareStackTrace = (_error, frames) => frames;
    const frames = (new Error().stack as unknown as NodeJS.CallSite[] | undefined) ?? [];
    const here = frames[0]?.getFileName();
    const caller = frames.find((f) => {
      const file = f.getFileName();
      return !!file && file !== here && !file.startsWith("node:") && !f.isConstructor();
    });
    return caller?.getFileName() ?? null;
  } finally {
    Error.prepareStackTrace = saved;
  }
}

/**
 * GitHub pull requests, over one client — the one handed in, or the one
 * `ctx.config` builds — and git in one checkout: `git` when handed one,
 * otherwise the repository of the file that constructed this, never the
 * directory the process was started from.
 *
 * `closingRefs` is whether the tracker beside it is GitHub's own issues. On,
 * a pull request it opens says `Closes #n` and one that closes a ticket's
 * issue is tied to it; off, it writes none and reads none — beside another
 * vendor's tracker, `#7` is GitHub's issue 7, which is somebody else's, and a
 * merge would close it.
 */
export class GitHubForge extends BaseForge {
  private readonly client: Client | undefined;
  private readonly git: Git;
  private readonly closingRefs: boolean;

  constructor({ closingRefs = false, client, git }: { closingRefs?: boolean; client?: Client; git?: Git } = {}) {
    super();
    this.client = client;
    this.closingRefs = closingRefs;
    if (git) {
      this.git = git;
    } else {
      const file = constructedIn();
      this.git = ownGit(async () => {
        if (file === null) throw new Error("the GitHub forge cannot tell which file constructed it, so it cannot find its repository; hand it git");
        return repositoryOf(file);
      });
    }
  }

  private gh(ctx: RuntimeContext): Client {
    return this.client ?? clientFor(ctx);
  }

  async login(ctx: RuntimeContext): Promise<string> {
    return this.gh(ctx).botLogin();
  }

  /** Every open pull request, paged and bounded, and the Done lane's merged and closed ones. */
  async pulls(ctx: RuntimeContext): Promise<PullRecord[]> {
    const gh = this.gh(ctx);
    const { owner, name } = gh;
    const pulls: PullNode[] = [];

    // A pull request missing from a short list is a ticket the board shows with no work on it.
    let cursor: string | null = null;
    for (let page = 0; ; page++) {
      if (page === MAX_ISSUE_PAGES) {
        throw new Error(`${gh.repo} has more than ${MAX_ISSUE_PAGES * ISSUE_PAGE} open pull requests, more than one list may carry`);
      }
      const data: { repository: { pullRequests: Page<PullNode> } | null } =
        await gh.graphql(pullsQuery(this.closingRefs), { owner, name, cursor });
      if (!data.repository) throw unseen(gh.repo);
      const { pullRequests } = data.repository;
      pulls.push(...pullRequests.nodes);
      if (!pullRequests.pageInfo.hasNextPage) break;
      cursor = pullRequests.pageInfo.endCursor;
    }

    // The Done lane's window, over merged and closed pull requests: bounded,
    // and stopped quietly past it — this is for the board, not the tick.
    const since = Date.now() - DONE_WINDOW_MS;
    cursor = null;
    closed: for (let page = 0; page < MAX_ISSUE_PAGES; page++) {
      const data: { repository: { pullRequests: Page<PullNode & { updatedAt: string | null }> } | null } =
        await gh.graphql(closedPullsQuery(this.closingRefs), { owner, name, cursor });
      if (!data.repository) throw unseen(gh.repo);
      const { pullRequests } = data.repository;
      for (const pull of pullRequests.nodes) {
        // No `updatedAt` at all says nothing about whether it is inside the
        // window — never shown on a guess.
        if (pull.updatedAt === null) continue;
        if (Date.parse(pull.updatedAt) < since) break closed;
        pulls.push(pull);
      }
      if (!pullRequests.pageInfo.hasNextPage) break;
      cursor = pullRequests.pageInfo.endCursor;
    }

    return pulls.map((pull) => recordOf(pull, this.closingRefs));
  }

  /**
   * One ticket's pull requests, found either way — by its branch, and by
   * closing reference — once each. A fork's found by its head name alone is
   * not this ticket's: the name is in somebody else's repository. By closing
   * reference, it is.
   */
  async pullsNaming(ticket: string, ctx: RuntimeContext): Promise<PullRecord[]> {
    const gh = this.gh(ctx);
    type Connection = { totalCount: number; nodes: PullNode[] };
    const data = await gh.graphql<{
      repository: { issue?: { closedByPullRequestsReferences: Connection } | null; pullRequests: Connection } | null;
    }>(ticketQuery(this.closingRefs), {
      owner: gh.owner, name: gh.name, head: prBranch(ticket), ...(this.closingRefs ? { number: issueNumber(ticket) } : {}),
    });
    if (!data.repository) throw unseen(gh.repo);
    const { issue, pullRequests } = data.repository;
    if (this.closingRefs && !issue) throw new Error(`#${ticket} is not an issue in ${gh.repo}`);
    const closing = issue?.closedByPullRequestsReferences;

    // A count over the first page is a number known to be short, and every
    // one of these is counted: past the page, the ticket halts saying so.
    for (const [what, connection] of [["pull requests on its branch", pullRequests], ["pull requests closing it", closing]] as const) {
      if (connection && connection.totalCount > connection.nodes.length) {
        throw new Error(`#${ticket} has ${connection.totalCount} ${what}, more than the ${TICKET_PAGE} one read carries`);
      }
    }

    const byNumber = new Map<number, PullNode>();
    for (const pull of [...pullRequests.nodes.filter((p) => !p.isCrossRepository), ...(closing?.nodes ?? [])]) {
      if (!byNumber.has(pull.number)) byNumber.set(pull.number, pull);
    }
    return [...byNumber.values()].map((pull) => recordOf(pull, this.closingRefs));
  }

  /**
   * Every review thread on one pull request, every page — or a refusal past
   * the bound: a count over part of them is a number known to be short, and
   * a briefing that stopped at the first page would show the fixer nothing
   * while the gate said findings were open.
   */
  async threads(pull: number, ctx: RuntimeContext): Promise<ReviewThread[]> {
    const gh = this.gh(ctx);
    const all: ReviewThread[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_THREAD_PAGES; page++) {
      const data: { repository: { pullRequest: { reviewThreads: Page<ThreadNode> } | null } | null } =
        await gh.graphql(THREADS_QUERY, { owner: gh.owner, name: gh.name, number: pull, cursor });
      if (!data.repository) throw unseen(gh.repo);
      const threads = data.repository.pullRequest?.reviewThreads;
      if (!threads) throw new Error(`pull request #${pull} answered with no review threads at all`);
      all.push(...threads.nodes.map(threadOf));
      if (!threads.pageInfo.hasNextPage) return all;
      cursor = threads.pageInfo.endCursor;
    }
    throw new Error(
      `the pull request #${pull} has more than ${MAX_THREAD_PAGES * THREAD_PAGE} review threads, ` +
      "so the open-thread count the review loop gates on cannot be read in one pass. " +
      "Reporting the count of what was read would be reporting a number known to be short.",
    );
  }

  async changedFiles(pull: number, ctx: RuntimeContext): Promise<ChangedFile[]> {
    return (await this.gh(ctx).pullFiles(pull)).map((f) => ({
      path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch,
    }));
  }

  async reviews(pull: number, ctx: RuntimeContext): Promise<string[]> {
    return (await this.gh(ctx).listReviews(pull)).map((r) => r.body ?? "");
  }

  async openPull({ ticket, branch, title }: { ticket: string; branch: string; title: string }, ctx: RuntimeContext): Promise<void> {
    const gh = this.gh(ctx);
    try {
      await gh.openPull({
        head: branch,
        base: await gh.defaultBranch(),
        title,
        // The closing reference is the second way a pull request is tied to
        // its ticket, and the one that survives a branch named any way at all.
        ...(this.closingRefs ? { body: `Closes #${issueNumber(ticket)}` } : {}),
      });
    } catch (e) {
      // GitHub's own way of saying what the push check says.
      if ((e as { status?: unknown } | null)?.status === 422 && /No commits between/i.test(String(e))) {
        throw nothingCommitted(branch, ticket);
      }
      throw e;
    }
  }

  async closePull(pull: number, ctx: RuntimeContext): Promise<void> {
    await this.gh(ctx).closePull(pull);
  }

  /** File threads first, the review last: its marker is what says the round is on GitHub. */
  async postReview(
    pull: number,
    { body, lines, files, head }: {
      body: string; lines: Array<{ path: string; line: number; body: string }>; files: Array<{ path: string; body: string }>; head: string;
    },
    ctx: RuntimeContext,
  ): Promise<void> {
    const gh = this.gh(ctx);
    for (const f of files) await gh.commentOnFile(pull, f.path, f.body, head);
    await gh.postReview(pull, body, lines.map((c) => ({ path: c.path, line: c.line, side: "RIGHT" as const, body: c.body })));
  }

  /** Checked, not assumed: no comment in the answer is a reply that did not land. */
  async reply(thread: string, body: string, ctx: RuntimeContext): Promise<void> {
    const done = await this.gh(ctx).graphql<{ addPullRequestReviewThreadReply?: { comment?: { id?: string } | null } | null }>(
      REPLY_THREAD, { id: thread, body },
    );
    if (!done.addPullRequestReviewThreadReply?.comment?.id) throw new Error(`GitHub did not post the reply on review thread ${thread}`);
  }

  /** Checked the same way: an answer that does not say the thread is now resolved is a resolve that did not happen. */
  async resolve(thread: string, ctx: RuntimeContext): Promise<void> {
    const done = await this.gh(ctx).graphql<{ resolveReviewThread?: { thread?: { isResolved?: boolean } } | null }>(
      RESOLVE_THREAD, { id: thread },
    );
    if (done.resolveReviewThread?.thread?.isResolved !== true) throw new Error(`GitHub did not resolve review thread ${thread}`);
  }

  async heads(): Promise<BranchHeads> {
    return branchHeads(this.git);
  }

  async push(branch: string, ticket: string, ctx: HookContext): Promise<void> {
    await push(this.git, this.gh(ctx), branch, ticket, ctx.signal);
  }

  /**
   * "Pull requests: Read", probed with one minimal query. Its write half has
   * no harmless form to try — opening a ticket's pull request and closing a
   * dropped child's both need it — so a fine-grained token without it is
   * named by the write itself.
   */
  async check(ctx: RuntimeContext): Promise<void> {
    const gh = this.gh(ctx);
    let data: { repository: unknown };
    try {
      data = await gh.graphql(PREFLIGHT_PR_QUERY, { owner: gh.owner, name: gh.name });
    } catch (e) {
      throw prReadFailure(e, gh.repo);
    }
    // A 200 with no errors and a null repository is GitHub's other shape for
    // "this token cannot see it": the read this probe exists to prove never happened.
    if (data.repository === null) {
      throw new Error(`pull request check failed: the repository "${gh.repo}" answered with nothing at all; check the token's access to it`);
    }
  }
}
