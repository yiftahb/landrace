import { assess } from "#core/assess.js";
import { deriveRun } from "#core/derive.js";
import type { Entry, Run, Snapshot, Stage } from "#namespace.js";

const stage: Stage = { id: "code-review", step: "steps/code-review.md" };

let t = 0;
const at = () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)).toISOString();
const enter = (s: string, round: number): Entry => ({ stage: s, kind: "enter", round, at: at(), byAgent: true });
const out = (s: string, round: number): Entry => ({ stage: s, kind: "output", round, data: {}, at: at(), byAgent: true });

const snap = (run: Partial<Run>): Snapshot =>
  ({ run: { counters: {}, outputs: {}, failedStages: [], rounds: {}, ...run } }) as Snapshot;

describe("assess is per round, not once per lifetime", () => {
  it("is complete when the step has produced output for the round it was entered at", () => {
    const run = deriveRun([enter("code-review", 1), out("code-review", 1)], "code-review");
    expect(assess({ run } as Snapshot, stage)).toBe("complete");
  });

  /*
   * The whole point. Before this, a stage was complete forever once any
   * output for it existed, so §10's review cycle could route back into
   * code-review and code-review would simply not run — the item ping-ponged
   * between two "complete" stages until the pass cap.
   */
  it("is pending again once the stage is re-entered at a later round", () => {
    const run = deriveRun(
      [enter("code-review", 1), out("code-review", 1), enter("code-review", 2)],
      "code-review",
    );
    expect(assess({ run } as Snapshot, stage)).toBe("pending");
  });

  it("is complete again once the later round has produced its own output", () => {
    const run = deriveRun(
      [enter("code-review", 1), out("code-review", 1), enter("code-review", 2), out("code-review", 2)],
      "code-review",
    );
    expect(assess({ run } as Snapshot, stage)).toBe("complete");
  });

  /*
   * Read validity before completeness (CLAUDE.md): a re-entered stage whose
   * round was rejected must not look like a round that has not run yet, or
   * the hard-fail rule turns into an infinite retry the moment a stage can
   * loop at all.
   */
  it("reads a rejected round before an unfinished one, even when re-entered", () => {
    const run = deriveRun(
      [enter("code-review", 1), out("code-review", 1), enter("code-review", 2),
       { stage: "code-review", kind: "malformed", round: 2, at: at(), byAgent: true }],
      "code-review",
    );
    expect(assess({ run } as Snapshot, stage)).toBe("failed");
  });

  it("is complete when the stage has no step to run, however many times it was entered", () => {
    const run = deriveRun([enter("pr-human-review", 1), enter("pr-human-review", 2)], "pr-human-review");
    expect(assess({ run } as Snapshot, { id: "pr-human-review" })).toBe("complete");
  });

  describe("a stage that records no entry at all keeps its old behaviour", () => {
    it("is pending with no output", () => {
      expect(assess({ run: deriveRun([], "spec") } as Snapshot, { id: "spec", step: "s.md" })).toBe("pending");
    });

    it("is complete with any output, whatever round it names", () => {
      const run = deriveRun([out("spec", 7)], "spec");
      expect(assess({ run } as Snapshot, { id: "spec", step: "s.md" })).toBe("complete");
    });
  });

  it("treats a snapshot with no run at all as pending, not as complete", () => {
    expect(assess({} as Snapshot, stage)).toBe("pending");
  });

  it("does not read a sibling stage's rounds", () => {
    const run = deriveRun([enter("fix-review", 1), out("fix-review", 1)], "fix-review");
    expect(assess({ run } as Snapshot, stage)).toBe("pending");
    expect(assess(snap({ rounds: { "code-review": { entered: 2, output: 1 } } }), stage)).toBe("pending");
  });
});
