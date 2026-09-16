import { decide } from "#core/decide.js";
import type { Snapshot, Stage, Workflow } from "#namespace.js";

const run = (o: object = {}) => ({ counters: {}, outputs: {}, lastOutputValid: null, failedStages: [], rounds: {}, ...o });
const snap = (o: object): Snapshot => o as Snapshot;

const stages: Stage[] = [
  { id: "spec", entry: true, step: "steps/spec.md",
    triggers: [{ name: "fresh", when: { "run.stage": null } }] },
  { id: "review", step: "steps/review.md",
    triggers: [{ name: "spec done", when: { "outputs.spec": { $exists: true } } }] },
  { id: "blocked", triggers: [{ name: "rejected", when: { "run.lastOutputValid": false } }] },
];
const wf: Workflow = { version: 1, name: "t", stages };

describe("decide", () => {
  it("skips an ineligible ticket with the reason", () => {
    const w: Workflow = { ...wf, eligible: [{ when: { "ok": true }, else: "no lr:auto label" }] };
    expect(decide(w, snap({ ok: false, run: run() }))).toMatchObject({
      action: "skip", why: "no lr:auto label",
    });
  });

  it("enters the entry stage from nowhere", () => {
    expect(decide(wf, snap({ run: run({ stage: null }) }))).toMatchObject({
      action: "transition", to: stages[0],
    });
  });

  it("invokes a step that has produced nothing", () => {
    expect(decide(wf, snap({ run: run({ stage: "spec" }) }))).toMatchObject({
      action: "invoke", step: "steps/spec.md", round: 1,
    });
  });

  it("numbers the next round from the counter", () => {
    // Entered a third time, two rounds of output behind it: the counter is
    // what numbers the round, the entry record only says work is owed.
    const s = snap({ run: run({ stage: "spec", counters: { spec: 2 }, rounds: { spec: { entered: 3, output: 2 } } }) });
    expect(decide(wf, s).round).toBe(3);
  });

  it("transitions when a single trigger matches", () => {
    const s = snap({
      run: run({ stage: "spec", outputs: { spec: {} }, rounds: { spec: { entered: 1, output: 1 } } }),
      outputs: { spec: {} },
    });
    expect(decide(wf, s)).toMatchObject({ action: "transition", to: stages[1], trigger: "spec done" });
  });

  describe("the round a transition is entering", () => {
    it("numbers a first entry as round 1", () => {
      const s = snap({ run: run({ stage: null }) });
      expect(decide(wf, s).round).toBe(1);
    });

    it("numbers a re-entry from the destination's own output counter, never from the entry records", () => {
      const s = snap({
        run: run({
          stage: "spec", outputs: { spec: {} }, counters: { spec: 1, review: 2 },
          rounds: { spec: { entered: 1, output: 1 }, review: { entered: 2, output: 2 } },
        }),
        outputs: { spec: {} },
      });
      expect(decide(wf, s)).toMatchObject({ action: "transition", to: stages[1], round: 3 });
    });

    /*
     * Re-entering a stage that owes an output must plan the *same* round it
     * already recorded, or a crash between the entry record and the step
     * would leave two entry records for one entry and the stage could never
     * catch up with itself.
     */
    it("re-plans the round already owed when the destination has not produced it yet", () => {
      const s = snap({
        run: run({
          stage: "spec", outputs: { spec: {} }, counters: { spec: 1, review: 1 },
          rounds: { spec: { entered: 1, output: 1 }, review: { entered: 2, output: 1 } },
        }),
        outputs: { spec: {} },
      });
      expect(decide(wf, s)).toMatchObject({ action: "transition", to: stages[1], round: 2 });
    });
  });

  it("waits when nothing matches", () => {
    const only: Workflow = { version: 1, name: "t", stages: [{ id: "spec", entry: true }] };
    expect(decide(only, snap({ run: run({ stage: "spec" }) })).action).toBe("wait");
  });

  it("halts on two matching triggers rather than taking the first", () => {
    const ambiguous: Workflow = { version: 1, name: "t", stages: [
      { id: "spec", entry: true },
      { id: "a", triggers: [{ name: "a", when: { "x": 1 } }] },
      { id: "b", triggers: [{ name: "b", when: { "x": 1 } }] },
    ] };
    const d = decide(ambiguous, snap({ x: 1, run: run({ stage: "spec" }) }));
    expect(d.action).toBe("halt");
    expect(d.why).toMatch(/ambiguous/);
  });

  it("halts when the ticket cannot be placed", () => {
    const both: Workflow = { version: 1, name: "t", stages: [
      { id: "a", entry: true, identity: { x: 1 } },
      { id: "b", identity: { x: 1 } },
    ] };
    expect(decide(both, snap({ x: 1, run: run() })).action).toBe("halt");
  });

  it("halts when a precondition is unmet instead of running a step on nothing", () => {
    const w: Workflow = { version: 1, name: "t", stages: [
      { id: "review", entry: true, step: "s.md", requires: { "outputs.spec": { $exists: true } } },
    ] };
    const d = decide(w, snap({ run: run({ stage: "review" }) }));
    expect(d.action).toBe("halt");
    expect(d.why).toMatch(/precondition/);
  });

  it("routes a rejected output straight to the handling stage, never retrying", () => {
    const s = snap({ run: run({ stage: "spec", lastOutputValid: false, failedStages: ["spec"] }) });
    expect(decide(wf, s)).toMatchObject({ action: "transition", to: stages[2] });
  });
});
