import type { Entry, Run } from "./types.js";

/**
 * Everything the engine knows about a ticket's progress, computed from entries.
 * Nothing here is stored: recovery is re-derivation.
 */
export function deriveRun(entries: Entry[], stage: string | null): Run {
  const ordered = [...entries].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const outputsByStage = new Map<string, Entry>();
  const roundsByStage = new Map<string, Set<number>>();
  const maxMalformedRoundByStage = new Map<string, number>();

  for (const e of ordered) {
    if (e.kind === "malformed") {
      const cur = maxMalformedRoundByStage.get(e.stage);
      if (cur === undefined || e.round > cur) maxMalformedRoundByStage.set(e.stage, e.round);
    }

    if (e.kind !== "output") continue;
    const rounds = roundsByStage.get(e.stage) ?? new Set<number>();
    rounds.add(e.round);
    roundsByStage.set(e.stage, rounds);

    const current = outputsByStage.get(e.stage);
    if (!current || e.round >= current.round) outputsByStage.set(e.stage, e);
  }

  const counters: Run["counters"] = {};
  for (const [s, rounds] of roundsByStage) counters[s] = rounds.size;

  const outputs: Run["outputs"] = {};
  for (const [s, e] of outputsByStage) outputs[s] = e.data;

  const last = ordered.at(-1) ?? null;
  const lastHuman = [...ordered].reverse().find((e) => !e.byAgent) ?? null;

  /*
   * A "malformed" entry marks its own round as invalid, regardless of whether
   * it happens to be logged before or after the "output" entry for that same
   * round — a hook can write them in either order. So validity is judged per
   * (stage, round): compare the highest malformed round to the highest output
   * round for the current stage, not by which entry has the latest timestamp.
   *
   * A stage can also be rejected with no output entry at all — a step whose
   * output fails its contract gets a "malformed" entry *instead of* an
   * output entry. Treating a missing round as -Infinity, rather than as "no
   * verdict", is what keeps that case invalid instead of silently retried.
   */
  const outRound = stage !== null ? outputsByStage.get(stage)?.round : undefined;
  const malRound = stage !== null ? maxMalformedRoundByStage.get(stage) : undefined;
  const lastOutputValid =
    outRound === undefined && malRound === undefined
      ? null
      : (malRound ?? -Infinity) >= (outRound ?? -Infinity)
        ? false
        : null;

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
    unblockedAt,
  };
}
