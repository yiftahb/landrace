import { deriveRun } from "#core/derive.js";
import { assess } from "#core/assess.js";
import type { Entry, Snapshot, Stage } from "#namespace.js";

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

  it("reads the unblock point so a returned ticket gets a fresh budget", () => {
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
     * or the ticket bounces between blocked and here until the pass cap.
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

describe("assess uses deriveRun's per-stage failedStages, not the stage lastOutputValid answers for", () => {
  // Regression for the bug verified in review: deriveRun is called with the
  // raw snapshot's own run.stage (here "spec"), but decide() places the
  // ticket independently via locate()'s identity predicates, which can name
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

  it("is the latest goto written since the ticket last entered a stage", () => {
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
    // that survives, and it answers only while the ticket is still there.
    expect(deriveRun([e, g], "blocked").goto).toBe("build");
  });

  it("is null when nothing asked", () => {
    expect(deriveRun([entered("spec", 1)], "spec").goto).toBeNull();
  });

  /*
   * A decline leaves a goto unconsumed, and a trigger can then carry the
   * ticket on to a stage — `blocked`, a terminal `done` — that writes no
   * entry record of its own. Read back there, the goto must not still
   * answer: it was written at "triage", not at the stage the ticket now
   * sits in, and nothing has consumed it in between.
   */
  it("is null once the position has moved on from the stage that wrote it, with no entry record in between", () => {
    const entries = [entered("triage", 1), { ...out("triage", 1), goto: "spec" }];
    expect(deriveRun(entries, "blocked").goto).toBeNull();
  });
});

describe("run.previousStage, from the current stage's own entry record", () => {
  const from = (stage: string, round: number, left: string): Entry => ({ ...entered(stage, round), from: left });

  it("is the stage that record says the ticket left", () => {
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
 * the ticket where it is, never an older one the ticket has since been sent
 * around. `failedStages` alone kept a spec that failed before a person sent
 * the ticket on to build, and Retry — reading it — paid for a spec round
 * after the reviews ran out, which nobody had asked for.
 */
describe("run.failedStage, the failure that put the ticket where it is", () => {
  const from = (stage: string, round: number, left: string): Entry => ({ ...entered(stage, round), from: left });
  const going = (stage: string, to: string): Entry => ({ stage, kind: "goto", round: 0, goto: to, at: at(), byAgent: true });

  it("is the step that failed, at the halt it failed into", () => {
    const entries = [entered("spec", 1), out("spec", 1), entered("build", 1), malformed("build", 1)];
    expect(deriveRun(entries, "blocked").failedStage).toBe("build");
  });

  /*
   * A reply at a halt goes through the judge and, unless it asks for a goto,
   * comes home. That round trip left from here and settled; it did not put
   * the ticket here. Read as "the stage it last left", Retry answered
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
   * visit also sent the ticket on *from triage* — goto-spec after a failed
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

  it("is null once the ticket was sent on past an older failure and came back for another reason", () => {
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

  it("is none on a ticket nobody paired on", () => {
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
