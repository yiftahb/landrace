import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const SCRIPT = join(process.cwd(), "scripts/release-notes.mjs");

const CHANGELOG = `# Changelog

## [Unreleased]

### Added

- Something not released yet.

## [11.0.0] - 2027-01-01

- Eleven.

## [1.0.0-rc.1] - 2026-09-01

- The candidate.

## [1.0.0] - 2026-10-03

### Added

- The first release.

[Unreleased]: https://github.com/yiftahb/landrace/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/yiftahb/landrace/releases/tag/v1.0.0
`;

async function release(tag: string, files: { version?: string; changelog?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "landrace-release-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "landrace", version: files.version ?? "1.0.0" }));
  await writeFile(join(dir, "CHANGELOG.md"), files.changelog ?? CHANGELOG);
  const out = join(dir, "notes.md");
  try {
    await exec(process.execPath, [SCRIPT, tag, out], { cwd: dir });
    return { ok: true as const, notes: await readFile(out, "utf8") };
  } catch (e) {
    return { ok: false as const, stderr: (e as { stderr: string }).stderr };
  }
}

describe("scripts/release-notes.mjs", () => {
  it("writes the version's own section as the notes, and nothing beside it", async () => {
    const result = await release("v1.0.0");
    expect(result).toEqual({ ok: true, notes: "### Added\n\n- The first release.\n" });
  });

  it("refuses a tag that is not package.json's version, naming both", async () => {
    const result = await release("v1.0.1");
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.stderr).toMatch(/v1\.0\.1.*1\.0\.0/);
    expect((await release("1.0.0")).ok).toBe(false);
  });

  it("refuses a version the changelog has no section for, however close another heading is", async () => {
    const result = await release("v1.0.0", { changelog: CHANGELOG.replace("## [1.0.0] - 2026-10-03", "## [1.0.0.1]") });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.stderr).toContain("## [1.0.0]");
  });

  it("refuses an empty section", async () => {
    const result = await release("v1.0.0", { changelog: "## [1.0.0] - 2026-10-03\n\n[1.0.0]: https://example.com\n" });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.stderr).toMatch(/is empty/);
  });
});

describe(".github/workflows/release.yml", () => {
  // A tag publishes to npm with an OIDC token in reach: a moved action tag or
  // a poisoned cache would publish someone else's build.
  const workflow = async () => (await readFile(join(process.cwd(), ".github/workflows/release.yml"), "utf8"));

  it("pins every action to a commit", async () => {
    const uses = [...(await workflow()).matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1] ?? "");
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) expect(use).toMatch(/@[0-9a-f]{40}$/);
  });

  it("restores no cache and keeps no git credentials", async () => {
    const text = await workflow();
    expect(text).not.toMatch(/^\s*cache:/m);
    expect(text).toMatch(/persist-credentials: false/);
  });
});
