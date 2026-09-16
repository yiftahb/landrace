import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import type { WorktreeState } from "../namespace.js";

const exec = promisify(execFile);

/**
 * git reports worktree paths resolved, and on macOS /var is a symlink to
 * /private/var. Resolving up front is why the "does it already exist" check
 * below matches, instead of trying to re-add the same worktree every tick.
 */
const ROOT = (): string => join(realpathSync(tmpdir()), "landrace", "worktrees");

const pathFor = (ticket: number, repoRoot: string): string =>
  join(ROOT(), basename(repoRoot), String(ticket));

/** git's own message, not a stack trace: an operator can act on "not a git repository". */
async function git(args: string[], cwd: string, what: string): Promise<string> {
  try {
    const { stdout } = await exec("git", args, { cwd });
    return stdout;
  } catch (e) {
    const stderr = String((e as { stderr?: unknown }).stderr ?? "").trim();
    throw new Error(`${what}: ${stderr || (e as Error).message}`);
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
  const path = pathFor(ticket, repoRoot);
  const listed = await git(["worktree", "list", "--porcelain"], repoRoot, `could not create a worktree for #${ticket}`);
  // Re-used, not rebuilt: a run that crashed mid-step left one registered, and
  // git refuses to add a second worktree at the same path anyway.
  if (listed.split("\n").includes(`worktree ${path}`)) return path;

  // A directory that exists but is registered nowhere is the residue of a
  // `worktree remove` that was interrupted, or of a pruned registration. git
  // would refuse to add onto it; the path is ours, so clearing it is safe.
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
  const path = pathFor(ticket, repoRoot);
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
