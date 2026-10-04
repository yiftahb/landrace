import { createHash } from "node:crypto";
import type { RuntimeConfig, RuntimeContext } from "#namespace.js";

/**
 * GitLab's REST v4, in memory, behind the `fetchImpl` the client takes — the
 * endpoints the forge calls, answering in GitLab's documented shapes. A fetch
 * rather than a server: a write step's sandbox cannot bind loopback.
 *
 * It refuses what GitLab refuses, because those refusals are what the forge
 * is shaped by: a second open merge request from one branch is a 409, and a
 * diff position GitLab cannot place — a context line given only its new
 * number — is a 400.
 */
export const BASE = "https://gitlab.example.com";
export const PROJECT = "group/app";
export const BOT = "landrace-bot";
export const TOKEN = "glpat-test-token-0123456789";
const PROJECT_ID = 42;

export interface FakePosition {
  position_type: "text" | "file";
  base_sha: string;
  start_sha: string;
  head_sha: string;
  old_path: string;
  new_path: string;
  new_line?: number | null;
  old_line?: number | null;
}

export interface FakeNote {
  id: number;
  body: string;
  author: { username: string };
  created_at: string;
  system: boolean;
  resolvable: boolean;
  resolved: boolean;
  type: string | null;
  position?: FakePosition;
}

export interface FakeDiscussion {
  id: string;
  individual_note: boolean;
  notes: FakeNote[];
}

export interface FakeDiff {
  old_path: string;
  new_path: string;
  diff: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
}

/** A commit status a tool posted — a scanner's, a reviewer's — the latest of its name. */
export interface FakeStatus {
  name: string;
  status: string;
  allow_failure?: boolean;
  description?: string | null;
  target_url?: string | null;
}

export interface FakeMr {
  iid: number;
  title: string;
  state: "opened" | "closed" | "merged" | "locked";
  source_branch: string;
  target_branch: string;
  source_project_id: number;
  target_project_id: number;
  sha: string;
  web_url: string;
  created_at: string;
  updated_at: string;
  diffs: FakeDiff[];
  discussions: FakeDiscussion[];
  /**
   * Its pipelines, in the order they were run; the API answers newest first.
   * `ref` is the merge request's source branch unless said: a merged results
   * pipeline's is `refs/merge-requests/<iid>/merge`, and its `sha` the
   * merge-result commit, whose parents `commits` holds. A `source: external`
   * pipeline is the commit statuses tools posted on its sha, `statuses`.
   */
  pipelines?: Array<{ id: number; sha: string; status: string; ref?: string; source?: string; statuses?: FakeStatus[] }>;
  /** The failed jobs of a pipeline, by its id. */
  failedJobs?: Map<number, Array<{ id: number; name: string }>>;
  /** A job's trace, by its id; a job with none answers 404. */
  traces?: Map<number, string>;
  /** False: GitLab refuses the merge with a 405 and its own words. */
  mergeable?: boolean;
  /** False: the token's user may not merge it — GitLab's `can_be_merged_by` — which is answered 401 before anything else. */
  mayMerge?: boolean;
  /** "Branch cannot be merged": 406 on an older GitLab, 422 on a newer one, answered after mergeability and before the head. */
  branchRefusal?: 406 | 422;
  /** What GitLab says of its mergeability, on a read of the merge request: `checking` while it works it out. */
  detailed_merge_status?: string;
  /**
   * How many files GitLab says it changes: the diff's length unless said —
   * "1000+" past GitLab's diff limits, null while it is still working the
   * diff out, as on a merge request just opened.
   */
  changes_count?: string | null;
}

export interface FakeSettings {
  /** What `/personal_access_tokens/self` says the token holds. */
  scopes: string[];
  /** The token's access level on the project — 30 is Developer — or null where GitLab names none. */
  access: number | null;
  /** Whether the token can see the project at all: GitLab answers 404 when it cannot. */
  visible: boolean;
  /** The project's default branch, which a merge request is proposed into. */
  defaultBranch: string;
  /** Whether the token's user administers the instance: GitLab names no membership for one. */
  admin: boolean;
}

