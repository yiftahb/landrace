import { buildRegistry } from "#hooks/load.js";
import { entriesFromComments } from "#conventions.js";
import { compose } from "#kit/compose.js";
import type { Entry, Git, Registry, RuntimeConfig, RuntimeContext } from "#namespace.js";
import { createClient, GitHubForge, GitHubIssues, GitHubPages } from "landrace/integrations/github";

/**
 * The shipped GitHub integration, over an in-memory GitHub.
 *
 * The fake is the HTTP boundary, not the hooks: `fetch` is what is replaced,
 * and everything above it — the client, the three roles, what `compose` makes
 * of them, and the loader's own classification of that — is the real code an
 * item runs through. A second, hand-written imitation of the hooks would be free to
 * disagree with them, and the place it disagreed would be exactly the place a
 * leak across the boundary stopped being visible.
 */
const REPO = "acme/widgets";
const BOT = "yiftahb";

export interface FakeIssue {
  number: number;
  /** The REST id, distinct from the number: GitHub links a sub-issue by this. */
  id: number;
  title: string;
  body: string;
  state: string;
  html_url: string;
  /** GraphQL's `createdAt`, answered only when a test sets one. */
  createdAt?: string;
  /** When a closed issue closed, and when it last changed. LandraceClosed orders and filters by these. */
  closedAt?: string;
  updatedAt?: string;
  labels: string[];
  /** As GitHub returns them — objects with a login, not bare strings — so the hook's own reading of them is what runs. */
  assignees: Array<{ login: string }>;
  /** Why a closed issue was closed, in GraphQL's spelling. Absent or null on an open one, and on one closed before GitHub had reasons. */
  stateReason?: "COMPLETED" | "NOT_PLANNED" | "DUPLICATE" | "REOPENED" | null;
  /** The same reason in REST's spelling, as a `PATCH /issues/{n}` last sent it. */
  state_reason?: "completed" | "not_planned" | null;
  /** Who opened it. A person, unless the hook created it under the bot's login. */
  author: string;
  /** Who last edited the body, if anyone has since it was opened. */
  editor?: string;
  /** The issue this one is a sub-issue of, by number. */
  parent?: number;
  /** What it is blocked by: an issue in this repository by its number, or one in another. */
  blockedBy?: Array<number | FakeBlocker>;
}

/**
 * A blocker in another repository, as GitHub answers it inside the blocked
 * issue's `blockedBy` connection — the only place the fake knows of it.
 */
export interface FakeBlocker {
  /** "owner/name". */
  repo: string;
  number: number;
  /** "open" or "closed", as `FakeIssue.state`. */
  state: string;
  stateReason?: FakeIssue["stateReason"];
  title?: string;
  /**
   * The token may not see it: GitHub answers the node null, with an error at
   * its place beside an otherwise whole answer. Given a field, only that
   * field is null and the error is at it — what a nullable field's own
   * failure looks like.
   */
  refused?: true | "stateReason";
}

export interface FakeComment {
  id: number;
  body: string;
  created_at: string;
  user: { login: string };
}

/**
 * A pull request and the review threads on it, as the GraphQL half of the API
 * answers for them.
 *
 * `body` on a thread is deliberately modelled and deliberately returned: it is
 * text anyone with comment access can write, and the property worth pinning is
 * that none of it reaches the snapshot. A fake that never had any could not
 * tell the difference.
 */
export interface FakeThread {
  /** GraphQL's node id, which is what resolveReviewThread takes. Absent: one is made up from its place. */
  id?: string;
  isResolved: boolean;
  body: string;
  /** Where the finding sits. Optional: a thread on a file GitHub can no longer place carries neither. */
  path?: string;
  line?: number;
  /** Who opened it. Absent means the bot: Landrace's own reviewer raises most threads. */
  author?: string;
  /** When it was opened. Absent, the fake stamps it the first time it is read, by the clock comments are dated by. */
  createdAt?: string;
  /** The argument under the finding, oldest first. */
  replies?: Array<{ author: string; body: string }>;
}

export interface FakePull {
  number: number;
  title?: string;
  /** The head branch. A PR is found by it, because the reference is derived from the item and never stored. */
  head: string;
  headSha: string;
  merged: boolean;
  /** GraphQL's own state. Absent means whatever `merged` implies: MERGED, else OPEN. */
  state?: "OPEN" | "MERGED" | "CLOSED";
  /** The issues it closes when merged — its closing references, the other way a PR is tied to an item. */
  closes?: number[];
  threads: FakeThread[];
  /** What a `POST /pulls` asked for, as it asked: the branch it goes into, and its description. */
  base?: string;
  body?: string;
  /** From a fork: its head branch is named in somebody else's repository, and may be named anything. */
  crossRepository?: boolean;
  /** GraphQL's `createdAt`, answered only when a test sets one. */
  createdAt?: string;
  /** GraphQL's `updatedAt`. LandraceClosedPulls orders and windows by this, the way LandraceClosed does for issues. */
  updatedAt?: string;
  /** What `GET /pulls/{n}/files` answers: the diff, a file at a time, a renamed one with its old path. */
  files?: Array<{ filename: string; status: string; additions: number; deletions: number; patch?: string; previous_filename?: string }>;
  /** Every review posted on it, as `POST /pulls/{n}/reviews` took them. */
  reviews?: Array<{ body: string; event: string }>;
  /** The head commit's `statusCheckRollup.state`; absent or null is a commit with no rollup at all. */
  checks?: "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED" | null;
  /** What `GET /commits/{sha}/check-runs` answers. `app` is the app's slug, "github-actions" unless said. */
  checkRuns?: Array<{ id: number; name: string; conclusion: string | null; app?: string; output?: { text?: string | null; summary?: string | null } }>;
  /** What `GET /commits/{sha}/status` answers. */
  statuses?: Array<{ context: string; state: string; description?: string | null }>;
  /** What `GET /actions/jobs/{id}/logs` answers, by job id; a job not here is a 404. */
  jobLogs?: Map<number, string>;
  /** Whether `PUT /pulls/{n}/merge` can merge it. Absent means it can; null is GitHub still working it out, which refuses too. */
  mergeable?: boolean | null;
}

/** A published Pages site, as `GET /repos/{owner}/{repo}/pages` describes one. */
export interface FakePages {
  /** The site's root as GitHub reports it: a custom domain's own, and not always with a trailing slash. */
  html_url: string;
  /** Where the site is built from. Defaults to the root of gh-pages, which is where the hook publishes. */
  source?: { branch: string; path: string };
  /** "workflow" for a site an Actions workflow deploys, which serves whatever that workflow uploads. */
  build_type?: "legacy" | "workflow";
}

