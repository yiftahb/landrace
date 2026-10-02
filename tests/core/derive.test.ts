import { deriveRun, locatedRun, nextRound } from "#core/derive.js";
import { assess } from "#core/assess.js";
import { stageFromLabels } from "#conventions.js";
import type { Entry, Node, Snapshot, Stage, Workflow } from "#namespace.js";

let t = 0;
const at = () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)).toISOString();
const out = (stage: string, round: number, data: unknown = {}): Entry =>
  ({ stage, kind: "output", round, data, at: at(), byAgent: true });
const human = (): Entry => ({ stage: "-", kind: "human", round: 0, at: at(), byAgent: false });
const malformed = (stage: string, round: number): Entry =>
  ({ stage, kind: "malformed", round, at: at(), byAgent: true });
const entered = (stage: string, round: number): Entry =>
  ({ stage, kind: "enter", round, at: at(), byAgent: true });
const refused = (stage: string, round: number): Entry =>
  ({ stage, kind: "refused", round, at: at(), byAgent: true });

describe("deriveRun", () => {
  it("counts rounds, not entries — two entries for one round are one round", () => {
    expect(deriveRun([out("spec", 1), out("spec", 1)], "spec").counters.spec).toBe(1);
  });

  it("counts distinct rounds per stage independently", () => {
    const r = deriveRun([out("spec", 1), out("spec", 2), out("review", 1)], "spec");
    expect(r.counters).toEqual({ spec: 2, review: 1 });
  });

  it("takes the highest round as the current output", () => {
    const r = deriveRun([out("spec", 1, { v: "old" }), out("spec", 2, { v: "new" })], "spec");
    expect(r.outputs.spec).toEqual({ v: "new" });
  });

  it("names who moved last", () => {
    expect(deriveRun([out("spec", 1)], "spec").lastEvent.actor).toBe("agent");
    expect(deriveRun([out("spec", 1), human()], "spec").lastEvent.actor).toBe("human");
    expect(deriveRun([], null).lastEvent.actor).toBeNull();
  });

  it("exposes the last human entry so a step can be given it", () => {
    const h = human();
    expect(deriveRun([out("spec", 1), h], "spec").lastHuman).toEqual(h);
  });

  it("marks output invalid when the current round was rejected, and null when it wasn't", () => {
    const bad: Entry = { stage: "spec", kind: "malformed", round: 1, at: at(), byAgent: true };
    expect(deriveRun([out("spec", 1), bad], "spec").lastOutputValid).toBe(false);
    expect(deriveRun([out("spec", 1)], "spec").lastOutputValid).toBeNull();
  });

  describe("lastOutputValid, judged per (stage, round)", () => {
    it("is false for a malformed round that shares its round with the current output", () => {
      expect(deriveRun([out("spec", 1), malformed("spec", 1)], "spec").lastOutputValid).toBe(false);
    });

    it("is false when a round was rejected and there is no output entry at all for it — a step must not silently re-run", () => {
      expect(deriveRun([malformed("spec", 1)], "spec").lastOutputValid).toBe(false);
    });

    it("clears back to null once a newer round produces a good output", () => {
      const bad = malformed("spec", 1);
      const good = out("spec", 2);
      expect(deriveRun([bad, good], "spec").lastOutputValid).toBeNull();
    });

    it("is false regardless of whether the malformed entry is timestamped before its output, same round", () => {
      const badFirst = malformed("spec", 1);
      const outputSecond = out("spec", 1);
      expect(deriveRun([badFirst, outputSecond], "spec").lastOutputValid).toBe(false);
    });
  });

  it("reads the unblock point so a returned item gets a fresh budget", () => {
    const unblocked: Entry = { stage: "spec", kind: "unblocked", round: 3, at: at(), byAgent: true };
    expect(deriveRun([out("spec", 3), unblocked], "spec").unblockedAt).toBe(3);
    expect(deriveRun([out("spec", 1)], "spec").unblockedAt).toBe(0);
  });

  it("does not let an unblock recorded on a different stage leak into this stage's budget", () => {
    const unblockedElsewhere: Entry = { stage: "review", kind: "unblocked", round: 5, at: at(), byAgent: true };
    expect(deriveRun([out("spec", 1), unblockedElsewhere], "spec").unblockedAt).toBe(0);
  });

  it("orders by timestamp, not array position", () => {
    const later = out("spec", 1);
    const earlier: Entry = { ...human(), at: "2025-01-01T00:00:00Z" };
    expect(deriveRun([later, earlier], "spec").lastEvent.actor).toBe("agent");
  });

  describe("rounds, counted from records and never incremented", () => {
    const enter = (stage: string, round: number): Entry =>
      ({ stage, kind: "enter", round, at: at(), byAgent: true });

    it("takes the highest round each kind of record names", () => {
      const r = deriveRun([enter("cr", 1), out("cr", 1), enter("cr", 2)], "cr");
      expect(r.rounds["cr"]).toEqual({ entered: 2, output: 1 });
    });

    /*
     * A stage that records no entry is treated as entered once, so every
     * stage that existed before entry records did keeps its old assessment:
     * any output at all means complete.
     */
    it("treats a stage with no entry record as entered exactly once", () => {
      expect(deriveRun([out("spec", 1)], "spec").rounds["spec"]).toEqual({ entered: 1, output: 1 });
      expect(deriveRun([out("spec", 7)], "spec").rounds["spec"]).toEqual({ entered: 1, output: 7 });
    });

    it("counts an entry record for a stage that has produced nothing yet", () => {
      expect(deriveRun([enter("cr", 1)], "cr").rounds["cr"]).toEqual({ entered: 1, output: 0 });
    });

    /*
     * Two records for one entry is the failure this design has to survive:
     * a crash between posting the entry and running the step re-plans the
     * same on_enter effect, and the round in it is derived from the *output*
     * counter, so the replan produces the same round. Counting distinct
     * rounds rather than records is the second half of that.
     */
    it("takes a repeated entry record for one round as one entry", () => {
      expect(deriveRun([enter("cr", 2), enter("cr", 2)], "cr").rounds["cr"]?.entered).toBe(2);
    });

    it("does not let an entry record advance the output counters the workflow bounds loops with", () => {
      const r = deriveRun([enter("cr", 1), out("cr", 1), enter("cr", 2)], "cr");
      expect(r.counters["cr"]).toBe(1);
    });

    it("keeps each stage's rounds to itself", () => {
      const r = deriveRun([enter("cr", 2), out("cr", 1), enter("fr", 1), out("fr", 1)], "cr");
      expect(r.rounds).toEqual({ cr: { entered: 2, output: 1 }, fr: { entered: 1, output: 1 } });
    });
  });

  describe("failedStages, exposed independently of the `stage` argument", () => {
    it("lists every stage with a rejected round, not only the one lastOutputValid answers for", () => {
      const r = deriveRun([out("spec", 1), malformed("review", 1)], "spec");
      expect(r.failedStages).toEqual(["review"]);
      // lastOutputValid still answers only for "spec", unaffected by review's rejection.
      expect(r.lastOutputValid).toBeNull();
    });

    it("agrees with lastOutputValid when assessing the stage the run was derived for", () => {
      const r = deriveRun([malformed("spec", 1)], "spec");
      expect(r.lastOutputValid).toBe(false);
      expect(r.failedStages).toContain("spec");
    });

    /*
     * The handback. A rejection judges the round it was written for, not the
     * stage forever: a later entry record — which only a workflow trigger can
     * produce — asks for a new round, and the stage has to be invocable again
     * or the item bounces between blocked and here until the pass cap.
     */
    it("clears once the stage has been entered again for a later round", () => {
      const r = deriveRun([entered("spec", 1), malformed("spec", 1), entered("spec", 2)], "spec");
      expect(r.failedStages).toEqual([]);
      expect(r.lastOutputValid).toBeNull();
      expect(assess({ run: r } as Snapshot, { id: "spec", step: "steps/spec.md" })).toBe("pending");
    });

    it("does not clear on a re-entry that names the same round, which is what a crash replans", () => {
      const r = deriveRun([entered("spec", 1), malformed("spec", 1)], "spec");
      expect(r.failedStages).toEqual(["spec"]);
      expect(assess({ run: r } as Snapshot, { id: "spec", step: "steps/spec.md" })).toBe("failed");
    });
  });

  /*
   * A refusal is a rejection a person reads differently: nothing was wrong
   * with the step's output, because the step was never let run — or ran and
   * was caught doing what it had not declared. Same failure, same scoping,
   * one more fact about it for a workflow to route on.
   */
  describe("lastRefused, beside lastOutputValid and scoped exactly as it is", () => {
    it("is true when the current stage's rejected round was refused", () => {
      const r = deriveRun([entered("build", 1), refused("build", 1)], "build");
      expect(r.lastOutputValid).toBe(false);
      expect(r.lastRefused).toBe(true);
    });

    it("is false when the current stage's rejected round broke its contract", () => {
      const r = deriveRun([entered("build", 1), malformed("build", 1)], "build");
      expect(r.lastOutputValid).toBe(false);
      expect(r.lastRefused).toBe(false);
    });

    it("is null when the current stage has no rejected round", () => {
      expect(deriveRun([entered("build", 1), out("build", 1)], "build").lastRefused).toBeNull();
      expect(deriveRun([], null).lastRefused).toBeNull();
    });

    it("answers for the current stage only, not for another stage's refusal", () => {
      const r = deriveRun([refused("build", 1), out("spec", 1)], "spec");
      expect(r.failedStages).toEqual(["build"]);
      expect(r.lastRefused).toBeNull();
    });

    it("clears exactly as failure does, once a later entry record asks for a new round", () => {
      const r = deriveRun([entered("build", 1), refused("build", 1), entered("build", 2)], "build");
      expect(r.lastOutputValid).toBeNull();
      expect(r.lastRefused).toBeNull();
    });

    it("reads the latest rejected round: a contract failure after a handed-back refusal is not a refusal", () => {
      const r = deriveRun(
        [entered("build", 1), refused("build", 1), entered("build", 2), malformed("build", 2)],
        "build",
      );
      expect(r.lastRefused).toBe(false);
    });

    it("counts a refused round toward the stage's counter, as any rejection does", () => {
      const r = deriveRun([entered("build", 1), refused("build", 1)], "build");
      expect(r.counters.build).toBe(1);
      expect(assess({ run: r } as Snapshot, { id: "build", step: "steps/build.md" })).toBe("failed");
    });
  });

  describe("counters count rounds that reached a verdict, good or rejected", () => {
    /*
     * The round a re-entry stamps on its own record is this counter plus one.
     * Counting only outputs left a rejected stage re-entering at the same
     * round forever, its identical entry record reconciled away — and left
     * `run.counters.spec: { $lt: 3 }` bounding a loop it never advanced.
     */
    it("advances on a rejected round", () => {
      expect(deriveRun([entered("spec", 1), malformed("spec", 1)], "spec").counters.spec).toBe(1);
    });

    it("counts a round that was both rejected and output once", () => {
      expect(deriveRun([malformed("spec", 1), out("spec", 1)], "spec").counters.spec).toBe(1);
    });

    it("does not advance on a round that produced nothing at all", () => {
      expect(deriveRun([entered("spec", 1)], "spec").counters.spec).toBeUndefined();
    });
  });
});