export interface FakeGitLab {
  fetchImpl: typeof fetch;
  settings: FakeSettings;
  mrs: Map<number, FakeMr>;
  /** The project's commits GitLab can read, by sha: each one's `parent_ids`. Any other sha answers 404. */
  commits: Map<string, string[]>;
  /** Every request that reached the boundary: method, path below `/api/v4`, query and JSON body. */
  requests: Array<{ method: string; path: string; query: URLSearchParams; body: Record<string, unknown> }>;
  /** A merge request, the way a person or a forge UI opens one. */
  open(mr: Partial<FakeMr> & { source_branch: string }): FakeMr;
  /** The diff a merge request from `branch` shows, set before it is opened. */
  diffsFor(branch: string, diffs: Array<Partial<FakeDiff> & { new_path: string; diff: string }>): void;
  /** A discussion, as somebody starts one: a resolvable thread unless said otherwise. */
  discuss(iid: number, d: {
    body: string; author?: string; resolvable?: boolean; resolved?: boolean; system?: boolean; individual?: boolean;
    position?: Partial<FakePosition>; replies?: Array<{ author: string; body: string }>;
  }): FakeDiscussion;
  /** The context a hook is handed, with these secrets. */
  ctx(secrets?: Record<string, string>): RuntimeContext;
  /** Answer the next request `match` picks with `status`, once — a 500, a 429, a dropped connection. */
  breakNext(match: (r: { method: string; path: string }) => boolean, status?: number): void;
}

/** A merge request as the API shows one: its diff and discussions are endpoints of their own. */
const shown = (mr: FakeMr): Omit<FakeMr, "diffs" | "discussions"> => {
  const { diffs, discussions, pipelines, failedJobs, traces, mergeable, mayMerge, branchRefusal, ...rest } = mr;
  void [discussions, pipelines, failedJobs, traces, mergeable, mayMerge, branchRefusal];
  return { ...rest, changes_count: mr.changes_count === undefined ? String(diffs.length) : mr.changes_count };
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

/** For each new-side line a patch shows, its old-side number — null for an added line. */
function sides(patch: string): Map<number, number | null> {
  const out = new Map<number, number | null>();
  let oldAt = 0;
  let newAt = 0;
  for (const row of patch.replace(/\n$/, "").split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      oldAt = Number(hunk[1]);
      newAt = Number(hunk[2]);
      continue;
    }
    if (newAt === 0 || row.startsWith("\\")) continue;
    if (row.startsWith("-")) oldAt++;
    else if (row.startsWith("+")) out.set(newAt++, null);
    else out.set(newAt++, oldAt++);
  }
  return out;
}

