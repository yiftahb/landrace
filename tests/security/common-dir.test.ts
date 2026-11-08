import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ensureWorktree, gitDirsOf, worktreeHead } from "#agent/worktree.js";
import { gitCommonDir, ownGit } from "#kit/git.js";
import { commonDirOf, sandboxRoot } from "#sandbox.js";
import { gitRepo, removeRepos } from "#tests/support/repo.js";

/*
 * git reads `commondir` in the main git directory too, and a write step on
 * Linux may make it there: the sandbox denies only paths that exist. So the
 * engine never asks git where the common directory is when `<root>/.git` is a
 * directory — that directory is it — and pins it on every git it runs, so one
 * planted while the engine runs is never followed.
 */

jest.setTimeout(60_000);

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", args, { cwd })).stdout.trim();

const made: string[] = [];
afterAll(async () => {
  while (made.length) await rm(made.pop() as string, { recursive: true, force: true });
  await removeRepos();
});

/** A repository of the step's own, with no commits: git following a planted commondir there finds no HEAD. */
async function elsewhere(): Promise<string> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "lr-elsewhere-")));
  made.push(dir);
  await git(dir, "init", "-q", "--bare");
  return dir;
}

describe("gitCommonDir", () => {
  it("is <root>/.git, asked from the top level or a folder below it", async () => {
    const root = await gitRepo();
    const common = realpathSync(join(root, ".git"));
    expect(gitCommonDir(root)).toBe(common);
    expect(gitCommonDir(join(root, "src"))).toBe(common);
  });

  it("is git's answer in a linked worktree, whose .git is a file", async () => {
    const root = await gitRepo();
    const path = await ensureWorktree("1", root);
    expect(gitCommonDir(path)).toBe(realpathSync(join(root, ".git")));
  });

  it("refuses a commondir in <root>/.git, naming it, where git follows it", async () => {
    const root = await gitRepo();
    const evil = await elsewhere();
    await writeFile(join(root, ".git", "commondir"), `${evil}\n`);
    // Armed: git asked plainly answers the step's directory.
    expect(realpathSync(await git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"))).toBe(evil);
    expect(() => gitCommonDir(root)).toThrow(join(realpathSync(join(root, ".git")), "commondir"));
    expect(() => gitCommonDir(join(root, "src"))).toThrow(/commondir/);
  });

  it("refuses an empty commondir in <root>/.git too: never followed, whatever it holds", async () => {
    const root = await gitRepo();
    await writeFile(join(root, ".git", "commondir"), "");
    expect(() => gitCommonDir(root)).toThrow(/commondir/);
  });

  it("throws git's own words outside a repository", async () => {
    const dir = realpathSync(await mkdtemp(join(tmpdir(), "lr-plain-")));
    made.push(dir);
    expect(() => gitCommonDir(dir)).toThrow(/not a git repository/i);
  });
});

describe("a commondir in <root>/.git at startup", () => {
  it("stops sandboxRoot, naming it, rather than keying the sandbox on another directory", async () => {
    const root = await gitRepo();
    await writeFile(join(root, ".git", "commondir"), `${await elsewhere()}\n`);
    expect(() => sandboxRoot(root)).toThrow(join(realpathSync(join(root, ".git")), "commondir"));
  });

  it("stops ownGit's first call, naming it", async () => {
    const root = await gitRepo();
    await writeFile(join(root, ".git", "commondir"), `${await elsewhere()}\n`);
    await expect(ownGit(async () => root)(["rev-parse", "HEAD"])).rejects.toThrow(join(realpathSync(join(root, ".git")), "commondir"));
  });

  it("leaves a directory outside any repository its own identity", async () => {
    const dir = realpathSync(await mkdtemp(join(tmpdir(), "lr-plain-")));
    made.push(dir);
    expect(sandboxRoot(dir)).toMatch(/lr-plain-/);
  });
});

describe("a commondir planted in <root>/.git once the engine is running", () => {
  // GIT_COMMON_DIR pins config, hooks and objects; git's ref store follows `<gitdir>/commondir` whatever
  // the environment says. So in the checkout the engine's git refuses while it is there, never reading
  // or moving branches in the step's directory; in a worktree, pinned to its admin folder, it is ignored.
  it("hands git none of its config, even past the pin, and stops ownGit naming it", async () => {
    const root = await gitRepo();
    const evil = await elsewhere();
    await git(evil, "config", "x.planted", "yes");
    const own = ownGit(async () => root);
    await own(["rev-parse", "HEAD"]);
    const common = realpathSync(join(root, ".git"));
    await writeFile(join(root, ".git", "commondir"), `${evil}\n`);
    // Armed: git asked plainly reads the step's config, and no longer finds the commit.
    expect(await git(root, "config", "x.planted")).toBe("yes");
    await expect(git(root, "rev-parse", "HEAD")).rejects.toThrow();
    // The pin alone keeps its config out.
    await expect(exec("git", ["config", "x.planted"], { cwd: root, env: { ...process.env, GIT_COMMON_DIR: common } }))
      .rejects.toMatchObject({ code: 1 });
    await expect(own(["rev-parse", "HEAD"])).rejects.toThrow(join(common, "commondir"));
  });

  it("is never followed by gitDirsOf or the worktree's git, and stops git in the checkout naming it", async () => {
    const root = await gitRepo();
    const common = commonDirOf(root);
    const path = await ensureWorktree("2", root);
    const head = await worktreeHead(path, root);
    await writeFile(join(root, ".git", "commondir"), `${await elsewhere()}\n`);
    expect((await gitDirsOf(path, root)).GIT_COMMON_DIR).toBe(common);
    expect(await worktreeHead(path, root)).toBe(head);
    await expect(ensureWorktree("3", root)).rejects.toThrow(join(common, "commondir"));
  });

  it("is never followed by a subfolder's identity either, once asked", async () => {
    const root = await gitRepo();
    await mkdir(join(root, "deep"), { recursive: true });
    const before = sandboxRoot(join(root, "deep"));
    await writeFile(join(root, ".git", "commondir"), `${await elsewhere()}\n`);
    expect(sandboxRoot(join(root, "deep"))).toBe(before);
  });
});
