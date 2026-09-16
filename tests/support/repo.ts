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
