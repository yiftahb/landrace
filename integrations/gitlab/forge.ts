/*
 * GitLab merge requests as a project's forge: the REST calls, the mapping of
 * merge requests, discussions and diffs into the kit's plain shapes, and the
 * push URL it trusts with a token. Everything else a forge does is
 * `BaseForge`'s.
 */
import { type HookContext, parseMarker, type RuntimeContext, sameLogin } from "landrace/hooks";
import {
  BaseForge, branchHeads, DONE_WINDOW_MS, MAX_ISSUE_PAGES, MAX_THREAD_PAGES, originPushUrl, ownGit, prBranch, pushBranch,
  repositoryOf, ITEM_PAGE,
  type BranchHeads, type ChangedFile, type CheckState, type FailedCheck, type Git, type MergeAnswer, type PullRecord,
  type ReviewThread, type ThreadComment,
} from "landrace/kit";
import { type Client, clientFor, PER_PAGE, statusOf, tokenRejected } from "./client.js";

/** Developer: what opening a merge request, commenting and resolving need. */
const DEVELOPER = 30;
const LEVELS: Record<number, string> = { 5: "Minimal access", 10: "Guest", 15: "Planner", 20: "Reporter", 30: "Developer", 40: "Maintainer", 50: "Owner" };

/** A merge request as REST answers one. */
interface MergeRequest {
  iid: number;
  title: string;
  web_url: string;
  /** "opened", "closed", "merged", or "locked" for the moment a merge is under way. */
  state: string;
  /** Null while GitLab has not yet worked out the head. */
  sha: string | null;
  source_branch: string;
  /** Not the target's for a fork's, whose branch is in somebody else's project — and so could be named anything. */
  source_project_id: number;
  target_project_id: number;
  created_at?: string;
  updated_at?: string | null;
}

/** A pipeline as REST lists one: the commit it ran on, and where it stands. */
interface Pipeline {
  id: number;
  sha: string;
  status: string;
}

const PIPELINE_STATES: Record<string, CheckState> = {
  success: "success", failed: "failure", canceled: "failure",
  created: "pending", canceling: "pending", waiting_for_resource: "pending", preparing: "pending", pending: "pending", running: "pending", scheduled: "pending", manual: "pending",
  skipped: "none",
};

/** What GitLab said, out of the JSON body of a refusal: its `message`, or the body as it came. */
function refusalMessage(e: unknown): string {
  const body = (e as { body?: unknown } | null)?.body;
  if (typeof body !== "string") return e instanceof Error ? e.message : String(e);
  try {
    const parsed = JSON.parse(body) as { message?: unknown; error?: unknown };
    const said = parsed.message ?? parsed.error;
    return typeof said === "string" ? said : Array.isArray(said) ? said.join("; ") : body;
  } catch {
    return body;
  }
}

/** One note of a discussion. `system` is GitLab's own ("added 1 commit"), never anybody's word. */
interface Note {
  body: string | null;
  author?: { username?: string } | null;
  created_at?: string;
  system: boolean;
  resolvable?: boolean;
  resolved?: boolean;
  position?: { new_path?: string | null; new_line?: number | null } | null;
}

interface Discussion {
  id: string;
  /** A plain note, which GitLab wraps as a discussion of one and which nobody can resolve. */
  individual_note: boolean;
  notes: Note[];
}

/** One file of a merge request's diff. `diff` is empty for a binary file, or one too large to show. */
interface Diff {
  old_path: string;
  new_path: string;
  diff: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
}

/** A merge request as the kit reads one. GitLab's own closing references are not read: nothing here writes one. */
const recordOf = (mr: MergeRequest): PullRecord => ({
  number: mr.iid,
  title: mr.title,
  link: mr.web_url,
  merged: mr.state === "merged",
  closed: mr.state === "closed",
  headSha: mr.sha ?? "",
  branch: mr.source_project_id === mr.target_project_id ? mr.source_branch : undefined,
  createdAt: mr.created_at,
  updatedAt: mr.updated_at ?? undefined,
  items: [],
});

const commentOf = (n: Note | undefined): ThreadComment | null =>
  n === undefined ? null : { body: n.body ?? "", author: n.author?.username ?? null };

