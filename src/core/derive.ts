import { ENTRY_KIND, OUTPUT_KIND } from "#conventions.js";
import type { Entry, Run, StageRounds } from "#namespace.js";

/**
 * Everything the engine knows about a ticket's progress, computed from entries.
 * Nothing here is stored: recovery is re-derivation.
 */
export function deriveRun(entries: Entry[], stage: string | null): Run {
  const ordered = [...entries].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const outputsByStage = new Map<string, Entry>();
  const roundsByStage = new Map<string, Set<number>>();
  const settledRoundsByStage = new Map<string, Set<number>>();
  const maxMalformedRoundByStage = new Map<string, number>();
  const maxEnteredRoundByStage = new Map<string, number>();

  const note = (map: Map<string, Set<number>>, stage: string, round: number): void => {
    const rounds = map.get(stage) ?? new Set<number>();
    rounds.add(round);
    map.set(stage, rounds);
  };

  for (const e of ordered) {
    if (e.kind === "malformed") {
      const cur = maxMalformedRoundByStage.get(e.stage);
      if (cur === undefined || e.round > cur) maxMalformedRoundByStage.set(e.stage, e.round);
      note(settledRoundsByStage, e.stage, e.round);
    }

    /*
     * A stage's own on_enter writes these, so entering a state twice is a
     * fact on the tracker rather than something the engine remembers. Only
     * the highest round matters, and two records naming the same round are
     * one entry: the round comes from the counter below, so a crash between
     * posting this and running the step replans the identical round.
     */
    if (e.kind === ENTRY_KIND) {
      const cur = maxEnteredRoundByStage.get(e.stage);
      if (cur === undefined || e.round > cur) maxEnteredRoundByStage.set(e.stage, e.round);
    }

    if (e.kind !== OUTPUT_KIND) continue;
    note(roundsByStage, e.stage, e.round);
    note(settledRoundsByStage, e.stage, e.round);

    const current = outputsByStage.get(e.stage);
    if (!current || e.round >= current.round) outputsByStage.set(e.stage, e);
  }

  /*
   * Null-prototype, because a stage id comes from outside: `outputs[s] = data`
   * with s = "__proto__" on an object literal writes the prototype of every
   * stage's outputs at once — invisible to Object.keys, yet read back by
   * `outputs.<anything>`. Reserved ids are also rejected at the marker
   * boundary; this half holds for any future path that reaches here. Nothing
   * downstream may call x.hasOwnProperty(k) on these — use Object.hasOwn or
   * `in`.
   */
  /*
   * A round counts once it has produced a verdict — an output, or a rejection.
   * Counting only outputs is what turned a rejected round into an infinite
   * loop: the round a re-entry stamps on its own entry record is this counter
   * plus one, so a stage that could never produce output re-entered at the
   * same round forever, the identical record was reconciled away, nothing on
   * the ticket changed, and the trigger that handed it back fired again on the
   * very next pass — 30 passes and 60 tracker writes per tick, for good.
   *
   * It is also what makes §11.4's bound a bound: a workflow writing
   * `run.counters.spec: { $lt: 3 }` on a handback trigger means "three
   * attempts", and an attempt that broke its contract is an attempt. A counter
   * only bounds a loop it advances on.
   *
   * A round that produced nothing at all still does not count, which is what
   * keeps the crash-recovery property: a crash between the entry record and
   * the step replans the identical round.
   */
  const counters = Object.create(null) as Run["counters"];
  for (const [s, rounds] of settledRoundsByStage) counters[s] = rounds.size;

  const outputs = Object.create(null) as Run["outputs"];
  for (const [s, e] of outputsByStage) outputs[s] = e.data;

  /*
   * How far each stage has got: entered against output. A stage with no
   * entry record at all reads as entered once, which is what keeps a stage
   * that never loops — and every ticket already in flight when entry records
   * were introduced — assessed exactly as before: any output means complete.
   * Null-prototype for the same reason `outputs` is.
   */
  const rounds = Object.create(null) as Run["rounds"];
  for (const s of new Set([...roundsByStage.keys(), ...maxEnteredRoundByStage.keys()])) {
    // Folded rather than `Math.max(...set)`: the set is as long as the
    // ticket's comment history, and a spread that long is an argument-count
    // limit waiting to be hit by a busy ticket.
    let output = 0;
    for (const r of roundsByStage.get(s) ?? []) output = Math.max(output, r);
    rounds[s] = { entered: maxEnteredRoundByStage.get(s) ?? 1, output } satisfies StageRounds;
  }

  const last = ordered.at(-1) ?? null;
  const lastHuman = [...ordered].reverse().find((e) => !e.byAgent) ?? null;

  /*
   * A "malformed" entry marks its own round as invalid, regardless of whether
   * it happens to be logged before or after the "output" entry for that same
   * round — a hook can write them in either order. So validity is judged per
   * (stage, round): compare the highest malformed round to the highest output
   * round for that stage, not by which entry has the latest timestamp.
   *
   * A stage can also be rejected with no output entry at all — a step whose
   * output fails its contract gets a "malformed" entry *instead of* an
   * output entry. Treating a missing round as -Infinity, rather than as "no
   * verdict", is what keeps that case invalid instead of silently retried.
   *
   * This is computed for every stage the entries mention, not only the
   * `stage` argument: assess() places a stage independently via locate()'s
   * identity predicates, which can diverge from `stage` (the tracker's own
   * notion of "current stage") when a workflow uses a custom identity. A
   * validity keyed only to `stage` would then answer assess()'s question
   * about a *different* stage — leaking one stage's rejection into another's
   * subState. failedStages is the per-stage answer; lastOutputValid keeps
   * answering the same single-stage question as before, for triggers that
   * read run.lastOutputValid directly and for snapshots built by hand
   * without a failedStages array.
   *
   * Failure is also scoped to the round the stage has actually been *entered*
   * for, not to the stage for the rest of its life. §2: "a terminal blocked is
   * a trap — halting is a handoff, and replying takes the ticket back". A
   * rejection that outlived the round it judged made that handback a second
   * trap: the stage was failed for good, so nothing could re-invoke it, and
   * the ticket ping-ponged between blocked and the stage it was handed back to
   * until the pass cap. So a later entry record — which only a workflow's own
   * trigger can produce, never the engine on its own — puts the stage back to
   * pending for a *new* round. That is not the retry CLAUDE.md forbids: the
   * rejected round is still never re-run, and nothing reads a rejection as
   * "hasn't happened yet".
   */
  const failedStages: string[] = [];
  for (const [s, malRound] of maxMalformedRoundByStage) {
    const outRound = outputsByStage.get(s)?.round ?? -Infinity;
    // A stage that records no entry at all reads as entered once, exactly as
    // `rounds` does — for it, this is the old rule unchanged.
    const enteredRound = maxEnteredRoundByStage.get(s) ?? 1;
    if (malRound >= outRound && malRound >= enteredRound) failedStages.push(s);
  }
  const lastOutputValid: false | null = stage !== null && failedStages.includes(stage) ? false : null;

  /** Per-stage: an unblock recorded against a different stage must not reset this one's budget. */
  const unblockedAt = ordered
    .filter((e) => e.kind === "unblocked" && e.stage === stage)
    .reduce((max, e) => Math.max(max, e.round), 0);

  return {
    stage,
    counters,
    outputs,
    lastEvent: { actor: last ? (last.byAgent ? "agent" : "human") : null, at: last?.at ?? null },
    lastHuman,
    lastOutputValid,
    failedStages,
    rounds,
    unblockedAt,
  };
}
