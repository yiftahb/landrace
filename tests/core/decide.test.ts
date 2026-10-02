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
const wf: Workflow = { version: 1, name: "t", description: "test", stages };

describe("decide", () => {
  it("skips an ineligible item with the reason", () => {
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
    const only: Workflow = { version: 1, name: "t", description: "test", stages: [{ id: "spec", entry: true }] };
    expect(decide(only, snap({ run: run({ stage: "spec" }) })).action).toBe("wait");
  });

  it("halts on two matching triggers rather than taking the first", () => {
    const ambiguous: Workflow = { version: 1, name: "t", description: "test", stages: [
      { id: "spec", entry: true },
      { id: "a", triggers: [{ name: "a", when: { "x": 1 } }] },
      { id: "b", triggers: [{ name: "b", when: { "x": 1 } }] },
    ] };
    const d = decide(ambiguous, snap({ x: 1, run: run({ stage: "spec" }) }));
    expect(d.action).toBe("halt");
    expect(d.why).toMatch(/ambiguous/);
  });

  // A workflow placed by the item's own state has no entry stage, and an item
  // its identities leave out is not "a workflow without an entry stage": it
  // is an item nothing here places, and the halt says that.
  it("halts an item no identity places, in a workflow with no entry stage, saying so", () => {
    const placed: Workflow = { version: 1, name: "t", description: "test", stages: [
      { id: "reviewing", waits: "person", identity: { "node.state.labels": { $in: ["mine"] } } },
      { id: "approved", terminal: true, identity: { "node.state.labels": { $in: ["approved"] } } },
    ] };
    expect(decide(placed, snap({ node: { state: { labels: ["review-requested"] } }, run: run({ stage: null }) }))).toEqual({
      action: "halt", why: "no stage of this workflow places the item: none of its identities match, and there is no entry stage to start it at",
    });
  });

  it("halts when the item cannot be placed", () => {
    const both: Workflow = { version: 1, name: "t", description: "test", stages: [
      { id: "a", entry: true, identity: { x: 1 } },
      { id: "b", identity: { x: 1 } },
    ] };
    expect(decide(both, snap({ x: 1, run: run() })).action).toBe("halt");
  });

  it("halts when a precondition is unmet instead of running a step on nothing", () => {
    const w: Workflow = { version: 1, name: "t", description: "test", stages: [
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

  describe("several entry stages", () => {
    const fresh = { "run.stage": null };
    const top: Stage = { id: "spec", entry: true, step: "steps/spec.md",
      triggers: [{ name: "top-level item", when: { ...fresh, "rel.child-of.out.total": 0 } }] };
    const child: Stage = { id: "build", entry: true, step: "steps/build.md",
      triggers: [{ name: "child from a breakdown", when: { ...fresh, "rel.child-of.out.total": 1 } }] };
    const review: Stage = { id: "review", step: "steps/review.md",
      triggers: [{ name: "built", when: { "run.stage": "build", "run.outputs.build": { $exists: true } } }] };
    const multi: Workflow = { version: 1, name: "t", description: "test", stages: [top, child, review] };
    const withParents = (n: number, o: object = {}) =>
      snap({ rel: { "child-of": { out: { total: n }, in: { total: 0 } } }, run: run({ stage: null, ...o }) });

    it("enters the one entry stage whose trigger matches", () => {
      expect(decide(multi, withParents(0))).toMatchObject({
        action: "transition", to: top, trigger: "top-level item", round: 1,
      });
      expect(decide(multi, withParents(1))).toMatchObject({
        action: "transition", to: child, trigger: "child from a breakdown", round: 1,
      });
    });

    it("halts when no entry stage accepts, naming every one it tried", () => {
      const d = decide(multi, withParents(2));
      expect(d).toMatchObject({ action: "halt" });
      expect(d.why).toMatch(/no entry stage accepts this item/);
      expect(d.why).toMatch(/spec/);
      expect(d.why).toMatch(/build/);
    });

    it("halts when two entry stages accept, rather than taking the first", () => {
      const greedy: Stage = { ...child, triggers: [{ name: "anything fresh", when: fresh }] };
      const d = decide({ ...multi, stages: [top, greedy, review] }, withParents(0));
      expect(d).toMatchObject({ action: "halt" });
      expect(d.why).toMatch(/ambiguous entry/);
      expect(d.why).toMatch(/spec \(top-level item\)/);
      expect(d.why).toMatch(/build \(anything fresh\)/);
    });

    it("halts when two triggers of one entry stage accept, as two matching triggers do everywhere", () => {
      const twice: Stage = { ...top, triggers: [...(top.triggers ?? []), { name: "also fresh", when: fresh }] };
      const d = decide({ ...multi, stages: [twice, child, review] }, withParents(0));
      expect(d).toMatchObject({ action: "halt" });
      expect(d.why).toMatch(/ambiguous entry/);
    });

    it("still halts an item with history and no position, before choosing any entry", () => {
      const d = decide(multi, withParents(1, { counters: { review: 1 }, rounds: { review: { entered: 1, output: 1 } } }));
      expect(d).toMatchObject({ action: "halt" });
      expect(d.why).toMatch(/has no position/);
    });

    it("resumes a first entry into a second entry stage whose position never landed", () => {
      // The entry record for build round 1 is on the item; the status label
      // that would have placed it is not. Nothing has settled.
      const d = decide(multi, withParents(1, { rounds: { build: { entered: 1, output: 0 } } }));
      expect(d).toMatchObject({ action: "transition", to: child, round: 1 });
    });

    it("does not re-enter a positioned item when its relationships change", () => {
      // At spec, still owing its first output — and now somebody's sub-issue.
      const s = snap({
        rel: { "child-of": { out: { total: 1 }, in: { total: 0 } } },
        run: run({ stage: "spec", rounds: { spec: { entered: 1, output: 0 } } }),
      });
      expect(decide(multi, s)).toMatchObject({ action: "invoke", stage: top });
    });
  });

  it("a sole entry stage is entered whatever its triggers say", () => {
    // Loop-back triggers only, none of which can hold on a fresh item: the
    // single-entry rule never read them, and must not start now.
    const loopOnly: Stage = { id: "a", entry: true, step: "steps/a.md",
      triggers: [{ name: "handed back", when: { "run.stage": "b" } }] };
    const w: Workflow = { version: 1, name: "t", description: "test", stages: [loopOnly, { id: "b", terminal: true, triggers: [{ when: { x: 1 } }] }] };
    expect(decide(w, snap({ run: run({ stage: null }) }))).toMatchObject({
      action: "transition", to: loopOnly, trigger: "entry", round: 1,
    });
  });
});

describe("a pending goto", () => {
  const stages: Stage[] = [
    { id: "spec", entry: true, step: "steps/spec.md", triggers: [{ name: "fresh", when: { "run.stage": null } }] },
    { id: "review", goto: ["spec", { stage: "build", when: { "run.counters.build": { $lt: 3 } } }],
      triggers: [{ name: "spec done", when: { "run.stage": "spec" } }] },
    { id: "build", step: "steps/build.md", requires: { "ok": true },
      triggers: [{ name: "never", when: { "run.stage": "nowhere" } }] },
    { id: "done", terminal: true, triggers: [{ name: "reviewed", when: { "run.stage": "review", "reviewed": true } }] },
  ];
  const w: Workflow = { version: 1, name: "t", description: "test", stages };
  const at = (stage: string, o: object = {}, top: object = {}) => snap({ ...top, run: run({ stage, ...o }) });

  it("sends the item to a target its stage lists, at the target's next round", () => {
    expect(decide(w, at("review", { goto: "spec", counters: { spec: 1 } }))).toMatchObject({
      action: "transition", to: { id: "spec" }, trigger: "goto", round: 2,
    });
  });

  it("outranks a trigger that also matches, rather than being one candidate among them", () => {
    expect(decide(w, at("review", {}, { reviewed: true }))).toMatchObject({ action: "transition", to: { id: "done" } });
    expect(decide(w, at("review", { goto: "spec" }, { reviewed: true }))).toMatchObject({ action: "transition", to: { id: "spec" } });
  });

  it("halts on a target its stage does not list, naming both", () => {
    const d = decide(w, at("review", { goto: "done" }));
    expect(d.action).toBe("halt");
    expect(d.why).toMatch(/"review".*"spec" or "build".*"done"/);
  });

  it("halts on a target that is not a stage at all, naming both", () => {
    expect(decide(w, at("review", { goto: "zz" }))).toMatchObject({
      action: "halt", why: expect.stringMatching(/"review".*"zz"/),
    });
  });

  /*
   * A cap the list declares turns the goto down without stopping the
   * item: the stage's own triggers decide. Halting would leave it at a
   * judge that runs a step, where no command can reach it and nothing
   * would ever consume the goto.
   */
  it("declines a target whose `when` does not hold, and lets the triggers decide", () => {
    const declined = decide(w, at("review", { goto: "build", counters: { build: 3 } }));
    expect(declined).toMatchObject({ action: "wait" });
    expect(declined.why).toMatch(/run\.counters\.build/);
    expect(decide(w, at("review", { goto: "build", counters: { build: 3 } }, { reviewed: true })))
      .toMatchObject({ action: "transition", to: { id: "done" } });
  });

  it("keeps the declined reason on an ambiguity halt, the same way a wait gets it", () => {
    const ambiguous: Stage[] = [
      { id: "review", goto: [{ stage: "build", when: { "run.counters.build": { $lt: 3 } } }] },
      { id: "build" },
      { id: "a", triggers: [{ name: "a", when: { "run.stage": "review" } }] },
      { id: "b", triggers: [{ name: "b", when: { "run.stage": "review" } }] },
    ];
    const aw: Workflow = { version: 1, name: "t", description: "test", stages: ambiguous };
    const d = decide(aw, at("review", { goto: "build", counters: { build: 3 } }));
    expect(d).toMatchObject({ action: "halt" });
    expect(d.why).toMatch(/ambiguous triggers/);
    expect(d.why).toMatch(/run\.counters\.build/);
  });

  /*
   * A round owed is run to its verdict before the item goes anywhere. Left
   * behind, it would be re-entered under the same number, its entry record
   * reconciled away as already posted, and the goto that left it would read
   * as pending again.
   */
  it("runs a step still owed before taking a goto", () => {
    const s = at("spec", { goto: "review", rounds: { spec: { entered: 1, output: 0 } } });
    expect(decide({ ...w, stages: stages.map((x) => (x.id === "spec" ? { ...x, goto: ["review"] } : x)) }, s))
      .toMatchObject({ action: "invoke", step: "steps/spec.md" });
  });

  it("still enforces the target's own precondition once the item arrives", () => {
    expect(decide(w, at("review", { goto: "build", counters: { build: 0 } })))
      .toMatchObject({ action: "transition", to: { id: "build" } });
    expect(decide(w, at("build", { rounds: { build: { entered: 1, output: 0 } } }, { ok: false })))
      .toMatchObject({ action: "halt", why: expect.stringMatching(/precondition for "build"/) });
  });
});

describe("a stage a person is pairing on", () => {
  const pairing = { stage: "spec", round: 1, n: 1, at: "2026-01-01T00:00:00.000Z" };

  it("never runs alone: its owed step waits, and says who holds it", () => {
    const s = snap({ run: run({ stage: "spec", pairing }) });
    expect(decide(wf, s)).toMatchObject({ action: "wait", paired: pairing, why: expect.stringMatching(/pairing on "spec", round 1/) });
  });

  it("does not hold another stage's step", () => {
    const s = snap({ run: run({ stage: "spec", pairing: { ...pairing, stage: "review" } }) });
    expect(decide(wf, s)).toMatchObject({ action: "invoke", step: "steps/spec.md" });
  });

  it("does not stop the stage's triggers once its round is settled", () => {
    const s = snap({ run: run({ stage: "spec", pairing, failedStages: ["spec"], lastOutputValid: false }) });
    expect(decide(wf, s)).toMatchObject({ action: "transition", to: stages[2] });
  });
});
