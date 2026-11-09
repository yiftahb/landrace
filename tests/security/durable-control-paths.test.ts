import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  adminFolderProblems, checkoutControlPaths, ensureWorktree, gitControlPaths, noneWriteRefusal, plantedControlPaths,
} from "#agent/worktree.js";
import { gitRepoWithOrigin, removeRepos } from "#tests/support/repo.js";

/*
 * A refusal record was once the only trace of a path a Linux write run
 * planted: lost, the next run listed the path as existing, denied it, and
 * never judged it again. So on Linux what a lost record would hide is judged
 * again from the repository itself, before each write run. Every platform
 * here is passed in, so no Linux machine is needed.
 */

jest.setTimeout(60_000);

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", args, { cwd })).stdout.trim();

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

/** The admin folder under `<common>/worktrees` whose `gitdir` names `path`, as git wrote it. */
async function adminOf(common: string, path: string): Promise<string> {
  for (const name of await readdir(join(common, "worktrees"))) {
    const gitdir = (await readFile(join(common, "worktrees", name, "gitdir"), "utf8")).trim();
    if (gitdir === join(path, ".git")) return join(common, "worktrees", name);
  }
  throw new Error(`no admin folder names ${path}`);
}

async function setup(): Promise<{ root: string; path: string; common: string; admin: string }> {
  const { root } = await gitRepoWithOrigin();
  const path = await ensureWorktree("13", root);
  const common = realpathSync(join(root, ".git"));
  return { root, path, common, admin: await adminOf(common, path) };
}

const PLANTED = /a step that may write could have put it there[^.]*\. Remove it and the item carries on/;

