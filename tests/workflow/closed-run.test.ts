import { validate } from "#workflow/validate.js";
import type { Effect, Stage, Step, Workflow } from "#namespace.js";

/*
 * `closed: run`: the one stage a closed item may enter and run its step at —
 * a retro after a ticket is resolved. It works on no branch and touches no
 * forge, since the item's work is over, and only a closed item reaches it.
 */
const ENTER = { type: "tracker.comment", kind: "enter", marker: "enter:{stage}:{round}" };

const retro = (over: Partial<Stage> = {}): Stage => ({
  id: "retro", step: "retro", closed: "run",
  triggers: [{ name: "resolved", when: { "node.closed": "done" } }],
  on_enter: [ENTER, { type: "tracker.status", value: "retro" }],
  ...over,
});

const flow = (stage: Stage, retroStep: Partial<Step> = {}): { w: Workflow; steps: Map<string, Step> } => ({
  w: {
    version: 1, name: "t", description: "test",
    stages: [
      { id: "work", entry: true, on_enter: [{ type: "tracker.status", value: "work" }] },
      { id: "done", terminal: true, triggers: [{ when: { "run.stage": "work", "node.state.labels": "shipped" } }] },
      stage,
    ],
  },
  steps: new Map([["retro", {
    prompt: "what did we learn",
    output: { discriminator: "kind", shapes: { learned: {} }, routes: [{ when: { kind: "learned" }, effect: { type: "tracker.comment", marker: "retro:{round}" } }] },
    ...retroStep,
  }]]),
});

const rules = ({ w, steps }: { w: Workflow; steps: Map<string, Step> }): string[] => validate(w, steps).map((p) => p.rule);
const closedRun = ({ w, steps }: { w: Workflow; steps: Map<string, Step> }): string[] =>
  validate(w, steps).filter((p) => p.rule === "closed-run").map((p) => p.message);

describe("closed-run", () => {
  it("passes a retro a resolved item enters, which rests there with no way out", () => {
    expect(validate(flow(retro()).w, flow(retro()).steps)).toEqual([]);
  });

  it("refuses one on a branch", () => {
    expect(closedRun(flow(retro({ branch: "landrace/{item}" })))).toEqual([
      expect.stringMatching(/stage "retro" runs on a closed item, so it works on no branch/),
    ]);
  });

  it("refuses one that touches the forge as it is entered, or as its step answers", () => {
    const opens: Effect = { type: "pull.open", branch: "landrace/{item}" };
    expect(closedRun(flow(retro({ on_enter: [ENTER, opens] })))).toEqual([
      expect.stringMatching(/stage "retro" runs on a closed item and plans pull.open/),
    ]);
    const pushes = { output: { discriminator: "kind", shapes: { learned: {} }, routes: [
      { when: { kind: "learned" }, effects: [{ type: "branch.push", branch: "landrace/{item}" }] },
    ] } };
    expect(closedRun(flow(retro(), pushes))).toEqual([expect.stringMatching(/plans branch.push/)]);
  });

  it("refuses a trigger that does not read node.closed", () => {
    const loose = retro({ triggers: [{ name: "resolved", when: { "node.closed": "done" } }, { name: "any", when: { "run.stage": "done" } }] });
    expect(closedRun(flow(loose))).toEqual([expect.stringMatching(/stage "retro" runs on a closed item, but its trigger "any" does not read node.closed/)]);
  });

  // Naming node.closed is not enough: an open item's is null, so a condition
  // that holds on null moves every open item into the retro.
  it("refuses a trigger whose node.closed condition holds on an open item", () => {
    for (const when of [
      { "node.closed": { $ne: "dropped" } },
      { "node.closed": null },
      { "node.closed": { $nin: ["dropped"] } },
      { $or: [{ "node.closed": "done" }, { "run.stage": "done" }] },
      { $not: { "node.closed": "dropped" } },
    ]) {
      expect(closedRun(flow(retro({ triggers: [{ name: "loose", when }] })))).toEqual([
        expect.stringMatching(/stage "retro" runs on a closed item, but its trigger "loose" can hold while node.closed is null/),
      ]);
    }
  });

  it("passes a trigger that holds only on a closed item, however it is written", () => {
    for (const when of [
      { "node.closed": { $in: ["done", "dropped"] } },
      { "node.closed": { $ne: null } },
      { $and: [{ "run.stage": "done" }, { "node.closed": "done" }] },
      { $or: [{ "node.closed": "done" }, { "node.closed": "dropped", "run.stage": "work" }] },
    ]) {
      expect(closedRun(flow(retro({ triggers: [{ name: "resolved", when }] })))).toEqual([]);
    }
  });

  // A sole entry stage is entered by every new open item, its triggers unread.
  it("refuses one that is an entry stage", () => {
    expect(closedRun(flow(retro({ entry: true })))).toEqual([
      expect.stringMatching(/stage "retro" runs on a closed item, so it cannot be an entry stage/),
    ]);
  });

  // A goto takes no trigger: an open item sent there would run the step and
  // rest with no way out, dead-end and shape-edge being waived for the stage.
  it("refuses a stage goto entry, or a route goto, into it", () => {
    const sent = flow(retro());
    const work = sent.w.stages[0];
    if (!work) throw new Error("no work stage");
    work.step = "work";
    work.goto = [{ stage: "retro", when: { "run.round": 1 } }];
    sent.steps.set("work", {
      prompt: "work",
      output: { discriminator: "kind", shapes: { over: {} }, routes: [{ when: { kind: "over" }, goto: "retro" }] },
    });
    expect(closedRun(sent)).toEqual([
      expect.stringMatching(/stage "work" lists "retro" in its goto, but "retro" runs on a closed item/),
      expect.stringMatching(/step work's route for \{"kind":"over"\} sends items to "retro", but "retro" runs on a closed item/),
    ]);
  });

  it("leaves a stage without the key alone", () => {
    const plain = retro({ closed: undefined });
    expect(rules(flow(plain))).not.toContain("closed-run");
  });
});
