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
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  allClosed,
  BRANCH_PUSH_EFFECT,
  CLOSE_EFFECT,
  defineArtifactHook,
  defineOperator,
  definePostHook,
  definePreHook,
  definePreflight,
  defineSource,
  DOCUMENT_KIND,
  effectBranch,
  entriesFromComments,
  hasPullFrom,
  isReservedId,
  LABEL_EFFECT,
  LABELS,
  labelsOf,
  MAX_SUBGRAPH_NODES,
  neutraliseMarkers,
  NODES_CLOSE_EFFECT,
  parseMarker,
  parseOrigin,
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
  stripMarker,
  TICKET_KIND,
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
/*
 * `landrace/hooks` resolves here by Node's package self-reference — the same
 * specifier a consumer with landrace installed writes, and the reason this
 * file is a copyable example rather than a repo-shaped one. It points at the
 * built `dist/hooks.js`, so run `pnpm build` before running the CLI out of
 * this repository; the test suite maps it to `src/` so it never waits on a
 * build.
 */

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
 * Runs git with these arguments and this extra environment, in one checkout,
 * and answers its stdout — stopped when `signal` aborts or `timeoutMs` passes.
 */
export type Git = (
  args: string[],
  env?: Record<string, string>,
  opts?: { signal?: AbortSignal | undefined; timeoutMs?: number | undefined },
) => Promise<string>;

const execFileAsync = promisify(execFile);

/**
 * git in `dir`, reporting git's own words rather than a stack trace.
 *
 * The operator's environment is passed through — HOME, an ssh agent, a proxy
 * are all how their git already reaches their remote — with prompting off: a
 * push that wants a password must fail and say so, not wait on a terminal
 * nobody is watching.
 */
export function gitIn(dir: string): Git {
  return async (args, env = {}, { signal, timeoutMs } = {}) => {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd: dir,
        env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" },
        maxBuffer: 16 * 1024 * 1024,
        ...(signal === undefined ? {} : { signal }),
        ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
      });
      return stdout;
    } catch (e) {
      const what = `git ${args[0] ?? ""} in ${dir}`;
      if (signal?.aborted) throw new Error(`${what} was aborted`);
      if ((e as { killed?: unknown }).killed === true && timeoutMs !== undefined) {
        throw new Error(`${what} did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped`);
      }
      const stderr = String((e as { stderr?: unknown }).stderr ?? "").trim();
      throw new Error(`${what}: ${stderr || (e instanceof Error ? e.message : String(e))}`);
    }
  };
}

/**
 * The repository this file is in: for a project's `.landrace/hooks/`, that
 * project — whatever directory the process was started from.
 *
 * `import.meta.dirname` is the obvious spelling and cannot be written here:
 * ts-jest's default pass compiles this file as CommonJS and refuses
 * `import.meta` outright (TS1343; see tests/hooks/claude.test.ts). The file
 * name V8 records for this very frame is the same fact, in either module
 * system — a path under jest, a file: URL under node.
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
  const here = dirname(file.startsWith("file:") ? fileURLToPath(file) : file);
  return (await gitIn(here)(["rev-parse", "--show-toplevel"])).trim();
}

/** git in the hook's own repository, found the first time it is needed. */
function ownGit(): Git {
  let root: Promise<string> | undefined;
  return async (args, env, opts) => {
    root ??= hookRepository();
    return gitIn(await root)(args, env, opts);
  };
}

/** A 404 from the API, told apart from every other failure by its status rather than by its text. */
const isMissing = (e: unknown): boolean => (e as { status?: unknown } | null)?.status === 404;

/**
 * The most GitHub will take in an issue comment body. Its number, so it lives
 * here: a Jira hook's is 32,767, and an engine that knew either of them would
 * be an engine that knows which tracker it is driving.
 *
 * The engine's own bound is `recordBodyProblem` in src/conventions.ts, which
 * is lower and tracker-agnostic, and which rejects at the step boundary where
 * the refusal is *recorded* on the ticket. This is the backstop under it — for
 * the bodies the engine does not compose, an operator's own `landrace_reply`
 * among them — and it reports the size rather than letting the API answer 422
 * to a request that should never have gone out.
 */
const MAX_COMMENT_CHARS = 65_536;

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

interface SnapshotComment {
  body?: string;
  user?: { login?: string } | null;
}

const commentsOf = (s: Snapshot): SnapshotComment[] =>
  ((s.ticket as { comments?: SnapshotComment[] })?.comments ?? []);

/**
 * Who we post as, as the pre hook recorded it this tick. satisfied() is
 * synchronous by contract, so it cannot resolve the login itself; the
 * snapshot is where the state a decision reads belongs anyway.
 *
 * Absent means we cannot tell whether an effect has landed, and the two ways
 * of guessing are both wrong: "satisfied" silently drops the work, "not
 * satisfied" re-posts a comment on every tick. Halting is the third option,
 * and the dispatcher attributes the throw to this hook.
 */
function botLoginOf(s: Snapshot): string {
  const bot = (s.tracker as { bot?: unknown } | undefined)?.bot;
  if (typeof bot !== "string" || !bot.trim()) {
    throw new Error("the snapshot does not record the login landrace posts as, so no effect can be checked");
  }
  return bot.trim().toLowerCase();
}

