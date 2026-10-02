/*
 * GitHub's REST and GraphQL client, which all three roles share: one per
 * configuration, so one `GET /user` resolves the login they post as.
 *
 * A marker counts as control state only because *we* wrote it, so no request
 * goes out until this token's own login is known.
 */
import type { RuntimeContext } from "landrace/hooks";
import { MAX_COMMENT_CHARS } from "landrace/kit";

export interface GitHubOptions {
  repo: string;
  token: string;
  /** Overrides the login resolved from the token, for a GitHub App posting under a bot name. */
  bot?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

/** An issue as REST answers it: read for the id a sub-issue is linked by. */
interface Issue {
  number: number;
  /** The REST id, which is not the number: a sub-issue is linked by this. */
  id: number;
}

/** A comment on an issue, as REST answers it. */
export interface Comment {
  id: number;
  body: string;
  created_at: string;
  user?: { login?: string } | null;
}

/** One file of a pull request's diff, as `GET /pulls/{n}/files` answers it. `patch` is absent for a binary or huge file. */
export interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

/** One check run on a commit, as `GET /commits/{sha}/check-runs` answers it. */
export interface CheckRun {
  id: number;
  name: string;
  /** Null until the run completes. */
  conclusion: string | null;
  app?: { slug?: string } | null;
  output?: { text?: string | null; summary?: string | null } | null;
}

/** One commit status, as `GET /commits/{sha}/status` answers it. */
export interface CommitStatus {
  context: string;
  state: string;
  description?: string | null;
}

/** A line comment inside a review — the only place GitHub takes several findings in one request. */
export interface ReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
}

/** A 404 from the API, told apart from every other failure by its status rather than by its text. */
export const isMissing = (e: unknown): boolean => (e as { status?: unknown } | null)?.status === 404;

/** A repository the token cannot see answers with a 200, no errors and a null repository — never read as an empty one. */
export const unseen = (repo: string): Error =>
  new Error(`the repository "${repo}" answered with nothing at all; check the token's access to it`);

/**
 * The engine's id as the number GitHub wants. Only GitHub's integration knows
 * its ids are integers; anything else reaching here is an item from some
 * other tracker, and calling `/issues/NaN` with it would report a 404 about
 * the wrong thing.
 */
export const issueNumber = (id: string): number => {
  if (!/^[1-9][0-9]*$/.test(id)) throw new Error(`"${id}" is not a GitHub issue number`);
  return Number(id);
};

/**
 * A 401 means GitHub rejected the token itself, before any one permission
 * ever entered into it — checked first in every probe, ahead of anything
 * status-specific, so a bad token is never misreported as missing one
 * particular permission.
 */
export function tokenRejected(e: unknown): Error | null {
  const status = (e as { status?: unknown } | null)?.status;
  return status === 401
    ? new Error("token was rejected by GitHub (401) — check that it is valid and not expired")
    : null;
}