export interface FakeTracker {
  registry: Registry;
  /** A context the hooks ignore: they were built with explicit options, not read out of config. */
  ctx: RuntimeContext;
  issues: Map<number, FakeIssue>;
  comments: Map<number, FakeComment[]>;
  /** Every request that reached the boundary, so a test can count what an "idempotent" publish actually cost. */
  requests: FakeRequest[];
  /** Every URL the fake was fetched at, a redirect's hops each, with the Authorization header that hop carried. */
  hops: Array<{ url: string; authorization: string | null }>;
  /**
   * Answer matching requests with a failure instead, for the failures a hook has to tell apart from "not there" —
   * with GitHub's own JSON body when one is given, since some failures are told apart by what that says.
   */
  breakOn(match: (request: FakeRequest) => boolean, status?: number, body?: unknown): void;
  /**
   * Answer every GraphQL query the way a failed one actually arrives: HTTP
   * 200, an `errors` array, and a `data` that still parses — partial success
   * is GraphQL's normal shape for a permission or field error, and it is why
   * reading past the errors turns a failure into "no pull request". `type`
   * defaults to "FORBIDDEN", GitHub's own type for a permission refusal;
   * pass "RATE_LIMITED" or "NOT_FOUND" to model the failures that are not one.
   */
  graphqlError(message: string, type?: string): void;
  /**
   * A 200 with no errors and a null repository — GitHub's *other* shape for
   * "this token cannot see it", the one it uses when it will not even confirm
   * a private repository exists. Distinct from `graphqlError`: there is no
   * `errors` array here at all.
   */
  graphqlRepositoryMissing(): void;
  /** What is published on the orphan branch right now, resolved through the git objects the hook wrote. */
  published(branch?: string): Map<string, string>;
  /**
   * Put a file on a branch the way somebody else's push would — blob, tree,
   * commit and ref in the same object store the hook writes to — so a test can
   * start from a page that is already published. Defaults to the Pages branch.
   */
  seedFile(path: string, content: string, branch?: string): void;
  /**
   * Answer every recursive tree listing the way GitHub does past its limit:
   * the first part of the entries, and `truncated: true`. The part kept holds
   * a real page, so a reader that ignored the flag would report a set it knew
   * to be short rather than none.
   */
  truncateTrees(): void;
  /**
   * How `GET /pages` answers: a published site, `null` for a repository with
   * no Pages site at all (a 404 — the default, and what a private repository
   * that never enabled one answers), or a bare status for a failure that says
   * nothing either way, such as a fine-grained token without "Pages: Read".
   */
  pages(answer: FakePages | number | null): void;
  /** The login the fake posts under, so what it writes reads back as ours — the relationship the real client has with its token. */
  bot: string;
  labelsOf(item: number): string[];
  /** Post as the bot, the way an effect would. */
  say(item: number, body: string): FakeComment;
  /** Post as somebody else, the way a person would. */
  sayAs(login: string, item: number, body: string, at?: string): FakeComment;
  entriesOf(item: number): Entry[];
  /** The pull requests that exist, by number. */
  pulls: Map<number, FakePull>;
  /** Open one on a head branch, the way a push and a `gh pr create` would. One with an existing number replaces it. */
  openPull(pull: Partial<FakePull> & { head: string }): FakePull;
  /** Every GraphQL query that reached the boundary, with the variables it carried. */
  graphql: Array<{ query: string; variables: Record<string, unknown> }>;
  /** The boundary itself, so a test can point a second, differently configured client at the same in-memory GitHub. */
  fetchImpl: typeof fetch;
  /** Answer every `blockedBy` connection with at most `to` nodes, its `totalCount` still all of them: a page cut short. */
  cutBlockers(to: number): void;
}

const LOG_HOST = "blob.example";

export interface FakeRequest {
  method: string;
  /** The path within the repository, e.g. "/git/blobs" — or the raw pathname for anything outside it. */
  path: string;
}

/**
 * What GitHub's GraphQL API returns per page of review threads. Hard-coded
 * rather than read off the query, because the page size is the API's, not the
 * caller's: a hook that asked for a thousand at once would simply be refused.
 */
const THREAD_PAGE = 100;

/** And per page of issues and of pull requests, for the same reason. */
const ISSUE_PAGE = 100;

/** And the `first:` the hook asks an item's sub-issues and pull requests for. */
const CONNECTION_PAGE = 50;

/**
 * What GitHub refuses an issue comment over, modelled here because it is the
 * refusal that costs money rather than one that merely fails: a body the API
 * will not take is a write that never lands, so the step's record never lands
 * either, the next tick re-derives the stage as pending, and the step is paid
 * for again. A fake that accepted any size could not tell that story apart
 * from a healthy run.
 */
export const GITHUB_COMMENT_MAX = 65_536;

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

/**
 * The checkout behind the fake GitHub when a test brings none: a repository
 * with no branches, so nothing is ever pushed. A test about pushing hands in
 * `gitIn` over a checkout of its own. The default must never be the hook's
 * own — the repository these tests run from, whose branches and whose origin
 * are real.
 */
export const noBranches: Git = async (args) => {
  if (args[0] === "for-each-ref") return "";
  throw new Error(`the fake GitHub has no checkout to run "git ${args.join(" ")}" in; pass one as opts.git`);
};

/**
 * The shipped integration's three roles over one client, composed as
 * `.landrace/hooks/github.ts` composes them — but with `git` handed in rather
 * than the hook file's own checkout, so nothing here reads or pushes the
 * repository the tests run from.
 */
export function githubHooks({ git = noBranches, ...opts }: Parameters<typeof createClient>[0] & { git?: Git }) {
  const client = createClient(opts);
  return compose({
    tracker: new GitHubIssues({ client }),
    forge: new GitHubForge({ closingRefs: true, client, git }),
    docs: new GitHubPages({ client }),
  });
}

