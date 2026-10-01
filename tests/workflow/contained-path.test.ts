import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containedPath, workspacePath } from "#workflow/load.js";

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

describe("workspacePath: relative to a workflow, contained in the workspace", () => {
  // <tmp>/outside.ts is a sibling of the workspace, not inside it.
  let outer: string;
  let ws: string;
  beforeEach(async () => {
    outer = await mkdtemp(join(tmpdir(), "landrace-wsp-"));
    ws = join(outer, "ws");
    for (const d of ["hooks", "workflows/main/steps", "workflows/main/hooks", "workflows/fastlane/steps"]) {
      await mkdir(join(ws, d), { recursive: true });
    }
    for (const f of ["hooks/claude.ts", "workflows/main/steps/build.md", "workflows/main/hooks/own.ts", "workflows/fastlane/steps/build.md"]) {
      await writeFile(join(ws, f), "");
    }
    await writeFile(join(outer, "outside.ts"), "");
  });
  afterEach(() => rm(outer, { recursive: true, force: true }));

  it("reaches the shared hooks folder from a workflow", async () => {
    expect(await workspacePath(ws, "workflows/main", "../../hooks/claude.ts")).toMatchObject({ ok: true });
  });
  it("reaches a file of the workflow's own", async () => {
    expect(await workspacePath(ws, "workflows/main", "hooks/own.ts")).toMatchObject({ ok: true });
  });
  it("reaches another workflow's step from a step folder", async () => {
    expect(await workspacePath(ws, "workflows/fastlane/steps", "../../main/steps/build.md")).toMatchObject({ ok: true });
  });
  it.each([["../../../outside.ts"], ["../../hooks/../../outside.ts"], ["/etc/passwd"], ["..\\..\\hooks\\claude.ts"], [".../x"]])(
    "refuses %s",
    async (rel) => {
      expect(await workspacePath(ws, "workflows/main", rel)).toMatchObject({ ok: false, kind: "unsafe" });
    },
  );
  it("refuses a link inside the workspace that points outside it", async () => {
    await symlink(join(outer, "outside.ts"), join(ws, "hooks", "escape.ts"));
    expect(await workspacePath(ws, "workflows/main", "../../hooks/escape.ts")).toMatchObject({ ok: false, kind: "unsafe" });
  });
  it("says a missing file is missing", async () => {
    expect(await workspacePath(ws, "workflows/main", "../../hooks/nope.ts")).toMatchObject({ ok: false, kind: "missing" });
  });
});
