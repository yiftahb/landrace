import type { Entry, Run } from "./types.js";

/**
 * Everything the engine knows about a ticket's progress, computed from entries.
 * Nothing here is stored: recovery is re-derivation.
 */
export function deriveRun(entries: Entry[], stage: string | null): Run {
  const ordered = [...entries].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const outputsByStage = new Map<string, Entry>();
  const roundsByStage = new Map<string, Set<number>>();

  for (const e of ordered) {
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
   * (stage, round), not by which entry has the latest timestamp.
   */
  const currentOutput = stage !== null ? outputsByStage.get(stage) : undefined;
  const currentRound = currentOutput?.round;
  const lastOutputValid =
    currentRound === undefined
      ? null
      : ordered.some((e) => e.stage === stage && e.kind === "malformed" && e.round === currentRound)
        ? false
        : null;

  const unblockedAt = ordered
    .filter((e) => e.kind === "unblocked")
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
