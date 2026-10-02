import { checkEligible } from "#core/eligible.js";
import { locate, locateNode, writesNothing } from "#core/locate.js";
import { assess } from "#core/assess.js";
import type { Node, Workflow, Snapshot, Stage } from "#namespace.js";

const wf = (stages: Stage[], eligible?: Workflow["eligible"]): Workflow =>
  ({ version: 1, name: "t", description: "test", stages, ...(eligible ? { eligible } : {}) });

const snap = (o: object): Snapshot => o as Snapshot;

describe("eligibility", () => {
  it("is eligible when no rules are declared", () => {
    expect(checkEligible(wf([]), snap({}))).toEqual({ eligible: true });
  });

  it("explains why it skipped instead of vanishing", () => {
    const w = wf([], [{ when: { "item.labels": { $in: ["lr:auto"] } }, else: "no lr:auto label" }]);
    expect(checkEligible(w, snap({ item: { labels: [] } }))).toEqual({
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

/*
 * Where a listed node is, asked of the node alone — what status rows, the
 * board and notifications can know without a snapshot per item. The label's
 * stage stands in for `run.stage`, which is what the snapshot would derive
 * from it, so a default identity places the item exactly as `locate` does.
 */
describe("locateNode", () => {
  const node = (labels: string[]): Node => ({
    id: "1", kind: "item", title: "t", link: "", closed: null, priority: null, origin: null, state: { labels, assignees: [] },
  });
  const mine = { "node.state.labels": { $in: ["needs-my-review"] } };

  it("places a labelled item at its label's stage, as locate would", () => {
    const stages: Stage[] = [{ id: "spec", entry: true }, { id: "build" }];
    expect(locateNode(wf(stages), node(["lr:stage:build"]))).toEqual({ kind: "at", stage: stages[1] });
    expect(locateNode(wf(stages), node([]))).toEqual({ kind: "none" });
  });

  it("places an item by an identity that reads the node, with no stage label", () => {
    const stages: Stage[] = [{ id: "spec", entry: true }, { id: "reviewing", identity: mine }];
    expect(locateNode(wf(stages), node(["needs-my-review"]))).toEqual({ kind: "at", stage: stages[1] });
  });

  it("halts rather than choosing when the label and an identity both match", () => {
    const stages: Stage[] = [{ id: "spec", entry: true }, { id: "reviewing", identity: mine }];
    expect(locateNode(wf(stages), node(["lr:stage:spec", "needs-my-review"]))).toEqual({ kind: "ambiguous", ids: ["spec", "reviewing"] });
  });

  it("halts on two stage labels, naming them, as the engine does", () => {
    const stages: Stage[] = [{ id: "spec", entry: true }, { id: "build" }];
    expect(locateNode(wf(stages), node(["lr:stage:spec", "lr:stage:build"]))).toEqual({ kind: "ambiguous", ids: ["spec", "build"] });
  });

  /*
   * An identity reading what no node carries — a step's output, a counter —
   * cannot be judged here. It is not a match, and not a miss either: it
   * gives way to an identity that can be judged and matches, and where none
   * does, the label's stage is all a node can say.
   */
  it("lets an identity it cannot judge give way to one that matches", () => {
    const stages: Stage[] = [
      { id: "spec", entry: true, identity: { "run.outputs.spec.kind": "spec" } },
      { id: "reviewing", identity: mine },
    ];
    expect(locateNode(wf(stages), node(["needs-my-review"]))).toEqual({ kind: "at", stage: stages[1] });
  });

  it("falls back to the label's stage when its identity cannot be judged and nothing else matches", () => {
    const stages: Stage[] = [
      { id: "spec", entry: true },
      { id: "review", identity: { "run.stage": "review", "run.outputs.review.kind": "ready" } },
    ];
    expect(locateNode(wf(stages), node(["lr:stage:review"]))).toEqual({ kind: "at", stage: stages[1] });
  });

  it("does not fall back to a label's stage whose own identity says no", () => {
    const stages: Stage[] = [
      { id: "spec", entry: true, identity: { "node.state.labels": { $in: ["drafting"] } } },
      { id: "review", identity: { "run.counters.review": { $lt: 3 } } },
    ];
    expect(locateNode(wf(stages), node(["lr:stage:spec"]))).toEqual({ kind: "abstained" });
  });

  /*
   * No stage, judged, is a fact a row can halt on as decide does; no stage
   * because an identity could not be judged here is not knowing. Two answers,
   * or a row would halt an item a relation or an output in fact places.
   */
  it("says none only when every identity was judged and none matched", () => {
    const judged: Stage[] = [{ id: "reviewing", identity: mine }, { id: "approved", identity: { "node.state.labels": { $in: ["approved"] } } }];
    expect(locateNode(wf(judged), node(["other"]))).toEqual({ kind: "none" });
    const unjudged: Stage[] = [...judged, { id: "escalated", identity: { "rel.implements.in.total": { $gt: 0 } } }];
    expect(locateNode(wf(unjudged), node(["other"]))).toEqual({ kind: "abstained" });
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

describe("writesNothing", () => {
  const placed = { identity: { "node.state.labels": { $in: ["x"] } } };
  const wf = (...stages: Stage[]): Workflow => ({ version: 1, name: "w", description: "d", stages });
  it("is true for stages all placed by state, with a terminal one", () => {
    expect(writesNothing(wf({ id: "a", waits: "person", ...placed }, { id: "done", terminal: true }))).toBe(true);
  });
  it("is false for an open stage not placed by state", () => {
    expect(writesNothing(wf({ id: "a", waits: "person", triggers: [] }))).toBe(false);
  });
  it("is false for a step", () => {
    expect(writesNothing(wf({ id: "a", step: "steps/a.md", ...placed }))).toBe(false);
  });
  it("is false for a trigger", () => {
    expect(writesNothing(wf({ id: "a", ...placed, triggers: [{ when: { "run.stage": "a" } }] }))).toBe(false);
  });
  it("is false with an entry stage, since entering an unplaced item is a write", () => {
    expect(writesNothing(wf({ id: "a", waits: "person", entry: true, ...placed }, { id: "done", terminal: true }))).toBe(false);
  });
  it("is false for an on_enter", () => {
    expect(writesNothing(wf({ id: "a", ...placed, on_enter: [{ type: "nodes.close" } as never] }))).toBe(false);
  });
});
