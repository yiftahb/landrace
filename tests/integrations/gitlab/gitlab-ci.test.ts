import { GitLab } from "landrace/integrations/gitlab";
import { compose } from "landrace/kit";
import type { Effect, Git, Graph, HookContext, PullRecord, Snapshot } from "#namespace.js";
import { MemoryTracker } from "#testing/external-state.js";
import { createFakeGitLab, type FakeGitLab, type FakeMr, PROJECT } from "#tests/integrations/gitlab/fake-gitlab.js";

/**
 * A merge request's CI and its merge, through the real client and forge over
 * the in-memory GitLab: what is asked of GitLab is asserted on the requests
 * the fake saw, and what a prompt reads on the briefing.
 */
const noGit: Git = async () => "";
const forgeOver = (gl: FakeGitLab): GitLab => new GitLab({ project: PROJECT, fetchImpl: gl.fetchImpl, git: noGit });

const recordOf = (mr: FakeMr): PullRecord =>
  ({ number: mr.iid, title: "t", link: "", merged: mr.state === "merged", closed: mr.state === "closed", headSha: mr.sha, branch: mr.source_branch, createdAt: undefined, items: [] });

const pipelineRequests = (gl: FakeGitLab) => gl.requests.filter((r) => r.path.includes("/pipelines") || r.path.includes("/jobs/"));

describe("a merge request's checks", () => {
  it.each([
    ["success", "success"],
    ["failed", "failure"],
    ["canceled", "failure"],
    ["created", "pending"],
    ["waiting_for_resource", "pending"],
    ["preparing", "pending"],
    ["pending", "pending"],
    ["running", "pending"],
    ["scheduled", "pending"],
    ["manual", "pending"],
    ["skipped", "none"],
  ] as const)("reads a pipeline that is %s as %s, on the head the merge request is at", async (status, expected) => {
    const gl = createFakeGitLab();
    const mr = gl.open({ source_branch: "landrace/1", sha: "abc1234", pipelines: [{ id: 1, sha: "abc1234", status }] });
    expect(await forgeOver(gl).checks(recordOf(mr), gl.ctx())).toBe(expected);
    const asked = gl.requests.filter((r) => r.path.endsWith("/pipelines"));
    expect(asked).toHaveLength(1);
    expect(asked[0]?.path).toBe(`/projects/${encodeURIComponent(PROJECT)}/merge_requests/${mr.iid}/pipelines`);
    expect(asked[0]?.query.get("per_page")).toBe("1");
  });

  it("reads a merge request with no pipeline as none", async () => {
    const gl = createFakeGitLab();
    const mr = gl.open({ source_branch: "landrace/1" });
    expect(await forgeOver(gl).checks(recordOf(mr), gl.ctx())).toBe("none");
  });

  it("reads the newest pipeline, and an older one's verdict on an older sha is not the head's: pending", async () => {
    const gl = createFakeGitLab();
    const mr = gl.open({ source_branch: "landrace/1", sha: "new", pipelines: [{ id: 1, sha: "old", status: "success" }] });
    expect(await forgeOver(gl).checks(recordOf(mr), gl.ctx())).toBe("pending");
    mr.pipelines?.push({ id: 2, sha: "new", status: "failed" });
    expect(await forgeOver(gl).checks(recordOf(mr), gl.ctx())).toBe("failure");
  });

  it("does not read a status it does not know as green", async () => {
    const gl = createFakeGitLab();
    const mr = gl.open({ source_branch: "landrace/1", sha: "a", pipelines: [{ id: 1, sha: "a", status: "exploded" }] });
    await expect(forgeOver(gl).checks(recordOf(mr), gl.ctx())).rejects.toThrow(/"exploded".*!1/);
  });

  it("never answers green when the read fails", async () => {
    const gl = createFakeGitLab();
    const mr = gl.open({ source_branch: "landrace/1", sha: "a", pipelines: [{ id: 1, sha: "a", status: "success" }] });
    gl.breakNext(({ path }) => path.endsWith("/pipelines"), 500);
    await expect(forgeOver(gl).checks(recordOf(mr), gl.ctx())).rejects.toThrow(/500/);
  });

  it("names the api scope when GitLab refuses the read", async () => {
    const gl = createFakeGitLab();
    const mr = gl.open({ source_branch: "landrace/1", sha: "a" });
    gl.breakNext(({ path }) => path.endsWith("/pipelines"), 403);
    await expect(forgeOver(gl).checks(recordOf(mr), gl.ctx())).rejects.toThrow(/token needs the "api" scope.*group\/app/);
  });

  it("puts the real state on an open merge request and costs a closed one no pipelines request", async () => {
    const gl = createFakeGitLab();
    gl.open({ source_branch: "landrace/1", iid: 10, sha: "red", pipelines: [{ id: 1, sha: "red", status: "failed" }] });
    gl.open({ source_branch: "landrace/1", iid: 11, sha: "old", state: "merged", pipelines: [{ id: 2, sha: "old", status: "failed" }] });
    gl.open({ source_branch: "landrace/1", iid: 12, sha: "gone", state: "closed", pipelines: [{ id: 3, sha: "gone", status: "failed" }] });
    const hooks = compose({ tracker: new MemoryTracker({ items: [{ id: "1", title: "t" }] }), forge: forgeOver(gl) });
    const graph = await hooks.source.read("1", gl.ctx());
    const state = (id: string) => graph.nodes.find((n) => n.id === id)?.state;
    expect(state("pr-10")).toMatchObject({ checks: "failure", ciPending: 0, ciFailed: 1 });
    expect(state("pr-11")).toMatchObject({ checks: "none", ciPending: 0, ciFailed: 0 });
    expect(state("pr-12")).toMatchObject({ checks: "none", ciPending: 0, ciFailed: 0 });
    expect(gl.requests.filter((r) => r.path.endsWith("/pipelines")).map((r) => r.path.split("/").at(-2))).toEqual(["10"]);
  });

  it.each(["checks", "failedChecks"] as const)("%s refuses an empty head with a sentence naming the merge request, before any request", async (method) => {
    const gl = createFakeGitLab();
    const mr = gl.open({ source_branch: "landrace/1", iid: 4 });
    await expect(forgeOver(gl)[method]({ ...recordOf(mr), headSha: "" }, gl.ctx())).rejects.toThrow("!4 has no head commit to read checks on");
    expect(gl.requests).toEqual([]);
  });
});

