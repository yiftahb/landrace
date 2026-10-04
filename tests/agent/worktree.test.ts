import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  changedSince,
  copyProblems,
  ensureWorktree,
  keptSlot,
  prepareWorktree,
  removeWorktree,
  repositoryRoot,
  worktreeOf,
  worktreeState,
} from "#agent/worktree.js";
import type { WorktreeSetup } from "#namespace.js";

/*
 * Every test here starts real processes — git worktree operations, child
 * node — and on a machine whose endpoint-security agent inspects each exec,
 * starting one can take seconds when that agent is backed up. Measured: these
 * files ran 50-370 s in failing runs while most of their tests still passed,
 * which is slow, not hung. Jest's 5 s default turned that into failures that
 * looked like regressions. Sixty seconds still fails a real hang within a
 * minute; these tests normally take well under one.
 */
jest.setTimeout(60_000);

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
    const path = await ensureWorktree("1", root);
    expect(await readFile(join(path, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
    await removeWorktree("1", root);
  });

  it("is idempotent — asking twice returns the same path and adds one worktree", async () => {
    const root = await repo();
    expect(await ensureWorktree("2", root)).toBe(await ensureWorktree("2", root));
    // The repository's own checkout is the first entry, so one sandbox means two.
    expect(await worktrees(root)).toHaveLength(2);
    await removeWorktree("2", root);
  });

  /**
   * The isolation claim, asked the way it matters: the agent reads committed
   * state, so work in progress in the operator's own checkout is invisible to
   * it — and cannot be broken by it.
   */
  it("does not show the working tree's uncommitted changes", async () => {
    const root = await repo();
    await writeFile(join(root, "src", "dirty.ts"), "export const dirty = true;\n");
    const path = await ensureWorktree("3", root);
    expect(existsSync(join(path, "src", "dirty.ts"))).toBe(false);
    await removeWorktree("3", root);
  });

  it("keeps an agent's writes out of the operator's checkout, and drops them on removal", async () => {
    const root = await repo();
    const path = await ensureWorktree("4", root);
    await writeFile(join(path, "src", "a.ts"), "export const a = 666;\n");
    await writeFile(join(path, "planted.ts"), "export const planted = true;\n");

    expect(await readFile(join(root, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(existsSync(join(root, "planted.ts"))).toBe(false);

    await removeWorktree("4", root);
    expect(existsSync(path)).toBe(false);
    expect(await worktrees(root)).toHaveLength(1);
  });

  it("removes cleanly, and removing twice is not an error", async () => {
    const root = await repo();
    await ensureWorktree("5", root);
    await removeWorktree("5", root);
    await expect(removeWorktree("5", root)).resolves.toBeUndefined();
  });

  it("gives each item its own worktree", async () => {
    const root = await repo();
    expect(await ensureWorktree("6", root)).not.toBe(await ensureWorktree("7", root));
    await removeWorktree("6", root);
    await removeWorktree("7", root);
  });

  it("reuses — rather than fails on — a worktree a crashed run left behind", async () => {
    const root = await repo();
    const first = await ensureWorktree("8", root);
    await writeFile(join(first, "leftover.ts"), "export const leftover = 1;\n");
    expect(await ensureWorktree("8", root)).toBe(first);
    await removeWorktree("8", root);
  });

  it("reports the failure rather than throwing something unreadable outside a repository", async () => {
    const notARepo = await mkdtemp(join(tmpdir(), "lr-plain-"));
    roots.push(notARepo);
    await expect(ensureWorktree("9", notARepo)).rejects.toThrow(/not a git repository|could not create a worktree/i);
  });

  /**
   * Resolved at startup, not at the first invoke: a loop started outside a
   * repository would otherwise run happily and fail on its first paid step,
   * hours in, on an item it has already moved.
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
      const path = await ensureWorktree("10", root);
      expect(changedSince(await worktreeState(path), await worktreeState(path))).toEqual([]);
      await removeWorktree("10", root);
    });

    it("names a file the agent edited", async () => {
      const root = await repo();
      const path = await ensureWorktree("11", root);
      const before = await worktreeState(path);
      await writeFile(join(path, "src", "a.ts"), "export const a = 2;\n");
      expect(changedSince(before, await worktreeState(path)).join(" ")).toMatch(/src\/a\.ts/);
      await removeWorktree("11", root);
    });

    it("names a file the agent created, not just one it edited", async () => {
      const root = await repo();
      const path = await ensureWorktree("12", root);
      const before = await worktreeState(path);
      await writeFile(join(path, "planted.ts"), "export const planted = true;\n");
      expect(changedSince(before, await worktreeState(path)).join(" ")).toMatch(/planted\.ts/);
      await removeWorktree("12", root);
    });

    /**
     * A commit leaves `git status` clean, so a check that only read the status
     * would call the tidiest possible violation — write, add, commit — no
     * violation at all.
     */
    it("sees a commit, which leaves the status clean", async () => {
      const root = await repo();
      const path = await ensureWorktree("13", root);
      const before = await worktreeState(path);
      await writeFile(join(path, "src", "a.ts"), "export const a = 3;\n");
      await run("git", ["add", "-A"], { cwd: path });
      await run("git", ["commit", "-qm", "sneaky"], { cwd: path });

      const after = await worktreeState(path);
      expect(after.changes).toEqual([]);
      expect(changedSince(before, after).join(" ")).toMatch(/commit/i);
      await removeWorktree("13", root);
    });

    /**
     * A worktree a previous run left dirty is not this step's doing. Comparing
     * before with after, rather than asking "is it clean", is what keeps an
     * unrelated leftover from failing an innocent step forever.
     */
    it("ignores dirt that was already there before the step ran", async () => {
      const root = await repo();
      const path = await ensureWorktree("14", root);
      await writeFile(join(path, "leftover.ts"), "export const leftover = 1;\n");
      const before = await worktreeState(path);
      expect(changedSince(before, await worktreeState(path))).toEqual([]);
      await removeWorktree("14", root);
    });
  });
});

