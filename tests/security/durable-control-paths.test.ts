import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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

  // Made empty when missing, so it is denied and nothing can be planted in it; an empty one sets
  // nothing with extensions.worktreeConfig on or off.
  it("has a missing config.worktree made empty, and denied rather than listed absent", async () => {
    const { root, path, common } = await setup();
    const file = join(common, "config.worktree");
    expect(existsSync(file)).toBe(false);
    const { deny, absent } = await gitControlPaths(path, root, "linux");
    expect(await readFile(file, "utf8")).toBe("");
    expect(deny).toContain(file);
    expect(absent).not.toContain(file);
  });

  // `git sparse-checkout disable`, which actions/checkout runs on every checkout, writes one.
  it("keeps a config.worktree that holds something as it is, and judges none of it", async () => {
    const { root, path, common } = await setup();
    const file = join(common, "config.worktree");
    const body = "[core]\n\tsparseCheckout = false\n";
    await writeFile(file, body);
    const { deny } = await gitControlPaths(path, root, "linux");
    expect(deny).toContain(file);
    expect(await readFile(file, "utf8")).toBe(body);
  });

  it("passes a repository left the way actions/checkout leaves it", async () => {
    const { root, path, common } = await setup();
    await git(root, "sparse-checkout", "disable");
    await git(root, "config", "--unset-all", "extensions.worktreeConfig");
    expect((await readFile(join(common, "config.worktree"), "utf8")).trim()).not.toBe("");
    await expect(gitControlPaths(path, root, "linux")).resolves.toBeDefined();
  });

  it.each(["hooks", "info", "config.worktree"])("refuses a write run when a missing %s cannot be made, naming it", async (name) => {
    const { root, path, common } = await setup();
    await rm(join(common, name), { recursive: true, force: true });
    // Every other one there already, so only this one is made.
    for (const other of ["hooks", "info"].filter((n) => n !== name)) await mkdir(join(common, other), { recursive: true });
    if (name !== "config.worktree") await writeFile(join(common, "config.worktree"), "");
    await chmod(common, 0o555);
    try {
      const refused = gitControlPaths(path, root, "linux");
      await expect(refused).rejects.toThrow(`${join(common, name)} is missing and could not be made`);
    } finally {
      await chmod(common, 0o755);
    }
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
      // An empty info is git's own for a moment, as it copies sparse-checkout in or deletes the folder.
      if (own === "info") await writeFile(join(admin, own, "attributes"), "* filter=x\n");
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

  // Git resolves `commondir` after following links (strbuf_realpath), so `../..` read as text names
  // the common directory while git, in a moved folder reached through a link, reads one the step built.
  it("reached through a link from <common>/worktrees is refused after the run, and again before the next", async () => {
    await judged(async (_admin, common) => {
      await mkdir(join(common, "evil"));
      await rename(join(common, "worktrees"), join(common, "evil", "worktrees"));
      await symlink(join(common, "evil", "worktrees"), join(common, "worktrees"));
      return join(common, "worktrees");
    });
  });

  it("that is itself a link is refused after the run, and again before the next", async () => {
    await judged(async (admin, common) => {
      await mkdir(join(common, "evil", "worktrees"), { recursive: true });
      const moved = join(common, "evil", "worktrees", basename(admin));
      await rename(admin, moved);
      await symlink(moved, admin);
      return admin;
    });
  });

  it("whose commondir reads ../.. but resolves, through a linked <common>/worktrees, elsewhere, names where git goes", async () => {
    const { common } = await setup();
    await mkdir(join(common, "evil"));
    await rename(join(common, "worktrees"), join(common, "evil", "worktrees"));
    await symlink(join(common, "evil", "worktrees"), join(common, "worktrees"));
    expect((await adminFolderProblems(common)).join("\n")).toContain(`names ${join(common, "evil")}, not ${common}`);
  });

  // `git worktree add` opens commondir with O_TRUNC before writing it, and another run's check can
  // land in between: git dies on an empty one, so nothing is trusted, and removing it breaks a
  // worktree that was valid.
  it("with an empty commondir, as git worktree add leaves it for a moment, passes", async () => {
    const { root, path, common } = await setup();
    const folder = join(common, "worktrees", "adding");
    await mkdir(folder);
    await writeFile(join(folder, "gitdir"), "/somewhere/wt/.git\n");
    await writeFile(join(folder, "commondir"), "");
    expect(await adminFolderProblems(common)).toEqual([]);
    await expect(gitControlPaths(path, root, "linux")).resolves.toBeDefined();
  });

  // `git worktree add` copies info/sparse-checkout into the folder with core.sparseCheckout on,
  // and per worktree git reads only that file from it.
  it("with git's own info/sparse-checkout passes, before and after a run", async () => {
    const { root, path, common, admin } = await setup();
    const controls = await gitControlPaths(path, root, "linux");
    expect(controls.absent).toContain(join(admin, "info"));
    await mkdir(join(admin, "info"));
    await writeFile(join(admin, "info", "sparse-checkout"), "/*\n");
    expect(await plantedControlPaths(controls)).toBeNull();
    expect(await adminFolderProblems(common)).toEqual([]);
    await expect(gitControlPaths(path, root, "linux")).resolves.toBeDefined();
  });

  it("made by git worktree add with core.sparseCheckout on passes", async () => {
    const { root, path, common } = await setup();
    await git(root, "config", "core.sparseCheckout", "true");
    await mkdir(join(common, "info"), { recursive: true });
    await writeFile(join(common, "info", "sparse-checkout"), "/*\n");
    const own = join(await scratch("lr-sparse-"), "wt");
    await git(root, "worktree", "add", "-q", "-b", "sparse", own);
    const admin = await adminOf(common, realpathSync(own));
    expect(await readdir(join(admin, "info"))).toEqual(["sparse-checkout"]);
    expect(await adminFolderProblems(common)).toEqual([]);
    await expect(gitControlPaths(path, root, "linux")).resolves.toBeDefined();
  });

  it("with an empty info, as git leaves one while adding or deleting the folder, passes", async () => {
    const { root, path, common, admin } = await setup();
    await mkdir(join(admin, "info"));
    expect(await adminFolderProblems(common)).toEqual([]);
    await expect(gitControlPaths(path, root, "linux")).resolves.toBeDefined();
  });

  it.each([
    ["anything else beside sparse-checkout", async (info: string) => {
      await writeFile(join(info, "sparse-checkout"), "/*\n");
      await writeFile(join(info, "attributes"), "* filter=x\n");
      return join(info, "attributes");
    }],
    ["a sparse-checkout that is a link", async (info: string) => {
      await symlink("/etc/hosts", join(info, "sparse-checkout"));
      return join(info, "sparse-checkout");
    }],
  ])("with an info holding %s is refused after the run, and again before the next", async (_what, put) => {
    await judged(async (admin) => {
      await mkdir(join(admin, "info"));
      return put(join(admin, "info"));
    });
  });
});

// Under `agent.isolation: none` a Linux step could rename the checkout's `.git` away and make it
// again, and bwrap's binds would move with the old one. A record of what was there lives in one
// run's memory; the refusal comes from the configuration, so it cannot be lost: `start` and
// `landrace mcp` refuse a configured `none`, and so does a run. Only a run told no isolation at all,
// the in-memory harness's, goes through.
describe("a write run with no worktree", () => {
  it("is refused on Linux only, saying to set agent.isolation: worktree", () => {
    expect(noneWriteRefusal("linux")).toMatch(/agent\.isolation: none[\s\S]*agent\.isolation: worktree/);
    expect(noneWriteRefusal("darwin")).toBeNull();
  });

  it("has its control paths listed on Linux, as on macOS", async () => {
    const { root } = await gitRepoWithOrigin();
    await expect(checkoutControlPaths([root], "linux")).resolves.toMatchObject({ commons: [realpathSync(join(root, ".git"))] });
    await expect(checkoutControlPaths([root], "darwin")).resolves.toMatchObject({ commons: [] });
  });
});
