import { compile } from "#core/predicate.js";
import type { GotoTarget, Snapshot, Stage } from "#namespace.js";

/** A stage's `goto` list, each entry in the one shape the engine reads. */
export const gotoTargetsOf = (stage: Stage): GotoTarget[] =>
  (stage.goto ?? []).map((g) => (typeof g === "string" ? { stage: g, when: null } : { stage: g.stage, when: g.when ?? null }));

/** Why `from` may never send a ticket to `target` — its own list does not name it — or null. */
export function gotoNotListed(from: Stage, target: string): string | null {
  const targets = gotoTargetsOf(from);
  if (targets.some((g) => g.stage === target)) return null;
  return targets.length === 0
    ? `"${from.id}" sends a ticket to no step, and was asked to send it to "${target}"`
    : `"${from.id}" sends a ticket only to ${targets.map((g) => `"${g.stage}"`).join(" or ")}, not to "${target}"`;
}

/** Why `from` does not send a ticket to a listed `target` right now — its `when` does not hold — or null. */
export function gotoDeclined(from: Stage, s: Snapshot, target: string): string | null {
  const entry = gotoTargetsOf(from).find((g) => g.stage === target);
  if (!entry || entry.when === null || compile(entry.when)(s)) return null;
  return `"${from.id}" sends a ticket to "${target}" only while ${JSON.stringify(entry.when)}, and that does not hold now`;
}
