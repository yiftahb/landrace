import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  changedSince,
  ensureWorktree,
  removeWorktree,
  repositoryRoot,
  worktreeState,
} from "#agent/worktree.js";

const run = promisify(execFile);

const roots: string[] = [];

/** A real repository with one commit, because every claim here is a claim about git. */
async function repo(at?: string): Promise<string> {
  const dir = at ?? (await mkdtemp(join(tmpdir(), "lr-wt-")));
  if (at === undefined) roots.push(dir);
  await mkdir(dir, { recursive: true });
  await run("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await run("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  await run("git", ["config", "user.name", "t"], { cwd: dir });
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "a.ts"), "export const a = 1;\n");
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

const worktrees = async (root: string): Promise<string[]> => {
  const { stdout } = await run("git", ["worktree", "list", "--porcelain"], { cwd: root });
  return stdout
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));
};

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

describe("worktree", () => {
  it("holds the committed tree", async () => {
    const root = await repo();
    const path = await ensureWorktree(1, root);
    expect(await readFile(join(path, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
    await removeWorktree(1, root);
  });

  it("is idempotent — asking twice returns the same path and adds one worktree", async () => {
    const root = await repo();
    expect(await ensureWorktree(2, root)).toBe(await ensureWorktree(2, root));
    // The repository's own checkout is the first entry, so one sandbox means two.
    expect(await worktrees(root)).toHaveLength(2);
    await removeWorktree(2, root);
  });

  /**
   * The isolation claim, asked the way it matters: the agent reads committed
   * state, so work in progress in the operator's own checkout is invisible to
   * it — and cannot be broken by it.
   */
  it("does not show the working tree's uncommitted changes", async () => {
    const root = await repo();
    await writeFile(join(root, "src", "dirty.ts"), "export const dirty = true;\n");
    const path = await ensureWorktree(3, root);
    expect(existsSync(join(path, "src", "dirty.ts"))).toBe(false);
    await removeWorktree(3, root);
  });

  it("keeps an agent's writes out of the operator's checkout, and drops them on removal", async () => {
    const root = await repo();
    const path = await ensureWorktree(4, root);
    await writeFile(join(path, "src", "a.ts"), "export const a = 666;\n");
    await writeFile(join(path, "planted.ts"), "export const planted = true;\n");

    expect(await readFile(join(root, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(existsSync(join(root, "planted.ts"))).toBe(false);

    await removeWorktree(4, root);
    expect(existsSync(path)).toBe(false);
    expect(await worktrees(root)).toHaveLength(1);
  });

  it("removes cleanly, and removing twice is not an error", async () => {
    const root = await repo();
    await ensureWorktree(5, root);
    await removeWorktree(5, root);
    await expect(removeWorktree(5, root)).resolves.toBeUndefined();
  });

  it("gives each ticket its own worktree", async () => {
    const root = await repo();
    expect(await ensureWorktree(6, root)).not.toBe(await ensureWorktree(7, root));
    await removeWorktree(6, root);
    await removeWorktree(7, root);
  });

  it("reuses — rather than fails on — a worktree a crashed run left behind", async () => {
    const root = await repo();
    const first = await ensureWorktree(8, root);
    await writeFile(join(first, "leftover.ts"), "export const leftover = 1;\n");
    expect(await ensureWorktree(8, root)).toBe(first);
    await removeWorktree(8, root);
  });

  it("reports the failure rather than throwing something unreadable outside a repository", async () => {
    const notARepo = await mkdtemp(join(tmpdir(), "lr-plain-"));
    roots.push(notARepo);
    await expect(ensureWorktree(9, notARepo)).rejects.toThrow(/not a git repository|could not create a worktree/i);
  });

  /**
   * Resolved at startup, not at the first invoke: a loop started outside a
   * repository would otherwise run happily and fail on its first paid step,
   * hours in, on a ticket it has already moved.
   */
  describe("repositoryRoot", () => {
    it("finds the repository a workflow directory sits in", async () => {
      const root = await repo();
      await mkdir(join(root, ".landrace", "steps"), { recursive: true });
      expect(await repositoryRoot(join(root, ".landrace"))).toBe(realpathSync(root));
    });

    it("says so, naming the directory, when there is no repository to isolate against", async () => {
      const plain = await mkdtemp(join(tmpdir(), "lr-plain-"));
      roots.push(plain);
      await expect(repositoryRoot(plain)).rejects.toThrow(new RegExp(plain.split("/").pop() as string));
    });
  });

  describe("worktreeState", () => {
    it("sees nothing changed in a fresh worktree", async () => {
      const root = await repo();
      const path = await ensureWorktree(10, root);
      expect(changedSince(await worktreeState(path), await worktreeState(path))).toEqual([]);
      await removeWorktree(10, root);
    });

    it("names a file the agent edited", async () => {
      const root = await repo();
      const path = await ensureWorktree(11, root);
      const before = await worktreeState(path);
      await writeFile(join(path, "src", "a.ts"), "export const a = 2;\n");
      expect(changedSince(before, await worktreeState(path)).join(" ")).toMatch(/src\/a\.ts/);
      await removeWorktree(11, root);
    });

    it("names a file the agent created, not just one it edited", async () => {
      const root = await repo();
      const path = await ensureWorktree(12, root);
      const before = await worktreeState(path);
      await writeFile(join(path, "planted.ts"), "export const planted = true;\n");
      expect(changedSince(before, await worktreeState(path)).join(" ")).toMatch(/planted\.ts/);
      await removeWorktree(12, root);
    });

    /**
     * A commit leaves `git status` clean, so a check that only read the status
     * would call the tidiest possible violation — write, add, commit — no
     * violation at all.
     */
    it("sees a commit, which leaves the status clean", async () => {
      const root = await repo();
      const path = await ensureWorktree(13, root);
      const before = await worktreeState(path);
      await writeFile(join(path, "src", "a.ts"), "export const a = 3;\n");
      await run("git", ["add", "-A"], { cwd: path });
      await run("git", ["commit", "-qm", "sneaky"], { cwd: path });

      const after = await worktreeState(path);
      expect(after.changes).toEqual([]);
      expect(changedSince(before, after).join(" ")).toMatch(/commit/i);
      await removeWorktree(13, root);
    });

    /**
     * A worktree a previous run left dirty is not this step's doing. Comparing
     * before with after, rather than asking "is it clean", is what keeps an
     * unrelated leftover from failing an innocent step forever.
     */
    it("ignores dirt that was already there before the step ran", async () => {
      const root = await repo();
      const path = await ensureWorktree(14, root);
      await writeFile(join(path, "leftover.ts"), "export const leftover = 1;\n");
      const before = await worktreeState(path);
      expect(changedSince(before, await worktreeState(path))).toEqual([]);
      await removeWorktree(14, root);
    });
  });
});

/**
 * Where a sandbox lives, and what is allowed to be deleted there.
 *
 * `rm -rf` on a path built from outside input is the highest-consequence line
 * in this codebase, and the path used to be keyed on `basename(repoRoot)`:
 * two checkouts called `widgets` resolved to one sandbox, and the second one
 * to start deleted the first one's worktree out from under a running agent.
 * That is the same defect fixed for the lock root in 9bad396, and the same
 * identity fixes it. These tests are that collision, and the bound on the
 * deletion itself, asked directly.
 */
describe("the sandbox path", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "lr-repos-"));
    roots.push(home);
  });

  /** A victim directory outside any sandbox, with something in it to lose. */
  async function victim(): Promise<string> {
    const dir = await mkdtemp(join(realpathSync(tmpdir()), "lr-victim-"));
    roots.push(dir);
    await writeFile(join(dir, "keep.txt"), "not yours to delete\n");
    return dir;
  }

  it("does not hand two repositories with the same directory name one sandbox", async () => {
    const mine = await repo(join(home, "mine", "widgets"));
    const theirs = await repo(join(home, "theirs", "widgets"));

    const ours = await ensureWorktree(30, mine);
    await writeFile(join(ours, "mid-run.ts"), "export const midRun = true;\n");

    // A different repository that happens to share a directory name, starting
    // its own #30: it found a directory registered to nobody it could see and
    // cleared it — the first repository's live worktree, mid-step.
    const alsoTheirs = await ensureWorktree(30, theirs);
    expect(alsoTheirs).not.toBe(ours);
    expect(existsSync(join(ours, "mid-run.ts"))).toBe(true);
    expect(await worktrees(mine)).toHaveLength(2);

    await removeWorktree(30, theirs);
    expect(existsSync(join(ours, "mid-run.ts"))).toBe(true);
    await removeWorktree(30, mine);
  });

  /**
   * The ticket is a number to TypeScript and a value out of a tracker hook at
   * runtime, which is not the same claim. Cast, because the guard being asked
   * about here is the one that has to hold when the type does not.
   */
  it("refuses a ticket whose path climbs out of the sandbox root", async () => {
    const root = await repo(join(home, "one", "widgets"));
    const outside = await victim();
    const climb = `../../../${basename(outside)}` as unknown as number;

    await expect(ensureWorktree(climb, root)).rejects.toThrow(/sandbox|outside|contain/i);
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);

    // The removal half runs on every exit path, including the ones already
    // unwinding from a failure, so it reports nothing — it simply must not
    // delete this.
    await removeWorktree(climb, root);
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
  });

  /**
   * The other way out: the path is an innocent `<root>/31`, and the root is
   * the link. Path arithmetic sees nothing wrong, which is exactly why both
   * ends are compared after realpath.
   */
  it("refuses a sandbox root that has been redirected out of its own tree", async () => {
    const root = await repo(join(home, "two", "widgets"));
    const outside = await victim();
    await mkdir(join(outside, "31"), { recursive: true });
    await writeFile(join(outside, "31", "keep.txt"), "not yours to delete\n");

    // The real root, learned from a real sandbox, then replaced by a link to
    // somewhere else — the residue a stray `ln -s` in $TMPDIR would leave.
    const first = await ensureWorktree(32, root);
    await removeWorktree(32, root);
    const sandboxRoot = dirname(first);
    await rm(sandboxRoot, { recursive: true, force: true });
    await symlink(outside, sandboxRoot);

    try {
      await expect(ensureWorktree(31, root)).rejects.toThrow(/sandbox|outside|resolve/i);
      expect(existsSync(join(outside, "31", "keep.txt"))).toBe(true);

      await removeWorktree(31, root);
      expect(existsSync(join(outside, "31", "keep.txt"))).toBe(true);
    } finally {
      await rm(sandboxRoot, { force: true });
    }
  });
});
