import { containedPath } from "#workflow/load.js";

/**
 * `containedPath`'s shape rules — no ".." segment, and the realpath-resolved
 * result must still land where it appears to — are stated for an arbitrary
 * `root`, but every caller in `src/` passes a real project directory: this is
 * the one place root itself is the filesystem root, which is what a hook
 * validating an absolute path (treating "/" as root and the rest as
 * `relative`, the way `.landrace/hooks/claude.ts` does its own `cwd` check)
 * would need to get right, and which nothing else here exercises.
 */
describe("containedPath against the filesystem root", () => {
  it("accepts a real absolute path with no unsafe segments", async () => {
    const result = await containedPath("/", "tmp");
    expect(result.ok).toBe(true);
  });

  it("still rejects a path that climbs with a \"..\" segment", async () => {
    const result = await containedPath("/", "tmp/../etc");
    expect(result).toMatchObject({ ok: false, kind: "unsafe" });
  });
});
