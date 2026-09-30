/**
 * GitHub, in one file, outside the engine.
 *
 * Everything this repository's workflow needs from a tracker is here: the REST
 * and GraphQL client, the pre hook that reads an issue's body and records, the
 * post hook that writes every effect GitHub owns, the artifact hook that
 * publishes the spec to Pages, the source that reports issues, sub-issues,
 * pull requests and published spec pages as a graph, and the operator actions
 * the MCP tools call. `src/` contains no GitHub code at all and a test enforces it,
 * so this file is also the worked example: a second tracker is a sibling of
 * this one, and nothing else changes.
 *
 * Read it in five parts — the client, the two hooks, the spec artifact, the
 * graph, and the ticket-less kinds — and note the two rules the engine cares
 * about:
 *
 *  - Every effect has a `satisfied()` beside its `apply()`, in this same file,
 *    so nobody adds a write and forgets how to tell it has already happened.
 *  - A marker counts as control state only because *we* wrote it, so no
 *    request goes out until this token's own login is known.
 *
 * And one part that is not HTTP at all: publishing a branch a step committed
 * to is a `git push` from the operator's own checkout, with the token handed
 * to git through its environment rather than its command line.
 *
 * What any tracker, forge or docs hook would need as much as this one — the
 * satisfied() rules, whose turn a thread is, the briefings, the spec's hash,
 * git itself — is in `landrace/kit`, and this file is what is GitHub's: the
 * client, the queries, GitHub's shapes and their mapping into the kit's, the
 * push URLs it trusts with a token, and every word said in GitHub's name.
 */
import {
  BRANCH_PUSH_EFFECT,
  CLOSE_EFFECT,
  defineArtifactHook,
  defineOperator,
  definePostHook,
  definePreHook,
  definePreflight,
  defineSource,
  effectBranch,
  entriesFromComments,
  hasPullFrom,
  LABEL_EFFECT,
  LABELS,
  MAX_SUBGRAPH_NODES,
  neutraliseMarkers,
  NODES_CLOSE_EFFECT,
  parseMarker,
  PULL_OPEN_EFFECT,
  PULL_REVIEW_EFFECT,
  PULL_REQUEST_KIND,
  RECORD_EFFECT,
  recordMarker,
  RELATIONS,
  renderMarker,
  renderOrigin,
  sameLogin,
  STAGE_LABEL_PREFIX,
  STATUS_EFFECT,
  type ArtifactHook,
  type Closed,
  type Effect,
  type Graph,
  type HookContext,
  type NewTicket,
  type Node,
  type Operator,
  type PostHook,
  type PreHook,
  type Preflight,
  type RelationDecl,
  type Relationship,
  type RuntimeContext,
  type Snapshot,
  type Source,
  type TicketPatch,
} from "landrace/hooks";
import {
  // the tracker's
  closeSatisfied, commentSatisfied, commentsOf, DONE_WINDOW_MS, ISSUE_PAGE, labelSatisfied, MAX_COMMENT_CHARS,
  MAX_ISSUE_PAGES, MAX_THREAD_PAGES, nodesCloseSatisfied, priorityFromLabels, statusSatisfied, THREAD_PAGE,
  TICKET_PAGE, ticketNode,
  // the forge's
  BRIEF_COMMENTS, BRIEF_HISTORY_THREADS, commentLine, cut, diffBrief, FINDING_KIND, FIX_KIND, isReply, newest,
  placeFindings, prBranch, pullNode, pushSatisfied, threadCounts, threadLine, threadsBrief, ticketOfBranch,
  // the docs'
  briefPage, contentOf, hashOf, mine, PUBLISH, publishSatisfied, SPEC, specNode,
  // git's
  branchHeads, gitIn, headIn, headsOf, nothingCommitted, originPushUrl, ownGit, pushBranch, repositoryOf,
  type ChangedFile, type Git, type ReviewThread, type SnapshotComment, type ThreadComment, type ThreadCounts,
} from "landrace/kit";
/*
 * `landrace/hooks` and `landrace/kit` resolve here by Node's package
 * self-reference — the same specifiers a consumer with landrace installed
 * writes, and the reason this file is a copyable example rather than a
 * repo-shaped one. They point at the built `dist/`, so run `pnpm build`
 * before running the CLI out of this repository; the test suite maps them to
 * `src/` so it never waits on a build.
 */

/* git, as the tests and the tracker fake reach it through this hook. */
export { gitIn };
export type { Git };

/* ── GitHub's own shapes ────────────────────────────────────────────────── */

/** An issue as REST answers it: read for its body, and for the stage labels a position swap removes. */
interface Issue {
  number: number;
  /** The REST id, which is not the number: a sub-issue is linked by this. */
  id: number;
  body: string | null;
  labels: Array<string | { name?: string }>;
}

interface Comment {
  id: number;
  body: string;
  created_at: string;
  user?: { login?: string } | null;
}

const labelNames = (issue: Issue): string[] =>
  (issue.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean);

/**
 * An issue as GraphQL answers `ISSUE_FIELDS`: the one reading of an issue that
 * becomes a `Node`, whichever query asked for it — list, read, or the
 * operator's own write reading back what it wrote.
 */
