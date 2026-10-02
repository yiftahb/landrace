import {
  AGENT_BY, CLEAR_KIND, ENTRY_KIND, MALFORMED_KIND, OUTPUT_KIND, PAIR_KIND, REFUSED_KIND, RELEASE_KIND, labelsOf, stageFromLabels,
} from "#conventions.js";
import { locate } from "#core/locate.js";
import type { Entry, Node, Run, Snapshot, StageRounds, Workflow } from "#namespace.js";

/**
 * The run read again from the stage an identity places the item at, for an
 * item with no `lr:stage:` label, because `deriveRun` scopes a goto, a refusal
 * and the entry record to the stage it is handed and a label-less item is
 * handed none. A label naming a stage is never overridden, and the new reading
 * is kept only if it leaves the item at the stage it was found at.
 */
export function locatedRun(w: Workflow, s: Snapshot): Run {
  const labelled = s.run as Run;
  if (stageFromLabels(labelsOf(s.node as Node | undefined)).found.length > 0) return labelled;
  const where = locate(w, s);
  if (where.kind !== "at") return labelled;
  const placed = deriveRun(s.entries ?? [], where.stage.id);
  const again = locate(w, { ...s, run: placed });
  return again.kind === "at" && again.stage.id === where.stage.id ? placed : labelled;
}

/**
 * Everything the engine knows about an item's progress, computed from entries.
 * Nothing here is stored: recovery is re-derivation.
 */