/**
 * A discussion as the kit reads a review thread — when it is one. Only a
 * resolvable discussion somebody started is: a plain note is a discussion
 * of one nobody can resolve, and one GitLab opened itself ("changed this
 * line in version 2") is nobody's finding. Either would sit in the open
 * count for ever.
 */
function threadOf(d: Discussion): ReviewThread | null {
  const opening = d.notes[0];
  if (d.individual_note || opening === undefined || opening.system || opening.resolvable !== true) return null;
  const notes = d.notes.filter((n) => !n.system);
  return {
    id: d.id,
    resolved: notes.every((n) => n.resolvable !== true || n.resolved === true),
    path: opening.position?.new_path ?? null,
    line: opening.position?.new_line ?? null,
    first: commentOf(opening),
    last: commentOf(notes.at(-1)),
    comments: notes.length,
    at: opening.created_at,
  };
}

/** A patch's rows from its first hunk on, without the newline GitLab ends it with — the kit would read that as one more line. */
const hunkRows = (diff: string): string[] => {
  const rows = diff.replace(/\n$/, "").split("\n");
  const start = rows.findIndex((r) => r.startsWith("@@"));
  return start === -1 ? [] : rows.slice(start);
};

const fileOf = (d: Diff): ChangedFile => {
  const rows = hunkRows(d.diff);
  return {
    path: d.new_path,
    status: d.new_file ? "added" : d.deleted_file ? "removed" : d.renamed_file ? "renamed" : "modified",
    additions: rows.filter((r) => r.startsWith("+")).length,
    deletions: rows.filter((r) => r.startsWith("-")).length,
    patch: rows.length === 0 ? undefined : rows.join("\n"),
  };
};

/**
 * Text GitLab will not run as a quick action. GitLab carries out `/close`,
 * `/merge`, `/approve` at the start of a line in any note it is handed, as
 * the account that posted it — ours, with Developer access — and what we
 * post is an agent's text, which can quote the code under review. A
 * backslash before the slash renders as the slash alone.
 *
 * ponytail: inside a code fence too, where GitLab would not run it and the
 * backslash shows; skip fences if that ever reads badly.
 */
const inert = (body: string): string => body.replace(/^([ \t]*)\//gm, "$1\\/");

/** The old-side number of a new-side line the patch shows unchanged, or null for an added line or one it does not show. */
function oldLineOf(diff: string, line: number): number | null {
  let oldAt = 0;
  let newAt = 0;
  for (const row of hunkRows(diff)) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      oldAt = Number(hunk[1]);
      newAt = Number(hunk[2]);
    } else if (row.startsWith("-")) {
      oldAt++;
    } else if (row.startsWith("+")) {
      if (newAt++ === line) return null;
    } else if (!row.startsWith("\\")) {
      if (newAt === line) return oldAt;
      oldAt++;
      newAt++;
    }
  }
  return null;
}

/**
 * Publish one branch to origin, fast-forward only — `pushBranch`, to the one
 * push URL `originPushUrl` allows.
 *
 * The token rides only to the project's own URL on `gitlabBaseUrl`, matched
 * as the very string git will use — `{gitlabBaseUrl}/{project}`, with or
 * without `.git` — never a parsed reading of it, which a second parser could
 * read another way. Any other origin is pushed with the operator's own
 * credentials and no token at all.
 *
 * With the token, it rides in git's environment as an `oauth2:` basic header
 * scoped to that exact URL, never on the command line; an empty value first
 * clears one some other tool configured, and credential helpers and askpass
 * are cleared so nothing git starts sees it. Whatever git says back is
 * scrubbed of the token and its base64 before it becomes an error.
 */
async function push(git: Git, { token, baseUrl, project }: Client, branch: string, item: string, signal: AbortSignal): Promise<void> {
  const basic = Buffer.from(`oauth2:${token}`).toString("base64");
  const scrub = (text: string): string => text.replaceAll(token, "[redacted]").replaceAll(basic, "[redacted]");
  const url = await originPushUrl(git, branch, signal);
  const header = `http.${url}.extraheader`;
  const auth: Array<[string, string]> = url === `${baseUrl}/${project}` || url === `${baseUrl}/${project}.git`
    ? [[header, ""], [header, `AUTHORIZATION: basic ${basic}`], ["credential.helper", ""], ["core.askPass", ""]]
    : [];
  try {
    await pushBranch(git, branch, item, signal, auth);
  } catch (e) {
    throw new Error(scrub(e instanceof Error ? e.message : String(e)));
  }
}