/*
 * The round a stage is entered or run at, from round numbers on its records:
 * the highest it was entered at and the highest it settled. A visit in
 * flight — the stage's own entry is the latest record of any entry, and
 * nothing settled it — is that same round, so a crash between the entry and
 * the position replans the identical record. Anything after it is a new
 * round: a stage with no step settles a round only when its way in is
 * refused, and re-entered at the round it last used, its entry would already
 * be there and reconcile away, leaving a refusal nothing could read.
 */
describe("the next round of a stage", () => {
  const from = (stage: string, round: number, left: string): Entry => ({ ...entered(stage, round), from: left });
  const rejected = (stage: string, round: number, left: string): Entry => ({ ...malformed(stage, round), from: left });

  it("is one for a stage with no records", () => {
    expect(nextRound(deriveRun([], null), "merge")).toBe(1);
  });

  it("is past the last settled round of a step", () => {
    const run = deriveRun([entered("build", 1), out("build", 1), from("code-review", 1, "build"), out("code-review", 1)], "code-review");
    expect([nextRound(run, "build"), nextRound(run, "code-review")]).toEqual([2, 2]);
  });

  it("is the same round while its visit is in flight: the step owed, or a crash before the position moved", () => {
    const owed = deriveRun([entered("build", 1), out("build", 1), from("build", 2, "ci")], "build");
    expect(nextRound(owed, "build")).toBe(2);
    const crashed = deriveRun([entered("build", 1), out("build", 1), from("publish", 1, "build")], "build");
    expect(nextRound(crashed, "publish")).toBe(1);
  });

  it("is a new round for a stage with no step entered again after another stage's entry", () => {
    const run = deriveRun([from("merge", 1, "ci"), from("code-review", 2, "merge"), out("code-review", 2)], "code-review");
    expect(nextRound(run, "merge")).toBe(2);
  });

  it("is past a refused round, from the halt as from anywhere", () => {
    const run = deriveRun([from("merge", 1, "ci"), from("code-review", 2, "merge"), from("merge", 2, "ci"), rejected("merge", 2, "ci")], "blocked");
    expect(nextRound(run, "merge")).toBe(3);
  });

  it("counts a stage's rounds apart from its counter, which counts only what settled", () => {
    const run = deriveRun([from("merge", 1, "ci"), from("code-review", 2, "merge"), from("merge", 2, "ci"), rejected("merge", 2, "ci")], "blocked");
    expect(run.counters.merge).toBe(1);
  });

  it("is counted from the counter for a run built without it", () => {
    expect(nextRound({ counters: { build: 2 } } as unknown as ReturnType<typeof deriveRun>, "build")).toBe(3);
    expect(nextRound(undefined, "build")).toBe(1);
  });
});