export function deriveRun(entries: Entry[], stage: string | null): Run {
  const ordered = [...entries].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const outputsByStage = new Map<string, Entry>();
  const roundsByStage = new Map<string, Set<number>>();
  const settledRoundsByStage = new Map<string, Set<number>>();
  const maxRejectedRoundByStage = new Map<string, number>();
  const maxRefusedRoundByStage = new Map<string, number>();
  const maxEnteredRoundByStage = new Map<string, number>();

  const note = (map: Map<string, Set<number>>, stage: string, round: number): void => {
    const rounds = map.get(stage) ?? new Set<number>();
    rounds.add(round);
    map.set(stage, rounds);
  };

  const raise = (map: Map<string, number>, stage: string, round: number): void => {
    const cur = map.get(stage);
    if (cur === undefined || round > cur) map.set(stage, round);
  };

  for (const e of ordered) {
    // A refusal is a rejection like any other — the same hard fail, the same
    // settled round — and is remembered apart only so lastRefused can say so.
    if (e.kind === MALFORMED_KIND || e.kind === REFUSED_KIND) {
      raise(maxRejectedRoundByStage, e.stage, e.round);
      if (e.kind === REFUSED_KIND) raise(maxRefusedRoundByStage, e.stage, e.round);
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
   * the item changed, and the trigger that handed it back fired again on the
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
   * that never loops — and every item already in flight when entry records
   * were introduced — assessed exactly as before: any output means complete.
   * Null-prototype for the same reason `outputs` is.
   */
  const rounds = Object.create(null) as Run["rounds"];
  for (const s of new Set([...roundsByStage.keys(), ...maxEnteredRoundByStage.keys()])) {
    // Folded rather than `Math.max(...set)`: the set is as long as the
    // item's comment history, and a spread that long is an argument-count
    // limit waiting to be hit by a busy item.
    let output = 0;
    for (const r of roundsByStage.get(s) ?? []) output = Math.max(output, r);
    rounds[s] = { entered: maxEnteredRoundByStage.get(s) ?? 1, output } satisfies StageRounds;
  }

  const last = ordered.at(-1) ?? null;
  const lastHuman = [...ordered].reverse().find((e) => !e.byAgent) ?? null;

  /*
   * A rejection — a "malformed" or a "refused" entry — marks its own round as
   * invalid, regardless of whether it happens to be logged before or after the
   * "output" entry for that same round — a hook can write them in either
   * order. So validity is judged per (stage, round): compare the highest
   * rejected round to the highest output round for that stage, not by which
   * entry has the latest timestamp.
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
   * a trap — halting is a handoff, and replying takes the item back". A
   * rejection that outlived the round it judged made that handback a second
   * trap: the stage was failed for good, so nothing could re-invoke it, and
   * the item ping-ponged between blocked and the stage it was handed back to
   * until the pass cap. So a later entry record — which only a workflow's own
   * trigger can produce, never the engine on its own — puts the stage back to
   * pending for a *new* round. That is not the retry CLAUDE.md forbids: the
   * rejected round is still never re-run, and nothing reads a rejection as
   * "hasn't happened yet".
   */
  const failedStages: string[] = [];
  for (const [s, rejectedRound] of maxRejectedRoundByStage) {
    const outRound = outputsByStage.get(s)?.round ?? -Infinity;
    // A stage that records no entry at all reads as entered once, exactly as
    // `rounds` does — for it, this is the old rule unchanged.
    const enteredRound = maxEnteredRoundByStage.get(s) ?? 1;
    if (rejectedRound >= outRound && rejectedRound >= enteredRound) failedStages.push(s);
  }
  const lastOutputValid: false | null = stage !== null && failedStages.includes(stage) ? false : null;

  /*
   * Of that failure, whether the round it judges was refused. The failing
   * round is the stage's highest rejected one, so a refusal handed back and
   * followed by a broken contract reads as the contract, which is what the
   * person is now looking at. One invocation writes one verdict; should a
   * round ever carry both, the refusal is what it reads as — a security
   * verdict a person has not seen is the costlier one to hide, and this is a
   * rule about the set of records, not about which came first.
   */
  const lastRefused: boolean | null = lastOutputValid === false && stage !== null
    ? maxRefusedRoundByStage.get(stage) === maxRejectedRoundByStage.get(stage)
    : null;

  /** Per-stage: an unblock recorded against a different stage must not reset this one's budget. */
  const unblockedAt = ordered
    .filter((e) => e.kind === "unblocked" && e.stage === stage)
    .reduce((max, e) => Math.max(max, e.round), 0);

  /*
   * A goto is pending from when it is written until the item next enters a
   * stage. Position in the ordered list, not timestamps: a tracker can stamp
   * comments to the second, a goto and the entry that consumes it can share
   * one, and the stable sort above keeps the order the tracker listed them in.
   *
   * It is also scoped to the stage that wrote it. A decline leaves it
   * unconsumed, and a trigger can then carry the item on to a stage that
   * writes no entry record of its own — `blocked`, a terminal `done`. Read
   * back there, a goto whose reason and cap belonged to the stage it was
   * declined at would be judged again against a stage nobody sent it from:
   * taken past the cap it was declined under, halted for a target the new
   * stage never lists, or left decorating a wait with a stale reason. So it
   * answers only while `stage` — the position passed in, i.e. the item's
   * own current one — is the stage the record naming it was written at;
   * anywhere else it reads as already consumed.
   */
  let goto: string | null = null;
  let gotoStage: string | null = null;
  for (const e of ordered) {
    if (e.kind === ENTRY_KIND) {
      goto = null;
      gotoStage = null;
    } else if (e.byAgent && e.goto !== undefined) {
      goto = e.goto;
      gotoStage = e.stage;
    }
  }
  if (gotoStage !== stage) goto = null;

  /*
   * A clearance holds from when it is written until anyone writes after it:
   * a comment made later reaches the cleared round's prompt, and a person
   * cleared only what they had read. Position, not timestamps, for the reason
   * the goto above gives.
   */
  let cleared: Run["cleared"] = null;
  for (const e of ordered) {
    if (!e.byAgent) cleared = null;
    else if (e.kind === CLEAR_KIND) cleared = { stage: e.stage, round: e.round };
  }

  /*
   * Only the current stage's own entry record answers "where did it come
   * from". A stage that writes none — every stage where it is a person's
   * turn — would otherwise read the `from` of whatever step ran before it,
   * which names the wrong stage with complete confidence.
   */
  const lastEntry = [...ordered].reverse().find((e) => e.kind === ENTRY_KIND);
  const previousStage = lastEntry !== undefined && lastEntry.stage === stage ? lastEntry.from ?? null : null;

  /*
   * The failure that put the item here, which is the step it last left.
   * `failedStages` alone answered "what has failed and not run since", and
   * that outlives being routed around: spec fails, a person sends the item
   * on to build, the reviews run out and it halts again — spec is still
   * listed, and Retry, reading the list, paid for a spec round nobody asked
   * for. Only the latest stage the item was in before this one can have
   * put it here; anything older it has since left behind.
   *
   * Two kinds of entry are walked past. The current stage's own, so the judge
   * reading a reply to a halt — entered from `blocked` — is still told what
   * failed before it. And a round trip from here that settled: a question at
   * a halt goes through the judge and comes home, and read as "the stage it
   * last left", that made Retry answer "nothing has failed" to the ordinary
   * conversation at a halt. A round trip whose stage failed is not walked
   * past — a goto from the halt whose step failed again is what put it here.
   *
   * Round trips from the *current visit* only: those newer than this stage's
   * own latest entry. An earlier visit also sent the item on from here — a
   * judge's goto-spec after a failed build — and walked past as a round trip,
   * that move let the judge's next visit, at spec-human-review, be told the
   * build had failed. A stage that records no entry — a halt — leaves no
   * visit to scope by, so every settled trip from it is walked past; one from
   * an earlier visit is reached only when the item came back with no other
   * stage's entry in between, since any such entry ends the walk first.
   */
  const ownEntry = ordered.findLastIndex((e) => e.kind === ENTRY_KIND && e.stage === stage);
  const leftLast = ordered.findLast((e, i) =>
    e.kind === ENTRY_KIND &&
    e.stage !== stage &&
    !(stage !== null && i > ownEntry && e.from === stage && !failedStages.includes(e.stage)));
  const failedStage = leftLast !== undefined && failedStages.includes(leftLast.stage) ? leftLast.stage : null;

  /*
   * The pairing open now. Position in the ordered list, like a goto, because
   * a release closes the pairing open when it was written and no later one:
   * a person who releases and then pairs again at the same round has a
   * second pairing, numbered two, which that release says nothing about. An
   * output at its round or later closes it wherever it sits — none can come
   * before it, since a pairing starts at a round still owed. A rejected round
   * does not: a refused hand-in leaves the pairing to be finished again.
   */
  let pairing: Run["pairing"] = null;
  const pairsAt = new Map<string, number>();
  for (const e of ordered) {
    if (e.kind === PAIR_KIND) {
      const key = `${e.stage}:${e.round}`;
      const n = (pairsAt.get(key) ?? 0) + 1;
      pairsAt.set(key, n);
      pairing = { stage: e.stage, round: e.round, n, at: e.at };
    } else if (e.kind === RELEASE_KIND && pairing !== null && e.stage === pairing.stage && e.round === pairing.round) {
      pairing = null;
    }
  }
  const open = pairing;
  if (open !== null && [...(roundsByStage.get(open.stage) ?? [])].some((r) => r >= open.round)) pairing = null;

  const lastOutput = ordered.findLast((e) => e.kind === OUTPUT_KIND);
  const lastOutputBy = lastOutput === undefined ? null : lastOutput.by ?? AGENT_BY;

  return {
    stage,
    counters,
    outputs,
    lastEvent: { actor: last ? (last.byAgent ? "agent" : "human") : null, at: last?.at ?? null },
    lastHuman,
    lastOutputValid,
    lastRefused,
    goto,
    cleared,
    previousStage,
    failedStages,
    failedStage,
    rounds,
    unblockedAt,
    pairing,
    lastOutputBy,
  };
}