/**
 * The branch a stage names, and what a step finds checked out because of it.
 *
 * A build's commits used to be made on a detached HEAD inside a worktree that
 * was removed when converge unwound — unreferenced, and gone at the next gc.
 * A branch is what keeps them, and whether the step gets the branch itself or
 * only a look at it is decided by whether it may write.
 */
describe("a stage's branch", () => {
  const git = async (cwd: string, ...args: string[]): Promise<string> =>
    (await run("git", args, { cwd })).stdout.trim();
  /** The branch checked out at `path`, or null when its HEAD is detached. */
  const attached = async (path: string): Promise<string | null> =>
    run("git", ["symbolic-ref", "-q", "--short", "HEAD"], { cwd: path }).then((r) => r.stdout.trim(), () => null);
  const sha = (cwd: string, ref: string): Promise<string | null> =>
    run("git", ["rev-parse", "--verify", "-q", ref], { cwd }).then((r) => r.stdout.trim(), () => null);
  const commitIn = async (path: string, file: string): Promise<string> => {
    await writeFile(join(path, file), `export const x = ${JSON.stringify(file)};\n`);
    await git(path, "add", "-A");
    await git(path, "commit", "-qm", `add ${file}`);
    return git(path, "rev-parse", "HEAD");
  };

  it("gives a step that may write the branch itself, created at HEAD", async () => {
    const root = await repo();
    const path = await ensureWorktree("40", root, { branch: "landrace/40", write: true });

    expect(await attached(path)).toBe("landrace/40");
    expect(await sha(root, "refs/heads/landrace/40")).toBe(await sha(root, "HEAD"));
    await removeWorktree("40", root);
  });

  it("keeps what the step committed after the worktree is gone", async () => {
    const root = await repo();
    const path = await ensureWorktree("41", root, { branch: "landrace/41", write: true });
    const made = await commitIn(path, "built.ts");

    await removeWorktree("41", root);

    expect(existsSync(path)).toBe(false);
    expect(await sha(root, "refs/heads/landrace/41")).toBe(made);
    // And the operator's own checkout never moved.
    expect(await attached(root)).toBe("main");
    expect(existsSync(join(root, "built.ts"))).toBe(false);
  });

  it("continues the same branch on the next write, rather than starting again from HEAD", async () => {
    const root = await repo();
    const first = await ensureWorktree("42", root, { branch: "landrace/42", write: true });
    const made = await commitIn(first, "round1.ts");
    await removeWorktree("42", root);

    const again = await ensureWorktree("42", root, { branch: "landrace/42", write: true });

    expect(await attached(again)).toBe("landrace/42");
    expect(await sha(again, "HEAD")).toBe(made);
    expect(existsSync(join(again, "round1.ts"))).toBe(true);
    await removeWorktree("42", root);
  });

  /*
   * The reviewer reads the item's code, not main's — and reads it detached,
   * so a commit it should never have made cannot land on the branch the next
   * push publishes.
   */
  it("shows a read-only step the branch's commit, detached from the branch", async () => {
    const root = await repo();
    const built = await ensureWorktree("43", root, { branch: "landrace/43", write: true });
    const made = await commitIn(built, "built.ts");
    await removeWorktree("43", root);

    const path = await ensureWorktree("43", root, { branch: "landrace/43", write: false });

    expect(await attached(path)).toBeNull();
    expect(await sha(path, "HEAD")).toBe(made);
    expect(existsSync(join(path, "built.ts"))).toBe(true);
    await removeWorktree("43", root);
  });

  it("shows a read-only step HEAD before the branch exists, and creates no branch", async () => {
    const root = await repo();
    const path = await ensureWorktree("44", root, { branch: "landrace/44", write: false });

    expect(await attached(path)).toBeNull();
    expect(await sha(path, "HEAD")).toBe(await sha(root, "HEAD"));
    expect(await sha(root, "refs/heads/landrace/44")).toBeNull();
    await removeWorktree("44", root);
  });

  /*
   * One converge reuses one worktree across passes — triage reads, then build
   * writes. What the second step needs is not what the first one had, so the
   * worktree is rebuilt on what it needs rather than handed over as it was.
   */
  it("moves a worktree a read-only step had onto the branch when a writing step follows", async () => {
    const root = await repo();
    const read = await ensureWorktree("45", root, { branch: "landrace/45", write: false });
    const write = await ensureWorktree("45", root, { branch: "landrace/45", write: true });

    expect(write).toBe(read);
    expect(await attached(write)).toBe("landrace/45");
    expect(await worktrees(root)).toHaveLength(2);
    await removeWorktree("45", root);
  });

  it("detaches a worktree a writing step had when a read-only step follows, and keeps the branch", async () => {
    const root = await repo();
    const built = await ensureWorktree("46", root, { branch: "landrace/46", write: true });
    const made = await commitIn(built, "built.ts");
    // Left uncommitted: a worktree is disposable, and only a commit outlives it.
    await writeFile(join(built, "stray.ts"), "export const stray = 1;\n");

    const review = await ensureWorktree("46", root, { branch: "landrace/46", write: false });

    expect(await attached(review)).toBeNull();
    expect(await sha(review, "HEAD")).toBe(made);
    expect(existsSync(join(review, "stray.ts"))).toBe(false);
    expect(await sha(root, "refs/heads/landrace/46")).toBe(made);
    await removeWorktree("46", root);
  });

  /*
   * Reused for what git ignores — an install's `node_modules` — and only that:
   * what a previous step left uncommitted does not carry over, any more than
   * it does when the worktree is rebuilt.
   */
  it("reuses a worktree on the branch, keeping what git ignores and dropping what was left uncommitted", async () => {
    const root = await repo();
    await writeFile(join(root, ".gitignore"), "node_modules/\n");
    await git(root, "add", "-A");
    await git(root, "commit", "-qm", "ignore");
    const first = await ensureWorktree("47", root, { branch: "landrace/47", write: true });
    await mkdir(join(first, "node_modules"));
    await writeFile(join(first, "node_modules", "dep.js"), "1\n");
    await writeFile(join(first, "leftover.ts"), "export const leftover = 1;\n");
    await writeFile(join(first, "src", "a.ts"), "export const a = 2;\n");

    expect(await ensureWorktree("47", root, { branch: "landrace/47", write: true })).toBe(first);
    expect(existsSync(join(first, "node_modules", "dep.js"))).toBe(true);
    expect(existsSync(join(first, "leftover.ts"))).toBe(false);
    expect(await git(first, "status", "--porcelain")).toBe("");
    await removeWorktree("47", root);
  });

  it("takes the branch from the item's kept worktree when another of its slots needs it", async () => {
    const root = await repo();
    const kept = await ensureWorktree("52", root, { branch: "landrace/52", write: true }, keptSlot("52"));

    const paired = await ensureWorktree("52", root, { branch: "landrace/52", write: true }, "52.pair");

    expect(await attached(paired)).toBe("landrace/52");
    expect(existsSync(kept)).toBe(false);
    await removeWorktree("52", root, "52.pair");
  });

  /*
   * git lets a branch be checked out in one place at a time, and the other
   * place here is the operator's own checkout. Forcing it would pull the
   * branch out from under them; the step is refused instead, in a sentence
   * that says where it is checked out.
   */
  it("refuses, naming where, when the branch is checked out somewhere else", async () => {
    const root = await repo();
    await git(root, "checkout", "-q", "-b", "landrace/48");

    await expect(ensureWorktree("48", root, { branch: "landrace/48", write: true }))
      .rejects.toThrow(new RegExp(`landrace/48[\\s\\S]*checked out at ${realpathSync(root)}`));
    expect(await attached(root)).toBe("landrace/48");
    expect(await worktrees(root)).toHaveLength(1);
  });

  it("still lets a read-only step look at a branch checked out elsewhere", async () => {
    const root = await repo();
    await git(root, "checkout", "-q", "-b", "landrace/49");
    const path = await ensureWorktree("49", root, { branch: "landrace/49", write: false });
    expect(await sha(path, "HEAD")).toBe(await sha(root, "refs/heads/landrace/49"));
    await removeWorktree("49", root);
  });

  /* The stage that names no branch, exactly as before. */
  it("names no branch for a stage with none: detached at HEAD, and nothing created", async () => {
    const root = await repo();
    const path = await ensureWorktree("50", root);

    expect(await attached(path)).toBeNull();
    expect(await sha(path, "HEAD")).toBe(await sha(root, "HEAD"));
    expect(await git(root, "branch", "--format=%(refname:short)")).toBe("main");
    await removeWorktree("50", root);
  });

  /*
   * A step without a branch that follows one with a branch gets HEAD, not the
   * item's code: what the stage declared, rather than whatever the worktree
   * happened to be on.
   */
  it("detaches onto HEAD for a stage with no branch, after one that had a branch", async () => {
    const root = await repo();
    const built = await ensureWorktree("51", root, { branch: "landrace/51", write: true });
    await commitIn(built, "built.ts");

    const plain = await ensureWorktree("51", root);

    expect(await attached(plain)).toBeNull();
    expect(await sha(plain, "HEAD")).toBe(await sha(root, "HEAD"));
    expect(existsSync(join(plain, "built.ts"))).toBe(false);
    await removeWorktree("51", root);
  });
});

