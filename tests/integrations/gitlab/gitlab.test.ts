import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createClient, GitLab } from "landrace/integrations/gitlab";
import { branchHeads, compose, gitIn } from "landrace/kit";
import { isEffectRefused, parseMarker, PULL_REQUEST_KIND } from "#conventions.js";
import type { Effect, Git, Graph, HookContext, Snapshot } from "#namespace.js";
import { MemoryTracker } from "#testing/external-state.js";
import { BASE, createFakeGitLab, type FakeGitLab, PROJECT, TOKEN } from "#tests/integrations/gitlab/fake-gitlab.js";
import { commitAt, commitOn, gitRepoWithOrigin, pushedElsewhere, removeRepos } from "#tests/support/repo.js";

/* Real git in the push tests: see tests/agent/worktree.test.ts for why a minute. */
jest.setTimeout(60_000);

const exec = promisify(execFile);
const made: string[] = [];
afterAll(async () => {
  while (made.length) await rm(made.pop() as string, { recursive: true, force: true });
  await removeRepos();
});

/** A checkout with no branches at all: enough for every test that never pushes. */
const noGit: Git = async () => "";

const forgeOver = (gl: FakeGitLab, project = PROJECT): GitLab => new GitLab({ project, fetchImpl: gl.fetchImpl, git: noGit });

describe("check", () => {
  it("passes a token with the api scope and Developer access on the project", async () => {
    const gl = createFakeGitLab();
    await expect(forgeOver(gl).check(gl.ctx())).resolves.toBeUndefined();
  });

  it("names the missing gitlabToken secret", async () => {
    const gl = createFakeGitLab();
    await expect(forgeOver(gl).check(gl.ctx({}))).rejects.toThrow(/"gitlabToken" secret/);
  });

  it("says the token was rejected, not that it lacks a scope, on a 401", async () => {
    const gl = createFakeGitLab();
    await expect(forgeOver(gl).check(gl.ctx({ gitlabToken: "wrong", gitlabBaseUrl: BASE }))).rejects.toThrow(/rejected by GitLab \(401\)/);
  });

  it("names the api scope, and what the token holds instead", async () => {
    const gl = createFakeGitLab();
    gl.settings.scopes = ["read_api", "read_repository"];
    await expect(forgeOver(gl).check(gl.ctx())).rejects.toThrow(/needs the "api" scope; it has read_api, read_repository/);
  });

  it("names the project a token cannot see", async () => {
    const gl = createFakeGitLab();
    gl.settings.visible = false;
    await expect(forgeOver(gl).check(gl.ctx())).rejects.toThrow(/cannot see the project group\/app/);
  });

  it("names Developer access when the token's is lower", async () => {
    const gl = createFakeGitLab();
    gl.settings.access = 20;
    await expect(forgeOver(gl).check(gl.ctx())).rejects.toThrow(/needs Developer access on group\/app/);
  });

  /* A public project answers anyone, member or not: being able to read it is not being able to open a merge request on it. */
  it("names a project the token can see but whose user is no member of", async () => {
    const gl = createFakeGitLab();
    gl.settings.access = null;
    await expect(forgeOver(gl).check(gl.ctx())).rejects.toThrow(/user is not a member of group\/app; it needs Developer access/);
  });

  it("lets an instance administrator through, who needs no membership", async () => {
    const gl = createFakeGitLab();
    gl.settings.access = null;
    gl.settings.admin = true;
    await expect(forgeOver(gl).check(gl.ctx())).resolves.toBeUndefined();
  });
});

describe("the client", () => {
  it.each([
    "http://gitlab.example.com",
    "https://gitlab.example.com/api",
    "https://user:pass@gitlab.example.com",
    "https://gitlab.example.com?x=1",
    "gitlab.example.com",
  ])("refuses gitlabBaseUrl %s before any request", (baseUrl) => {
    expect(() => createClient({ project: PROJECT, token: TOKEN, baseUrl })).toThrow(/https:\/\/host\[:port\]/);
  });

  it("takes a port, and a trailing slash", () => {
    expect(createClient({ project: PROJECT, token: TOKEN, baseUrl: "https://gitlab.example.com:8443/" }).baseUrl)
      .toBe("https://gitlab.example.com:8443");
  });

  it.each(["app", "group/../app", "group/app?x", ".hidden/app", "group//app"])("refuses project %s", (project) => {
    expect(() => createClient({ project, token: TOKEN })).toThrow(/project must be/);
  });

  it("defaults to gitlab.com", () => {
    expect(createClient({ project: PROJECT, token: TOKEN }).baseUrl).toBe("https://gitlab.com");
  });

  it("never puts the token in a failure's message", async () => {
    const gl = createFakeGitLab();
    gl.settings.visible = false;
    const client = createClient({ project: PROJECT, token: TOKEN, baseUrl: BASE, fetchImpl: gl.fetchImpl });
    const failure = await client.get("").then(() => "", (e: unknown) => String(e));
    expect(failure).toMatch(/404/);
    expect(failure).not.toContain(TOKEN);
  });
});

