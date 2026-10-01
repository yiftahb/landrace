import { GOTO_TRIGGER } from "#conventions.js";
import { assess } from "#core/assess.js";
import { checkEligible } from "#core/eligible.js";
import { gotoDeclined, gotoNotListed } from "#core/goto.js";
import { locate } from "#core/locate.js";
import { compile } from "#core/predicate.js";
import type { Decision, Run, Snapshot, Stage, Workflow } from "#namespace.js";

/**
 * What an item has done that an entry stage's own first round cannot
 * account for.
 *
 * Every stage the item has been recorded as entering, plus every stage that
 * has settled a round — an output, or a rejection. An entry stage at round
 * one is deliberately not history: entering it is the very thing being
 * considered, and its record landing without the position that belongs beside
 * it is the ordinary crash this design already recovers from. *Every* entry
 * stage, not only the first: a child whose first entry into `build` crashed
 * before its label landed is exactly as recoverable as a top-level item
 * whose entry into `spec` did.
 */
function history(run: Run, entryIds: ReadonlySet<string>): string[] {
  const settled = Object.entries(run.counters ?? {}).filter(([, n]) => n > 0).map(([id]) => id);
  const entered = Object.keys(run.rounds ?? {});
  return [...new Set([...entered, ...settled])]
    .filter((id) => !entryIds.has(id) || (run.counters[id] ?? 0) > 0)
    .sort();
}

/**
 * Which entry stage an item with no position starts at.
 *
 * One entry stage is entered unconditionally, its triggers unread — that is
 * the rule every workflow written before this one relies on, including the
 * ones whose entry stage carries only loop-back triggers that cannot hold on a
 * fresh item. Reading them now would halt every such workflow's first
 * item.
 *
 * Several are chosen between by their triggers, and only by their triggers.
 * No match is a halt, not a fall back to the first one declared: a child the
 * workflow has no start for would otherwise be run through the whole planning
 * phase its breakdown was meant to spare it. Two matches is a halt too, for
 * the reason it is everywhere else.
 */
function pickEntry(entries: Stage[], s: Snapshot): { to: Stage; trigger: string } | { why: string } {
  const [sole] = entries;
  if (entries.length === 1 && sole) return { to: sole, trigger: "entry" };

  const matches = entries.flatMap((stage) =>
    (stage.triggers ?? [])
      .filter((t) => compile(t.when)(s))
      .map((t) => ({ to: stage, trigger: t.name ?? stage.id })),
  );
  const [only, ...rest] = matches;
  if (!only) return { why: `no entry stage accepts this item (tried: ${entries.map((e) => e.id).join(", ")})` };
  if (rest.length > 0) {
    return { why: `ambiguous entry: ${matches.map((m) => `${m.to.id} (${m.trigger})`).join(", ")}` };
  }
  return only;
}