export interface IssueNode {
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

/**
 * The fields every issue query asks for, spelled once so `IssueNode` has one
 * shape whichever query it came back from. Sub-issues are asked for with these
 * too: a parent counting its children by stage reads their labels.
 */
export const ISSUE_FIELDS = `
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

const ISSUE_QUERY = `
query LandraceIssue($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) { ${ISSUE_FIELDS} }
  }
}`;

/* ── the client ─────────────────────────────────────────────────────────── */

export interface GitHubOptions {
  repo: string;
  token: string;
  /** Overrides the login resolved from the token, for a GitHub App posting under a bot name. */
  bot?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  /**
   * git, in the checkout whose branches are pushed and read. By default the
   * repository this file is in — `gitIn(await hookRepository())` — which a
   * test replaces with a checkout of its own, so nothing here ever reads or
   * pushes the repository the tests happen to run from.
   */
  git?: Git | undefined;
}

/**
 * The repository this file is in: for a project's `.landrace/hooks/`, that
 * project — whatever directory the process was started from.
 *
 * `import.meta.dirname` is the obvious spelling and cannot be written here:
 * ts-jest's default pass compiles this file as CommonJS and refuses
 * `import.meta` outright (TS1343; see tests/hooks/claude.test.ts). The file
 * name V8 records for this very frame is the same fact, in either module
 * system — a path under jest, a file: URL under node. Read here and nowhere
 * else: the same lookup inside the kit would name the kit's own file.
 */
export async function hookRepository(): Promise<string> {
  const saved = Error.prepareStackTrace;
  let file: string | null | undefined;
  try {
    Error.prepareStackTrace = (_error, frames) => frames;
    file = (new Error().stack as unknown as NodeJS.CallSite[] | undefined)?.[0]?.getFileName();
  } finally {
    Error.prepareStackTrace = saved;
  }
  if (!file) throw new Error("the github hook cannot tell which file it was loaded from, so it cannot find its repository");
  return repositoryOf(file);
}

/** A 404 from the API, told apart from every other failure by its status rather than by its text. */
const isMissing = (e: unknown): boolean => (e as { status?: unknown } | null)?.status === 404;

function createClient(opts: GitHubOptions) {
  const { repo, token } = opts;
  const doFetch = opts.fetchImpl ?? fetch;
  // [^/] admitted "?", "#", "%2F" and "@", so `repo: "o/n#x"` silently
  // retargeted every request at /repos/o/n; allowing "." anywhere then left
  // the ".." segment, which WHATWG URL normalisation collapses before the
  // request goes out ("../user" reached a real, different endpoint). A dot is
  // legal inside a name and never at the start of one. The host is pinned, so
  // none of this was ever cross-host — but a request should go where the
  // config says it goes.
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(repo)) {
    throw new Error(`tracker.repo must be "owner/name", got "${repo}"`);
  }

  async function request<T>(
    method: string,
    url: string,
    body?: unknown,
    // Read alongside the ordinary response handling below, never as a second
    // fetch: botLogin's own GET /user is the only place a classic token's
    // scopes are ever visible, and this is how it hands that header back
    // without a second request to the same endpoint.
    onResponse?: (res: Response) => void,
  ): Promise<T> {
    const res = await doFetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "landrace",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    onResponse?.(res);
    // The status rides on the error rather than only in its text. "Is this a
    // 404?" answered by searching the message finds the *path* on a ticket
    // numbered 404 — `/contents/specs/404/index.md` — and a caller that reads
    // a broken repository as an absent file republishes it on every tick.
    if (!res.ok) {
      throw Object.assign(new Error(`${method} ${url} → ${res.status} ${await res.text()}`), { status: res.status });
    }
    return res.status === 204 ? (null as T) : ((await res.json()) as T);
  }

  /*
   * Which account we post as is what separates our control markers from a
   * stranger's, so it is resolved once from the token and cached: it cannot
   * change under a fixed token, and every tick reads markers.
   */
  const configured = opts.bot?.trim() ?? "";
  let login = "";

  /**
   * `x-oauth-scopes`, captured off the same GET /user that resolves the
   * login. A classic personal access token carries its scopes on every
   * response; a fine-grained token carries none at all — so the preflight
   * below tells the two apart by whether this is null, not by trying to
   * parse the token itself. `undefined` until botLogin has run once;
   * `null` after it has, if the header was not there.
   */
  let scopes: string[] | null | undefined;

  async function botLogin(): Promise<string> {
    if (login) return login;

    // Asked even when tracker.bot is set. A GitHub App's installation token
    // resolves to that app's own bot user, so a legitimate override matches
    // and only a typo differs — and an unverified typo switched the whole
    // authorship guard off: our own output stopped counting as ours and every
    // paid step was re-invoked, forever.
    let resolved = "";
    let failure = "";
    try {
      const user = await request<unknown>("GET", "https://api.github.com/user", undefined, (res) => {
        const header = res.headers.get("x-oauth-scopes");
        const parsed = header === null ? null : header.split(",").map((s) => s.trim()).filter(Boolean);
        // An empty or whitespace-only header parses to `[]`, which is not the
        // same claim as "classic, and holds zero scopes" — nothing here can
        // tell that apart from a fine-grained token whose header GitHub left
        // blank, and reading it as the former would refuse every one of
        // those. Folded into `null` (unknown) so the probes below judge real
        // access instead of a scope list that might not mean anything.
        scopes = parsed !== null && parsed.length === 0 ? null : parsed;
      });
      const candidate = (user as { login?: unknown } | null)?.login;
      // Shape-checked inside the guarded path: a non-string login used to
      // throw a TypeError past this handler, so the operator saw
      // "login.trim is not a function" instead of what to do about it.
      if (typeof candidate === "string" && candidate.trim()) resolved = candidate.trim();
      else failure = "GET /user returned no login";
    } catch (e) {
      failure = String(e);
    }

    if (configured) {
      if (resolved && resolved.toLowerCase() !== configured.toLowerCase()) {
        throw new Error(
          `tracker.bot is "${configured}" but this token posts as "${resolved}". ` +
          "One of the two is wrong, and a login that is not the one we post under makes " +
          "our own comments read as a stranger's — every step would be re-invoked forever.",
        );
      }
      // Matched, or /user could not answer at all: the second is the case the
      // override exists for.
      login = configured;
      return login;
    }

    if (!resolved) {
      // Fail closed. A fallback that treated every marker as someone else's
      // would make the engine believe no step had ever run.
      throw new Error(
        `cannot resolve the account landrace posts as: ${failure}. ` +
        "Check the token, or set tracker.bot in landrace.yaml if it is a GitHub App.",
      );
    }

    login = resolved;
    return login;
  }

  /*
   * Nothing touches the repository until the login is known. The engine used
   * to get this by refusing to start, back when it knew what a login was; it
   * does not any more, so the rule lives at the one place every entry point
   * goes through instead. It is the same fail-closed either way, and it is not
   * caution for its own sake: an unresolved login makes our own markers read
   * as a stranger's, which makes the engine believe no step has ever run and
   * pay for every one of them again on every tick.
   */
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    await botLogin();
    return request<T>(method, `https://api.github.com/repos/${repo}${path}`, body);
  };

  /**
   * A 403 on a write the preflight could not probe, reported as the permission
   * it lacks. Closing a pull request and linking a sub-issue have no harmless
   * form to try at startup, so this is where a token missing either is named.
   */
  const named = async (write: Promise<unknown>, permission: string): Promise<void> => {
    try {
      await write;
    } catch (e) {
      // GitHub's own words kept: a secondary rate limit answers 403 too.
      if ((e as { status?: unknown } | null)?.status === 403) {
        throw new Error(`token needs ${permission} (GitHub answered: ${e instanceof Error ? e.message : String(e)})`);
      }
      throw e;
    }
  };

  /**
   * Everything a review thread's `isResolved`, a sub-issue and a closing
   * reference need: none of them is in REST.
   *
   * It is a POST to a different host path and its own error shape — a
   * GraphQL failure is an HTTP 200 carrying an `errors` array — so it lives
   * beside `call` rather than inside it. The login gate is the same one for
   * the same reason: it is resolved once per client, and every entry point
   * goes through it.
   */
  async function graphqlRequest<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    await botLogin();
    const body = await request<{ data?: T; errors?: Array<{ message?: unknown; type?: unknown }> }>(
      "POST",
      "https://api.github.com/graphql",
      { query, variables },
    );
    // Errors arrive with a 200 and are the whole answer: read past them and
    // a query that failed looks exactly like one that found nothing. The
    // array rides on the thrown error too — a permission refusal (type
    // FORBIDDEN) and a rate limit (type RATE_LIMITED) are both this same
    // shape, and only the preflight cares which one it actually was.
    if (body.errors?.length) {
      throw Object.assign(
        new Error(`graphql: ${body.errors.map((e) => String(e.message ?? e)).join("; ")}`),
        { errors: body.errors },
      );
    }
    if (body.data === undefined || body.data === null) throw new Error("graphql: the response carried no data");
    return body.data;
  }

  return {
    botLogin,

    /**
     * The scopes a classic token carries, or null for a fine-grained one —
     * the preflight's own way of telling the two apart, off the same GET
     * /user call `botLogin` already makes rather than a second one.
     */
    oauthScopes: async (): Promise<string[] | null> => {
      await botLogin();
      return scopes ?? null;
    },

    /**
     * The one write the startup preflight makes: an empty, unreferenced blob.
     * No tree, commit or ref ever names it, so nothing shows in the GitHub UI
     * and the object is garbage-collected on GitHub's own schedule — and it is
     * the only way to learn whether a fine-grained token can write Contents at
     * all, because such a token cannot report its own permissions the way a
     * classic one's `x-oauth-scopes` header does. The user approved exactly
     * this write, once, and nothing else.
     */
    createEmptyBlob: async (): Promise<void> => {
      await call("POST", "/git/blobs", { content: "", encoding: "utf-8" });
    },

    /**
     * The one question REST cannot answer: a review thread's `isResolved`.
     *
     * It is a POST to a different host path and its own error shape — a
     * GraphQL failure is an HTTP 200 carrying an `errors` array — so it lives
     * beside `call` rather than inside it. The login gate is the same one for
     * the same reason: it is resolved once per client, and every entry point
     * goes through it.
     */
    graphql: graphqlRequest,

    getIssue: (n: number) => call<Issue>("GET", `/issues/${n}`),

    /**
     * One issue as a graph node would read it, over the same fields `list`
     * and `read` ask for — so the operator's writes read back through the one
     * mapping from GitHub to a `Node`, not a REST one beside a GraphQL one.
     */
    getIssueNode: async (n: number): Promise<IssueNode> => {
      const [owner = "", name = ""] = repo.split("/");
      const data = await graphqlRequest<{ repository: { issue: IssueNode | null } | null }>(
        ISSUE_QUERY, { owner, name, number: n },
      );
      if (!data.repository) throw unseen(repo);
      if (!data.repository.issue) throw new Error(`#${n} is not an issue in ${repo}`);
      return data.repository.issue;
    },
    createIssue: (fields: { title: string; body?: string; labels?: string[] }) =>
      call<Issue>("POST", `/issues`, fields),
    updateIssue: (n: number, fields: { title?: string; body?: string; state?: string }) =>
      call<Issue>("PATCH", `/issues/${n}`, fields),
    closeIssue: (n: number, reason: "completed" | "not_planned") =>
      call<Issue>("PATCH", `/issues/${n}`, { state: "closed", state_reason: reason }),
    closePull: (n: number) =>
      named(call("PATCH", `/pulls/${n}`, { state: "closed" }), `"Pull requests: Read and write" on ${repo}`),

    /** The branch a pull request is proposed into: the repository's own default, never an assumed "main". */
    defaultBranch: async (): Promise<string> => {
      const info = await call<{ default_branch?: unknown }>("GET", "");
      if (typeof info.default_branch !== "string" || info.default_branch === "") {
        throw new Error(`${repo} did not say what its default branch is`);
      }
      return info.default_branch;
    },

    /**
     * Open a pull request — or find one already open from this head, which
     * GitHub answers with a 422 saying so. That is the effect having landed,
     * most likely on an attempt a crash cut off before the next read could
     * see it, so it counts as done rather than as a failure.
     */
    openPull: async (fields: { head: string; base: string; title: string; body: string }): Promise<void> => {
      try {
        await named(call("POST", "/pulls", fields), `"Pull requests: Read and write" on ${repo}`);
      } catch (e) {
        if ((e as { status?: unknown } | null)?.status === 422 && /already exists/i.test(String(e))) return;
        throw e;
      }
    },
    /** The pull request's diff, a file at a time; GitHub stops at 3,000 files, a hundred a page. */
    pullFiles: async (n: number): Promise<PullFile[]> => {
      const all: PullFile[] = [];
      for (let page = 1; page <= 30; page++) {
        const batch = await call<PullFile[]>("GET", `/pulls/${n}/files?per_page=100&page=${page}`);
        all.push(...batch);
        if (batch.length < 100) break;
      }
      return all;
    },
    // ponytail: the first hundred reviews only; past that a round's marker could be missed and posted twice.
    listReviews: (n: number) => call<Array<{ body: string | null }>>("GET", `/pulls/${n}/reviews?per_page=100`),
    postReview: (n: number, body: string, comments: ReviewComment[]) =>
      named(call("POST", `/pulls/${n}/reviews`, { event: "COMMENT", body, comments }), `"Pull requests: Read and write" on ${repo}`),
    commentOnFile: (n: number, path: string, body: string, commitId: string) =>
      named(
        call("POST", `/pulls/${n}/comments`, { path, body, commit_id: commitId, subject_type: "file" }),
        `"Pull requests: Read and write" on ${repo}`,
      ),
    // Checked, not assumed: an answer that does not say the thread is now
    // resolved is a resolve that did not happen.
    resolveThread: async (id: string): Promise<void> => {
      const done = await graphqlRequest<{ resolveReviewThread?: { thread?: { isResolved?: boolean } } | null }>(RESOLVE_THREAD, { id });
      if (done.resolveReviewThread?.thread?.isResolved !== true) throw new Error(`GitHub did not resolve review thread ${id}`);
    },
    // Checked the same way: no comment in the answer is a reply that did not land.
    replyToThread: async (id: string, body: string): Promise<void> => {
      const done = await graphqlRequest<{ addPullRequestReviewThreadReply?: { comment?: { id?: string } | null } | null }>(
        REPLY_THREAD, { id, body },
      );
      if (!done.addPullRequestReviewThreadReply?.comment?.id) throw new Error(`GitHub did not post the reply on review thread ${id}`);
    },
    addSubIssue: (parent: number, child: number) =>
      named(call("POST", `/issues/${parent}/sub_issues`, { sub_issue_id: child }), `"Issues: Read and write" on ${repo}`),
    listComments: (n: number) => call<Comment[]>("GET", `/issues/${n}/comments?per_page=100`),
    createComment: (n: number, body: string) => {
      // Refused before the request goes out, because a 422 here is an apply
      // that throws — and an apply that throws leaves nothing durable on the
      // ticket, so the next tick re-derives the stage as pending and pays for
      // the step all over again.
      if (body.length > MAX_COMMENT_CHARS) {
        throw new Error(
          `refusing to post a ${body.length}-character comment on #${n}: GitHub takes at most ${MAX_COMMENT_CHARS}`,
        );
      }
      return call<Comment>("POST", `/issues/${n}/comments`, { body });
    },
    addLabels: async (n: number, labels: string[]): Promise<void> => {
      if (labels.length) await call("POST", `/issues/${n}/labels`, { labels });
    },
    removeLabel: async (n: number, label: string): Promise<void> => {
      try {
        await call("DELETE", `/issues/${n}/labels/${encodeURIComponent(label)}`);
      } catch (e) {
        if (!isMissing(e)) throw e; // already gone is success
      }
    },

    /**
     * Every file on `branch`, by path, in one request — or null if the branch
     * is not there. `truncated` is GitHub saying it stopped before the end:
     * past its own limit on one response a listing is part of the tree, and
     * a caller must not read it as the whole. An absent flag is read as cut
     * short too, because nothing then says the listing is complete.
     */
    listFiles: async (branch: string): Promise<{ paths: string[]; truncated: boolean } | null> => {
      try {
        const listing = await call<{ tree?: unknown; truncated?: unknown }>(
          "GET",
          `/git/trees/${encodeURIComponent(branch)}?recursive=1`,
        );
        if (!Array.isArray(listing.tree)) throw new Error(`the tree of ${branch} came back with no list of entries`);
        const paths = (listing.tree as Array<{ type?: unknown; path?: unknown } | null>)
          .flatMap((e) => (e?.type === "blob" && typeof e.path === "string" ? [e.path] : []));
        return { paths, truncated: listing.truncated !== false };
      } catch (e) {
        if (isMissing(e)) return null;
        throw e;
      }
    },

    /**
     * How GitHub describes this repository's Pages site, or null when it has
     * none. Any other failure is thrown: a 403 from a token without "Pages:
     * Read" says nothing about whether a site exists.
     */
    pagesSite: async (): Promise<unknown> => {
      try {
        return await call<unknown>("GET", "/pages");
      } catch (e) {
        if (isMissing(e)) return null;
        throw e;
      }
    },

    /** A file's content on `branch`, or null if the branch or the file is not there. */
    getFile: async (branch: string, path: string): Promise<string | null> => {
      try {
        const file = await call<{ content?: unknown; encoding?: unknown }>(
          "GET",
          `/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch)}`,
        );
        // Over a megabyte, the contents API answers with an empty string and a
        // different encoding. Hashing that would compare the file against ""
        // and republish it on every tick, so it is a failure, not a value.
        if (file.encoding !== "base64" || typeof file.content !== "string") {
          throw new Error(`${path} on ${branch} came back as ${String(file.encoding)}, which cannot be read as text`);
        }
        return Buffer.from(file.content, "base64").toString("utf8");
      } catch (e) {
        if (isMissing(e)) return null;
        throw e;
      }
    },

    /**
     * Write one file to `branch` through the Git Data API — blob, tree,
     * commit, ref — creating the branch as an orphan if it is not there.
     *
     * Not the contents API's file-by-file PUT: that needs the blob's current
     * sha to overwrite, which is a second round trip per file, and it cannot
     * create the first commit of an orphan branch at all.
     */
    putFile: async (branch: string, path: string, content: string, message: string): Promise<void> => {
      const head = await headOf(branch);
      const blob = await call<{ sha: string }>("POST", "/git/blobs", {
        content: Buffer.from(content, "utf8").toString("base64"),
        encoding: "base64",
      });
      const tree = await call<{ sha: string }>("POST", "/git/trees", {
        // Everything already on the branch is kept: each ticket owns its own
        // path, and a publish must not delete its neighbours.
        ...(head ? { base_tree: head.tree } : {}),
        tree: [{ path, mode: "100644", type: "blob", sha: blob.sha }],
      });
      const commit = await call<{ sha: string }>("POST", "/git/commits", {
        message,
        tree: tree.sha,
        // No parent on the first commit: the branch is orphan by construction,
        // so nothing published here is ever part of main's history.
        parents: head ? [head.sha] : [],
      });
      if (head) await call("PATCH", `/git/refs/heads/${branch}`, { sha: commit.sha });
      else await call("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha: commit.sha });
    },
  };

  /** The branch's commit and the tree it points at, or null if the branch does not exist yet. */
  async function headOf(branch: string): Promise<{ sha: string; tree: string } | null> {
    try {
      const ref = await call<{ object: { sha: string } }>("GET", `/git/ref/heads/${branch}`);
      const commit = await call<{ tree: { sha: string } }>("GET", `/git/commits/${ref.object.sha}`);
      return { sha: ref.object.sha, tree: commit.tree.sha };
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
  }
}


type Client = ReturnType<typeof createClient>;

/* ── the post hook's satisfied(), which needs no client ─────────────────── */

/**
 * One check per effect this hook handles, each the kit's but `pull.review`'s.
 * Every one reads only the snapshot: the labels and closed state the source
 * read, the comments and login and branch heads the pre hook recorded.
 */
function satisfied(snapshot: Snapshot, effect: Effect): boolean {
  switch (effect.type) {
    case LABEL_EFFECT:
      return labelSatisfied(snapshot, effect);
    case STATUS_EFFECT:
      // GitHub has no status field; position is a stage label.
      return statusSatisfied(snapshot, effect);
    case RECORD_EFFECT:
      return commentSatisfied(snapshot, effect);
    case NODES_CLOSE_EFFECT:
      return nodesCloseSatisfied(snapshot, effect);
    case CLOSE_EFFECT:
      return closeSatisfied(snapshot);
    case BRANCH_PUSH_EFFECT:
      return pushSatisfied(snapshot, effect);
    case PULL_OPEN_EFFECT:
      return hasPullFrom(snapshot.graph as Graph | undefined, (snapshot.node as Node | undefined)?.id, effectBranch(effect));
    case PULL_REVIEW_EFFECT:
      // Asked of GitHub by apply() itself, by the review's marker: the
      // snapshot carries no reviews, and a step's route effect is only ever
      // planned once, right after its step.
      return false;
    default:
      return false;
  }
}

/** An owner or a repository name, as `tracker.repo` itself is validated: nothing a parser could read two ways. */
const NAME = "[A-Za-z0-9_-][A-Za-z0-9._-]*";

/**
 * The only forms of a GitHub push URL this hook will act on, matched against
 * the exact string git will use — never a parsed reading of it.
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
 * push URL `originPushUrl` allows, once this hook has checked it.
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
function pusher(git: Git, token: string, repo: string): (branch: string, ticket: string, signal: AbortSignal) => Promise<void> {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  const scrub = (text: string): string => text.replaceAll(token, "[redacted]").replaceAll(basic, "[redacted]");
  return async (branch, ticket, signal) => {
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
  };
}

/* ── the four hooks ─────────────────────────────────────────────────────── */

/*
 * Exactly what `readTicket` below puts in the snapshot, and nothing else.
 *
 * Both directions matter, because `landrace validate`'s path-coverage rule is
 * answered from this list: a path declared and not provided passes a workflow
 * whose predicate reads nothing, and a path provided and not declared flags a
 * workflow that is fine — and a validator that flags healthy workflows gets
 * switched off. Only what a graph cannot hold is here: the title, the state,
 * the labels and the assignees are the ticket's node, which the source reads,
 * and a second copy of them here would be two readings of one issue free to
 * disagree. tests/hooks/provides.test.ts holds this list level with the
 * fragment, for this tracker and for the in-memory one.
 */
const PROVIDES = [
  "ticket", "ticket.body", "ticket.comments", "entries", "tracker", "tracker.bot", "git", "git.local", "git.remote",
];

const HANDLES = [
  LABEL_EFFECT, STATUS_EFFECT, RECORD_EFFECT, NODES_CLOSE_EFFECT, CLOSE_EFFECT, BRANCH_PUSH_EFFECT, PULL_OPEN_EFFECT,
  PULL_REVIEW_EFFECT,
];

/**
 * Observe: the part of an issue a graph cannot hold — its body and its
 * records — and the branch heads a push is judged against, which live in the
 * operator's checkout rather than on GitHub.
 */
async function readTicket(gh: Client, git: Git, ticket: string): Promise<Record<string, unknown>> {
  const n = issueNumber(ticket);
  const issue = await gh.getIssue(n);
  const raw = await gh.listComments(n);
  const bot = await gh.botLogin();
  return {
    ticket: {
      body: issue.body ?? "",
      comments: raw,
    },
    entries: entriesFromComments(raw, bot),
    // Recorded because the post hook's satisfied() is synchronous and needs to
    // know which comments are ours.
    tracker: { bot },
    // And for the same reason: satisfied() cannot ask git whether a push has
    // landed, so the heads are read here, once a pass.
    git: await branchHeads(git),
  };
}

/** Act: every write GitHub owns, each beside the check that says it has landed. */
async function applyEffect(
  gh: Client,
  push: (branch: string, ticket: string, signal: AbortSignal) => Promise<void>,
  effect: Effect,
  { ticket, snapshot, signal }: HookContext,
): Promise<void> {
  const n = issueNumber(ticket);
  switch (effect.type) {
    case LABEL_EFFECT: {
      for (const l of (effect.remove as string[]) ?? []) await gh.removeLabel(n, l);
      await gh.addLabels(n, (effect.add as string[]) ?? []);
      return;
    }
    case STATUS_EFFECT: {
      // Position is one label, and moving it is more than one request — so
      // there is a window in the middle of this, and the only choice is what
      // the ticket looks like inside it.
      //
      // Removing first left *zero* stage labels there, and a ticket with no
      // position used to read as a new ticket: a Ctrl-C, a 502 on the add or a
      // rate limit in that window restarted a ticket that had already finished
      // a build and seven review rounds, paying for the entry step again and
      // republishing over what was there. Adding first leaves two, which is a
      // state the engine refuses to place at all rather than one it places
      // wrongly — and the next status apply removes the loser, because the
      // removals are derived from what is on the ticket rather than from what
      // this call put there.
      const want = LABELS.stage(String(effect.value));
      await gh.addLabels(n, [want]);
      const current = labelNames(await gh.getIssue(n)).filter((l) => l.startsWith(STAGE_LABEL_PREFIX));
      for (const stale of current.filter((l) => l !== want)) await gh.removeLabel(n, stale);
      return;
    }
    case RECORD_EFFECT: {
      // No kind, no marker: an operator's reply is genuinely a human turn, and
      // stamping it would make the engine read a person's words as its own
      // record. Everything a stage plans names a kind.
      if (effect.kind === undefined) {
        await gh.createComment(n, neutraliseMarkers(String(effect.body ?? "")));
        return;
      }
      const marker = recordMarker(effect);
      await gh.createComment(n, neutraliseMarkers(String(effect.body ?? "")) + renderMarker(marker));
      return;
    }
    case NODES_CLOSE_EFFECT: {
      const graph = snapshot.graph as Graph | undefined;
      for (const id of (effect.ids as string[] | undefined) ?? []) {
        // Already closed is left alone: a merged pull request cannot be
        // un-merged, and an issue closed as completed must not be re-closed
        // as not planned. Unknown is attempted, and GitHub says why it cannot.
        if ((graph?.nodes.find((node) => node.id === id)?.closed ?? null) !== null) continue;
        const pull = /^pr-([1-9][0-9]*)$/.exec(id);
        if (pull) await gh.closePull(Number(pull[1]));
        else await gh.closeIssue(issueNumber(id), "not_planned");
      }
      return;
    }
    case CLOSE_EFFECT:
      await gh.closeIssue(n, "completed");
      return;
    case BRANCH_PUSH_EFFECT:
      await push(effectBranch(effect), ticket, signal);
      return;
    case PULL_OPEN_EFFECT: {
      const branch = effectBranch(effect);
      // Asked of the checkout first: a branch that is nowhere — never
      // committed to, never pushed — has nothing to propose, and GitHub's own
      // answer to it ("head invalid") names neither the ticket nor why.
      const { local, remote } = headsOf(snapshot);
      if (headIn(local, branch) === undefined && headIn(remote, branch) === undefined) {
        throw new Error(
          `cannot open a pull request for #${ticket} from ${branch}: this checkout has no such branch, ` +
          "so no step has committed anything to it",
        );
      }
      try {
        await gh.openPull({
          head: branch,
          base: await gh.defaultBranch(),
          title: (snapshot.node as Node | undefined)?.title ?? `#${n}`,
          // The closing reference is the second way a pull request is tied to
          // its ticket, and the one that survives a branch named any way at all.
          body: `Closes #${n}`,
        });
      } catch (e) {
        if ((e as { status?: unknown } | null)?.status === 422 && /No commits between/i.test(String(e))) {
          throw nothingCommitted(branch, ticket);
        }
        throw e;
      }
      return;
    }
    default:
      throw new Error(`the github hook cannot apply effect "${effect.type}"`);
  }
}

/* ── the spec artifact, published to Pages ──────────────────────────────── */

/**
 * An orphan branch: nothing published here is part of main's history, and no
 * checkout is involved.
 */
const PAGES_BRANCH = "gh-pages";

/**
 * Derived from the ticket, never stored. There is no artifact id to lose, so
 * the reference survives a crash, a rename and a re-derivation for free — the
 * whole reason §3.1 asks for a derived reference rather than a recorded one.
 */
const pagePath = (ticket: string): string => `specs/${ticket}/index.md`;

/** The ticket a path on the Pages branch is the spec page of, when it is one. */
const ticketOfPage = (path: string): string | null => /^specs\/([1-9][0-9]*)\/index\.md$/.exec(path)?.[1] ?? null;

/** The page as a file on GitHub, which anyone who can see the repository can open. */
const fileUrl = (repo: string, ticket: string): string =>
  `https://github.com/${repo}/blob/${[PAGES_BRANCH, ...pagePath(ticket).split("/")].map(encodeURIComponent).join("/")}`;

/**
 * Where a Pages site serves the spec pages, or null when it serves none of
 * them. A 200 says a site exists, not that it serves this branch: one built
 * from main's docs folder, or deployed by an Actions workflow, answers every
 * spec path with a 404 — the dead link this exists to stop handing out. The
 * root is GitHub's own `html_url`, so a custom domain needs no configuring.
 */
function pagesRoot(site: unknown): string | null {
  const s = site as { html_url?: unknown; build_type?: unknown; source?: { branch?: unknown; path?: unknown } | null } | null;
  if (s === null || s.build_type === "workflow" || s.source?.branch !== PAGES_BRANCH || s.source.path !== "/") return null;
  if (typeof s.html_url !== "string" || !/^https?:\/\//.test(s.html_url)) {
    throw new Error(`GitHub described the Pages site with no usable html_url (${String(s.html_url)})`);
  }
  return s.html_url.replace(/\/*$/, "/");
}

/**
 * A spec page's link, from one question per client: does a Pages site serve
 * the gh-pages branch? The listed node, the read node and the artifact's url
 * all come through here, so they cannot disagree about a ticket. A private
 * repository with no site 404s at every github.io link, so without a site the
 * link is the file on GitHub, which any viewer of the repository can open.
 *
 * Only an answer is kept, and a 403 is one: this token lacks "Pages: Read",
 * and only a new token changes that, so it links the file until a restart
 * rather than paying a request per call for the same refusal. A 5xx, a
 * dropped connection or a site described with no address says nothing either
 * way, so it costs this call the file link and the next call asks again.
 * Either is said in the log once, not every tick.
 */
function specLinks(gh: Client, repo: string) {
  // ponytail: kept for the process's lifetime — a Pages site enabled or removed, or a token granted Pages: Read, shows after a restart.
  let root: Promise<string | null> | undefined;
  let told = false;
  return async (ticket: string, log: HookContext["log"]): Promise<string> => {
    root ??= gh.pagesSite().then(pagesRoot).catch((e: unknown) => {
      const refused = (e as { status?: unknown } | null)?.status === 403;
      if (!refused) root = undefined;
      if (!told) {
        told = true;
        log("github.pages.unknown", {
          reason: `could not tell whether a Pages site serves ${PAGES_BRANCH}, so spec links point at the file ` +
            `on GitHub ${refused ? "until a restart" : "until a later read can"}: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
      return null;
    });
    const at = await root;
    return at === null ? fileUrl(repo, ticket) : `${at}specs/${ticket}/`;
  };
}

type SpecLink = ReturnType<typeof specLinks>;

async function readPage(gh: Client, link: SpecLink, ticket: string, log: HookContext["log"]): Promise<Record<string, unknown>> {
  const content = await gh.getFile(PAGES_BRANCH, pagePath(ticket));
  // `exists` and a content hash are the whole state: presence is what a
  // precondition reads, and the hash is what makes a republish a no-op.
  return { exists: content !== null, hash: content === null ? null : hashOf(content), url: await link(ticket, log) };
}

async function publishPage(gh: Client, effect: Effect, ticket: string): Promise<void> {
  mine(effect);
  const content = contentOf(effect);

  // Read before writing, and not from the snapshot: the step that produced
  // this ran minutes ago, and converge deliberately does not reconcile a
  // step's own output before applying it. Identical content is then a no-op
  // at the cost of one GET, rather than a commit per tick on a page nobody
  // changed.
  if ((await gh.getFile(PAGES_BRANCH, pagePath(ticket))) === content) return;

  await gh.putFile(PAGES_BRANCH, pagePath(ticket), content, `landrace: publish the spec for #${ticket}`);
}

/* ── the graph: issues, sub-issues and pull requests over GraphQL, and pages ── */

/**
 * The engine's id as the number GitHub wants. Only this file knows GitHub ids
 * are integers; anything else reaching here is a ticket from some other
 * tracker, and calling `/issues/NaN` with it would report a 404 about the
 * wrong thing.
 */
const issueNumber = (id: string): number => {
  if (!/^[1-9][0-9]*$/.test(id)) throw new Error(`"${id}" is not a GitHub issue number`);
  return Number(id);
};

/** Every relationship type this source reports; a node has one parent, a pull request one ticket, a page one ticket. */
const RELATION_DECLS: RelationDecl[] = [
  { type: RELATIONS.childOf, singular: true },
  { type: RELATIONS.implements, singular: true },
  { type: RELATIONS.documents, singular: true },
];

/**
 * What a pull request is asked for, wherever it is found: enough to know
 * whether it is open, merged or abandoned, which ticket it names, and the head
 * a fix round moves. No thread in it — see THREADS_QUERY — and no body.
 */
const PULL_FIELDS = `
  number title url state merged headRefName headRefOid isCrossRepository createdAt
  closingIssuesReferences(first: 20) { nodes { number } }`;

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

/**
 * Every open pull request, paged on its own cursor. Merged ones are not
 * listed: the board shows what is live, and routing reads `read`, which does
 * include them.
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
 * stops at the first one last touched before the window — the same reasoning
 * CLOSED_QUERY uses for closed issues: none past it can have been updated
 * inside the window either. Mirrors CLOSED_QUERY because it exists for the
 * same bug: a Done ticket's merged pull request never reached the board, since
 * PULLS_QUERY's OPEN-only list is the one an open pull request needs and a
 * merged one never answers.
 */
const CLOSED_PULLS_QUERY = `
query LandraceClosedPulls($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: [MERGED, CLOSED], first: ${ISSUE_PAGE}, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { ${PULL_FIELDS} updatedAt }
    }
  }
}`;

/** One ticket: itself, its parent, its sub-issues, and every pull request tied to it either way. */
const TICKET_QUERY = `
query LandraceTicket($owner: String!, $name: String!, $number: Int!, $head: String!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      ${ISSUE_FIELDS}
      parent { ${ISSUE_FIELDS} }
      subIssues(first: ${TICKET_PAGE}) { totalCount nodes { ${ISSUE_FIELDS} } }
      closedByPullRequestsReferences(first: ${TICKET_PAGE}, includeClosedPrs: true) { totalCount nodes { ${PULL_FIELDS} } }
    }
    pullRequests(headRefName: $head, states: [OPEN, MERGED, CLOSED], first: ${TICKET_PAGE},
                 orderBy: { field: CREATED_AT, direction: DESC }) {
      totalCount
      nodes { ${PULL_FIELDS} }
    }
  }
}`;

/**
 * Thread resolution is GraphQL-only: REST exposes review comments but not
 * `isResolved`. That is a hard requirement on this hook rather than an
 * optimisation, because the review loop's gate is a *count* of unresolved
 * threads — a structural fact nobody can write — and not a judge's verdict.
 *
 * Only what the triggers read reaches the graph. In particular no thread
 * body: a body is written by anyone with comment access, and the graph is
 * hashed into the snapshot and carried into every predicate. The last
 * comment's body is fetched only to be asked whether it is our `fix` answer,
 * and the graph gets the count, never the text.
 */
/** One file of a pull request's diff, as `GET /pulls/{n}/files` answers it. `patch` is absent for a binary or huge file. */
interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

/** A line comment inside a review — the only place GitHub takes several findings in one request. */
interface ReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
}

const RESOLVE_THREAD = `
mutation LandraceResolve($id: ID!) {
  resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } }
}`;

/**
 * Each thread's last comment rides along — 200 nodes a page — because whose
 * turn a thread is is read off its last word: see `answered`. Its body is
 * parsed for our marker here and goes no further; the graph gets two counts.
 */
const THREADS_QUERY = `
query LandraceThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: ${THREAD_PAGE}, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { isResolved lastReply: comments(last: 1) { nodes { body author { login } } } }
      }
    }
  }
}`;

/**
 * fix-review's reply on a thread, by the thread's GraphQL id — the one the
 * briefing names. REST's reply endpoint wants a comment id nothing here reads.
 */
const REPLY_THREAD = `
mutation LandraceReply($id: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { comment { id } }
}`;

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
  closingIssuesReferences: { nodes: Array<{ number: number }> };
  /** ISO 8601. Optional for the same reason as IssueNode's. */
  createdAt?: string;
}

interface ListedIssue extends IssueNode {
  parent: { number: number } | null;
  subIssues: { nodes: IssueNode[] };
}

interface IssuesResponse {
  repository: {
    issues: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ListedIssue[] };
  } | null;
}

interface ClosedIssue extends IssueNode {
  closedAt: string | null;
  updatedAt: string | null;
  parent: { number: number } | null;
}

interface ClosedResponse {
  repository: {
    issues: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ClosedIssue[] };
  } | null;
}

interface PullsResponse {
  repository: {
    pullRequests: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: PullNode[] };
  } | null;
}

interface ClosedPullNode extends PullNode {
  updatedAt: string | null;
}

interface ClosedPullsResponse {
  repository: {
    pullRequests: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ClosedPullNode[] };
  } | null;
}

interface TicketResponse {
  repository: {
    issue: (IssueNode & {
      parent: IssueNode | null;
      subIssues: { totalCount: number; nodes: IssueNode[] };
      closedByPullRequestsReferences: { totalCount: number; nodes: PullNode[] };
    }) | null;
    pullRequests: { totalCount: number; nodes: PullNode[] };
  } | null;
}

interface ThreadsResponse {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{ isResolved: boolean; lastReply: { nodes: BriefComment[] } }>;
      };
    } | null;
  } | null;
}

