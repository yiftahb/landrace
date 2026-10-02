import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Every directory this suite asked for, so one afterAll can clear them. */
const made: string[] = [];

/**
 * A real repository.
 *
 * The engine's half of a capability is the filesystem remembering what an
 * agent did whatever the agent says about it, and the check is a real `git
 * status` plus a real `git log`. A fake filesystem would remember whatever the
 * fake decided, which is the one thing this must not be able to do.
 */
export async function gitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lr-sbx-"));
  made.push(dir);
  await exec("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await exec("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  await exec("git", ["config", "user.name", "t"], { cwd: dir });
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "a.ts"), "export const a = 1;\n");
  await exec("git", ["add", "-A"], { cwd: dir });
  await exec("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

/**
 * The operator's checkout with a bare repository beside it as `origin` — a
 * file:// remote, so a push really lands and really moves the remote-tracking
 * ref, and nothing leaves the machine.
 */
export async function gitRepoWithOrigin(): Promise<{ root: string; origin: string }> {
  const root = await gitRepo();
  const origin = await mkdtemp(join(tmpdir(), "lr-origin-"));
  made.push(origin);
  await exec("git", ["init", "-q", "--bare", "-b", "main"], { cwd: origin });
  await exec("git", ["remote", "add", "origin", `file://${origin}`], { cwd: root });
  await exec("git", ["push", "-q", "origin", "main"], { cwd: root });
  return { root, origin };
}

/**
 * A commit on `branch` — created from main if it is not there yet — made the
 * way a step makes one, in a worktree of its own, so the operator's checkout
 * never moves. Returns the commit.
 */
export async function commitOn(root: string, branch: string, file: string): Promise<string> {
  const exists = await exec("git", ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { cwd: root }).then(() => true, () => false);
  if (!exists) await exec("git", ["branch", branch, "main"], { cwd: root });
  const at = await mkdtemp(join(tmpdir(), "lr-commit-"));
  await rm(at, { recursive: true, force: true });
  await exec("git", ["worktree", "add", "-q", at, branch], { cwd: root });
  try {
    await writeFile(join(at, file), `export const made = ${JSON.stringify(file)};\n`);
    await exec("git", ["add", "-A"], { cwd: at });
    await exec("git", ["commit", "-qm", `add ${file}`], { cwd: at });
    return (await exec("git", ["rev-parse", "HEAD"], { cwd: at })).stdout.trim();
  } finally {
    await exec("git", ["worktree", "remove", "--force", at], { cwd: root });
  }
}

/**
 * A commit on origin's `branch` made from another clone — a person's push,
 * or the forge's "Update branch" — that the operator's checkout has not
 * heard of. Returns the commit.
 */
export async function pushedElsewhere(origin: string, branch: string, file = "theirs.ts"): Promise<string> {
  const other = await mkdtemp(join(tmpdir(), "lr-other-"));
  made.push(other);
  const git = async (...args: string[]): Promise<string> => (await exec("git", args, { cwd: other })).stdout.trim();
  await git("clone", "-q", `file://${origin}`, ".");
  await git("config", "user.email", "o@example.com");
  await git("config", "user.name", "o");
  await git("checkout", "-q", branch);
  await writeFile(join(other, file), `export const theirs = ${JSON.stringify(file)};\n`);
  await git("add", "-A");
  await git("commit", "-qm", `add ${file}`);
  await git("push", "-q", "origin", branch);
  return git("rev-parse", "HEAD");
}

/** The commit `ref` names in the repository at `cwd`, or null. */
export const commitAt = (cwd: string, ref: string): Promise<string | null> =>
  exec("git", ["rev-parse", "--verify", "-q", ref], { cwd }).then((r) => r.stdout.trim(), () => null);

/** A directory that is not a repository, cleared by the same afterAll. */
export async function plainDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lr-plain-"));
  made.push(dir);
  return dir;
}

/** The linked worktrees a repository currently has, so a test can say there are none left. */
export async function worktreesOf(root: string): Promise<string[]> {
  const { stdout } = await exec("git", ["worktree", "list", "--porcelain"], { cwd: root });
  return stdout.split("\n").filter((l) => l.startsWith("worktree ")).slice(1);
}

export async function removeRepos(): Promise<void> {
  while (made.length) await rm(made.pop() as string, { recursive: true, force: true });
}
