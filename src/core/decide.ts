import { assess } from "./assess.js";
import { checkEligible } from "./eligible.js";
import { locate } from "./locate.js";
import { compile } from "./predicate.js";
import type { Decision, Run, Snapshot, Workflow } from "./types.js";

export function decide(w: Workflow, s: Snapshot): Decision {
  const eligibility = checkEligible(w, s);
  if (!eligibility.eligible) return { action: "skip", why: eligibility.reason };

  const run = (s.run ?? { counters: {} }) as Run;
  /*
   * The round a stage is about to work on, derived by counting its own
   * output records and never by incrementing anything. It numbers both the
   * invocation and the entry record planEffects stamps on the state being
   * entered, which is what keeps the two in step: a stage that has been
   * entered but has produced nothing re-plans the same round, so a crash
   * between the two leaves one entry record, not two.
   */
  const nextRound = (stage: string): number => (run.counters[stage] ?? 0) + 1;

  const where = locate(w, s);
  if (where.kind === "ambiguous") {
    return { action: "halt", why: `cannot place the ticket: ${where.ids.join(", ")} all match` };
  }
  if (where.kind === "none") {
    const entry = w.stages.find((x) => x.entry);
    if (!entry) return { action: "halt", why: "the workflow has no entry stage" };
    return { action: "transition", to: entry, trigger: "entry", round: nextRound(entry.id) };
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
