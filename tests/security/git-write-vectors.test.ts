import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { chmod, cp, link, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import {
  ensureWorktree, gitControlPaths, gitDirsOf, keptSlot, plantedControlPaths, prepareWorktree, releaseWorktree, removeWorktree, worktreeHead,
  worktreeIntact, worktreeState,
} from "#agent/worktree.js";
import { GIT_GUARD_ARGS } from "#conventions.js";
import { branchHeads, commonDirIntact, fetchBranch, gitIn, ownGit, pushBranch } from "#kit/git.js";
import { commitOn, gitRepoWithOrigin, removeRepos } from "#tests/support/repo.js";

/*
 * A step that may write shares the repository's git directory and writes its
 * worktree's `.git` file. Each way it could make git run its code is planted
 * here for real, proven armed by git run plainly, and then every entry point
 * the engine reaches git through is run and must leave no marker. A filter in
 * the repository's own config is not among them, nor a `commondir` in the
 * common directory, which hands git a config of the step's: a write step is
 * denied both files (`gitControlPaths`), and the engine overrides no `filter.*`.
 */

jest.setTimeout(180_000);

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", args, { cwd })).stdout.trim();

const made: string[] = [];
afterAll(async () => {
  while (made.length) await rm(made.pop() as string, { recursive: true, force: true });
  await removeRepos();
});

/** A scratch folder, a script in it that appends to `marker`, and a filter that does too and passes stdin through, as a filter must. */
async function trap(): Promise<{ dir: string; marker: string; script: string; filter: string }> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "lr-trap-")));
  made.push(dir);
  const marker = join(dir, "MARKER");
  const script = join(dir, "run.sh");
  // Reads nothing: git may hold an fsmonitor hook's stdin open.
  await writeFile(script, `#!/bin/sh\necho ran >> '${marker}'\n`);
  await chmod(script, 0o755);
  const filter = join(dir, "filter.sh");
  await writeFile(filter, `#!/bin/sh\necho ran >> '${marker}'\ncat\n`);
  await chmod(filter, 0o755);
  return { dir, marker, script, filter };
}

const HOOKS = ["post-checkout", "pre-commit", "post-commit", "reference-transaction", "pre-push", "post-merge", "post-index-change", "post-rewrite", "pre-auto-gc"];

async function hooksIn(dir: string, script: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const hook of HOOKS) {
    await writeFile(join(dir, hook), `#!/bin/sh\nexec '${script}'\n`);
    await chmod(join(dir, hook), 0o755);
  }
}

/** A git directory of the step's own: a copy of `from`, configured to run the script every way it can. */
async function evilCopy(from: string, at: string, { script, filter }: { script: string; filter: string }): Promise<string> {
  await cp(from, at, { recursive: true });
  await hooksIn(join(at, "hooks"), script);
  await mkdir(join(at, "info"), { recursive: true });
  await writeFile(join(at, "info", "attributes"), "* filter=trap\n");
  const config = await readFile(join(at, "config"), "utf8");
  await writeFile(join(at, "config"),
    `${config}[core]\n\tfsmonitor = ${script}\n\thooksPath = ${join(at, "hooks")}\n[filter "trap"]\n\tclean = ${filter}\n\tsmudge = ${filter}\n`);
  return at;
}

/** The repository's common directory and the step worktree's admin folder, as git itself names them. */
async function dirsOf(root: string, path: string): Promise<{ common: string; admin: string }> {
  const common = realpathSync(join(root, ".git"));
  for (const name of await readdir(join(common, "worktrees"))) {
    const gitdir = (await readFile(join(common, "worktrees", name, "gitdir"), "utf8")).trim();
    if (gitdir === join(path, ".git")) return { common, admin: join(common, "worktrees", name) };
  }
  throw new Error(`no admin folder names ${path}`);
}

type Vector = "hooks" | "hooksPath" | "fsmonitor" | "dotgit" | "commondir";

