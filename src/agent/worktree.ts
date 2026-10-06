import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import { INHERITED_ENV_KEYS } from "#conventions.js";
import type { RemoteGuard, WorktreeBranch, WorktreePreparation, WorktreeSetup, WorktreeState } from "#namespace.js";
import { sandboxRoot } from "#sandbox.js";
import { containedPath } from "#workflow/load.js";
import { messageOf } from "#runner/errors.js";

const exec = promisify(execFile);

/**
 * The slot a write step's worktree is kept in between steps, until the item
 * ends: beside the item's own, which every converge and conversation cuts and
 * removes, so an install in it outlives the run that made it.
 */
export const keptSlot = (item: string): string => `${item}.write`;

/** The items that have a kept write worktree under this repository's sandbox, by its slot's folder. */
export async function keptItems(repoRoot: string): Promise<string[]> {
  const names = await readdir(await rootFor(repoRoot));
  return names.filter((n) => n.endsWith(".write")).map((n) => n.slice(0, -".write".length));
}

/** The files whose change means what `setup` installs has changed, unless `agent.worktree.lockfiles` names others: the lockfiles at the repository root. */
export const DEFAULT_LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"];

/**
 * How long one call to origin may take before it is stopped — the forge's
 * limit on its own fetch of the same origin: it holds the item's lock and a
 * `tick.concurrency` slot while it runs.
 */
const FETCH_TIMEOUT_MS = 5 * 60_000;

/** How much of a failed setup command's output its reason carries. */
const SETUP_TAIL = 2000;

/**
 * `$TMPDIR/landrace/<repo>/worktrees/`, beside that repository's locks.
 *
 * `<repo>` is the resolved common git directory, digested — not
 * `basename(repoRoot)`, which is what this was and which is a name, not an
 * identity: two checkouts called `widgets` resolved to one sandbox, and the
 * second one to start found a directory registered to no worktree it could
 * see and cleared it. That was the other repository's live sandbox, deleted
 * out from under a running agent. Same defect as the lock root, same
 * identity, same helper.
 *
 * Created here rather than left to `git worktree add`, and then resolved:
 * every path below is compared against this one, so a component of it
 * replaced by a link has to be caught here, where the comparison is still
 * possible. Otherwise the whole sandbox — and with it the `rm -rf` below —
 * quietly relocates to wherever the link points, and each path under it still
 * looks perfectly contained.
 */
async function rootFor(repoRoot: string): Promise<string> {
  const root = join(sandboxRoot(repoRoot), "worktrees");
  await mkdir(root, { recursive: true });
  const real = await realpath(root);
  if (real !== root) {
    throw new Error(`refusing to use ${root} as a sandbox root: it resolves to ${real}, outside the sandbox`);
  }
  return root;
}

/**
 * Where #item's sandbox goes — proven to be inside this repository's own
 * sandbox root before anything is created there and, more to the point,
 * before anything is deleted there.
 *
 * `rm -rf` on a path assembled from outside input is the highest-consequence
 * operation in this codebase, and an item is a validated string to the
 * typechecker and a value out of a tracker hook at runtime, which are not the
 * same claim. `containedPath` is the existing answer to exactly this shape:
 * it rejects a segment that climbs out before resolving anything, and
 * compares both ends after fs.realpath, so a path that exists but leads
 * somewhere else is refused rather than followed.
 */
export async function pathFor(item: string, repoRoot: string): Promise<string> {
  const root = await rootFor(repoRoot);
  const where = await containedPath(root, item);
  if (where.ok) return where.path;
  // Not there yet, which is the ordinary case — and the shape check and the
  // containment check both ran before the lookup that said so.
  if (where.kind === "missing") return join(root, item);
  throw new Error(`refusing to touch a sandbox for #${item} under ${root}: that path ${where.reason}`);
}

/** git's own message, not a stack trace: an operator can act on "not a git repository". */
async function git(args: string[], cwd: string, what: string): Promise<string> {
  try {
    const { stdout } = await exec("git", args, { cwd });
    return stdout;
  } catch (e) {
    const stderr = String((e as { stderr?: unknown }).stderr ?? "").trim();
    throw new Error(`${what}: ${stderr || messageOf(e)}`);
  }
}

