import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { ensureWorktree } from "#agent/worktree.js";
import { runInit } from "#cli/init.js";
import { sandboxFor } from "#cli/start.js";
import { runValidate } from "#cli/validate.js";
import { runtimeConfigSchema } from "#config/schema.js";
import { resolveStepServers } from "#kit/executor.js";
import { CommonDirRefused, gitCommonDir, pinnedCommonDir, repositoryOf } from "#kit/git.js";
import { gitRepo, removeRepos } from "#tests/support/repo.js";
import { workspaceOf } from "#tests/support/workspace.js";

/*
 * Every git the engine runs is pinned to the repository's common directory,
 * and refused while a `commondir` is planted there: git would read a config
 * of the step's through it, and branches whatever the environment says. None
 * of these runs only before steps — a forge's first git can come after a run,
 * and `landrace mcp`, `validate` and `init` run at any time.
 */

jest.setTimeout(60_000);

const exec = promisify(execFile);

const made: string[] = [];
afterAll(async () => {
  while (made.length) await rm(made.pop() as string, { recursive: true, force: true });
  await removeRepos();
});

const scratch = async (prefix: string): Promise<string> => {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
};

/** A repository with a `commondir` planted in its `.git`, and the path planted. */
async function planted(): Promise<{ root: string; file: string }> {
  const root = await gitRepo();
  const file = join(realpathSync(join(root, ".git")), "commondir");
  await writeFile(file, `${await scratch("lr-elsewhere-")}\n`);
  return { root, file };
}

/**
 * Each git run while `fn` runs, as `<GIT_COMMON_DIR>|<args>`: a `git` ahead
 * of the real one on PATH writes down what it was handed, then runs it.
 */
