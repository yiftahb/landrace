import { deriveRun } from "../../src/core/derive.js";
import { assess } from "../../src/core/assess.js";
import type { Entry, Snapshot, Stage } from "../../src/core/types.js";

let t = 0;
const at = () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)).toISOString();
const out = (stage: string, round: number, data: unknown = {}): Entry =>
  ({ stage, kind: "output", round, data, at: at(), byAgent: true });
const human = (): Entry => ({ stage: "-", kind: "human", round: 0, at: at(), byAgent: false });
const malformed = (stage: string, round: number): Entry =>
  ({ stage, kind: "malformed", round, at: at(), byAgent: true });

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
