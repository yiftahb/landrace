import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Person, RunDenials } from "#namespace.js";

/**
 * A person's folder under the sandbox's worktrees: their id, encoded, which
 * no path separator survives. Where every worktree of theirs is cut, and so
 * what every other person's step is denied.
 */
export const scopeOf = (person: Pick<Person, "id">): string => encodeURIComponent(person.id);

/**
 * What a person's step may not read, as the engine knows it: Landrace's
 * credentials and the workspace's `.env`, whoever else is here; and each
 * other person's folder of worktrees. Never their own, and each once. The
 * agent integration adds what it keeps of the runs under each folder — its
 * transcripts — when the step starts.
 *
 * The other folders are the roster's people and, for a person with a folder
 * of their own (`own`), everything else `present` under the worktrees: the
 * roster drops a person on a sync while their runs are still unwinding, and
 * their folder stays theirs for as long as it is there. The local person has
 * no folder of their own — their worktrees are the folder's own entries — so
 * only the roster's people are denied them.
 */
export function denyForPerson(
  self: Pick<Person, "id">, others: readonly Pick<Person, "id">[],
  { worktrees, credentials, env, own, present = [] }: {
    worktrees: string; credentials: string; env: string; own?: string | undefined; present?: readonly string[];
  },
): RunDenials {
  const listed = others.filter((other) => other.id !== self.id).map((other) => scopeOf(other));
  const found = own === undefined ? [] : present;
  const folders = [...listed, ...found].filter((name) => name !== own && name !== scopeOf(self)).map((name) => join(worktrees, name));
  return { always: [credentials, env], people: [...new Set(folders)] };
}

/**
 * Every entry under the sandbox's worktrees, read now. Not there is none;
 * any other failure refuses the run — read as none, a person who has left
 * the roster would be left readable.
 */
export async function worktreeFolders(worktrees: string): Promise<string[]> {
  return readdir(worktrees).catch((e: unknown) => {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  });
}
