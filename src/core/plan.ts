import type { Decision, Effect } from "./types.js";

/**
 * Effects belong to the state you are in, never to a transition. There is no
 * on_exit: re-entering a state replans its effects and reconcile drops the ones
 * that already landed, which is what makes crash recovery free.
 */
export function planEffects(d: Decision): Effect[] {
  if (d.action !== "transition") return [];
  return d.to?.on_enter ?? [];
}