/** What the step plants, in the repository at `root` and its worktree at `path`. */
async function plant(vector: Vector, root: string, path: string, t: { dir: string; script: string; filter: string }): Promise<void> {
  const { common, admin } = await dirsOf(root, path);
  // Every tracked file's stat made stale, so a status re-reads it through whatever filter git
  // is given — first, since the git that lists them would run an fsmonitor planted before it.
  const now = new Date(Date.now() + 5_000);
  for (const file of (await git(root, "ls-files")).split("\n").filter(Boolean)) {
    if (existsSync(join(path, file))) await utimes(join(path, file), now, now);
  }
  if (vector === "hooks") await hooksIn(join(common, "hooks"), t.script);
  if (vector === "hooksPath") {
    await hooksIn(join(t.dir, "hooks"), t.script);
    await git(root, "config", "core.hooksPath", join(t.dir, "hooks"));
  }
  if (vector === "fsmonitor") await git(root, "config", "core.fsmonitor", t.script);
  if (vector === "dotgit") {
    const evil = await evilCopy(common, join(t.dir, `gitdir-${Date.now()}`), t);
    await writeFile(join(path, ".git"), `gitdir: ${evil}\n`);
  }
  if (vector === "commondir") {
    const evil = await evilCopy(common, join(t.dir, `common-${Date.now()}`), t);
    await writeFile(join(admin, "commondir"), `${evil}\n`);
  }
}

/** Undo what `plant` did, so the next entry point starts from a planted state of its own. */
async function unplant(vector: Vector, root: string, path: string): Promise<void> {
  const common = realpathSync(join(root, ".git"));
  if (vector === "hooks") for (const hook of HOOKS) await rm(join(common, "hooks", hook), { force: true });
  if (vector === "hooksPath") await git(root, "config", "--unset", "core.hooksPath");
  if (vector === "fsmonitor") await git(root, "config", "--unset", "core.fsmonitor");
  if (vector === "dotgit" || vector === "commondir") {
    for (const name of await readdir(join(common, "worktrees"))) {
      const folder = join(common, "worktrees", name);
      const gitdir = (await readFile(join(folder, "gitdir"), "utf8")).trim();
      if (gitdir !== join(path, ".git")) continue;
      if (vector === "dotgit" && existsSync(path)) await writeFile(join(path, ".git"), `gitdir: ${folder}\n`);
      if (vector === "commondir") await writeFile(join(folder, "commondir"), "../..\n");
    }
  }
}

const ran = (marker: string): boolean => existsSync(marker);

const VECTORS: Vector[] = ["hooks", "hooksPath", "fsmonitor", "dotgit", "commondir"];