export function createClient(opts: GitHubOptions) {
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
  const [owner = "", name = ""] = repo.split("/");

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
    // 404?" answered by searching the message finds the *path* on an item
    // numbered 404 — `/contents/specs/404/index.md` — and a caller that reads
    // a broken repository as an absent file republishes it on every tick.
    if (!res.ok) {
      const text = await res.text();
      throw Object.assign(new Error(`${method} ${url} → ${res.status} ${text}`), { status: res.status, body: text });
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
   * tells the two apart by whether this is null, not by trying to parse the
   * token itself. `undefined` until botLogin has run once; `null` after it
   * has, if the header was not there.
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
        // those. Folded into `null` (unknown) so the probes judge real access
        // instead of a scope list that might not mean anything.
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
   * Nothing touches the repository until the login is known — the one place
   * every entry point goes through. An unresolved login makes our own markers
   * read as a stranger's, which makes the engine believe no step has ever run
   * and pay for every one of them again on every tick.
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
   * the same reason.
   */
  async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
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

  return {
    repo,
    owner,
    name,
    /** For the one place it goes besides a request: the push's own header, and scrubbing it from what git says. */
    token,

    botLogin,

    /**
     * The scopes a classic token carries, or null for a fine-grained one —
     * off the same GET /user call `botLogin` already makes.
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
     * classic one's `x-oauth-scopes` header does.
     */
    createEmptyBlob: async (): Promise<void> => {
      await call("POST", "/git/blobs", { content: "", encoding: "utf-8" });
    },

    graphql,

    createIssue: (fields: { title: string; body?: string; labels?: string[] }) =>
      call<Issue>("POST", `/issues`, fields),
    updateIssue: (n: number, fields: { title?: string | undefined; body?: string | undefined; state?: string | undefined }) =>
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
    openPull: async (fields: { head: string; base: string; title: string; body?: string }): Promise<void> => {
      try {
        await named(call("POST", "/pulls", fields), `"Pull requests: Read and write" on ${repo}`);
      } catch (e) {
        if ((e as { status?: unknown } | null)?.status === 422 && /already exists/i.test(String(e))) return;
        throw e;
      }
    },
    /** One page of a commit's check runs; see the forge for why one is all that is read. */
    checkRuns: (sha: string, perPage: number) =>
      call<{ check_runs?: CheckRun[] }>("GET", `/commits/${encodeURIComponent(sha)}/check-runs?per_page=${perPage}`),
    /** A commit's statuses, the older way a service reports on a commit. */
    commitStatus: (sha: string) => call<{ statuses?: CommitStatus[] }>("GET", `/commits/${encodeURIComponent(sha)}/status`),
    /**
     * An Actions job's log as text. GitHub answers with a redirect to where
     * the text lives, which fetch follows — and drops the Authorization header
     * on the way out of api.github.com, so the token goes nowhere but here.
     */
    jobLog: async (id: number): Promise<string> => {
      await botLogin();
      const res = await doFetch(`https://api.github.com/repos/${repo}/actions/jobs/${id}/logs`, {
        headers: { Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "landrace" },
        redirect: "follow",
      });
      if (!res.ok) throw Object.assign(new Error(`GET /actions/jobs/${id}/logs → ${res.status}`), { status: res.status });
      return res.text();
    },
    pull: (n: number) => call<{ merged?: boolean }>("GET", `/pulls/${n}`),
    /** Merge with a merge commit, only if the head is still `sha`: GitHub answers 409 when it is not. */
    mergePull: (n: number, sha: string) =>
      named(call("PUT", `/pulls/${n}/merge`, { sha, merge_method: "merge" }),
        `"Pull requests: Read and write" and "Contents: Read and write" on ${repo}`),

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
    addSubIssue: (parent: number, child: number) =>
      named(call("POST", `/issues/${parent}/sub_issues`, { sub_issue_id: child }), `"Issues: Read and write" on ${repo}`),
    /** One page of an issue's comments, oldest first. */
    listComments: (n: number, page: number) => call<Comment[]>("GET", `/issues/${n}/comments?per_page=100&page=${page}`),
    createComment: (n: number, body: string) => {
      // Refused before the request goes out, because a 422 here is an apply
      // that throws — and an apply that throws leaves nothing durable on the
      // item, so the next tick re-derives the stage as pending and pays for
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
        // Everything already on the branch is kept: each item owns its own
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
}

export type Client = ReturnType<typeof createClient>;

/**
 * A hook is *handed* its configuration and its secrets rather than
 * constructed with them — that is what keeps it testable and what lets log
 * redaction know every value it must never print — so the client cannot exist
 * until the first call. One per configuration object, which a process loads
 * once, so the three roles share one client and the login is resolved once.
 */
const clients = new WeakMap<object, Client>();

export function clientFor(ctx: RuntimeContext): Client {
  const existing = clients.get(ctx.config);
  if (existing) return existing;

  const tracker = ctx.config.tracker as { repo?: unknown; bot?: unknown } | undefined;
  const repo = typeof tracker?.repo === "string" ? tracker.repo.trim() : "";
  if (!repo) throw new Error('the GitHub integration needs tracker.repo in landrace.yaml, as "owner/name"');

  const token = ctx.secrets.get("githubToken");
  if (!token) throw new Error('the GitHub integration needs a "githubToken" secret declared in landrace.yaml');

  const client = createClient({ repo, token, ...(typeof tracker?.bot === "string" ? { bot: tracker.bot } : {}) });
  clients.set(ctx.config, client);
  return client;
}
