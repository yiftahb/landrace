import { branchNameProblem, NODES_CLOSE_EFFECT } from "#conventions.js";
import { planNodesClose } from "#core/children.js";
import type { Decision, Effect, Snapshot, Stage } from "#namespace.js";

/**
 * One `{}` template syntax, and one place that knows what a name looks like.
 *
 * Three passes fill these in and each answers for a different vocabulary: the
 * engine's own `{round}`, `{stage}` and `{ticket}` on an effect field (below), a snapshot
 * path in a step's prompt (runner/step.ts), and `{vars.x}` from the
 * configuration at load (workflow/vars.ts). What they must agree on is the
 * *shape* of a name and what happens to one nobody answers for — it is left
 * visible, never blanked, so a typo shows up in the output instead of
 * vanishing from it. A second regex here is how one pass comes to recognise a
 * name the next one does not; this function was already deduplicated once for
 * that reason, between core's plan and the runner's prompt.
 *
 * The dot is admitted deliberately even though only two of the three
 * vocabularies use it: a name this pass does not recognise is left alone
 * anyway, so widening the pattern changes no output — it only stops
 * `{ticket.body}` meaning "a template" in one pass and "ordinary text" in
 * another.
 */
const TEMPLATE = /\{([a-zA-Z0-9_.]+)\}/g;

export const fillTemplate = (value: string, lookup: (name: string) => string | undefined): string =>
  value.replace(TEMPLATE, (whole, name: string) => lookup(name) ?? whole);

const expand = (value: unknown, vars: Record<string, string>): unknown =>
  typeof value === "string"
    ? fillTemplate(value, (k) => (Object.hasOwn(vars, k) ? String(vars[k]) : undefined))
    : value;

/**
 * An effect's fields, templated only with what the engine itself knows about
 * this entry or this invocation — the round, the stage id, the ticket's own
 * id, the already-validated output shape — never with snapshot content. The
 * id is identity rather than content: the engine locks, sandboxes and names
 * branches by it, and it has passed `ticketIdProblem` before anything is
 * planned for it. An effect is
 * structure, not prose: a marker assembled from a ticket body would be a
 * control token forged by whoever opened the ticket, which is exactly what
 * neutraliseMarkers exists to prevent downstream. An unrecognised `{name}` is
 * left visible, matching renderPrompt's "unknown path stays visible" rule
 * rather than silently vanishing.
 *
 * `Object.hasOwn`, not `vars[k] ?? whole`: the latter reads the prototype
 * chain, so `{toString}` resolved to `Object.prototype.toString` and got
 * stringified into the field — a live hole in the "only round, stage and
 * shape" claim, even though snapshot content genuinely could not reach it.
 *
 * One copy, here. This lived verbatim in core/plan.ts and runner/step.ts, two
 * agents solving one problem twice, with near-identical comments recording
 * the same prototype-chain hole — and they had already begun to diverge in
 * what they were handed. Two copies of a rule about what may reach a control
 * token is exactly the kind that rots silently: the next fix lands in one of
 * them.
 */
export const expandEffectFields = (
  effect: Record<string, unknown>,
  vars: Record<string, string>,
): Record<string, unknown> =>
  Object.fromEntries(Object.entries(effect).map(([k, v]) => [k, expand(v, vars)]));

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
export function planEffects(d: Decision, s: Snapshot, ticket: string | null): Effect[] {
  if (d.action !== "transition" || !d.to) return [];

  const to = d.to;
  const stage = to.id;
  const round = d.round ?? 1;
  // An argument, not `s.node.id`: what may reach an effect is decided by what
  // this function is handed, and the snapshot is handed to it for the graph.
  const vars = { round: String(round), stage, ...(ticket === null ? {} : { ticket }) };
  // Expanded once, in declaration order: a close declared first is applied
  // first, which is what the shipped workflow relies on — see its on_enter.
  const closes = planNodesClose(to, s, round);

  return (to.on_enter ?? []).map((effect) => {
    if (effect.type === NODES_CLOSE_EFFECT) return closes.shift() as Effect;
    return {
      ...expandEffectFields(effect, vars),
      // An effect type is a dispatch key, never templated text.
      type: effect.type,
      // Filled in rather than overwritten: an effect that names its own stage
      // or round means it, and silently retargeting it would be the engine
      // overruling the workflow about where a record belongs.
      ...(effect.stage === undefined ? { stage } : {}),
      ...(effect.round === undefined ? { round } : {}),
    };
  });
}

/**
 * The branch a stage's step works on, for this ticket and round — null for a
 * stage that names none — or why there cannot be one.
 *
 * The workflow names it, per stage, so a ticket has as many branches as its
 * stages say and the engine assumes none. Filled from the same three names an
 * effect may use and nothing else: a branch is argv for git, and a name this
 * does not recognise would otherwise stay in it as literal braces, which git
 * accepts. `landrace validate` asks this of every stage with an example ticket;
 * the runner asks it again with the real one, because a valid ticket id —
 * "a..b" — is not always a valid ref.
 */
export function stageBranch(
  stage: Stage,
  ticket: string,
  round: number,
): { ok: true; branch: string | null } | { ok: false; reason: string } {
  if (stage.branch === undefined) return { ok: true, branch: null };
  const vars: Record<string, string> = { ticket, stage: stage.id, round: String(round) };
  const unknown: string[] = [];
  const branch = fillTemplate(stage.branch, (name) => {
    if (Object.hasOwn(vars, name)) return vars[name];
    unknown.push(name);
    return undefined;
  });
  if (unknown.length) {
    return {
      ok: false,
      reason: `stage "${stage.id}" names its branch with {${unknown.join("}, {")}}; ` +
        "a branch is named from {ticket}, {stage} and {round} only",
    };
  }
  const problem = branchNameProblem(branch);
  return problem === null
    ? { ok: true, branch }
    : { ok: false, reason: `stage "${stage.id}" cannot name a branch for #${ticket}: ${problem}` };
}