/** A repository the token cannot see answers with a 200, no errors and a null repository — never read as an empty one. */
const unseen = (repo: string): Error =>
  new Error(`the repository "${repo}" answered with nothing at all; check the token's access to it`);

/**
 * GitHub's close reason, as the one piece of lifecycle the engine understands.
 *
 * Anything else is refused rather than guessed (spec §3): `REOPENED` on a
 * closed issue, or a reason GitHub adds later, would otherwise read as
 * finished and let a parent count it done.
 */
function closedOf(issue: IssueNode): Closed {
  if (issue.state === "OPEN") return null;
  // Closed with no reason is how every issue closed before GitHub had reasons reads.
  if (issue.stateReason === "COMPLETED" || issue.stateReason === null) return "done";
  if (issue.stateReason === "NOT_PLANNED" || issue.stateReason === "DUPLICATE") return "dropped";
  throw new Error(
    `#${issue.number} is closed for the reason "${String(issue.stateReason)}", which this hook does not map ` +
    "to done or dropped; it will not guess",
  );
}

/**
 * The one mapping from a GitHub issue to a ticket node: GitHub's fields read
 * into the kit's `ticketNode`. `bot` is the login we post as: an origin
 * counts only in a body we wrote, because a re-run closes whatever claims it.
 */
export function nodeOfIssue(issue: IssueNode, bot: string): Node {
  return ticketNode({
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
  }, bot);
}