export function createFakeGitLab(): FakeGitLab {
  const settings: FakeSettings = { scopes: ["api"], access: 30, visible: true, defaultBranch: "main", admin: false };
  let broken: { match: (r: { method: string; path: string }) => boolean; status: number } | null = null;
  const mrs = new Map<number, FakeMr>();
  const commits = new Map<string, string[]>();
  const branchDiffs = new Map<string, FakeDiff[]>();
  const requests: FakeGitLab["requests"] = [];
  let nextIid = 1;
  let nextNote = 100;
  let minute = 0;
  const now = (): string => new Date(Date.UTC(2026, 8, 1) + minute++ * 60_000).toISOString();
  const discussionId = (n: number): string => createHash("sha1").update(`discussion-${n}`).digest("hex");

  const noteOf = (author: string, body: string, extra: Partial<FakeNote> = {}): FakeNote => ({
    id: nextNote++, body, author: { username: author }, created_at: now(), system: false, resolvable: true, resolved: false,
    type: "DiscussionNote", ...extra,
  });

  const open: FakeGitLab["open"] = (mr) => {
    const iid = mr.iid ?? nextIid;
    nextIid = Math.max(nextIid, iid + 1);
    const at = now();
    const created: FakeMr = {
      iid,
      title: mr.title ?? `MR !${iid}`,
      state: mr.state ?? "opened",
      source_branch: mr.source_branch,
      target_branch: mr.target_branch ?? settings.defaultBranch,
      source_project_id: mr.source_project_id ?? PROJECT_ID,
      target_project_id: mr.target_project_id ?? PROJECT_ID,
      sha: mr.sha ?? `head-${iid}`,
      web_url: mr.web_url ?? `${BASE}/${PROJECT}/-/merge_requests/${iid}`,
      created_at: mr.created_at ?? at,
      updated_at: mr.updated_at ?? at,
      diffs: mr.diffs ?? branchDiffs.get(mr.source_branch) ?? [],
      discussions: mr.discussions ?? [],
      ...(mr.pipelines ? { pipelines: mr.pipelines } : {}),
      ...(mr.failedJobs ? { failedJobs: mr.failedJobs } : {}),
      ...(mr.traces ? { traces: mr.traces } : {}),
      ...(mr.mergeable === undefined ? {} : { mergeable: mr.mergeable }),
      ...(mr.mayMerge === undefined ? {} : { mayMerge: mr.mayMerge }),
      ...(mr.branchRefusal === undefined ? {} : { branchRefusal: mr.branchRefusal }),
      ...(mr.detailed_merge_status === undefined ? {} : { detailed_merge_status: mr.detailed_merge_status }),
      ...(mr.changes_count === undefined ? {} : { changes_count: mr.changes_count }),
    };
    mrs.set(iid, created);
    return created;
  };

  const discuss: FakeGitLab["discuss"] = (iid, d) => {
    const mr = mrs.get(iid);
    if (!mr) throw new Error(`no merge request !${iid}`);
    const resolvable = d.resolvable ?? !d.individual;
    const first = noteOf(d.author ?? BOT, d.body, {
      resolvable, resolved: d.resolved ?? false, system: d.system ?? false,
      type: d.position ? "DiffNote" : d.individual ? null : "DiscussionNote",
      ...(d.position ? {
        position: {
          position_type: "text", base_sha: `base-${iid}`, start_sha: `base-${iid}`, head_sha: mr.sha, old_path: "", new_path: "",
          ...d.position,
        } as FakePosition,
      } : {}),
    });
    const replies = (d.replies ?? []).map((r) => noteOf(r.author, r.body, { resolvable, resolved: d.resolved ?? false }));
    const discussion: FakeDiscussion = { id: discussionId(first.id), individual_note: d.individual ?? false, notes: [first, ...replies] };
    mr.discussions.push(discussion);
    return discussion;
  };

  /** One page of `all`, by GitLab's `page` and `per_page`, with the `x-next-page` header it answers. */
  const page = (all: unknown[], query: URLSearchParams): Response => {
    const per = Math.min(Number(query.get("per_page") ?? 20), 100);
    const at = Number(query.get("page") ?? 1);
    const slice = all.slice((at - 1) * per, at * per);
    return json(slice, 200, { "x-next-page": at * per < all.length ? String(at + 1) : "" });
  };

  const badPosition = (): Response =>
    json({ message: "400 Bad request - Note {:line_code=>[\"can't be blank\", \"must be a valid line code\"]}" }, 400);

  /** Whether GitLab could place a new discussion here: on the merge request's diff, both sides named where both exist. */
  const placeable = (mr: FakeMr, p: Partial<FakePosition>): boolean => {
    if (p.base_sha !== `base-${mr.iid}` || p.start_sha !== `base-${mr.iid}` || p.head_sha !== mr.sha) return false;
    const diff = mr.diffs.find((d) => d.new_path === p.new_path && d.old_path === p.old_path);
    if (!diff) return false;
    if (p.position_type === "file") return true;
    if (p.position_type !== "text" || typeof p.new_line !== "number") return false;
    const line = sides(diff.diff);
    if (!line.has(p.new_line)) return false;
    const old = line.get(p.new_line);
    return old === null ? p.old_line === undefined || p.old_line === null : p.old_line === old;
  };

  const fetchImpl = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>);
    if (!url.href.startsWith(`${BASE}/api/v4/`)) return new Response("not this GitLab", { status: 404 });
    const path = url.pathname.slice("/api/v4".length);
    requests.push({ method, path, query: url.searchParams, body });

    if (broken?.match({ method, path })) {
      const { status } = broken;
      broken = null;
      return json({ message: `${status} the fake broke here` }, status);
    }

    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== `Bearer ${TOKEN}`) return json({ message: "401 Unauthorized" }, 401);

    if (path === "/user" && method === "GET") return json({ id: 7, username: BOT, ...(settings.admin ? { is_admin: true } : {}) });
    if (path === "/personal_access_tokens/self" && method === "GET") {
      return json({ id: 3, name: "landrace", active: true, revoked: false, scopes: settings.scopes });
    }

    const projectPath = `/projects/${encodeURIComponent(PROJECT)}`;
    if (!path.startsWith(projectPath) || !settings.visible) return json({ message: "404 Project Not Found" }, 404);
    const rest = path.slice(projectPath.length);

    if (rest === "" && method === "GET") {
      return json({
        id: PROJECT_ID, path_with_namespace: PROJECT, default_branch: settings.defaultBranch,
        permissions: { project_access: settings.access === null ? null : { access_level: settings.access }, group_access: null },
      });
    }

    // A user's effective role, inherited and invited ones included; no membership at all is a 404.
    if (rest === "/members/all/7" && method === "GET") {
      return settings.access === null
        ? json({ message: "404 Not found" }, 404)
        : json({ id: 7, username: BOT, access_level: settings.access });
    }

    // Pipelines newest first, as GitLab lists them: the highest id is the latest.
    const newest = (all: FakeMr[]) => all.flatMap((m) => m.pipelines ?? []).sort((a, b) => b.id - a.id);
    if (rest === "/pipelines" && method === "GET") return page(newest([...mrs.values()]), url.searchParams);
    const jobs = /^\/pipelines\/(\d+)\/jobs$/.exec(rest);
    if (jobs && method === "GET") {
      const owner = [...mrs.values()].find((m) => m.pipelines?.some((p) => p.id === Number(jobs[1])));
      const failed = url.searchParams.get("scope[]") === "failed" ? owner?.failedJobs?.get(Number(jobs[1])) ?? [] : [];
      return page(failed.map((j) => ({ ...j, status: "failed" })), url.searchParams);
    }
    // A commit's statuses, the latest of each name, narrowed to one pipeline by `pipeline_id`.
    const statuses = /^\/repository\/commits\/([^/]+)\/statuses$/.exec(rest);
    if (statuses && method === "GET") {
      const sha = decodeURIComponent(statuses[1] ?? "");
      const id = url.searchParams.get("pipeline_id");
      const on = newest([...mrs.values()]).filter((p) => p.sha === sha && (id === null || p.id === Number(id)));
      return page(on.flatMap((p) => (p.statuses ?? []).map((s) => ({ allow_failure: false, description: null, target_url: null, ...s, sha }))), url.searchParams);
    }
    const commit = /^\/repository\/commits\/([^/]+)$/.exec(rest);
    if (commit && method === "GET") {
      const sha = decodeURIComponent(commit[1] ?? "");
      const parents = commits.get(sha);
      return parents === undefined ? json({ message: "404 Commit Not Found" }, 404) : json({ id: sha, parent_ids: parents });
    }
    const trace = /^\/jobs\/(\d+)\/trace$/.exec(rest);
    if (trace && method === "GET") {
      const text = [...mrs.values()].map((m) => m.traces?.get(Number(trace[1]))).find((t) => t !== undefined);
      return text === undefined ? json({ message: "404 Not found" }, 404) : new Response(text, { status: 200, headers: { "Content-Type": "text/plain" } });
    }

    if (rest === "/merge_requests" && method === "GET") {
      const q = url.searchParams;
      const state = q.get("state") ?? "all";
      const since = q.get("updated_after");
      const listed = [...mrs.values()]
        .filter((mr) => state === "all" || mr.state === state)
        .filter((mr) => q.get("source_branch") === null || mr.source_branch === q.get("source_branch"))
        .filter((mr) => since === null || mr.updated_at > since)
        .sort((a, b) => (q.get("order_by") === "updated_at" ? b.updated_at.localeCompare(a.updated_at) : b.iid - a.iid))
        .map(shown);
      return page(listed, q);
    }

    if (rest === "/merge_requests" && method === "POST") {
      const source = String(body.source_branch ?? "");
      const existing = [...mrs.values()].find((mr) => mr.state === "opened" && mr.source_branch === source);
      if (existing) return json({ message: [`Another open merge request already exists for this source branch: !${existing.iid}`] }, 409);
      const created = shown(open({ source_branch: source, target_branch: String(body.target_branch ?? ""), title: String(body.title ?? "") }));
      return json(created, 201);
    }

    const one = /^\/merge_requests\/(\d+)(\/.*)?$/.exec(rest);
    const mr = one ? mrs.get(Number(one[1])) : undefined;
    if (!one || !mr) return json({ message: "404 Not found" }, 404);
    const sub = one[2] ?? "";

    if (sub === "" && method === "GET") {
      return json({ ...shown(mr), diff_refs: { base_sha: `base-${mr.iid}`, start_sha: `base-${mr.iid}`, head_sha: mr.sha } });
    }
    if (sub === "" && method === "PUT") {
      if (body.state_event === "close") mr.state = "closed";
      mr.updated_at = now();
      return json(shown(mr));
    }
    if (sub === "/pipelines" && method === "GET") {
      const listed = [...(mr.pipelines ?? [])].sort((a, b) => b.id - a.id).map(({ statuses: _, ...p }) => ({ ref: mr.source_branch, source: "merge_request_event", ...p }));
      return page(listed, url.searchParams);
    }
    if (sub === "/merge" && method === "PUT") {
      // GitLab's own order: who may merge, then mergeability — "pipelines
      // must succeed" included — then the branch, and the head only last.
      if (mr.mayMerge === false) return json({ message: "401 Unauthorized" }, 401);
      if (mr.state !== "opened" || mr.mergeable === false) return json({ message: "405 Method Not Allowed" }, 405);
      if (mr.branchRefusal !== undefined) return json({ message: "Branch cannot be merged" }, mr.branchRefusal);
      if (body.sha !== mr.sha) return json({ message: "SHA does not match HEAD of source branch" }, 409);
      mr.state = "merged";
      mr.updated_at = now();
      return json(shown(mr));
    }
    if (sub === "/diffs" && method === "GET") return page(mr.diffs, url.searchParams);
    if (sub === "/discussions" && method === "GET") return page(mr.discussions, url.searchParams);
    // GitLab runs the quick actions in every note it is handed, whoever wrote
    // the text: `/close` alone on a line closes the merge request.
    if (method === "POST" && /^\/close\b/m.test(String(body.body ?? ""))) mr.state = "closed";
    if (sub === "/discussions" && method === "POST") {
      const position = body.position as Partial<FakePosition> | undefined;
      if (position && !placeable(mr, position)) return badPosition();
      const made = discuss(mr.iid, { body: String(body.body ?? ""), ...(position ? { position } : {}) });
      return json(made, 201);
    }
    if (sub === "/notes" && method === "GET") {
      const notes = mr.discussions.flatMap((d) => d.notes).sort((a, b) => a.created_at.localeCompare(b.created_at));
      return page(url.searchParams.get("sort") === "desc" ? notes.reverse() : notes, url.searchParams);
    }
    if (sub === "/notes" && method === "POST") {
      const made = discuss(mr.iid, { body: String(body.body ?? ""), individual: true });
      return json(made.notes[0], 201);
    }

    const thread = /^\/discussions\/([0-9a-f]+)(\/notes)?$/.exec(sub);
    const discussion = thread ? mr.discussions.find((d) => d.id === thread[1]) : undefined;
    if (!thread || !discussion) return json({ message: "404 Not found" }, 404);
    if (thread[2] && method === "POST") {
      const first = discussion.notes[0];
      const note = noteOf(BOT, String(body.body ?? ""), { resolvable: first?.resolvable ?? false, resolved: first?.resolved ?? false });
      discussion.notes.push(note);
      return json(note, 201);
    }
    if (!thread[2] && method === "PUT") {
      const resolved = body.resolved === true || url.searchParams.get("resolved") === "true";
      for (const note of discussion.notes) if (note.resolvable) note.resolved = resolved;
      return json(discussion);
    }
    return json({ message: "404 Not found" }, 404);
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    settings,
    mrs,
    commits,
    requests,
    open,
    discuss,
    diffsFor: (branch, diffs) => {
      branchDiffs.set(branch, diffs.map((d) => ({
        old_path: d.old_path ?? d.new_path, new_file: false, renamed_file: false, deleted_file: false, ...d,
      })));
    },
    breakNext: (match, status = 500) => {
      broken = { match, status };
    },
    ctx: (secrets = { gitlabToken: TOKEN, gitlabBaseUrl: BASE }) => ({
      config: {} as RuntimeConfig,
      secrets: new Map(Object.entries(secrets)),
      signal: new AbortController().signal,
      log: () => {},
    }),
  };
}
