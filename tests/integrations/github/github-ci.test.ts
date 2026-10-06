import { createClient, GitHubForge, GitHubIssues } from "landrace/integrations/github";
import { compose } from "landrace/kit";
import { buildBriefing } from "#runner/artifacts.js";
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
  ({ number: pull.number, title: "t", link: "", merged: pull.merged, closed: false, headSha: pull.headSha, conflicts: false, branch: pull.head, createdAt: undefined, items: [] });

/** The context a merge is asked in: for #1, the item whose refusal it names. */
const forItem = (gh: FakeTracker): HookContext => ({ ...gh.ctx, item: "1", snapshot: {} });

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

describe("named reviewers", () => {
  const reviewing = (gh: FakeTracker): GitHubForge => new GitHubForge({
    closingRefs: true, reviewers: [{ status: "CodeRabbit" }],
    client: createClient({ repo: "acme/widgets", token: "test-token", fetchImpl: gh.fetchImpl }),
  });

  it.each<[string, Partial<FakePull>, number]>([
    ["a run still in progress", { checkRuns: [run(1, "CodeRabbit", null, { status: "in_progress" })] }, 1],
    ["a run queued", { checkRuns: [run(1, "CodeRabbit", null, { status: "queued" })] }, 1],
    ["a run completed", { checkRuns: [run(1, "CodeRabbit", "neutral")] }, 0],
    ["a run that failed", { checkRuns: [run(1, "CodeRabbit", "failure")] }, 0],
    ["a status pending", { statuses: [{ context: "CodeRabbit", state: "pending" }] }, 1],
    ["a status that succeeded", { statuses: [{ context: "CodeRabbit", state: "success" }] }, 0],
    ["neither", { statuses: [{ context: "ci/other", state: "success" }] }, 1],
  ])("reads %s as reviewPending %s", async (_said, seed, pending) => {
    const gh = createFakeTracker([{ number: 1 }]);
    gh.openPull({ head: "landrace/1", number: 10, headSha: "head", checks: "SUCCESS", ...seed });
    const client = createClient({ repo: "acme/widgets", token: "test-token", fetchImpl: gh.fetchImpl });
    const hooks = compose({ tracker: new GitHubIssues({ client }), forge: reviewing(gh) });
    const graph = await hooks.source.read("1", gh.ctx);
    expect(graph.nodes.find((n) => n.id === "pr-10")?.state).toMatchObject({ reviewPending: pending });
  });

  it("refuses, rather than call a reviewer missing, when GitHub listed only part of the head's checks", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    const pull = gh.openPull({ head: "landrace/1", headSha: "head", checkRuns: [run(1, "unit", "success")], checkRunsTotal: 150 });
    await expect(reviewing(gh).finishedReviewers(recordOf(pull), gh.ctx)).rejects.toThrow(/CodeRabbit/);
  });

  it.each([
    ["finished", "success", ["CodeRabbit"]],
    ["running", null, []],
  ] as const)("reads a reviewer %s on the part GitHub listed as it stands", async (_said, conclusion, finished) => {
    const gh = createFakeTracker([{ number: 1 }]);
    const runs = [run(1, "CodeRabbit", conclusion, conclusion === null ? { status: "in_progress" } : {})];
    const pull = gh.openPull({ head: "landrace/1", headSha: "head", checkRuns: runs, checkRunsTotal: 150 });
    expect(await reviewing(gh).finishedReviewers(recordOf(pull), gh.ctx)).toEqual(new Set(finished));
  });

  it.each([
    ["CI green beside a running reviewer", [run(1, "unit", "success"), run(2, "CodeRabbit", null, { status: "in_progress" })], "success"],
    ["CI green beside a failed reviewer", [run(1, "unit", "success"), run(2, "CodeRabbit", "failure")], "success"],
    ["CI running", [run(1, "unit", null, { status: "in_progress" }), run(2, "CodeRabbit", "success")], "pending"],
    ["CI red", [run(1, "unit", "failure"), run(2, "CodeRabbit", "success")], "failure"],
    ["only the reviewer", [run(2, "CodeRabbit", "success")], "none"],
  ] as const)("leaves the reviewer out of checks: %s reads %s", async (_said, checkRuns, expected) => {
    const gh = createFakeTracker([{ number: 1 }]);
    // The rollup folds the reviewer in: never what is read once a reviewer is named.
    const pull = gh.openPull({ head: "landrace/1", headSha: "head", checks: "FAILURE", checkRuns: [...checkRuns] });
    expect(await reviewing(gh).checks(recordOf(pull), gh.ctx)).toBe(expected);
    expect(checksQueries(gh)).toEqual([]);
  });

  it("leaves a reviewer's status out of checks, and its failure out of the failed checks", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    const pull = gh.openPull({
      head: "landrace/1", headSha: "head",
      statuses: [{ context: "CodeRabbit", state: "failure" }, { context: "ci/jenkins", state: "success" }],
      checkRuns: [run(1, "CodeRabbit", "failure")],
    });
    expect(await reviewing(gh).checks(recordOf(pull), gh.ctx)).toBe("success");
    expect(await reviewing(gh).failedChecks(recordOf(pull), gh.ctx)).toEqual([]);
    expect((await forgeOf(gh).failedChecks(recordOf(pull), gh.ctx)).map((c) => c.name)).toEqual(["CodeRabbit", "CodeRabbit"]);
  });

  it("never reads a list GitHub did not give whole as green", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    const pull = gh.openPull({ head: "landrace/1", headSha: "head", checkRuns: [run(1, "unit", "success")], checkRunsTotal: 101 });
    expect(await reviewing(gh).checks(recordOf(pull), gh.ctx)).toBe("pending");
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
    expect(gh.hops.map((h) => h.url)).toContain("https://api.github.com/repos/acme/widgets/commits/abc1234/check-runs?per_page=100");
  });

  it("reads a log through GitHub's redirect to another origin, which is sent no Authorization", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    const pull = gh.openPull({ head: "landrace/1", checkRuns: [run(2, "unit", "failure")], jobLogs: new Map([[2, "the log text"]]) });
    expect(await forgeOf(gh).failedChecks(recordOf(pull), gh.ctx)).toEqual([{ name: "unit", log: "the log text" }]);
    const hops = gh.hops.filter((h) => h.url.includes("/logs") || h.url.includes("blob.example"));
    expect(hops.map((h) => new URL(h.url).host)).toEqual(["api.github.com", "blob.example"]);
    expect(hops[0]?.authorization).toBe("Bearer test-token");
    expect(hops[1]?.authorization).toBeNull();
  });

  it.each(["checks", "failedChecks"] as const)("%s refuses an empty head with a sentence naming the pull request", async (method) => {
    const gh = createFakeTracker([{ number: 1 }]);
    const pull = gh.openPull({ head: "landrace/1", number: 4, checks: "SUCCESS" });
    await expect(forgeOf(gh)[method]({ ...recordOf(pull), headSha: "" }, gh.ctx)).rejects.toThrow("pr-4 has no head commit to read checks on");
    expect(gh.requests.filter((r) => r.path.startsWith("/commits/"))).toEqual([]);
    expect(checksQueries(gh)).toEqual([]);
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

/*
 * A prompt is briefed only the keys it names, and only those are read: a
 * review that names threads and a diff never pays for a red build's checks
 * and logs, nor fails when they cannot be read.
 */
describe("briefing only the keys a prompt names", () => {
  const redPull = (gh: FakeTracker): void => {
    gh.openPull({
      head: "landrace/1", number: 8, headSha: "abc1234", closes: [1], checks: "FAILURE",
      checkRuns: [run(1, "unit", "failure"), run(2, "e2e", "failure")],
      jobLogs: new Map([[1, "boom"], [2, "bang"]]),
    });
  };
  const ciRequests = (gh: FakeTracker): string[] => [
    ...checksQueries(gh).map(() => "LandraceChecks"),
    ...gh.requests.map((r) => r.path).filter((p) => p.includes("/check-runs") || p.endsWith("/status") || p.startsWith("/actions/jobs/")),
  ];
  const brief = (gh: FakeTracker, prompt: string) =>
    buildBriefing([gh.registry.source as NonNullable<FakeTracker["registry"]["source"]>], { ...gh.ctx, item: "1", snapshot: {} } as HookContext, prompt);

  it("makes no checks or log request for a prompt that names only the threads", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    redPull(gh);
    const briefed = await brief(gh, "Fix what is open.\n\n{brief.project.threads}");
    expect(Object.keys(briefed.project ?? {})).toEqual(["threads"]);
    expect(ciRequests(gh)).toEqual([]);
  });

  it("is not failed by a checks read that would fail, when the prompt does not name ci", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    redPull(gh);
    gh.breakOn(({ path }) => path.endsWith("/check-runs"), 502);
    await expect(brief(gh, "{brief.project.threads} {brief.project.diff}")).resolves.toMatchObject({ project: { threads: expect.any(String), diff: expect.any(String) } });
  });

  it("still briefs ci to a prompt that names it", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    redPull(gh);
    const briefed = await brief(gh, "Make it green.\n\n{brief.project.ci}");
    expect(Object.keys(briefed.project ?? {})).toEqual(["ci"]);
    expect(briefed.project?.ci).toContain("### pr-8: checks failure");
    expect(briefed.project?.ci).toContain("#### unit");
    expect(briefed.project?.ci).toContain("boom");
    expect(ciRequests(gh)).toEqual(expect.arrayContaining(["LandraceChecks", "/actions/jobs/1/logs"]));
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
    expect(await forge.merge(8, "abc1234", forItem(gh))).toBe("merged");
    expect(put).toHaveBeenCalledWith(expect.stringContaining("/pulls/8/merge"), { sha: "abc1234", merge_method: "merge" });
    expect(pull.merged).toBe(true);
  });

  it("answers moved, and merges nothing, when the head is not the one asked for", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    const pull = gh.openPull({ head: "landrace/1", number: 8, headSha: "new" });
    expect(await forgeOf(gh).merge(8, "old", forItem(gh))).toBe("moved");
    expect(pull.merged).toBe(false);
  });

  it("answers moved for a head that moved on a pull request GitHub finds unmergeable first", async () => {
    // A push whose required checks have not run: GitHub may say "not mergeable" before it looks at the head.
    const gh = createFakeTracker([{ number: 1 }]);
    const pull = gh.openPull({ head: "landrace/1", number: 8, headSha: "new", mergeable: false });
    expect(await forgeOf(gh).merge(8, "old", forItem(gh))).toBe("moved");
    expect(gh.requests.map((r) => `${r.method} ${r.path}`)).toEqual(expect.arrayContaining(["PUT /pulls/8/merge", "GET /pulls/8"]));
    expect(pull.merged).toBe(false);
  });

  it("answers merged for a pull request that already is, and does not throw", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    gh.openPull({ head: "landrace/1", number: 8, headSha: "abc", merged: true });
    expect(await forgeOf(gh).merge(8, "abc", forItem(gh))).toBe("merged");
    expect(gh.requests.map((r) => `${r.method} ${r.path}`)).toEqual(expect.arrayContaining(["PUT /pulls/8/merge", "GET /pulls/8"]));
  });

  it("refuses one GitHub will not merge, naming the pull request and GitHub's words", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    gh.openPull({ head: "landrace/1", number: 8, headSha: "abc", mergeable: false });
    await expect(forgeOf(gh).merge(8, "abc", forItem(gh))).rejects.toThrow("pr-8 for #1 cannot be merged: Pull Request is not mergeable");
  });

  it("wraps any other refusal in a sentence naming the pull request and the item", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    gh.openPull({ head: "landrace/1", number: 8, headSha: "abc" });
    gh.breakOn(({ method }) => method === "PUT", 422, { message: "Validation Failed" });
    await expect(forgeOf(gh).merge(8, "abc", forItem(gh))).rejects.toThrow(/^pr-8 for #1 could not be merged: GitHub answered 422: Validation Failed$/);
  });

  it("names the permissions a refused merge lacks", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    gh.openPull({ head: "landrace/1", number: 8, headSha: "abc" });
    gh.breakOn(({ method }) => method === "PUT", 403);
    await expect(forgeOf(gh).merge(8, "abc", forItem(gh))).rejects.toThrow('token needs "Pull requests: Read and write" and "Contents: Read and write" on acme/widgets');
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

  it("probes the default branch's tip, whatever it is called", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    const seen = gh.fetchImpl;
    const develop = (async (url: string, init?: RequestInit) => {
      const res = await seen(url, init);
      return String(url).endsWith("/repos/acme/widgets") ? new Response(JSON.stringify({ default_branch: "trunk" }), { status: 200 }) : res;
    }) as typeof fetch;
    const forge = new GitHubForge({ client: createClient({ repo: "acme/widgets", token: "t", fetchImpl: develop }) });
    await forge.check(gh.ctx);
    expect(gh.requests.map((r) => r.path)).toEqual(expect.arrayContaining(["/commits/trunk/check-runs", "/commits/trunk/status"]));
    expect(gh.requests.map((r) => r.path)).not.toContain("/commits/main/check-runs");
  });

  it.each([404, 422])("starts on an empty repository, where the default branch has no commit to read (%i)", async (status) => {
    const gh = createFakeTracker([{ number: 1 }]);
    gh.breakOn(({ path }) => path.startsWith("/commits/"), status);
    await expect(forgeOf(gh).check(gh.ctx)).resolves.toBeUndefined();
  });

  it("still refuses a 403 on the same probes, naming the permissions", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    gh.breakOn(({ path }) => path.startsWith("/commits/"), 403);
    await expect(forgeOf(gh).check(gh.ctx)).rejects.toThrow('token needs "Checks: Read" and "Commit statuses: Read" on acme/widgets');
  });

  // A token made by the README before P6 lacks both: one restart should say so, not two.
  it("names every missing permission in one sentence, for a token missing both", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    gh.breakOn(({ path }) => path.endsWith("/check-runs") || path.endsWith("/status"), 403, {
      message: "Resource not accessible by personal access token", status: "403",
    });
    const said = await forgeOf(gh).check(gh.ctx).then(() => "", (e: unknown) => (e as Error).message);
    expect(said).toMatch(/^token needs "Checks: Read" and "Commit statuses: Read" on acme\/widgets \(GitHub answered: /);
    expect(said.match(/token needs/g)).toHaveLength(1);
    expect(gh.requests.map((r) => r.path)).toEqual(expect.arrayContaining(["/commits/main/check-runs", "/commits/main/status"]));
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

// A user told only "needs Checks: Read" looked for a fine-grained setting that does not exist.
describe("a token refused Checks", () => {
  const where = /only to a classic token with the repo scope or to a GitHub App, never to a fine-grained token/;

  it("says where Checks: Read is granted, at start and on a read", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    gh.breakOn(({ path }) => path.endsWith("/check-runs"), 403, { message: "Resource not accessible by personal access token" });
    await expect(forgeOf(gh).check(gh.ctx)).rejects.toThrow(where);
    const pull = gh.openPull({ head: "landrace/1", number: 8, headSha: "abc1234", checks: "FAILURE" });
    await expect(forgeOf(gh).failedChecks(recordOf(pull), gh.ctx)).rejects.toThrow(where);
  });

  it("says nothing of it when only Commit statuses is refused", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    gh.breakOn(({ path }) => path.endsWith("/status"), 403);
    const said = await forgeOf(gh).check(gh.ctx).then(() => "", (e: unknown) => (e as Error).message);
    expect(said).toContain('token needs "Commit statuses: Read"');
    expect(said).not.toMatch(where);
  });
});

