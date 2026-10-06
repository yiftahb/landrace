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
  BaseForge, branchHeads, DONE_WINDOW_MS, EffectRefused, fetchBranch, isEffectRefused, ISSUE_PAGE, MAX_ISSUE_PAGES, MAX_THREAD_PAGES, nothingCommitted, originPushUrl,
  itemBranchOf, ownGit, prBranch, pushBranch, repositoryOf, THREAD_PAGE, ITEM_PAGE,
  type BranchHeads, type ChangedFiles, type CheckState, type FailedCheck, type ForgeOptions, type Git, type MergeAnswer, type PullRecord,
  type ReviewThread, type ThreadComment,
} from "landrace/kit";
import { type Client, clientFor, issueNumber, MAX_COMMENT_CHARS, tokenRejected, unseen } from "./client.js";

/**
 * What a pull request is asked for, wherever it is found: enough to know
 * whether it is open, merged or abandoned, the head a fix round moves, and
 * whether it is from a fork. No thread in it and no body, and not the issues
 * it closes: anyone can write `Closes #7`, from a fork too, so what a pull
 * request says it closes ties it to nothing.
 */
const PULL_FIELDS = `
  number title url state merged headRefName headRefOid isCrossRepository createdAt updatedAt mergeable`;

/**
 * Every open pull request, paged on its own cursor. Merged ones are not
 * listed here: the board shows what is live, and routing reads `read`, which
 * does include them.
 */
const PULLS_QUERY = `
query LandracePulls($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: ${ISSUE_PAGE}, after: $cursor, orderBy: { field: CREATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { ${PULL_FIELDS} }
    }
  }
}`;

/**
 * Merged and closed pull requests, most recently updated first, so the list
 * stops at the first one last touched before the window: none past it can
 * have been updated inside the window either. A Done item's merged pull
 * request never answers the open-only query above.
 */
const CLOSED_PULLS_QUERY = `
query LandraceClosedPulls($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: [MERGED, CLOSED], first: ${ISSUE_PAGE}, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { ${PULL_FIELDS} }
    }
  }
}`;

/**
 * Every pull request on one item's branch as its head, a page at a time
 * on its own cursor — a fork's among them, since GitHub cannot be asked for
 * one repository's heads alone, until `pullsNaming` leaves it out.
 */
const ITEM_QUERY = `
query LandraceItem($owner: String!, $name: String!, $head: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $head, states: [OPEN, MERGED, CLOSED], first: ${ITEM_PAGE}, after: $cursor,
                 orderBy: { field: CREATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { ${PULL_FIELDS} }
    }
  }
}`;

/**
 * Every review thread on one pull request, a page at a time — the one query
 * the count the graph carries and the text a prompt is briefed both read.
 *
 * `comments(first: 1)` is the finding itself, the thread's opening comment,
 * and when it was said places the thread in the item's history.
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
 * A commit's rollup: GitHub's own fold of its check runs and its statuses
 * into one state, so a pull request's CI is one small read rather than two
 * lists. It is its own query and not a field of the pull request ones, which
 * would widen every list.
 */
const CHECKS_QUERY = `
query LandraceChecks($owner: String!, $name: String!, $oid: GitObjectID!) {
  repository(owner: $owner, name: $name) {
    object(oid: $oid) { ... on Commit { statusCheckRollup { state } } }
  }
}`;

