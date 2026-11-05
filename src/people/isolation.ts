import { join } from "node:path";
import type { Person } from "#namespace.js";

/**
 * A person's folder under the sandbox's worktrees: their id, encoded, which
 * no path separator survives. Where every worktree of theirs is cut, and so
 * what every other person's step is denied.
 */
export const scopeOf = (person: Pick<Person, "id">): string => encodeURIComponent(person.id);

/**
 * What a person's step may not read, as the engine knows it: Landrace's
 * credentials, and each other person's folder of worktrees. Never their own,
 * and each once. The agent integration adds what it keeps of the runs under
 * each folder — its transcripts — when the step starts.
 */
export function denyForPerson(
  self: Pick<Person, "id">, others: readonly Pick<Person, "id">[], { worktrees, credentials }: { worktrees: string; credentials: string },
): string[] {
  const folders = others.filter((other) => other.id !== self.id).map((other) => join(worktrees, scopeOf(other)));
  return [...new Set([credentials, ...folders])];
}
