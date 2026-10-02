import { execFile } from "node:child_process";
import { mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { WorktreeBranch, WorktreeState } from "#namespace.js";
import { sandboxRoot } from "#sandbox.js";
import { containedPath } from "#workflow/load.js";
import { messageOf } from "#runner/errors.js";

const exec = promisify(execFile);

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
 * With no branch — a stage that names none — a detached HEAD: the agent sees
 * committed state only, cannot read the operator's work in progress and
 * cannot damage it, and nothing it commits outlives the worktree. With one, a
 * step that may write gets the branch itself, created at HEAD the first time,
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
): Promise<string> {
  const path = await pathFor(slot, repoRoot);
  const what = `could not create a worktree for #${item}`;
  // Pruned first, so a registration whose directory is already gone reads as
  // gone rather than as a worktree to reuse or a branch someone still holds.
  await git(["worktree", "prune"], repoRoot, what);
  const all = registered(await git(["worktree", "list", "--porcelain"], repoRoot, what));

  // Started from origin's head when origin has moved the branch on: a step
  // sent back because the head moved must read the head that moved.
  const holder = on === undefined ? undefined : all.find((w) => w.branch === on.branch && w.path !== path);
  const local = on === undefined ? null : await commitOf(`refs/heads/${on.branch}`, repoRoot, what);
  const tip = on === undefined || local === null || holder ? local : await caughtUp(on.branch, local, repoRoot, what);
  const attach = on?.write ? on.branch : null;
  const detach = attach === null ? (tip ?? (await commitOf("HEAD", repoRoot, what))) : null;

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
  }

  // Re-used as it stands when it is already on what this step needs: a run
  // that crashed mid-step left it registered, and git refuses to add a second
  // worktree at the same path anyway. On the branch, at the commit the branch
  // names now: one moved forward under it is rebuilt there.
  const mine = all.find((w) => w.path === path);
  if (mine && (attach !== null ? mine.branch === attach && mine.head === tip : mine.branch === null && mine.head === detach)) return path;

  // Anything else is rebuilt rather than switched: the worktree is disposable
  // and a commit lives on a branch, so what a previous step left uncommitted
  // does not carry over — the same as when converge unwinds. A directory that
  // exists but is registered nowhere is the residue of an interrupted remove;
  // the path is ours — `pathFor` is what makes that a fact rather than an
  // assumption — so clearing it is safe.
  if (mine) await git(["worktree", "remove", "--force", path], repoRoot, what);
  await rm(path, { recursive: true, force: true });
  let add: string[];
  if (attach !== null) add = tip === null ? ["-b", attach, path, "HEAD"] : [path, attach];
  else if (detach !== null) add = ["--detach", path, detach];
  else throw new Error(`${what}: the repository has no commit to check out`);
  await git(["worktree", "add", ...add], repoRoot, what);
  return path;
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
  const head = (await git(["rev-parse", "HEAD"], path, "could not read the worktree's commit")).trim();
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
