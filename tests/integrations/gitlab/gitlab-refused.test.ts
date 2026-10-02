import { GitLab } from "landrace/integrations/gitlab";
import { isEffectRefused } from "landrace/kit";
import type { Git, HookContext } from "#namespace.js";
import { createFakeGitLab, type FakeGitLab, PROJECT } from "#tests/integrations/gitlab/fake-gitlab.js";

/*
 * What GitLab refuses on purpose carries the kit's mark, so the engine
 * records it on the item and asks a person; what failed on the way — a 5xx,
 * a token GitLab no longer accepts — does not, and is asked again on the
 * next tick. Through the real client over the fake GitLab.
 */
const noGit: Git = async () => "";
const forgeOver = (gl: FakeGitLab): GitLab => new GitLab({ project: PROJECT, fetchImpl: gl.fetchImpl, git: noGit });
const forItem = (gl: FakeGitLab): HookContext => ({ ...gl.ctx(), item: "1", snapshot: {} });

const failure = (p: Promise<unknown>): Promise<{ message: string; refused: boolean } | "resolved"> =>
  p.then(() => "resolved" as const, (e: unknown) => ({ message: (e as Error).message, refused: isEffectRefused(e) }));

describe("a merge GitLab refuses", () => {
  it.each([
    ["not mergeable", { mergeable: false }],
    ["a branch it cannot merge (406)", { branchRefusal: 406 }],
    ["a branch it cannot merge (422)", { branchRefusal: 422 }],
  ] as const)("marks one %s at the head it was asked at", async (_why, seed) => {
    const gl = createFakeGitLab();
    gl.open({ source_branch: "landrace/1", iid: 8, sha: "abc", ...seed });
    expect(await failure(forgeOver(gl).merge(8, "abc", forItem(gl)))).toMatchObject({
      message: expect.stringMatching(/^!8 for #1 cannot be merged: /), refused: true,
    });
  });

  /*
   * GitLab works mergeability out asynchronously, and its documentation says
   * to retry while it does: a 405 or 422 while the merge status is still
   * being checked, or waits on a running pipeline, clears by asking again.
   */
  it.each([
    ["checking", { mergeable: false }],
    ["unchecked", { mergeable: false }],
    ["ci_still_running", { mergeable: false }],
    ["preparing", { mergeable: false }],
    ["approvals_syncing", { mergeable: false }],
    ["checking", { branchRefusal: 422 }],
  ] as const)("leaves a merge refused while its merge status is %s unmarked, for the next tick", async (status, seed) => {
    const gl = createFakeGitLab();
    gl.open({ source_branch: "landrace/1", iid: 8, sha: "abc", detailed_merge_status: status, ...seed });
    expect(await failure(forgeOver(gl).merge(8, "abc", forItem(gl)))).toMatchObject({
      message: expect.stringMatching(/^!8 for #1 cannot be merged yet: /), refused: false,
    });
  });

  it("marks one whose merge status says it cannot merge", async () => {
    const gl = createFakeGitLab();
    gl.open({ source_branch: "landrace/1", iid: 8, sha: "abc", mergeable: false, detailed_merge_status: "conflict" });
    expect(await failure(forgeOver(gl).merge(8, "abc", forItem(gl)))).toMatchObject({ refused: true });
  });

  it("marks a user the protected branch does not allow to merge (401)", async () => {
    const gl = createFakeGitLab();
    gl.open({ source_branch: "landrace/1", iid: 8, sha: "abc", mayMerge: false });
    expect(await failure(forgeOver(gl).merge(8, "abc", forItem(gl)))).toMatchObject({
      message: expect.stringContaining("may not merge !8 for #1"), refused: true,
    });
  });

  it("marks a token without the scope or role a merge needs (403)", async () => {
    const gl = createFakeGitLab();
    gl.open({ source_branch: "landrace/1", iid: 8, sha: "abc" });
    gl.breakNext(({ method }) => method === "PUT", 403);
    expect(await failure(forgeOver(gl).merge(8, "abc", forItem(gl)))).toMatchObject({
      message: expect.stringContaining('token needs the "api" scope'), refused: true,
    });
  });

  it.each([500, 502, 503])("leaves a %i unmarked, for the next tick", async (status) => {
    const gl = createFakeGitLab();
    gl.open({ source_branch: "landrace/1", iid: 8, sha: "abc" });
    gl.breakNext(({ method }) => method === "PUT", status);
    expect(await failure(forgeOver(gl).merge(8, "abc", forItem(gl)))).toMatchObject({ refused: false });
  });
});

describe("a merge request GitLab will not close", () => {
  it("marks a token that may not close it (403)", async () => {
    const gl = createFakeGitLab();
    const mr = gl.open({ source_branch: "landrace/7" });
    gl.breakNext(({ method }) => method === "PUT", 403);
    expect(await failure(forgeOver(gl).closePull(mr.iid, gl.ctx()))).toMatchObject({
      message: expect.stringContaining('token needs the "api" scope'), refused: true,
    });
    expect(mr.state).toBe("opened");
  });

  it("leaves a 502 unmarked", async () => {
    const gl = createFakeGitLab();
    const mr = gl.open({ source_branch: "landrace/7" });
    gl.breakNext(({ method }) => method === "PUT", 502);
    expect(await failure(forgeOver(gl).closePull(mr.iid, gl.ctx()))).toMatchObject({ refused: false });
  });
});