/*
 * Whether a pull request conflicts with its base, as GraphQL's `mergeable`
 * says: UNKNOWN while GitHub works it out, which the node leaves out so a
 * workflow never routes on a guess.
 */
describe("a pull request's conflicts", () => {
  it.each([["CONFLICTING", 1], ["MERGEABLE", 0], ["UNKNOWN", undefined]] as const)(
    "reads GraphQL's mergeable %s as conflicts %s",
    async (mergeable, conflicts) => {
      const gh = createFakeTracker([{ number: 1 }]);
      gh.openPull({ head: "landrace/1", number: 10, graphqlMergeable: mergeable });
      const graph = await gh.registry.source?.read("1", gh.ctx);
      const state = graph?.nodes.find((n) => n.id === "pr-10")?.state ?? {};
      expect(state.conflicts).toBe(conflicts);
      expect(Object.hasOwn(state, "conflicts")).toBe(conflicts !== undefined);
      expect(gh.graphql.some((q) => /\bmergeable\b/.test(q.query))).toBe(true);
    },
  );

  it("reads a merged or closed one as conflicting with nothing", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    gh.openPull({ head: "landrace/1", number: 10, merged: true, graphqlMergeable: "CONFLICTING" });
    gh.openPull({ head: "landrace/1", number: 11, state: "CLOSED", graphqlMergeable: "UNKNOWN" });
    const graph = await gh.registry.source?.read("1", gh.ctx);
    const state = (id: string) => graph?.nodes.find((n) => n.id === id)?.state;
    expect(state("pr-10")).toMatchObject({ conflicts: 0 });
    expect(state("pr-11")).toMatchObject({ conflicts: 0 });
  });

  it("says so in the ci briefing", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    gh.openPull({ head: "landrace/1", number: 5, checks: "SUCCESS", graphqlMergeable: "CONFLICTING" });
    const briefed = await gh.registry.source?.brief?.({ ...gh.ctx, item: "1", snapshot: {} } as HookContext);
    expect(briefed?.ci).toContain("pr-5 conflicts with the default branch");
  });
});
