import { ENTRY_KIND, OUTPUT_KIND } from "../conventions.js";
import type { Entry, Run, StageRounds } from "./types.js";

/**
 * Everything the engine knows about a ticket's progress, computed from entries.
 * Nothing here is stored: recovery is re-derivation.
 */
export function deriveRun(entries: Entry[], stage: string | null): Run {
  const ordered = [...entries].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const outputsByStage = new Map<string, Entry>();
  const roundsByStage = new Map<string, Set<number>>();
  const maxMalformedRoundByStage = new Map<string, number>();
  const maxEnteredRoundByStage = new Map<string, number>();

  for (const e of ordered) {
    if (e.kind === "malformed") {
      const cur = maxMalformedRoundByStage.get(e.stage);
      if (cur === undefined || e.round > cur) maxMalformedRoundByStage.set(e.stage, e.round);
    }

    /*
     * A stage's own on_enter writes these, so entering a state twice is a
     * fact on the tracker rather than something the engine remembers. Only
     * the highest round matters, and two records naming the same round are
     * one entry: the round comes from the *output* counter, so a crash
     * between posting this and running the step replans the identical round.
     */
    if (e.kind === ENTRY_KIND) {
      const cur = maxEnteredRoundByStage.get(e.stage);
      if (cur === undefined || e.round > cur) maxEnteredRoundByStage.set(e.stage, e.round);
    }

    if (e.kind !== OUTPUT_KIND) continue;
    const rounds = roundsByStage.get(e.stage) ?? new Set<number>();
    rounds.add(e.round);
    roundsByStage.set(e.stage, rounds);

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
  const counters = Object.create(null) as Run["counters"];
  for (const [s, rounds] of roundsByStage) counters[s] = rounds.size;

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
   */
  const failedStages: string[] = [];
  for (const s of new Set([...outputsByStage.keys(), ...maxMalformedRoundByStage.keys()])) {
    const outRound = outputsByStage.get(s)?.round;
    const malRound = maxMalformedRoundByStage.get(s);
    if ((malRound ?? -Infinity) >= (outRound ?? -Infinity)) failedStages.push(s);
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