/**
 * The file that said `new`: past this module's own frames, and past the
 * constructors of any subclass, wherever those are defined — a subclass in a
 * shared package is still constructed by the project's hook file. The file
 * name V8 records for a frame is a path under jest and a file: URL under
 * node; `repositoryOf` takes either.
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

/** A refusal past a paging bound, said as one: a count over part of a list is a number known to be short. */
const tooMany = (what: string): Error =>
  new Error(`${what}, more than one read carries — reporting what was read would be reporting a number known to be short`);

export interface GitLabOptions {
  /** The project's full path: "group/app". */
  project: string;
  /** git in the operator's checkout; the repository of the file that constructs this when absent. */
  git?: Git | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export class GitLab extends BaseForge {
  private readonly project: string;
  private readonly git: Git;
  private readonly fetchImpl: typeof fetch | undefined;
  /** Discussion id → the merge request it is on, as `threads` last read it. */
  private readonly discussions = new Map<string, number>();

  constructor({ project, git, fetchImpl }: GitLabOptions) {
    super();
    this.project = project;
    this.fetchImpl = fetchImpl;
    if (git) {
      this.git = git;
    } else {
      const file = constructedIn();
      this.git = ownGit(async () => {
        if (file === null) throw new Error("the GitLab forge cannot tell which file constructed it, so it cannot find its repository; hand it git");
        return repositoryOf(file);
      });
    }
  }

  private gl(ctx: RuntimeContext): Client {
    return clientFor(ctx, this.project, this.fetchImpl);
  }

  async login(ctx: RuntimeContext): Promise<string> {
    return this.gl(ctx).login();
  }

  /** Every open merge request, bounded, and the Done lane's merged and closed ones. */
  async pulls(ctx: RuntimeContext): Promise<PullRecord[]> {
    const gl = this.gl(ctx);
    const open = await gl.pages<MergeRequest>("/merge_requests?state=opened&order_by=created_at&sort=desc", MAX_ISSUE_PAGES);
    if (open.more) throw tooMany(`${this.project} has more than ${MAX_ISSUE_PAGES * PER_PAGE} open merge requests`);
    // The Done lane's window: for the board, not the tick, so it stops
    // quietly at the bound.
    const since = new Date(Date.now() - DONE_WINDOW_MS).toISOString();
    const recent = await gl.pages<MergeRequest>(
      `/merge_requests?state=all&order_by=updated_at&sort=desc&updated_after=${encodeURIComponent(since)}`, MAX_ISSUE_PAGES,
    );
    const listed = new Set(open.items.map((mr) => mr.iid));
    const done = recent.items.filter((mr) => (mr.state === "merged" || mr.state === "closed") && !listed.has(mr.iid));
    return [...open.items, ...done].map(recordOf);
  }

  /** Every merge request from the item's `landrace/{item}` branch, merged and closed ones too, and never a fork's. */
  async pullsNaming(item: string, ctx: RuntimeContext): Promise<PullRecord[]> {
    const { items: requests, more } = await this.gl(ctx).pages<MergeRequest>(
      `/merge_requests?state=all&order_by=created_at&sort=desc&source_branch=${encodeURIComponent(prBranch(item))}`, 1,
    );
    if (more || requests.length > ITEM_PAGE) throw tooMany(`#${item} has more than ${ITEM_PAGE} merge requests on its branch`);
    return requests.filter((mr) => mr.source_project_id === mr.target_project_id).map(recordOf);
  }

  /**
   * Every review thread on a merge request, each recorded against it: a
   * reply or a resolve names a discussion, and GitLab's URL for it needs
   * the merge request too. The base reads threads before either.
   */
  async threads(pull: number, ctx: RuntimeContext): Promise<ReviewThread[]> {
    const { items, more } = await this.gl(ctx).pages<Discussion>(`/merge_requests/${pull}/discussions`, MAX_THREAD_PAGES);
    if (more) throw tooMany(`merge request !${pull} has more than ${MAX_THREAD_PAGES * PER_PAGE} discussions`);
    const threads = items.flatMap((d) => threadOf(d) ?? []);
    for (const t of threads) this.discussions.set(t.id, pull);
    return threads;
  }

  async changedFiles(pull: number, ctx: RuntimeContext): Promise<ChangedFile[]> {
    return (await this.diffs(pull, ctx)).map(fileOf);
  }

  /** Our own notes only, by login: anyone can paste a round's marker into theirs. */
  async reviews(pull: number, ctx: RuntimeContext): Promise<string[]> {
    const gl = this.gl(ctx);
    const { items, more } = await gl.pages<Note>(`/merge_requests/${pull}/notes?order_by=created_at&sort=asc`, MAX_THREAD_PAGES);
    if (more) throw tooMany(`merge request !${pull} has more than ${MAX_THREAD_PAGES * PER_PAGE} notes`);
    const bot = await gl.login();
    return items
      .filter((n) => !n.system && typeof n.author?.username === "string" && sameLogin(n.author.username, bot))
      .map((n) => n.body ?? "");
  }

  private async diffs(pull: number, ctx: RuntimeContext): Promise<Diff[]> {
    const { items, more } = await this.gl(ctx).pages<Diff>(`/merge_requests/${pull}/diffs`, MAX_ISSUE_PAGES);
    if (more) throw tooMany(`merge request !${pull} changes more than ${MAX_ISSUE_PAGES * PER_PAGE} files`);
    return items;
  }

  async openPull({ branch, title }: { item: string; branch: string; title: string }, ctx: RuntimeContext): Promise<void> {
    const gl = this.gl(ctx);
    // The project's own default branch, never an assumed "main".
    const info = await gl.get<{ default_branch?: unknown }>("");
    if (typeof info.default_branch !== "string" || info.default_branch === "") {
      throw new Error(`${this.project} did not say what its default branch is`);
    }
    try {
      await gl.post("/merge_requests", { source_branch: branch, target_branch: info.default_branch, title });
    } catch (e) {
      // "Another open merge request already exists for this source branch":
      // the effect landed, most likely on an attempt a crash cut off before
      // the next read could see it.
      if (statusOf(e) === 409 && /already exists/i.test(String(e))) return;
      throw e;
    }
  }

  async closePull(pull: number, ctx: RuntimeContext): Promise<void> {
    await this.gl(ctx).put(`/merge_requests/${pull}`, { state_event: "close" });
  }

  /**
   * The merge request's newest pipeline, on its head. A pipeline of an older
   * commit says nothing of this head — the head's has not started — so that
   * reads `pending`, never the old verdict. No pipeline at all is nothing
   * configured to check it, or nothing registered yet: `none`. A status this
   * does not know is not read, and so is not green.
   */
  async checks(pull: PullRecord, ctx: RuntimeContext): Promise<CheckState> {
    const newest = await this.newestPipeline(pull, ctx);
    if (newest === null) return "none";
    if (newest.sha !== pull.headSha) return "pending";
    const known = PIPELINE_STATES[newest.status];
    if (known === undefined) throw new Error(`GitLab answered a pipeline status "${newest.status}" for !${pull.number}, which landrace does not know how to read`);
    return known;
  }

  /**
   * The head's pipeline's failed jobs, each with its trace: a trace that
   * cannot be had is `null` — the job is still named. A head whose pipeline
   * has not started has no failures to name.
   *
   * ponytail: one page of 100 failed jobs; more than that is not worth paging for.
   */
  async failedChecks(pull: PullRecord, ctx: RuntimeContext): Promise<FailedCheck[]> {
    const gl = this.gl(ctx);
    const newest = await this.newestPipeline(pull, ctx);
    if (newest === null || newest.sha !== pull.headSha) return [];
    let jobs: Array<{ id: number; name: string }>;
    try {
      jobs = await gl.get(`/pipelines/${newest.id}/jobs?scope[]=failed&per_page=${PER_PAGE}`);
    } catch (e) {
      throw this.tokenRefusal(e, true);
    }
    const failed: FailedCheck[] = [];
    for (const job of jobs) failed.push({ name: job.name, log: await gl.text(`/jobs/${job.id}/trace`).catch(() => null) });
    return failed;
  }

  private async newestPipeline(pull: PullRecord, ctx: RuntimeContext): Promise<Pipeline | null> {
    if (pull.headSha === "") throw new Error(`!${pull.number} has no head commit to read checks on`);
    try {
      return (await this.gl(ctx).get<Pipeline[]>(`/merge_requests/${pull.number}/pipelines?per_page=1`))[0] ?? null;
    } catch (e) {
      throw this.tokenRefusal(e, true);
    }
  }

  /** A refused read names the scope and role; any other failure is passed as it came — never an answer. */
  private tokenRefusal(e: unknown, ci: boolean): unknown {
    return tokenRejected(e) ?? (statusOf(e) === 403
      ? new Error(`token needs the "api" scope and Developer access on ${this.project}${ci ? ", and CI/CD enabled on the project" : ""} (GitLab answered: ${refusalMessage(e)})`)
      : e);
  }

  /**
   * GitLab's project merge method, guarded by the head the caller read: 409
   * is a head that is no longer that, which is `moved` and not an error. A
   * 405, 406 or 422 is "cannot be merged" — or already merged, which a crash
   * after the merge and before the next read makes ordinary — so the merge
   * request is asked.
   */
  async merge(pull: number, headSha: string, ctx: RuntimeContext): Promise<MergeAnswer> {
    const gl = this.gl(ctx);
    try {
      await gl.put(`/merge_requests/${pull}/merge`, { sha: headSha });
      return "merged";
    } catch (e) {
      const status = statusOf(e);
      if (status === 409) return "moved";
      if (status === 401 || status === 403) throw this.tokenRefusal(e, false);
      if (status !== 405 && status !== 406 && status !== 422) throw e;
      if ((await gl.get<{ state?: unknown }>(`/merge_requests/${pull}`)).state === "merged") return "merged";
      throw new Error(`!${pull} cannot be merged: ${refusalMessage(e)}`);
    }
  }

  /**
   * File findings, then line findings, as diff discussions on the merge
   * request's current diff; then the review's prose as a plain note — last,
   * because its marker says the round is on GitLab, and plain, because
   * nobody can resolve one and so no count ever includes it.
   *
   * GitLab places a line by both sides where both exist: a context line
   * given only its new number is refused, and a renamed file is named by its
   * old path beside its new one.
   *
   * GitLab takes one finding per request, where GitHub takes a review's in
   * one, so a round cut off partway — a 500, a rate limit — leaves some on
   * the merge request. Applied again, a finding whose marker already opens
   * a discussion of ours is not posted twice.
   */
  async postReview(
    pull: number,
    { body, lines, files }: {
      body: string; lines: Array<{ path: string; line: number; body: string }>; files: Array<{ path: string; body: string }>; head: string;
    },
    ctx: RuntimeContext,
  ): Promise<void> {
    const gl = this.gl(ctx);
    const on = `/merge_requests/${pull}/discussions`;
    if (lines.length + files.length > 0) {
      const mr = await gl.get<{ diff_refs?: { base_sha?: unknown; start_sha?: unknown; head_sha?: unknown } | null }>(`/merge_requests/${pull}`);
      const { base_sha, start_sha, head_sha } = mr.diff_refs ?? {};
      if (typeof base_sha !== "string" || typeof start_sha !== "string" || typeof head_sha !== "string") {
        throw new Error(`merge request !${pull} has no diff yet for GitLab to place findings on`);
      }
      const bot = await gl.login();
      const posted = new Set((await this.threads(pull, ctx)).flatMap((t) => {
        const marker = t.first?.author != null && sameLogin(t.first.author, bot) ? parseMarker(t.first.body)?.marker : undefined;
        return marker === undefined ? [] : [marker];
      }));
      const fresh = <T extends { body: string }>(list: T[]): T[] => list.filter((f) => !posted.has(parseMarker(f.body)?.marker ?? ""));
      const diffs = new Map((await this.diffs(pull, ctx)).map((d) => [d.new_path, d]));
      const at = (path: string) => ({ base_sha, start_sha, head_sha, old_path: diffs.get(path)?.old_path ?? path, new_path: path });
      for (const f of fresh(files)) await gl.post(on, { body: inert(f.body), position: { position_type: "file", ...at(f.path) } });
      for (const c of fresh(lines)) {
        const old = oldLineOf(diffs.get(c.path)?.diff ?? "", c.line);
        await gl.post(on, {
          body: inert(c.body), position: { position_type: "text", ...at(c.path), new_line: c.line, ...(old === null ? {} : { old_line: old }) },
        });
      }
    }
    await gl.post(`/merge_requests/${pull}/notes`, { body: inert(body) });
  }

  /** Checked, not assumed: an answer with no note is a reply that did not land. */
  async reply(thread: string, body: string, ctx: RuntimeContext): Promise<void> {
    const note = await this.gl(ctx).post<{ id?: unknown } | null>(`${this.discussion(thread)}/notes`, { body: inert(body) });
    if (typeof note?.id !== "number") throw new Error(`GitLab did not post the reply on discussion ${thread}`);
  }

  /** Checked the same way: an answer that does not read as resolved is a resolve that did not happen. */
  async resolve(thread: string, ctx: RuntimeContext): Promise<void> {
    const answer = await this.gl(ctx).put<Discussion | null>(this.discussion(thread), { resolved: true });
    if (!answer || threadOf(answer)?.resolved !== true) throw new Error(`GitLab did not resolve discussion ${thread}`);
  }

  /** A discussion's path, by the merge request `threads` read it on — or a refusal, before anything is asked. */
  private discussion(thread: string): string {
    const pull = this.discussions.get(thread);
    if (pull === undefined) {
      throw new Error(`no merge request read so far has the discussion ${thread}, so it cannot be answered or resolved`);
    }
    return `/merge_requests/${pull}/discussions/${encodeURIComponent(thread)}`;
  }

  async heads(): Promise<BranchHeads> {
    return branchHeads(this.git);
  }

  async push(branch: string, item: string, ctx: HookContext): Promise<void> {
    await push(this.git, this.gl(ctx), branch, item, ctx.signal);
  }

  /**
   * The `api` scope, then the project: one the token cannot see is a 404,
   * and without Developer membership it can read merge requests but open
   * none. Each refusal names which is missing. Writes nothing.
   */
  async check(ctx: RuntimeContext): Promise<void> {
    const gl = this.gl(ctx);
    const failed = (what: string, e: unknown): Error =>
      tokenRejected(e) ?? new Error(`${what} failed: ${e instanceof Error ? e.message : String(e)}`);

    let scopes: string[];
    try {
      scopes = await gl.scopes();
    } catch (e) {
      throw failed("the token's scope check", e);
    }
    if (!scopes.includes("api")) {
      throw new Error(`token needs the "api" scope; it has ${scopes.length === 0 ? "none" : scopes.join(", ")}`);
    }

    try {
      await gl.get("");
    } catch (e) {
      if (statusOf(e) === 404) {
        throw new Error(`token cannot see the project ${this.project}; give its user Developer access to it`);
      }
      throw failed(`the project check on ${this.project}`, e);
    }

    // The role GitLab grants the token's user here, inherited and invited
    // ones included. A public project answers a stranger too, and the
    // project's own `permissions` names neither an inherited nor an invited
    // role, so seeing it says nothing. An administrator needs no membership.
    let level: unknown;
    try {
      const me = await gl.user();
      if (me.admin) return this.pipelinesReadable(gl);
      level = (await gl.get<{ access_level?: unknown } | null>(`/members/all/${me.id}`))?.access_level;
    } catch (e) {
      if (statusOf(e) === 404) throw new Error(`token's user is not a member of ${this.project}; it needs Developer access`);
      throw failed(`the membership check on ${this.project}`, e);
    }
    if (typeof level !== "number" || level < DEVELOPER) {
      throw new Error(`token needs Developer access on ${this.project}; it has ${typeof level === "number" ? LEVELS[level] ?? `level ${level}` : "none GitLab names"}`);
    }
    return this.pipelinesReadable(gl);
  }

  /**
   * Every read of an open merge request asks for its pipeline, so a token
   * that cannot read them would fail every read and every briefing. An empty
   * project answers an empty list, which is a pass; a 404 is not: the project
   * was just read, so a probe that read nothing is not a pass.
   */
  private async pipelinesReadable(gl: Client): Promise<void> {
    try {
      await gl.get(`/pipelines?per_page=1`);
    } catch (e) {
      throw tokenRejected(e) ?? new Error(
        statusOf(e) === 403
          ? `token cannot read pipelines on ${this.project}; it needs the "api" scope and Developer access, and CI/CD enabled on the project`
          : `the pipeline check on ${this.project} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