describe("pulls", () => {
  it("lists every open merge request as the kit reads one", async () => {
    const gl = createFakeGitLab();
    const mr = gl.open({ source_branch: "landrace/7", title: "Add a thing", sha: "abc" });
    expect(await forgeOver(gl).pulls(gl.ctx())).toEqual([{
      number: mr.iid, title: "Add a thing", link: mr.web_url, merged: false, closed: false, headSha: "abc", conflicts: false,
      branch: "landrace/7", createdAt: mr.created_at, updatedAt: mr.updated_at, items: [],
    }]);
  });

  it("names no branch for a fork's merge request: the name is in somebody else's project", async () => {
    const gl = createFakeGitLab();
    gl.open({ source_branch: "landrace/7", source_project_id: 99 });
    expect((await forgeOver(gl).pulls(gl.ctx()))[0]?.branch).toBeUndefined();
  });

  it("adds the merged and closed ones updated inside the Done window, and no older", async () => {
    const gl = createFakeGitLab();
    const recent = new Date().toISOString();
    gl.open({ source_branch: "landrace/1", state: "merged", updated_at: recent });
    gl.open({ source_branch: "landrace/2", state: "closed", updated_at: recent });
    gl.open({ source_branch: "landrace/3", state: "merged", updated_at: "2020-01-01T00:00:00.000Z" });
    const pulls = await forgeOver(gl).pulls(gl.ctx());
    expect(pulls.map((p) => [p.branch, p.merged, p.closed]).sort()).toEqual([["landrace/1", true, false], ["landrace/2", false, true]]);
  });

  it("refuses past the bound rather than list part of the open ones", async () => {
    const gl = createFakeGitLab();
    for (let i = 0; i < 1000; i++) gl.open({ source_branch: `b${i}` });
    await expect(forgeOver(gl).pulls(gl.ctx())).rejects.toThrow(/more than 1000 open merge requests/);
  });
});