/** A pull request as GraphQL answers it, as the kit's `pullNode`: a fork's head branch is not named. */
function pullNodeOf(pull: PullNode, threads?: ThreadCounts): Node {
  return pullNode({
    number: pull.number,
    title: pull.title,
    link: pull.url,
    merged: pull.merged,
    closed: pull.state === "CLOSED",
    headSha: pull.headRefOid,
    branch: pull.isCrossRepository ? undefined : pull.headRefName,
    createdAt: pull.createdAt,
  }, threads);
}

/**
 * Every ticket a pull request names: every issue it closes, and the one its
 * branch is for — unless the branch is a fork's, which anybody can name
 * after any ticket.
 */
const ticketsNamedBy = (pull: PullNode): Set<string> => {
  const named = new Set(pull.closingIssuesReferences.nodes.map((i) => String(i.number)));
  const branch = pull.isCrossRepository ? null : ticketOfBranch(pull.headRefName);
  if (branch !== null) named.add(branch);
  return named;
};

/**
 * How many review threads on one pull request nobody has resolved, and how
 * many of those await a fix, every page of them, or a refusal — never a
 * number known to be short.
 */
async function countThreads(gh: Client, repo: string, number: number): Promise<ThreadCounts> {
  const [owner = "", name = ""] = repo.split("/");
  const bot = await gh.botLogin();
  let cursor: string | null = null;
  const read: Array<Pick<ReviewThread, "resolved" | "last">> = [];

  for (let page = 0; page < MAX_THREAD_PAGES; page++) {
    const data: ThreadsResponse = await gh.graphql<ThreadsResponse>(THREADS_QUERY, { owner, name, number, cursor });
    if (!data.repository) throw unseen(repo);
    const threads = data.repository.pullRequest?.reviewThreads;
    if (!threads) throw new Error(`pull request #${number} answered with no review threads at all`);
    read.push(...threads.nodes.map((t) => ({ resolved: t.isResolved, last: commentOf(t.lastReply.nodes[0]) })));
    if (!threads.pageInfo.hasNextPage) return threadCounts(read, bot);
    cursor = threads.pageInfo.endCursor;
  }

  throw new Error(
    `the pull request #${number} has more than ${MAX_THREAD_PAGES * THREAD_PAGE} review threads, ` +
    "so the open-thread count the review loop gates on cannot be read in one pass. " +
    "Reporting the count of what was read would be reporting a number known to be short.",
  );
}

