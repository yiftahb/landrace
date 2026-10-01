import { createClient, GitLab } from "landrace/integrations/gitlab";
import type { Git } from "#namespace.js";
import { BASE, createFakeGitLab, type FakeGitLab, PROJECT, TOKEN } from "#tests/integrations/gitlab/fake-gitlab.js";

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
      number: mr.iid, title: "Add a thing", link: mr.web_url, merged: false, closed: false, headSha: "abc",
      branch: "landrace/7", createdAt: mr.created_at, updatedAt: mr.updated_at, tickets: [],
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
  it("reads every merge request from the ticket's branch, merged and closed ones too, and no fork's", async () => {
    const gl = createFakeGitLab();
    gl.open({ source_branch: "landrace/7", state: "merged" });
    gl.open({ source_branch: "landrace/7" });
    gl.open({ source_branch: "landrace/7", source_project_id: 99 });
    gl.open({ source_branch: "landrace/8" });
    const pulls = await forgeOver(gl).pullsNaming("7", gl.ctx());
    expect(pulls.map((p) => [p.number, p.branch, p.merged])).toEqual([[2, "landrace/7", false], [1, "landrace/7", true]]);
  });

  it("refuses more than one ticket read carries", async () => {
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
    expect(await forgeOver(gl).changedFiles(mr.iid, gl.ctx())).toEqual([
      { path: "src/a.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1,2 +1,3 @@\n line one\n+line two\n line three" },
      { path: "src/new.ts", status: "added", additions: 2, deletions: 0, patch: "@@ -0,0 +1,2 @@\n+a\n+b" },
      { path: "src/gone.ts", status: "removed", additions: 0, deletions: 1, patch: "@@ -1 +0,0 @@\n-x" },
      { path: "src/moved.ts", status: "renamed", additions: 0, deletions: 0, patch: undefined },
    ]);
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