describe("on Linux, the common directory", () => {
  it("has a missing hooks and info made empty, and denied rather than listed absent", async () => {
    const { root, path, common } = await setup();
    await rm(join(common, "hooks"), { recursive: true, force: true });
    await rm(join(common, "info"), { recursive: true, force: true });
    const { deny, absent } = await gitControlPaths(path, root, "linux");
    for (const folder of ["hooks", "info"]) {
      expect(await readdir(join(common, folder))).toEqual([]);
      expect(deny).toContain(join(common, folder));
      expect(absent).not.toContain(join(common, folder));
    }
  });

  it("keeps the operator's own hooks as they are, and judges none of them", async () => {
    const { root, path, common } = await setup();
    await writeFile(join(common, "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n");
    const { deny } = await gitControlPaths(path, root, "linux");
    expect(deny).toContain(join(common, "hooks"));
    expect(await readFile(join(common, "hooks", "pre-commit"), "utf8")).toBe("#!/bin/sh\nexit 0\n");
  });

  it("is where the admin folders are judged after the run", async () => {
    const { root, path, common } = await setup();
    expect((await gitControlPaths(path, root, "linux")).commons).toEqual([common]);
  });

  it("refuses a write run while its config.worktree holds something, with no record of it, naming it", async () => {
    const { root, path, common } = await setup();
    const file = join(common, "config.worktree");
    await writeFile(file, "[core]\n\tfsmonitor = /bin/true\n");
    const refused = gitControlPaths(path, root, "linux");
    await expect(refused).rejects.toThrow(file);
    await expect(gitControlPaths(path, root, "linux")).rejects.toThrow(PLANTED);
    // What a Linux sandbox leaves where it denied a path that was not there: it sets nothing.
    await writeFile(file, "");
    await expect(gitControlPaths(path, root, "linux")).resolves.toBeDefined();
  });

  it("refuses a write run while its config is missing, which git init always makes", async () => {
    const { root, path, common } = await setup();
    const config = join(common, "config");
    await rename(config, join(common, "config.kept"));
    try {
      await expect(gitControlPaths(path, root, "linux")).rejects.toThrow(`${config} is missing`);
    } finally {
      await rename(join(common, "config.kept"), config);
    }
    await expect(gitControlPaths(path, root, "linux")).resolves.toBeDefined();
  });
});

describe("on macOS, the listing", () => {
  it("is unchanged: nothing is made, nothing is judged up front, and no admin folder after", async () => {
    const { root, path, common } = await setup();
    await rm(join(common, "hooks"), { recursive: true, force: true });
    await writeFile(join(common, "config.worktree"), "[core]\n\tfsmonitor = /bin/true\n");
    const { deny, absent, commons } = await gitControlPaths(path, root, "darwin");
    expect(existsSync(join(common, "hooks"))).toBe(false);
    expect(deny).toContain(join(common, "hooks"));
    expect(absent).toContain(join(common, "hooks"));
    expect(commons).toEqual([]);
  });
});

describe("on Linux, an admin folder", () => {
  /** A run: listed, then what the step did, judged after it — and before the next run, with the record of it lost. */
  async function judged(make: (admin: string, common: string) => Promise<string>): Promise<void> {
    const { root, path, common, admin } = await setup();
    const controls = await gitControlPaths(path, root, "linux");
    const at = await make(admin, common);
    const after = await plantedControlPaths(controls);
    expect(after).toContain(at);
    expect(after).toMatch(PLANTED);
    expect((await adminFolderProblems(common)).join("\n")).toContain(at);
    const before = gitControlPaths(path, root, "linux");
    await expect(before).rejects.toThrow(at);
    await expect(gitControlPaths(path, root, "linux")).rejects.toThrow(PLANTED);
  }

  it("rebuilt with its commondir pointing elsewhere is refused after the run, and again before the next", async () => {
    const elsewhere = await scratch("lr-elsewhere-");
    await judged(async (admin, common) => {
      await rename(admin, join(common, "moved-away"));
      await cp(join(common, "moved-away"), admin, { recursive: true });
      await writeFile(join(admin, "commondir"), `${elsewhere}\n`);
      return join(admin, "commondir");
    });
  });

  it.each(["config", "hooks", "info"])("holding %s is refused after the run, and again before the next", async (own) => {
    await judged(async (admin) => {
      if (own === "config") await writeFile(join(admin, own), "[core]\n\thooksPath = x\n");
      else await mkdir(join(admin, own));
      return join(admin, own);
    });
  });

  it("holding a config.worktree with something in it is refused after the run, and again before the next", async () => {
    await judged(async (admin) => {
      await writeFile(join(admin, "config.worktree"), "[filter \"x\"]\n\tclean = evil\n");
      return join(admin, "config.worktree");
    });
  });

  it("of the operator's own linked worktree is judged too", async () => {
    const { root, path, common } = await setup();
    const own = join(await scratch("lr-own-"), "wt");
    await git(root, "worktree", "add", "-q", "-b", "own", own);
    const admin = await adminOf(common, realpathSync(own));
    await mkdir(join(admin, "hooks"));
    await expect(gitControlPaths(path, root, "linux")).rejects.toThrow(join(admin, "hooks"));
  });

  it.each([
    ["nothing in it yet", async () => undefined],
    ["its gitdir but no commondir yet", async (folder: string) => writeFile(join(folder, "gitdir"), "/somewhere/wt/.git\n")],
  ])("being made by git worktree add, with %s, passes", async (_what, before) => {
    const { root, path, common } = await setup();
    const folder = join(common, "worktrees", "adding");
    await mkdir(folder);
    await before(folder);
    expect(await adminFolderProblems(common)).toEqual([]);
    await expect(gitControlPaths(path, root, "linux")).resolves.toBeDefined();
  });

  it("as git made it, with the relative commondir it writes, passes", async () => {
    const { common, admin } = await setup();
    expect((await readFile(join(admin, "commondir"), "utf8")).trim()).toBe("../..");
    expect(await adminFolderProblems(common)).toEqual([]);
  });
});

// Under `agent.isolation: none` a Linux step could rename the checkout's `.git` away and make it
// again, and bwrap's binds would move with the old one. A record of what was there lives in one
// run's memory; the refusal comes from the configuration, and cannot be lost.
describe("a write run with no worktree", () => {
  it("is refused on Linux, saying to set agent.isolation: worktree", async () => {
    const { root } = await gitRepoWithOrigin();
    const reason = noneWriteRefusal("linux");
    expect(reason).toMatch(/agent\.isolation: none[\s\S]*agent\.isolation: worktree/);
    await expect(checkoutControlPaths([root], "linux")).rejects.toThrow(reason ?? "a reason");
  });

  it("runs on macOS", async () => {
    const { root } = await gitRepoWithOrigin();
    expect(noneWriteRefusal("darwin")).toBeNull();
    await expect(checkoutControlPaths([root], "darwin")).resolves.toMatchObject({ commons: [] });
  });
});
