import { checkEligible } from "../../src/core/eligible.js";
import { locate } from "../../src/core/locate.js";
import { assess } from "../../src/core/assess.js";
import type { Workflow, Snapshot, Stage } from "../../src/core/types.js";

const wf = (stages: Stage[], eligible?: Workflow["eligible"]): Workflow =>
  ({ version: 1, name: "t", stages, ...(eligible ? { eligible } : {}) });

const snap = (o: object): Snapshot => o as Snapshot;

describe("eligibility", () => {
  it("is eligible when no rules are declared", () => {
    expect(checkEligible(wf([]), snap({}))).toEqual({ eligible: true });
  });

  it("explains why it skipped instead of vanishing", () => {
    const w = wf([], [{ when: { "ticket.labels": { $in: ["lr:auto"] } }, else: "no lr:auto label" }]);
    expect(checkEligible(w, snap({ ticket: { labels: [] } }))).toEqual({
      eligible: false, reason: "no lr:auto label",
    });
  });
});

describe("locate", () => {
  const stages: Stage[] = [
    { id: "spec", entry: true, identity: { "run.stage": "spec" } },
    { id: "build", identity: { "run.stage": "build" } },
  ];

  it("finds the one matching stage", () => {
    expect(locate(wf(stages), snap({ run: { stage: "spec" } }))).toEqual({ kind: "at", stage: stages[0] });
  });

  it("reports none when nothing matches", () => {
    expect(locate(wf(stages), snap({ run: { stage: null } })).kind).toBe("none");
  });

  it("halts on two matches rather than picking the first", () => {
    const both: Stage[] = [
      { id: "a", entry: true, identity: { "x": 1 } },
      { id: "b", identity: { "x": 1 } },
    ];
    expect(locate(wf(both), snap({ x: 1 }))).toEqual({ kind: "ambiguous", ids: ["a", "b"] });
  });
});

describe("assess", () => {
  const stage: Stage = { id: "spec", step: "steps/spec.md" };

  it("reads invalid output before completeness, so a rejected step is not retried", () => {
    expect(assess(snap({ run: { lastOutputValid: false, failedStages: ["spec"], counters: {}, outputs: {}, rounds: {} } }), stage)).toBe("failed");
  });

  it("is complete when the stage has no step to run", () => {
    expect(assess(snap({ run: { counters: {}, outputs: {}, failedStages: [], rounds: {} } }), { id: "waiting" })).toBe("complete");
  });

  it("is pending when the step has produced nothing this round", () => {
    expect(assess(snap({ run: { counters: {}, outputs: {}, lastOutputValid: null, failedStages: [], rounds: {} } }), stage)).toBe("pending");
  });

  it("is complete when the step's output for the current round exists", () => {
    const s = snap({ run: { counters: { spec: 1 }, outputs: { spec: { kind: "spec" } }, lastOutputValid: null, failedStages: [], rounds: { spec: { entered: 1, output: 1 } } } });
    expect(assess(s, stage)).toBe("complete");
  });
});
