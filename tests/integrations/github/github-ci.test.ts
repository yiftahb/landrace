import { createClient, GitHubForge } from "landrace/integrations/github";
import { createFakeTracker, githubHooks, noBranches, type FakePull, type FakeTracker } from "#tests/support/fake-tracker.js";
import type { Effect, Graph, HookContext, PullRecord, Snapshot } from "#namespace.js";

/**
 * A pull request's CI and its merge, through the real client and the real
 * forge over the in-memory GitHub: what is asked of GitHub is asserted on the
 * requests the fake saw, and what a prompt reads on the briefing.
 */
const forgeOf = (gh: FakeTracker): GitHubForge =>
  new GitHubForge({ closingRefs: true, client: createClient({ repo: "acme/widgets", token: "test-token", fetchImpl: gh.fetchImpl }) });

const recordOf = (pull: FakePull): PullRecord =>
  ({ number: pull.number, title: "t", link: "", merged: pull.merged, closed: false, headSha: pull.headSha, branch: pull.head, createdAt: undefined, items: [] });

const checksQueries = (gh: FakeTracker) => gh.graphql.filter((q) => q.query.includes("query LandraceChecks("));
const run = (id: number, name: string, conclusion: string | null, extra: Partial<NonNullable<FakePull["checkRuns"]>[number]> = {}) =>
  ({ id, name, conclusion, ...extra });

describe("a pull request's checks", () => {
  it.each([
    ["SUCCESS", "success"],
    ["FAILURE", "failure"],
    ["ERROR", "failure"],
    ["PENDING", "pending"],
    ["EXPECTED", "pending"],
    [null, "none"],
  ] as const)("reads a rollup of %s as %s, on the head the pull request is at", async (rollup, expected) => {
    const gh = createFakeTracker([{ number: 1 }]);
    const pull = gh.openPull({ head: "landrace/1", headSha: "abc1234", checks: rollup });
    expect(await forgeOf(gh).checks(recordOf(pull), gh.ctx)).toBe(expected);
    expect(checksQueries(gh)).toHaveLength(1);
    expect(checksQueries(gh)[0]?.variables).toMatchObject({ owner: "acme", name: "widgets", oid: "abc1234" });
  });

  it("does not read a commit GitHub does not have as green", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    const pull = gh.openPull({ head: "landrace/1", checks: "SUCCESS" });
    await expect(forgeOf(gh).checks({ ...recordOf(pull), headSha: "gone" }, gh.ctx)).rejects.toThrow(/no commit gone/);
  });

  it("names Checks: Read when GitHub refuses the rollup, and never answers green", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    const pull = gh.openPull({ head: "landrace/1", checks: "SUCCESS" });
    gh.graphqlError("Resource not accessible by personal access token");
    await expect(forgeOf(gh).checks(recordOf(pull), gh.ctx)).rejects.toThrow('token needs "Checks: Read" on acme/widgets');
  });

  it("puts the real state on an open pull request and costs a closed one no checks request", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    gh.openPull({ head: "landrace/1", number: 10, headSha: "red", checks: "FAILURE" });
    gh.openPull({ head: "landrace/1", number: 11, headSha: "old", merged: true, checks: "FAILURE" });
    const graph = await gh.registry.source?.read("1", gh.ctx);
    const state = (id: string) => graph?.nodes.find((n) => n.id === id)?.state;
    expect(state("pr-10")).toMatchObject({ checks: "failure", ciPending: 0, ciFailed: 1 });
    expect(state("pr-11")).toMatchObject({ checks: "none", ciPending: 0, ciFailed: 0 });
    expect(checksQueries(gh).map((q) => q.variables.oid)).toEqual(["red"]);
  });
});