describe("a merge request's failed checks", () => {
  const failing = (gl: FakeGitLab, extra: Partial<FakeMr> = {}) => gl.open({
    source_branch: "landrace/1", sha: "abc", iid: 5,
    pipelines: [{ id: 1, sha: "abc", status: "success" }, { id: 2, sha: "abc", status: "failed" }],
    failedJobs: new Map([[2, [{ id: 20, name: "unit" }, { id: 21, name: "lint" }]], [1, [{ id: 10, name: "stale" }]]]),
    traces: new Map([[20, "FAIL a.test.ts"], [21, "lint log"]]),
    ...extra,
  });

  it("lists the newest pipeline's failed jobs, each with its trace as text", async () => {
    const gl = createFakeGitLab();
    const mr = failing(gl);
    expect(await forgeOver(gl).failedChecks(recordOf(mr), gl.ctx())).toEqual([
      { name: "unit", log: "FAIL a.test.ts" },
      { name: "lint", log: "lint log" },
    ]);
    const jobs = gl.requests.find((r) => r.path.endsWith("/pipelines/2/jobs"));
    expect(jobs?.query.get("scope[]")).toBe("failed");
    expect(jobs?.query.get("per_page")).toBe("100");
    expect(gl.requests.map((r) => r.path.split("/").slice(-3).join("/"))).toEqual(
      expect.arrayContaining(["jobs/20/trace", "jobs/21/trace"]),
    );
  });

  it("names a job whose trace GitLab will not give, with a null log", async () => {
    const gl = createFakeGitLab();
    const mr = failing(gl, { traces: new Map([[21, "lint log"]]) });
    expect(await forgeOver(gl).failedChecks(recordOf(mr), gl.ctx())).toEqual([{ name: "unit", log: null }, { name: "lint", log: "lint log" }]);
  });

  it.each([403, 410, 500])("gives a trace answered %i as null, still naming its job", async (status) => {
    const gl = createFakeGitLab();
    const mr = failing(gl);
    gl.breakNext(({ path }) => path.endsWith("/jobs/20/trace"), status);
    expect(await forgeOver(gl).failedChecks(recordOf(mr), gl.ctx())).toEqual([{ name: "unit", log: null }, { name: "lint", log: "lint log" }]);
  });

  it("lists nothing when the head's pipeline has not started, and reads no jobs", async () => {
    const gl = createFakeGitLab();
    const mr = failing(gl, { sha: "newer" });
    expect(await forgeOver(gl).failedChecks(recordOf(mr), gl.ctx())).toEqual([]);
    expect(gl.requests.some((r) => r.path.includes("/jobs"))).toBe(false);
  });

  it("lists nothing for a merge request with no pipeline", async () => {
    const gl = createFakeGitLab();
    const mr = gl.open({ source_branch: "landrace/1" });
    expect(await forgeOver(gl).failedChecks(recordOf(mr), gl.ctx())).toEqual([]);
  });

  it("throws, rather than list nothing, when the jobs cannot be read", async () => {
    const gl = createFakeGitLab();
    const mr = failing(gl);
    gl.breakNext(({ path }) => path.endsWith("/pipelines/2/jobs"), 403);
    await expect(forgeOver(gl).failedChecks(recordOf(mr), gl.ctx())).rejects.toThrow(/token needs the "api" scope/);
  });

  it("reaches a prompt as the ci briefing, tailed, with a log it could not get said so", async () => {
    const gl = createFakeGitLab();
    failing(gl, { traces: new Map([[20, `${"x".repeat(5000)}THE END`]]) });
    const hooks = compose({ tracker: new MemoryTracker({ items: [{ id: "1", title: "t" }] }), forge: forgeOver(gl) });
    const briefed = await hooks.source.brief?.({ ...gl.ctx(), item: "1", snapshot: {} } as HookContext);
    const ci = briefed?.ci ?? "";
    expect(ci).toContain("### pr-5: checks failure");
    expect(ci).toContain("#### unit");
    expect(ci).toContain("THE END");
    expect(ci).not.toContain("x".repeat(4500));
    expect(ci).toMatch(/#### lint\n\n\(log unavailable\)/);
  });
});

describe("merging a merge request at its head", () => {
  it("merges guarded by the head it was asked at", async () => {
    const gl = createFakeGitLab();
    const mr = gl.open({ source_branch: "landrace/1", iid: 8, sha: "abc1234" });
    expect(await forgeOver(gl).merge(8, "abc1234", gl.ctx())).toBe("merged");
    expect(gl.requests.find((r) => r.method === "PUT" && r.path.endsWith("/merge_requests/8/merge"))?.body).toEqual({ sha: "abc1234" });
    expect(mr.state).toBe("merged");
  });

  it("answers moved, and merges nothing, when the head is not the one asked for", async () => {
    const gl = createFakeGitLab();
    const mr = gl.open({ source_branch: "landrace/1", iid: 8, sha: "new" });
    expect(await forgeOver(gl).merge(8, "old", gl.ctx())).toBe("moved");
    expect(mr.state).toBe("opened");
  });

  it("answers merged for one that already is, and asks for it before saying so", async () => {
    const gl = createFakeGitLab();
    gl.open({ source_branch: "landrace/1", iid: 8, sha: "abc", state: "merged" });
    expect(await forgeOver(gl).merge(8, "abc", gl.ctx())).toBe("merged");
    expect(gl.requests.map((r) => `${r.method} ${r.path.split("/").slice(3).join("/")}`)).toEqual(
      expect.arrayContaining(["PUT merge_requests/8/merge", "GET merge_requests/8"]),
    );
  });

  it.each([405, 406, 422])("refuses one GitLab answers %i for, naming the merge request and GitLab's words", async (status) => {
    const gl = createFakeGitLab();
    gl.open({ source_branch: "landrace/1", iid: 8, sha: "abc", mergeable: false });
    gl.breakNext(({ method, path }) => method === "PUT" && path.endsWith("/merge"), status);
    await expect(forgeOver(gl).merge(8, "abc", gl.ctx())).rejects.toThrow(new RegExp(`^!8 cannot be merged: ${status} the fake broke here`));
  });

  it("refuses an unmergeable one in GitLab's own message", async () => {
    const gl = createFakeGitLab();
    gl.open({ source_branch: "landrace/1", iid: 8, sha: "abc", mergeable: false });
    await expect(forgeOver(gl).merge(8, "abc", gl.ctx())).rejects.toThrow("!8 cannot be merged: 405 Method Not Allowed");
  });

  it.each([401, 403])("names the token's scope and role, not the merge request, on a %i", async (status) => {
    const gl = createFakeGitLab();
    gl.open({ source_branch: "landrace/1", iid: 8, sha: "abc" });
    gl.breakNext(({ method }) => method === "PUT", status);
    const rejected = forgeOver(gl).merge(8, "abc", gl.ctx());
    await expect(rejected).rejects.toThrow(status === 401 ? /rejected by GitLab \(401\)/ : /token needs the "api" scope and Developer access on group\/app/);
  });
});

describe("the preflight reads pipelines too", () => {
  it("passes on a token that can, asking for one", async () => {
    const gl = createFakeGitLab();
    await expect(forgeOver(gl).check(gl.ctx())).resolves.toBeUndefined();
    const asked = pipelineRequests(gl);
    expect(asked.map((r) => r.path)).toEqual([`/projects/${encodeURIComponent(PROJECT)}/pipelines`]);
    expect(asked[0]?.query.get("per_page")).toBe("1");
  });

  it("refuses to start when GitLab refuses it, naming what is missing", async () => {
    const gl = createFakeGitLab();
    gl.breakNext(({ path }) => path.endsWith("/pipelines"), 403);
    await expect(forgeOver(gl).check(gl.ctx())).rejects.toThrow(/token cannot read pipelines on group\/app.*api/);
  });

  it("does not take a rejected token for a missing permission", async () => {
    const gl = createFakeGitLab();
    gl.breakNext(({ path }) => path.endsWith("/pipelines"), 401);
    await expect(forgeOver(gl).check(gl.ctx())).rejects.toThrow(/rejected by GitLab \(401\)/);
  });

  it("probes an administrator's token too, whom no membership check applies to", async () => {
    const gl = createFakeGitLab();
    gl.settings.admin = true;
    gl.breakNext(({ path }) => path.endsWith("/pipelines"), 403);
    await expect(forgeOver(gl).check(gl.ctx())).rejects.toThrow(/cannot read pipelines/);
  });

  it("starts on a project with no pipelines at all, which GitLab answers with an empty list", async () => {
    const gl = createFakeGitLab();
    await expect(forgeOver(gl).check(gl.ctx())).resolves.toBeUndefined();
    expect(gl.mrs.size).toBe(0);
  });
});

describe("pull.merge through compose", () => {
  const merge: Effect = { type: "pull.merge", branch: "landrace/1" };
  const project = (extra: Partial<FakeMr>) => {
    const gl = createFakeGitLab();
    const opened = gl.open({ source_branch: "landrace/1", iid: 8, sha: "abc1234", ...extra });
    const hooks = compose({ tracker: new MemoryTracker({ items: [{ id: "1", title: "t" }] }), forge: forgeOver(gl) });
    const snapshot = async (): Promise<Snapshot> => {
      const graph: Graph = await hooks.source.read("1", gl.ctx());
      return { graph, node: graph.nodes.find((n) => n.id === "1") };
    };
    return { gl, hooks, opened, snapshot };
  };

  it("merges a green merge request and then reads it satisfied", async () => {
    const { gl, hooks, opened, snapshot } = project({ pipelines: [{ id: 1, sha: "abc1234", status: "success" }] });
    const before = await snapshot();
    expect(hooks.post.satisfied(before, merge)).toBe(false);
    await hooks.post.apply(merge, { ...gl.ctx(), item: "1", snapshot: before } as HookContext);
    expect(opened.state).toBe("merged");
    expect(hooks.post.satisfied(await snapshot(), merge)).toBe(true);
  });

  it("refuses a red merge request, naming its checks, and merges nothing", async () => {
    const { gl, hooks, opened, snapshot } = project({ pipelines: [{ id: 1, sha: "abc1234", status: "failed" }] });
    await expect(hooks.post.apply(merge, { ...gl.ctx(), item: "1", snapshot: await snapshot() } as HookContext))
      .rejects.toThrow("will not merge pr-8 for #1: its checks on abc1234 are failure");
    expect(opened.state).toBe("opened");
    expect(gl.requests.some((r) => r.method === "PUT")).toBe(false);
  });

  it("does not halt on a head that moved after the snapshot: nothing merges, the next read has the new head", async () => {
    const { gl, hooks, opened, snapshot } = project({ pipelines: [{ id: 1, sha: "abc1234", status: "success" }] });
    const stale = await snapshot();
    opened.sha = "def5678";
    await hooks.post.apply(merge, { ...gl.ctx(), item: "1", snapshot: stale } as HookContext);
    expect(opened.state).toBe("opened");
    const next = ((await snapshot()).graph as Graph).nodes.find((n) => n.id === "pr-8");
    expect(next?.state.headSha).toBe("def5678");
  });
});