describe("pullsNaming", () => {
  it("reads every merge request from the item's branch, merged and closed ones too, and no fork's", async () => {
    const gl = createFakeGitLab();
    gl.open({ source_branch: "landrace/7", state: "merged" });
    gl.open({ source_branch: "landrace/7" });
    gl.open({ source_branch: "landrace/7", source_project_id: 99 });
    gl.open({ source_branch: "landrace/8" });
    const pulls = await forgeOver(gl).pullsNaming("7", gl.ctx());
    expect(pulls.map((p) => [p.number, p.branch, p.merged])).toEqual([[2, "landrace/7", false], [1, "landrace/7", true]]);
  });

  // Re-review N9, as on GitHub: forks are left out before anything is counted.
  it("leaves forks out before it counts: 150 forks' merge requests from a branch named landrace/7 do not halt #7", async () => {
    const gl = createFakeGitLab();
    // Opened first, so newest-first it is last: on the second page, past every fork.
    gl.open({ source_branch: "landrace/7" });
    for (let i = 0; i < 150; i++) gl.open({ source_branch: "landrace/7", source_project_id: 99 });
    const pulls = await forgeOver(gl).pullsNaming("7", gl.ctx());
    expect(pulls.map((p) => p.number)).toEqual([1]);
  });

  it("refuses a list it could not read to its end, forks' among them", async () => {
    const gl = createFakeGitLab();
    for (let i = 0; i < 1000; i++) gl.open({ source_branch: "landrace/7", source_project_id: 99 });
    await expect(forgeOver(gl).pullsNaming("7", gl.ctx())).rejects.toThrow(/more than 1000 merge requests .*landrace\/7.*forks/);
  });

  it("refuses more than one item read carries", async () => {
    const gl = createFakeGitLab();
    for (let i = 0; i < 51; i++) gl.open({ source_branch: "landrace/7", state: "closed" });
    await expect(forgeOver(gl).pullsNaming("7", gl.ctx())).rejects.toThrow(/#7 has more than 50 merge requests/);
  });
});

describe("threads", () => {
  it("is every resolvable discussion, placed, with its opening and its last word", async () => {
    const gl = createFakeGitLab();
    const mr = gl.open({ source_branch: "landrace/7" });
    const onLine = gl.discuss(mr.iid, { body: "finding", position: { new_path: "src/a.ts", old_path: "src/a.ts", new_line: 2 } });
    const general = gl.discuss(mr.iid, { body: "a question", author: "alice", replies: [{ author: "bob", body: "an answer" }] });
    const done = gl.discuss(mr.iid, { body: "settled", resolved: true });
    const threads = await forgeOver(gl).threads(mr.iid, gl.ctx());
    expect(threads).toEqual([
      { id: onLine.id, resolved: false, path: "src/a.ts", line: 2, first: { body: "finding", author: "landrace-bot" },
        last: { body: "finding", author: "landrace-bot" }, comments: 1, at: onLine.notes[0]?.created_at },
      { id: general.id, resolved: false, path: null, line: null, first: { body: "a question", author: "alice" },
        last: { body: "an answer", author: "bob" }, comments: 2, at: general.notes[0]?.created_at },
      expect.objectContaining({ id: done.id, resolved: true }),
    ]);
  });

  it("never counts a plain note or a system note as a thread", async () => {
    const gl = createFakeGitLab();
    const mr = gl.open({ source_branch: "landrace/7" });
    gl.discuss(mr.iid, { body: "LGTM", author: "alice", individual: true });
    gl.discuss(mr.iid, { body: "added 1 commit", system: true, individual: true, resolvable: false });
    gl.discuss(mr.iid, { body: "changed this line in version 2", system: true });
    expect(await forgeOver(gl).threads(mr.iid, gl.ctx())).toEqual([]);
  });

  it("refuses past the bound rather than count part of them", async () => {
    const gl = createFakeGitLab();
    const mr = gl.open({ source_branch: "landrace/7" });
    for (let i = 0; i < 1000; i++) gl.discuss(mr.iid, { body: `t${i}` });
    await expect(forgeOver(gl).threads(mr.iid, gl.ctx())).rejects.toThrow(/more than 1000 discussions/);
  });
});

describe("changedFiles", () => {
  it("maps GitLab's diffs, a patch with no trailing newline the kit would read as one more line", async () => {
    const gl = createFakeGitLab();
    gl.diffsFor("landrace/7", [
      { new_path: "src/a.ts", diff: "@@ -1,2 +1,3 @@\n line one\n+line two\n line three\n" },
      { new_path: "src/new.ts", new_file: true, diff: "@@ -0,0 +1,2 @@\n+a\n+b\n" },
      { new_path: "src/gone.ts", deleted_file: true, diff: "@@ -1 +0,0 @@\n-x\n" },
      { old_path: "src/old.ts", new_path: "src/moved.ts", renamed_file: true, diff: "" },
    ]);
    const mr = gl.open({ source_branch: "landrace/7" });
    expect(await forgeOver(gl).changedFiles(mr.iid, gl.ctx())).toEqual({
      complete: true,
      files: [
        { path: "src/a.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1,2 +1,3 @@\n line one\n+line two\n line three" },
        { path: "src/new.ts", status: "added", additions: 2, deletions: 0, patch: "@@ -0,0 +1,2 @@\n+a\n+b" },
        { path: "src/gone.ts", status: "removed", additions: 0, deletions: 1, patch: "@@ -1 +0,0 @@\n-x" },
        // A rename's old path: a protected path renamed away is a protected path changed.
        { path: "src/moved.ts", previous: "src/old.ts", status: "renamed", additions: 0, deletions: 0, patch: undefined },
      ],
    });
  });

  /*
   * What `pull.merge`'s protected paths are judged on, and whether that was
   * all of it: GitLab cuts a diff at its own limits and says so only in the
   * merge request's count of changes, and a page bound stops the read.
   */
  const diffs = (n: number) => Array.from({ length: n }, (_, i) => ({ new_path: `src/f${i}.ts`, diff: "@@ -1 +1 @@\n+x\n" }));
  const pages = (gl: FakeGitLab) => gl.requests.filter((r) => r.method === "GET" && /\/merge_requests\/\d+\/diffs$/.test(r.path)).length;

  it("reads every page, the last one short, and calls a list GitLab counts the same whole", async () => {
    const gl = createFakeGitLab();
    gl.diffsFor("landrace/7", diffs(250));
    const mr = gl.open({ source_branch: "landrace/7" });
    const read = await forgeOver(gl).changedFiles(mr.iid, gl.ctx());
    expect(read.complete).toBe(true);
    expect(read.files).toHaveLength(250);
    expect(pages(gl)).toBe(3);
  });

  it("calls a diff GitLab cut at its own limits not whole, though every page was read", async () => {
    const gl = createFakeGitLab();
    gl.diffsFor("landrace/7", diffs(20));
    const mr = gl.open({ source_branch: "landrace/7", changes_count: "1000+" });
    expect(await forgeOver(gl).changedFiles(mr.iid, gl.ctx())).toMatchObject({ complete: false, files: expect.any(Array) });
  });

  it("calls a list not whole when GitLab's count is missing, or names files the pages did not", async () => {
    for (const changes_count of ["", "21"]) {
      const gl = createFakeGitLab();
      gl.diffsFor("landrace/7", diffs(20));
      const mr = gl.open({ source_branch: "landrace/7", changes_count });
      expect(await forgeOver(gl).changedFiles(mr.iid, gl.ctx())).toMatchObject({ complete: false });
    }
  });

  /*
   * GitLab names no count while it is still working the diff out — on a
   * merge request just opened, say. That is not a list cut short but one not
   * settled yet: the merge is left to the next tick, never refused for it.
   */
  it("calls a list GitLab has not counted yet still settling, not cut short", async () => {
    const gl = createFakeGitLab();
    gl.diffsFor("landrace/7", diffs(20));
    const mr = gl.open({ source_branch: "landrace/7", changes_count: null });
    expect(await forgeOver(gl).changedFiles(mr.iid, gl.ctx())).toMatchObject({ complete: false, settling: true });
  });

  it("calls a list stopped at the page bound not whole, and not settling, whatever GitLab counts", async () => {
    for (const changes_count of [undefined, null]) {
      const gl = createFakeGitLab();
      gl.diffsFor("landrace/7", diffs(1_000));
      const mr = gl.open({ source_branch: "landrace/7", ...(changes_count === undefined ? {} : { changes_count }) });
      const read = await forgeOver(gl).changedFiles(mr.iid, gl.ctx());
      expect(read).toEqual({ complete: false, files: expect.any(Array) });
    }
  });

  it("calls a list stopped at the page bound not whole", async () => {
    const gl = createFakeGitLab();
    gl.diffsFor("landrace/7", diffs(1_000));
    const mr = gl.open({ source_branch: "landrace/7" });
    const read = await forgeOver(gl).changedFiles(mr.iid, gl.ctx());
    expect(read).toMatchObject({ complete: false });
    expect(read.files).toHaveLength(1_000);
    expect(pages(gl)).toBe(10);
  });

  it("refuses rather than answer a list a page of which failed", async () => {
    const gl = createFakeGitLab();
    gl.diffsFor("landrace/7", diffs(250));
    const mr = gl.open({ source_branch: "landrace/7" });
    let asked = 0;
    gl.breakNext((r) => r.method === "GET" && /\/diffs$/.test(r.path) && ++asked === 2, 502);
    await expect(forgeOver(gl).changedFiles(mr.iid, gl.ctx())).rejects.toThrow(/502/);
  });
});

describe("reviews", () => {
  it("is the body of every note we posted, and none a person did — a pasted marker cannot skip a round", async () => {
    const gl = createFakeGitLab();
    const mr = gl.open({ source_branch: "landrace/7" });
    gl.discuss(mr.iid, { body: "ours <!-- landrace:review:1 -->", individual: true });
    gl.discuss(mr.iid, { body: "pasted <!-- landrace:review:2 -->", author: "mallory", individual: true });
    expect(await forgeOver(gl).reviews(mr.iid, gl.ctx())).toEqual(["ours <!-- landrace:review:1 -->"]);
  });
});

describe("openPull and closePull", () => {
  it("opens a merge request from the branch into the project's default branch", async () => {
    const gl = createFakeGitLab();
    gl.settings.defaultBranch = "trunk";
    await forgeOver(gl).openPull({ item: "7", branch: "landrace/7", title: "Add a thing" }, gl.ctx());
    expect([...gl.mrs.values()]).toEqual([expect.objectContaining({ source_branch: "landrace/7", target_branch: "trunk", title: "Add a thing", state: "opened" })]);
  });

  it("sends a description only when it has one, inert to GitLab's quick actions", async () => {
    const gl = createFakeGitLab();
    await forgeOver(gl).openPull({ item: "7", branch: "landrace/7", title: "t", description: "For #7.\n/close\n  /merge" }, gl.ctx());
    await forgeOver(gl).openPull({ item: "8", branch: "landrace/8", title: "t" }, gl.ctx());
    const posted = gl.requests.filter((r) => r.method === "POST" && r.path.endsWith("/merge_requests")).map((r) => r.body);
    expect(posted[0]?.description).toBe("For #7.\n\\/close\n  \\/merge");
    expect(posted[1]).not.toHaveProperty("description");
  });

  /* A crash between the request and the next read re-runs the effect; GitLab answers the second with a 409. */
  it("counts GitLab's 'already exists' as opened", async () => {
    const gl = createFakeGitLab();
    gl.open({ source_branch: "landrace/7" });
    await expect(forgeOver(gl).openPull({ item: "7", branch: "landrace/7", title: "t" }, gl.ctx())).resolves.toBeUndefined();
    expect(gl.mrs.size).toBe(1);
  });

  it("says any other refusal", async () => {
    const gl = createFakeGitLab();
    const forge = forgeOver(gl);
    const ctx = gl.ctx();
    await forge.login(ctx);
    gl.settings.visible = false;
    await expect(forge.openPull({ item: "7", branch: "landrace/7", title: "t" }, ctx)).rejects.toThrow(/404/);
  });

  it("closes a merge request without merging it", async () => {
    const gl = createFakeGitLab();
    const mr = gl.open({ source_branch: "landrace/7" });
    await forgeOver(gl).closePull(mr.iid, gl.ctx());
    expect(mr.state).toBe("closed");
  });
});

describe("postReview", () => {
  /** Line 2 added between two context lines: new 1 and 3 are old 1 and 2. */
  const DIFF = "@@ -1,2 +1,3 @@\n line one\n+line two\n line three\n";

  const reviewed = async (diffs: Parameters<FakeGitLab["diffsFor"]>[1] = [{ new_path: "src/a.ts", diff: DIFF }]) => {
    const gl = createFakeGitLab();
    gl.diffsFor("landrace/7", diffs);
    const mr = gl.open({ source_branch: "landrace/7" });
    const forge = forgeOver(gl);
    const path = diffs[0]?.new_path ?? "";
    await forge.postReview(mr.iid, {
      body: "The review.",
      lines: [{ path, line: 2, body: "on the added line" }, { path, line: 3, body: "on a context line" }],
      files: [{ path, body: "line 40: off the hunks" }],
      head: mr.sha,
    }, gl.ctx());
    return { gl, mr, forge };
  };

  it("puts each finding on the diff — an added line by its new number, a context line by both, the rest on the file", async () => {
    const { mr } = await reviewed();
    const positions = mr.discussions.map((d) => [d.notes[0]?.body, d.notes[0]?.position]);
    const refs = { base_sha: `base-${mr.iid}`, start_sha: `base-${mr.iid}`, head_sha: mr.sha, old_path: "src/a.ts", new_path: "src/a.ts" };
    expect(positions).toEqual([
      ["line 40: off the hunks", { position_type: "file", ...refs }],
      ["on the added line", { position_type: "text", ...refs, new_line: 2 }],
      ["on a context line", { position_type: "text", ...refs, new_line: 3, old_line: 2 }],
      ["The review.", undefined],
    ]);
  });

  it("names a renamed file's old path beside its new one", async () => {
    const { mr } = await reviewed([{ old_path: "src/old.ts", new_path: "src/a.ts", renamed_file: true, diff: DIFF }]);
    expect(mr.discussions.slice(0, 3).map((d) => d.notes[0]?.position?.old_path)).toEqual(["src/old.ts", "src/old.ts", "src/old.ts"]);
  });

  it("posts the prose last, as a plain note no count includes", async () => {
    const { gl, mr, forge } = await reviewed();
    expect(gl.requests.filter((r) => r.method === "POST").at(-1)?.path).toMatch(/\/notes$/);
    const threads = await forge.threads(mr.iid, gl.ctx());
    expect(threads.map((t) => t.first?.body)).toEqual(["line 40: off the hunks", "on the added line", "on a context line"]);
  });
});

describe("reply and resolve", () => {
  const withThread = async () => {
    const gl = createFakeGitLab();
    const mr = gl.open({ source_branch: "landrace/7" });
    const discussion = gl.discuss(mr.iid, { body: "a finding" });
    const forge = forgeOver(gl);
    const ctx = gl.ctx();
    await forge.threads(mr.iid, ctx);
    return { gl, discussion, forge, ctx };
  };

  it("replies on the discussion a thread id names", async () => {
    const { discussion, forge, ctx } = await withThread();
    await forge.reply(discussion.id, "fixed", ctx);
    expect(discussion.notes.map((n) => [n.author.username, n.body])).toEqual([["landrace-bot", "a finding"], ["landrace-bot", "fixed"]]);
  });

  it("resolves it", async () => {
    const { discussion, forge, ctx } = await withThread();
    await forge.resolve(discussion.id, ctx);
    expect(discussion.notes.every((n) => n.resolved)).toBe(true);
  });

  it("refuses an id no merge request it read has, asking GitLab nothing", async () => {
    const { gl, forge, ctx } = await withThread();
    const asked = gl.requests.length;
    await expect(forge.reply("f".repeat(40), "x", ctx)).rejects.toThrow(/no merge request read so far has the discussion f{40}/);
    await expect(forge.resolve("f".repeat(40), ctx)).rejects.toThrow(/no merge request read so far/);
    expect(gl.requests.length).toBe(asked);
  });
});

describe("push", () => {
  /** GitLab's own basic credential for a token, the way git would carry it. */
  const BASIC = Buffer.from(`oauth2:${TOKEN}`).toString("base64");

  type Call = { args: string[]; env: Record<string, string> };

  /** git reporting `url` as origin's push URL and a branch to push, with every call written down and nothing sent. */
  const scripted = (url: string, push: () => Promise<string> = async () => ""): { git: Git; calls: Call[] } => {
    const calls: Call[] = [];
    const git: Git = async (args, env = {}) => {
      calls.push({ args, env });
      if (args[0] === "remote") return `${url}\n`;
      if (args[0] === "for-each-ref") return args.includes("refs/heads") ? `refs/heads/landrace/1\0${"a".repeat(40)}\n` : "";
      if (args[0] === "push") return push();
      throw new Error(`the script has no answer for git ${args.join(" ")}`);
    };
    return { git, calls };
  };

  /** The configuration the push handed git through its environment. */
  const configOf = (calls: Call[]): Array<[string, string]> => {
    const env = calls.find((c) => c.args[0] === "push")?.env ?? {};
    return Object.keys(env).filter((k) => k.startsWith("GIT_CONFIG_KEY_"))
      .map((k) => [env[k] ?? "", env[k.replace("KEY", "VALUE")] ?? ""] as [string, string]);
  };

  const pushed = async (git: Git): Promise<void> => {
    const gl = createFakeGitLab();
    const ctx: HookContext = { ...gl.ctx(), item: "1", snapshot: {} };
    await new GitLab({ project: PROJECT, fetchImpl: gl.fetchImpl, git }).push("landrace/1", "1", ctx);
  };

  it.each([`${BASE}/${PROJECT}`, `${BASE}/${PROJECT}.git`])("hands git the token for the project's own URL, %s, in its environment", async (url) => {
    const { git, calls } = scripted(url);
    await pushed(git);
    expect(configOf(calls)).toContainEqual([`http.${url}.extraheader`, `AUTHORIZATION: basic ${BASIC}`]);
    for (const call of calls) for (const secret of [TOKEN, BASIC]) expect(call.args.join(" ")).not.toContain(secret);
  });

  it.each([
    `${BASE}/${PROJECT}-evil.git`,
    `${BASE}/other/app.git`,
    `${BASE}/${PROJECT}.git/`,
    `${BASE}/GROUP/app.git`,
    "https://gitlab.com/group/app.git",
    "https://user@gitlab.example.com/group/app.git",
    "git@gitlab.example.com:group/app.git",
  ])("hands git no token for any other URL: %s", async (url) => {
    const { git, calls } = scripted(url);
    await pushed(git);
    expect(configOf(calls).map(([key]) => key).filter((key) => key.includes("extraheader"))).toEqual([]);
    for (const secret of [TOKEN, BASIC]) expect(JSON.stringify(calls)).not.toContain(secret);
  });

  it("keeps the token and its base64 out of the error when git's own output quotes them", async () => {
    const { git } = scripted(`${BASE}/${PROJECT}.git`, async () => {
      throw new Error(`fatal: unable to access: header AUTHORIZATION: basic ${BASIC} (token ${TOKEN})`);
    });
    const failure = await pushed(git).then(() => "", (e: unknown) => String(e));
    expect(failure).toMatch(/could not push landrace\/1/);
    expect(failure).not.toContain(TOKEN);
    expect(failure).not.toContain(BASIC);
  });

  /* Asked of git itself: the header reaches the project's URL and what git fetches under it, and nothing beside it. */
  it("scopes the header so git sends it to that URL alone", async () => {
    const url = `${BASE}/${PROJECT}.git`;
    const { git, calls } = scripted(url);
    await pushed(git);
    const env = calls.find((c) => c.args[0] === "push")?.env ?? {};
    const header = (at: string): Promise<string | null> =>
      exec("git", ["config", "--get-urlmatch", "http.extraheader", at], { env: { ...process.env, ...env } })
        .then((r) => r.stdout.trim(), () => null);
    expect(await header(`${url}/info/refs`)).toBe(`AUTHORIZATION: basic ${BASIC}`);
    expect(await header(`${BASE}/${PROJECT}-evil.git`)).toBeNull();
    expect(await header(`${BASE}/other/app.git`)).toBeNull();
  });

  /*
   * Re-review N2: the remote branch's head, fetched before a step on the
   * branch — from the URL the push goes to, with the token as the push has it.
   */
  const fetched = (git: Git, branch = "landrace/1"): Promise<string | null> => {
    const gl = createFakeGitLab();
    return new GitLab({ project: PROJECT, fetchImpl: gl.fetchImpl, git }).remoteHead(branch, gl.ctx());
  };
  const remote = (url: string, fetch: () => Promise<string> = async () => ""): { git: Git; calls: Call[] } => {
    const calls: Call[] = [];
    const git: Git = async (args, env = {}) => {
      calls.push({ args, env });
      if (args[0] === "remote") return `${url}\n`;
      if (args[0] === "ls-remote") return `${"b".repeat(40)}\trefs/heads/landrace/1\n`;
      if (args[0] === "fetch") return fetch();
      throw new Error(`the script has no answer for git ${args.join(" ")}`);
    };
    return { git, calls };
  };
  const configIn = (env: Record<string, string>): Array<[string, string]> =>
    Object.keys(env).filter((k) => k.startsWith("GIT_CONFIG_KEY_"))
      .map((k) => [env[k] ?? "", env[k.replace("KEY", "VALUE")] ?? ""] as [string, string]);

  it("fetches the remote branch's head with the token for the project's own URL, in git's environment alone", async () => {
    const url = `${BASE}/${PROJECT}.git`;
    const { git, calls } = remote(url);
    expect(await fetched(git)).toBe("b".repeat(40));
    const asked = calls.filter((c) => c.args[0] === "ls-remote" || c.args[0] === "fetch");
    expect(asked.map((c) => c.args[0])).toEqual(["ls-remote", "fetch"]);
    for (const call of asked) {
      expect(call.args).toContain(url);
      expect(configIn(call.env)).toContainEqual([`http.${url}.extraheader`, `AUTHORIZATION: basic ${BASIC}`]);
    }
    for (const call of calls) for (const secret of [TOKEN, BASIC]) expect(call.args.join(" ")).not.toContain(secret);
  });

  it("fetches with no token from any other URL", async () => {
    const { git, calls } = remote("https://gitlab.com/group/app.git");
    await fetched(git);
    expect(JSON.stringify(calls)).not.toContain(BASIC);
  });

  it("keeps the token out of a fetch's error", async () => {
    const { git } = remote(`${BASE}/${PROJECT}.git`, async () => {
      throw new Error(`fatal: unable to access: header AUTHORIZATION: basic ${BASIC} (token ${TOKEN})`);
    });
    const failure = await fetched(git).then(() => "", (e: unknown) => String(e));
    expect(failure).toMatch(/could not fetch landrace\/1 from origin/);
    expect(failure).not.toContain(TOKEN);
    expect(failure).not.toContain(BASIC);
  });

  it("fetches the commit another clone pushed, and answers it", async () => {
    const { root, origin } = await gitRepoWithOrigin();
    await commitOn(root, "landrace/1", "built.ts");
    await pushed(gitIn(root));
    const theirs = await pushedElsewhere(origin, "landrace/1");
    expect(await fetched(gitIn(root))).toBe(theirs);
    expect(await commitAt(root, "refs/remotes/origin/landrace/1")).toBe(theirs);
  });

  it("publishes the branch to origin, fast-forward, and reads back as landed", async () => {
    const { root, origin } = await gitRepoWithOrigin();
    const sha = await commitOn(root, "landrace/1", "built.ts");
    await pushed(gitIn(root));
    expect(await commitAt(origin, "refs/heads/landrace/1")).toBe(sha);
    expect((await branchHeads(gitIn(root))).remote["landrace/1"]).toBe(sha);
  });
});

/*
 * What a GitLab project gets: the forge made into hooks by `compose`, beside
 * the in-memory tracker, driven through the effects a workflow plans — the
 * merge request opened, a review round's findings threaded, the fixer's
 * reply, the reviewer's resolve — with the counts the review loop gates on
 * read back from the graph after each.
 */
describe("GitLab composed as a project's forge", () => {
  const DIFF = "@@ -1,2 +1,3 @@\n line one\n+line two\n line three\n";
  const project = () => {
    const gl = createFakeGitLab();
    gl.diffsFor("landrace/7", [{ new_path: "src/a.ts", diff: DIFF }]);
    // The checkout a build left: the item's branch committed, not yet on origin.
    const git: Git = async (args) => (args[0] === "for-each-ref" ? `refs/heads/landrace/7\0${"a".repeat(40)}\n` : "");
    const hooks = compose({
      tracker: new MemoryTracker({ items: [{ id: "7", title: "Add a thing" }] }),
      forge: new GitLab({ project: PROJECT, fetchImpl: gl.fetchImpl, git }),
    });
    const ctx = gl.ctx();
    const snapshot = async (): Promise<Snapshot> => {
      const graph = await hooks.source.read("7", ctx);
      const base: Snapshot = { graph, node: graph.nodes.find((n) => n.id === "7") };
      return { ...base, ...(await hooks.pre.run({ ...ctx, item: "7", snapshot: base })) };
    };
    const apply = async (effect: Effect): Promise<void> => hooks.post.apply(effect, { ...ctx, item: "7", snapshot: await snapshot() });
    const counts = async (): Promise<unknown[]> => {
      const pr = ((await snapshot()).graph as Graph).nodes.find((n) => n.kind === PULL_REQUEST_KIND);
      return [pr?.id, pr?.state.openThreads, pr?.state.awaitingFix];
    };
    return { gl, hooks, snapshot, apply, counts };
  };

  const round = (marker: string, output: unknown): Effect => {
    const [kind = "", n = "0"] = marker.split(":");
    return { type: "pull.review", branch: "landrace/7", marker, stage: kind === "fix" ? "fix-review" : "code-review", round: Number(n), body: `Round ${marker}.`, output };
  };

  /*
   * GitHub's audit probe P2, on GitLab: a fork can call its branch anything,
   * ours included. Only the item's own `landrace/{item}` branch in this
   * project is its work, so nothing a fork wrote reaches a prompt or a count.
   */
  it("ties no fork's merge request to the item, whatever its branch is called: not in the graph, not in a briefing", async () => {
    const { gl, hooks } = project();
    gl.diffsFor("landrace/7", [{ new_path: "src/a.ts", diff: "@@ -1 +1 @@\n+OUTSIDER_DIFF\n" }]);
    const fork = gl.open({ source_branch: "landrace/7", source_project_id: 99, sha: "f0", pipelines: [{ id: 5, sha: "f0", status: "failed" }] });
    gl.discuss(fork.iid, { body: "OUTSIDER_THREAD", author: "outsider" });
    const ctx = gl.ctx();

    for (const g of [await hooks.source.read("7", ctx), await hooks.source.list(ctx)]) {
      expect(g.nodes.filter((n) => n.kind === PULL_REQUEST_KIND)).toEqual([]);
    }
    const brief = await hooks.source.brief?.({ ...ctx, item: "7", snapshot: {} } as HookContext);
    expect(Object.keys(brief ?? {})).toEqual(expect.arrayContaining(["threads", "diff", "ci", "history"]));
    expect(JSON.stringify(brief)).not.toContain("OUTSIDER");
  });

  // #120: the item branch landrace.yaml names is the one source branch that ties.
  it("ties a merge request on the item branch the config names to its item, and none on landrace/{item}", async () => {
    const { gl, hooks } = project();
    const ours = gl.open({ source_branch: "lr-7", sha: "a1" });
    gl.open({ source_branch: "landrace/7", sha: "b1" });
    const lr = { ...gl.ctx(), config: { ...gl.ctx().config, branch: "lr-{item}" } };
    for (const g of [await hooks.source.read("7", lr), await hooks.source.list(lr)]) {
      expect(g.relationships.filter((r) => r.type === "implements").map((r) => r.from)).toEqual([`pr-${ours.iid}`]);
    }
  });

  /*
   * The bound a review is cut to is the forge's own (separation review M4):
   * GitLab takes a note of a million characters, so a review longer than
   * GitHub's 65,536 is posted whole here, marker and all.
   */
  it("posts a review body past GitHub's bound whole, under GitLab's own", async () => {
    const { gl, apply } = project();
    await apply({ type: "pull.open", branch: "landrace/7" });
    await apply({ ...round("review:1", { findings: [], resolved: [] }), body: "y".repeat(70_000) });
    const notes = gl.mrs.get(1)?.discussions.flatMap((d) => d.notes) ?? [];
    const review = notes.find((n) => parseMarker(n.body ?? "")?.marker === "review:1");
    expect(review?.body?.startsWith("y".repeat(70_000))).toBe(true);
  });

  it("opens the item's merge request, once", async () => {
    const { gl, hooks, snapshot, apply } = project();
    const open: Effect = { type: "pull.open", branch: "landrace/7" };
    expect(hooks.post.satisfied(await snapshot(), open)).toBe(false);
    await apply(open);
    expect(hooks.post.satisfied(await snapshot(), open)).toBe(true);
    expect([...gl.mrs.values()]).toEqual([expect.objectContaining({ source_branch: "landrace/7", target_branch: "main", title: "Add a thing" })]);
  });

  it("threads findings on the lines the diff shows, and one off its hunks on the file", async () => {
    const { gl, apply } = project();
    await apply({ type: "pull.open", branch: "landrace/7" });
    await apply(round("review:1", {
      findings: [{ file: "src/a.ts", line: 2, body: "added" }, { file: "src/a.ts", line: 3, body: "context" }, { file: "src/a.ts", line: 40, body: "off" }],
      resolved: [],
    }));
    const placed = gl.mrs.get(1)?.discussions.map((d) => [d.notes[0]?.position?.position_type, d.notes[0]?.position?.new_line, d.notes[0]?.position?.old_line]);
    expect(placed).toEqual([["file", undefined, undefined], ["text", 2, undefined], ["text", 3, 2], [undefined, undefined, undefined]]);
  });

  it("threads a finding on a file the merge request does not change on a changed file, naming its real path:line", async () => {
    const { gl, apply, counts } = project();
    await apply({ type: "pull.open", branch: "landrace/7" });
    await apply(round("review:1", { findings: [{ file: "src/elsewhere.ts", line: 3, body: "caller not updated" }], resolved: [] }));
    const [discussion] = gl.mrs.get(1)?.discussions ?? [];
    expect(discussion?.notes[0]?.position).toMatchObject({ position_type: "file", new_path: "src/a.ts" });
    expect(discussion?.notes[0]?.body).toMatch(/^`src\/elsewhere\.ts:3` — caller not updated/);
    expect(await counts()).toEqual(["pr-1", 1, 1]);
  });

  /*
   * A merge request just opened, its diff not worked out yet: there is no
   * changed file to put the finding on so far, and the next tick may find
   * one. Left for then, never refused for it.
   */
  it("leaves a review it has no changed file for to the next tick while GitLab is still working out the diff", async () => {
    const { gl, apply } = project();
    gl.diffsFor("landrace/7", []);
    await apply({ type: "pull.open", branch: "landrace/7" });
    const mr = gl.mrs.get(1);
    if (mr) mr.changes_count = null;
    let thrown: unknown;
    await apply(round("review:1", { findings: [{ file: "src/a.ts", line: 2, body: "x" }], resolved: [] })).catch((e: unknown) => { thrown = e; });

    expect(thrown).toBeInstanceOf(Error);
    expect(isEffectRefused(thrown)).toBe(false);
    expect(String(thrown)).toMatch(/still working out its changed files/);
    expect(mr?.discussions).toEqual([]);
  });

  it("gates on the counts: 1/1 raised, 1/0 answered, 0/0 resolved — and 0/0 once closed with a thread open", async () => {
    const { gl, apply, counts } = project();
    await apply({ type: "pull.open", branch: "landrace/7" });

    await apply(round("review:1", { findings: [{ file: "src/a.ts", line: 2, body: "breaks on empty input" }], resolved: [] }));
    expect(await counts()).toEqual(["pr-1", 1, 1]);
    const thread = gl.mrs.get(1)?.discussions[0]?.id ?? "";

    await apply(round("fix:1", { replies: [{ thread, body: "Handled the empty case." }] }));
    expect(await counts()).toEqual(["pr-1", 1, 0]);

    await apply(round("review:2", { findings: [], resolved: [thread] }));
    expect(await counts()).toEqual(["pr-1", 0, 0]);

    await apply(round("review:3", { findings: [{ file: "src/a.ts", line: 3, body: "still wrong" }], resolved: [] }));
    expect(await counts()).toEqual(["pr-1", 1, 1]);
    await apply({ type: "nodes.close", ids: ["pr-1"] });
    expect(gl.mrs.get(1)?.state).toBe("closed");
    expect(await counts()).toEqual(["pr-1", 0, 0]);
  });

  /*
   * GitLab takes one finding per request, where GitHub takes a review's in
   * one: a round cut off partway — a 500, a rate limit — and applied again
   * must not post again the findings that landed.
   */
  it("posts each finding once when a round fails partway and is applied again", async () => {
    const { gl, apply } = project();
    await apply({ type: "pull.open", branch: "landrace/7" });
    const effect = round("review:1", {
      findings: [{ file: "src/a.ts", line: 2, body: "first" }, { file: "src/a.ts", line: 3, body: "second" }], resolved: [],
    });
    let posts = 0;
    gl.breakNext((r) => r.method === "POST" && r.path.endsWith("/discussions") && ++posts === 2);
    await expect(apply(effect)).rejects.toThrow(/500/);
    await apply(effect);
    const bodies = gl.mrs.get(1)?.discussions.map((d) => (d.notes[0]?.body ?? "").split("\n")[0]);
    expect(bodies).toEqual(["first", "second", "Round review:1."]);
  });

  /*
   * GitLab runs a quick action in any note it is handed, as the account that
   * posted it — and ours may merge. A reviewer's or fixer's text is not ours:
   * it can quote the code under review, which anyone can write.
   */
  it("never lets text it posts run as a GitLab quick action", async () => {
    const { gl, apply } = project();
    await apply({ type: "pull.open", branch: "landrace/7" });
    await apply({ ...round("review:1", { findings: [{ file: "src/a.ts", line: 2, body: "breaks\n/close" }], resolved: [] }), body: "/close" });
    expect(gl.mrs.get(1)?.state).toBe("opened");
    const thread = gl.mrs.get(1)?.discussions[0]?.id ?? "";
    await apply(round("fix:1", { replies: [{ thread, body: "  /close" }] }));
    expect(gl.mrs.get(1)?.state).toBe("opened");
    const said = gl.mrs.get(1)?.discussions.flatMap((d) => d.notes.map((n) => n.body)).join("\n") ?? "";
    expect(said).toContain("\\/close");
  });

  /*
   * Inside a code fence too. A fence is GitLab's to recognise, not ours: an
   * unclosed one, a `~~~` one, one indented under a list item — a renderer
   * and GitLab's quick-action reader need not agree on where any of them
   * ends, so text left as it was because it "is in a fence" may be a command
   * to GitLab. Every line-leading slash is escaped, fenced or not.
   */
  it("never lets a quick action through inside a code fence", async () => {
    const { gl, apply } = project();
    await apply({ type: "pull.open", branch: "landrace/7" });
    const fenced = "Reproduce with:\n\n```sh\n/merge\n/close\n```\n\n~~~\n/approve\n~~~\n\n- step\n  ```\n  /close\n  ```\n\n```\n/close";
    await apply({ ...round("review:1", { findings: [{ file: "src/a.ts", line: 2, body: fenced }], resolved: [] }), body: fenced });
    const thread = gl.mrs.get(1)?.discussions[0]?.id ?? "";
    await apply(round("fix:1", { replies: [{ thread, body: fenced }] }));

    expect(gl.mrs.get(1)?.state).toBe("opened");
    const lines = (gl.mrs.get(1)?.discussions.flatMap((d) => d.notes.map((n) => n.body)) ?? []).flatMap((b) => b.split("\n"));
    expect(lines.filter((l) => /^[ \t]*\//.test(l))).toEqual([]);
    for (const command of ["merge", "close", "approve"]) expect(lines).toContain(`\\/${command}`);
    expect(lines).toContain("  \\/close");
  });

  it("never posts one round twice", async () => {
    const { gl, apply } = project();
    await apply({ type: "pull.open", branch: "landrace/7" });
    const effect = round("review:1", { findings: [{ file: "src/a.ts", line: 2, body: "x" }], resolved: [] });
    await apply(effect);
    await apply(effect);
    expect(gl.mrs.get(1)?.discussions).toHaveLength(2);
  });
});

/* The live check, run with nothing to run against: it says what it needs and fails, before it imports or asks anything. */
describe("scripts/gitlab-check.mjs", () => {
  const run = (env: Record<string, string>) => {
    const { GITLAB_TOKEN: _t, GITLAB_PROJECT: _p, GITLAB_BASE_URL: _b, ...rest } = process.env;
    void [_t, _p, _b];
    return spawnSync(process.execPath, [resolve("scripts/gitlab-check.mjs")], { encoding: "utf8", env: { ...rest, ...env } });
  };

  it("exits non-zero, naming GITLAB_TOKEN, without one", () => {
    const r = run({ GITLAB_PROJECT: PROJECT });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/GITLAB_TOKEN/);
  });

  it("exits non-zero, naming GITLAB_PROJECT, without one", () => {
    const r = run({ GITLAB_TOKEN: "t" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/GITLAB_PROJECT/);
  });
});

/*
 * Where the forge runs git when nobody hands it one: the repository of the
 * file that constructed it — never the directory the process was started from.
 */
describe("the checkout the forge works in", () => {
  const readsThisRepository = async (forge: GitLab): Promise<void> => {
    const root = (await exec("git", ["rev-parse", "--show-toplevel"])).stdout.trim();
    const back = process.cwd();
    const away = await mkdtemp(join(tmpdir(), "lr-away-"));
    made.push(away);
    process.chdir(away);
    try {
      expect(await forge.heads()).toEqual(await branchHeads(gitIn(root)));
    } finally {
      process.chdir(back);
    }
  };

  it("is the repository of the file that constructs it, whatever the working directory", async () => {
    await readsThisRepository(new GitLab({ project: PROJECT }));
  });

  it("is the constructing file's repository when the forge is a subclass defined elsewhere", async () => {
    const lib = await mkdtemp(join(tmpdir(), "lr-lib-"));
    made.push(lib);
    const file = join(lib, "forges.cjs");
    await writeFile(file, "module.exports = (Base) => class Explicit extends Base { constructor(opts) { super(opts); } };\n");
    type Forge = new (opts: ConstructorParameters<typeof GitLab>[0]) => GitLab;
    const Explicit = (createRequire(__filename)(file) as (base: typeof GitLab) => Forge)(GitLab);
    await readsThisRepository(new Explicit({ project: PROJECT }));
  });
});
