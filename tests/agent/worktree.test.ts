import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  changedSince,
  ensureWorktree,
  removeWorktree,
  repositoryRoot,
  worktreeState,
} from "../../src/agent/worktree.js";

const run = promisify(execFile);

const roots: string[] = [];

/** A real repository with one commit, because every claim here is a claim about git. */
async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lr-wt-"));
  roots.push(dir);
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