/*
 * A branch someone else moved on origin — a person's push, the forge's
 * "Update branch" — once the checkout has fetched it. The step starts from
 * that head, not the older one the local branch still names: a reviewer
 * sent back because the head moved must read the head that moved. Only ever
 * forward, and only a branch no other checkout holds: commits the local
 * branch has and origin does not are never dropped.
 */
describe("a branch origin has moved on", () => {
  const git = async (cwd: string, ...args: string[]): Promise<string> =>
    (await run("git", args, { cwd })).stdout.trim();
  const sha = (cwd: string, ref: string): Promise<string | null> =>
    run("git", ["rev-parse", "--verify", "-q", ref], { cwd }).then((r) => r.stdout.trim(), () => null);

  /** The operator's checkout with a bare origin, and the item's branch pushed to it once. */
  async function published(item: string): Promise<{ root: string; origin: string; branch: string; ours: string }> {
    const root = await repo();
    const origin = await mkdtemp(join(tmpdir(), "lr-wt-origin-"));
    roots.push(origin);
    await git(origin, "init", "-q", "--bare", "-b", "main");
    await git(root, "remote", "add", "origin", `file://${origin}`);
    await git(root, "push", "-q", "origin", "main");
    const branch = `landrace/${item}`;
    const built = await ensureWorktree(item, root, { branch, write: true });
    await writeFile(join(built, "built.ts"), "export const built = 1;\n");
    await git(built, "add", "-A");
    await git(built, "commit", "-qm", "build");
    await removeWorktree(item, root);
    await git(root, "push", "-q", "origin", branch);
    return { root, origin, branch, ours: (await sha(root, `refs/heads/${branch}`)) as string };
  }

  /** Someone else's commit on the branch, pushed to origin from a clone of their own; the checkout then fetches. */
  async function pushedElsewhere(origin: string, root: string, branch: string, file: string): Promise<string> {
    const theirs = await mkdtemp(join(tmpdir(), "lr-wt-theirs-"));
    roots.push(theirs);
    await run("git", ["clone", "-q", "--branch", branch, `file://${origin}`, theirs]);
    await git(theirs, "config", "user.email", "them@example.com");
    await git(theirs, "config", "user.name", "them");
    await writeFile(join(theirs, file), "export const theirs = 1;\n");
    await git(theirs, "add", "-A");
    await git(theirs, "commit", "-qm", `add ${file}`);
    await git(theirs, "push", "-q", "origin", branch);
    await git(root, "fetch", "-q", "origin");
    return git(theirs, "rev-parse", "HEAD");
  }

  it("shows a read-only step the head someone else pushed, and moves the branch forward to it", async () => {
    const { root, origin, branch } = await published("60");
    const pushed = await pushedElsewhere(origin, root, branch, "theirs.ts");

    const path = await ensureWorktree("60", root, { branch, write: false });

    expect(await sha(path, "HEAD")).toBe(pushed);
    expect(existsSync(join(path, "theirs.ts"))).toBe(true);
    expect(await sha(root, `refs/heads/${branch}`)).toBe(pushed);
    await removeWorktree("60", root);
  });

  it("gives a writing step the branch at that head, so what it commits goes on top", async () => {
    const { root, origin, branch } = await published("61");
    const pushed = await pushedElsewhere(origin, root, branch, "theirs.ts");

    const path = await ensureWorktree("61", root, { branch, write: true });

    expect(await sha(path, "HEAD")).toBe(pushed);
    expect(existsSync(join(path, "theirs.ts"))).toBe(true);
    await removeWorktree("61", root);
  });

  it("rebuilds a worktree a crashed run left on the older head", async () => {
    const { root, origin, branch, ours } = await published("62");
    const left = await ensureWorktree("62", root, { branch, write: true });
    expect(await sha(left, "HEAD")).toBe(ours);
    const pushed = await pushedElsewhere(origin, root, branch, "theirs.ts");

    const path = await ensureWorktree("62", root, { branch, write: true });

    expect(await sha(path, "HEAD")).toBe(pushed);
    expect(existsSync(join(path, "theirs.ts"))).toBe(true);
    expect(await git(path, "status", "--porcelain")).toBe("");
    await removeWorktree("62", root);
  });

  it("never moves a branch with commits origin does not have", async () => {
    const { root, origin, branch } = await published("63");
    await pushedElsewhere(origin, root, branch, "theirs.ts");
    const mine = await ensureWorktree("63", root, { branch, write: true });
    // Only the local branch has this one: the step's own, not yet pushed.
    await writeFile(join(mine, "mine.ts"), "export const mine = 1;\n");
    await git(mine, "add", "-A");
    await git(mine, "commit", "-qm", "mine");
    const local = await sha(mine, "HEAD");
    await removeWorktree("63", root);

    const path = await ensureWorktree("63", root, { branch, write: false });

    expect(await sha(root, `refs/heads/${branch}`)).toBe(local);
    expect(await sha(path, "HEAD")).toBe(local);
    expect(existsSync(join(path, "mine.ts"))).toBe(true);
    await removeWorktree("63", root);
  });

  it("leaves a branch another checkout holds where it is", async () => {
    const { root, origin, branch, ours } = await published("64");
    await pushedElsewhere(origin, root, branch, "theirs.ts");
    await git(root, "checkout", "-q", branch);

    const path = await ensureWorktree("64", root, { branch, write: false });

    expect(await sha(root, `refs/heads/${branch}`)).toBe(ours);
    expect(await sha(path, "HEAD")).toBe(ours);
    expect(await git(root, "status", "--porcelain")).toBe("");
    await removeWorktree("64", root);
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

    const ours = await ensureWorktree("30", mine);
    await writeFile(join(ours, "mid-run.ts"), "export const midRun = true;\n");

    // A different repository that happens to share a directory name, starting
    // its own #30: it found a directory registered to nobody it could see and
    // cleared it — the first repository's live worktree, mid-step.
    const alsoTheirs = await ensureWorktree("30", theirs);
    expect(alsoTheirs).not.toBe(ours);
    expect(existsSync(join(ours, "mid-run.ts"))).toBe(true);
    expect(await worktrees(mine)).toHaveLength(2);

    await removeWorktree("30", theirs);
    expect(existsSync(join(ours, "mid-run.ts"))).toBe(true);
    await removeWorktree("30", mine);
  });

  /**
   * `ensureWorktree` is handed an item id straight out of a tracker hook, and
   * this proves its own containment check holds even when nothing upstream —
   * `itemIdProblem` at the tick's own boundary — has screened the id first.
   */
  it("refuses an item whose path climbs out of the sandbox root", async () => {
    const root = await repo(join(home, "one", "widgets"));
    const outside = await victim();
    const climb = `../../../${basename(outside)}`;

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
    const first = await ensureWorktree("32", root);
    await removeWorktree("32", root);
    const sandboxRoot = dirname(first);
    await rm(sandboxRoot, { recursive: true, force: true });
    await symlink(outside, sandboxRoot);

    try {
      await expect(ensureWorktree("31", root)).rejects.toThrow(/sandbox|outside|resolve/i);
      expect(existsSync(join(outside, "31", "keep.txt"))).toBe(true);

      await removeWorktree("31", root);
      expect(existsSync(join(outside, "31", "keep.txt"))).toBe(true);
    } finally {
      await rm(sandboxRoot, { force: true });
    }
  });
});