/**
 * `git` for a call that reaches origin, with the forge's guards on its own
 * fetch of the same origin: prompting off, so one that wants a password fails
 * and says so rather than waiting on a terminal nobody is watching, and
 * stopped at the run's abort or its own limit — it holds the item's lock and
 * a `tick.concurrency` slot while it runs, and a converge stuck on it would
 * hold both for good.
 */
async function gitRemote(args: string[], cwd: string, what: string, guard: RemoteGuard): Promise<string> {
  try {
    const { stdout } = await exec("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      timeout: guard.timeoutMs,
      ...(guard.signal === undefined ? {} : { signal: guard.signal }),
    });
    return stdout;
  } catch (e) {
    // The subcommand, past any `-c key=value` before it.
    const command = args.find((arg, i) => !arg.startsWith("-") && args[i - 1] !== "-c") ?? "";
    if (guard.signal?.aborted) throw new Error(`${what}: git ${command} was aborted`);
    if ((e as { killed?: unknown }).killed === true) {
      throw new Error(`${what}: git ${command} did not finish within ${Math.round(guard.timeoutMs / 1000)}s and was stopped`);
    }
    const stderr = String((e as { stderr?: unknown }).stderr ?? "").trim();
    throw new Error(`${what}: ${stderr || messageOf(e)}`);
  }
}

/**
 * The repository a workflow directory belongs to.
 *
 * Asked once at startup rather than at the first invoke: a loop started
 * outside a repository would otherwise assemble happily, poll happily, and
 * fail at its first paid step — hours in, on an item it has already moved.
 */
export async function repositoryRoot(dir: string): Promise<string> {
  const out = await git(
    ["rev-parse", "--show-toplevel"],
    dir,
    `${dir} is not inside a git repository, so there is nothing to isolate a step against`,
  );
  return out.trim();
}

/** The commit `ref` names, or null when there is no such ref. */
async function commitOf(ref: string, cwd: string, what: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["rev-parse", "--verify", "-q", `${ref}^{commit}`], { cwd });
    return stdout.trim();
  } catch (e) {
    // `-q` makes a ref that is not there exit 1 and say nothing. Anything
    // else — not a repository, a corrupt ref — is a failure, not an absence.
    const stderr = String((e as { stderr?: unknown }).stderr ?? "").trim();
    if ((e as { code?: unknown }).code === 1 && stderr === "") return null;
    throw new Error(`${what}: ${stderr || messageOf(e)}`);
  }
}

/**
 * The branch moved forward to what the checkout knows of origin's, when
 * origin's has everything the local one has and more — a person's push, the
 * forge's "Update branch", once a fetch brought it here — and the commit the
 * step should start from either way.
 *
 * Never backwards, never across a fork: a local commit origin does not have
 * is a step's own, not yet pushed, and is kept. And never a branch another
 * checkout has out — the operator's own, say — whose files would no longer
 * match it. The update names the commit it moves from, so a branch that
 * moved meanwhile is left as it is.
 */
async function caughtUp(branch: string, local: string, repoRoot: string, what: string): Promise<string> {
  const theirs = await commitOf(`refs/remotes/origin/${branch}`, repoRoot, what);
  if (theirs === null || theirs === local) return local;
  const behind = await exec("git", ["merge-base", "--is-ancestor", local, theirs], { cwd: repoRoot }).then(
    () => true,
    (e: unknown) => {
      // Exit 1 is "not an ancestor"; anything else is a failure, not an answer.
      if ((e as { code?: unknown }).code === 1) return false;
      throw new Error(`${what}: ${String((e as { stderr?: unknown }).stderr ?? "").trim() || messageOf(e)}`);
    },
  );
  if (!behind) return local;
  await git(["update-ref", `refs/heads/${branch}`, theirs, local], repoRoot, what);
  return theirs;
}

/**
 * Origin's default branch, as `refs/remotes/origin/HEAD` names it, asked of
 * origin once when nothing has set it yet — a clone sets it, a `remote add`
 * and a push do not.
 */
