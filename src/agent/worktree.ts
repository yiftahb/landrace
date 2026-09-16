import { execFile } from "node:child_process";
import { mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { WorktreeState } from "#namespace.js";
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
 * Where #ticket's sandbox goes — proven to be inside this repository's own
 * sandbox root before anything is created there and, more to the point,
 * before anything is deleted there.
 *
 * `rm -rf` on a path assembled from outside input is the highest-consequence
 * operation in this codebase, and a ticket is a number to the typechecker and
 * a value out of a tracker hook at runtime, which are not the same claim.
 * `containedPath` is the existing answer to exactly this shape: it rejects a
 * segment that climbs out before resolving anything, and compares both ends
 * after fs.realpath, so a path that exists but leads somewhere else is
 * refused rather than followed.
 */
async function pathFor(ticket: number, repoRoot: string): Promise<string> {
  const root = await rootFor(repoRoot);
  const where = await containedPath(root, String(ticket));
  if (where.ok) return where.path;
  // Not there yet, which is the ordinary case — and the shape check and the
  // containment check both ran before the lookup that said so.
  if (where.kind === "missing") return join(root, String(ticket));
  throw new Error(`refusing to touch a sandbox for #${ticket} under ${root}: that path ${where.reason}`);
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
 * fail at its first paid step — hours in, on a ticket it has already moved.
 */
export async function repositoryRoot(dir: string): Promise<string> {
  const out = await git(
    ["rev-parse", "--show-toplevel"],
    dir,
    `${dir} is not inside a git repository, so there is nothing to isolate a step against`,
  );
  return out.trim();
}

/**
 * A detached worktree at HEAD, one per ticket.
 *
 * The agent therefore sees committed state only: it cannot read the operator's
 * work in progress and cannot damage it. This is filesystem isolation, not
 * process isolation — the agent still runs as you, with your credentials on
 * disk — which is exactly why containers remain on the roadmap and why the
 * capability check in `runStep` is the half of this that actually refuses
 * something.
 */
export async function ensureWorktree(ticket: number, repoRoot: string): Promise<string> {
  const path = await pathFor(ticket, repoRoot);
  const listed = await git(["worktree", "list", "--porcelain"], repoRoot, `could not create a worktree for #${ticket}`);
  // Re-used, not rebuilt: a run that crashed mid-step left one registered, and
  // git refuses to add a second worktree at the same path anyway.
  if (listed.split("\n").includes(`worktree ${path}`)) return path;

  // A directory that exists but is registered nowhere is the residue of a
  // `worktree remove` that was interrupted, or of a pruned registration. git
  // would refuse to add onto it; the path is ours — `pathFor` is what makes
  // that a fact rather than an assumption — so clearing it is safe.
  await git(["worktree", "prune"], repoRoot, `could not create a worktree for #${ticket}`);
  await rm(path, { recursive: true, force: true });
  await git(
    ["worktree", "add", "--detach", path, "HEAD"],
    repoRoot,
    `could not create a worktree for #${ticket}`,
  );
  return path;
}

/**
 * Idempotent on purpose: this runs on every exit path, including the ones
 * reached because something already went wrong. A removal that threw there
 * would replace the real failure with its own.
 */
export async function removeWorktree(ticket: number, repoRoot: string): Promise<void> {
  // A path this refuses is one that is not ours, and there is nothing of ours
  // at it to remove: doing nothing is the whole answer, and reporting it here
  // would be reporting it from the unwind of something else.
  const path = await pathFor(ticket, repoRoot).catch(() => null);
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
