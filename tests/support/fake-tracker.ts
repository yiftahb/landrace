import { buildRegistry } from "#hooks/load.js";
import { entriesFromComments } from "#conventions.js";
import type { Entry, Registry, RuntimeConfig } from "#namespace.js";
import type { RuntimeContext } from "#namespace.js";
import { githubHooks } from "#landrace/hooks/github.js";

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
  title: string;
  body: string;
  state: string;
  html_url: string;
  labels: string[];
  /** As GitHub returns them — objects with a login, not bare strings — so the hook's own reading of them is what runs. */
  assignees: Array<{ login: string }>;
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
  /** The head branch. A PR is found by it, because the reference is derived from the ticket and never stored. */
  head: string;
  headSha: string;
  merged: boolean;
  threads: FakeThread[];
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
  /** Open one on a head branch, the way a push and a `gh pr create` would. */
  openPull(pull: { head: string; number?: number; headSha?: string; merged?: boolean; threads?: FakeThread[] }): FakePull;
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

export function createFakeTracker(
  seed: Array<Partial<FakeIssue>> = [],
  opts: {
    /**
     * `x-oauth-scopes` on `/user`, the way a classic PAT carries it. Absent by
     * default, the way a fine-grained token actually behaves — every other
     * test in this file needs that default unchanged.
     */
    scopes?: string[];
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
      title: s.title ?? `issue ${n}`,
      body: s.body ?? "",
      state: s.state ?? "open",
      html_url: `https://github.com/${REPO}/issues/${n}`,
      labels: s.labels ?? [],
      assignees: s.assignees ?? [],
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

  const pulls = new Map<number, FakePull>();
  let nextPull = 100;

  const requests: FakeRequest[] = [];
  const graphql: Array<{ query: string; variables: Record<string, unknown> }> = [];
  let broken: { match: (r: FakeRequest) => boolean; status: number } | null = null;
  let graphqlFailure: { message: string; type: string } | null = null;
  let repositoryMissing = false;

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
      // answers by variables rather than by parsing the query: the count's
      // read takes `isResolved` alone, and the briefing takes the rest.
      nodes: page.map((t) => ({
        isResolved: t.isResolved,
        body: t.body,
        path: t.path ?? null,
        line: t.line ?? null,
        comments: { nodes: [{ body: t.body }] },
      })),
    };
  };

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

      // Newest first, the way `orderBy: { field: CREATED_AT, direction: DESC }`
      // orders them: a merged pull request and a later one on the same branch
      // both exist, and the later one is the current work.
      const pull = [...pulls.values()]
        .filter((p) => p.head === variables.head)
        .sort((a, b) => b.number - a.number)[0];
      if (!pull) return json({ data: { repository: { pullRequests: { nodes: [] } } } });

      return json({
        data: {
          repository: {
            pullRequests: {
              nodes: [{
                number: pull.number,
                merged: pull.merged,
                headRefOid: pull.headSha,
                reviewThreads: threadPage(pull, variables.cursor),
              }],
            },
          },
        },
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
      if (method === "PATCH") Object.assign(issue, body);
      return json(issue);
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

  const hooks = githubHooks({ repo: REPO, token: "test-token", fetchImpl });

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
    bot: BOT,
    labelsOf: (ticket) => issues.get(ticket)?.labels ?? [],
    say: (ticket, body) => post(ticket, BOT, body),
    sayAs: (login, ticket, body, when) => post(ticket, login, body, when),
    entriesOf: (ticket) => entriesFromComments(comments.get(ticket) ?? [], BOT),
  };
}
