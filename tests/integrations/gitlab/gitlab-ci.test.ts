import { GitLab } from "landrace/integrations/gitlab";
import { compose, isEffectRefused } from "landrace/kit";
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

/** The context a merge is asked in: for #1, the item whose refusal it names. */
const forItem = (gl: FakeGitLab): HookContext => ({ ...gl.ctx(), item: "1", snapshot: {} });

const pipelineRequests = (gl: FakeGitLab) => gl.requests.filter((r) => r.path.includes("/pipelines") || r.path.includes("/jobs/"));

describe("a merge request's checks", () => {
  it.each([
    ["success", "success"],
    ["failed", "failure"],
    ["canceled", "failure"],
    ["created", "pending"],
    ["canceling", "pending"],
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
    await expect(forgeOver(gl).checks(recordOf(mr), gl.ctx())).rejects.toThrow(/token needs the "api" scope and Developer access on group\/app, and CI\/CD enabled/);
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

describe("a merged results pipeline", () => {
  /** !7 at `head`, whose newest pipeline ran on the merge of `parent` into main: a merge-result commit, never the head. */
  const merged = (gl: FakeGitLab, status: string, parent = "head") => {
    gl.commits.set("merge-result", ["main-tip", parent]);
    return gl.open({
      source_branch: "landrace/1", iid: 7, sha: "head",
      pipelines: [{ id: 3, sha: "merge-result", status, ref: "refs/merge-requests/7/merge" }],
      failedJobs: new Map([[3, [{ id: 30, name: "unit" }]]]),
      traces: new Map([[30, "FAIL b.test.ts"]]),
    });
  };
  const commitReads = (gl: FakeGitLab) => gl.requests.filter((r) => r.path.includes("/repository/commits/"));

  it.each([["success", "success"], ["failed", "failure"], ["running", "pending"]] as const)(
    "on the head settles checks: %s reads %s", async (status, expected) => {
      const gl = createFakeGitLab();
      const mr = merged(gl, status);
      expect(await forgeOver(gl).checks(recordOf(mr), gl.ctx())).toBe(expected);
      expect(commitReads(gl).map((r) => r.path.split("/").at(-1))).toEqual(["merge-result"]);
    },
  );

  it("on the head lists its failed jobs", async () => {
    const gl = createFakeGitLab();
    const mr = merged(gl, "failed");
    expect(await forgeOver(gl).failedChecks(recordOf(mr), gl.ctx())).toEqual([{ name: "unit", log: "FAIL b.test.ts" }]);
  });

  it("on an older head stays pending, and lists nothing", async () => {
    const gl = createFakeGitLab();
    const mr = merged(gl, "failed", "older");
    expect(await forgeOver(gl).checks(recordOf(mr), gl.ctx())).toBe("pending");
    expect(await forgeOver(gl).failedChecks(recordOf(mr), gl.ctx())).toEqual([]);
    expect(gl.requests.some((r) => r.path.includes("/jobs"))).toBe(false);
  });

  it.each(["landrace/1", "refs/merge-requests/7/head", "refs/merge-requests/8/merge"])(
    "is not counted off a ref of %s whose sha is not the head, and reads no commit", async (ref) => {
      const gl = createFakeGitLab();
      gl.commits.set("other", ["main-tip", "head"]);
      const mr = gl.open({ source_branch: "landrace/1", iid: 7, sha: "head", pipelines: [{ id: 3, sha: "other", status: "success", ref }] });
      expect(await forgeOver(gl).checks(recordOf(mr), gl.ctx())).toBe("pending");
      expect(commitReads(gl)).toEqual([]);
    },
  );

  it("reads its commit once for both checks and failed checks", async () => {
    const gl = createFakeGitLab();
    const mr = merged(gl, "failed");
    const forge = forgeOver(gl);
    await forge.checks(recordOf(mr), gl.ctx());
    await forge.failedChecks(recordOf(mr), gl.ctx());
    await forge.checks(recordOf(mr), gl.ctx());
    expect(commitReads(gl)).toHaveLength(1);
  });

  it("never answers green when its commit cannot be read", async () => {
    const gl = createFakeGitLab();
    const mr = merged(gl, "success");
    gl.breakNext(({ path }) => path.includes("/repository/commits/"), 500);
    await expect(forgeOver(gl).checks(recordOf(mr), gl.ctx())).rejects.toThrow(/500/);
    gl.commits.clear();
    await expect(forgeOver(gl).checks(recordOf(mr), gl.ctx())).rejects.toThrow(/404/);
  });

  it("names the api scope when GitLab refuses its commit", async () => {
    const gl = createFakeGitLab();
    const mr = merged(gl, "success");
    gl.breakNext(({ path }) => path.includes("/repository/commits/"), 403);
    await expect(forgeOver(gl).checks(recordOf(mr), gl.ctx())).rejects.toThrow(/token needs the "api" scope/);
  });

  it("routes through compose: ci is no longer pending, and a failure counts", async () => {
    const gl = createFakeGitLab();
    merged(gl, "failed");
    const hooks = compose({ tracker: new MemoryTracker({ items: [{ id: "1", title: "t" }] }), forge: forgeOver(gl) });
    const graph = await hooks.source.read("1", gl.ctx());
    expect(graph.nodes.find((n) => n.id === "pr-7")?.state).toMatchObject({ checks: "failure", ciPending: 0, ciFailed: 1 });
  });
});

describe("merging a merge request at its head", () => {
  it("merges guarded by the head it was asked at", async () => {
    const gl = createFakeGitLab();
    const mr = gl.open({ source_branch: "landrace/1", iid: 8, sha: "abc1234" });
    expect(await forgeOver(gl).merge(8, "abc1234", forItem(gl))).toBe("merged");
    expect(gl.requests.find((r) => r.method === "PUT" && r.path.endsWith("/merge_requests/8/merge"))?.body).toEqual({ sha: "abc1234" });
    expect(mr.state).toBe("merged");
  });

  it("answers moved, and merges nothing, when the head is not the one asked for", async () => {
    const gl = createFakeGitLab();
    const mr = gl.open({ source_branch: "landrace/1", iid: 8, sha: "new" });
    expect(await forgeOver(gl).merge(8, "old", forItem(gl))).toBe("moved");
    expect(mr.state).toBe("opened");
  });

  it.each([
    ["not mergeable while the new head's pipeline runs", { mergeable: false }],
    ["a branch GitLab cannot merge (406)", { branchRefusal: 406 }],
    ["a branch GitLab cannot merge (422)", { branchRefusal: 422 }],
  ] as const)("answers moved for a head that moved, though GitLab first refuses it as %s", async (_why, seed) => {
    // GitLab asks mergeability — "pipelines must succeed" among it — before the sha.
    const gl = createFakeGitLab();
    const mr = gl.open({ source_branch: "landrace/1", iid: 8, sha: "new", ...seed });
    expect(await forgeOver(gl).merge(8, "old", forItem(gl))).toBe("moved");
    expect(gl.requests.map((r) => `${r.method} ${r.path.split("/").slice(3).join("/")}`)).toEqual(
      expect.arrayContaining(["PUT merge_requests/8/merge", "GET merge_requests/8"]),
    );
    expect(mr.state).toBe("opened");
  });

  it("refuses an unmergeable one at the head it was asked at, in GitLab's words", async () => {
    const gl = createFakeGitLab();
    gl.open({ source_branch: "landrace/1", iid: 8, sha: "abc", branchRefusal: 422 });
    await expect(forgeOver(gl).merge(8, "abc", forItem(gl))).rejects.toThrow("!8 for #1 cannot be merged: Branch cannot be merged");
  });

  it("answers merged for one that already is, and asks for it before saying so", async () => {
    const gl = createFakeGitLab();
    gl.open({ source_branch: "landrace/1", iid: 8, sha: "abc", state: "merged" });
    expect(await forgeOver(gl).merge(8, "abc", forItem(gl))).toBe("merged");
    expect(gl.requests.map((r) => `${r.method} ${r.path.split("/").slice(3).join("/")}`)).toEqual(
      expect.arrayContaining(["PUT merge_requests/8/merge", "GET merge_requests/8"]),
    );
  });

  it.each([405, 406, 422])("refuses one GitLab answers %i for, naming the merge request and GitLab's words", async (status) => {
    const gl = createFakeGitLab();
    gl.open({ source_branch: "landrace/1", iid: 8, sha: "abc", mergeable: false });
    gl.breakNext(({ method, path }) => method === "PUT" && path.endsWith("/merge"), status);
    await expect(forgeOver(gl).merge(8, "abc", forItem(gl))).rejects.toThrow(new RegExp(`^!8 for #1 cannot be merged: ${status} the fake broke here`));
  });

  it("refuses an unmergeable one in GitLab's own message", async () => {
    const gl = createFakeGitLab();
    gl.open({ source_branch: "landrace/1", iid: 8, sha: "abc", mergeable: false });
    await expect(forgeOver(gl).merge(8, "abc", forItem(gl))).rejects.toThrow("!8 for #1 cannot be merged: 405 Method Not Allowed");
  });

  it("wraps any other refusal in a sentence naming the merge request and the item", async () => {
    const gl = createFakeGitLab();
    gl.open({ source_branch: "landrace/1", iid: 8, sha: "abc" });
    gl.breakNext(({ method }) => method === "PUT", 500);
    await expect(forgeOver(gl).merge(8, "abc", forItem(gl))).rejects.toThrow(/^!8 for #1 could not be merged: GitLab answered 500: 500 the fake broke here$/);
  });

  it("names the token's scope and role, not the merge request, on a 403", async () => {
    const gl = createFakeGitLab();
    gl.open({ source_branch: "landrace/1", iid: 8, sha: "abc" });
    gl.breakNext(({ method }) => method === "PUT", 403);
    const rejected = forgeOver(gl).merge(8, "abc", forItem(gl));
    await expect(rejected).rejects.toThrow(/token needs the "api" scope and Developer access on group\/app/);
  });

  // GitLab answers 401 to a valid token whose user may not merge here — a
  // Developer on a default protected branch — and asks it before the head.
  it.each([["at its head", "abc"], ["though its head moved", "old"]])("says the token's user may not merge it, %s, on a 401", async (_when, asked) => {
    const gl = createFakeGitLab();
    const mr = gl.open({ source_branch: "landrace/1", iid: 8, sha: "abc", mayMerge: false });
    const said = await forgeOver(gl).merge(8, asked, forItem(gl)).then(String, (e: unknown) => (e as Error).message);
    expect(said).toBe(
      "the token's user may not merge !8 for #1 into its target branch: check the protected branch's \"Allowed to merge\", " +
      "or give the user the Maintainer role (GitLab answered: 401 Unauthorized)",
    );
    expect(said).not.toMatch(/rejected/);
    expect(mr.state).toBe("opened");
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
    await expect(forgeOver(gl).check(gl.ctx())).rejects.toThrow(/token cannot read pipelines on group\/app.*"api".*CI\/CD enabled/);
  });

  it("does not pass a probe that read nothing: a 404 refuses", async () => {
    const gl = createFakeGitLab();
    gl.breakNext(({ path }) => path.endsWith("/pipelines"), 404);
    await expect(forgeOver(gl).check(gl.ctx())).rejects.toThrow(/pipeline check on group\/app failed.*404/);
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
  const project = (extra: Partial<FakeMr>, prepare: (gl: FakeGitLab) => void = () => {}) => {
    const gl = createFakeGitLab();
    prepare(gl);
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

  /*
   * The protected-path gate over GitLab's diff (security follow-up): a diff
   * GitLab has not counted yet — `changes_count` null, still computing — is
   * unsettled, an unmarked error the next tick asks again; one the page
   * bound cut short stays a refusal, marked, for a person.
   */
  const guarded: Effect = { ...merge, refuse: [".landrace/hooks/**"] };
  const files = (n: number) => Array.from({ length: n }, (_, i) => ({ new_path: `src/f${i}.ts`, diff: "@@ -1 +1 @@\n+x\n" }));
  const attempt = async (gl: FakeGitLab, hooks: ReturnType<typeof compose>, snapshot: Snapshot) =>
    hooks.post.apply(guarded, { ...gl.ctx(), item: "1", snapshot } as HookContext)
      .then(() => "merged" as const, (e: unknown) => ({ message: (e as Error).message, refused: isEffectRefused(e) }));

  it("leaves a merge whose diff GitLab is still counting unmarked, for the next tick, and merges once it has", async () => {
    const { gl, hooks, opened, snapshot } = project({ changes_count: null, pipelines: [{ id: 1, sha: "abc1234", status: "success" }] });
    expect(await attempt(gl, hooks, await snapshot())).toEqual({ message: expect.stringMatching(/still working out/), refused: false });
    expect(opened.state).toBe("opened");
    expect(gl.requests.some((r) => r.method === "PUT")).toBe(false);

    delete opened.changes_count;
    expect(await attempt(gl, hooks, await snapshot())).toBe("merged");
    expect(opened.state).toBe("merged");
  });

  it.each([["counted", undefined], ["not counted yet", null]] as const)(
    "refuses, marked, a merge whose diff the page bound cut short — %s by GitLab",
    async (_what, changes_count) => {
      const { gl, hooks, opened, snapshot } = project(
        { pipelines: [{ id: 1, sha: "abc1234", status: "success" }], ...(changes_count === undefined ? {} : { changes_count }) },
        (fake) => fake.diffsFor("landrace/1", files(1_000)),
      );
      expect(await attempt(gl, hooks, await snapshot())).toEqual({ message: expect.stringMatching(/stopped before the rest/), refused: true });
      expect(opened.state).toBe("opened");
    },
  );

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