/**
 * Which tickets have a spec page, from one listing of the whole Pages branch
 * rather than a read per ticket — or none at all, said in the log, when that
 * listing could not be had whole.
 *
 * Display only, so nothing about it may fail the tick: nothing a tick decides
 * from reads these — `read` carries its own — and a `list` that throws stalls
 * every ticket's work for the sake of a board row. A 5xx, an empty
 * repository's 409, a dropped connection and a body that is not a tree all
 * cost this tick its documents and a log line saying why; a missing branch is
 * simply no pages yet, and says nothing.
 *
 * And none rather than some when GitHub cut the listing short: part of the
 * pages is a set known to be short, and the board would show a spec on one
 * ticket and quietly none on the next, which reads as "not published".
 */
async function publishedSpecs(gh: Client, ctx: RuntimeContext): Promise<Set<string>> {
  const skipped = (reason: string): Set<string> => {
    ctx.log("github.documents.skipped", { branch: PAGES_BRANCH, reason });
    return new Set();
  };
  let listing: Awaited<ReturnType<Client["listFiles"]>>;
  try {
    listing = await gh.listFiles(PAGES_BRANCH);
  } catch (e) {
    return skipped(`the listing of ${PAGES_BRANCH} failed, so no spec page is reported this tick: ${
      e instanceof Error ? e.message : String(e)}`);
  }
  if (listing === null) return new Set();
  if (listing.truncated) {
    return skipped(`GitHub truncated its listing of ${PAGES_BRANCH}, so no spec page is reported this tick rather than some of them`);
  }
  return new Set(listing.paths.flatMap((path) => ticketOfPage(path) ?? []));
}

/**
 * Every open issue and every open pull request, as one graph, once per tick —
 * and every listed ticket's published spec page, as a document beside it.
 *
 * What it must never do is fail the tick for one issue's sake: two priority
 * labels list as unprioritised, and a pull request naming two tickets lists
 * with no edge at all. `read` of that ticket is where either halts, naming it.
 */
async function listGraph(gh: Client, repo: string, link: SpecLink, ctx: RuntimeContext): Promise<Graph> {
  const [owner = "", name = ""] = repo.split("/");
  const nodes = new Map<string, Node>();
  const parentOf = new Map<string, string>();
  const bot = await gh.botLogin();

  // An issue this hook cannot map is left out, with every edge touching it:
  // one bad issue must not fail the tick for the rest. `read` of anything
  // whose neighbourhood holds it halts, naming it.
  const keep = (issue: IssueNode): void => {
    try {
      nodes.set(String(issue.number), nodeOfIssue(issue, bot));
    } catch (e) {
      ctx.log("github.issue.skipped", { issue: issue.number, reason: e instanceof Error ? e.message : String(e) });
    }
  };
  const pulls: PullNode[] = [];
  let cursor: string | null = null;

  for (let page = 0; ; page++) {
    if (page === MAX_ISSUE_PAGES) {
      throw new Error(`${repo} has more than ${MAX_ISSUE_PAGES * ISSUE_PAGE} open issues, more than one list may carry`);
    }
    const data: IssuesResponse = await gh.graphql<IssuesResponse>(ISSUES_QUERY, { owner, name, cursor });
    if (!data.repository) throw unseen(repo);
    const { issues } = data.repository;

    for (const issue of issues.nodes) {
      const id = String(issue.number);
      // An open sub-issue is listed twice — as an issue, and under its
      // parent. It is one node, and the reading as an issue is the full one
      // (SUB_ISSUE_FIELDS asks for fewer labels), so that one wins.
      nodes.delete(id);
      keep(issue);
      if (issue.parent) parentOf.set(id, String(issue.parent.number));
      for (const sub of issue.subIssues.nodes) {
        const child = String(sub.number);
        if (!nodes.has(child)) keep(sub);
        parentOf.set(child, id);
      }
    }
    if (!issues.pageInfo.hasNextPage) break;
    cursor = issues.pageInfo.endCursor;
  }

  // The board's Done lane: tickets Landrace moved — an lr:stage:* label says it
  // did — that closed inside the window. A closed issue nobody routed is not
  // Landrace's to show. Bounded like the rest, but past the bound it stops
  // quietly rather than failing the tick: this is for the page, not the loop.
  const since = Date.now() - DONE_WINDOW_MS;
  cursor = null;
  closed: for (let page = 0; page < MAX_ISSUE_PAGES; page++) {
    const data: ClosedResponse = await gh.graphql<ClosedResponse>(CLOSED_QUERY, { owner, name, cursor });
    if (!data.repository) throw unseen(repo);
    const { issues } = data.repository;
    for (const issue of issues.nodes) {
      if (issue.updatedAt !== null && Date.parse(issue.updatedAt) < since) break closed;
      if (issue.closedAt === null || Date.parse(issue.closedAt) < since) continue;
      if (!issue.labels.nodes.some((l) => l.name.startsWith(STAGE_LABEL_PREFIX))) continue;
      const id = String(issue.number);
      // A closed sub-issue is already here under its open parent, read lighter; this reading is the full one.
      nodes.delete(id);
      keep(issue);
      if (issue.parent) parentOf.set(id, String(issue.parent.number));
    }
    if (!issues.pageInfo.hasNextPage) break;
    cursor = issues.pageInfo.endCursor;
  }

  // Paged and bounded the same way: a pull request missing from a short list
  // is a ticket the board shows with no work on it.
  cursor = null;
  for (let page = 0; ; page++) {
    if (page === MAX_ISSUE_PAGES) {
      throw new Error(`${repo} has more than ${MAX_ISSUE_PAGES * ISSUE_PAGE} open pull requests, more than one list may carry`);
    }
    const data: PullsResponse = await gh.graphql<PullsResponse>(PULLS_QUERY, { owner, name, cursor });
    if (!data.repository) throw unseen(repo);
    const { pullRequests } = data.repository;
    pulls.push(...pullRequests.nodes);
    if (!pullRequests.pageInfo.hasNextPage) break;
    cursor = pullRequests.pageInfo.endCursor;
  }

  // The same Done-lane window as the closed issues above, over merged and
  // closed pull requests: a closed ticket's own pull request is still work
  // this list should show, and the open-only query above never answers it —
  // the bug this covers, a Done ticket with no pull request on the board.
  // Bounded and stopped quietly past it, like the closed issues: this is for
  // the board, not the tick.
  cursor = null;
  closedPulls: for (let page = 0; page < MAX_ISSUE_PAGES; page++) {
    const data: ClosedPullsResponse = await gh.graphql<ClosedPullsResponse>(CLOSED_PULLS_QUERY, { owner, name, cursor });
    if (!data.repository) throw unseen(repo);
    const { pullRequests } = data.repository;
    for (const pull of pullRequests.nodes) {
      // No `updatedAt` at all says nothing about whether it is within the
      // window, the same reason a closed issue with no `closedAt` is left
      // out above — never shown on a guess.
      if (pull.updatedAt === null) continue;
      if (Date.parse(pull.updatedAt) < since) break closedPulls;
      pulls.push(pull);
    }
    if (!pullRequests.pageInfo.hasNextPage) break;
    cursor = pullRequests.pageInfo.endCursor;
  }

  const relationships: Relationship[] = [];
  // A parent that is closed and was not listed is outside this graph, and an
  // issue left out above is too: the edge is dropped rather than left dangling.
  for (const [child, parent] of parentOf) {
    if (nodes.has(child) && nodes.has(parent)) relationships.push({ from: child, to: parent, type: RELATIONS.childOf });
  }

  const listed = [...nodes.values()];
  for (const pull of pulls) {
    const named = ticketsNamedBy(pull);
    const [only] = named;
    // Two tickets named is an ambiguity; `read` of either one halts on it.
    if (named.size !== 1 || only === undefined || !nodes.has(only)) continue;
    const node = pullNodeOf(pull);
    listed.push(node);
    relationships.push({ from: node.id, to: only, type: RELATIONS.implements });
  }

  // Only for a ticket this list carries, so no edge dangles: a page whose
  // ticket is closed and unlisted, or was never an issue, is left out.
  const paged = await publishedSpecs(gh, ctx);
  for (const ticket of nodes.keys()) {
    if (!paged.has(ticket)) continue;
    const page = specNode(ticket, await link(ticket, ctx.log));
    listed.push(page);
    relationships.push({ from: page.id, to: ticket, type: RELATIONS.documents });
  }

  return { nodes: listed, relationships };
}