describe("a pull request's failed checks", () => {
  it("lists failed runs and failed statuses, and only those", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    const pull = gh.openPull({
      head: "landrace/1",
      headSha: "abc1234",
      checkRuns: [
        run(1, "lint", "success"), run(2, "unit", "failure"), run(3, "slow", "timed_out"), run(4, "gate", "cancelled"),
        run(5, "approve", "action_required"), run(6, "boot", "startup_failure"), run(7, "later", null), run(8, "skipped", "skipped"),
      ],
      statuses: [{ context: "ci/jenkins", state: "failure", description: "build 12 failed" }, { context: "ci/ok", state: "success" }, { context: "ci/err", state: "error" }],
      jobLogs: new Map([[2, "unit log"], [3, "slow log"], [4, "gate log"], [5, "approve log"], [6, "boot log"]]),
    });
    expect((await forgeOf(gh).failedChecks(recordOf(pull), gh.ctx)).map((c) => c.name)).toEqual(
      ["unit", "slow", "gate", "approve", "boot", "ci/jenkins", "ci/err"],
    );
    expect(gh.requests.filter((r) => r.path.startsWith("/commits/")).map((r) => r.path)).toEqual(
      ["/commits/abc1234/check-runs", "/commits/abc1234/status"],
    );
  });

  it("gives an Actions run its job log, another app's run its output, and a status its description", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    const pull = gh.openPull({
      head: "landrace/1",
      checkRuns: [
        run(2, "unit", "failure", { output: { summary: "ignored" } }),
        run(3, "sonar", "failure", { app: "sonarcloud", output: { text: "3 bugs", summary: "quality gate" } }),
        run(4, "scan", "failure", { app: "scanner", output: { text: null, summary: "one finding" } }),
        run(5, "bare", "failure", { app: "scanner" }),
      ],
      statuses: [{ context: "ci/a", state: "failure", description: "it broke" }, { context: "ci/b", state: "error" }],
      jobLogs: new Map([[2, "FAIL tests/a.test.ts\nexpected 1 to be 2"]]),
    });
    expect(await forgeOf(gh).failedChecks(recordOf(pull), gh.ctx)).toEqual([
      { name: "unit", log: "FAIL tests/a.test.ts\nexpected 1 to be 2" },
      { name: "sonar", log: "3 bugs" },
      { name: "scan", log: "one finding" },
      { name: "bare", log: null },
      { name: "ci/a", log: "it broke" },
      { name: "ci/b", log: null },
    ]);
  });

  it.each([403, 404, 410])("gives a log GitHub answers %i for as null, still naming its check", async (status) => {
    const gh = createFakeTracker([{ number: 1 }]);
    const pull = gh.openPull({ head: "landrace/1", checkRuns: [run(9, "unit", "failure")], jobLogs: new Map([[9, "never read"]]) });
    gh.breakOn(({ path }) => path === "/actions/jobs/9/logs", status);
    expect(await forgeOf(gh).failedChecks(recordOf(pull), gh.ctx)).toEqual([{ name: "unit", log: null }]);
  });

  it("gives a job whose log is not there at all as null", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    const pull = gh.openPull({ head: "landrace/1", checkRuns: [run(9, "unit", "failure")] });
    expect(await forgeOf(gh).failedChecks(recordOf(pull), gh.ctx)).toEqual([{ name: "unit", log: null }]);
  });

  it("throws the permission when the list of check runs is refused", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    const pull = gh.openPull({ head: "landrace/1", checkRuns: [run(9, "unit", "failure")] });
    gh.breakOn(({ path }) => path.endsWith("/check-runs"), 403);
    await expect(forgeOf(gh).failedChecks(recordOf(pull), gh.ctx)).rejects.toThrow('token needs "Checks: Read" on acme/widgets');
  });

  it("throws the permission when the statuses are refused", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    const pull = gh.openPull({ head: "landrace/1" });
    gh.breakOn(({ path }) => path.endsWith("/status"), 403);
    await expect(forgeOf(gh).failedChecks(recordOf(pull), gh.ctx)).rejects.toThrow('token needs "Commit statuses: Read" on acme/widgets');
  });

  it("reaches a prompt as the ci briefing, tailed, with a log it could not get said so", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    gh.openPull({
      head: "landrace/1", number: 5, checks: "FAILURE",
      checkRuns: [run(2, "unit", "failure"), run(3, "e2e", "failure")],
      jobLogs: new Map([[2, `${"x".repeat(5000)}THE END`]]),
    });
    const source = gh.registry.source;
    const briefed = await source?.brief?.({ ...gh.ctx, item: "1", snapshot: {} } as HookContext);
    const ci = briefed?.ci ?? "";
    expect(ci).toContain("### pr-5: checks failure");
    expect(ci).toContain("#### unit");
    expect(ci).toContain("THE END");
    expect(ci).not.toContain("x".repeat(4500));
    expect(ci).toMatch(/#### e2e\n\n\(log unavailable\)/);
  });
});