/** sameLogin, for the reason entriesFromComments uses it: an app has two spellings. */
const wroteIt = (c: SnapshotComment, bot: string): boolean =>
  typeof c.user?.login === "string" && sameLogin(c.user.login, bot);

function satisfied(snapshot: Snapshot, effect: Effect): boolean {
  // The labels the source read, not a second copy of them from the pre hook:
  // one reading of the ticket, which is the one the engine placed it from.
  const present = labelsOf(snapshot.node as Node | undefined);
  switch (effect.type) {
    // The two label cases read labels, which only an account with write
    // access can set — unlike a comment, which anyone can post. Forging one
    // is the operator-tools problem (lr: labels are refused there), not an
    // authorship question this hook can answer.
    case LABEL_EFFECT: {
      const add = (effect.add as string[]) ?? [];
      const remove = (effect.remove as string[]) ?? [];
      return add.every((l) => present.includes(l)) && remove.every((l) => !present.includes(l));
    }
    case STATUS_EFFECT:
      // GitHub has no status field; position is a stage label.
      return present.includes(LABELS.stage(String(effect.value)));
    case RECORD_EFFECT: {
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
    case NODES_CLOSE_EFFECT:
      return allClosed(snapshot.graph as Graph | undefined, (effect.ids as string[] | undefined) ?? []);
    case CLOSE_EFFECT:
      // Closed either way counts: a person who closed it as not planned
      // decided that, and re-closing it as completed would overrule them.
      return ((snapshot.node as Node | undefined)?.closed ?? null) !== null;
    case BRANCH_PUSH_EFFECT: {
      // Done when origin's head, as this checkout last saw it, is the local
      // one. A branch the checkout does not have has nothing to publish —
      // pushing it would fail, not push — so that is done too.
      const branch = effectBranch(effect);
      const { local, remote } = headsOf(snapshot);
      const head = headIn(local, branch);
      return head === undefined || headIn(remote, branch) === head;
    }
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

/**
 * The branch heads the pre hook read this pass. Absent is a halt, for the
 * reason botLoginOf gives: "satisfied" would drop a push that never happened,
 * and "not satisfied" would push on every tick.
 */
function headsOf(s: Snapshot): { local: Record<string, unknown>; remote: Record<string, unknown> } {
  const git = s.git as { local?: unknown; remote?: unknown } | undefined;
  const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
  if (!git || !isMap(git.local) || !isMap(git.remote)) {
    throw new Error("the snapshot does not record this checkout's branches, so no push can be checked");
  }
  return { local: git.local, remote: git.remote };
}

/** One branch's head out of a map a snapshot carried, own keys only: a branch called "constructor" is still a branch. */
const headIn = (heads: Record<string, unknown>, branch: string): string | undefined =>
  Object.hasOwn(heads, branch) && typeof heads[branch] === "string" ? heads[branch] : undefined;

/**
 * Every local branch head, and every head origin had when this checkout last
 * heard from it — out of the checkout's own refs, never the network. A
 * remote-tracking ref is exactly what a push moves, so the pass after
 * `branch.push` reads its own push back from here.
 *
 * ponytail: every branch, on every pass, into the snapshot. A repository with
 * thousands of branches pays for all of them each time; narrow this to the
 * branches the workflow's effects name if one ever does.
 */
async function branchHeads(git: Git): Promise<{ local: Record<string, string>; remote: Record<string, string> }> {
  const out = await git(["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads", "refs/remotes/origin"]);
  const local: Record<string, string> = {};
  const remote: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const [ref = "", sha = ""] = line.split("\0");
    const into = ref.startsWith("refs/heads/") ? local : ref.startsWith("refs/remotes/origin/") ? remote : null;
    const name = ref.replace(/^refs\/(heads|remotes\/origin)\//, "");
    // origin/HEAD points at a branch rather than being one, and a reserved
    // key is a prototype write rather than a name.
    if (into === null || sha === "" || name === "HEAD" || isReservedId(name)) continue;
    into[name] = sha;
  }
  return { local, remote };
}

/** How long one push may take before it is stopped: it holds the ticket's lock while it runs. */
const PUSH_TIMEOUT_MS = 5 * 60_000;

/**
 * What a publishing effect says when there is nothing on the branch to
 * publish. The push checks for it and GitHub answers it to `pull.open`, so
 * both say it in one sentence: a halt that clears itself once somebody
 * commits, because the next tick asks again.
 */
const nothingCommitted = (branch: string, ticket: string): Error =>
  new Error(
    `nothing was committed on ${branch} for #${ticket}: it is already part of origin's default branch, so ` +
    "there is nothing to push or propose. Commit to the branch and the next tick carries on",
  );

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
 * Publish one branch to origin, fast-forward only.
 *
 * To exactly one destination. `git push origin` pushes to every push URL
 * origin has, and a step that may write shares this repository's config, so
 * one more pushurl is one line away. An origin with anything but one push
 * URL — `git remote get-url --push --all`, after every rewrite a config could
 * apply — is refused before anything else is built.
 *
 * The token goes into the push's environment only when that one URL is an
 * https URL on github.com naming this very repository. An ssh origin, one
 * whose URL carries its own credentials, or one on another host is pushed
 * with the operator's own credentials and no token at all; a GitHub origin
 * naming some other repository is refused, since its branch could never be
 * the head of a pull request here.
 *
 * With the token, it rides in git's environment and never on its command
 * line: argv is readable by every process on the machine. `GIT_CONFIG_*` is
 * git's own way to take configuration from the environment — appended after
 * any the operator already set. The header is scoped to that exact URL, not
 * to github.com, so no other destination that slipped in would be handed it;
 * an empty value first clears a header some other tool left configured (a CI
 * checkout does), and credential helpers and askpass are cleared so nothing
 * git would start to ask for credentials sees the token either.
 *
 * Hooks are off for every push. A step that may write can point
 * core.hooksPath at a script of its own, and a pre-push or
 * reference-transaction hook runs inside this very environment. The push is
 * the one branch and nothing more: an explicit refspec makes git ignore
 * `remote.origin.push`, a mirror remote refuses one outright, and following
 * tags or pushing submodules is switched off here rather than left to config.
 * Whatever git says back is scrubbed of both spellings of the token before
 * it becomes an error, a log line or a comment.
 *
 * Never forced: a branch origin has moved on is somebody else's work, and
 * the way through it is a person's.
 */
function pusher(git: Git, token: string, repo: string): (branch: string, ticket: string, signal: AbortSignal) => Promise<void> {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  const scrub = (text: string): string => text.replaceAll(token, "[redacted]").replaceAll(basic, "[redacted]");
  return async (branch, ticket, signal) => {
    const urls = (await git(["remote", "get-url", "--push", "--all", "origin"], {}, { signal }))
      .split("\n").map((u) => u.trim()).filter(Boolean);
    const [url] = urls;
    if (urls.length !== 1 || url === undefined) {
      throw new Error(
        `refusing to push ${branch}: origin has ${urls.length} push URLs, and landrace pushes a ticket's branch ` +
        "to exactly one destination — the one it can check. Leave origin a single push URL " +
        "(git remote set-url --push origin <url>) and the ticket carries on",
      );
    }
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
    const withToken = remote?.https === true;

    // Nothing to publish either when origin already has everything the
    // branch has: a person's push, or the forge's "Update branch", moved it on
    // and a fetch brought the news. A fast-forward-only push of it would be
    // refused, on every tick, over commits that are already there.
    const theirs = `refs/remotes/origin/${branch}`;
    if ((await git(["for-each-ref", "--format=%(objectname)", theirs], {}, { signal })).trim() !== "") {
      const contained = await git(["merge-base", "--is-ancestor", `refs/heads/${branch}`, theirs], {}, { signal })
        .then(() => true, () => false);
      if (contained) return;
    }

    // Nothing to publish: the branch is origin's default branch, or behind
    // it. Asked of refs this checkout already has — origin/HEAD, as the clone
    // or `git remote set-head` left it — and skipped when it has none;
    // GitHub's own answer to `pull.open` says the same thing then.
    const base = (await git(["for-each-ref", "--format=%(objectname)", "refs/remotes/origin/HEAD"], {}, { signal })).trim();
    if (base !== "") {
      const ahead = (await git(["rev-list", "--count", `${base}..refs/heads/${branch}`], {}, { signal })).trim();
      if (ahead === "0") throw nothingCommitted(branch, ticket);
    }

    const config: Array<[string, string]> = [
      ["core.hooksPath", "/dev/null"], ["push.followTags", "false"], ["push.recurseSubmodules", "no"],
    ];
    if (withToken) {
      const header = `http.${url}.extraheader`;
      config.push(
        [header, ""], [header, `AUTHORIZATION: basic ${basic}`], ["credential.helper", ""], ["core.askPass", ""],
      );
    }
    const at = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? "", 10) || 0;
    const env: Record<string, string> = { GIT_CONFIG_COUNT: String(at + config.length) };
    for (const [i, [key, value]] of config.entries()) {
      env[`GIT_CONFIG_KEY_${at + i}`] = key;
      env[`GIT_CONFIG_VALUE_${at + i}`] = value;
    }

    try {
      await git(["push", "origin", `refs/heads/${branch}:refs/heads/${branch}`], env, { signal, timeoutMs: PUSH_TIMEOUT_MS });
    } catch (e) {
      const said = scrub(e instanceof Error ? e.message : String(e));
      const behind = /non-fast-forward|fetch first/i.test(said)
        ? ` — origin's ${branch} has commits this checkout does not, and landrace does not force-push; ` +
          "bring the branch up to date by hand and the ticket carries on"
        : "";
      throw new Error(`could not push ${branch} to origin${behind}: ${said}`);
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
 * The artifact this hook owns, and the effect type it answers. One name, used
 * for the snapshot path, the effect's `artifact` field and the hook's id: the
 * engine nests an artifact's state under the hook's own id, so a second
 * spelling here would be a path no workflow could read.
 */
const SPEC = "spec";
const PUBLISH = "artifact.publish";

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

/**
 * The same page as the graph reports it: a document beside its ticket, so the
 * board can draw it. Derived from the ticket like the path and the url, so
 * there is nothing to remember about it — and nothing routes on it: what the
 * workflow reads is `artifacts.spec`, below, exactly as before.
 */
const specNode = (ticket: string, link: string): Node => ({
  id: `spec-${ticket}`,
  kind: DOCUMENT_KIND,
  title: "Spec",
  link,
  closed: null,
  priority: null,
  origin: null,
  state: {},
});

const hashOf = (content: string): string => createHash("sha256").update(content).digest("hex");

/**
 * What this publish puts on the page.
 *
 * An empty body is refused rather than published: an empty document would
 * hash, satisfy and read back perfectly well, so the stage would complete and
 * the reviewer would be sent to a blank page with nothing saying why.
 */
function contentOf(effect: Effect): string {
  const body = typeof effect.body === "string" ? effect.body : "";
  if (!body.trim()) throw new Error(`a "${PUBLISH}" effect for "${SPEC}" carried no content to publish`);
  return body;
}

/** Refuses a publish addressed to an artifact this hook does not own, rather than writing it to the spec's path. */
function mine(effect: Effect): void {
  if (effect.artifact !== SPEC) {
    throw new Error(`this hook publishes the "${SPEC}" artifact, not "${String(effect.artifact)}"`);
  }
}

async function readPage(gh: Client, link: SpecLink, ticket: string, log: HookContext["log"]): Promise<Record<string, unknown>> {
  const content = await gh.getFile(PAGES_BRANCH, pagePath(ticket));
  // `exists` and a content hash are the whole state: presence is what a
  // precondition reads, and the hash is what makes a republish a no-op.
  return { exists: content !== null, hash: content === null ? null : hashOf(content), url: await link(ticket, log) };
}

/** What a step is told when there is no page to hand it — said, so the prompt never shows a bare placeholder. */
const NO_SPEC = "No spec has been published for this ticket.";

/**
 * The page's own text, for a step to work from — the prose half of the
 * artifact, beside `readPage`'s state.
 *
 * Handed over as text rather than as a link. A link sends the agent off to
 * fetch something, which a prompt screener rightly reads as an injection
 * vector and which, in a private repository, it could not have opened in the
 * first place. Escaping and the size bound are the engine's, applied to every
 * briefing on the way in; a failed read throws, because "the spec could not
 * be read" and "there is no spec" are different things to tell a build.
 */
async function briefPage(gh: Client, ticket: string): Promise<Record<string, string>> {
  const content = await gh.getFile(PAGES_BRANCH, pagePath(ticket));
  return { content: content ?? NO_SPEC };
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

/**
 * Idempotence, without a ledger: the page's own content hash, as this tick
 * read it, against the hash of what we are about to publish.
 *
 * Absent state is neither yes nor no. "Satisfied" would silently drop the
 * publish and complete a stage with nothing published; "not satisfied" would
 * republish on every tick. Halting is the third option, exactly as for a
 * missing bot login.
 */
function publishSatisfied(snapshot: Snapshot, effect: Effect): boolean {
  mine(effect);
  const state = (snapshot.artifacts as Record<string, { hash?: unknown }> | undefined)?.[SPEC];
  if (state === undefined || state === null) {
    throw new Error(`the snapshot has no artifacts.${SPEC} state, so no publish of it can be checked`);
  }
  return state.hash === hashOf(contentOf(effect));
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

/**
 * Derived from the ticket, never stored — the same rule the spec's path
 * follows. There is no PR id to remember and nothing to repair: the branch
 * names the ticket, and every pull request with that head is its work.
 */
const prBranch = (ticket: string): string => `landrace/${ticket}`;

/** The ticket a head branch names, when it is one of ours. */
const ticketOfBranch = (head: string): string | null => /^landrace\/([1-9][0-9]*)$/.exec(head)?.[1] ?? null;

/** Every relationship type this source reports; a node has one parent, a pull request one ticket, a page one ticket. */
const RELATION_DECLS: RelationDecl[] = [
  { type: RELATIONS.childOf, singular: true },
  { type: RELATIONS.implements, singular: true },
  { type: RELATIONS.documents, singular: true },
];

/**
 * GitHub's own page size for a connection, and how many pages one read will
 * pay for. A count that stopped at the first page would read a 150-thread pull
 * request as having fewer findings than it has — and, with the first hundred
 * resolved, as having none at all, which is a ticket leaving the review loop
 * with open findings on it. Past the cap the honest answer is that the count
 * could not be read, not a number we know is short.
 */
const THREAD_PAGE = 100;
const MAX_THREAD_PAGES = 10;

/** The same bound on the issue and pull request lists, for the same reason: the REST list this replaced stopped at 100 without saying so. */
const ISSUE_PAGE = 100;
const MAX_ISSUE_PAGES = 10;

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

// ponytail: a constant, not a setting — tracker config if another window is ever wanted.
/** How far back the board's Done lane reaches. Display only: tick works open tickets alone. */
const DONE_WINDOW_MS = 30 * 86_400_000;

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

/**
 * How many sub-issues, and pull requests each way, one ticket read carries.
 * Every one of them is counted by the workflow — "every child closed", "every
 * pull request merged" — so a ticket with more than this is refused by
 * `read` rather than read as one with fewer.
 */
const TICKET_PAGE = 50;

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

const PRIORITY_LABEL = /^P([0-9])$/;

/**
 * `P0`..`P9`, the convention this repository's labels use. Two of them is a
 * ticket whose priority cannot be told — reported, like two stage labels,
 * rather than resolved by taking the first.
 */
function priorityFromLabels(labels: string[]): { priority: number | null; found: string[] } {
  const found = labels.filter((l) => PRIORITY_LABEL.test(l));
  const only = found.length === 1 ? found[0] : undefined;
  return { priority: only === undefined ? null : Number(PRIORITY_LABEL.exec(only)?.[1]), found };
}

/**
 * The one mapping from a GitHub issue to a ticket node. `bot` is the login we
 * post as: an origin counts only in a body we wrote, because a re-run closes
 * whatever claims it.
 */
export function nodeOfIssue(issue: IssueNode, bot: string): Node {
  const labels = issue.labels.nodes.map((l) => l.name);
  return {
    id: String(issue.number),
    kind: TICKET_KIND,
    title: issue.title,
    link: issue.url,
    closed: closedOf(issue),
    priority: priorityFromLabels(labels).priority,
    // Nobody but us may have touched the body since: a person keeps the
    // bot's authorship when they edit it, and could otherwise rewrite the
    // marker to claim another stage or round.
    origin: issue.editor && !sameLogin(issue.editor.login, bot)
      ? null
      : parseOrigin(issue.body ?? "", issue.author?.login, bot),
    // Always lists, and empty rather than absent: an eligibility rule reading
    // a path the node does not carry is one the tick cannot answer, and it
    // abstains on those — so an unassigned ticket would be worked by every
    // instance instead of none.
    state: { labels, assignees: issue.assignees.nodes.map((a) => a?.login ?? "").filter(Boolean) },
    ...createdAtOf(issue.createdAt),
  };
}

/** The board's "opened 3h ago": absent, not NaN, when GitHub gave no parseable time. */
function createdAtOf(at: string | undefined): { createdAt?: number } {
  const ms = at === undefined ? NaN : Date.parse(at);
  return Number.isNaN(ms) ? {} : { createdAt: ms };
}

function pullNodeOf(pull: PullNode, threads?: ThreadCounts): Node {
  return {
    id: `pr-${pull.number}`,
    kind: PULL_REQUEST_KIND,
    title: pull.title,
    link: pull.url,
    closed: pull.merged ? "done" : pull.state === "CLOSED" ? "dropped" : null,
    priority: null,
    origin: null,
    // The head branch, so `pull.open` can tell one branch's pull request from
    // another's: a ticket has as many as its workflow's stages name. Not for
    // a fork's, whose branch is in another repository and could carry any
    // name — ours included — and so stand in for the one we would open.
    state: {
      merged: pull.merged,
      headSha: pull.headRefOid,
      ...(pull.isCrossRepository ? {} : { branch: pull.headRefName }),
      ...threads,
    },
    ...createdAtOf(pull.createdAt),
  };
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

/** What a pull request node says of its threads: how many are unresolved, and how many of those await a fix. */
interface ThreadCounts {
  openThreads: number;
  awaitingFix: number;
}

/**
 * How many review threads on one pull request nobody has resolved, and how
 * many of those await a fix, every page of them, or a refusal — never a
 * number known to be short.
 */
async function countThreads(gh: Client, repo: string, number: number): Promise<ThreadCounts> {
  const [owner = "", name = ""] = repo.split("/");
  const bot = await gh.botLogin();
  let cursor: string | null = null;
  const counts: ThreadCounts = { openThreads: 0, awaitingFix: 0 };

  for (let page = 0; page < MAX_THREAD_PAGES; page++) {
    const data: ThreadsResponse = await gh.graphql<ThreadsResponse>(THREADS_QUERY, { owner, name, number, cursor });
    if (!data.repository) throw unseen(repo);
    const threads = data.repository.pullRequest?.reviewThreads;
    if (!threads) throw new Error(`pull request #${number} answered with no review threads at all`);
    for (const t of threads.nodes) {
      if (t.isResolved) continue;
      counts.openThreads++;
      if (!answered(t.lastReply.nodes[0], bot)) counts.awaitingFix++;
    }
    if (!threads.pageInfo.hasNextPage) return counts;
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
 * What the briefing carries, and it is not the same bound as the count's.
 *
 * Twenty findings is more than any one fix round can honestly address, and a
 * thousand characters is a long review comment. The count stays exact however
 * many there are — that is the gate — while the text is a working list, cut
 * with a line saying how much was left out so the agent is never told there
 * are three findings when there are fifty.
 */
const BRIEF_THREADS = 20;
const BRIEF_BODY_CHARS = 1000;

/**
 * The history's bounds: the newest of each kept, since the latest correction
 * is the one a retro most needs to see, with the older ones counted aloud.
 */
const BRIEF_COMMENTS = 60;
const BRIEF_HISTORY_THREADS = 40;

/**
 * And what each of its two halves may spend. The engine cuts a hook's whole
 * briefing at 32 KB from the end, which on a long history would drop the
 * newest comments and every review thread first — the opposite of what the
 * retro needs. Two halves this size, and the short `threads` beside them
 * when the review has settled, stay inside it.
 */
const BRIEF_HISTORY_HALF_CHARS = 14_000;

/**
 * The open threads as prose, asked for only when a step is about to run.
 *
 * This is the one place thread text is fetched at all, and it is deliberately
 * not part of THREADS_QUERY: that runs on every converge pass, feeds the
 * graph, and must carry nothing anybody outside this repository wrote. A
 * briefing runs once per invocation and feeds a prompt.
 *
 * `comments(first: 1)` is the finding itself — the thread's opening comment.
 * The replies under it are the argument about the finding, including the
 * fixer's own from last round, and a fixer re-reading its own reply is how a
 * round loops without moving. So the open list shows the opening comment
 * alone; `lastReply` is the history's, which shows how the argument ended,
 * and `totalCount` says whether there was one at all.
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

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

/** "src/x.ts:12", "src/x.ts", or nothing at all — GitHub cannot always place a thread. */
const where = (thread: BriefThread): string =>
  thread.path === null ? "" : `${thread.path}${thread.line === null ? "" : `:${thread.line}`} — `;

/**
 * Every review thread on one pull request, resolved or not, every page.
 *
 * Paged the same way the count is, and for the same reason pointed the other
 * way: asking for the first twenty *threads* on a pull request whose first
 * hundred are resolved would show the fixer nothing while the gate said twenty
 * findings were open — and a step told to address nothing answers "addressed",
 * which spends a round and moves the ticket on with the findings still there.
 */
async function threadsOn(gh: Client, repo: string, number: number): Promise<BriefThread[]> {
  const [owner = "", name = ""] = repo.split("/");
  const all: BriefThread[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_THREAD_PAGES; page++) {
    const data: BriefResponse = await gh.graphql<BriefResponse>(BRIEF_QUERY, { owner, name, number, cursor });
    // Same failures the count tells apart, and for the same reason: an
    // empty briefing and an unreadable one look identical to the agent.
    if (!data.repository) throw unseen(repo);
    const threads = data.repository.pullRequest?.reviewThreads;
    if (!threads) throw new Error(`pull request #${number} answered with no review threads at all`);
    all.push(...threads.nodes);
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
  const read = new Map<number, BriefThread[]>();
  for (const pull of pulls) read.set(pull.number, await threadsOn(gh, repo, pull.number));
  const open = pulls.filter((p) => p.state === "OPEN");
  return {
    threads: openThreads(open, read),
    history: historyOf(commentsOf(snapshot), pulls, read, await gh.botLogin()),
    diff: await diffOf(gh, open),
  };
}

/**
 * The open review threads across every open pull request on the ticket,
 * rendered for a prompt under one `## PR #N` heading each.
 */
function openThreads(open: PullNode[], read: Map<number, BriefThread[]>): string {
  if (open.length === 0) return "There is no pull request open on this ticket, so there is nothing to address.";

  let listed = 0;
  let more = 0;
  const sections: string[] = [];

  for (const pull of open) {
    const shown: BriefThread[] = [];
    for (const thread of read.get(pull.number) ?? []) {
      if (thread.isResolved) continue;
      if (listed < BRIEF_THREADS) {
        shown.push(thread);
        listed++;
      } else {
        more++;
      }
    }
    if (shown.length > 0) {
      sections.push(`## PR #${pull.number}\n\n${shown.map((thread, i) => {
        const opening = thread.comments.nodes[0]?.body ?? "";
        // The id is what a reviewer lists to resolve a thread, and only its
        // own may be: ours by the finding marker pull.review stamped.
        const ours = parseMarker(opening)?.kind === FINDING_KIND ? "(raised by the reviewer) " : "";
        return `${i + 1}. [thread ${thread.id}] ${where(thread)}${ours}${cut(stripMarker(opening).trim(), BRIEF_BODY_CHARS)}`;
      }).join("\n\n")}`);
    }
  }

  if (listed === 0) return "No review thread on the ticket's pull requests is open. Nothing here needs addressing.";

  // Said out loud rather than left implicit: an agent shown twenty of fifty
  // findings and told nothing would report the pull request addressed.
  const tail = more === 0
    ? ""
    : `\n\n(${more} more open threads are not listed here. Address what is above; the rest come back next round.)`;

  return sections.join("\n\n") + tail;
}

/** How much of the diff a reviewer's prompt carries; the rest is named, to read in the worktree. */
const BRIEF_DIFF_CHARS = 24_000;

/**
 * What the ticket's open pull requests change, file by file, for a reviewer
 * that has no shell to run `git diff` with. Files past the budget are listed
 * by name rather than dropped silently.
 */
async function diffOf(gh: Client, open: PullNode[]): Promise<string> {
  if (open.length === 0) return "No pull request is open on this ticket, so there is no diff to review.";
  const parts: string[] = [];
  const unshown: string[] = [];
  let spent = 0;
  for (const pull of open) {
    const files = await gh.pullFiles(pull.number);
    parts.push(`## PR #${pull.number} — ${files.length} files changed`);
    for (const f of files) {
      const text = `### ${f.filename} (${f.status}, +${f.additions} −${f.deletions})\n\n` +
        (f.patch === undefined ? "(no textual diff: binary, or too large for GitHub to show)" : "```diff\n" + f.patch + "\n```");
      if (spent + text.length > BRIEF_DIFF_CHARS) {
        unshown.push(`- ${f.filename} (+${f.additions} −${f.deletions})`);
        continue;
      }
      spent += text.length;
      parts.push(text);
    }
  }
  const tail = unshown.length === 0
    ? ""
    : `\n\n${unshown.length} more changed files are not shown here; read them in the worktree:\n${unshown.join("\n")}`;
  return parts.join("\n\n") + tail;
}

/** The marker kind a finding's thread ends with: how a reviewer's own thread is told from a person's. */
const FINDING_KIND = "finding";

/** The marker kind of fix-review's route, and of each reply it posts: the fixer has answered, and the thread is the person's turn. */
const FIX_KIND = "fix";

/**
 * Whether a thread's last word is the fixer's answer — ours, by login and
 * marker both, since anyone with comment access can paste a marker. Anything
 * else last, or no reply at all, is a thread awaiting a fix.
 */
const answered = (last: BriefComment | undefined, bot: string): boolean =>
  typeof last?.author?.login === "string" && sameLogin(last.author.login, bot) &&
  parseMarker(last.body ?? "")?.kind === FIX_KIND;

interface Finding {
  file: string;
  line: number;
  body: string;
}

const isFinding = (f: unknown): f is Finding => {
  const x = f as Partial<Finding> | null;
  return typeof x === "object" && x !== null && typeof x.file === "string" && x.file !== "" &&
    Number.isInteger(x.line) && (x.line ?? 0) > 0 && typeof x.body === "string" && x.body.trim() !== "";
};

/**
 * The new-side lines a patch shows — added or unchanged context — which are
 * the lines GitHub takes a line comment on. A removed line has no new-side
 * number, and a line outside every hunk is not in the diff at all.
 */
function commentableLines(patch: string | undefined): Set<number> {
  const lines = new Set<number>();
  let next = 0;
  for (const row of (patch ?? "").split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (next === 0 || row.startsWith("-") || row.startsWith("\\")) continue;
    lines.add(next++);
  }
  return lines;
}

/**
 * pull.review: the reviewer's prose as one review, a thread per finding, and
 * the reviewer's own threads it lists as addressed resolved.
 *
 * Idempotent by the review's trailing marker, checked on GitHub itself: a
 * step's route effect is applied once, right after the step, and the one way
 * it runs twice is a crash before the record, which re-runs the step at the
 * same round. satisfied() cannot answer this — it sees only the snapshot, and
 * the snapshot carries no reviews.
 *
 * Placement follows what GitHub accepts: a finding on a line the diff shows is
 * a line thread in the review; one elsewhere in a changed file is a thread on
 * the file, naming the line; one in a file the pull request does not touch
 * cannot be threaded at all, and is listed in the review's text instead. A
 * malformed finding is listed the same way rather than failing the step — the
 * engine checks an output's fields, not what is inside them.
 */
async function applyReview(gh: Client, repo: string, effect: Effect, { snapshot, log }: HookContext): Promise<void> {
  const branch = effectBranch(effect);
  const out = (effect.output ?? {}) as { findings?: unknown; resolved?: unknown };
  const findings = Array.isArray(out.findings) ? out.findings : [];
  const resolved = Array.isArray(out.resolved) ? out.resolved.filter((id): id is string => typeof id === "string") : [];
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
    if ((findings.length === 0 && resolved.length === 0) || fromBranch.length > 0) {
      log("github.review.nowhere", { branch, findings: findings.length, why: "no open pull request from the branch" });
      return;
    }
    throw new Error(`there is no open pull request from ${branch} to put the review on`);
  }
  const stage = String(effect.stage ?? "review");
  const round = Number(effect.round ?? 0);
  const marker = String(effect.marker ?? `review:${stage}:${round}`);

  const posted = (await gh.listReviews(number)).some((r) => parseMarker(r.body ?? "")?.marker === marker);
  if (!posted) {
    const changed = new Map((await gh.pullFiles(number)).map((f) => [f.filename, commentableLines(f.patch)]));
    const onLines: ReviewComment[] = [];
    const onFiles: Array<{ path: string; body: string }> = [];
    const unplaced: string[] = [];
    findings.forEach((f, i) => {
      if (!isFinding(f)) {
        unplaced.push(`- ${neutraliseMarkers(cut(typeof f === "string" ? f : JSON.stringify(f) ?? String(f), BRIEF_BODY_CHARS))}`);
        return;
      }
      const tail = renderMarker({ stage, kind: FINDING_KIND, round, marker: `${FINDING_KIND}:${stage}:${round}:${i}` });
      const text = neutraliseMarkers(cut(f.body.trim(), MAX_COMMENT_CHARS - 1_000));
      const lines = changed.get(f.file);
      if (lines?.has(f.line)) onLines.push({ path: f.file, line: f.line, side: "RIGHT", body: text + tail });
      else if (lines) onFiles.push({ path: f.file, body: `line ${f.line}: ${text}${tail}` });
      else unplaced.push(`- \`${f.file}:${f.line}\` — ${text}`);
    });
    const listed = unplaced.length === 0 ? "" : `\n\nFindings GitHub cannot place on this pull request's diff:\n\n${unplaced.join("\n")}`;
    const body = cut(neutraliseMarkers(String(effect.body ?? "").trim()) + listed, MAX_COMMENT_CHARS - 1_000) +
      renderMarker({ stage, kind: "review", round, marker });
    // File threads first, the review last: the review's marker is what says
    // this round is on GitHub, so it lands only once everything else has.
    const head = typeof pr.state.headSha === "string" ? pr.state.headSha : "";
    for (const f of onFiles) await gh.commentOnFile(number, f.path, f.body, head);
    await gh.postReview(number, body, onLines);
  }

  if (resolved.length === 0) return;
  const threads = new Map((await threadsOn(gh, repo, number)).map((t) => [t.id, t]));
  for (const id of resolved) {
    const thread = threads.get(id);
    if (!thread || parseMarker(thread.comments.nodes[0]?.body ?? "")?.kind !== FINDING_KIND) {
      // A person's thread is theirs to close, and an id that is not on the
      // pull request is a mistake worth seeing: said, never silently dropped.
      log("github.review.unresolvable", { thread: id, why: thread ? "a person raised it" : "no such thread on the pull request" });
      continue;
    }
    if (!thread.isResolved) await gh.resolveThread(id);
  }
}

/**
 * The newest of a list, rendered, oldest first: at most `keep` of them and
 * no more text than one half of the history may spend — and the line saying
 * how many earlier ones were left out.
 */
function newest<T>(all: T[], keep: number, what: string, render: (item: T) => string): { kept: Array<{ item: T; text: string }>; left: string } {
  const kept: Array<{ item: T; text: string }> = [];
  let spent = 0;
  for (let i = all.length - 1; i >= 0 && kept.length < keep; i--) {
    const item = all[i] as T;
    const text = render(item);
    if (spent + text.length > BRIEF_HISTORY_HALF_CHARS) break;
    spent += text.length;
    kept.push({ item, text });
  }
  const dropped = all.length - kept.length;
  return {
    kept: kept.reverse(),
    left: dropped === 0 ? "" : `(${dropped} earlier ${what} are not listed here.)\n\n`,
  };
}

/**
 * The ticket's whole history, for the retro: every comment on it in order,
 * then every review thread on every pull request tied to it — resolved or
 * not, merged or not, because a correction that was argued and settled is
 * exactly what a retro learns from.
 *
 * A comment is Landrace's by the test `entriesFromComments` applies — our
 * login *and* our marker — so a person's reply the board posted as the bot
 * reads as that person's turn, not as a record. Each body is cut here, and
 * the engine bounds the whole on the way in.
 */
function historyOf(comments: SnapshotComment[], pulls: PullNode[], read: Map<number, BriefThread[]>, bot: string): string {
  const ours = (login: string | undefined): boolean => typeof login === "string" && sameLogin(login, bot);
  const text = (body: string | null | undefined): string => cut((body ?? "").trim(), BRIEF_BODY_CHARS);

  const said = newest(comments, BRIEF_COMMENTS, "comments", (c) => {
    const marker = wroteIt(c, bot) ? parseMarker(c.body ?? "") : null;
    return marker
      ? `Landrace [${marker.marker ?? marker.kind}]: ${text(stripMarker(c.body ?? ""))}`
      : `@${c.user?.login ?? "ghost"}: ${text(c.body)}`;
  });
  const conversation = said.kept.length === 0
    ? "No comments on the ticket."
    : said.left + said.kept.map((k) => k.text).join("\n\n");

  const ordered = [...pulls].sort((a, b) => a.number - b.number);
  const raised = newest(
    ordered.flatMap((pull) => (read.get(pull.number) ?? []).map((thread) => ({ pull: pull.number, thread }))),
    BRIEF_HISTORY_THREADS,
    "threads",
    ({ thread }) => {
      const opening = thread.comments.nodes[0];
      const last = thread.lastReply.nodes[0];
      const by = ours(opening?.author?.login) ? "Landrace's reviewer" : `@${opening?.author?.login ?? "ghost"}`;
      const reply = thread.comments.totalCount > 1 && last
        ? `\nLast reply, from ${ours(last.author?.login) ? "Landrace" : `@${last.author?.login ?? "ghost"}`}: ${text(last.body)}`
        : "";
      return `${where(thread)}raised by ${by} — ${thread.isResolved ? "resolved" : "open"}\n${text(opening?.body)}${reply}`;
    },
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
  const git = opts.git ?? ownGit();
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
      // Asked only by a step whose prompt names {brief.spec.…}, once per invocation.
      brief: ({ ticket }) => briefPage(gh, ticket),
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
  RESOLVE_THREAD,
};
