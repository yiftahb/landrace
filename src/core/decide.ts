import { assess } from "#core/assess.js";
import { checkEligible } from "#core/eligible.js";
import { locate } from "#core/locate.js";
import { compile } from "#core/predicate.js";
import type { Decision, Run, Snapshot, Stage, Workflow } from "#namespace.js";

/**
 * What a ticket has done that an entry stage's own first round cannot
 * account for.
 *
 * Every stage the ticket has been recorded as entering, plus every stage that
 * has settled a round — an output, or a rejection. An entry stage at round
 * one is deliberately not history: entering it is the very thing being
 * considered, and its record landing without the position that belongs beside
 * it is the ordinary crash this design already recovers from. *Every* entry
 * stage, not only the first: a child whose first entry into `build` crashed
 * before its label landed is exactly as recoverable as a top-level ticket
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
 * Which entry stage a ticket with no position starts at.
 *
 * One entry stage is entered unconditionally, its triggers unread — that is
 * the rule every workflow written before this one relies on, including the
 * ones whose entry stage carries only loop-back triggers that cannot hold on a
 * fresh ticket. Reading them now would halt every such workflow's first
 * ticket.
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
  if (!only) return { why: `no entry stage accepts this ticket (tried: ${entries.map((e) => e.id).join(", ")})` };
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
    return { action: "halt", why: `cannot place the ticket: ${where.ids.join(", ")} all match` };
  }
  if (where.kind === "none") {
    const entries = w.stages.filter((x) => x.entry);
    if (entries.length === 0) return { action: "halt", why: "the workflow has no entry stage" };
    /*
     * "No position" is the same thing as "a new ticket" only when the ticket
     * has no run behind it either. Position is one value written by a swap
     * that is not atomic, so losing it costs a crash, a 502 on the add, or a
     * person with triage rights — and reading that as fresh restarted a
     * ticket that had finished a build, four review rounds and three fix
     * rounds: a fresh paid entry step, the spec republished over the old one,
     * and the whole run still on the ticket, unread.
     *
     * Recovery is re-derivation, and here there is nothing left to re-derive
     * from — the one record that said where the ticket was is gone. So this
     * halts for a person the way every other thing the engine cannot tell
     * halts, rather than guessing the cheapest-looking answer and spending
     * money on it. Asked before an entry stage is chosen, because the answer
     * does not depend on which one would be.
     */
    const behind = history(run, new Set(entries.map((e) => e.id)));
    if (behind.length) {
      return {
        action: "halt",
        why: `the ticket has already run ${behind.join(", ")} but has no position: ` +
          "it is not a new ticket, and where it belongs cannot be derived",
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
    return {
      action: "invoke",
      stage,
      subState,
      step: stage.step as string,
      round: nextRound(stage.id),
    };
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
    return { action: "halt", stage, subState, why: `ambiguous triggers: ${listed}` };
  }

  const only = matches[0];
  if (!only) return { action: "wait", stage, subState, why: "no trigger matched" };

  return { action: "transition", stage, subState, to: only.to, trigger: only.trigger, round: nextRound(only.to.id) };
}