/*
 * A pairing's worktree sits beside the item's own, in a slot of its own:
 * the tick and a conversation cut and remove `<item>` on every run, and a
 * person's session must not be deleted out from under them by either.
 */
describe("a worktree in its own slot", () => {
  it("lives beside the item's, and removing one leaves the other", async () => {
    const root = await repo();
    const mine = await ensureWorktree("5", root);
    const paired = await ensureWorktree("5", root, undefined, "5.pair");
    expect(basename(paired)).toBe("5.pair");
    expect(dirname(paired)).toBe(dirname(mine));

    await removeWorktree("5", root);
    expect(existsSync(mine)).toBe(false);
    expect(existsSync(paired)).toBe(true);
    await removeWorktree("5", root, "5.pair");
    expect(existsSync(paired)).toBe(false);
  });

  it("is found where it is registered, and not before it is cut", async () => {
    const root = await repo();
    expect(await worktreeOf("6.pair", root)).toBeNull();
    const paired = await ensureWorktree("6", root, undefined, "6.pair");
    expect(await worktreeOf("6.pair", root)).toBe(paired);
  });
});

/*
 * What a write step's worktree is given before its agent runs: the
 * operator's untracked files, copied in by glob, and the setup commands, run
 * outside the agent and its sandbox — once per worktree, and again only when
 * the lockfiles or the commands change.
 */