/*
 * An effect refused while the item was entering a stage: the stage's entry
 * record landed, then the forge or the tracker refused what came after it,
 * and the engine recorded the stage's round as rejected, saying where the
 * item was leaving from. The item is still there — the position was to be
 * written after the refused effect — so that is where the failure is read:
 * the way on from here was refused, and only a halt may take the item.
 */
describe("a way into a stage refused while the item was leaving another", () => {
  const from = (stage: string, round: number, left: string): Entry => ({ ...entered(stage, round), from: left });
  const rejected = (stage: string, round: number, left: string): Entry => ({ ...malformed(stage, round), from: left });
  const built = [entered("build", 1), out("build", 1, { kind: "done" })];

  it("reads as a failure at the stage it was leaving, a broken contract rather than a refusal", () => {
    const r = deriveRun([...built, from("publish", 1, "build"), rejected("publish", 1, "build")], "build");
    expect(r.lastOutputValid).toBe(false);
    expect(r.lastRefused).toBe(false);
  });

  it("counts the round it refused, and lists the stage among the failed", () => {
    const r = deriveRun([...built, from("publish", 1, "build"), rejected("publish", 1, "build")], "build");
    expect(r.counters.publish).toBe(1);
    expect(r.failedStages).toContain("publish");
    expect(r.failedStages).not.toContain("build");
  });

  it("is not read at the halt it led to, where Retry finds the stage it refused", () => {
    const r = deriveRun([...built, from("publish", 1, "build"), rejected("publish", 1, "build")], "blocked");
    expect(r.lastOutputValid).toBeNull();
    expect(r.failedStage).toBe("publish");
  });

  it("is not read where the entry landed and nothing was refused after it — an outage, or a crash", () => {
    expect(deriveRun([...built, from("publish", 1, "build")], "build").lastOutputValid).toBeNull();
  });

  /*
   * A step's own failure carries no `from`: a judge that broke its contract
   * at triage, entered from the halt, and was routed back to it. That is the
   * judge's failure, read at triage as it always was, not the halt's.
   */
  it("is not read for a step's own failure, which names no stage it was leaving", () => {
    const r = deriveRun([entered("build", 1), malformed("build", 1), human(), from("triage", 1, "blocked"), malformed("triage", 1)], "blocked");
    expect(r.lastOutputValid).toBeNull();
  });

  it("is not read for a refusal written leaving another stage", () => {
    expect(deriveRun([...built, from("publish", 1, "build"), rejected("publish", 1, "ci")], "build").lastOutputValid).toBeNull();
  });

  it("is over once the stage is entered again, and read again if that entry is refused too", () => {
    const first = [...built, from("publish", 1, "build"), rejected("publish", 1, "build")];
    const retried = deriveRun([...first, from("publish", 2, "blocked")], "publish");
    expect(retried.lastOutputValid).toBeNull();
    expect(retried.failedStages).not.toContain("publish");
    const again = deriveRun([...first, from("publish", 2, "blocked"), rejected("publish", 2, "blocked")], "blocked");
    expect(again.lastOutputValid).toBe(false);
    expect(again.failedStage).toBe("publish");
    expect(again.counters.publish).toBe(2);
  });

  it("is not read for an earlier round's refusal, once the stage was entered from here again", () => {
    const entries = [
      ...built, from("publish", 1, "build"), rejected("publish", 1, "build"),
      from("build", 2, "blocked"), out("build", 2, { kind: "done" }), from("publish", 2, "build"),
    ];
    expect(deriveRun(entries, "build").lastOutputValid).toBeNull();
  });

  /*
   * A Retry that met an outage on the way in — a 502, checks still running —
   * consumed its goto with the stage's entry record and left that round
   * unsettled, the item still at the halt. That way in never finished, and
   * it is what Retry must take again: walked past as a settled round trip, it
   * left Retry answering "nothing has failed" to an item no trigger moves.
   */
  it("names a way in from the halt that never finished, for Retry to take again", () => {
    const entries = [...built, from("publish", 1, "build"), rejected("publish", 1, "build"), from("publish", 2, "blocked")];
    const r = deriveRun(entries, "blocked");
    expect(r.failedStage).toBe("publish");
    expect(r.lastOutputValid).toBeNull();
    expect(nextRound(r, "publish")).toBe(2);
  });

  it("still walks past a round trip from the halt that settled", () => {
    const entries = [...built, from("publish", 1, "build"), rejected("publish", 1, "build"), human(), from("triage", 1, "blocked"), out("triage", 1, { intent: "question" })];
    expect(deriveRun(entries, "blocked").failedStage).toBe("publish");
  });

  it("is judged a refusal when the record says so", () => {
    const r = deriveRun([...built, from("publish", 1, "build"), { ...refused("publish", 1), from: "build" }], "build");
    expect(r.lastOutputValid).toBe(false);
    expect(r.lastRefused).toBe(true);
  });
});

