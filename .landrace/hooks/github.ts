/**
 * GitHub, in one file, outside the engine.
 *
 * Everything this repository's workflow needs from a tracker is here: the REST
 * client, the pre hook that turns an issue into a snapshot, the post hook that
 * writes every effect GitHub owns, the source the tick enumerates work from,
 * and the operator actions the MCP tools call. `src/` contains no GitHub code
 * at all and a test enforces it, so this file is also the worked example: a
 * second tracker is a sibling of this one, and nothing else changes.
 *
 * Read it in four parts — the client, the two hooks, and the two ticket-less
 * kinds — and note the two rules the engine cares about:
 *
 *  - Every effect has a `satisfied()` beside its `apply()`, in this same file,
 *    so nobody adds a write and forgets how to tell it has already happened.
 *  - A marker counts as control state only because *we* wrote it, so no
 *    request goes out until this token's own login is known.
 */
import {
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
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${await res.text()}`);
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
        if (!String(e).includes("404")) throw e; // already gone is success
      }
    },
  };
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
} {
  const gh = createClient(opts);

  return {
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

export const operator = defineOperator({
  id: "github",
  createTicket: async (input: NewTicket, ctx: RuntimeContext) => hooksFor(ctx).operator.createTicket(input, ctx),
  updateTicket: async (ticket: number, patch: TicketPatch, ctx: RuntimeContext) =>
    hooksFor(ctx).operator.updateTicket(ticket, patch, ctx),
});