export function decide(w: Workflow, s: Snapshot): Decision {
  const eligibility = checkEligible(w, s);
  if (!eligibility.eligible) return { action: "skip", why: eligibility.reason };

  const run = (s.run ?? { counters: {} }) as Run;
  /*
   * The round a stage is about to work on, derived by counting the rounds it
   * has already settled — an output, or a rejection — and never by
   * incrementing anything. It numbers both the invocation and the entry
   * record planEffects stamps on the state being entered, which is what keeps
   * the two in step: a stage that has been entered but has settled nothing
   * re-plans the same round, so a crash between the two leaves one entry
   * record, not two. A rejected round counts, or a stage that can no longer
   * produce output would re-enter at the same round for ever (derive.ts).
   */
  const nextRound = (stage: string): number => (run.counters[stage] ?? 0) + 1;

  const where = locate(w, s);
  if (where.kind === "ambiguous") {
    return { action: "halt", why: `cannot place the item: ${where.ids.join(", ")} all match` };
  }
  if (where.kind === "none") {
    const entries = w.stages.filter((x) => x.entry);
    if (entries.length === 0) return { action: "halt", why: "the workflow has no entry stage" };
    /*
     * "No position" is the same thing as "a new item" only when the item
     * has no run behind it either. Position is one value written by a swap
     * that is not atomic, so losing it costs a crash, a 502 on the add, or a
     * person with triage rights — and reading that as fresh restarted a
     * item that had finished a build, four review rounds and three fix
     * rounds: a fresh paid entry step, the spec republished over the old one,
     * and the whole run still on the item, unread.
     *
     * Recovery is re-derivation, and here there is nothing left to re-derive
     * from — the one record that said where the item was is gone. So this
     * halts for a person the way every other thing the engine cannot tell
     * halts, rather than guessing the cheapest-looking answer and spending
     * money on it. Asked before an entry stage is chosen, because the answer
     * does not depend on which one would be.
     */
    const behind = history(run, new Set(entries.map((e) => e.id)));
    if (behind.length) {
      return {
        action: "halt",
        why: `the item has already run ${behind.join(", ")} but has no position: ` +
          "it is not a new item, and where it belongs cannot be derived",
      };
    }
    const picked = pickEntry(entries, s);
    if ("why" in picked) return { action: "halt", why: picked.why };
    return { action: "transition", to: picked.to, trigger: picked.trigger, round: nextRound(picked.to.id) };
  }

  const stage = where.stage;
  if (stage.requires && !compile(stage.requires)(s)) {
    return { action: "halt", stage, why: `precondition for "${stage.id}" is not satisfied` };
  }

  const subState = assess(s, stage);

  // A rejected output is routed by a trigger like any other fact, so the
  // workflow decides where it goes. It is never retried.
  if (subState === "pending") {
    // A person is working this round with the agent in their own session:
    // the stage never runs alone while they are, however long that takes.
    const paired = run.pairing ?? null;
    if (paired !== null && paired.stage === stage.id) {
      return {
        action: "wait", stage, subState, paired,
        why: `a person is pairing on "${stage.id}", round ${paired.round}`,
      };
    }
    return {
      action: "invoke",
      stage,
      subState,
      step: stage.step as string,
      round: nextRound(stage.id),
    };
  }

  /*
   * A person's explicit instruction, never one candidate among the triggers:
   * taken before them, so it cannot be ambiguous with one, and after the
   * step above, so a round that was owed reaches its verdict rather than
   * being abandoned. A target the stage does not list is a workflow or a
   * command that should never have written it, and halts. One the list names
   * but whose `when` does not hold is declined: the decision is left to the
   * stage's own triggers below, neither retried nor halted here. That is not
   * a guarantee the item has somewhere to go — a workflow that wants the
   * reply to come home once the cap is hit must give this stage a trigger
   * that says so, or the item only waits.
   */
  let declined: string | null = null;
  if (run.goto) {
    const to = w.stages.find((x) => x.id === run.goto);
    if (!to) {
      return {
        action: "halt", stage, subState,
        why: `"${stage.id}" was asked to send an item to "${run.goto}", which is not a stage of this workflow`,
      };
    }
    const unlisted = gotoNotListed(stage, to.id);
    if (unlisted) return { action: "halt", stage, subState, why: unlisted };
    declined = gotoDeclined(stage, s, to.id);
    if (declined === null) {
      return { action: "transition", stage, subState, to, trigger: GOTO_TRIGGER, round: nextRound(to.id) };
    }
  }

  const matches = w.stages.flatMap((candidate) =>
    candidate.id === stage.id
      ? []
      : (candidate.triggers ?? [])
          .filter((t) => compile(t.when)(s))
          .map((t) => ({ to: candidate, trigger: t.name ?? candidate.id })),
  );

  if (matches.length > 1) {
    const listed = matches.map((m) => `${m.to.id} (${m.trigger})`).join(", ");
    const why = `ambiguous triggers: ${listed}`;
    return { action: "halt", stage, subState, why: declined ? `${why}; ${declined}` : why };
  }

  const only = matches[0];
  if (!only) return { action: "wait", stage, subState, why: declined ? `no trigger matched; ${declined}` : "no trigger matched" };

  return { action: "transition", stage, subState, to: only.to, trigger: only.trigger, round: nextRound(only.to.id) };
}
