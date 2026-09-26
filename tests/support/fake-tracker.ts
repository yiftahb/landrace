import { buildRegistry } from "#hooks/load.js";
import { entriesFromComments } from "#conventions.js";
import type { Entry, Registry, RuntimeConfig } from "#namespace.js";
import type { RuntimeContext } from "#namespace.js";
import { githubHooks, type Git } from "#landrace/hooks/github.js";

/**
 * The shipped GitHub integration, over an in-memory GitHub.
 *
 * The fake is the HTTP boundary, not the hooks: `fetch` is what is replaced,
 * and everything above it — the client, both hooks, the source, the operator,
 * and the loader's own classification of them — is the real code a ticket runs
 * through. A second, hand-written imitation of the hooks would be free to
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
  isResolved: boolean;
  body: string;
  /** Where the finding sits. Optional: a thread on a file GitHub can no longer place carries neither. */
  path?: string;
  line?: number;
}

export interface FakePull {
  number: number;
  title?: string;
  /** The head branch. A PR is found by it, because the reference is derived from the ticket and never stored. */
  head: string;
  headSha: string;
  merged: boolean;
  /** GraphQL's own state. Absent means whatever `merged` implies: MERGED, else OPEN. */
  state?: "OPEN" | "MERGED" | "CLOSED";
  /** The issues it closes when merged — its closing references, the other way a PR is tied to a ticket. */
  closes?: number[];
  threads: FakeThread[];
  /** What a `POST /pulls` asked for, as it asked: the branch it goes into, and its description. */
  base?: string;
  body?: string;
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
  /** Answer matching requests with a failure instead, for the failures a hook has to tell apart from "not there". */
  breakOn(match: (request: FakeRequest) => boolean, status?: number): void;
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
  labelsOf(ticket: number): string[];
  /** Post as the bot, the way an effect would. */
  say(ticket: number, body: string): FakeComment;
  /** Post as somebody else, the way a person would. */
  sayAs(login: string, ticket: number, body: string, at?: string): FakeComment;
  entriesOf(ticket: number): Entry[];
  /** The pull requests that exist, by number. */
  pulls: Map<number, FakePull>;
  /** Open one on a head branch, the way a push and a `gh pr create` would. One with an existing number replaces it. */
  openPull(pull: Partial<FakePull> & { head: string }): FakePull;
  /** Every GraphQL query that reached the boundary, with the variables it carried. */
  graphql: Array<{ query: string; variables: Record<string, unknown> }>;
  /** The boundary itself, so a test can point a second, differently configured client at the same in-memory GitHub. */
  fetchImpl: typeof fetch;
}

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

