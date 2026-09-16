import type { Decision, Effect } from "#namespace.js";

/**
 * An on_enter effect field may be templated only with what the engine itself
 * knows about this entry — the round and the stage id — never with snapshot
 * content. This is the same rule, and deliberately the same shape, as the one
 * step.ts applies to a route's effect fields: an effect is structure, not
 * prose. A marker assembled from a ticket body would be a control token
 * forged by whoever opened the ticket, which is exactly what
 * neutraliseMarkers exists to prevent downstream.
 *
 * `Object.hasOwn`, not `vars[k] ?? whole`: the latter reads the prototype
 * chain, so `{toString}` resolves to a function and gets stringified in.
 */
const expand = (value: unknown, vars: Record<string, string>): unknown =>
  typeof value === "string"
    ? value.replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, k: string) => (Object.hasOwn(vars, k) ? String(vars[k]) : whole))
    : value;

/**
 * Effects belong to the state you are in, never to a transition. There is no
 * on_exit: re-entering a state replans its effects and reconcile drops the ones
 * that already landed, which is what makes crash recovery free.
 *
 * The round is stamped on every planned effect because re-entry is a fact the
 * ticket has to record: an entry effect whose marker did not name the round
 * would read as already satisfied the second time round, be reconciled away,
 * and leave the stage unable to tell it owed another pass. The round is the
 * destination's own output counter plus one (decide.ts), so replanning the
 * same entry — after a crash, or on the next poll — produces the identical
 * marker rather than a second record of one entry.
 */
export function planEffects(d: Decision): Effect[] {
  if (d.action !== "transition" || !d.to) return [];

  const stage = d.to.id;
  const round = d.round ?? 1;
  const vars = { round: String(round), stage };

  return (d.to.on_enter ?? []).map((effect) => ({
    ...Object.fromEntries(Object.entries(effect).map(([k, v]) => [k, expand(v, vars)])),
    // An effect type is a dispatch key, never templated text.
    type: effect.type,
    // Filled in rather than overwritten: an effect that names its own stage
    // or round means it, and silently retargeting it would be the engine
    // overruling the workflow about where a record belongs.
    ...(effect.stage === undefined ? { stage } : {}),
    ...(effect.round === undefined ? { round } : {}),
  }));
}
