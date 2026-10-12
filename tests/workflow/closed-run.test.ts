import { validate } from "#workflow/validate.js";
import type { Effect, Stage, Step, Workflow } from "#namespace.js";

/*
 * `closed: run`: the one stage a closed item may enter and run its step at —
 * a retro after a ticket is resolved. Only a closed item reaches it. The
 * item's own work is over, so it never names the item branch: it works on no
 * branch, or on a variant (`landrace/{item}-retro`), and plans only
 * `branch.push` and `pull.open`, both on that variant.
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

  /*
   * A closed item's item branch is merged or dropped already, so the only
   * branch it may work on is a variant of it (#158) — `landrace/{item}-retro`,
   * cut fresh — and what it may publish there is that branch and a pull
   * request from it, never a merge, a review or a close.
   */
  const VARIANT = "landrace/{item}-retro";
  const onVariant = (over: Partial<Stage> = {}): Stage => retro({ branch: VARIANT, ...over });
  const publishes = (branch = VARIANT): Partial<Step> => ({ output: { discriminator: "kind", shapes: { learned: {} }, routes: [
    { when: { kind: "learned" }, effects: [{ type: "branch.push", branch }, { type: "pull.open", branch, title: "{item}: retro lessons" }] },
  ] } });
  const variantRun = ({ w, steps }: { w: Workflow; steps: Map<string, Step> }): string[] =>
    validate(w, steps, undefined, "landrace/{item}", ["retro"]).filter((p) => p.rule === "closed-run" || p.rule === "branch").map((p) => p.message);

  it("passes one on a variant that pushes it and opens a pull request from it", () => {
    const { w, steps } = flow(onVariant(), publishes());
    expect(validate(w, steps, undefined, "landrace/{item}", ["retro"])).toEqual([]);
  });

  it("refuses one on the item branch, naming the variant rule", () => {
    expect(variantRun(flow(retro({ branch: "landrace/{item}" })))).toEqual([
      expect.stringMatching(/stage "retro" runs on a closed item, whose item branch landrace\/\{item\} is merged or dropped already: it may work only on a variant/),
    ]);
  });

  it("refuses a variant landrace.yaml does not name, under branch, naming it", () => {
    const { w, steps } = flow(onVariant(), publishes());
    expect(validate(w, steps).filter((p) => p.rule === "branch").map((p) => p.message)).toEqual(expect.arrayContaining([
      expect.stringMatching(/stage "retro" works on branch "landrace\/\{item\}-retro"; it must be landrace\/\{item\}/),
    ]));
  });

  it("refuses one that merges, reviews or closes a pull request, as it is entered or as its step answers", () => {
    for (const type of ["pull.merge", "pull.review", "pull.close"]) {
      expect(variantRun(flow(onVariant({ on_enter: [ENTER, { type, branch: VARIANT }] })))).toEqual([
        expect.stringMatching(new RegExp(`stage "retro" runs on a closed item and plans ${type}; a closed item's work is merged or dropped already`)),
      ]);
    }
    const merges = { output: { discriminator: "kind", shapes: { learned: {} }, routes: [
      { when: { kind: "learned" }, effects: [{ type: "pull.merge", branch: VARIANT }] },
    ] } };
    expect(variantRun(flow(onVariant(), merges))).toEqual(expect.arrayContaining([expect.stringMatching(/plans pull.merge/)]));
  });

  it("refuses a push or a pull request on any branch but its own, or with no branch of its own", () => {
    expect(variantRun(flow(onVariant(), publishes("landrace/{item}")))).toEqual([
      expect.stringMatching(/stage "retro" runs on a closed item and plans branch.push on landrace\/\{item\}; it may publish only its own branch, landrace\/\{item\}-retro/),
      expect.stringMatching(/plans pull.open on landrace\/\{item\}; it may publish only its own branch/),
    ]);
    const opens: Effect = { type: "pull.open", branch: VARIANT };
    expect(variantRun(flow(retro({ on_enter: [ENTER, opens] })))).toEqual([
      expect.stringMatching(/stage "retro" runs on a closed item and plans pull.open, but works on no branch: name a variant as its branch/),
    ]);
    expect(variantRun(flow(retro(), publishes()))).toEqual([
      expect.stringMatching(/plans branch.push, but works on no branch/), expect.stringMatching(/plans pull.open, but works on no branch/),
    ]);
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

  // Retry on a closed item reruns the round that failed where it rests, so
  // only the stage itself may list itself, and only as Retry's.
  it("passes a retry: only entry on the stage naming itself, and still refuses it without retry: only", () => {
    expect(validate(flow(retro({ goto: [{ stage: "retro", retry: "only" }] })).w, flow(retro()).steps)).toEqual([]);
    const capped = retro({ goto: [{ stage: "retro", retry: "only", when: { "run.counters.retro": { $lt: 3 } } }] });
    expect(validate(flow(capped).w, flow(capped).steps)).toEqual([]);
    expect(closedRun(flow(retro({ goto: [{ stage: "retro" }] })))).toEqual([
      expect.stringMatching(/stage "retro" lists "retro" in its goto, but "retro" runs on a closed item, which only a trigger reading node.closed may send there/),
    ]);
    expect(closedRun(flow(retro({ goto: ["retro"] })))).toEqual([expect.stringMatching(/stage "retro" lists "retro" in its goto/)]);
  });

  it("refuses a retry: only entry naming it from another stage, which an open item could take", () => {
    const sent = flow(retro());
    const work = sent.w.stages[0];
    if (!work) throw new Error("no work stage");
    work.goto = [{ stage: "retro", retry: "only" }];
    expect(closedRun(sent)).toEqual([
      expect.stringMatching(/stage "work" lists "retro" with retry: only, but only "retro" itself may: .*an open item/),
    ]);
  });

  it("refuses a route goto into it from its own step", () => {
    const self = flow(retro({ goto: [{ stage: "retro", retry: "only" }] }), {
      output: { discriminator: "kind", shapes: { learned: {} }, routes: [{ when: { kind: "learned" }, goto: "retro" }] },
    });
    expect(closedRun(self)).toEqual([expect.stringMatching(/step retro's route for \{"kind":"learned"\} sends items to "retro", but "retro" runs on a closed item/)]);
  });

  it("leaves a stage without the key alone", () => {
    const plain = retro({ closed: undefined });
    expect(rules(flow(plain))).not.toContain("closed-run");
  });
});
