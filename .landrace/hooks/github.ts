/**
 * GitHub, in one file, outside the engine.
 *
 * Everything this repository's workflow needs from a tracker is here: the REST
 * client, the pre hook that turns an issue into a snapshot, the post hook that
 * writes every effect GitHub owns, the artifact hook that publishes the spec to
 * Pages, the source the tick enumerates work from, and the operator actions the
 * MCP tools call. `src/` contains no GitHub code at all and a test enforces it,
 * so this file is also the worked example: a second tracker is a sibling of
 * this one, and nothing else changes.
 *
 * Read it in five parts — the client, the two hooks, the spec artifact, and the
 * two ticket-less kinds — and note the two rules the engine cares about:
 *
 *  - Every effect has a `satisfied()` beside its `apply()`, in this same file,
 *    so nobody adds a write and forgets how to tell it has already happened.
 *  - A marker counts as control state only because *we* wrote it, so no
 *    request goes out until this token's own login is known.
 */
import { createHash } from "node:crypto";
import {
  defineArtifactHook,
  defineOperator,
  definePostHook,
  definePreHook,
  defineSource,
  entriesFromComments,
  LABELS,
  neutraliseMarkers,
  parseMarker,
  renderMarker,
  stageFromLabels,
  STAGE_LABEL_PREFIX,
  type ArtifactHook,
  type Candidate,
  type Effect,
  type HookContext,
  type Marker,
  type NewTicket,
  type Operator,
  type PostHook,
  type PreHook,
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

interface Issue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  labels: Array<string | { name?: string }>;
  pull_request?: unknown;
}

interface Comment {
  id: number;
  body: string;
  created_at: string;
  user?: { login?: string } | null;
}

const labelNames = (issue: Issue): string[] =>
  (issue.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean);

const candidateOf = (issue: Issue): Candidate => ({
  ticket: issue.number,
  title: issue.title,
  url: issue.html_url,
  labels: labelNames(issue),
});

/* ── the client ─────────────────────────────────────────────────────────── */

export interface GitHubOptions {
  repo: string;
  token: string;
  /** Overrides the login resolved from the token, for a GitHub App posting under a bot name. */
  bot?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
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

  async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
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
      const user = await request<unknown>("GET", "https://api.github.com/user");
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

  return {
    botLogin,

    /**
     * The one question REST cannot answer: a review thread's `isResolved`.
     *
     * It is a POST to a different host path and its own error shape — a
     * GraphQL failure is an HTTP 200 carrying an `errors` array — so it lives
     * beside `call` rather than inside it. The login gate is the same one for
     * the same reason: it is resolved once per client, and every entry point
     * goes through it.
     */
    graphql: async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
      await botLogin();
      const body = await request<{ data?: T; errors?: Array<{ message?: unknown }> }>(
        "POST",
        "https://api.github.com/graphql",
        { query, variables },
      );
      // Errors arrive with a 200 and are the whole answer: read past them and
      // a query that failed looks exactly like one that found nothing.
      if (body.errors?.length) {
        throw new Error(`graphql: ${body.errors.map((e) => String(e.message ?? e)).join("; ")}`);
      }
      if (body.data === undefined || body.data === null) throw new Error("graphql: the response carried no data");
      return body.data;
    },