export function createFakeTracker(
  seed: Array<Partial<FakeIssue>> = [],
  opts: {
    /**
     * `x-oauth-scopes` on `/user`, the way a classic PAT carries it. Absent by
     * default, the way a fine-grained token actually behaves — every other
     * test in this file needs that default unchanged.
     */
    scopes?: string[];
    /** git in the operator's checkout, for a test about branches: a real one over a temp repository. */
    git?: Git;
  } = {},
): FakeTracker {
  const issues = new Map<number, FakeIssue>();
  const comments = new Map<number, FakeComment[]>();
  let nextIssue = 1;
  let nextComment = 1000;
  let clock = 0;
  const stamp = (): string => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString();

  /**
   * Monotonic per issue, the way a real tracker's timestamps are: a comment
   * posted now is never dated before one already on the issue. A bare counter
   * is not enough — a test that seeds a human reply dated later than the
   * counter (the natural way to write "and then a person spoke") would have
   * every comment we posted afterwards sort *before* it, so
   * run.lastEvent.actor stayed "human" for the rest of the run and every
   * human-handback trigger kept firing. That is the fake disagreeing with
   * GitHub, not the engine.
   */
  const at = (issue: number): string => {
    const next = stamp();
    const latest = (comments.get(issue) ?? []).reduce((max, c) => (c.created_at > max ? c.created_at : max), "");
    return latest >= next ? new Date(Date.parse(latest) + 1000).toISOString() : next;
  };

  for (const s of seed) {
    const n = s.number ?? nextIssue++;
    issues.set(n, {
      number: n,
      id: s.id ?? n + 100_000,
      author: s.author ?? "a-person",
      title: s.title ?? `issue ${n}`,
      body: s.body ?? "",
      state: s.state ?? "open",
      html_url: `https://github.com/${REPO}/issues/${n}`,
      labels: s.labels ?? [],
      assignees: s.assignees ?? [],
      ...(s.stateReason === undefined ? {} : { stateReason: s.stateReason }),
      ...(s.createdAt === undefined ? {} : { createdAt: s.createdAt }),
      ...(s.closedAt === undefined ? {} : { closedAt: s.closedAt }),
      ...(s.updatedAt === undefined ? {} : { updatedAt: s.updatedAt }),
      ...(s.parent === undefined ? {} : { parent: s.parent }),
      ...(s.editor === undefined ? {} : { editor: s.editor }),
      ...(s.blockedBy === undefined ? {} : { blockedBy: s.blockedBy }),
    });
    nextIssue = Math.max(nextIssue, n + 1);
  }

  const post = (item: number, login: string, body: string, when?: string): FakeComment => {
    const comment: FakeComment = { id: nextComment++, body, created_at: when ?? at(item), user: { login } };
    comments.set(item, [...(comments.get(item) ?? []), comment]);
    return comment;
  };

  /**
   * The git object store behind the orphan branch: real blobs, trees, commits
   * and refs, so the hook's blob → tree → commit → ref walk is exercised
   * rather than imitated by a path-to-string map. Trees hold whole paths, the
   * way the API's own tree entries do.
   */
  const blobs = new Map<string, string>();
  const trees = new Map<string, Map<string, string>>();
  const commits = new Map<string, { tree: string; parents: string[] }>();
  const refs = new Map<string, string>();
  let objects = 0;
  const objectSha = (): string => (++objects).toString(16).padStart(40, "0");

  const treeOfRef = (branch: string): Map<string, string> => {
    const head = refs.get(branch);
    const commit = head === undefined ? undefined : commits.get(head);
    return (commit && trees.get(commit.tree)) ?? new Map<string, string>();
  };

  const seedFile = (path: string, content: string, branch = "gh-pages"): void => {
    const blob = objectSha();
    blobs.set(blob, content);
    const tree = objectSha();
    trees.set(tree, new Map([...treeOfRef(branch), [path, blob]]));
    const head = refs.get(branch);
    const commit = objectSha();
    commits.set(commit, { tree, parents: head === undefined ? [] : [head] });
    refs.set(branch, commit);
  };

  let treesTruncated = false;

  /**
   * A tree as `GET /git/trees/{ref}?recursive=1` lists it: every directory on
   * the way down as a `tree` entry, every file as a `blob`, in path order.
   * Without `recursive`, the top level only.
   */
  const treeListing = (files: Map<string, string>, recursive: boolean) => {
    const entries = new Map<string, { path: string; mode: string; type: string; sha: string }>();
    for (const [file, sha] of files) {
      const parts = file.split("/");
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join("/");
        if (!entries.has(dir)) entries.set(dir, { path: dir, mode: "040000", type: "tree", sha: `tree-${dir}` });
      }
      entries.set(file, { path: file, mode: "100644", type: "blob", sha });
    }
    const all = [...entries.values()]
      .filter((e) => recursive || !e.path.includes("/"))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return treesTruncated && recursive
      ? { tree: all.slice(0, Math.ceil(all.length / 2)), truncated: true }
      : { tree: all, truncated: false };
  };

  const pulls = new Map<number, FakePull>();
  let nextPull = 100;

  const requests: FakeRequest[] = [];
  const hops: Array<{ url: string; authorization: string | null }> = [];
  const graphql: Array<{ query: string; variables: Record<string, unknown> }> = [];
  let broken: { match: (r: FakeRequest) => boolean; status: number; body?: unknown } | null = null;
  let graphqlFailure: { message: string; type: string } | null = null;
  let repositoryMissing = false;
  let pagesSite: FakePages | number | null = null;
  let blockersCut: number | null = null;

  /**
   * One page of review threads, as a connection.
   *
   * The cursor is the index of the next thread, stringified — GitHub's is
   * opaque and base64, and a caller that parsed one would be relying on
   * something it was promised nothing about, so the shape (opaque string in,
   * opaque string out) is what matters here rather than the encoding.
   */
  const threadPage = (pull: FakePull, cursor: unknown) => {
    const from = typeof cursor === "string" && cursor ? Number(cursor) : 0;
    const page = pull.threads.slice(from, from + THREAD_PAGE);
    const end = from + page.length;
    return {
      pageInfo: { hasNextPage: end < pull.threads.length, endCursor: String(end) },
      // `body` rides along on every node: a server returns what it returns,
      // and "no thread text reaches the snapshot" has to be a property of the
      // hook rather than of what the fake happened to omit.
      // Every field the one thread query asks of a node: the count reads
      // `isResolved` and the last word, the briefing and the history the rest.
      nodes: page.map((t, i) => {
        t.createdAt ??= stamp();
        const opening = { body: t.body, createdAt: t.createdAt, author: { login: t.author ?? BOT } };
        const said = [opening, ...(t.replies ?? []).map((r) => ({ body: r.body, author: { login: r.author } }))];
        return {
          id: t.id ?? `thread-${pull.number}-${from + i}`,
          isResolved: t.isResolved,
          body: t.body,
          path: t.path ?? null,
          line: t.line ?? null,
          comments: { totalCount: said.length, nodes: [opening] },
          lastReply: { nodes: said.slice(-1) },
        };
      }),
    };
  };

  /** An issue as GraphQL's `Issue` answers the fields the hook asks for. */
  const issueNode = (i: FakeIssue) => ({
    number: i.number,
    title: i.title,
    body: i.body,
    author: { login: i.author },
    editor: i.editor === undefined ? null : { login: i.editor },
    url: i.html_url,
    state: i.state.toUpperCase(),
    stateReason: i.stateReason ?? null,
    ...(i.createdAt === undefined ? {} : { createdAt: i.createdAt }),
    ...(i.updatedAt === undefined ? {} : { updatedAt: i.updatedAt }),
    labels: { nodes: i.labels.map((name) => ({ name })) },
    assignees: { nodes: i.assignees },
  });

  type GraphQLError = { message: string; type: string; path: Array<string | number> };
  const [OWNER, NAME] = REPO.split("/") as [string, string];

  /**
   * An issue's `blockedBy` connection as GitHub answers it at `path`, when
   * the query asked for one: the first page it asked for, and how many there
   * are in all. A blocker the token is refused is a null — or a null field —
   * with an error at its place pushed onto `errors`, beside an answer
   * otherwise whole.
   */
  const blockedByAt = (i: FakeIssue, query: string, path: Array<string | number>, errors: GraphQLError[]) => {
    const first = /blockedBy\(first: (\d+)\)/.exec(query)?.[1];
    if (first === undefined) return {};
    const asked = Number(first);
    const all = i.blockedBy ?? [];
    const nodes = all.slice(0, Math.min(asked, blockersCut ?? asked)).map((b, j) => {
      if (typeof b === "number") {
        const own = issues.get(b);
        return own === undefined ? null : {
          number: own.number, title: own.title, url: own.html_url, state: own.state.toUpperCase(),
          stateReason: own.stateReason ?? null, repository: { name: NAME, owner: { login: OWNER } },
        };
      }
      const [owner = "", name = ""] = b.repo.split("/");
      const node = {
        number: b.number, title: b.title ?? `issue ${b.number}`, url: `https://github.com/${b.repo}/issues/${b.number}`,
        state: b.state.toUpperCase(), stateReason: b.stateReason ?? null, repository: { name, owner: { login: owner } },
      };
      if (b.refused === undefined) return node;
      const message = "Resource not accessible by personal access token";
      if (b.refused === true) {
        errors.push({ message, type: "FORBIDDEN", path: [...path, "blockedBy", "nodes", j] });
        return null;
      }
      errors.push({ message, type: "FORBIDDEN", path: [...path, "blockedBy", "nodes", j, b.refused] });
      return { ...node, [b.refused]: null };
    });
    return { blockedBy: { totalCount: all.length, nodes } };
  };

  /** A connection as GraphQL pages one: the first page of nodes, and how many there are in all. */
  const connection = <T>(all: T[]) => ({ totalCount: all.length, nodes: all.slice(0, CONNECTION_PAGE) });

  /** One page of an item's pull requests, from the cursor a previous page ended at. */
  const itemPullPage = <T>(all: T[], cursor: unknown) => {
    const from = typeof cursor === "string" && cursor ? Number(cursor) : 0;
    const nodes = all.slice(from, from + CONNECTION_PAGE);
    const end = from + nodes.length;
    return { totalCount: all.length, pageInfo: { hasNextPage: end < all.length, endCursor: String(end) }, nodes };
  };

  const childrenOf = (n: number): FakeIssue[] =>
    [...issues.values()].filter((i) => i.parent === n).sort((a, b) => a.number - b.number);

  const pullState = (p: FakePull): "OPEN" | "MERGED" | "CLOSED" => p.state ?? (p.merged ? "MERGED" : "OPEN");

  /** A pull request as GraphQL's `PullRequest` answers the fields the hook asks for. */
  const pullNode = (p: FakePull) => ({
    number: p.number,
    title: p.title ?? `pull request ${p.number}`,
    url: `https://github.com/${REPO}/pull/${p.number}`,
    state: pullState(p),
    merged: p.merged,
    headRefName: p.head,
    headRefOid: p.headSha,
    isCrossRepository: p.crossRepository ?? false,
    ...(p.createdAt === undefined ? {} : { createdAt: p.createdAt }),
    ...(p.updatedAt === undefined ? {} : { updatedAt: p.updatedAt }),
    closingIssuesReferences: { nodes: (p.closes ?? []).map((number) => ({ number })) },
  });

  /** Only the endpoints the hooks actually call, answering the way GitHub does. */
  const serve = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>);

    if (url.host === LOG_HOST) {
      const log = [...pulls.values()].map((p) => p.jobLogs?.get(Number(/^\/log\/(\d+)$/.exec(url.pathname)?.[1]))).find((l) => l !== undefined);
      return log === undefined ? new Response("gone", { status: 404 }) : new Response(log, { status: 200, headers: { "Content-Type": "text/plain" } });
    }

    const prefix = `/repos/${REPO}`;
    const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
    requests.push({ method, path });
    if (broken && broken.match({ method, path })) {
      return broken.body === undefined
        ? new Response(`the repository is unhappy about ${path}`, { status: broken.status })
        : json(broken.body, broken.status);
    }

    if (url.pathname === "/user") {
      return opts.scopes === undefined
        ? json({ login: BOT })
        : new Response(JSON.stringify({ login: BOT }), {
            status: 200,
            headers: { "Content-Type": "application/json", "x-oauth-scopes": opts.scopes.join(", ") },
          });
    }

    if (url.pathname === "/graphql" && method === "POST") {
      const variables = (body.variables ?? {}) as Record<string, unknown>;
      graphql.push({ query: String(body.query ?? ""), variables });

      if (repositoryMissing) return json({ data: { repository: null } });

      if (graphqlFailure !== null) {
        return json({
          data: { repository: { pullRequests: { nodes: [] } } },
          errors: [{ message: graphqlFailure.message, type: graphqlFailure.type }],
        });
      }

      // A mutation names a node, not a repository, so it is answered before the repository check below.
      const mutation = /mutation (\w+)/.exec(String(body.query ?? ""))?.[1];
      if (mutation === "LandraceResolve") {
        for (const p of pulls.values()) {
          const thread = p.threads.find((t, i) => (t.id ?? `thread-${p.number}-${i}`) === variables.id);
          if (thread) {
            thread.isResolved = true;
            return json({ data: { resolveReviewThread: { thread: { id: variables.id, isResolved: true } } } });
          }
        }
        return json({ data: null, errors: [{ message: `Could not resolve to a node with the global id of '${String(variables.id)}'` }] });
      }
      if (mutation === "LandraceReply") {
        for (const p of pulls.values()) {
          const thread = p.threads.find((t, i) => (t.id ?? `thread-${p.number}-${i}`) === variables.id);
          if (thread) {
            thread.replies = [...(thread.replies ?? []), { author: BOT, body: String(variables.body ?? "") }];
            return json({ data: { addPullRequestReviewThreadReply: { comment: { id: `reply-${thread.replies.length}` } } } });
          }
        }
        return json({ data: null, errors: [{ message: `Could not resolve to a node with the global id of '${String(variables.id)}'` }] });
      }

      // A repository the token cannot see answers with a null repository and
      // no error at all, which is a different failure from "no pull request".
      if (variables.owner !== REPO.split("/")[0] || variables.name !== REPO.split("/")[1]) {
        return json({ data: { repository: null } });
      }

      // Answered by the operation's name, the way a server reads the query
      // rather than guessing from its variables: the hook asks five different
      // questions, and two of them take the same variables.
      const operation = /(?:query|mutation) (\w+)/.exec(String(body.query ?? ""))?.[1];
      const pullOf = (n: unknown): FakePull | null => pulls.get(Number(n)) ?? null;

      const query = String(body.query ?? "");
      const errors: GraphQLError[] = [];
      const answer = (data: unknown): Response => json({ data, ...(errors.length > 0 ? { errors } : {}) });

      if (operation === "LandraceIssues") {
        const open = [...issues.values()].filter((i) => i.state === "open").sort((a, b) => a.number - b.number);
        const from = typeof variables.cursor === "string" && variables.cursor ? Number(variables.cursor) : 0;
        const page = open.slice(from, from + ISSUE_PAGE);
        const end = from + page.length;
        return answer({
          repository: {
            nameWithOwner: REPO,
            issues: {
              pageInfo: { hasNextPage: end < open.length, endCursor: String(end) },
              nodes: page.map((i, n) => ({
                ...issueNode(i),
                ...blockedByAt(i, query, ["repository", "issues", "nodes", n], errors),
                parent: i.parent === undefined ? null : { number: i.parent },
                subIssues: { nodes: childrenOf(i.number).map(issueNode) },
              })),
            },
          },
        });
      }

      // Every open issue's blockers and nothing else, paged as LandraceIssues pages the full reading.
      if (operation === "LandraceOpenBlockers") {
        const open = [...issues.values()].filter((i) => i.state === "open").sort((a, b) => a.number - b.number);
        const from = typeof variables.cursor === "string" && variables.cursor ? Number(variables.cursor) : 0;
        const page = open.slice(from, from + ISSUE_PAGE);
        const end = from + page.length;
        return answer({
          repository: {
            nameWithOwner: REPO,
            issues: {
              pageInfo: { hasNextPage: end < open.length, endCursor: String(end) },
              nodes: page.map((i, n) => ({ number: i.number, ...blockedByAt(i, query, ["repository", "issues", "nodes", n], errors) })),
            },
          },
        });
      }

      // Closed issues, most recently updated first, as `orderBy: UPDATED_AT DESC` pages them.
      if (operation === "LandraceClosed") {
        const closed = [...issues.values()].filter((i) => i.state === "closed")
          .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.number - b.number);
        const from = typeof variables.cursor === "string" && variables.cursor ? Number(variables.cursor) : 0;
        const size = Number(/issues\(states: CLOSED, first: (\d+)/.exec(String(body.query))?.[1] ?? ISSUE_PAGE);
        const page = closed.slice(from, from + size);
        const end = from + page.length;
        return answer({
          repository: {
            nameWithOwner: REPO,
            issues: {
              pageInfo: { hasNextPage: end < closed.length, endCursor: String(end) },
              nodes: page.map((i, n) => ({
                ...issueNode(i), closedAt: i.closedAt ?? null, updatedAt: i.updatedAt ?? null,
                ...blockedByAt(i, query, ["repository", "issues", "nodes", n], errors),
                parent: i.parent === undefined ? null : { number: i.parent },
              })),
            },
          },
        });
      }

      if (operation === "LandracePulls") {
        const open = [...pulls.values()].filter((p) => pullState(p) === "OPEN").sort((a, b) => b.number - a.number);
        const from = typeof variables.cursor === "string" && variables.cursor ? Number(variables.cursor) : 0;
        const page = open.slice(from, from + ISSUE_PAGE);
        const end = from + page.length;
        return json({
          data: {
            repository: {
              pullRequests: { pageInfo: { hasNextPage: end < open.length, endCursor: String(end) }, nodes: page.map(pullNode) },
            },
          },
        });
      }

      // Merged and closed pull requests, most recently updated first, paged
      // and windowed the same way LandraceClosed pages closed issues.
      if (operation === "LandraceClosedPulls") {
        const closed = [...pulls.values()].filter((p) => pullState(p) !== "OPEN")
          .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.number - b.number);
        const from = typeof variables.cursor === "string" && variables.cursor ? Number(variables.cursor) : 0;
        const size = Number(/pullRequests\(states: \[MERGED, CLOSED\], first: (\d+)/.exec(String(body.query))?.[1] ?? ISSUE_PAGE);
        const page = closed.slice(from, from + size);
        const end = from + page.length;
        return json({
          data: {
            repository: {
              pullRequests: {
                pageInfo: { hasNextPage: end < closed.length, endCursor: String(end) },
                nodes: page.map((p) => ({ ...pullNode(p), updatedAt: p.updatedAt ?? null })),
              },
            },
          },
        });
      }

      if (operation === "LandraceItem") {
        const issue = issues.get(Number(variables.number));
        const parent = issue?.parent === undefined ? undefined : issues.get(issue.parent);
        return json({
          data: {
            repository: {
              issue: issue === undefined ? null : {
                ...issueNode(issue),
                parent: parent === undefined ? null : issueNode(parent),
                subIssues: connection(childrenOf(issue.number).map(issueNode)),
                closedByPullRequestsReferences: connection(
                  [...pulls.values()].filter((p) => (p.closes ?? []).includes(issue.number)).map(pullNode),
                ),
              },
              // Newest first, the way `orderBy: { field: CREATED_AT, direction: DESC }`
              // orders them, a page at a time on its own cursor, and forks' among
              // them: GitHub cannot be asked for one repository's heads alone.
              pullRequests: itemPullPage(
                [...pulls.values()].filter((p) => p.head === variables.head).sort((a, b) => b.number - a.number).map(pullNode),
                variables.cursor,
              ),
            },
          },
        });
      }

      if (operation === "LandraceIssue") {
        const issue = issues.get(Number(variables.number));
        return answer({
          repository: {
            nameWithOwner: REPO,
            issue: issue === undefined ? null : {
              ...issueNode(issue),
              ...blockedByAt(issue, query, ["repository", "issue"], errors),
              parent: issue.parent === undefined ? null : { number: issue.parent },
            },
          },
        });
      }

      if (operation === "LandraceSubIssues") {
        const issue = issues.get(Number(variables.number));
        return answer({
          repository: {
            issue: issue === undefined ? null : {
              subIssues: connection(childrenOf(issue.number).map((c, n) => ({
                ...issueNode(c),
                ...blockedByAt(c, query, ["repository", "issue", "subIssues", "nodes", n], errors),
              }))),
            },
          },
        });
      }

      if (operation === "LandraceThreads") {
        const pull = pullOf(variables.number);
        return json({
          data: {
            repository: {
              pullRequest: pull === null ? null : { number: pull.number, reviewThreads: threadPage(pull, variables.cursor) },
            },
          },
        });
      }

      if (operation === "LandraceChecks") {
        const pull = [...pulls.values()].find((p) => p.headSha === variables.oid);
        return json({
          data: {
            repository: {
              object: pull === undefined ? null : { statusCheckRollup: pull.checks ? { state: pull.checks } : null },
            },
          },
        });
      }

      // Anything else is the preflight's probe, which asks only that the
      // repository answers at all.
      return json({ data: { repository: { pullRequests: { totalCount: pulls.size } } } });
    }

    if (path === "/pages" && method === "GET") {
      if (pagesSite === null) return json({ message: "Not Found" }, 404);
      if (typeof pagesSite === "number") return json({ message: `the Pages endpoint answered ${pagesSite}` }, pagesSite);
      return json({
        url: `https://api.github.com/repos/${REPO}/pages`,
        status: "built",
        cname: null,
        html_url: pagesSite.html_url,
        build_type: pagesSite.build_type ?? "legacy",
        source: pagesSite.source ?? { branch: "gh-pages", path: "/" },
        public: false,
        https_enforced: true,
      });
    }

    const issueOf = (n: number): FakeIssue | null => issues.get(n) ?? null;

    if (path === "/issues" && method === "GET") {
      const wanted = (url.searchParams.get("labels") ?? "").split(",").filter(Boolean);
      const state = url.searchParams.get("state") ?? "open";
      return json([...issues.values()].filter(
        (i) => i.state === state && wanted.every((l) => i.labels.includes(l)),
      ));
    }

    if (path === "/issues" && method === "POST") {
      const issue: FakeIssue = {
        number: nextIssue,
        id: nextIssue + 100_000,
        // Whoever the token is: the hook creates issues as the bot.
        author: BOT,
        title: String(body.title ?? ""),
        body: String(body.body ?? ""),
        state: "open",
        html_url: `https://github.com/${REPO}/issues/${nextIssue}`,
        labels: (body.labels as string[] | undefined) ?? [],
        assignees: ((body.assignees as string[] | undefined) ?? []).map((login) => ({ login })),
      };
      issues.set(nextIssue++, issue);
      return json(issue);
    }

    const single = /^\/issues\/(\d+)$/.exec(path);
    if (single) {
      const issue = issueOf(Number(single[1]));
      if (!issue) return new Response("Not Found", { status: 404 });
      if (method === "PATCH") {
        Object.assign(issue, body);
        // One issue, two spellings of why it closed: REST's lower-case one
        // is what a PATCH carries, GraphQL's upper-case one is what reads it.
        if ("state_reason" in body) {
          const reason = body.state_reason;
          issue.stateReason = typeof reason === "string" ? (reason.toUpperCase() as NonNullable<FakeIssue["stateReason"]>) : null;
        }
      }
      return json(issue);
    }

    const onSubIssues = /^\/issues\/(\d+)\/sub_issues$/.exec(path);
    if (onSubIssues && method === "POST") {
      const parent = issueOf(Number(onSubIssues[1]));
      const child = [...issues.values()].find((i) => i.id === body.sub_issue_id);
      if (!parent || !child) return new Response("Not Found", { status: 404 });
      child.parent = parent.number;
      return json(parent, 201);
    }

    // A dependency names its blocker by the REST id, as a sub-issue link does — never by its number.
    const onBlockedBy = /^\/issues\/(\d+)\/dependencies\/blocked_by(?:\/(\d+))?$/.exec(path);
    if (onBlockedBy) {
      const issue = issueOf(Number(onBlockedBy[1]));
      const blockerId = method === "DELETE" ? Number(onBlockedBy[2]) : body.issue_id;
      const blocker = [...issues.values()].find((i) => i.id === blockerId);
      if (!issue || !blocker) return json({ message: "Not Found" }, 404);
      if (method === "POST" && onBlockedBy[2] === undefined) {
        // GitHub refuses a dependency it already holds, rather than taking it twice.
        if ((issue.blockedBy ?? []).includes(blocker.number)) {
          return json({
            message: "Validation Failed",
            errors: [{ resource: "IssueDependency", code: "already_exists", field: "issue_id", message: "has already been taken" }],
          }, 422);
        }
        issue.blockedBy = [...(issue.blockedBy ?? []), blocker.number];
        return json(blocker, 201);
      }
      if (method === "DELETE" && onBlockedBy[2] !== undefined) {
        if (!(issue.blockedBy ?? []).includes(blocker.number)) return json({ message: "Not Found" }, 404);
        issue.blockedBy = (issue.blockedBy ?? []).filter((b) => b !== blocker.number);
        return json(blocker);
      }
    }

    // The repository itself, for the one thing asked of it: which branch a
    // pull request is proposed into.
    if (path === "" && method === "GET") return json({ full_name: REPO, default_branch: "main" });

    // GitHub refuses a second open pull request from one head, and says so in
    // these words — which the hook reads as the first one having landed.
    if (path === "/pulls" && method === "POST") {
      const head = String(body.head ?? "");
      if ([...pulls.values()].some((p) => p.head === head && pullState(p) === "OPEN")) {
        return json({
          message: "Validation Failed",
          errors: [{ resource: "PullRequest", code: "custom", message: `A pull request already exists for acme:${head}.` }],
        }, 422);
      }
      const number = nextPull++;
      const text = String(body.body ?? "");
      const closes = [...text.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?) #(\d+)/gi)].map((m) => Number(m[1]));
      pulls.set(number, {
        number, head, headSha: `sha-${number}`, merged: false, threads: [],
        title: String(body.title ?? ""), base: String(body.base ?? ""), body: text,
        ...(closes.length ? { closes } : {}),
      });
      return json({ number, state: "open", head: { ref: head } }, 201);
    }

    // A review, as GitHub takes one: its body, and a thread per line comment,
    // each landing as an open review thread the graph then counts.
    const onReviews = /^\/pulls\/(\d+)\/reviews$/.exec(path);
    if (onReviews) {
      const pull = pulls.get(Number(onReviews[1]));
      if (!pull) return new Response("Not Found", { status: 404 });
      if (method === "GET") return json((pull.reviews ?? []).map((r, i) => ({ id: i + 1, body: r.body, state: "COMMENTED" })));
      pull.reviews = [...(pull.reviews ?? []), { body: String(body.body ?? ""), event: String(body.event ?? "") }];
      for (const c of (body.comments as Array<{ path: string; line: number; body: string }> | undefined) ?? []) {
        pull.threads.push({ id: `thread-${pull.number}-${pull.threads.length}`, isResolved: false, body: c.body, path: c.path, line: c.line });
      }
      return json({ id: pull.reviews.length });
    }

    // A comment on a whole file, which opens a thread with no line.
    const onReviewComments = /^\/pulls\/(\d+)\/comments$/.exec(path);
    if (onReviewComments && method === "POST") {
      const pull = pulls.get(Number(onReviewComments[1]));
      if (!pull) return new Response("Not Found", { status: 404 });
      pull.threads.push({ id: `thread-${pull.number}-${pull.threads.length}`, isResolved: false, body: String(body.body ?? ""), path: String(body.path ?? "") });
      return json({ id: pull.threads.length }, 201);
    }

    const onFiles = /^\/pulls\/(\d+)\/files$/.exec(path);
    if (onFiles && method === "GET") {
      const pull = pulls.get(Number(onFiles[1]));
      if (!pull) return new Response("Not Found", { status: 404 });
      // GitHub's paging, and its cap: it lists at most 3,000 of a pull request's files.
      const perPage = Number(url.searchParams.get("per_page") ?? "30");
      const page = Number(url.searchParams.get("page") ?? "1");
      return json((pull.files ?? []).slice(0, 3_000).slice((page - 1) * perPage, page * perPage));
    }

    const onPull = /^\/pulls\/(\d+)$/.exec(path);
    if (onPull && method === "PATCH") {
      const pull = pulls.get(Number(onPull[1]));
      if (!pull) return new Response("Not Found", { status: 404 });
      // A merged pull request is closed already and stays merged.
      if (pull.merged) return json({ message: "Validation Failed" }, 422);
      if (body.state === "closed") pull.state = "CLOSED";
      return json({ number: pull.number, state: body.state });
    }

    const onComments = /^\/issues\/(\d+)\/comments$/.exec(path);
    if (onComments) {
      const n = Number(onComments[1]);
      if (!issueOf(n)) return new Response("Not Found", { status: 404 });
      if (method === "POST") {
        const text = String(body.body ?? "");
        if (text.length > GITHUB_COMMENT_MAX) {
          return json(
            { message: "Validation Failed", errors: [{ resource: "IssueComment", field: "body", code: "too_long" }] },
            422,
          );
        }
        return json(post(n, BOT, text));
      }
      // Paged the way GitHub pages them: thirty unless asked for more, a hundred at most.
      const per = Math.min(Number(url.searchParams.get("per_page") ?? "30"), 100);
      const page = Number(url.searchParams.get("page") ?? "1");
      return json((comments.get(n) ?? []).slice((page - 1) * per, page * per));
    }

    const onLabels = /^\/issues\/(\d+)\/labels$/.exec(path);
    if (onLabels && method === "POST") {
      const issue = issueOf(Number(onLabels[1]));
      if (!issue) return new Response("Not Found", { status: 404 });
      issue.labels = [...new Set([...issue.labels, ...((body.labels as string[] | undefined) ?? [])])];
      return json(issue.labels);
    }

    const oneLabel = /^\/issues\/(\d+)\/labels\/(.+)$/.exec(path);
    if (oneLabel && method === "DELETE") {
      const issue = issueOf(Number(oneLabel[1]));
      if (!issue) return new Response("Not Found", { status: 404 });
      const name = decodeURIComponent(oneLabel[2] as string);
      if (!issue.labels.includes(name)) return new Response("Not Found", { status: 404 });
      issue.labels = issue.labels.filter((l) => l !== name);
      return json(issue.labels);
    }

    const onContents = /^\/contents\/(.+)$/.exec(path);
    if (onContents && method === "GET") {
      const wanted = decodeURI(onContents[1] as string);
      const blob = treeOfRef(url.searchParams.get("ref") ?? "").get(wanted);
      const content = blob === undefined ? undefined : blobs.get(blob);
      if (content === undefined) return new Response("Not Found", { status: 404 });
      return json({ sha: blob, encoding: "base64", content: Buffer.from(content, "utf8").toString("base64") });
    }

    const onRef = /^\/git\/ref\/heads\/(.+)$/.exec(path);
    if (onRef && method === "GET") {
      const sha = refs.get(decodeURIComponent(onRef[1] as string));
      if (sha === undefined) return new Response("Not Found", { status: 404 });
      return json({ ref: `refs/heads/${onRef[1]}`, object: { sha, type: "commit" } });
    }

    // A branch name or a tree sha, as GitHub takes either; a branch that is
    // not there is a 404, which is how the Pages branch reads before anything
    // has been published.
    const onTree = /^\/git\/trees\/([^/]+)$/.exec(path);
    if (onTree && method === "GET") {
      const name = decodeURIComponent(onTree[1] as string);
      const head = refs.get(name);
      const files = trees.get(head === undefined ? name : (commits.get(head)?.tree ?? ""));
      if (!files) return json({ message: "Not Found" }, 404);
      return json({ sha: head ?? name, ...treeListing(files, url.searchParams.has("recursive")) });
    }

    const onCommit = /^\/git\/commits\/([0-9a-f]+)$/.exec(path);
    if (onCommit && method === "GET") {
      const commit = commits.get(onCommit[1] as string);
      if (!commit) return new Response("Not Found", { status: 404 });
      return json({ sha: onCommit[1], tree: { sha: commit.tree }, parents: commit.parents.map((sha) => ({ sha })) });
    }

    if (path === "/git/blobs" && method === "POST") {
      const sha = objectSha();
      blobs.set(sha, Buffer.from(String(body.content ?? ""), String(body.encoding) === "base64" ? "base64" : "utf8").toString("utf8"));
      return json({ sha }, 201);
    }

    if (path === "/git/trees" && method === "POST") {
      const base = body.base_tree === undefined ? new Map<string, string>() : trees.get(String(body.base_tree));
      if (!base) return new Response("Unprocessable Entity", { status: 422 });
      const next = new Map(base);
      for (const entry of (body.tree as Array<{ path: string; sha: string }> | undefined) ?? []) {
        next.set(entry.path, entry.sha);
      }
      const sha = objectSha();
      trees.set(sha, next);
      return json({ sha }, 201);
    }

    if (path === "/git/commits" && method === "POST") {
      if (!trees.has(String(body.tree))) return new Response("Unprocessable Entity", { status: 422 });
      const sha = objectSha();
      commits.set(sha, { tree: String(body.tree), parents: ((body.parents as string[] | undefined) ?? []) });
      return json({ sha }, 201);
    }

    if (path === "/git/refs" && method === "POST") {
      const ref = String(body.ref ?? "").replace(/^refs\/heads\//, "");
      // GitHub refuses a ref that already exists rather than moving it, which
      // is what makes "create, else update" two different calls in the hook.
      if (!ref || refs.has(ref)) return new Response("Reference already exists", { status: 422 });
      refs.set(ref, String(body.sha ?? ""));
      return json({ ref: body.ref, object: { sha: body.sha } }, 201);
    }

    const updateRef = /^\/git\/refs\/heads\/(.+)$/.exec(path);
    if (updateRef && method === "PATCH") {
      const ref = decodeURIComponent(updateRef[1] as string);
      if (!refs.has(ref)) return new Response("Not Found", { status: 404 });
      refs.set(ref, String(body.sha ?? ""));
      return json({ ref: `refs/heads/${ref}`, object: { sha: body.sha } });
    }

    const onChecks = /^\/commits\/([^/]+)\/(check-runs|status)$/.exec(path);
    if (onChecks && method === "GET") {
      const pull = [...pulls.values()].find((p) => p.headSha === onChecks[1]);
      if (onChecks[2] === "status") return json({ state: "failure", statuses: pull?.statuses ?? [] });
      const runs = (pull?.checkRuns ?? []).map((r) => ({
        id: r.id, name: r.name, status: "completed", conclusion: r.conclusion,
        app: { slug: r.app ?? "github-actions" }, output: { text: r.output?.text ?? null, summary: r.output?.summary ?? null },
      }));
      return json({ total_count: runs.length, check_runs: runs });
    }

    const onJobLog = /^\/actions\/jobs\/(\d+)\/logs$/.exec(path);
    if (onJobLog && method === "GET") {
      // GitHub answers with a redirect to where the text lives, on another origin.
      for (const p of pulls.values()) {
        if (p.jobLogs?.has(Number(onJobLog[1]))) {
          return new Response(null, { status: 302, headers: { Location: `https://${LOG_HOST}/log/${onJobLog[1]}` } });
        }
      }
      return json({ message: "Not Found" }, 404);
    }

    const onPullRead = /^\/pulls\/(\d+)(\/merge)?$/.exec(path);
    if (onPullRead && onPullRead[2] === undefined && method === "GET") {
      const pull = pulls.get(Number(onPullRead[1])) ?? null;
      return pull === null
        ? json({ message: "Not Found" }, 404)
        : json({
          number: pull.number, state: pullState(pull).toLowerCase(), merged: pull.merged, head: { ref: pull.head, sha: pull.headSha },
          mergeable: pull.mergeable === undefined ? true : pull.mergeable,
        });
    }
    if (onPullRead && onPullRead[2] !== undefined && method === "PUT") {
      const pull = pulls.get(Number(onPullRead[1])) ?? null;
      if (pull === null) return json({ message: "Not Found" }, 404);
      // Mergeability before the head, as branch protection's required checks
      // can answer: a push whose checks have not run is "not mergeable" first.
      if (pull.merged || pull.mergeable === false || pull.mergeable === null) return json({ message: "Pull Request is not mergeable" }, 405);
      if (body.sha !== pull.headSha) return json({ message: "Head branch was modified. Review and try the merge again." }, 409);
      pull.merged = true;
      return json({ sha: "merge-sha", merged: true, message: "Pull Request successfully merged" });
    }

    return new Response(`no route for ${method} ${url.pathname}`, { status: 404 });
  };

  /**
   * Follows a redirect the way a browser's fetch does, so a test can see what
   * the client's own request headers do on the next hop: Authorization is
   * dropped when the origin changes. Done here and not left to Node, so the
   * strip is the fake's own and an assertion on it means something.
   */
  const fetchImpl = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    let url = new URL(String(input));
    let headers = { ...((init?.headers ?? {}) as Record<string, string>) };
    for (let hop = 0; hop < 5; hop++) {
      hops.push({ url: url.href, authorization: headers.Authorization ?? null });
      const res = await serve(url, { ...init, headers });
      const location = res.headers.get("location");
      if (res.status < 300 || res.status >= 400 || location === null || init?.redirect === "manual") return res;
      const next = new URL(location, url);
      if (next.origin !== url.origin) delete headers.Authorization;
      url = next;
      headers = { ...headers };
    }
    throw new Error("too many redirects");
  }) as unknown as typeof fetch;

  const hooks = githubHooks({ repo: REPO, token: "test-token", fetchImpl, git: opts.git ?? noBranches });

  return {
    // Through the real loader, so the brands and the ambiguity rules are
    // exercised on the way in rather than assumed.
    registry: buildRegistry([{ specifier: "hooks/github.ts", exports: hooks as unknown as Record<string, unknown> }]),
    ctx: {
      config: {} as RuntimeConfig,
      secrets: new Map<string, string>(),
      signal: new AbortController().signal,
      log: () => {},
    },
    issues,
    comments,
    requests,
    hops,
    graphql,
    fetchImpl,
    pulls,
    openPull: (pull) => {
      const number = pull.number ?? nextPull++;
      const created: FakePull = {
        number,
        head: pull.head,
        headSha: pull.headSha ?? `sha-${number}`,
        merged: pull.merged ?? false,
        threads: pull.threads ?? [],
        ...(pull.title === undefined ? {} : { title: pull.title }),
        ...(pull.state === undefined ? {} : { state: pull.state }),
        ...(pull.closes === undefined ? {} : { closes: pull.closes }),
        ...(pull.crossRepository === undefined ? {} : { crossRepository: pull.crossRepository }),
        ...(pull.createdAt === undefined ? {} : { createdAt: pull.createdAt }),
        ...(pull.updatedAt === undefined ? {} : { updatedAt: pull.updatedAt }),
        ...(pull.files === undefined ? {} : { files: pull.files }),
        ...(pull.checks === undefined ? {} : { checks: pull.checks }),
        ...(pull.checkRuns === undefined ? {} : { checkRuns: pull.checkRuns }),
        ...(pull.statuses === undefined ? {} : { statuses: pull.statuses }),
        ...(pull.jobLogs === undefined ? {} : { jobLogs: pull.jobLogs }),
        ...(pull.mergeable === undefined ? {} : { mergeable: pull.mergeable }),
      };
      pulls.set(number, created);
      nextPull = Math.max(nextPull, number + 1);
      return created;
    },
    breakOn: (match, status = 500, body) => { broken = { match, status, ...(body === undefined ? {} : { body }) }; },
    graphqlError: (message, type = "FORBIDDEN") => { graphqlFailure = { message, type }; },
    graphqlRepositoryMissing: () => { repositoryMissing = true; },
    published: (branch = "gh-pages") =>
      new Map([...treeOfRef(branch)].map(([file, blob]) => [file, blobs.get(blob) ?? ""])),
    seedFile,
    truncateTrees: () => { treesTruncated = true; },
    pages: (answer) => { pagesSite = answer; },
    cutBlockers: (to) => { blockersCut = to; },
    bot: BOT,
    labelsOf: (item) => issues.get(item)?.labels ?? [],
    say: (item, body) => post(item, BOT, body),
    sayAs: (login, item, body, when) => post(item, login, body, when),
    entriesOf: (item) => entriesFromComments(comments.get(item) ?? [], BOT),
  };
}