async function defaultBranch(repoRoot: string, what: string, guard: RemoteGuard): Promise<string> {
  const named = async (): Promise<string | null> => {
    const ref = await exec("git", ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"], { cwd: repoRoot }).then(
      ({ stdout }) => stdout.trim(),
      (e: unknown) => {
        // `-q` makes an unset ref exit 1 and say nothing; anything else is a failure, not an absence.
        const stderr = String((e as { stderr?: unknown }).stderr ?? "").trim();
        if ((e as { code?: unknown }).code === 1 && stderr === "") return null;
        throw new Error(`${what}: ${stderr || messageOf(e)}`);
      },
    );
    return ref?.startsWith("refs/remotes/origin/") ? ref.slice("refs/remotes/origin/".length) : null;
  };
  const known = await named();
  if (known !== null) return known;
  const fix = "run `git remote set-head origin --auto` in the repository, or `git remote set-head origin <branch>` to name it";
  await gitRemote(["remote", "set-head", "origin", "--auto"], repoRoot, `${what}: origin's default branch is unknown, and asking origin failed; ${fix}`, guard);
  const asked = await named();
  if (asked === null) throw new Error(`${what}: origin's default branch is unknown; ${fix}`);
  return asked;
}

/**
 * The commit a worktree with nothing of its own starts at — a stage with no
 * branch, or an item branch not yet made: origin's default branch, fetched
 * now. The operator's `HEAD` was this, and it is whatever their checkout has
 * out, however long ago it was pulled: an item specced there was specced on
 * stale code, and one built there carried their branch into its pull request.
 *
 * A fetch that fails fails the round with git's words, never a quiet fall back
 * to an older commit. Only a repository with no origin at all keeps `HEAD`.
 * The operator's checkout is never touched: only origin's ref moves.
 */
async function baseCommit(repoRoot: string, what: string, guard: RemoteGuard): Promise<string | null> {
  return (await fetchDefault(repoRoot, what, guard)) ?? commitOf("HEAD", repoRoot, what);
}

/**
 * Origin's default branch fetched into `refs/remotes/origin/<default>`, and
 * the commit it names now; null in a repository with no origin, where there
 * is nothing to fetch.
 */
async function fetchDefault(repoRoot: string, what: string, guard: RemoteGuard): Promise<string | null> {
  const remotes = (await git(["remote"], repoRoot, what)).split("\n");
  if (!remotes.includes("origin")) return null;
  const branch = await defaultBranch(repoRoot, what, guard);
  const tracking = `refs/remotes/origin/${branch}`;
  // The operator's repository, so only that one ref, as the forge's fetch of
  // the same origin takes it: their FETCH_HEAD and tags untouched, none of
  // their hooks run, and no submodule's remote asked, which can fail the round
  // whenever origin's new commits move an initialised one.
  await gitRemote(
    ["-c", "core.hooksPath=/dev/null", "-c", "fetch.recurseSubmodules=false",
      "fetch", "-q", "--no-tags", "--no-write-fetch-head", "origin", `+refs/heads/${branch}:${tracking}`],
    repoRoot, `${what}: fetching origin's ${branch} failed`, guard,
  );
  const commit = await commitOf(tracking, repoRoot, what);
  if (commit === null) throw new Error(`${what}: origin's default branch ${branch} has no commit after fetching it`);
  return commit;
}