/** Every GraphQL document the forge sends, so a test can cost each against GitHub's node limit. */
export const FORGE_QUERIES = {
  PULLS_QUERY,
  CLOSED_PULLS_QUERY,
  ITEM_QUERY,
  THREADS_QUERY,
  PREFLIGHT_PR_QUERY,
  CHECKS_QUERY,
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
  /** ISO 8601. Optional because a reading without it draws no age, never NaN. */
  createdAt?: string;
  /** ISO 8601, when it last changed: the board's lane order. Optional likewise; null where GitHub answers none. */
  updatedAt?: string | null;
  /** Whether it conflicts with its base: UNKNOWN while GitHub works it out. */
  mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
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
 * branch is not named, so it is no item's, and no item is named beside the
 * head — the issues its text closes tie it to nothing.
 */
const recordOf = (pull: PullNode): PullRecord => ({
  number: pull.number,
  title: pull.title,
  link: pull.url,
  merged: pull.merged,
  closed: pull.state === "CLOSED",
  headSha: pull.headRefOid,
  conflicts: pull.mergeable === "CONFLICTING" ? true : pull.mergeable === "MERGEABLE" ? false : null,
  branch: pull.isCrossRepository ? undefined : pull.headRefName,
  createdAt: pull.createdAt,
  updatedAt: pull.updatedAt ?? undefined,
  items: [],
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
 * origin's one push URL, as `originPushUrl` allows it, checked here — the one
 * destination landrace publishes an item's branch to and fetches it back
 * from — and what git is handed with it.
 *
 * The token goes into git's environment only when that one URL is an
 * https URL on github.com naming this very repository. An ssh origin, one
 * whose URL carries its own credentials, or one on another host is reached
 * with the operator's own credentials and no token at all; a GitHub origin
 * naming some other repository is refused, since its branch could never be
 * the head of a pull request here.
 *
 * With the token, it rides in git's environment as configuration and never
 * on its command line. The header is scoped to that exact URL, not to
 * github.com, so no other destination that slipped in would be handed it;
 * an empty value first clears a header some other tool left configured (a CI
 * checkout does), and credential helpers and askpass are cleared so nothing
 * git would start to ask for credentials sees the token either. `scrub` takes
 * both spellings of the token out of whatever git says back, before it
 * becomes an error, a log line or a comment.
 */
async function origin(
  git: Git, { token, repo }: Client, branch: string, signal: AbortSignal, verb: "push" | "fetch",
): Promise<{ url: string; auth: Array<[string, string]>; scrub: (text: string) => string }> {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  const scrub = (text: string): string => text.replaceAll(token, "[redacted]").replaceAll(basic, "[redacted]");
  const url = await originPushUrl(git, branch, signal, verb);
  const remote = githubRemote(url);
  if (remote === null && looksLikeGithub(url)) {
    throw new Error(
      `refusing to ${verb} ${branch}: origin's push URL ${shown(url)} mentions github.com but is not in a form ` +
      "landrace can verify — https://github.com/<owner>/<repo>(.git), git@github.com:<owner>/<repo>.git or " +
      "ssh://git@github.com/<owner>/<repo>.git. A URL git could read differently from how it reads here is " +
      "not one to push to, or hand a token to; set it in one of those forms and the item carries on",
    );
  }
  if (remote && remote.repo !== repo.toLowerCase()) {
    throw new Error(
      `refusing to ${verb} ${branch}: origin pushes to ${shown(url)}, which is not ${repo}, the repository ` +
      "this workflow's tracker is — a pull request here could never be opened from it",
    );
  }
  const header = `http.${url}.extraheader`;
  const auth: Array<[string, string]> = remote?.https === true
    ? [[header, ""], [header, `AUTHORIZATION: basic ${basic}`], ["credential.helper", ""], ["core.askPass", ""]]
    : [];
  return { url, auth, scrub };
}

/** Publish one branch to origin, fast-forward only — `pushBranch`, to the URL `origin` checked, with what it hands git. */
async function push(git: Git, client: Client, branch: string, item: string, signal: AbortSignal): Promise<void> {
  const { auth, scrub } = await origin(git, client, branch, signal, "push");
  try {
    await pushBranch(git, branch, item, signal, auth);
  } catch (e) {
    throw new Error(scrub(e instanceof Error ? e.message : String(e)));
  }
}

/** Origin's head of one branch, fetched into this checkout — `fetchBranch`, from the URL `origin` checked, with what it hands git. */
async function fetchHead(git: Git, client: Client, branch: string, signal: AbortSignal): Promise<string | null> {
  const { url, auth, scrub } = await origin(git, client, branch, signal, "fetch");
  try {
    return await fetchBranch(git, url, branch, signal, auth);
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

const CHECK_STATES: Record<string, CheckState> = {
  SUCCESS: "success", FAILURE: "failure", ERROR: "failure", PENDING: "pending", EXPECTED: "pending",
};

/** A run that ended in any of these is a failed check; one still running, skipped, neutral or green is not. */
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);

/** Whether GitHub said this token may not read it: a 403, or GraphQL's FORBIDDEN or "not accessible". */
function refusedRead(e: unknown): boolean {
  const errors = (e as { errors?: unknown } | null)?.errors;
  return (e as { status?: unknown } | null)?.status === 403 ||
    /not accessible/i.test(e instanceof Error ? e.message : String(e)) ||
    (Array.isArray(errors) && errors.some((err) => (err as { type?: unknown } | null)?.type === "FORBIDDEN"));
}

/**
 * A CI read that failed: the permission by name when GitHub refused it, with
 * GitHub's own words kept, else the failure as it came. Never an answer — a
 * check that could not be read is not a check that passed.
 */
function ciReadFailure(e: unknown, permission: string, repo: string): unknown {
  const rejected = tokenRejected(e);
  if (rejected) return rejected;
  return refusedRead(e)
    ? new Error(`token needs "${permission}" on ${repo} (GitHub answered: ${e instanceof Error ? e.message : String(e)})${grantedHow([permission])}`)
    : e;
}

/**
 * GitHub offers no Checks permission on a fine-grained token — only a
 * classic token's `repo` scope or a GitHub App can read check runs. A user
 * told only "needs Checks: Read" went looking for a setting that does not
 * exist, so the sentence says where it does.
 */
function grantedHow(permissions: readonly string[]): string {
  return permissions.includes("Checks: Read")
    ? ". GitHub grants \"Checks: Read\" only to a classic token with the repo scope or to a GitHub App, never to a fine-grained token"
    : "";
}

/** Nothing can be read on a commit that is not named, and an empty name is a refused read, not a green one. */
function noHead(pull: PullRecord): void {
  if (!pull.headSha) throw new Error(`pr-${pull.number} has no head commit to read checks on`);
}

/** What GitHub said, out of the JSON body of a refusal: its `message`, or the body as it came. */
function refusalMessage(e: unknown): string {
  const body = (e as { body?: unknown } | null)?.body;
  if (typeof body !== "string") return e instanceof Error ? e.message : String(e);
  try {
    const message = (JSON.parse(body) as { message?: unknown }).message;
    return typeof message === "string" ? message : body;
  } catch {
    return body;
  }
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
 * a pull request it opens says `Closes #n`, so the merge closes the issue;
 * off, it writes none — beside another vendor's tracker, `#7` is GitHub's
 * issue 7, which is somebody else's, and a merge would close it. Either way
 * it reads none: a pull request is an item's only from that item's own
 * branch as its head in this repository, since anybody — a fork on a
 * public repository — can write `Closes #7`, and what it was tied to by that
 * reached the prompts and the routing of an item merged with no person.
 */
export class GitHubForge extends BaseForge {
  readonly commentChars = MAX_COMMENT_CHARS;
  private readonly client: Client | undefined;
  private readonly git: Git;
  private readonly closingRefs: boolean;

  constructor({ closingRefs = false, client, git, reviewers, pull }: { closingRefs?: boolean; client?: Client; git?: Git } & ForgeOptions = {}) {
    super({ reviewers, pull });
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

    // A pull request missing from a short list is an item the board shows with no work on it.
    let cursor: string | null = null;
    for (let page = 0; ; page++) {
      if (page === MAX_ISSUE_PAGES) {
        throw new Error(`${gh.repo} has more than ${MAX_ISSUE_PAGES * ISSUE_PAGE} open pull requests, more than one list may carry`);
      }
      const data: { repository: { pullRequests: Page<PullNode> } | null } =
        await gh.graphql(PULLS_QUERY, { owner, name, cursor });
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
        await gh.graphql(CLOSED_PULLS_QUERY, { owner, name, cursor });
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

    return pulls.map(recordOf);
  }

  /**
   * One item's pull requests: every one on its branch — `landrace/{item}`,
   * or the one landrace.yaml names — as its head in this repository. A fork's on a head of that name is not this item's —
   * the name is in somebody else's repository — and nor is one that only
   * says it closes the item.
   *
   * Forks are left out page by page, before anything is counted: counted
   * first, anybody's 51 forks on a branch named `landrace/7` halted #7
   * (re-review N9). The item's own past one page is still a number known to
   * be short, and so is a list the page bound cut — the item's own pull
   * request may be past the cut — so either halts the item, saying so.
   */
  async pullsNaming(item: string, ctx: RuntimeContext): Promise<PullRecord[]> {
    const gh = this.gh(ctx);
    const head = prBranch(item, itemBranchOf(ctx.config));
    const own: PullNode[] = [];
    let cursor: string | null = null;
    for (let page = 0; ; page++) {
      if (page === MAX_ISSUE_PAGES) {
        throw new Error(
          `more than ${MAX_ISSUE_PAGES * ITEM_PAGE} pull requests are on a branch named ${head}, forks' among them, ` +
          `more than #${item}'s read carries — its own may be past them`,
        );
      }
      const data: { repository: { pullRequests: Page<PullNode> } | null } =
        await gh.graphql(ITEM_QUERY, { owner: gh.owner, name: gh.name, head, cursor });
      if (!data.repository) throw unseen(gh.repo);
      const { pullRequests } = data.repository;
      own.push(...pullRequests.nodes.filter((p) => !p.isCrossRepository));
      if (own.length > ITEM_PAGE) {
        throw new Error(`#${item} has more than ${ITEM_PAGE} pull requests on its branch, more than one read carries`);
      }
      if (!pullRequests.pageInfo.hasNextPage) return own.map(recordOf);
      cursor = pullRequests.pageInfo.endCursor;
    }
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

  async changedFiles(pull: number, ctx: RuntimeContext): Promise<ChangedFiles> {
    const { files, complete } = await this.gh(ctx).pullFiles(pull);
    return {
      complete,
      files: files.map((f) => ({
        path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch,
        ...(f.previous_filename === undefined ? {} : { previous: f.previous_filename }),
      })),
    };
  }

  async reviews(pull: number, ctx: RuntimeContext): Promise<string[]> {
    return (await this.gh(ctx).listReviews(pull)).map((r) => r.body ?? "");
  }

  async openPull(
    { item, branch, title, description }: { item: string; branch: string; title: string; description?: string }, ctx: RuntimeContext,
  ): Promise<void> {
    const gh = this.gh(ctx);
    // So the merge closes the issue. It ties nothing: see the class.
    const body = [description, this.closingRefs ? `Closes #${issueNumber(item)}` : undefined].filter((t) => t !== undefined).join("\n\n");
    try {
      await gh.openPull({
        head: branch,
        base: await gh.defaultBranch(),
        title,
        ...(body === "" ? {} : { body }),
      });
    } catch (e) {
      // GitHub's own way of saying what the push check says.
      if ((e as { status?: unknown } | null)?.status === 422 && /No commits between/i.test(String(e))) {
        throw nothingCommitted(branch, item);
      }
      throw e;
    }
  }

  async closePull(pull: number, ctx: RuntimeContext): Promise<void> {
    await this.gh(ctx).closePull(pull);
  }

  /**
   * The rollup on the pull request's head commit. A commit with no rollup has
   * nothing configured to check it — or nothing registered yet — and reads
   * `none`. A commit GitHub does not know, or a state this does not know, is
   * not read at all, and so is not green.
   */
  async checks(pull: PullRecord, ctx: RuntimeContext): Promise<CheckState> {
    if (this.reviewers.size > 0) return this.checksBesideReviewers(pull, ctx);
    noHead(pull);
    const gh = this.gh(ctx);
    let data: { repository: { object: { statusCheckRollup?: { state?: string } | null } | null } | null };
    try {
      data = await gh.graphql(CHECKS_QUERY, { owner: gh.owner, name: gh.name, oid: pull.headSha });
    } catch (e) {
      throw ciReadFailure(e, "Checks: Read", gh.repo);
    }
    if (!data.repository) throw unseen(gh.repo);
    if (data.repository.object === null) throw new Error(`${gh.repo} has no commit ${pull.headSha}, so the checks on pr-${pull.number} cannot be read`);
    const state = data.repository.object.statusCheckRollup?.state;
    if (state === undefined) return "none";
    const known = CHECK_STATES[state];
    if (known === undefined) throw new Error(`GitHub answered a check state "${state}" for ${pull.headSha}, which landrace does not know how to read`);
    return known;
  }

  /**
   * The rollup folds a reviewer's run or status in with the rest, so with
   * `reviewers` named the head's runs and statuses are read one by one and
   * combined without them: any failed is `failure`, any running — or a list
   * GitHub did not give whole — `pending`, nothing left `none`.
   */
  private async checksBesideReviewers(pull: PullRecord, ctx: RuntimeContext): Promise<CheckState> {
    const { contexts, complete } = await this.contexts(pull, ctx);
    const states = contexts.filter((c) => !this.reviewers.has(c.name)).map((c) => c.state);
    if (states.includes("failure")) return "failure";
    if (!complete || states.includes("pending")) return "pending";
    return states.length === 0 ? "none" : "success";
  }

  /**
   * Each failed check run and each failed status on the head, with the log
   * GitHub will give: an Actions job's own log, or the text another app wrote
   * on its run. A log that cannot be had is `null` — the check is still named.
   *
   * ponytail: one page of 100 check runs; a pull request with more failed
   * checks than that is not a case worth paging for.
   */
  async failedChecks(pull: PullRecord, ctx: RuntimeContext): Promise<FailedCheck[]> {
    const { gh, runs, statuses } = await this.onHead(pull, ctx);
    const failed: FailedCheck[] = [];
    for (const run of (runs.check_runs ?? []).filter((r) => r.conclusion !== null && FAILED_CONCLUSIONS.has(r.conclusion) && !this.reviewers.has(r.name))) {
      let log: string | null;
      if (run.app?.slug === "github-actions") {
        // The log is optional: a 403 (no "Actions: Read"), a 404 or a 410 (expired) leaves the check named without it.
        log = await gh.jobLog(run.id).catch(() => null);
      } else {
        log = run.output?.text ?? run.output?.summary ?? null;
      }
      failed.push({ name: run.name, log });
    }
    for (const status of (statuses.statuses ?? []).filter((s) => (s.state === "failure" || s.state === "error") && !this.reviewers.has(s.context))) {
      failed.push({ name: status.context, log: status.description ?? null });
    }
    return failed;
  }

  /** The head's check runs, one page of 100, and its commit statuses, the latest of each context. */
  private async onHead(pull: PullRecord, ctx: RuntimeContext): Promise<{
    gh: Client; runs: Awaited<ReturnType<Client["checkRuns"]>>; statuses: Awaited<ReturnType<Client["commitStatus"]>>;
  }> {
    noHead(pull);
    const gh = this.gh(ctx);
    let runs: Awaited<ReturnType<Client["checkRuns"]>>;
    let statuses: Awaited<ReturnType<Client["commitStatus"]>>;
    try {
      runs = await gh.checkRuns(pull.headSha, 100);
    } catch (e) {
      throw ciReadFailure(e, "Checks: Read", gh.repo);
    }
    try {
      statuses = await gh.commitStatus(pull.headSha);
    } catch (e) {
      throw ciReadFailure(e, "Commit statuses: Read", gh.repo);
    }
    return { gh, runs, statuses };
  }

  /**
   * Every check run and commit status on the head, each by its name and
   * where it stands — a run not completed is pending, one that ended in a
   * failed conclusion is a failure, any other ending passed — and whether
   * GitHub listed all of them.
   */
  private async contexts(pull: PullRecord, ctx: RuntimeContext): Promise<{ contexts: Array<{ name: string; state: CheckState }>; complete: boolean }> {
    const { runs, statuses } = await this.onHead(pull, ctx);
    const contexts: Array<{ name: string; state: CheckState }> = [];
    for (const run of runs.check_runs ?? []) {
      const state: CheckState = run.status !== undefined && run.status !== "completed" || run.conclusion === null
        ? "pending"
        : FAILED_CONCLUSIONS.has(run.conclusion) ? "failure" : "success";
      contexts.push({ name: run.name, state });
    }
    for (const status of statuses.statuses ?? []) {
      const state = CHECK_STATES[status.state.toUpperCase()];
      if (state === undefined) throw new Error(`GitHub answered a commit status "${status.state}" for ${pull.headSha}, which landrace does not know how to read`);
      contexts.push({ name: status.context, state });
    }
    const listed = (total: number | undefined, read: number): boolean => total === undefined || total <= read;
    return {
      contexts,
      complete: listed(runs.total_count, runs.check_runs?.length ?? 0) && listed(statuses.total_count, statuses.statuses?.length ?? 0),
    };
  }

  /**
   * The named reviewers whose check run or commit status on the head is
   * over, whatever it concluded. One missing from a list GitHub did not give
   * to its end may be past it, so that is refused, never read as not posted.
   */
  override async finishedReviewers(pull: PullRecord, ctx: RuntimeContext): Promise<ReadonlySet<string>> {
    const { contexts, complete } = await this.contexts(pull, ctx);
    const running = new Set(contexts.filter((c) => c.state === "pending").map((c) => c.name));
    const finished = new Set(contexts.filter((c) => this.reviewers.has(c.name) && !running.has(c.name)).map((c) => c.name));
    const unseen = [...this.reviewers].filter((name) => !contexts.some((c) => c.name === name));
    if (!complete && unseen.length > 0) {
      throw new Error(`GitHub listed only part of the checks on ${pull.headSha}, so ${unseen.join(", ")} cannot be read as not posted`);
    }
    return finished;
  }

  protected override async root(): Promise<string> {
    return (await this.git(["rev-parse", "--show-toplevel"])).trim();
  }

  /**
   * A merge commit, guarded by the head the caller read: GitHub answers 409
   * when the head is no longer that, which is `moved` and not an error. A 405
   * is "not mergeable" — which branch protection can answer before it looks
   * at the head, for a push whose required checks have not run, or already
   * merged, which a crash after the merge and before the next read makes
   * ordinary — so the pull request is asked: another head is `moved`.
   */
  async merge(pull: number, headSha: string, ctx: HookContext): Promise<MergeAnswer> {
    const gh = this.gh(ctx);
    const which = `pr-${pull} for #${ctx.item}`;
    try {
      await gh.mergePull(pull, headSha);
      return "merged";
    } catch (e) {
      const status = (e as { status?: unknown } | null)?.status;
      if (status === 409) return "moved";
      if (status === 405) {
        const now = await gh.pull(pull);
        // Unread is not moved: only a head GitHub names, and names as another, is.
        if (typeof now.head?.sha === "string" && now.head.sha !== headSha) return "moved";
        if (now.merged === true) return "merged";
        // GitHub still settling it — mergeability not worked out yet, or the
        // base branch moved under the merge, which it says to try again —
        // clears by asking again on the next tick.
        const said = refusalMessage(e);
        if (now.mergeable === null || /base branch was modified/i.test(said)) throw new Error(`${which} cannot be merged yet: ${said}`);
        // Not mergeable at the head asked for: conflicts, or branch protection. A refusal.
        throw new EffectRefused(`${which} cannot be merged: ${said}`);
      }
      // A refused permission is already a sentence naming it, and still a
      // refusal; anything else is GitHub's own words, said whose merge it was.
      const said = tokenRejected(e)?.message ?? (typeof status === "number" ? `GitHub answered ${status}: ${refusalMessage(e)}` : refusalMessage(e));
      throw isEffectRefused(e) ? new EffectRefused(`${which} could not be merged: ${said}`) : new Error(`${which} could not be merged: ${said}`);
    }
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

  async push(branch: string, item: string, ctx: HookContext): Promise<void> {
    await push(this.git, this.gh(ctx), branch, item, ctx.signal);
  }

  async remoteHead(branch: string, ctx: RuntimeContext): Promise<string | null> {
    return fetchHead(this.git, this.gh(ctx), branch, ctx.signal);
  }

  /**
   * "Pull requests: Read", probed with one minimal query. Its write half has
   * no harmless form to try — opening an item's pull request and closing a
   * dropped child's both need it — so a token without it is named by the
   * write itself. Then "Checks: Read", which only a classic token with the
   * `repo` scope or a GitHub App is granted, and "Commit statuses: Read",
   * because every read of an open pull request asks for its checks: a token
   * without them would fail every read, not one step. Every one missing is
   * named in one sentence.
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

    // The default branch's tip is a commit that always exists. An empty
    // repository has none (404, 422): nothing to read yet, so nothing to refuse.
    // Both are asked whatever the first says, so a token missing both is told
    // so at one start, not at two.
    const ref = await gh.defaultBranch();
    const missing: Array<{ permission: string; said: string }> = [];
    for (const [read, permission] of [
      [() => gh.checkRuns(ref, 1), "Checks: Read"],
      [() => gh.commitStatus(ref), "Commit statuses: Read"],
    ] as const) {
      try {
        await read();
      } catch (e) {
        const status = (e as { status?: unknown } | null)?.status;
        if (status === 404 || status === 422) continue;
        if (tokenRejected(e) !== null || !refusedRead(e)) throw ciReadFailure(e, permission, gh.repo);
        missing.push({ permission, said: e instanceof Error ? e.message : String(e) });
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `token needs ${missing.map((m) => `"${m.permission}"`).join(" and ")} on ${gh.repo} ` +
        `(GitHub answered: ${missing.map((m) => m.said).join("; ")})${grantedHow(missing.map((m) => m.permission))}`,
      );
    }
  }
}