describe("merging a pull request at its head", () => {
  it("merges with a merge commit, guarded by the head it was asked at", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    const pull = gh.openPull({ head: "landrace/1", number: 8, headSha: "abc1234" });
    const put = jest.fn();
    const seen = gh.fetchImpl;
    const spy = (async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT") put(url, JSON.parse(String(init.body)));
      return seen(url, init);
    }) as typeof fetch;
    const forge = new GitHubForge({ client: createClient({ repo: "acme/widgets", token: "t", fetchImpl: spy }) });
    expect(await forge.merge(8, "abc1234", gh.ctx)).toBe("merged");
    expect(put).toHaveBeenCalledWith(expect.stringContaining("/pulls/8/merge"), { sha: "abc1234", merge_method: "merge" });
    expect(pull.merged).toBe(true);
  });

  it("answers moved, and merges nothing, when the head is not the one asked for", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    const pull = gh.openPull({ head: "landrace/1", number: 8, headSha: "new" });
    expect(await forgeOf(gh).merge(8, "old", gh.ctx)).toBe("moved");
    expect(pull.merged).toBe(false);
  });

  it("answers merged for a pull request that already is, and does not throw", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    gh.openPull({ head: "landrace/1", number: 8, headSha: "abc", merged: true });
    expect(await forgeOf(gh).merge(8, "abc", gh.ctx)).toBe("merged");
    expect(gh.requests.map((r) => `${r.method} ${r.path}`)).toEqual(expect.arrayContaining(["PUT /pulls/8/merge", "GET /pulls/8"]));
  });

  it("refuses one GitHub will not merge, naming the pull request and GitHub's words", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    gh.openPull({ head: "landrace/1", number: 8, headSha: "abc", mergeable: false });
    await expect(forgeOf(gh).merge(8, "abc", gh.ctx)).rejects.toThrow("pr-8 cannot be merged: Pull Request is not mergeable");
  });

  it("names the permissions a refused merge lacks", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    gh.openPull({ head: "landrace/1", number: 8, headSha: "abc" });
    gh.breakOn(({ method }) => method === "PUT", 403);
    await expect(forgeOf(gh).merge(8, "abc", gh.ctx)).rejects.toThrow('token needs "Pull requests: Read and write" and "Contents: Read and write" on acme/widgets');
  });
});

describe("the preflight reads CI too", () => {
  it("passes on a token that can read checks and statuses", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    await expect(forgeOf(gh).check(gh.ctx)).resolves.toBeUndefined();
    expect(gh.requests.map((r) => r.path)).toEqual(expect.arrayContaining(["/commits/main/check-runs", "/commits/main/status"]));
  });

  it.each([
    ["check-runs", "Checks: Read"],
    ["status", "Commit statuses: Read"],
  ])("refuses to start when GitHub refuses %s, naming %s", async (tail, permission) => {
    const gh = createFakeTracker([{ number: 1 }]);
    gh.breakOn(({ path }) => path.endsWith(`/${tail}`), 403);
    await expect(forgeOf(gh).check(gh.ctx)).rejects.toThrow(`token needs "${permission}" on acme/widgets`);
  });

  it("does not take a rejected token for a missing permission", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    gh.breakOn(({ path }) => path.endsWith("/check-runs"), 401);
    await expect(forgeOf(gh).check(gh.ctx)).rejects.toThrow(/rejected by GitHub \(401\)/);
  });
});

describe("pull.merge through compose", () => {
  const merge: Effect = { type: "pull.merge", branch: "landrace/1" };
  const project = (pull: Partial<FakePull>) => {
    const gh = createFakeTracker([{ number: 1 }]);
    const hooks = githubHooks({ repo: "acme/widgets", token: "test-token", fetchImpl: gh.fetchImpl, git: noBranches });
    const opened = gh.openPull({ head: "landrace/1", number: 8, headSha: "abc1234", closes: [1], ...pull });
    const snapshot = async (): Promise<Snapshot> => {
      const graph: Graph = await hooks.source.read("1", gh.ctx);
      return { graph, node: graph.nodes.find((n) => n.id === "1") };
    };
    return { gh, hooks, opened, snapshot };
  };

  it("merges a green pull request and then reads it satisfied", async () => {
    const { gh, hooks, opened, snapshot } = project({ checks: "SUCCESS" });
    const before = await snapshot();
    expect(hooks.post.satisfied(before, merge)).toBe(false);
    await hooks.post.apply(merge, { ...gh.ctx, item: "1", snapshot: before } as HookContext);
    expect(opened.merged).toBe(true);
    expect(hooks.post.satisfied(await snapshot(), merge)).toBe(true);
  });

  it("refuses a red pull request, naming its checks, and merges nothing", async () => {
    const { gh, hooks, opened, snapshot } = project({ checks: "FAILURE" });
    await expect(hooks.post.apply(merge, { ...gh.ctx, item: "1", snapshot: await snapshot() } as HookContext))
      .rejects.toThrow("will not merge pr-8 for #1: its checks on abc1234 are failure");
    expect(opened.merged).toBe(false);
    expect(gh.requests.some((r) => r.method === "PUT")).toBe(false);
  });

  it("does not halt on a head that moved after the snapshot: nothing merges, the next read has the new head", async () => {
    const { gh, hooks, opened, snapshot } = project({ checks: "SUCCESS" });
    const stale = await snapshot();
    opened.headSha = "def5678";
    await hooks.post.apply(merge, { ...gh.ctx, item: "1", snapshot: stale } as HookContext);
    expect(opened.merged).toBe(false);
    const next = ((await snapshot()).graph as Graph).nodes.find((n) => n.id === "pr-8");
    expect(next?.state.headSha).toBe("def5678");
  });
});