describe.each(VECTORS)("a write step that planted %s", (vector) => {
  /** The operator's checkout, its origin, an item branch with a commit, and that item's kept write worktree. */
  async function setup(item: string): Promise<{ root: string; origin: string; path: string; branch: string }> {
    const { root, origin } = await gitRepoWithOrigin();
    const branch = `landrace/${item}`;
    await commitOn(root, branch, `${item}.ts`);
    const path = await ensureWorktree(item, root, { branch, write: true }, keptSlot(item));
    return { root, origin, path, branch };
  }

  it("is armed: git run plainly runs it", async () => {
    const t = await trap();
    const { root, path } = await setup("1");
    await plant(vector, root, path, t);
    // In the worktree for the step's own git directories, in the checkout for the repository's.
    const where = vector === "dotgit" || vector === "commondir" ? path : root;
    await exec("git", ["status"], { cwd: where }).catch(() => undefined);
    await exec("git", ["commit", "-q", "--allow-empty", "-m", "x"], { cwd: where }).catch(() => undefined);
    expect(ran(t.marker)).toBe(true);
  });

  if (vector === "dotgit" || vector === "commondir") {
    it("is armed even past the guard args: git that reads the worktree's own pointers runs its filter", async () => {
      const t = await trap();
      const { root, path } = await setup("2");
      await plant(vector, root, path, t);
      await exec("git", [...GIT_GUARD_ARGS, "status"], { cwd: path }).catch(() => undefined);
      expect(ran(t.marker)).toBe(true);
    });
  }

  it("runs none of it through any entry point the engine reaches git by", async () => {
    const t = await trap();
    const { root, origin, path, branch } = await setup("3");
    const signal = new AbortController().signal;
    const entries: Array<[string, () => Promise<unknown>]> = [
      ["ensureWorktree, reusing the kept slot", () => ensureWorktree("3", root, { branch, write: true }, keptSlot("3"))],
      ["worktreeHead", () => worktreeHead(path, root)],
      ["worktreeState", () => worktreeState(path, root)],
      ["prepareWorktree", () => prepareWorktree({
        item: "3", path, root, log: () => {}, signal,
        setup: { copy: [], setup: ["true"], timeoutMs: 30_000, lockfiles: ["*.ts"] },
      })],
      ["releaseWorktree", () => releaseWorktree("3", root)],
      // Released, so this attaches the kept slot to its branch again.
      ["ensureWorktree, attaching the released kept slot", () => ensureWorktree("3", root, { branch, write: true }, keptSlot("3"))],
      ["branchHeads", () => branchHeads(gitIn(root))],
      ["fetchBranch", () => fetchBranch(gitIn(root), `file://${origin}`, branch, signal, [])],
      ["pushBranch", () => pushBranch(gitIn(root), branch, "3", signal, [])],
    ];
    const fired: string[] = [];
    const refused: string[] = [];
    for (const [name, call] of entries) {
      await plant(vector, root, path, t);
      // prepareWorktree is about to run setup that git reads the worktree's own way, so it halts
      // on a worktree pointing at a git directory of the step's; nothing else may.
      if (name === "prepareWorktree") await call().catch(() => refused.push(name));
      else await call();
      if (ran(t.marker)) fired.push(name);
      await rm(t.marker, { force: true });
      await unplant(vector, root, path);
    }
    // Rebuilt: a slot at origin's default branch, asked for on the item's branch, is removed and added again.
    const rebuilt = await ensureWorktree("8", root);
    await plant(vector, root, rebuilt, t);
    await ensureWorktree("8", root, { branch, write: false });
    if (ran(t.marker)) fired.push("ensureWorktree, rebuilding");
    await rm(t.marker, { force: true });
    await unplant(vector, root, rebuilt);
    // And removed.
    const removing = await ensureWorktree("4", root);
    await plant(vector, root, removing, t);
    await removeWorktree("4", root);
    if (ran(t.marker)) fired.push("removeWorktree");
    expect(fired).toEqual([]);
    expect(refused).toEqual(vector === "dotgit" || vector === "commondir" ? ["prepareWorktree"] : []);
  });
});