/** `git worktree list --porcelain`, one entry per worktree: where, at which commit, on which branch (null when detached). */
function registered(porcelain: string): Array<{ path: string; head: string | null; branch: string | null }> {
  return porcelain.split("\n\n").flatMap((block) => {
    const field = (name: string): string | null =>
      block.split("\n").find((line) => line.startsWith(`${name} `))?.slice(name.length + 1) ?? null;
    const path = field("worktree");
    const branch = field("branch")?.replace(/^refs\/heads\//, "") ?? null;
    return path === null ? [] : [{ path, head: field("HEAD"), branch }];
  });
}

/**
 * A worktree for one item, checked out on what its stage names.
 *
 * With no branch — a stage that names none — origin's default branch,
 * detached: the agent sees committed state only, cannot read the operator's
 * work in progress and cannot damage it, and nothing it commits outlives the
 * worktree. With one, a step that may write gets the branch itself, created
 * at origin's default branch the first time (see `baseCommit`) and with that
 * branch fetched again every later time, for the step to merge,
 * so its commits are kept when the worktree goes; a read-only step gets the
 * branch's commit detached — the item's code, not main's, and no branch for
 * a commit it should never have made to land on.
 *
 * This is filesystem isolation, not process isolation — the agent still runs
 * as you, with your credentials on disk — which is exactly why containers
 * remain on the roadmap and why the capability check in `runStep` is the half
 * of this that actually refuses something.
 */
export async function ensureWorktree(
  item: string,
  repoRoot: string,
  on?: WorktreeBranch,
  /**
   * The directory's name, when it is not the item's own: a pairing's
   * `<item>.pair`, which the tick and a conversation — each cutting and
   * removing `<item>` as they run — never touch.
   */
  slot: string = item,
  { signal, timeoutMs = FETCH_TIMEOUT_MS }: Partial<RemoteGuard> = {},
): Promise<string> {
  const guard = { signal, timeoutMs };
  const path = await pathFor(slot, repoRoot);
  const what = `could not create a worktree for #${item}`;
  // Pruned first, so a registration whose directory is already gone reads as
  // gone rather than as a worktree to reuse or a branch someone still holds.
  await git(["worktree", "prune"], repoRoot, what);
  const all = registered(await git(["worktree", "list", "--porcelain"], repoRoot, what));

  // Started from origin's head when origin has moved the branch on: a step
  // sent back because the head moved must read the head that moved. The
  // item's own kept worktree holds no one's work but a step's commits, so it
  // is never a reason to leave the branch behind; it is reset onto the branch
  // when it is next reused.
  const kept = await pathFor(keptSlot(item), repoRoot);
  const holder = on === undefined ? undefined : all.find((w) => w.branch === on.branch && w.path !== path && w.path !== kept);
  const local = on === undefined ? null : await commitOf(`refs/heads/${on.branch}`, repoRoot, what);
  const tip = on === undefined || local === null || holder ? local : await caughtUp(on.branch, local, repoRoot, what);
  const attach = on?.write ? on.branch : null;
  const base = tip === null ? await baseCommit(repoRoot, what, guard) : null;
  const detach = attach === null ? (tip ?? base) : null;
  // A write step on a branch that already exists merges origin's default
  // branch itself, from a sandbox that cannot reach an origin wanting
  // credentials: fetched here, or it merges whatever the branch's first build
  // fetched and git calls that up to date (#126). The branch is not moved.
  if (attach !== null && tip !== null && !holder) await fetchDefault(repoRoot, what, guard);

  if (attach !== null) {
    // git checks a branch out in one place at a time, and the other place is
    // usually the operator's own checkout. Taking it from there is not ours
    // to do, and git would refuse in words that name neither the item nor
    // the way out.
    if (holder) {
      throw new Error(
        `#${item}'s branch ${attach} is checked out at ${holder.path}, and git checks a branch out in one ` +
        "place at a time; landrace will not take it from there. Switch that checkout to another branch and " +
        "the item carries on.",
      );
    }
    // The item's kept worktree is ours to give up: another of its slots — a
    // pairing, a conversation's turn — needs the branch, and the kept one is
    // rebuilt when a write step next wants it.
    if (path !== kept && all.some((w) => w.path === kept && w.branch === attach)) {
      await removeWorktree(item, repoRoot, keptSlot(item));
    }
  }

  // Re-used when it is already on what this step needs: a run that crashed
  // mid-step left it registered, git refuses to add a second worktree at the
  // same path anyway, and a write step's install is what reuse is for. On the
  // branch, it is reset to the commit the branch names now — one moved forward
  // under it, by origin or by a read-only step's catch-up — and what a
  // previous step left uncommitted is cleaned away, as a rebuild would; what
  // git ignores, `node_modules` and the copied files, stays. The kept one is
  // found detached, released when its last step ended, and is attached to the
  // branch again first. Detached, as it stands, at the commit it needs.
  const mine = all.find((w) => w.path === path);
  const released = mine !== undefined && path === kept && attach !== null && mine.branch === null && tip !== null;
  if (released) await git(["checkout", "-q", "--force", attach], path, what);
  if (mine && attach !== null && (mine.branch === attach || released)) {
    await git(["reset", "--hard", "-q", tip ?? "HEAD"], path, what);
    await git(["clean", "-fdq"], path, what);
    return path;
  }
  if (mine && attach === null && mine.branch === null && mine.head === detach) return path;

  // Anything else is rebuilt rather than switched: the worktree is disposable
  // and a commit lives on a branch, so what a previous step left uncommitted
  // does not carry over — the same as when converge unwinds. A directory that
  // exists but is registered nowhere is the residue of an interrupted remove;
  // the path is ours — `pathFor` is what makes that a fact rather than an
  // assumption — so clearing it is safe.
  if (mine) await git(["worktree", "remove", "--force", path], repoRoot, what);
  await rm(path, { recursive: true, force: true });
  let add: string[];
  if (attach !== null && tip !== null) add = [path, attach];
  // The commit, not origin's ref: a branch started from a remote-tracking ref
  // would be set to track origin's default branch.
  else if (attach !== null && base !== null) add = ["-b", attach, path, base];
  else if (attach === null && detach !== null) add = ["--detach", path, detach];
  else throw new Error(`${what}: the repository has no commit to check out`);
  await git(["worktree", "add", ...add], repoRoot, what);
  return path;
}

/**
 * The item's kept worktree, detached where it stands, so the branch is free
 * while the item waits: git checks a branch out in one place at a time, and
 * a person trying the item or pushing a fix from their own checkout needs it.
 * `ensureWorktree` attaches it again for the next write step.
 *
 * Quiet on failure, as `removeWorktree` is: it runs as a converge unwinds, and
 * a branch left held is refused by name when a person switches to it.
 */
export async function releaseWorktree(item: string, repoRoot: string): Promise<void> {
  // Only a registered worktree: git run in a directory that is not one would
  // act on whichever repository encloses it.
  const path = await worktreeOf(keptSlot(item), repoRoot).catch(() => null);
  if (path === null) return;
  await exec("git", ["checkout", "-q", "--detach"], { cwd: path }).catch(() => undefined);
}

/**
 * Idempotent on purpose: this runs on every exit path, including the ones
 * reached because something already went wrong. A removal that threw there
 * would replace the real failure with its own.
 */
export async function removeWorktree(item: string, repoRoot: string, slot: string = item): Promise<void> {
  // A path this refuses is one that is not ours, and there is nothing of ours
  // at it to remove: doing nothing is the whole answer, and reporting it here
  // would be reporting it from the unwind of something else.
  const path = await pathFor(slot, repoRoot).catch(() => null);
  if (path === null) return;
  await exec("git", ["worktree", "remove", "--force", path], { cwd: repoRoot }).catch(() => undefined);
  // The registration and the directory can outlive each other — a remove that
  // failed because the repository moved leaves the directory behind, and that
  // is the disk leak. Both are cleared, and neither failure is reported: the
  // caller is usually already unwinding from something else.
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
  await exec("git", ["worktree", "prune"], { cwd: repoRoot }).catch(() => undefined);
}

/**
 * Where a slot's worktree is registered, or null when it has none.
 *
 * Asked before `ensureWorktree` wherever a person may already be working in
 * it: that one rebuilds a worktree that is not on the commit it expects, and
 * a pairing's detached checkout falls behind the moment main moves — a
 * rebuild would delete what the person had not committed.
 */
export async function worktreeOf(slot: string, repoRoot: string): Promise<string | null> {
  const path = await pathFor(slot, repoRoot);
  const what = `could not read the worktree for ${slot}`;
  await git(["worktree", "prune"], repoRoot, what);
  return registered(await git(["worktree", "list", "--porcelain"], repoRoot, what)).some((w) => w.path === path)
    ? path
    : null;
}

/**
 * The commit a worktree is at. Asked of a step's worktree as it is cut, once
 * its branch has been brought up to origin's: the commit the step starts
 * from, which is what its record says it saw.
 */
export async function worktreeHead(path: string): Promise<string> {
  return (await git(["rev-parse", "HEAD"], path, "could not read the worktree's commit")).trim();
}

/**
 * What a worktree looks like right now: its commit, and every path git reports
 * as changed.
 *
 * Read before and after a step rather than asked as "is it clean", because a
 * worktree a previous run left dirty is not this step's doing — see
 * `changedSince`. Ignored paths (`dist/`, `node_modules/`) are outside this by
 * construction: they are not the repository's content, and they are discarded
 * with the worktree either way.
 */
export async function worktreeState(path: string): Promise<WorktreeState> {
  const head = await worktreeHead(path);
  const status = await git(
    ["status", "--porcelain", "-z", "--untracked-files=all"],
    path,
    "could not read the worktree's status",
  );
  return { head, changes: status.split("\0").filter((entry) => entry.length > 0) };
}

/**
 * What the step did to its worktree, in words a refusal can quote.
 *
 * The commit check is not decoration: `git add -A && git commit` leaves the
 * status completely clean, so a check that read only the status would call the
 * tidiest possible violation no violation at all.
 */
export function changedSince(before: WorktreeState, after: WorktreeState): string[] {
  const already = new Set(before.changes);
  const changes = after.changes.filter((entry) => !already.has(entry));
  return [
    ...(before.head === after.head ? [] : [`a commit (${before.head.slice(0, 8)} → ${after.head.slice(0, 8)})`]),
    ...changes,
  ];
}

/** The files `glob` matches in the checkout at `root`, among those `flags` select for `git ls-files`. */
async function filesMatching(root: string, glob: string, flags: string[], key = "copy"): Promise<string[]> {
  const out = await git(["ls-files", "-z", ...flags, "--", `:(glob)${glob}`], root, `could not read the files agent.worktree.${key} "${glob}" matches`);
  return out.split("\0").filter((f) => f.length > 0);
}

/** Why a glob of `agent.worktree.<key>` cannot be read from the repository root, or null. */
function globProblem(key: string, glob: string): string | null {
  if (isAbsolute(glob) || glob.startsWith("/")) return `agent.worktree.${key} "${glob}" is an absolute path; a glob is read from the repository root`;
  if (glob.split(/[\\/]/).includes("..")) return `agent.worktree.${key} "${glob}" climbs out of the repository with ".."`;
  return null;
}

/** What is wrong with `agent.worktree.lockfiles`, one line per glob: one that is absolute or climbs out with `..`. */
export function lockfileProblems(globs: readonly string[]): string[] {
  return globs.flatMap((glob) => globProblem("lockfiles", glob) ?? []);
}

/**
 * What is wrong with `agent.worktree.copy`, one line per glob and per file:
 * a glob that is absolute or climbs out with `..`, and every tracked file a
 * glob matches — copying one over the worktree would mask the branch's own
 * version of it. Asked at start and again before every copy, because a file
 * can be committed in between.
 */
export async function copyProblems(root: string, globs: readonly string[]): Promise<string[]> {
  const problems: string[] = [];
  for (const glob of globs) {
    const problem = globProblem("copy", glob);
    if (problem !== null) {
      problems.push(problem);
    } else {
      for (const file of await filesMatching(root, glob, [])) {
        problems.push(`agent.worktree.copy "${glob}" matches ${file}, which git tracks; only untracked or ignored files are copied`);
      }
    }
  }
  return problems;
}

/**
 * The untracked and ignored files the globs match, copied from the checkout
 * into the worktree at the same paths. A link that leads outside the
 * repository is not followed — it would hand the agent whatever it points at
 * — and a destination whose folder leads outside the worktree, through a
 * link the item's branch committed, is refused rather than written through.
 */
async function copyInto(path: string, root: string, globs: readonly string[]): Promise<void> {
  const problems = await copyProblems(root, globs);
  // The item's branch too: a file it committed is untracked in the checkout
  // still, and copying over it would hand the operator's version to the next
  // `git commit -a`.
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], path, "could not read the worktree's branch")).trim();
  for (const glob of globs) {
    if (isAbsolute(glob) || glob.split(/[\\/]/).includes("..")) continue;
    for (const file of await filesMatching(path, glob, [])) {
      problems.push(`agent.worktree.copy "${glob}" matches ${file}, which ${branch} tracks; only untracked or ignored files are copied`);
    }
  }
  if (problems.length) throw new Error(problems.join("; "));
  for (const glob of globs) {
    const files = [
      ...(await filesMatching(root, glob, ["--others", "--exclude-standard"])),
      ...(await filesMatching(root, glob, ["--others", "--ignored", "--exclude-standard"])),
    ];
    for (const file of files) {
      const from = await containedPath(root, file);
      if (!from.ok) continue;
      // ponytail: folders made before the check below are left if it refuses; they are empty.
      await mkdir(join(path, dirname(file)), { recursive: true });
      const into = await containedPath(path, dirname(file));
      if (!into.ok) throw new Error(`agent.worktree.copy will not copy ${file}: its folder in the worktree ${into.reason}`);
      const to = join(into.path, basename(file));
      // A link already at the path would be written through.
      await rm(to, { force: true });
      await copyFile(from.path, to);
    }
  }
}

