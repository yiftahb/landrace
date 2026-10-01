/*
 * GitLab merge requests as a project's forge: the REST calls, the mapping of
 * merge requests, discussions and diffs into the kit's plain shapes, and the
 * push URL it trusts with a token. Everything else a forge does is
 * `BaseForge`'s.
 */
import { type RuntimeContext, sameLogin } from "landrace/hooks";
import {
  BaseForge, DONE_WINDOW_MS, MAX_ISSUE_PAGES, MAX_THREAD_PAGES, prBranch, TICKET_PAGE,
  type BranchHeads, type ChangedFile, type Git, type PullRecord, type ReviewThread, type ThreadComment,
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
  tickets: [],
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
    this.git = git ?? (async () => "");
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

  /** Every merge request from the ticket's `landrace/{ticket}` branch, merged and closed ones too, and never a fork's. */
  async pullsNaming(ticket: string, ctx: RuntimeContext): Promise<PullRecord[]> {
    const { items, more } = await this.gl(ctx).pages<MergeRequest>(
      `/merge_requests?state=all&order_by=created_at&sort=desc&source_branch=${encodeURIComponent(prBranch(ticket))}`, 1,
    );
    if (more || items.length > TICKET_PAGE) throw tooMany(`#${ticket} has more than ${TICKET_PAGE} merge requests on its branch`);
    return items.filter((mr) => mr.source_project_id === mr.target_project_id).map(recordOf);
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

  async openPull({ branch, title }: { ticket: string; branch: string; title: string }, ctx: RuntimeContext): Promise<void> {
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
   * File findings, then line findings, as diff discussions on the merge
   * request's current diff; then the review's prose as a plain note — last,
   * because its marker says the round is on GitLab, and plain, because
   * nobody can resolve one and so no count ever includes it.
   *
   * GitLab places a line by both sides where both exist: a context line
   * given only its new number is refused, and a renamed file is named by its
   * old path beside its new one.
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
      const diffs = new Map((await this.diffs(pull, ctx)).map((d) => [d.new_path, d]));
      const at = (path: string) => ({ base_sha, start_sha, head_sha, old_path: diffs.get(path)?.old_path ?? path, new_path: path });
      for (const f of files) await gl.post(on, { body: f.body, position: { position_type: "file", ...at(f.path) } });
      for (const c of lines) {
        const old = oldLineOf(diffs.get(c.path)?.diff ?? "", c.line);
        await gl.post(on, { body: c.body, position: { position_type: "text", ...at(c.path), new_line: c.line, ...(old === null ? {} : { old_line: old }) } });
      }
    }
    await gl.post(`/merge_requests/${pull}/notes`, { body });
  }

  /** Checked, not assumed: an answer with no note is a reply that did not land. */
  async reply(thread: string, body: string, ctx: RuntimeContext): Promise<void> {
    const note = await this.gl(ctx).post<{ id?: unknown } | null>(`${this.discussion(thread)}/notes`, { body });
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
    throw new Error("not yet");
  }

  async push(): Promise<void> {
    throw new Error("not yet");
  }

  /**
   * The `api` scope, then the project: one the token cannot see is a 404,
   * and below Developer it can read merge requests but open none. Each
   * refusal names which of the two is missing. Writes nothing.
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

    let info: { permissions?: { project_access?: { access_level?: unknown } | null; group_access?: { access_level?: unknown } | null } | null };
    try {
      info = await gl.get("");
    } catch (e) {
      if (statusOf(e) === 404) {
        throw new Error(`token cannot see the project ${this.project}; give its user Developer access to it`);
      }
      throw failed(`the project check on ${this.project}`, e);
    }
    // The higher of the two, as GitLab grants it. Neither named — an
    // administrator's, say — is no level to judge, and is let through.
    const levels = [info.permissions?.project_access?.access_level, info.permissions?.group_access?.access_level]
      .filter((l): l is number => typeof l === "number");
    const level = Math.max(...levels);
    if (levels.length > 0 && level < DEVELOPER) {
      throw new Error(`token needs Developer access on ${this.project}; it has ${LEVELS[level] ?? `level ${level}`}`);
    }
  }
}