/** One ticket's pull requests, found either way — by its branch, and by closing reference — once each. */
async function pullsOf(gh: Client, repo: string, ticket: string): Promise<{ issue: NonNullable<NonNullable<TicketResponse["repository"]>["issue"]>; pulls: PullNode[] }> {
  const [owner = "", name = ""] = repo.split("/");
  const data = await gh.graphql<TicketResponse>(TICKET_QUERY, {
    owner, name, number: issueNumber(ticket), head: prBranch(ticket),
  });
  if (!data.repository) throw unseen(repo);
  const issue = data.repository.issue;
  if (!issue) throw new Error(`#${ticket} is not an issue in ${repo}`);

  // A count over the first page is a number known to be short, and every one
  // of these is counted: past the page, the ticket halts saying so.
  for (const [what, connection] of [
    ["sub-issues", issue.subIssues],
    ["pull requests on its branch", data.repository.pullRequests],
    ["pull requests closing it", issue.closedByPullRequestsReferences],
  ] as const) {
    if (connection.totalCount > connection.nodes.length) {
      throw new Error(`#${ticket} has ${connection.totalCount} ${what}, more than the ${TICKET_PAGE} one read carries`);
    }
  }

  // A fork's pull request found by its head name alone is not this ticket's:
  // the name is in somebody else's repository. By closing reference, it is.
  const byNumber = new Map<number, PullNode>();
  const onBranch = data.repository.pullRequests.nodes.filter((pull) => !pull.isCrossRepository);
  for (const pull of [...onBranch, ...issue.closedByPullRequestsReferences.nodes]) {
    if (!byNumber.has(pull.number)) byNumber.set(pull.number, pull);
  }
  return { issue, pulls: [...byNumber.values()] };
}

/**
 * One ticket's neighbourhood: itself, its parent, every descendant, breadth
 * first, and every pull request tied to any of them — merged and closed ones
 * included, because "every pull request is merged" is a count over all of
 * them, and a newer open one beside a merged one is work not yet done.
 *
 * The whole subtree, not one level: a re-run's cascade closes what hangs off a
 * stale child — its pull requests, its own children — and it can only close
 * what the graph shows it. One query per issue in the subtree, and the read
 * stops at MAX_SUBGRAPH_NODES rather than paying for a graph the engine would
 * refuse anyway.
 */
async function readGraph(gh: Client, repo: string, link: SpecLink, ticket: string, ctx: RuntimeContext): Promise<Graph> {
  const bot = await gh.botLogin();
  const root = await pullsOf(gh, repo, ticket);

  const { found } = priorityFromLabels(root.issue.labels.nodes.map((l) => l.name));
  if (found.length > 1) throw new Error(`#${ticket} carries ${found.join(" and ")}; priority is one`);

  const nodes = new Map<string, Node>();
  const relationships: Relationship[] = [];
  const add = (node: Node): void => {
    nodes.set(node.id, node);
    if (nodes.size > MAX_SUBGRAPH_NODES) {
      throw new Error(
        `#${ticket} has more than the ${MAX_SUBGRAPH_NODES} nodes one read may carry ` +
        `(reading stopped at ${nodes.size}); a graph known to be short is not one to decide from`,
      );
    }
  };

  add(nodeOfIssue(root.issue, bot));
  if (root.issue.parent) {
    const parent = nodeOfIssue(root.issue.parent, bot);
    add(parent);
    relationships.push({ from: ticket, to: parent.id, type: RELATIONS.childOf });
  }

  const queue = [root];
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i];
    if (at === undefined) break;
    const id = String(at.issue.number);

    for (const sub of at.issue.subIssues.nodes) {
      const child = String(sub.number);
      // GitHub keeps sub-issues a tree; this only stops a read that is not one
      // from walking in circles.
      if (nodes.has(child)) continue;
      const next = await pullsOf(gh, repo, child);
      add(nodeOfIssue(next.issue, bot));
      relationships.push({ from: child, to: id, type: RELATIONS.childOf });
      queue.push(next);
    }

    for (const pull of at.pulls) {
      const named = ticketsNamedBy(pull);
      // The one thing about a pull request that halts: a single PR claiming two
      // tickets. Which of them it implements is not something to guess.
      if (named.size > 1) {
        throw new Error(
          `pull request #${pull.number} is tied to ${[...named].map((t) => `#${t}`).join(" and ")}; ` +
          "a pull request implements one ticket",
        );
      }
      // Only an open pull request's threads are counted, and only an open one's
      // are briefed: a thread left unresolved on a merged or abandoned one is
      // nothing a fix round can act on, and counting it would send the ticket
      // to fix-review for ever with nothing to fix. So a closed one reports
      // zero without a query — zero, not nothing: with every pull request
      // merged, an absent count would leave `sum.awaitingFix` undefined and
      // every review trigger reading it false, parking the ticket in review.
      const node = pullNodeOf(
        pull,
        pull.state === "OPEN" ? await countThreads(gh, repo, pull.number) : { openThreads: 0, awaitingFix: 0 },
      );
      add(node);
      relationships.push({ from: node.id, to: id, type: RELATIONS.implements });
    }
  }

  // The ticket's own page, by one file read: exact, where the branch listing
  // `list` makes can come back cut short, and the ticket's own only, because
  // that is all `rel.documents` counts. The spec artifact reads the same file
  // again for its hash — the two run in different phases of the snapshot, and
  // nothing may be carried from one to the other.
  if ((await gh.getFile(PAGES_BRANCH, pagePath(ticket))) !== null) {
    const page = specNode(ticket, await link(ticket, ctx.log));
    add(page);
    relationships.push({ from: page.id, to: ticket, type: RELATIONS.documents });
  }

  return { nodes: [...nodes.values()], relationships };
}

/**
 * The open threads as prose, asked for only when a step is about to run.
 *
 * This is the one place thread text is fetched at all, and it is deliberately
 * not part of THREADS_QUERY: that runs on every converge pass, feeds the
 * graph, and must carry nothing anybody outside this repository wrote. A
 * briefing runs once per invocation and feeds a prompt.
 *
 * `comments(first: 1)` is the finding itself — the thread's opening comment.
 * `lastReply` is the thread's last word, which says whose turn it is (see
 * `answered`): the open list shows it beside the finding, since a person's
 * reply is what the fixer acts on, and the history shows how the argument
 * ended. `totalCount` says whether there was a reply at all.
 */
const BRIEF_QUERY = `
query LandraceBrief($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: ${THREAD_PAGE}, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          path
          line
          comments(first: 1) { totalCount nodes { body author { login } } }
          lastReply: comments(last: 1) { nodes { body author { login } } }
        }
      }
    }
  }
}`;

/** `author` is null for a deleted account, which GitHub shows as "ghost". */
interface BriefComment {
  body: string | null;
  author: { login: string } | null;
}

interface BriefThread {
  id: string;
  isResolved: boolean;
  path: string | null;
  line: number | null;
  comments: { totalCount: number; nodes: BriefComment[] };
  lastReply: { nodes: BriefComment[] };
}

interface BriefResponse {
  repository: {
    pullRequest: {
      reviewThreads: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: BriefThread[] };
    } | null;
  } | null;
}

/** A thread comment as GraphQL answers it, as the kit reads one: a deleted account is no author at all. */
const commentOf = (c: BriefComment | undefined): ThreadComment | null =>
  c === undefined ? null : { body: c.body ?? "", author: c.author?.login ?? null };

/** A review thread as GraphQL answers it, as the kit reads one. */
const threadOf = (t: BriefThread): ReviewThread => ({
  id: t.id,
  resolved: t.isResolved,
  path: t.path,
  line: t.line,
  first: commentOf(t.comments.nodes[0]),
  last: commentOf(t.lastReply.nodes[0]),
  comments: t.comments.totalCount,
});

/** One file of a pull request as REST answers it, as the kit reads one. */
const changedFile = (f: PullFile): ChangedFile => ({
  path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch,
});

/**
 * Every review thread on one pull request, resolved or not, every page.
 *
 * Paged the same way the count is, and for the same reason pointed the other
 * way: asking for the first twenty *threads* on a pull request whose first
 * hundred are resolved would show the fixer nothing while the gate said twenty
 * findings were open — and a step told to address nothing answers "addressed",
 * which spends a round and moves the ticket on with the findings still there.
 */
async function threadsOn(gh: Client, repo: string, number: number): Promise<ReviewThread[]> {
  const [owner = "", name = ""] = repo.split("/");
  const all: ReviewThread[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_THREAD_PAGES; page++) {
    const data: BriefResponse = await gh.graphql<BriefResponse>(BRIEF_QUERY, { owner, name, number, cursor });
    // Same failures the count tells apart, and for the same reason: an
    // empty briefing and an unreadable one look identical to the agent.
    if (!data.repository) throw unseen(repo);
    const threads = data.repository.pullRequest?.reviewThreads;
    if (!threads) throw new Error(`pull request #${number} answered with no review threads at all`);
    all.push(...threads.nodes.map(threadOf));
    if (!threads.pageInfo.hasNextPage) break;
    cursor = threads.pageInfo.endCursor;
  }
  return all;
}

/**
 * The source's briefing: `threads`, what is left to address, and `history`,
 * how the ticket got here. One call makes both, because both are the same
 * pages of the same threads read two ways, and a step naming either pays for
 * the read once.
 */
async function briefTicket(gh: Client, repo: string, ticket: string, snapshot: Snapshot): Promise<Record<string, string>> {
  const pulls = (await pullsOf(gh, repo, ticket)).pulls;
  const read = new Map<number, ReviewThread[]>();
  for (const pull of pulls) read.set(pull.number, await threadsOn(gh, repo, pull.number));
  const open = pulls.filter((p) => p.state === "OPEN");
  const bot = await gh.botLogin();
  const changed: Array<{ number: number; files: ChangedFile[] }> = [];
  for (const pull of open) changed.push({ number: pull.number, files: (await gh.pullFiles(pull.number)).map(changedFile) });
  return {
    threads: threadsBrief(open.map((p) => p.number), read, bot),
    history: historyOf(commentsOf(snapshot), pulls, read, bot),
    diff: diffBrief(changed),
  };
}

