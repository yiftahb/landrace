import { compile } from "#core/predicate.js";
import type { GotoTarget, Snapshot, Stage } from "#namespace.js";

/** A stage's `goto` list, each entry in the one shape the engine reads. */
export const gotoTargetsOf = (stage: Stage): GotoTarget[] =>
  (stage.goto ?? []).map((g) => (typeof g === "string"
    ? { stage: g, when: null, retryOnly: false }
    : { stage: g.stage, when: g.when ?? null, retryOnly: g.retry === "only" }));

/** Why `from` may never send an item to `target` — its own list does not name it — or null. */
export function gotoNotListed(from: Stage, target: string): string | null {
  const targets = gotoTargetsOf(from);
  if (targets.some((g) => g.stage === target)) return null;
  return targets.length === 0
    ? `"${from.id}" sends an item to no step, and was asked to send it to "${target}"`
    : `"${from.id}" sends an item only to ${targets.map((g) => `"${g.stage}"`).join(" or ")}, not to "${target}"`;
}

/**
 * Why `from` does not send an item to a listed `target` right now — it is
 * Retry's alone and not what failed, or its `when` does not hold — or null.
 * `retry: only` is the one source of truth for the first: the board reads
 * the same declaration, never how a `when` happens to be spelled.
 */
export function gotoDeclined(from: Stage, s: Snapshot, target: string): string | null {
  const entry = gotoTargetsOf(from).find((g) => g.stage === target);
  if (!entry) return null;
  if (entry.retryOnly && s.run?.failedStage !== target) {
    return `"${from.id}" sends an item to "${target}" only as the Retry of a failed "${target}", and that is not what failed`;
  }
  if (entry.when === null || compile(entry.when)(s)) return null;
  return `"${from.id}" sends an item to "${target}" only while ${JSON.stringify(entry.when)}, and that does not hold now`;
}
