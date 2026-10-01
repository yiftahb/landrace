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
  worktreeOf,
  worktreeState,
} from "#agent/worktree.js";

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

  it("reuses a worktree that is already on what the step needs, as it stands", async () => {
    const root = await repo();
    const first = await ensureWorktree("47", root, { branch: "landrace/47", write: true });
    await writeFile(join(first, "leftover.ts"), "export const leftover = 1;\n");

    expect(await ensureWorktree("47", root, { branch: "landrace/47", write: true })).toBe(first);
    expect(existsSync(join(first, "leftover.ts"))).toBe(true);
    await removeWorktree("47", root);
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
