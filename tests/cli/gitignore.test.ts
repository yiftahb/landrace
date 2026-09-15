import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runValidate } from "../../src/cli/validate.js";

const execFileAsync = promisify(execFile);

/**
 * The gitignore guard in runValidate asks git rather than parsing .gitignore
 * itself, because gitignore semantics — negation, nesting, precedence across
 * multiple files — are real git behavior that a hand-rolled regex cannot
 * reproduce. These tests build actual git repositories (via `git init`) so
 * they exercise that real behavior instead of a fixture that merely looks
 * like one.
 */

async function gitInit(cwd: string): Promise<void> {
  await execFileAsync("git", ["init", "-q"], { cwd });
}

/** A workflow directory loadable by runValidate, with a .env file in it. */
async function workflowDir(...segments: string[]): Promise<string> {
  const dir = join(...segments);
  await mkdir(join(dir, "steps"), { recursive: true });
  await copyFile("tests/fixtures/minimal/workflow.yaml", join(dir, "workflow.yaml"));
  await copyFile("tests/fixtures/minimal/steps/spec.md", join(dir, "steps", "spec.md"));
  await writeFile(join(dir, ".env"), "GITHUB_TOKEN=ghp_x\n");
  return dir;
}

const notGitignored = (problems: { message: string }[]): boolean =>
  problems.some((p) => /not gitignored/.test(p.message));

describe("runValidate's .env gitignore guard, against real git repositories", () => {
  it("reports no problem when the parent .gitignore covers .env", async () => {
    const root = await mkdtemp(join(tmpdir(), "landrace-git-"));
    await gitInit(root);
    await writeFile(join(root, ".gitignore"), ".env\n");
    const dir = await workflowDir(root, ".landrace");

    const { problems } = await runValidate(dir);
    expect(notGitignored(problems)).toBe(false);
  });

  it("reports the problem when a negation pattern re-includes .env", async () => {
    const root = await mkdtemp(join(tmpdir(), "landrace-git-"));
    await gitInit(root);
    await writeFile(join(root, ".gitignore"), ".env\n!.landrace/.env\n");
    const dir = await workflowDir(root, ".landrace");

    // Sanity check the scenario against git itself, not just our guard.
    const ignored = await execFileAsync("git", ["check-ignore", "-q", ".env"], { cwd: dir }).then(
      () => true,
      () => false,
    );
    expect(ignored).toBe(false);

    const { problems } = await runValidate(dir);
    expect(notGitignored(problems)).toBe(true);
  });

  it("reports the problem when there is no .gitignore at all", async () => {
    const root = await mkdtemp(join(tmpdir(), "landrace-git-"));
    await gitInit(root);
    const dir = await workflowDir(root, ".landrace");

    const { problems } = await runValidate(dir);
    expect(notGitignored(problems)).toBe(true);
  });

  it("reports no problem for a workflow dir nested below a repo root using **/.env", async () => {
    const root = await mkdtemp(join(tmpdir(), "landrace-git-"));
    await gitInit(root);
    await writeFile(join(root, ".gitignore"), "**/.env\n");
    const dir = await workflowDir(root, "packages", "app", ".landrace");

    const { problems } = await runValidate(dir);
    expect(notGitignored(problems)).toBe(false);
  });

  it("reports no problem, and does not throw, outside any git repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "landrace-nogit-"));
    const dir = await workflowDir(root, ".landrace");

    const { problems } = await runValidate(dir); // must not reject
    expect(notGitignored(problems)).toBe(false);
  });
});