async function gitsDuring(fn: () => Promise<unknown>): Promise<string[]> {
  const bin = await scratch("lr-git-");
  const log = join(bin, "log");
  const real = (await exec("sh", ["-c", "command -v git"])).stdout.trim();
  await writeFile(join(bin, "git"), `#!/bin/sh\nprintf '%s|%s\\n' "$GIT_COMMON_DIR" "$*" >> '${log}'\nexec '${real}' "$@"\n`);
  await chmod(join(bin, "git"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path ?? ""}`;
  try {
    await fn();
  } finally {
    process.env.PATH = path;
  }
  return (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
}

describe("pinnedCommonDir", () => {
  it("pins the repository's common directory, from a checkout and from a linked worktree", async () => {
    const root = await gitRepo();
    const common = realpathSync(join(root, ".git"));
    expect(pinnedCommonDir(root)).toEqual({ GIT_COMMON_DIR: common });
    expect(pinnedCommonDir(await ensureWorktree("1", root))).toEqual({ GIT_COMMON_DIR: common });
  });

  it("pins nothing outside a repository", async () => {
    expect(pinnedCommonDir(await scratch("lr-plain-"))).toEqual({});
  });

  it("refuses a planted commondir, naming it", async () => {
    const { root, file } = await planted();
    expect(() => pinnedCommonDir(root)).toThrow(CommonDirRefused);
    expect(() => pinnedCommonDir(root)).toThrow(file);
  });
});

/*
 * Run from a linked worktree, git finds the common directory through the
 * admin folder's `commondir`, which a Linux step can rebuild by renaming the
 * folder away. Cached, that is caught within one process; a restart, a fresh
 * `landrace mcp`, `validate` or forge git would pin every git to the step's
 * directory, and `git worktree add` would run its filter.
 */
describe("the common directory, from the operator's own linked worktree", () => {
  /** A repository, a linked worktree of it as the operator's checkout, and that checkout's admin folder. */
  async function linked(): Promise<{ root: string; own: string; common: string; admin: string }> {
    const root = await gitRepo();
    const common = realpathSync(join(root, ".git"));
    const own = join(await scratch("lr-own-"), "wt");
    await exec("git", ["worktree", "add", "-q", "-b", "own", own], { cwd: root });
    return { root, own: realpathSync(own), common, admin: join(common, "worktrees", "wt") };
  }

  /** A git directory of the step's, beside the common directory, holding what git needs to answer from it. */
  async function evil(common: string): Promise<string> {
    const at = join(common, "evil");
    await mkdir(at);
    for (const shared of ["objects", "refs", "HEAD", "config"]) await cp(join(common, shared), join(at, shared), { recursive: true });
    return at;
  }

  it("is git's answer when that is the directory the .git file names", async () => {
    const { own, common } = await linked();
    expect(gitCommonDir(own)).toBe(common);
    expect(pinnedCommonDir(own)).toEqual({ GIT_COMMON_DIR: common });
  });

  it.each([
    ["its commondir rebuilt to name another", async (_common: string, admin: string, at: string) => {
      await writeFile(join(admin, "commondir"), `${at}\n`);
    }],
    ["<common>/worktrees moved behind a link", async (common: string, _admin: string, at: string) => {
      await rename(join(common, "worktrees"), join(at, "worktrees"));
      await symlink(join(at, "worktrees"), join(common, "worktrees"));
    }],
  ])("is refused, naming both, with %s", async (_what, plant) => {
    const { own, common, admin } = await linked();
    const at = await evil(common);
    await plant(common, admin, at);
    // Armed: git itself now answers the step's directory.
    expect(realpathSync((await exec("git", ["rev-parse", "--git-common-dir"], { cwd: own })).stdout.trim())).toBe(at);
    expect(() => gitCommonDir(own)).toThrow(CommonDirRefused);
    expect(() => gitCommonDir(own)).toThrow(`git answers ${at}`);
    expect(() => gitCommonDir(own)).toThrow(`names ${common}`);
    expect(() => pinnedCommonDir(own)).toThrow(CommonDirRefused);
    await expect(repositoryOf(join(own, "src", "a.ts"))).rejects.toThrow(`git answers ${at}`);
  });

  it("passes a relative .git file", async () => {
    const { own, common, admin } = await linked();
    await writeFile(join(own, ".git"), `gitdir: ${relative(own, admin)}\n`);
    expect(gitCommonDir(own)).toBe(common);
  });

  // On Linux the operator's own admin folder is judged as the common directory is found at startup,
  // not only around a step's run: a restart before the next run would run `git worktree add` there.
  it("has its admin folder judged at startup on Linux, naming what a step put there", async () => {
    const { own, admin } = await linked();
    const config = runtimeConfigSchema.parse({ version: 1, agent: { adapter: "fake", isolation: "worktree" } });
    await expect(sandboxFor(config, own, "linux")).resolves.toMatchObject({ root: own });
    await mkdir(join(admin, "hooks"));
    await expect(sandboxFor(config, own, "linux")).rejects.toThrow(`${join(admin, "hooks")} exists`);
    await expect(sandboxFor(config, own, "linux")).rejects.toThrow(/a step that may write could have put it there/);
    await expect(sandboxFor(config, own, "darwin")).resolves.toMatchObject({ root: own });
  });
});

describe("repositoryOf", () => {
  it("passes GIT_COMMON_DIR to its git", async () => {
    const root = await gitRepo();
    const calls = await gitsDuring(() => repositoryOf(join(root, "src", "a.ts")));
    expect(calls.filter((c) => c.includes("--show-toplevel"))).toEqual([expect.stringMatching(`^${realpathSync(join(root, ".git"))}\\|`)]);
  });

  it("refuses a planted commondir, naming it, and runs no git", async () => {
    const { root, file } = await planted();
    let refused: unknown;
    const calls = await gitsDuring(() => repositoryOf(join(root, "src", "a.ts")).catch((e: unknown) => { refused = e; }));
    expect(String(refused)).toContain(file);
    expect(calls).toEqual([]);
  });
});

describe("the executor's repository root", () => {
  it("passes GIT_COMMON_DIR to its git", async () => {
    const root = await gitRepo();
    await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { memory: { command: "m" } } }));
    const calls = await gitsDuring(() => resolveStepServers(root, ["memory"]));
    expect(calls.filter((c) => c.includes("--show-toplevel"))).toEqual([expect.stringMatching(`^${realpathSync(join(root, ".git"))}\\|`)]);
  });

  it("refuses a planted commondir as itself, never as no repository", async () => {
    const { root, file } = await planted();
    await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { memory: { command: "m" } } }));
    const { problems } = await resolveStepServers(root, ["memory"]);
    expect(problems.map((p) => p.message).join("\n")).toContain(file);
    expect(problems.map((p) => p.message).join("\n")).not.toMatch(/there is no repository/);
  });
});

describe("landrace init's .gitignore check", () => {
  it("passes GIT_COMMON_DIR to git check-ignore", async () => {
    const root = await gitRepo();
    const calls = await gitsDuring(() => runInit(root, "triage"));
    expect(calls.filter((c) => c.includes("check-ignore"))).toEqual([expect.stringMatching(`^${realpathSync(join(root, ".git"))}\\|`)]);
  });

  it("refuses a planted commondir, naming it, before writing anything", async () => {
    const { root, file } = await planted();
    await expect(runInit(root, "triage")).rejects.toThrow(file);
    expect(existsSync(join(root, ".landrace"))).toBe(false);
  });
});

describe("landrace validate's .env check", () => {
  async function workspace(root: string): Promise<string> {
    const dir = await workspaceOf({ main: "tests/fixtures/minimal" }, join(root, ".landrace"));
    await writeFile(join(dir, ".env"), "GITHUB_TOKEN=ghp_x\n");
    return dir;
  }

  it("passes GIT_COMMON_DIR to git check-ignore", async () => {
    const root = await gitRepo();
    const dir = await workspace(root);
    const calls = await gitsDuring(() => runValidate(dir));
    expect(calls.filter((c) => c.includes("check-ignore"))).toEqual([expect.stringMatching(`^${realpathSync(join(root, ".git"))}\\|`)]);
  });

  it("reports a planted commondir, naming it, rather than reading it as not ignored", async () => {
    const root = await gitRepo();
    await mkdir(join(root, ".landrace"), { recursive: true });
    const dir = await workspace(root);
    const file = join(realpathSync(join(root, ".git")), "commondir");
    await writeFile(file, `${await scratch("lr-elsewhere-")}\n`);
    const { ok, problems } = await runValidate(dir);
    expect(ok).toBe(false);
    const secret = problems.filter((p) => p.rule === "secret").map((p) => p.message).join("\n");
    expect(secret).toContain(file);
    expect(secret).not.toMatch(/not gitignored/);
  });
});