describe("assess uses deriveRun's per-stage failedStages, not the stage lastOutputValid answers for", () => {
  // Regression for the bug verified in review: deriveRun is called with the
  // raw snapshot's own run.stage (here "spec"), but decide() places the
  // item independently via locate()'s identity predicates, which can name
  // a *different* stage (here "review") when a workflow uses a custom
  // identity. assess() must answer about the stage it is actually asked
  // about, not leak "spec"'s rejection into "review"'s subState.
  it("does not leak a different stage's rejection into the assessed stage's subState", () => {
    const entries = [malformed("spec", 1), out("review", 1)];
    const run = deriveRun(entries, "spec");
    const snapshot: Snapshot = { run } as Snapshot;
    const reviewStage: Stage = { id: "review", step: "steps/review.md" };
    expect(assess(snapshot, reviewStage)).toBe("complete");
  });

  it("still reports failed when assessing the stage that was actually rejected", () => {
    const entries = [malformed("spec", 1), out("review", 1)];
    const run = deriveRun(entries, "spec");
    const snapshot: Snapshot = { run } as Snapshot;
    const specStage: Stage = { id: "spec", step: "steps/spec.md" };
    expect(assess(snapshot, specStage)).toBe("failed");
  });
});

describe("run.goto, derived from records and consumed by entering a stage", () => {
  const going = (stage: string, to: string): Entry => ({ stage, kind: "goto", round: 0, goto: to, at: at(), byAgent: true });

  it("is the latest goto written since the item last entered a stage", () => {
    expect(deriveRun([entered("spec", 1), going("blocked", "spec"), going("blocked", "build")], "blocked").goto).toBe("build");
  });

  it("is consumed by the next entry record, whichever stage that enters", () => {
    expect(deriveRun([going("blocked", "build"), entered("build", 2)], "build").goto).toBeNull();
  });

  it("rides on a judge's own output record", () => {
    expect(deriveRun([entered("triage", 1), { ...out("triage", 1), goto: "spec" }], "triage").goto).toBe("spec");
  });

  it("is ignored when a person wrote it", () => {
    expect(deriveRun([{ ...going("blocked", "build"), byAgent: false }], "blocked").goto).toBeNull();
  });

  /*
   * GitHub stamps comments to the second. A goto and the entry that consumes
   * it can share one, and the tracker lists comments in the order they were
   * made — which the sort keeps, being stable.
   */
  it("orders a goto and an entry that share a second by the order they were listed in", () => {
    const same = "2026-02-01T00:00:00.000Z";
    const g = { ...going("blocked", "build"), at: same };
    const e = { ...entered("build", 2), at: same };
    expect(deriveRun([g, e], "build").goto).toBeNull();
    // The entry comes first here, so it is the goto — written at "blocked" —
    // that survives, and it answers only while the item is still there.
    expect(deriveRun([e, g], "blocked").goto).toBe("build");
  });

  it("is null when nothing asked", () => {
    expect(deriveRun([entered("spec", 1)], "spec").goto).toBeNull();
  });

  /*
   * A decline leaves a goto unconsumed, and a trigger can then carry the
   * item on to a stage — `blocked`, a terminal `done` — that writes no
   * entry record of its own. Read back there, the goto must not still
   * answer: it was written at "triage", not at the stage the item now
   * sits in, and nothing has consumed it in between.
   */
  it("is null once the position has moved on from the stage that wrote it, with no entry record in between", () => {
    const entries = [entered("triage", 1), { ...out("triage", 1), goto: "spec" }];
    expect(deriveRun(entries, "blocked").goto).toBeNull();
  });
});

