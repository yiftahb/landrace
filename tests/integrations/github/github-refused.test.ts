import { createClient, GitHubForge } from "landrace/integrations/github";
import { isEffectRefused } from "landrace/kit";
import { createFakeTracker, type FakeTracker } from "#tests/support/fake-tracker.js";
import type { Effect, HookContext, Snapshot } from "#namespace.js";

/*
 * What GitHub refuses on purpose carries the kit's mark, so the engine
 * records it on the item and asks a person; what failed on the way — a 5xx,
 * a rate limit, a token GitHub no longer accepts — does not, and is asked
 * again on the next tick. Through the real client over the fake GitHub.
 */
const forgeOf = (gh: FakeTracker): GitHubForge =>
  new GitHubForge({ closingRefs: true, client: createClient({ repo: "acme/widgets", token: "test-token", fetchImpl: gh.fetchImpl }) });

const forItem = (gh: FakeTracker): HookContext => ({ ...gh.ctx, item: "1", snapshot: {} });

const failure = (p: Promise<unknown>): Promise<{ message: string; refused: boolean } | "resolved"> =>
  p.then(() => "resolved" as const, (e: unknown) => ({ message: (e as Error).message, refused: isEffectRefused(e) }));

describe("a merge GitHub refuses", () => {
  it("marks one GitHub finds not mergeable", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    gh.openPull({ head: "landrace/1", number: 8, headSha: "abc", mergeable: false });
    expect(await failure(forgeOf(gh).merge(8, "abc", forItem(gh)))).toEqual({
      message: "pr-8 for #1 cannot be merged: Pull Request is not mergeable", refused: true,
    });
  });

  it("marks a token without the permissions a merge needs", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    gh.openPull({ head: "landrace/1", number: 8, headSha: "abc" });
    gh.breakOn(({ method }) => method === "PUT", 403);
    expect(await failure(forgeOf(gh).merge(8, "abc", forItem(gh)))).toMatchObject({
      message: expect.stringContaining('token needs "Pull requests: Read and write" and "Contents: Read and write"'), refused: true,
    });
  });

  /*
   * GitHub still settling the merge: it answers 405 while it has not
   * worked out whether the pull request can merge, or when the base branch
   * moved under it, and says to try again. Both clear by asking again.
   */
  it("leaves 'Base branch was modified' unmarked, for the next tick", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    gh.openPull({ head: "landrace/1", number: 8, headSha: "abc" });
    gh.breakOn(({ method }) => method === "PUT", 405, { message: "Base branch was modified. Review and try the merge again." });
    expect(await failure(forgeOf(gh).merge(8, "abc", forItem(gh)))).toMatchObject({
      message: expect.stringContaining("Base branch was modified"), refused: false,
    });
  });

  it("leaves a merge GitHub refuses while it is still working out mergeability unmarked", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    gh.openPull({ head: "landrace/1", number: 8, headSha: "abc", mergeable: null });
    expect(await failure(forgeOf(gh).merge(8, "abc", forItem(gh)))).toMatchObject({ refused: false });
  });

  it.each([
    ["a 502", 502, undefined],
    ["a 503", 503, undefined],
    ["a 403 that is a rate limit", 403, { message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." }],
    ["a token GitHub no longer accepts", 401, undefined],
  ] as const)("leaves %s unmarked, for the next tick", async (_what, status, body) => {
    const gh = createFakeTracker([{ number: 1 }]);
    gh.openPull({ head: "landrace/1", number: 8, headSha: "abc" });
    gh.breakOn(({ method }) => method === "PUT", status, body);
    expect(await failure(forgeOf(gh).merge(8, "abc", forItem(gh)))).toMatchObject({ refused: false });
  });
});

describe("a pull request GitHub will not open", () => {
  it("marks GitHub's 'No commits between' as nothing committed", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    gh.breakOn((r) => r.method === "POST" && r.path === "/pulls", 422, {
      message: "Validation Failed",
      errors: [{ resource: "PullRequest", code: "custom", message: "No commits between main and landrace/1" }],
    });
    expect(await failure(forgeOf(gh).openPull({ item: "1", branch: "landrace/1", title: "t" }, gh.ctx))).toMatchObject({
      message: expect.stringMatching(/^nothing was committed on landrace\/1 for #1/), refused: true,
    });
  });

  it("marks a token that may not open pull requests", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    gh.breakOn((r) => r.method === "POST" && r.path === "/pulls", 403);
    expect(await failure(forgeOf(gh).openPull({ item: "1", branch: "landrace/1", title: "t" }, gh.ctx))).toMatchObject({ refused: true });
  });

  it("leaves a 502 unmarked", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    gh.breakOn((r) => r.method === "POST" && r.path === "/pulls", 502);
    expect(await failure(forgeOf(gh).openPull({ item: "1", branch: "landrace/1", title: "t" }, gh.ctx))).toMatchObject({ refused: false });
  });

  it("marks the kit's own refusal of a branch no step committed to, before GitHub is asked", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    const post = gh.registry.post[0];
    if (!post) throw new Error("the fake tracker registered no post hook");
    const graph = await gh.registry.source?.read("1", gh.ctx);
    const snapshot: Snapshot = { graph, node: graph?.nodes.find((n) => n.id === "1"), git: { local: {}, remote: {} } };
    const open: Effect = { type: "pull.open", branch: "landrace/1" };
    expect(await failure(post.apply(open, { ...gh.ctx, item: "1", snapshot }))).toMatchObject({
      message: expect.stringContaining("no such branch"), refused: true,
    });
    expect(gh.requests.filter((r) => r.path === "/pulls")).toEqual([]);
  });
});

describe("a pull request a person closed on GitHub", () => {
  it("refuses to open another from the branch, before GitHub is asked", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    gh.openPull({ head: "landrace/1", number: 8, closes: [1], state: "CLOSED" });
    const post = gh.registry.post[0];
    if (!post) throw new Error("the fake tracker registered no post hook");
    const graph = await gh.registry.source?.read("1", gh.ctx);
    const snapshot: Snapshot = { graph, node: graph?.nodes.find((n) => n.id === "1"), git: { local: { "landrace/1": "abc" }, remote: {} } };
    expect(await failure(post.apply({ type: "pull.open", branch: "landrace/1" }, { ...gh.ctx, item: "1", snapshot }))).toMatchObject({
      message: expect.stringContaining("pr-8 from landrace/1 for #1 was closed unmerged"), refused: true,
    });
    expect(gh.requests.filter((r) => r.method === "POST" && r.path === "/pulls")).toEqual([]);
  });
});

describe("a pull request GitHub will not close", () => {
  it("marks a token that may not close it", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    gh.openPull({ head: "landrace/1", number: 8 });
    gh.breakOn((r) => r.method === "PATCH" && r.path === "/pulls/8", 403);
    expect(await failure(forgeOf(gh).closePull(8, gh.ctx))).toMatchObject({
      message: expect.stringContaining('token needs "Pull requests: Read and write"'), refused: true,
    });
  });

  it("leaves a 502 unmarked", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    gh.openPull({ head: "landrace/1", number: 8 });
    gh.breakOn((r) => r.method === "PATCH" && r.path === "/pulls/8", 502);
    expect(await failure(forgeOf(gh).closePull(8, gh.ctx))).toMatchObject({ refused: false });
  });
});