describe("preparing a write step's worktree", () => {
  const git = async (cwd: string, ...args: string[]): Promise<string> =>
    (await run("git", args, { cwd })).stdout.trim();

  /** A repository that ignores `.env`, with one `.env` and an untracked `pkg/.npmrc` in the operator's checkout. */
  async function project(): Promise<string> {
    const root = await repo();
    await writeFile(join(root, ".gitignore"), ".env\nnode_modules/\n");
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: 1\n");
    await git(root, "add", "-A");
    await git(root, "commit", "-qm", "project");
    await writeFile(join(root, ".env"), "TOKEN=from-env\n");
    await mkdir(join(root, "pkg"));
    await writeFile(join(root, "pkg", ".npmrc"), "//registry/:_authToken=t\n");
    return root;
  }

  const setup = (over: Partial<WorktreeSetup> = {}): WorktreeSetup => ({ copy: [], setup: [], timeoutMs: 60_000, ...over });

  async function prepared(item: string, root: string, s: WorktreeSetup, events: Array<[string, Record<string, unknown>]> = []) {
    const path = await ensureWorktree(item, root, { branch: `landrace/${item}`, write: true }, keptSlot(item));
    await prepareWorktree({ item, path, root, setup: s, log: (event, data = {}) => events.push([event, data]) });
    return path;
  }

  it("copies the ignored and untracked files the globs match, from anywhere in the repository", async () => {
    const root = await project();
    const path = await prepared("80", root, setup({ copy: ["**/.env", "**/.npmrc"] }));

    expect(await readFile(join(path, ".env"), "utf8")).toBe("TOKEN=from-env\n");
    expect(await readFile(join(path, "pkg", ".npmrc"), "utf8")).toBe("//registry/:_authToken=t\n");
    await removeWorktree("80", root, keptSlot("80"));
  });

  it("refuses a glob that matches a tracked file, naming the file", async () => {
    const root = await project();
    expect(await copyProblems(root, ["src/*.ts"])).toEqual([expect.stringMatching(/src\/a\.ts/)]);
    await expect(prepared("81", root, setup({ copy: ["src/*.ts"] }))).rejects.toThrow(/src\/a\.ts.*tracked/);
    await removeWorktree("81", root, keptSlot("81"));
  });

  it("refuses an absolute glob and one that climbs out of the repository", async () => {
    const root = await project();
    const problems = await copyProblems(root, ["/etc/hosts", "../x/.env", "ok/../../.env"]);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/\/etc\/hosts/);
    expect(problems[1]).toMatch(/\.\.\/x\/\.env/);
    expect(await copyProblems(root, ["**/.env"])).toEqual([]);
  });

  it("does not follow a link that leads outside the repository", async () => {
    const root = await project();
    const outside = await mkdtemp(join(tmpdir(), "lr-wt-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "key"), "secret\n");
    await symlink(join(outside, "key"), join(root, "leak.env"));
    await writeFile(join(root, "inside.env"), "fine\n");

    const path = await prepared("82", root, setup({ copy: ["*.env"] }));

    expect(existsSync(join(path, "leak.env"))).toBe(false);
    expect(await readFile(join(path, "inside.env"), "utf8")).toBe("fine\n");
    await removeWorktree("82", root, keptSlot("82"));
  });

  it("runs setup in the worktree, after the copy, without the engine's environment", async () => {
    const root = await project();
    process.env["LANDRACE_TEST_SECRET"] = "engine-only";
    try {
      const events: Array<[string, Record<string, unknown>]> = [];
      const path = await prepared("83", root, setup({
        copy: ["**/.env"],
        setup: ['printf "%s|%s" "$LANDRACE_TEST_SECRET" "$(cat .env)" > seen.txt'],
      }), events);

      expect(await readFile(join(path, "seen.txt"), "utf8")).toBe("|TOKEN=from-env");
      expect(events.map(([e]) => e)).toEqual(["worktree.setup.started", "worktree.setup.finished"]);
      expect(events[0]?.[1]).toMatchObject({ item: "83", command: expect.stringContaining("printf") });
      await removeWorktree("83", root, keptSlot("83"));
    } finally {
      delete process.env["LANDRACE_TEST_SECRET"];
    }
  });

  it("runs setup once while the lockfile is unchanged, and again when it changes or the worktree is rebuilt", async () => {
    const root = await project();
    const counter = join(await mkdtemp(join(tmpdir(), "lr-wt-count-")), "runs");
    roots.push(dirname(counter));
    const s = setup({ setup: [`echo run >> '${counter}'`] });
    const runs = async (): Promise<number> => (await readFile(counter, "utf8")).split("\n").filter(Boolean).length;

    const path = await prepared("84", root, s);
    await prepared("84", root, s);
    expect(await runs()).toBe(1);

    await writeFile(join(path, "pnpm-lock.yaml"), "lockfileVersion: 2\n");
    await git(path, "commit", "-qam", "bump");
    await prepared("84", root, s);
    expect(await runs()).toBe(2);

    await prepared("84", root, setup({ setup: [...s.setup, "true"] }));
    expect(await runs()).toBe(3);

    await removeWorktree("84", root, keptSlot("84"));
    await prepared("84", root, setup({ setup: [...s.setup, "true"] }));
    expect(await runs()).toBe(4);
    await removeWorktree("84", root, keptSlot("84"));
  });

  it("fails with the tail of the command's output, runs nothing after it, and runs it again next time", async () => {
    const root = await project();
    const events: Array<[string, Record<string, unknown>]> = [];
    const s = setup({ setup: ["echo first; echo 'ERR_PNPM_FETCH registry.example' >&2; exit 3", "touch after.txt"] });

    const path = await ensureWorktree("85", root, { branch: "landrace/85", write: true }, keptSlot("85"));
    await expect(prepareWorktree({ item: "85", path, root, setup: s, log: (event, data = {}) => events.push([event, data]) }))
      .rejects.toThrow(/exit[^\n]*3[\s\S]*ERR_PNPM_FETCH registry\.example/);
    expect(events.map(([e]) => e)).toEqual(["worktree.setup.started", "worktree.setup.failed"]);
    expect(existsSync(join(path, "after.txt"))).toBe(false);

    await expect(prepared("85", root, s)).rejects.toThrow(/ERR_PNPM_FETCH/);
    await removeWorktree("85", root, keptSlot("85"));
  });

  it("stops a command that outlasts setupTimeout, and says so", async () => {
    const root = await project();
    const started = Date.now();
    await expect(prepared("86", root, setup({ setup: ["echo waiting; sleep 30"], timeoutMs: 300 })))
      .rejects.toThrow(/timed out after 300ms[\s\S]*waiting/);
    expect(Date.now() - started).toBeLessThan(10_000);
    await removeWorktree("86", root, keptSlot("86"));
  });
});