/*
 * A person clearing a step the security check refused: one round of one
 * stage runs without the screener. Whatever anyone writes after the
 * clearance reaches that round's prompt, so it voids it — new text is
 * never waved through unread.
 */
describe("run.cleared, a person's clearance of the security check", () => {
  const clearing = (stage: string, round: number): Entry => ({ stage, kind: "cleared", round, at: at(), byAgent: true });

  it("names the stage and round the latest clearance covers", () => {
    const entries = [entered("spec", 1), refused("spec", 1), clearing("spec", 2), entered("spec", 2)];
    expect(deriveRun(entries, "spec").cleared).toEqual({ stage: "spec", round: 2 });
  });

  it("is void once anyone writes after it", () => {
    expect(deriveRun([refused("spec", 1), clearing("spec", 2), human()], "screened").cleared).toBeNull();
  });

  it("survives what was written before it — the message it was cleared after", () => {
    expect(deriveRun([refused("triage", 1), human(), clearing("triage", 2)], "screened").cleared)
      .toEqual({ stage: "triage", round: 2 });
  });

  it("is ignored when a person wrote it", () => {
    expect(deriveRun([{ ...clearing("spec", 2), byAgent: false }], "screened").cleared).toBeNull();
  });

  it("orders a clearance and a comment that share a second by the order they were listed in", () => {
    const same = "2026-02-01T00:00:00.000Z";
    const c = { ...clearing("spec", 2), at: same };
    const h = { ...human(), at: same };
    expect(deriveRun([c, h], "screened").cleared).toBeNull();
    expect(deriveRun([h, c], "screened").cleared).toEqual({ stage: "spec", round: 2 });
  });

  it("is null when nothing was cleared", () => {
    expect(deriveRun([entered("spec", 1), refused("spec", 1)], "screened").cleared).toBeNull();
  });
});

describe("run.previousStage, from the current stage's own entry record", () => {
  const from = (stage: string, round: number, left: string): Entry => ({ ...entered(stage, round), from: left });

  it("is the stage that record says the item left", () => {
    expect(deriveRun([from("spec", 1, "x"), from("triage", 1, "spec-human-review")], "triage").previousStage)
      .toBe("spec-human-review");
  });

  it("is null at a stage that records no entry, rather than an older stage's answer", () => {
    expect(deriveRun([from("build", 1, "triage")], "blocked").previousStage).toBeNull();
  });

  it("is null for an entry record written before entry records named where they came from", () => {
    expect(deriveRun([entered("triage", 1)], "triage").previousStage).toBeNull();
  });
});