describe("a write step that planted the common directory's own commondir", () => {
  // git reads `commondir` in any git directory, the main one too: written there, it hands every git
  // in the checkout — the operator's, and the engine's fetch, push and `worktree add` — a config of
  // the step's, past the guard args. Like the repository's `config`, the deny list alone closes it.
  it("is armed: git in the checkout follows it, and runs its code even with the guard args", async () => {
    const t = await trap();
    const { root } = await gitRepoWithOrigin();
    const common = realpathSync(join(root, ".git"));
    const evil = await evilCopy(common, join(t.dir, "common"), t);
    await writeFile(join(common, "commondir"), `${evil}\n`);
    expect(realpathSync(await git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"))).toBe(evil);
    // A changed file, so adding it runs the clean filter the planted config names.
    await writeFile(join(root, "src", "a.ts"), "export const a = 2;\n");
    await exec("git", [...GIT_GUARD_ARGS, "add", "-A"], { cwd: root }).catch(() => undefined);
    expect(ran(t.marker)).toBe(true);
  });

  it("is a path a write step may not write while absent on macOS, and one checked after the run on Linux", async () => {
    const { root } = await gitRepoWithOrigin();
    const path = await ensureWorktree("10", root);
    const common = realpathSync(join(root, ".git"));
    expect(existsSync(join(common, "commondir"))).toBe(false);
    expect((await gitControlPaths(path, root, "darwin")).deny).toContain(join(common, "commondir"));
    const linux = await gitControlPaths(path, root, "linux");
    expect(linux.deny).not.toContain(join(common, "commondir"));
    expect(linux.absent).toContain(join(common, "commondir"));
  });
});

describe("the admin folder the engine's git uses", () => {
  async function setup(): Promise<{ root: string; path: string; common: string; admin: string }> {
    const { root } = await gitRepoWithOrigin();
    const path = await ensureWorktree("5", root);
    return { root, path, ...(await dirsOf(root, path)) };
  }

  it("is the one that names the worktree, beside the repository's own common directory", async () => {
    const { root, path, common, admin } = await setup();
    expect(await gitDirsOf(path, root)).toEqual({ GIT_DIR: admin, GIT_COMMON_DIR: common, GIT_WORK_TREE: path });
  });

  it("is found again when a step renamed it away and made another naming the worktree, and its commondir is not read", async () => {
    const t = await trap();
    const { root, path, common, admin } = await setup();
    // The real one moved out of worktrees/, a new one made in its place, the .git file pointed at it.
    await rename(admin, join(common, "moved-away"));
    const evilCommon = await evilCopy(common, join(t.dir, "common"), t);
    const made = join(common, "worktrees", "planted");
    await cp(join(common, "moved-away"), made, { recursive: true });
    await writeFile(join(made, "commondir"), `${evilCommon}\n`);
    await writeFile(join(path, ".git"), `gitdir: ${made}\n`);

    const dirs = await gitDirsOf(path, root);
    expect(dirs.GIT_DIR).toBe(made);
    expect(dirs.GIT_COMMON_DIR).toBe(common);
    await worktreeState(path, root);
    expect(ran(t.marker)).toBe(false);
  });

  // `agent.worktree.setup` runs the operator's commands outside the sandbox, and any git they
  // start reads the worktree as git would — through its `.git` file and the admin folder's
  // `commondir`, never the directories the engine pinned. So the worktree is checked first.
  it.each(["renamed-in", "dotgit"] as const)(
    "refuses to run setup that starts git when the step left a %s git directory of its own",
    async (how) => {
      const t = await trap();
      const { root, path, common, admin } = await setup();
      const evilCommon = await evilCopy(common, join(t.dir, "common"), t);
      if (how === "renamed-in") {
        await rename(admin, join(common, "moved-away"));
        const planted = join(common, "worktrees", "planted");
        await cp(join(common, "moved-away"), planted, { recursive: true });
        await writeFile(join(planted, "commondir"), `${evilCommon}\n`);
        await writeFile(join(path, ".git"), `gitdir: ${planted}\n`);
      } else {
        await writeFile(join(path, ".git"), `gitdir: ${evilCommon}\n`);
      }
      // Armed: the same command, run as setup would run it, runs the step's code.
      await exec("sh", ["-c", "git status"], { cwd: path }).catch(() => undefined);
      expect(ran(t.marker)).toBe(true);
      await rm(t.marker, { force: true });

      await expect(prepareWorktree({
        item: "5", path, root, log: () => {},
        setup: { copy: [], setup: ["git status"], timeoutMs: 30_000, lockfiles: ["*.ts"] },
      })).rejects.toThrow(/refusing to hand out or run in/);
      expect(ran(t.marker)).toBe(false);
    },
  );

  it("runs setup that starts git in a worktree as git made it", async () => {
    const { root, path } = await setup();
    await expect(prepareWorktree({
      item: "5", path, root, log: () => {},
      setup: { copy: [], setup: ["git status"], timeoutMs: 30_000, lockfiles: ["*.ts"] },
    })).resolves.toBeUndefined();
  });

  it.each([
    ["an fsmonitor", "[core]\n\tfsmonitor = /bin/true\n"],
    ["a filter", "[filter \"x\"]\n\tclean = evil\n"],
  ])("halts when it holds a config.worktree setting %s, naming it", async (_what, body) => {
    const { root, path, admin } = await setup();
    await writeFile(join(admin, "config.worktree"), body);
    await expect(gitDirsOf(path, root)).rejects.toThrow(join(admin, "config.worktree"));
    await expect(worktreeState(path, root)).rejects.toThrow(/config\.worktree/);
  });

  // The stub a Linux sandbox leaves where it was told to deny a path that was not there: it sets nothing.
  it.each([["empty", ""], ["whitespace", " \n\t\n"]])("passes a config.worktree that is %s, which sets nothing", async (_what, body) => {
    const { root, path, admin } = await setup();
    await writeFile(join(admin, "config.worktree"), body);
    await expect(gitDirsOf(path, root)).resolves.toMatchObject({ GIT_DIR: admin });
    await expect(worktreeIntact(path, root)).resolves.toBeUndefined();
  });

  it("halts on an empty config.worktree with a second name, which a step can fill through it", async () => {
    const { root, path, common, admin } = await setup();
    await writeFile(join(common, "description"), "");
    await link(join(common, "description"), join(admin, "config.worktree"));
    await expect(gitDirsOf(path, root)).rejects.toThrow(join(admin, "config.worktree"));
  });

  it("halts when two admin folders name the worktree, naming both", async () => {
    const { root, path, common, admin } = await setup();
    const second = join(common, "worktrees", "second");
    await cp(admin, second, { recursive: true });
    const refused = gitDirsOf(path, root);
    await expect(refused).rejects.toThrow(admin);
    await expect(gitDirsOf(path, root)).rejects.toThrow(second);
  });

  it("halts when none names it", async () => {
    const { root, path, admin } = await setup();
    await writeFile(join(admin, "gitdir"), "/somewhere/else/.git\n");
    await expect(gitDirsOf(path, root)).rejects.toThrow(/no admin folder under .* names it/);
  });
});

// A step's sandbox reaches every admin folder under the git directory, those
// git makes while it runs too — another item's worktree, a turn's, a
// pairing's — and those are on no list it was handed. Landrace's git never
// reads their `commondir`; the person pairing in one, or an agent run there,
// runs git that does. So each worktree is checked before it is handed out or
// run in, the way git itself would read it.
describe("a worktree handed out or run in", () => {
  async function setup(): Promise<{ root: string; path: string; common: string; admin: string }> {
    const { root } = await gitRepoWithOrigin();
    const path = await ensureWorktree("8", root);
    return { root, path, ...(await dirsOf(root, path)) };
  }

  it("passes as git made it", async () => {
    const { root, path } = await setup();
    await expect(worktreeIntact(path, root)).resolves.toBeUndefined();
  });

  it("passes for a checkout whose .git is a directory", async () => {
    const { root } = await gitRepoWithOrigin();
    await expect(worktreeIntact(realpathSync(root), root)).resolves.toBeUndefined();
  });

  it("is armed: a person's own git there follows a commondir a step rewrote, and runs its code", async () => {
    const t = await trap();
    const { root, path, common, admin } = await setup();
    const evilCommon = await evilCopy(common, join(t.dir, "common"), t);
    await writeFile(join(admin, "commondir"), `${evilCommon}\n`);
    await exec("git", ["status"], { cwd: path }).catch(() => undefined);
    expect(ran(t.marker)).toBe(true);
    await expect(worktreeIntact(path, root)).rejects.toThrow(join(admin, "commondir"));
  });

  it("halts on a commondir naming another git directory, naming it and where it points", async () => {
    const { root, path, admin } = await setup();
    const elsewhere = await mkdtemp(join(tmpdir(), "lr-elsewhere-"));
    made.push(elsewhere);
    await writeFile(join(admin, "commondir"), `${elsewhere}\n`);
    const refused = worktreeIntact(path, root);
    await expect(refused).rejects.toThrow(join(admin, "commondir"));
    await expect(worktreeIntact(path, root)).rejects.toThrow(realpathSync(elsewhere));
  });

  it("halts on a commondir that names nothing", async () => {
    const { root, path, admin } = await setup();
    await writeFile(join(admin, "commondir"), "/no/such/dir\n");
    await expect(worktreeIntact(path, root)).rejects.toThrow(/commondir.*\/no\/such\/dir/);
  });

  it("halts on an admin folder with no commondir, which git would read as a repository of its own", async () => {
    const { root, path, admin } = await setup();
    await rm(join(admin, "commondir"));
    await expect(worktreeIntact(path, root)).rejects.toThrow(`${join(admin, "commondir")} is missing`);
  });

  it.each(["config", "hooks", "info"])("halts on an admin folder holding %s, naming it", async (file) => {
    const { root, path, admin } = await setup();
    if (file === "config") await writeFile(join(admin, file), "[core]\n\tfsmonitor = /bin/true\n");
    else await mkdir(join(admin, file));
    await expect(worktreeIntact(path, root)).rejects.toThrow(`${join(admin, file)} exists`);
  });

  it("keeps the admin folder lookup's config.worktree halt", async () => {
    const { root, path, admin } = await setup();
    await writeFile(join(admin, "config.worktree"), "[filter \"x\"]\n\tclean = evil\n");
    await expect(worktreeIntact(path, root)).rejects.toThrow(join(admin, "config.worktree"));
  });

  it("halts on a .git file pointing anywhere but the admin folder that names it", async () => {
    const t = await trap();
    const { root, path, common } = await setup();
    const evil = await evilCopy(common, join(t.dir, "gitdir"), t);
    await writeFile(join(path, ".git"), `gitdir: ${evil}\n`);
    await expect(worktreeIntact(path, root)).rejects.toThrow(`${join(path, ".git")} points at ${evil}`);
  });

  it("accepts a relative .git file naming its admin folder", async () => {
    const { root, path, admin } = await setup();
    await writeFile(join(path, ".git"), `gitdir: ${relative(path, admin)}\n`);
    await expect(worktreeIntact(path, root)).resolves.toBeUndefined();
  });

  it("accepts the relative commondir git writes, and an absolute one naming the same directory", async () => {
    const { root, path, common, admin } = await setup();
    expect((await readFile(join(admin, "commondir"), "utf8")).trim()).toBe("../..");
    await writeFile(join(admin, "commondir"), `${common}\n`);
    await expect(worktreeIntact(path, root)).resolves.toBeUndefined();
  });
});

describe("gitControlPaths", () => {
  it("lists the repository's config, hooks and info, each admin folder's control files and the .git file — absent ones too — on macOS", async () => {
    const { root } = await gitRepoWithOrigin();
    const path = await ensureWorktree("6", root);
    const other = await ensureWorktree("7", root);
    const common = realpathSync(join(root, ".git"));
    const admins = (await readdir(join(common, "worktrees"))).sort();
    expect(admins).toHaveLength(2);

    const { deny, absent } = await gitControlPaths(path, root, "darwin");

    const all = [
      join(common, "config"), join(common, "config.worktree"), join(common, "commondir"), join(common, "hooks"), join(common, "info"),
      ...admins.flatMap((n) =>
        ["config", "config.worktree", "commondir", "gitdir", "hooks", "info"].map((f) => join(common, "worktrees", n, f))),
      join(path, ".git"),
    ];
    expect(deny).toEqual(all);
    expect(absent).toEqual(all.filter((p) => !existsSync(p)));
    expect(absent).toEqual(expect.arrayContaining([join(common, "config.worktree"), join(common, "commondir")]));
    // An admin folder git made has no config or hooks of its own: listed absent, since a step
    // that recreated the folder without `commondir` would have git read them as a repository's.
    expect(absent).toContain(join(common, "worktrees", admins[0] ?? "", "config"));
    expect(deny).not.toContain(join(other, ".git"));
  });

  // bwrap makes each missing path it is told to deny, as an empty file git then reads: an empty
  // `<common>/commondir` stopped every git in the checkout, and no Linux write step finished.
  it("denies only the paths that exist on Linux, and lists the rest as absent", async () => {
    const { root } = await gitRepoWithOrigin();
    const path = await ensureWorktree("6", root);
    const { deny, absent } = await gitControlPaths(path, root, "linux");
    expect(deny.length).toBeGreaterThan(0);
    expect(deny.every((p) => existsSync(p))).toBe(true);
    expect(absent.length).toBeGreaterThan(0);
    expect(absent.every((p) => !existsSync(p))).toBe(true);
    expect(new Set([...deny, ...absent])).toEqual(new Set((await gitControlPaths(path, root, "darwin")).deny));
  });

  // A sandbox denies by path: a control file with a second name is written through that one.
  it.each(["linux", "darwin"] as const)("refuses a write run on %s while a control file has more than one link, naming it", async (platform) => {
    const { root } = await gitRepoWithOrigin();
    const path = await ensureWorktree("6", root);
    const common = realpathSync(join(root, ".git"));
    const linked = join(common, "config.worktree");
    await writeFile(join(common, "description"), "");
    await link(join(common, "description"), linked);
    await expect(gitControlPaths(path, root, platform)).rejects.toThrow(linked);
    await expect(gitControlPaths(path, root, platform)).rejects.toThrow(/more than one link/);
    await rm(linked);
    await expect(gitControlPaths(path, root, platform)).resolves.toBeDefined();
  });

  it("lists no .git file for a checkout whose .git is a directory", async () => {
    const { root } = await gitRepoWithOrigin();
    const common = realpathSync(join(root, ".git"));
    expect((await gitControlPaths(realpathSync(root), root, "darwin")).deny).toEqual(
      ["config", "config.worktree", "commondir", "hooks", "info"].map((f) => join(common, f)));
  });

  // With the extension on git reads every admin folder's config.worktree, those made while the step
  // runs too, and a Linux sandbox cannot keep a step from making one: so no write run starts.
  describe("on Linux, with extensions.worktreeConfig", () => {
    it.each(["true", "yes", "on", "1"])("refuses a write run when it is %s, naming the setting and saying to turn it off", async (value) => {
      const { root } = await gitRepoWithOrigin();
      const path = await ensureWorktree("6", root);
      await git(root, "config", "extensions.worktreeConfig", value);
      await expect(gitControlPaths(path, root, "linux")).rejects.toThrow(/extensions\.worktreeConfig.*turn it off/);
      // macOS denies every control path, absent or not, so the setting is the operator's own there.
      await expect(gitControlPaths(path, root, "darwin")).resolves.toBeDefined();
    });

    it("refuses it set through an included file too", async () => {
      const { root } = await gitRepoWithOrigin();
      const path = await ensureWorktree("6", root);
      const common = realpathSync(join(root, ".git"));
      await writeFile(join(common, "extra"), "[extensions]\n\tworktreeConfig = true\n");
      await git(root, "config", "include.path", "extra");
      await expect(gitControlPaths(path, root, "linux")).rejects.toThrow(/extensions\.worktreeConfig/);
    });

    it("passes it off or unset", async () => {
      const { root } = await gitRepoWithOrigin();
      const path = await ensureWorktree("6", root);
      await expect(gitControlPaths(path, root, "linux")).resolves.toBeDefined();
      await git(root, "config", "extensions.worktreeConfig", "false");
      await expect(gitControlPaths(path, root, "linux")).resolves.toBeDefined();
    });

    it("refuses when the repository's config cannot be read", async () => {
      const { root } = await gitRepoWithOrigin();
      const path = await ensureWorktree("6", root);
      const config = join(realpathSync(join(root, ".git")), "config");
      await chmod(config, 0o000);
      try {
        await expect(gitControlPaths(path, root, "linux")).rejects.toThrow(/extensions\.worktreeConfig/);
      } finally {
        await chmod(config, 0o644);
      }
    });

    it("refuses a value git cannot read as a boolean", async () => {
      const { root } = await gitRepoWithOrigin();
      const path = await ensureWorktree("6", root);
      await git(root, "config", "extensions.worktreeConfig", "maybe");
      await expect(gitControlPaths(path, root, "linux")).rejects.toThrow(/extensions\.worktreeConfig/);
    });
  });
});

describe("an empty config.worktree in the common directory", () => {
  it("breaks neither the engine's git nor the operator's git status", async () => {
    const { root } = await gitRepoWithOrigin();
    await writeFile(join(realpathSync(join(root, ".git")), "config.worktree"), "");
    await expect(git(root, "status", "--short")).resolves.toBe("");
    const path = await ensureWorktree("11", root, { branch: "landrace/11", write: true }, keptSlot("11"));
    await expect(worktreeState(path, root)).resolves.toMatchObject({ changes: [] });
    await expect(branchHeads(ownGit(async () => root))).resolves.toMatchObject({ local: { "landrace/11": expect.any(String) } });
  });
});

describe("plantedControlPaths", () => {
  async function setup(): Promise<{ root: string; path: string; common: string; admin: string; absent: string[] }> {
    const { root } = await gitRepoWithOrigin();
    const path = await ensureWorktree("12", root);
    const { absent } = await gitControlPaths(path, root, "linux");
    return { root, path, absent, ...(await dirsOf(root, path)) };
  }

  it("passes when nothing absent was made", async () => {
    const { absent } = await setup();
    await expect(plantedControlPaths(absent)).resolves.toBeNull();
  });

  it.each([
    ["an empty file", async (p: string) => writeFile(p, "")],
    ["a whitespace-only file", async (p: string) => writeFile(p, "  \n")],
    ["an empty folder", async (p: string) => mkdir(p)],
  ])("passes %s, which is what a Linux sandbox leaves and sets nothing", async (_what, make) => {
    const { admin, absent } = await setup();
    await make(join(admin, "config.worktree"));
    await expect(plantedControlPaths(absent)).resolves.toBeNull();
  });

  // Every engine git refuses a `<common>/commondir` that exists at all
  // (`commonDirIntact`), so one left empty is judged here, where it is
  // recorded, rather than at the next snapshot, where it fails unrecorded.
  it.each([
    ["an empty file", async (p: string) => writeFile(p, "")],
    ["a whitespace-only file", async (p: string) => writeFile(p, "  \n")],
    ["an empty folder", async (p: string) => mkdir(p)],
  ])("refuses %s at <common>/commondir, which stops every engine git", async (_what, make) => {
    const { common, absent } = await setup();
    const planted = join(common, "commondir");
    expect(absent).toContain(planted);
    await make(planted);
    expect(() => commonDirIntact(common)).toThrow(planted);
    const reason = await plantedControlPaths(absent);
    expect(reason).toContain(planted);
    expect(reason).toMatch(/a step that may write could have put it there/);
  });

  it.each([
    ["<common>/commondir naming another directory", (c: string) => join(c, "commondir"), async (p: string) => writeFile(p, "/elsewhere\n")],
    ["an admin config setting hooksPath", (_c: string, a: string) => join(a, "config"), async (p: string) => writeFile(p, "[core]\n\thooksPath = x\n")],
    ["a non-empty info folder", (_c: string, a: string) => join(a, "info"), async (p: string) => {
      await mkdir(p);
      await writeFile(join(p, "attributes"), "* filter=x\n");
    }],
    ["a symlink", (_c: string, a: string) => join(a, "hooks"), async (p: string) => symlink("/nowhere", p)],
    ["an admin config.worktree setting a filter", (_c: string, a: string) => join(a, "config.worktree"),
      async (p: string) => writeFile(p, "[filter \"x\"]\n\tclean = evil\n")],
  ])("refuses %s, naming it", async (_what, where: (c: string, a: string) => string, make) => {
    const { common, admin, absent } = await setup();
    const planted = where(common, admin);
    expect(absent).toContain(planted);
    await make(planted);
    const reason = await plantedControlPaths(absent);
    expect(reason).toContain(planted);
    expect(reason).toMatch(/a step that may write could have put it there/);
  });

  // A hard link to a file the step may still write, such as `<common>/description`: empty when
  // judged, bound read-only by path from the next run on, and filled through its other name.
  it.each([
    ["<common>/config.worktree", (c: string) => join(c, "config.worktree")],
    ["an admin config.worktree", (_c: string, a: string) => join(a, "config.worktree")],
    ["an admin config", (_c: string, a: string) => join(a, "config")],
  ])("refuses an empty hard link at %s, which another name can fill", async (_what, where: (c: string, a: string) => string) => {
    const { common, admin, absent } = await setup();
    const planted = where(common, admin);
    expect(absent).toContain(planted);
    await writeFile(join(common, "description"), "");
    await link(join(common, "description"), planted);
    const reason = await plantedControlPaths(absent);
    expect(reason).toContain(planted);
    expect(reason).toMatch(/a step that may write could have put it there/);
  });

  // Read whole, a multi-gigabyte file would exhaust the engine's memory before the refusal is recorded.
  it("refuses a file over 4 KiB without reading it, and reads one of exactly 4 KiB", async () => {
    const { admin, absent } = await setup();
    const planted = join(admin, "config.worktree");
    await writeFile(planted, " ".repeat(4096));
    await expect(plantedControlPaths(absent)).resolves.toBeNull();
    await writeFile(planted, " ".repeat(4097));
    expect(await plantedControlPaths(absent)).toContain(planted);
  });

  it("refuses a FIFO without opening it to read", async () => {
    const { admin, absent } = await setup();
    const planted = join(admin, "config.worktree");
    await exec("mkfifo", [planted]);
    expect(await plantedControlPaths(absent)).toContain(planted);
  });

  it("refuses a path it cannot read, naming it", async () => {
    const { admin, absent } = await setup();
    const planted = join(admin, "info");
    await mkdir(planted);
    await chmod(planted, 0o000);
    try {
      const reason = await plantedControlPaths(absent);
      expect(reason).toContain(planted);
      expect(reason).toMatch(/could not be read/);
    } finally {
      await chmod(planted, 0o755);
    }
  });
});
