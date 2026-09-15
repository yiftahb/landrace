import { containedPath } from "../../src/workflow/load.js";

/**
 * `containedPath` is reused by the claude executor (src/agent/claude.ts) to
 * validate an absolute `cwd`, by treating "/" as the root and the rest of
 * the path as `relative` — a case its own tests never exercised before,
 * since every other caller passes a real project directory as root, never
 * the filesystem root itself.
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