/*
 * What Retry re-runs and what the judge is told failed: the failure that put
 * the item where it is, never an older one the item has since been sent
 * around. `failedStages` alone kept a spec that failed before a person sent
 * the item on to build, and Retry — reading it — paid for a spec round
 * after the reviews ran out, which nobody had asked for.
 */
describe("run.failedStage, the failure that put the item where it is", () => {
  const from = (stage: string, round: number, left: string): Entry => ({ ...entered(stage, round), from: left });
  const going = (stage: string, to: string): Entry => ({ stage, kind: "goto", round: 0, goto: to, at: at(), byAgent: true });

  it("is the step that failed, at the halt it failed into", () => {
    const entries = [entered("spec", 1), out("spec", 1), entered("build", 1), malformed("build", 1)];
    expect(deriveRun(entries, "blocked").failedStage).toBe("build");
  });

  /*
   * A reply at a halt goes through the judge and, unless it asks for a goto,
   * comes home. That round trip left from here and settled; it did not put
   * the item here. Read as "the stage it last left", Retry answered
   * "nothing has failed" to the ordinary conversation at a halt.
   */
  it("looks past a settled round trip from here — a question at the halt the judge sent home", () => {
    const failed = [entered("build", 1), malformed("build", 1)];
    const question = (round: number) => [human(), from("triage", round, "blocked"), out("triage", round, { intent: "question" })];
    expect(deriveRun([...failed, ...question(1)], "blocked").failedStage).toBe("build");
    expect(deriveRun([...failed, ...question(1), ...question(2)], "blocked").failedStage).toBe("build");
  });

  it("stops at a round trip from here that failed — a goto from the halt whose step failed again", () => {
    const entries = [
      entered("spec", 1), malformed("spec", 1),
      going("blocked", "build"), from("build", 1, "blocked"), malformed("build", 1),
    ];
    expect(deriveRun(entries, "blocked").failedStage).toBe("build");
  });

  /*
   * The round-trip skip is scoped to the current visit. A judge's earlier
   * visit also sent the item on *from triage* — goto-spec after a failed
   * build — and at the judge's next visit, read as a round trip, that move
   * was walked past and the judge at spec-human-review was told "build".
   */
  describe("a move an earlier visit to this stage made is not a round trip from this one", () => {
    const failedBuildThenGotoSpec = (spec: Entry[]) => [
      entered("build", 1), malformed("build", 1),
      human(), from("triage", 1, "blocked"), { ...out("triage", 1, { intent: "goto-spec" }), goto: "spec" },
      from("spec", 2, "triage"), ...spec,
    ];

    it("is null at the judge reading a reply to the spec that goto produced", () => {
      const entries = [...failedBuildThenGotoSpec([out("spec", 2, { kind: "spec" })]), human(), from("triage", 2, "spec-human-review")];
      expect(deriveRun(entries, "triage").failedStage).toBeNull();
    });

    it("is null at the judge reading answers to the questions that goto produced", () => {
      const entries = [...failedBuildThenGotoSpec([out("spec", 2, { kind: "questions" })]), human(), from("triage", 2, "spec-questions")];
      expect(deriveRun(entries, "triage").failedStage).toBeNull();
    });

    it("is the spec the goto re-ran when it failed, at the judge reading the reply to that halt", () => {
      const failedAgain = [...failedBuildThenGotoSpec([malformed("spec", 2)]), human()];
      expect(deriveRun(failedAgain, "blocked").failedStage).toBe("spec");
      expect(deriveRun([...failedAgain, from("triage", 2, "blocked")], "triage").failedStage).toBe("spec");
    });
  });

  it("is null once the item was sent on past an older failure and came back for another reason", () => {
    // The walk stops at the last review round: entered from another stage,
    // and not failed. The build before it was a round trip from the halt,
    // but the reviews came in between.
    // Built in the order they happen: `at()` stamps each as it is made.
    const entries = [
      entered("spec", 1), malformed("spec", 1), entered("spec", 2), malformed("spec", 2),
      going("blocked", "build"), from("build", 1, "blocked"), out("build", 1, { kind: "done" }),
    ];
    for (const round of [1, 2, 3, 4]) {
      entries.push(from("code-review", round, round === 1 ? "publish" : "fix-review"), out("code-review", round));
    }
    const run = deriveRun(entries, "blocked");
    // Still failed — nothing has run spec since — but not what put it here.
    expect(run.failedStages).toContain("spec");
    expect(run.failedStage).toBeNull();
  });

  it("looks past the judge's own entry, at the judge reading a reply to a halt", () => {
    const entries = [entered("build", 1), malformed("build", 1), human(), from("triage", 1, "blocked")];
    expect(deriveRun(entries, "triage").failedStage).toBe("build");
  });

  it("is null at the judge reading a reply to a spec that did not fail", () => {
    const entries = [entered("spec", 1), out("spec", 1), human(), from("triage", 1, "spec-human-review")];
    expect(deriveRun(entries, "triage").failedStage).toBeNull();
  });

  it("is the judge itself when the judge is what failed", () => {
    const entries = [entered("spec", 1), out("spec", 1), human(), from("triage", 1, "spec-human-review"), malformed("triage", 1)];
    expect(deriveRun(entries, "blocked").failedStage).toBe("triage");
  });

  it("is null when no stage has been entered at all", () => {
    expect(deriveRun([], null).failedStage).toBeNull();
  });
});