/** And the `first:` the hook asks a ticket's sub-issues and pull requests for. */
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
const noBranches: Git = async (args) => {
  if (args[0] === "for-each-ref") return "";
  throw new Error(`the fake GitHub has no checkout to run "git ${args.join(" ")}" in; pass one as opts.git`);
};

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
    const next = new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString();
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
      ...(s.parent === undefined ? {} : { parent: s.parent }),
      ...(s.editor === undefined ? {} : { editor: s.editor }),
    });
    nextIssue = Math.max(nextIssue, n + 1);
  }

  const post = (ticket: number, login: string, body: string, when?: string): FakeComment => {
    const comment: FakeComment = { id: nextComment++, body, created_at: when ?? at(ticket), user: { login } };
    comments.set(ticket, [...(comments.get(ticket) ?? []), comment]);
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
  const graphql: Array<{ query: string; variables: Record<string, unknown> }> = [];
  let broken: { match: (r: FakeRequest) => boolean; status: number } | null = null;
  let graphqlFailure: { message: string; type: string } | null = null;
  let repositoryMissing = false;
  let pagesSite: FakePages | number | null = null;

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
      // Every field either query asks of a thread node, because the fake
      // answers both from this one page: the count's read takes
      // `isResolved` alone, and the briefing takes the rest.
      nodes: page.map((t) => ({
        isResolved: t.isResolved,
        body: t.body,
        path: t.path ?? null,
        line: t.line ?? null,
        comments: { nodes: [{ body: t.body }] },
      })),
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
    labels: { nodes: i.labels.map((name) => ({ name })) },
    assignees: { nodes: i.assignees },
  });

  /** A connection as GraphQL pages one: the first page of nodes, and how many there are in all. */
  const connection = <T>(all: T[]) => ({ totalCount: all.length, nodes: all.slice(0, CONNECTION_PAGE) });

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
    closingIssuesReferences: { nodes: (p.closes ?? []).map((number) => ({ number })) },
  });

  /** Only the endpoints the hooks actually call, answering the way GitHub does. */
  const fetchImpl = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>);

    const prefix = `/repos/${REPO}`;
    const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
    requests.push({ method, path });
    if (broken && broken.match({ method, path })) {
      return new Response(`the repository is unhappy about ${path}`, { status: broken.status });
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

      // A repository the token cannot see answers with a null repository and
      // no error at all, which is a different failure from "no pull request".
      if (variables.owner !== REPO.split("/")[0] || variables.name !== REPO.split("/")[1]) {
        return json({ data: { repository: null } });
      }

      // Answered by the operation's name, the way a server reads the query
      // rather than guessing from its variables: the hook asks five different
      // questions, and two of them take the same variables.
      const operation = /query (\w+)/.exec(String(body.query ?? ""))?.[1];
      const pullOf = (n: unknown): FakePull | null => pulls.get(Number(n)) ?? null;

      if (operation === "LandraceIssues") {
        const open = [...issues.values()].filter((i) => i.state === "open").sort((a, b) => a.number - b.number);
        const from = typeof variables.cursor === "string" && variables.cursor ? Number(variables.cursor) : 0;
        const page = open.slice(from, from + ISSUE_PAGE);
        const end = from + page.length;
        return json({
          data: {
            repository: {
              issues: {
                pageInfo: { hasNextPage: end < open.length, endCursor: String(end) },
                nodes: page.map((i) => ({
                  ...issueNode(i),
                  parent: i.parent === undefined ? null : { number: i.parent },
                  subIssues: { nodes: childrenOf(i.number).map(issueNode) },
                })),
              },
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

      if (operation === "LandraceTicket") {
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
              // Newest first, the way `orderBy: { field: CREATED_AT, direction: DESC }` orders them.
              pullRequests: connection(
                [...pulls.values()].filter((p) => p.head === variables.head).sort((a, b) => b.number - a.number).map(pullNode),
              ),
            },
          },
        });
      }

      if (operation === "LandraceIssue") {
        const issue = issues.get(Number(variables.number));
        return json({ data: { repository: { issue: issue === undefined ? null : issueNode(issue) } } });
      }

      if (operation === "LandraceThreads" || operation === "LandraceBrief") {
        const pull = pullOf(variables.number);
        return json({
          data: {
            repository: {
              pullRequest: pull === null ? null : { number: pull.number, reviewThreads: threadPage(pull, variables.cursor) },
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
      return json(comments.get(n) ?? []);
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

    return new Response(`no route for ${method} ${url.pathname}`, { status: 404 });
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
      };
      pulls.set(number, created);
      nextPull = Math.max(nextPull, number + 1);
      return created;
    },
    breakOn: (match, status = 500) => { broken = { match, status }; },
    graphqlError: (message, type = "FORBIDDEN") => { graphqlFailure = { message, type }; },
    graphqlRepositoryMissing: () => { repositoryMissing = true; },
    published: (branch = "gh-pages") =>
      new Map([...treeOfRef(branch)].map(([file, blob]) => [file, blobs.get(blob) ?? ""])),
    seedFile,
    truncateTrees: () => { treesTruncated = true; },
    pages: (answer) => { pagesSite = answer; },
    bot: BOT,
    labelsOf: (ticket) => issues.get(ticket)?.labels ?? [],
    say: (ticket, body) => post(ticket, BOT, body),
    sayAs: (login, ticket, body, when) => post(ticket, login, body, when),
    entriesOf: (ticket) => entriesFromComments(comments.get(ticket) ?? [], BOT),
  };
}