/**
 * The ticket's whole history in two halves, each item as the kit renders it:
 * every comment in order, then every review thread on every pull request
 * tied to it, under one heading each. The kit's `historyBrief` is the one
 * timeline a composed hook briefs; this hook keeps its halves until it is
 * built on the kit's bases.
 */
function historyOf(
  comments: SnapshotComment[],
  pulls: Array<{ number: number; state: string }>,
  read: Map<number, ReviewThread[]>,
  bot: string,
): string {
  const said = newest(comments, BRIEF_COMMENTS, "comments", (c) => commentLine(c, bot));
  const conversation = said.kept.length === 0
    ? "No comments on the ticket."
    : said.left + said.kept.map((k) => k.text).join("\n\n");

  const ordered = [...pulls].sort((a, b) => a.number - b.number);
  const raised = newest(
    ordered.flatMap((pull) => (read.get(pull.number) ?? []).map((thread) => ({ pull: pull.number, thread }))),
    BRIEF_HISTORY_THREADS,
    "threads",
    ({ thread }) => threadLine(thread, bot),
  );
  let n = 0;
  const reviews = ordered.length === 0
    ? "No pull request was opened on this ticket."
    : raised.left + ordered.map((pull) => {
      const listed = raised.kept.filter((r) => r.item.pull === pull.number).map((r) => `${++n}. ${r.text}`);
      return `### PR #${pull.number} (${pull.state.toLowerCase()})\n\n${listed.length === 0 ? "Nothing listed." : listed.join("\n\n")}`;
    }).join("\n\n");

  return `## Ticket conversation\n\n${conversation}\n\n## Review threads\n\n${reviews}`;
}

/**
 * pull.review: a step's replies on the threads they name, its prose as one
 * review, a thread per finding, and the reviewer's own threads it lists as
 * addressed resolved.
 *
 * The step is told apart by its route's marker — `fix:{round}` for
 * fix-review, `review:{round}` for code-review — and that kind is what each
 * reply ends in: a `fix` one hands the thread to the person, any other puts
 * it back to awaiting a fix. A fix round replies on any thread and resolves
 * none; a review replies on any, and resolves only its own findings.
 *
 * Each reply is idempotent by its own marker, `{kind}:{stage}:{round}:{thread}`:
 * a thread whose last word is already this one is not answered again.
 *
 * Idempotent by the review's trailing marker, checked on GitHub itself: a
 * step's route effect is applied once, right after the step, and the one way
 * it runs twice is a crash before the record, which re-runs the step at the
 * same round. satisfied() cannot answer this — it sees only the snapshot, and
 * the snapshot carries no reviews.
 *
 * Placement is the kit's `placeFindings`, by what GitHub accepts: a line
 * thread in the review, a thread on the file, or a line in the review's text.
 */
async function applyReview(gh: Client, repo: string, effect: Effect, { snapshot, log }: HookContext): Promise<void> {
  const branch = effectBranch(effect);
  const out = (effect.output ?? {}) as { findings?: unknown; resolved?: unknown; replies?: unknown };
  const findings = Array.isArray(out.findings) ? out.findings : [];
  const replies = Array.isArray(out.replies) ? out.replies.filter(isReply) : [];
  const stage = String(effect.stage ?? "review");
  const round = Number(effect.round ?? 0);
  const marker = String(effect.marker ?? `review:${stage}:${round}`);
  const kind = marker.split(":")[0] || "review";
  const resolved = kind === FIX_KIND || !Array.isArray(out.resolved)
    ? []
    : out.resolved.filter((id): id is string => typeof id === "string");
  const fromBranch = ((snapshot.graph as Graph | undefined)?.nodes ?? []).filter(
    (node) => node.kind === PULL_REQUEST_KIND && node.state.branch === branch,
  );
  const pr = fromBranch.find((node) => node.closed === null);
  const number = Number(/^pr-([1-9][0-9]*)$/.exec(pr?.id ?? "")?.[1]);
  if (!pr || !Number.isInteger(number)) {
    // Merged or closed while the review ran — or a clean review with no
    // pull request left to put it on — is nothing to fix, and halting here
    // would hold a ticket back from `done`. No pull request from the branch
    // at all is a route naming the wrong branch, and that is said.
    if ((findings.length === 0 && resolved.length === 0 && replies.length === 0) || fromBranch.length > 0) {
      log("github.review.nowhere", { branch, findings: findings.length, why: "no open pull request from the branch" });
      return;
    }
    throw new Error(`there is no open pull request from ${branch} to put the review on`);
  }

  const threads = replies.length > 0 || resolved.length > 0
    ? new Map((await threadsOn(gh, repo, number)).map((t) => [t.id, t]))
    : new Map<string, ReviewThread>();

  // Replies first, and the review last: its marker is what says the round
  // is on GitHub, so it lands only once everything else has.
  const bot = replies.length > 0 ? await gh.botLogin() : "";
  for (const reply of replies) {
    const thread = threads.get(reply.thread);
    if (!thread) {
      log("github.review.unrepliable", { thread: reply.thread, why: "no such thread on the pull request" });
      continue;
    }
    const said = `${kind}:${stage}:${round}:${thread.id}`;
    const last = thread.last;
    if (typeof last?.author === "string" && sameLogin(last.author, bot) && parseMarker(last.body)?.marker === said) continue;
    await gh.replyToThread(
      thread.id,
      neutraliseMarkers(cut(reply.body.trim(), MAX_COMMENT_CHARS - 1_000)) + renderMarker({ stage, kind, round, marker: said }),
    );
  }

  const posted = (await gh.listReviews(number)).some((r) => parseMarker(r.body ?? "")?.marker === marker);
  if (!posted) {
    const { onLines, onFiles, unplaced } = placeFindings(findings, (await gh.pullFiles(number)).map(changedFile), stage, round);
    const listed = unplaced.length === 0 ? "" : `\n\nFindings GitHub cannot place on this pull request's diff:\n\n${unplaced.join("\n")}`;
    const body = cut(neutraliseMarkers(String(effect.body ?? "").trim()) + listed, MAX_COMMENT_CHARS - 1_000) +
      renderMarker({ stage, kind, round, marker });
    // File threads first, the review last, for the same reason as the replies.
    const head = typeof pr.state.headSha === "string" ? pr.state.headSha : "";
    for (const f of onFiles) await gh.commentOnFile(number, f.path, f.body, head);
    await gh.postReview(number, body, onLines.map((c): ReviewComment => ({ path: c.path, line: c.line, side: "RIGHT", body: c.body })));
  }

  for (const id of resolved) {
    const thread = threads.get(id);
    if (!thread || parseMarker(thread.first?.body ?? "")?.kind !== FINDING_KIND) {
      // A person's thread is theirs to close, and an id that is not on the
      // pull request is a mistake worth seeing: said, never silently dropped.
      log("github.review.unresolvable", { thread: id, why: thread ? "a person raised it" : "no such thread on the pull request" });
      continue;
    }
    if (!thread.resolved) await gh.resolveThread(id);
  }
}

/* ── the startup preflight ───────────────────────────────────────────────── */

/**
 * A user's fine-grained token had Issues access but Contents read-only.
 * `landrace start` ran, the spec step invoked a paid agent, and only then did
 * publishing the spec fail with a 403 on `POST /git/blobs` — after the money
 * was already spent, with nothing durable recorded to show for it. This is
 * the engine's `preflight` hook kind, run once at startup, before any of
 * that: every probe below stops at the first failure, and every failure names
 * the permission in the words GitHub's own token UI uses.
 *
 * Issues write is deliberately not probed here: a label or a comment is
 * written on entering a stage, before any agent runs, so a missing Issues
 * permission already fails there for free, before any money is spent —
 * probing it here would only pay for a fifth round trip to learn the same
 * thing sooner.
 *
 * Neither is "Pull requests: Read and write", which opening a ticket's pull
 * request and closing a dropped child's both need: there is no harmless pull
 * request write to try. A classic token has it under "repo"; a fine-grained
 * one without it is named by the write itself, as `token needs "Pull
 * requests: Read and write"`. Pushing a branch needs "Contents: Read and
 * write", which the blob write below already proves.
 */
async function checkPermissions(gh: Client, repo: string): Promise<void> {
  // A classic token carries its scopes on every response; a fine-grained one
  // carries none at all, so the header's mere presence is what tells the two
  // apart — not the shape of the token string, which nothing here reads. An
  // empty (or whitespace-only) header counts as absent: `oauthScopes` already
  // folds that case into `null` rather than an empty list, because nothing
  // here can tell "classic, and sent no scopes" apart from "fine-grained, and
  // GitHub happened to send a blank header" — and reading the former would
  // refuse every fine-grained token the day GitHub does that.
  //
  // "repo" only ever skips the *immediate* failure a missing scope already
  // is. Scopes are necessary, not sufficient: a read-only collaborator, a
  // token not SSO-authorised for its org, or an org that blocks classic
  // tokens outright all carry "repo" and still 403 on the write — which is
  // the exact incident this feature exists to catch, so a classic token
  // still runs every probe below.
  const scopes = await gh.oauthScopes();
  if (scopes !== null && !scopes.includes("repo")) {
    throw new Error('classic token is missing the "repo" scope');
  }

  await probeContentsRead(gh, repo);
  await probeContentsWrite(gh, repo);
  await probePullRequestsRead(gh, repo);
}

/**
 * A 401 means GitHub rejected the token itself, before any one permission
 * ever entered into it — checked first in every probe, ahead of anything
 * status-specific, so a bad token is never misreported as missing one
 * particular permission.
 */
function tokenRejected(e: unknown): Error | null {
  const status = (e as { status?: unknown } | null)?.status;
  return status === 401
    ? new Error("token was rejected by GitHub (401) — check that it is valid and not expired")
    : null;
}

/** A 403 on this read is the one failure worth naming; a 404 means the branch or file is simply not there yet. */
async function probeContentsRead(gh: Client, repo: string): Promise<void> {
  try {
    // Any path answers the question. Ticket 0 never exists, so this reads as
    // a 404 on a healthy token rather than risking a real spec directory,
    // which the contents API would answer with a listing `getFile` cannot
    // parse as a file at all.
    await gh.getFile(PAGES_BRANCH, pagePath("0"));
  } catch (e) {
    throw tokenRejected(e) ?? ((e as { status?: unknown } | null)?.status === 403
      ? new Error(`token needs "Contents: Read and write" on ${repo}`)
      : e);
  }
}

/**
 * The one write this whole check makes, and the reason it has to be a write
 * at all: a fine-grained token cannot report its own permissions the way a
 * classic one's scopes header does, so writing is the only way to find out
 * whether it can. An empty, unreferenced blob is the most harmless write
 * available — no branch, tag or commit ever points at it, nothing appears in
 * the GitHub UI, and GitHub garbage-collects it on its own schedule.
 */