describe("a pairing, derived from its records", () => {
  const pair = (stage: string, round: number): Entry => ({ stage, kind: "pair", round, at: at(), byAgent: true });
  const release = (stage: string, round: number): Entry => ({ stage, kind: "release", round, at: at(), byAgent: true });

  it("is open from its pair record, numbered and timed", () => {
    const p = pair("spec", 1);
    expect(deriveRun([entered("spec", 1), p], "spec").pairing).toEqual({ stage: "spec", round: 1, n: 1, at: p.at });
  });

  it("is none on an item nobody paired on", () => {
    expect(deriveRun([entered("spec", 1)], "spec").pairing).toBeNull();
  });

  it("closes at an output for its stage at its round or later, whoever wrote it", () => {
    expect(deriveRun([entered("spec", 1), pair("spec", 1), out("spec", 1)], "spec").pairing).toBeNull();
    expect(deriveRun([entered("spec", 2), pair("spec", 2), out("spec", 1)], "spec").pairing).not.toBeNull();
  });

  it("stays open past a rejected round: a refused hand-in leaves it to be finished again", () => {
    expect(deriveRun([entered("spec", 1), pair("spec", 1), malformed("spec", 1)], "blocked").pairing)
      .toMatchObject({ stage: "spec", round: 1 });
  });

  it("closes at a release, and a second pairing at the same round is its own, numbered two", () => {
    expect(deriveRun([pair("spec", 1), release("spec", 1)], "spec").pairing).toBeNull();
    expect(deriveRun([pair("spec", 1), release("spec", 1), pair("spec", 1)], "spec").pairing)
      .toMatchObject({ stage: "spec", round: 1, n: 2 });
  });

  it("is not closed by a release for another stage", () => {
    expect(deriveRun([pair("spec", 1), release("build", 1)], "spec").pairing).toMatchObject({ stage: "spec" });
  });
});

describe("who produced the latest output", () => {
  it("reads a record that names nobody as the agent's, and a paired one as the pair's", () => {
    expect(deriveRun([out("spec", 1)], "spec").lastOutputBy).toBe("agent");
    expect(deriveRun([{ ...out("spec", 1), by: "pair" }], "spec").lastOutputBy).toBe("pair");
    expect(deriveRun([{ ...out("spec", 1), by: "pair" }, out("build", 1)], "build").lastOutputBy).toBe("agent");
  });

  it("is null before anything has produced one", () => {
    expect(deriveRun([entered("spec", 1)], "spec").lastOutputBy).toBeNull();
  });
});

/*
 * The commit each stage's latest settled round started at (security audit
 * H1): `pull.merge`'s `reviewedBy` merges only the head the review saw. Read
 * off the engine's own field on the record — an output's or a rejection's —
 * never off the value an agent wrote.
 */
describe("the head each stage's latest settled round started at", () => {
  const at_ = (e: Entry, head: string): Entry => ({ ...e, head });

  it("is the head on the latest settled round's record, output or rejection", () => {
    const run = deriveRun([at_(out("code-review", 1), "a"), at_(out("code-review", 2), "b"), at_(out("build", 1), "x")], "ci");
    expect(run.heads).toEqual({ "code-review": "b", build: "x" });
    expect(deriveRun([at_(out("code-review", 1), "a"), at_(malformed("code-review", 2), "c")], "blocked").heads).toEqual({ "code-review": "c" });
  });

  it("is absent where the latest settled round recorded none, though an earlier one did", () => {
    expect(deriveRun([at_(out("code-review", 1), "a"), out("code-review", 2)], "ci").heads).toEqual({});
    expect(deriveRun([at_(out("code-review", 1), "a"), malformed("code-review", 2)], "blocked").heads).toEqual({});
  });

  it("is no round's that has not settled: an entry for the next one changes nothing", () => {
    expect(deriveRun([at_(out("code-review", 1), "a"), entered("code-review", 2)], "code-review").heads).toEqual({ "code-review": "a" });
  });

  it("ignores an agent's value that names a head", () => {
    expect(deriveRun([out("code-review", 1, { kind: "reviewed", head: "forged" })], "ci").heads).toEqual({});
  });

  it("is a map no stage id can reach the prototype of", () => {
    const run = deriveRun([at_(out("__proto__", 1), "a")], "ci");
    expect(Object.getPrototypeOf(run.heads)).toBeNull();
  });
});