    async listIssues({ labels = [], state = "open" }: { labels?: string[]; state?: string }): Promise<Issue[]> {
      const q = new URLSearchParams({ state, per_page: "100" });
      if (labels.length) q.set("labels", labels.join(","));
      const items = await call<Issue[]>("GET", `/issues?${q}`);
      // The issues endpoint returns pull requests too.
      return items.filter((i) => !i.pull_request);
    },
    getIssue: (n: number) => call<Issue>("GET", `/issues/${n}`),
    createIssue: (fields: { title: string; body?: string; labels?: string[] }) =>
      call<Issue>("POST", `/issues`, fields),
    updateIssue: (n: number, fields: { title?: string; body?: string; state?: string }) =>
      call<Issue>("PATCH", `/issues/${n}`, fields),
    listComments: (n: number) => call<Comment[]>("GET", `/issues/${n}/comments?per_page=100`),
    createComment: (n: number, body: string) => call<Comment>("POST", `/issues/${n}/comments`, { body }),
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

const labelsOf = (s: Snapshot): string[] => ((s.ticket as { labels?: string[] })?.labels ?? []);

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

const wroteIt = (c: SnapshotComment, bot: string): boolean =>
  typeof c.user?.login === "string" && c.user.login.toLowerCase() === bot;

function satisfied(snapshot: Snapshot, effect: Effect): boolean {
  const present = labelsOf(snapshot);
  switch (effect.type) {
    // The two label cases read labels, which only an account with write
    // access can set — unlike a comment, which anyone can post. Forging one
    // is the operator-tools problem (lr: labels are refused there), not an
    // authorship question this hook can answer.
    case "tracker.label": {
      const add = (effect.add as string[]) ?? [];
      const remove = (effect.remove as string[]) ?? [];
      return add.every((l) => present.includes(l)) && remove.every((l) => !present.includes(l));
    }
    case "tracker.status":
      // GitHub has no status field; position is a stage label.
      return present.includes(LABELS.stage(String(effect.value)));
    case "tracker.comment": {
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
    default:
      return false;
  }
}

/* ── the four hooks ─────────────────────────────────────────────────────── */

const PROVIDES = [
  "ticket.number", "ticket.title", "ticket.body", "ticket.labels", "ticket.comments",
  "entries", "tracker.bot",
];

const HANDLES = ["tracker.label", "tracker.status", "tracker.comment"];

/** Observe: turn a GitHub issue into the snapshot the engine reads. */
async function readTicket(gh: Client, ticket: number): Promise<Record<string, unknown>> {
  const issue = await gh.getIssue(ticket);
  const raw = await gh.listComments(ticket);
  const bot = await gh.botLogin();
  const names = labelNames(issue);
  return {
    ticket: {
      number: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      state: issue.state,
      url: issue.html_url,
      labels: names,
      stage: stageFromLabels(names).stage,
      comments: raw,
    },
    entries: entriesFromComments(raw, bot),
    // Recorded because the post hook's satisfied() is synchronous and needs to
    // know which comments are ours.
    tracker: { bot },
  };
}

/** Act: every write GitHub owns, each beside the check that says it has landed. */
async function applyEffect(gh: Client, effect: Effect, ticket: number): Promise<void> {
  switch (effect.type) {
    case "tracker.label": {
      for (const l of (effect.remove as string[]) ?? []) await gh.removeLabel(ticket, l);
      await gh.addLabels(ticket, (effect.add as string[]) ?? []);
      return;
    }
    case "tracker.status": {
      const want = LABELS.stage(String(effect.value));
      const current = labelNames(await gh.getIssue(ticket)).filter((l) => l.startsWith(STAGE_LABEL_PREFIX));
      for (const stale of current.filter((l) => l !== want)) await gh.removeLabel(ticket, stale);
      await gh.addLabels(ticket, [want]);
      return;
    }
    case "tracker.comment": {
      // No kind, no marker: an operator's reply is genuinely a human turn, and
      // stamping it would make the engine read a person's words as its own
      // record. Everything a stage plans names a kind.
      if (effect.kind === undefined) {
        await gh.createComment(ticket, neutraliseMarkers(String(effect.body ?? "")));
        return;
      }
      const marker: Marker = {
        stage: String(effect.stage ?? "-"),
        kind: String(effect.kind),
        round: Number(effect.round ?? 0),
        ...(effect.marker ? { marker: String(effect.marker) } : {}),
        // The step's own value, already cut to its declared shape by the
        // runner. It rides inside the marker, not in the body: the body is
        // prose, and prose is escaped on the way out precisely so it cannot
        // carry control state. Kept as structure rather than stringified,
        // because parseMarker reads it back with JSON.parse.
        ...(effect.output === undefined ? {} : { output: effect.output }),
      };
      await gh.createComment(ticket, neutraliseMarkers(String(effect.body ?? "")) + renderMarker(marker));
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
const pagePath = (ticket: number): string => `specs/${ticket}/index.md`;

const pageUrl = (repo: string, ticket: number): string => {
  // GitHub's own default domain for a project site. A repository serving Pages
  // from a custom domain publishes to the same branch and path; only the
  // origin below differs, and it would be the one thing worth configuring.
  const [owner, name] = repo.split("/");
  return `https://${owner}.github.io/${name}/specs/${ticket}/`;
};

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

async function readPage(gh: Client, repo: string, ticket: number): Promise<Record<string, unknown>> {
  const content = await gh.getFile(PAGES_BRANCH, pagePath(ticket));
  // `exists` and a content hash are the whole state: presence is what a
  // precondition reads, and the hash is what makes a republish a no-op.
  return { exists: content !== null, hash: content === null ? null : hashOf(content), url: pageUrl(repo, ticket) };
}

async function publishPage(gh: Client, effect: Effect, ticket: number): Promise<void> {
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

/* ── the pull request, read over GraphQL ────────────────────────────────── */

/** The artifact the review loop turns on. One name, for the snapshot path and the hook's id. */
const PR = "pr";

/**
 * Derived from the ticket, never stored — the same rule the spec's path
 * follows. There is no PR id to remember and nothing to repair: the branch
 * names the ticket, and the pull request is whichever one has that head.
 */
const prBranch = (ticket: number): string => `landrace/${ticket}`;

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

/**
 * Thread resolution is GraphQL-only: REST exposes review comments but not
 * `isResolved`. That is a hard requirement on this hook rather than an
 * optimisation, because the review loop's gate is a *count* of unresolved
 * threads — a structural fact nobody can write — and not a judge's verdict.
 *
 * Only what §10's triggers read is asked for. In particular no thread body:
 * a body is written by anyone with comment access, and the snapshot is hashed,
 * interpolated into prompts and carried into every predicate. What cannot be
 * fetched cannot leak.
 */
const PR_QUERY = `
query($owner: String!, $name: String!, $head: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $head, states: [OPEN, MERGED], first: 1,
                 orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes {
        number
        merged
        headRefOid
        reviewThreads(first: ${THREAD_PAGE}, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { isResolved }
        }
      }
    }
  }
}`;

interface PrNode {
  number: number;
  merged: boolean;
  headRefOid: string;
  reviewThreads: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{ isResolved: boolean }>;
  };
}

interface PrResponse {
  repository: { pullRequests: { nodes: PrNode[] } } | null;
}

/**
 * The pull request for a ticket's branch, as the facts §10 routes on: the
 * number `code-review` requires, the head sha a fix round moves, whether it
 * merged, and how many review threads are still open.
 *
 * `{}` when there is no pull request yet — not a null, and not an `exists`
 * flag. `artifacts.pr.number` is what the gate reads, and absent has to read
 * as absent.
 *
 * Note what is *not* here. No `reviewDecision`: nothing in the workflow reads
 * it, and an artifact carrying more than its gates read is a remote document's
 * shape reaching the snapshot. No thread bodies: see PR_QUERY.
 */
async function readPr(gh: Client, repo: string, ticket: number): Promise<Record<string, unknown>> {
  const [owner = "", name = ""] = repo.split("/");
  const head = prBranch(ticket);

  let cursor: string | null = null;
  let pull: PrNode | null = null;
  let openThreads = 0;

  for (let page = 0; page < MAX_THREAD_PAGES; page++) {
    const data: PrResponse = await gh.graphql<PrResponse>(PR_QUERY, { owner, name, head, cursor });

    // A repository a token cannot see answers with a 200, no errors and a null
    // repository. Read as an empty answer it is indistinguishable from "no
    // pull request yet", which parks every ticket at `build` saying nothing.
    if (!data.repository) {
      throw new Error(`the repository "${repo}" answered with nothing at all; check the token's access to it`);
    }

    // Two pull requests can share a head branch — one merged, one opened after
    // it — so the newest is the current work. That is a total order on
    // creation time, not a first-match-wins over an arbitrary list.
    const node = data.repository.pullRequests.nodes[0];
    if (!node) return {};

    pull = node;
    openThreads += node.reviewThreads.nodes.filter((t) => !t.isResolved).length;
    if (!node.reviewThreads.pageInfo.hasNextPage) {
      return { number: node.number, headSha: node.headRefOid, merged: node.merged, openThreads };
    }
    cursor = node.reviewThreads.pageInfo.endCursor;
  }

  throw new Error(
    `the pull request #${pull?.number ?? "?"} has more than ${MAX_THREAD_PAGES * THREAD_PAGE} review threads, ` +
    "so the open-thread count the review loop gates on cannot be read in one pass. " +
    "Reporting the count of what was read would be reporting a number known to be short.",
  );
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
 * The open threads as prose, asked for only when a step is about to run.
 *
 * This is the one place thread text is fetched at all, and it is deliberately
 * not part of PR_QUERY: that runs on every converge pass, feeds the snapshot,
 * and must carry nothing anybody outside this repository wrote. A briefing
 * runs once per invocation and feeds a prompt.
 *
 * `comments(first: 1)` is the finding itself — the thread's opening comment.
 * The replies under it are the argument about the finding, including the
 * fixer's own from last round, and a fixer re-reading its own reply is how a
 * round loops without moving.
 */
const BRIEF_QUERY = `
query($owner: String!, $name: String!, $head: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $head, states: [OPEN, MERGED], first: 1,
                 orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes {
        number
        reviewThreads(first: ${THREAD_PAGE}, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            isResolved
            path
            line
            comments(first: 1) { nodes { body } }
          }
        }
      }
    }
  }
}`;

interface BriefThread {
  isResolved: boolean;
  path: string | null;
  line: number | null;
  comments: { nodes: Array<{ body: string | null }> };
}

interface BriefNode {
  number: number;
  reviewThreads: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: BriefThread[];
  };
}

interface BriefResponse {
  repository: { pullRequests: { nodes: BriefNode[] } } | null;
}

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

/** "src/x.ts:12", "src/x.ts", or nothing at all — GitHub cannot always place a thread. */
const where = (thread: BriefThread): string =>
  thread.path === null ? "" : `${thread.path}${thread.line === null ? "" : `:${thread.line}`} — `;

/**
 * The open review threads, rendered for a prompt.
 *
 * Paged the same way the count is, and for the same reason pointed the other
 * way: asking for the first twenty *threads* on a pull request whose first
 * hundred are resolved would show the fixer nothing while the gate said twenty
 * findings were open — and a step told to address nothing answers "addressed",
 * which spends a round and moves the ticket on with the findings still there.
 */
async function briefPr(gh: Client, repo: string, ticket: number): Promise<Record<string, string>> {
  const [owner = "", name = ""] = repo.split("/");
  const head = prBranch(ticket);

  let cursor: string | null = null;
  const open: BriefThread[] = [];
  let more = 0;

  for (let page = 0; page < MAX_THREAD_PAGES; page++) {
    const data: BriefResponse = await gh.graphql<BriefResponse>(BRIEF_QUERY, { owner, name, head, cursor });
    // Same three failures the count tells apart, and for the same reason: an
    // empty briefing and an unreadable one look identical to the agent.
    if (!data.repository) {
      throw new Error(`the repository "${repo}" answered with nothing at all; check the token's access to it`);
    }
    const node = data.repository.pullRequests.nodes[0];
    if (!node) return { threads: "There is no pull request on this ticket's branch, so there is nothing to address." };

    for (const thread of node.reviewThreads.nodes) {
      if (thread.isResolved) continue;
      if (open.length < BRIEF_THREADS) open.push(thread);
      else more++;
    }
    if (!node.reviewThreads.pageInfo.hasNextPage) break;
    cursor = node.reviewThreads.pageInfo.endCursor;
  }

  if (open.length === 0) {
    return { threads: "No review thread on the pull request is open. Nothing here needs addressing." };
  }

  const listed = open.map((thread, i) => {
    const body = thread.comments.nodes[0]?.body ?? "";
    return `${i + 1}. ${where(thread)}${cut(body.trim(), BRIEF_BODY_CHARS)}`;
  });

  // Said out loud rather than left implicit: an agent shown twenty of fifty
  // findings and told nothing would report the pull request addressed.
  const tail = more === 0
    ? ""
    : `\n\n(${more} more open threads are not listed here. Address what is above; the rest come back next round.)`;

  return { threads: listed.join("\n\n") + tail };
}

/**
 * The act half of an artifact nothing publishes.
 *
 * A pull request is opened by whoever pushes the branch, so this artifact is
 * read-only and `handles` is empty: the dispatcher routes no effect type here
 * and neither of these is reachable from the engine. They throw rather than
 * returning a polite nothing, because the two silent answers are the two ways
 * an unhandled effect goes wrong — "satisfied" drops the work, "not satisfied"
 * re-applies it every tick.
 */
const nothingPublishes = (effect: Effect): never => {
  throw new Error(
    `nothing publishes the "${PR}" artifact — it is opened by whoever pushes the branch and only read here — ` +
    `so "${String(effect.type)}" has no handler on this hook`,
  );
};

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
  pullRequestArtifact: ArtifactHook;
  specArtifact: ArtifactHook;
} {
  const gh = createClient(opts);

  return {
    // Named to sort after `pre`, for the reason spelled out on `specArtifact`
    // below. As `prArtifact` it sorted *before* it ("prA" < "pre"), and the
    // artifact phase ran ahead of the tracker read it is meant to sit beside.
    pullRequestArtifact: defineArtifactHook({
      id: PR,
      handles: [],
      read: ({ ticket }) => readPr(gh, opts.repo, ticket),
      // The text half, fetched per invocation rather than per pass: what
      // `fix-review` is told to address, which `read` will not carry.
      brief: ({ ticket }) => briefPr(gh, opts.repo, ticket),
      satisfied: (_snapshot, effect) => nothingPublishes(effect),
      apply: (effect) => nothingPublishes(effect),
    }),

    // Sorts after every other export on purpose: the loader files a module's
    // exports in sorted name order, and an artifact's read wants the tracker's
    // fragment already in the snapshot beside it.
    specArtifact: defineArtifactHook({
      id: SPEC,
      handles: [PUBLISH],
      read: ({ ticket }) => readPage(gh, opts.repo, ticket),
      satisfied: publishSatisfied,
      apply: (effect, { ticket }) => publishPage(gh, effect, ticket),
    }),

    pre: definePreHook({
      id: "github",
      provides: PROVIDES,
      run: ({ ticket }) => readTicket(gh, ticket),
    }),

    post: definePostHook({
      id: "github",
      handles: HANDLES,
      satisfied,
      apply: (effect, { ticket }) => applyEffect(gh, effect, ticket),
    }),

    source: defineSource({
      id: "github",
      // Every open issue, labels included: position, eligibility and whose
      // turn it is are all labels, so a tick can choose what to work and
      // `landrace status` can print a line each without a snapshot per ticket.
      list: async () => (await gh.listIssues({})).map(candidateOf),
    }),

    operator: defineOperator({
      id: "github",
      createTicket: async ({ title, body, labels }: NewTicket) =>
        candidateOf(await gh.createIssue({ title, body: body ?? "", labels: labels ?? [] })),

      updateTicket: async (ticket: number, patch: TicketPatch) => {
        const fields: { title?: string; body?: string; state?: string } = {};
        if (patch.title !== undefined) fields.title = patch.title;
        if (patch.body !== undefined) fields.body = patch.body;
        if (patch.state !== undefined) fields.state = patch.state;

        for (const name of patch.removeLabels ?? []) await gh.removeLabel(ticket, name);
        await gh.addLabels(ticket, patch.addLabels ?? []);

        return candidateOf(
          Object.keys(fields).length ? await gh.updateIssue(ticket, fields) : await gh.getIssue(ticket),
        );
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
  list: async (ctx: RuntimeContext) => hooksFor(ctx).source.list(ctx),
});

/**
 * The pull request for this ticket's branch, read every tick.
 *
 * The one artifact here that is read-only: §10's review loop routes on its
 * number, its unresolved thread count and whether it merged, and none of those
 * are things this workflow writes.
 */
export const pullRequestArtifact = defineArtifactHook({
  id: PR,
  handles: [],
  read: async (ctx: HookContext) => hooksFor(ctx).pullRequestArtifact.read(ctx),
  brief: async (ctx: HookContext) => {
    const hook = hooksFor(ctx).pullRequestArtifact;
    if (!hook.brief) throw new Error("the pull request artifact briefs nothing");
    return hook.brief(ctx);
  },
  satisfied: (_snapshot: Snapshot, effect: Effect) => nothingPublishes(effect),
  apply: async (effect: Effect) => nothingPublishes(effect),
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
  // Not delegated: it reads the snapshot and hashes a string, so it needs no
  // client and no configuration to build one from.
  satisfied: publishSatisfied,
  apply: async (effect: Effect, ctx: HookContext) => hooksFor(ctx).specArtifact.apply(effect, ctx),
});

export const operator = defineOperator({
  id: "github",
  createTicket: async (input: NewTicket, ctx: RuntimeContext) => hooksFor(ctx).operator.createTicket(input, ctx),
  updateTicket: async (ticket: number, patch: TicketPatch, ctx: RuntimeContext) =>
    hooksFor(ctx).operator.updateTicket(ticket, patch, ctx),
});