/**
 * What setup's last run was for: its commands, and each lockfile the globs
 * match as the worktree holds it now — tracked, or added and not yet
 * committed — by its path, so one added or removed counts as a change too.
 */
async function setupHash(path: string, { setup, lockfiles }: WorktreeSetup): Promise<string> {
  const hash = createHash("sha256").update(JSON.stringify(setup));
  const files = new Set<string>();
  for (const glob of lockfiles) {
    for (const file of await filesMatching(path, glob, ["--cached", "--others", "--exclude-standard"], "lockfiles")) files.add(file);
  }
  for (const file of [...files].sort()) {
    hash.update(`\0${file}\0`);
    hash.update(await readFile(join(path, file)).catch(() => "\0absent"));
  }
  return hash.digest("hex");
}

/**
 * One setup command, in the worktree, through the shell — it is the
 * operator's own line, trusted like `landrace.yaml` — with the agent's
 * minimal environment, never the engine's: an install script must not see the
 * forge token. Its whole process group is killed at the timeout or an abort.
 * Null when it passed, or why not with the tail of its output.
 */
function runSetup(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<string | null> {
  return new Promise((done) => {
    let tail = "";
    let stopped: string | null = null;
    const env = Object.fromEntries(INHERITED_ENV_KEYS.flatMap((key) => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }));
    const child = spawn(command, { cwd, env, shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const keep = (chunk: Buffer): void => {
      tail = (tail + chunk.toString()).slice(-SETUP_TAIL);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const stop = (why: string): void => {
      stopped = why;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => stop(`timed out after ${timeoutMs}ms`), timeoutMs);
    const onAbort = (): void => stop("was stopped: the run was aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (failure: string | null): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const said = tail.trim();
      done(failure === null ? null : `${failure}${said ? `:\n${said}` : ", and printed nothing"}`);
    };
    child.on("error", (e) => finish(`could not start: ${messageOf(e)}`));
    child.on("close", (code, sig) => {
      if (stopped !== null) finish(stopped);
      else if (code === 0) finish(null);
      else finish(code === null ? `was killed by ${String(sig)}` : `exited ${code}`);
    });
  });
}

/**
 * A write step's worktree made ready for its agent: `copy`, then `setup` when
 * its commands or its lockfiles have changed since it last passed here.
 *
 * What it last passed for is recorded in the worktree's own git folder, so a
 * rebuilt worktree has none and runs setup again, and a record that is
 * missing or unreadable runs it too: reuse is an optimisation, never a source
 * of truth. A failure throws the command's tail, before the agent is paid for.
 */
export async function prepareWorktree({ item, path, root, setup, log, signal }: WorktreePreparation): Promise<void> {
  await copyInto(path, root, setup.copy);
  if (setup.setup.length === 0) return;
  const what = `could not set up #${item}'s worktree`;
  const record = resolve(path, (await git(["rev-parse", "--git-path", "landrace-setup"], path, what)).trim());
  if ((await readFile(record, "utf8").catch(() => null)) === (await setupHash(path, setup))) return;
  await rm(record, { force: true });
  for (const command of setup.setup) {
    log("worktree.setup.started", { item, command });
    const started = Date.now();
    const failure = await runSetup(command, path, setup.timeoutMs, signal);
    if (failure !== null) {
      log("worktree.setup.failed", { item, command, reason: failure });
      throw new Error(`#${item}'s worktree setup "${command}" ${failure}`);
    }
    log("worktree.setup.finished", { item, command, ms: Date.now() - started });
  }
  // Hashed after, so a setup that rewrites a lockfile is not run again for its own change.
  await writeFile(record, await setupHash(path, setup));
}