/*
 * deriveRun scopes a pending goto, the current stage's failure and refusal,
 * its unblock and the stage it was entered from to the position it is handed.
 * A snapshot hands it the label's, and an item a custom identity places
 * carries none: every one of those read as though it were nowhere, so a goto
 * written where it stood was never read back, and a refusal there was nobody's.
 */
describe("locatedRun, the run read from where the item is", () => {
  const mine = { "node.state.labels": { $in: ["needs-my-review"] } };
  const flow = (review: Stage): Workflow => ({
    version: 1, name: "t", description: "test",
    stages: [
      { id: "build", entry: true, step: "steps/build.md" },
      review,
      { id: "stuck", identity: { "node.state.labels": { $in: ["stuck"] } } },
    ],
  });
  const w = flow({ id: "review", identity: mine, step: "steps/review.md" });
  const node = (labels: string[]): Node => ({
    id: "1", kind: "item", title: "t", link: "", closed: null, priority: null, origin: null, state: { labels, assignees: [] },
  });
  /** What buildSnapshot hands over: the run its label reads, as it always has been. */
  const snap = (labels: string[], entries: Entry[]): Snapshot =>
    ({ node: node(labels), entries, run: deriveRun(entries, stageFromLabels(labels).stage) }) as Snapshot;
  const from = (stage: string, round: number, left: string): Entry => ({ ...entered(stage, round), from: left });
  const going = (stage: string, to: string): Entry => ({ stage, kind: "goto", round: 0, goto: to, at: at(), byAgent: true });

  it("reads a refused round at the stage an identity places the item at as that stage's own", () => {
    const entries = [from("review", 1, "build"), refused("review", 1)];
    const run = locatedRun(w, snap(["needs-my-review"], entries));
    expect(run).toMatchObject({ stage: "review", lastOutputValid: false, lastRefused: true, failedStages: ["review"] });
    // Exactly what a label naming review would have read: the item is there.
    expect(run).toEqual(deriveRun(entries, "review"));
  });

  it("reads a goto written there as pending there, and the stage it was entered from", () => {
    const entries = [from("review", 1, "build"), going("review", "build")];
    expect(locatedRun(w, snap(["needs-my-review"], entries)))
      .toMatchObject({ stage: "review", goto: "build", previousStage: "build" });
  });

  it("names the failure that put it at a halt an identity places it at, past a question sent home from there", () => {
    const unblocked: Entry = { stage: "stuck", kind: "unblocked", round: 2, at: at(), byAgent: true };
    const entries = [entered("build", 1), malformed("build", 1), human(), from("review", 1, "stuck"), out("review", 1), unblocked];
    expect(locatedRun(w, snap(["stuck"], entries))).toMatchObject({ stage: "stuck", failedStage: "build", unblockedAt: 2 });
  });

  it("leaves a labelled item's run exactly as its label reads it", () => {
    const s = snap(["lr:stage:build"], [entered("build", 1), refused("build", 1), going("build", "review")]);
    expect(locatedRun(w, s)).toBe(s.run);
  });

  /*
   * A label naming one stage while an identity places the item at another is
   * a contradiction, and resolving it is not this function's to do: the
   * label's reading stays, as it always has.
   */
  it("does not reconcile a label naming another stage with the identity that places the item", () => {
    const s = snap(["lr:stage:stuck", "needs-my-review"], [from("review", 1, "build"), going("review", "build")]);
    expect(locatedRun(w, s)).toBe(s.run);
  });

  it("leaves an item carrying two stage labels as unplaced as it is", () => {
    const s = snap(["lr:stage:build", "lr:stage:stuck", "needs-my-review"], [from("review", 1, "build"), going("review", "build")]);
    expect(locatedRun(w, s)).toBe(s.run);
  });

  it("is the label's reading where no stage, or more than one, places the item", () => {
    const nowhere = snap([], [going("review", "build")]);
    expect(locatedRun(w, nowhere)).toBe(nowhere.run);
    const twice = flow({ id: "review", identity: { "node.state.labels": { $in: ["stuck"] } }, step: "steps/review.md" });
    const both = snap(["stuck"], [going("stuck", "build")]);
    expect(locatedRun(twice, both)).toBe(both.run);
  });

  /*
   * An identity can read the run itself. One that holds only while the item
   * has no position would place it at review read from its label, and
   * nowhere read from review — and a tick deciding on the second while the
   * board shows the first would act on an item it cannot place. The label's
   * reading, the one that does place it, stays.
   */
  it("keeps the label's reading when reading from the identity's stage would move the item off it", () => {
    const unanchored = flow({ id: "review", identity: { "run.stage": null, ...mine }, step: "steps/review.md" });
    const s = snap(["needs-my-review"], [from("review", 1, "build"), going("review", "build")]);
    expect(locatedRun(unanchored, s)).toBe(s.run);
    // Nor when it would move it on to another stage.
    const onward: Workflow = { ...unanchored, stages: [...unanchored.stages, { id: "after", identity: { "run.stage": "review" } }] };
    expect(locatedRun(onward, s)).toBe(s.run);
  });
});
