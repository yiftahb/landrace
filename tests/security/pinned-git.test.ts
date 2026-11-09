import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ensureWorktree } from "#agent/worktree.js";
import { runInit } from "#cli/init.js";
import { runValidate } from "#cli/validate.js";
import { resolveStepServers } from "#kit/executor.js";
import { CommonDirRefused, pinnedCommonDir, repositoryOf } from "#kit/git.js";
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