async function probeContentsWrite(gh: Client, repo: string): Promise<void> {
  try {
    await gh.createEmptyBlob();
  } catch (e) {
    const rejected = tokenRejected(e);
    if (rejected) throw rejected;
    const status = (e as { status?: unknown } | null)?.status;
    if (status === 403) throw new Error(`token needs "Contents: Read and write" on ${repo}`);
    // A fine-grained token with no access to this repository at all gets a
    // 404 here, not a 403 — GitHub will not confirm a private repository
    // exists to a token nobody has shared it with. The contents-read probe
    // above cannot tell that apart from "not there yet" (both read as 404),
    // so this is the one place the distinction actually surfaces.
    if (status === 404) throw new Error(`token cannot see ${repo} — grant it access to this repository`);
    throw e;
  }
}

/** One minimal GraphQL read, cheap enough to cost nothing beyond what §10's own review-thread reads already pay for. */
const PREFLIGHT_PR_QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 1) { totalCount }
  }
}`;

interface PreflightPrResponse {
  repository: unknown;
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

async function probePullRequestsRead(gh: Client, repo: string): Promise<void> {
  const [owner = "", name = ""] = repo.split("/");
  let data: PreflightPrResponse;
  try {
    data = await gh.graphql<PreflightPrResponse>(PREFLIGHT_PR_QUERY, { owner, name });
  } catch (e) {
    throw prReadFailure(e, repo);
  }
  // A 200 with no errors and a null repository is GitHub's other shape for
  // "this token cannot see it", and here it means the read this probe exists
  // to prove never actually happened.
  if (data.repository === null) {
    throw new Error(
      `pull request check failed: the repository "${repo}" answered with nothing at all; check the token's access to it`,
    );
  }
}

/**
 * The integration, built over one client.
 *
 * Exported so a test can drive the real hooks over a fake `fetch` rather than
 * a second, hand-written imitation of them — a fake that implements something
 * narrower is a fake that lets a leak through the boundary go unnoticed. The
 * module-level hooks below are this same function, called with options read
 * out of the runtime context.
 */
export function githubHooks(opts: GitHubOptions): {
  pre: PreHook;
  post: PostHook;
  source: Source;
  operator: Operator;
  specArtifact: ArtifactHook;
  preflight: Preflight;
} {
  const gh = createClient(opts);
  const link = specLinks(gh, opts.repo);
  const git = opts.git ?? ownGit(hookRepository);
  const push = pusher(git, opts.token, opts.repo);

  return {
    preflight: definePreflight({ id: "github", check: () => checkPermissions(gh, opts.repo) }),

    // Sorts after every other export on purpose: the loader files a module's
    // exports in sorted name order, and an artifact's read wants the tracker's
    // fragment already in the snapshot beside it.
    specArtifact: defineArtifactHook({
      id: SPEC,
      handles: [PUBLISH],
      read: ({ ticket, log }) => readPage(gh, link, ticket, log),
      // Asked only by a step whose prompt names {brief.spec.…}, once per
      // invocation. A failed read throws rather than reading as no page.
      brief: async ({ ticket }) => briefPage(await gh.getFile(PAGES_BRANCH, pagePath(ticket))),
      satisfied: publishSatisfied,
      apply: (effect, { ticket }) => publishPage(gh, effect, ticket),
    }),

    pre: definePreHook({
      id: "github",
      provides: PROVIDES,
      run: ({ ticket }) => readTicket(gh, git, ticket),
    }),

    post: definePostHook({
      id: "github",
      handles: HANDLES,
      satisfied,
      apply: (effect, ctx) =>
        effect.type === PULL_REVIEW_EFFECT ? applyReview(gh, opts.repo, effect, ctx) : applyEffect(gh, push, effect, ctx),
    }),

    source: defineSource({
      id: "github",
      relations: RELATION_DECLS,
      list: (ctx) => listGraph(gh, opts.repo, link, ctx),
      read: (id, ctx) => readGraph(gh, opts.repo, link, id, ctx),
      // The text half, fetched per invocation rather than per pass: what
      // `fix-review` is told to address and what `retro` learns from, which
      // the graph will not carry.
      brief: ({ ticket, snapshot }) => briefTicket(gh, opts.repo, ticket, snapshot),
    }),

    operator: defineOperator({
      id: "github",
      // Both read back through GraphQL, so what an operator is shown is the
      // node `list` and `read` would report, not a second reading beside it.
      createTicket: async ({ title, body, labels, parent, origin, priority }: NewTicket) => {
        // Checked before anything is created, so a bad parent leaves nothing behind.
        const under = parent === undefined ? undefined : issueNumber(parent);
        const created = await gh.createIssue({
          title,
          // Marked under our own login, so the origin reads back as ours — and
          // only ours: a person's issue carrying the same text is nobody's. The
          // agent's body is escaped first, so it cannot bring a marker of its own.
          body: neutraliseMarkers(body ?? "") + (origin ? renderOrigin(origin) : ""),
        });
        if (under !== undefined) {
          try {
            // GitHub links a sub-issue by the child's REST id, not its number.
            await gh.addSubIssue(under, created.id);
          } catch (e) {
            // Unlinked, it is outside the parent's subtree: nothing would ever
            // see it to drop it. It carries no labels yet, so even if this
            // close fails too it is inert — nothing will work it.
            const linkError = e instanceof Error ? e.message : String(e);
            try {
              await gh.closeIssue(created.number, "not_planned");
            } catch (c) {
              throw new Error(
                `${linkError}; and closing the unlinked #${created.number} again failed too: ` +
                `${c instanceof Error ? c.message : String(c)}`,
              );
            }
            throw e;
          }
        }
        // Labelled last: the eligibility label is what lets a tick work it,
        // and only a linked child is one a re-run's cascade can see.
        await gh.addLabels(created.number, priority === undefined ? (labels ?? []) : [...(labels ?? []), `P${priority}`]);
        return nodeOfIssue(await gh.getIssueNode(created.number), await gh.botLogin());
      },

      updateTicket: async (ticket: string, patch: TicketPatch) => {
        const n = issueNumber(ticket);
        const fields: { title?: string; body?: string; state?: string } = {};
        if (patch.title !== undefined) fields.title = patch.title;
        if (patch.body !== undefined) fields.body = patch.body;
        if (patch.state !== undefined) fields.state = patch.state;

        for (const name of patch.removeLabels ?? []) await gh.removeLabel(n, name);
        await gh.addLabels(n, patch.addLabels ?? []);
        if (Object.keys(fields).length) await gh.updateIssue(n, fields);

        return nodeOfIssue(await gh.getIssueNode(n), await gh.botLogin());
      },
    }),
  };
}

/* ── what the loader picks up ───────────────────────────────────────────── */

/**
 * A hook is *handed* its configuration and its secrets rather than
 * constructed with them — that is what keeps it testable and what lets log
 * redaction know every value it must never print — so the client cannot exist
 * until the first call. Built once per config object, which a process loads
 * once, so the login is resolved once too.
 */
const built = new WeakMap<object, ReturnType<typeof githubHooks>>();

function hooksFor(ctx: RuntimeContext): ReturnType<typeof githubHooks> {
  const existing = built.get(ctx.config);
  if (existing) return existing;

  const tracker = ctx.config.tracker as { repo?: unknown; bot?: unknown };
  const repo = typeof tracker?.repo === "string" ? tracker.repo.trim() : "";
  if (!repo) throw new Error('the github hook needs tracker.repo in landrace.yaml, as "owner/name"');

  const token = ctx.secrets.get("githubToken");
  if (!token) throw new Error('the github hook needs a "githubToken" secret declared in landrace.yaml');

  const hooks = githubHooks({
    repo,
    token,
    ...(typeof tracker.bot === "string" ? { bot: tracker.bot } : {}),
  });
  built.set(ctx.config, hooks);
  return hooks;
}

/*
 * Every delegate is async, so a configuration that cannot be read comes back
 * as a rejection rather than a synchronous throw: these are declared to return
 * a promise, and a caller that reaches for `.catch` should get one.
 */
export const pre = definePreHook({
  id: "github",
  provides: PROVIDES,
  run: async (ctx: HookContext) => hooksFor(ctx).pre.run(ctx),
});

export const post = definePostHook({
  id: "github",
  handles: HANDLES,
  // Not delegated: satisfied() is synchronous and reads only the snapshot, so
  // it needs no client and no context to build one from.
  satisfied,
  apply: async (effect: Effect, ctx: HookContext) => hooksFor(ctx).post.apply(effect, ctx),
});

export const source = defineSource({
  id: "github",
  relations: RELATION_DECLS,
  list: async (ctx: RuntimeContext) => hooksFor(ctx).source.list(ctx),
  read: async (id: string, ctx: RuntimeContext) => hooksFor(ctx).source.read(id, ctx),
  brief: async (ctx: HookContext) => {
    const hook = hooksFor(ctx).source;
    if (!hook.brief) throw new Error("the github source briefs nothing");
    return hook.brief(ctx);
  },
});

/**
 * The spec document, on the orphan Pages branch. One object owns both halves —
 * the read the engine files into the observe phase, and the publish it files
 * into the act phase — so nobody can add a write here without the check that
 * says it has already happened.
 */
export const specArtifact = defineArtifactHook({
  id: SPEC,
  handles: [PUBLISH],
  read: async (ctx: HookContext) => hooksFor(ctx).specArtifact.read(ctx),
  brief: async (ctx: HookContext) => {
    const hook = hooksFor(ctx).specArtifact;
    if (!hook.brief) throw new Error("the spec artifact briefs nothing");
    return hook.brief(ctx);
  },
  // Not delegated: it reads the snapshot and hashes a string, so it needs no
  // client and no configuration to build one from.
  satisfied: publishSatisfied,
  apply: async (effect: Effect, ctx: HookContext) => hooksFor(ctx).specArtifact.apply(effect, ctx),
});

export const operator = defineOperator({
  id: "github",
  createTicket: async (input: NewTicket, ctx: RuntimeContext) => hooksFor(ctx).operator.createTicket(input, ctx),
  updateTicket: async (ticket: string, patch: TicketPatch, ctx: RuntimeContext) =>
    hooksFor(ctx).operator.updateTicket(ticket, patch, ctx),
});

/**
 * Run once at startup, before `landrace start` or `landrace mcp` do anything
 * that costs money: see `checkPermissions` for the four checks, in order, and
 * the exact wording each failure produces.
 */
async function check(ctx: RuntimeContext): Promise<void> {
  return hooksFor(ctx).preflight.check(ctx);
}

export const githubPreflight = definePreflight({ id: "github", check });


/** Every GraphQL document this hook sends, so a test can cost each against GitHub's node limit. */
export const GRAPHQL_QUERIES = {
  ISSUE_QUERY, ISSUES_QUERY, CLOSED_QUERY, PULLS_QUERY, CLOSED_PULLS_QUERY, TICKET_QUERY, THREADS_QUERY, BRIEF_QUERY, PREFLIGHT_PR_QUERY,
  RESOLVE_THREAD, REPLY_THREAD,
};
