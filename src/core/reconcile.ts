import type { Effect, Snapshot } from "../namespace.js";

/**
 * Drop every effect the externals already satisfy. This is why there is no
 * ledger: "have I done this" is a question about the world, and a local record
 * can disagree with the world where the world cannot disagree with itself.
 *
 * `satisfied` is injected because core does not know what any effect type means.
 */
export function reconcile(
  s: Snapshot,
  effects: Effect[],
  satisfied: (s: Snapshot, e: Effect) => boolean,
): Effect[] {
  return effects.filter((e) => !satisfied(s, e));
}
