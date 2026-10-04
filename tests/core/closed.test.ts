import { claimItems, closedIdle, decide } from "#core/index.js";
import type { Closed, Graph, Node, Snapshot, Stage, Workflow } from "#namespace.js";

/*
 * A retro after a ticket is resolved: `retro` is the one stage a closed item
 * enters, by a trigger on `node.closed`, and its step runs there once.
 * Everywhere else a closed item is left alone, as it always was.
 */
const run = (o: object = {}) => ({ counters: {}, outputs: {}, lastOutputValid: null, failedStages: [], rounds: {}, ...o });

const RETRO: Stage = { id: "retro", step: "steps/retro.md", closed: "run", triggers: [{ name: "resolved", when: { "node.closed": "done" } }] };
const stages: Stage[] = [
  { id: "triage", entry: true, step: "steps/triage.md", triggers: [{ name: "fresh", when: { "run.stage": null } }] },
  { id: "build", step: "steps/build.md", triggers: [{ name: "triaged", when: { "run.stage": "triage", "run.outputs.triage": { $exists: true } } }] },
  { id: "done", terminal: true, triggers: [{ name: "built", when: { "run.stage": "build", "run.outputs.build": { $exists: true } } }] },
  RETRO,
];
const sweep: Workflow = { version: 1, name: "t", description: "test", stages };

/** `sweep` with `triage` given one more trigger. */
const withTriage = (when: Record<string, unknown>): Workflow => ({
  ...sweep,
  stages: stages.map((s) => (s.id === "triage" ? { ...s, triggers: [...(s.triggers ?? []), { name: "back", when }] } : s)),
});

const at = (stage: string | null, closed: Closed, o: object = {}): Snapshot =>
  ({ node: { id: "7", closed }, run: run({ stage, ...o }) }) as unknown as Snapshot;

const ran = { outputs: { retro: { kind: "learned" } }, counters: { retro: 1 }, rounds: { retro: { entered: 1, output: 1 } } };

describe("decide, on a closed item", () => {
  it("does not move an open item at done", () => {
    expect(decide(sweep, at("done", null))).toMatchObject({ action: "wait" });
  });

  it("enters retro once an item at done is closed as done", () => {
    expect(decide(sweep, at("done", "done"))).toMatchObject({ action: "transition", to: RETRO, trigger: "resolved", round: 1 });
  });

  it("runs retro's step there, and only once", () => {
    expect(decide(sweep, at("retro", "done"))).toMatchObject({ action: "invoke", step: "steps/retro.md", round: 1 });
    expect(decide(sweep, at("retro", "done", ran))).toMatchObject({ action: "skip", why: expect.stringMatching(/closed.*rests at "retro"/) });
  });

  it("lets nothing leave retro while the item is closed", () => {
    const leaving: Workflow = withTriage({ "node.closed": "done", "run.stage": "retro" });
    expect(decide(leaving, at("retro", "done", ran))).toMatchObject({ action: "skip" });
  });

  it("skips an item closed as dropped", () => {
    expect(decide(sweep, at("done", "dropped"))).toMatchObject({ action: "skip", why: expect.stringMatching(/closed/) });
  });

  it("invokes nothing on an item closed at build with its round owed", () => {
    expect(decide(sweep, at("build", "done"))).toMatchObject({ action: "transition", to: RETRO });
    const noRetro: Workflow = { ...sweep, stages: stages.filter((s) => s.id !== "retro") };
    expect(decide(noRetro, at("build", "done"))).toMatchObject({ action: "skip" });
  });

  it("skips a closed item whose only match leads somewhere a closed item does not run", () => {
    expect(decide(withTriage({ "node.closed": "dropped" }), at("done", "dropped"))).toMatchObject({ action: "skip" });
  });

  it("halts on a second match, as on an open item", () => {
    expect(decide(withTriage({ "node.closed": "done" }), at("done", "done"))).toMatchObject({
      action: "halt", why: expect.stringMatching(/ambiguous triggers: triage \(back\), retro \(resolved\)/),
    });
  });

  it("skips a closed item with no position, and never enters it", () => {
    expect(decide(sweep, at(null, "done"))).toMatchObject({ action: "skip" });
  });

  it("goes by the ordinary rules once the item is reopened", () => {
    expect(decide(sweep, at("retro", null))).toMatchObject({ action: "invoke", step: "steps/retro.md" });
    expect(decide(sweep, at("build", null))).toMatchObject({ action: "invoke", step: "steps/build.md" });
  });
});

const node = (id: string, labels: string[], closed: Closed = null): Node => ({
  id, kind: "item", title: id, link: "", closed, priority: null, origin: null, state: { labels },
});
const graph = (...nodes: Node[]): Graph => ({ nodes, relationships: [] });
const eligible = (label: string, closedStage: boolean): Workflow => ({
  ...sweep,
  stages: closedStage ? stages : stages.filter((s) => s.id !== "retro"),
  eligible: [{ when: { "node.state.labels": { $in: [label] } }, else: `no ${label}` }],
});

describe("claimItems, for a closed item", () => {
  it("gives it to the one workflow with a closed: run stage that claims it", () => {
    const c = claimItems(
      [{ id: "main", workflow: eligible("lr:auto", true), source: 0, closedRun: true }],
      [graph(node("1", ["lr:auto"], "done"))],
    );
    expect([...c.closed]).toEqual([["1", "main"]]);
    expect(c.owner.size).toBe(0);
  });

  it("halts one two such workflows claim", () => {
    const c = claimItems(
      ["b", "a"].map((id) => ({ id, workflow: eligible("lr:auto", true), source: 0, closedRun: true })),
      [graph(node("1", ["lr:auto"], "done"))],
    );
    expect(c.conflicts.get("1")).toEqual(["a", "b"]);
    expect(c.closed.size).toBe(0);
  });

  it("admits it nowhere when none claims it, and says nothing of it", () => {
    const c = claimItems(
      [{ id: "main", workflow: eligible("lr:fast", true), source: 0, closedRun: true }],
      [graph(node("1", ["lr:auto"], "done"))],
    );
    expect([...c.owner, ...c.closed, ...c.conflicts, ...c.unclaimed, ...c.clashes]).toEqual([]);
  });

  it("halts an id one source lists open and another lists closed for a closed: run workflow", () => {
    const c = claimItems(
      [{ id: "open", workflow: eligible("lr:auto", false), source: 0 }, { id: "retro", workflow: eligible("lr:auto", true), source: 1, closedRun: true }],
      [graph(node("1", ["lr:auto"])), graph(node("1", ["lr:auto"], "done"))],
    );
    expect(c.clashes.get("1")).toEqual(["open", "retro"]);
    expect([...c.owner, ...c.closed]).toEqual([]);
  });

  it("names every workflow whose source lists a closed id two sources report", () => {
    const c = claimItems(
      [{ id: "retro", workflow: eligible("lr:auto", true), source: 0, closedRun: true }, { id: "other", workflow: eligible("lr:auto", false), source: 1 }],
      [graph(node("12", ["lr:auto"], "done")), graph(node("12", ["lr:auto"], "done"))],
    );
    expect(c.clashes.get("12")).toEqual(["other", "retro"]);
    expect(c.closed.size).toBe(0);
  });

  it("is no clash when no closed: run workflow reads the source listing it closed", () => {
    const c = claimItems(
      [{ id: "open", workflow: eligible("lr:auto", false), source: 0 }, { id: "other", workflow: eligible("lr:auto", false), source: 1 }],
      [graph(node("1", ["lr:auto"])), graph(node("1", ["lr:auto"], "done"))],
    );
    expect([...c.owner]).toEqual([["1", "open"]]);
    expect(c.clashes.size).toBe(0);
  });

  it("is no workflow's without a closed: run stage, as it always was", () => {
    const c = claimItems(
      [{ id: "main", workflow: eligible("lr:auto", false), source: 0 }, { id: "retro", workflow: eligible("lr:auto", true), source: 0, closedRun: true }],
      [graph(node("1", ["lr:auto"], "done"))],
    );
    expect([...c.closed]).toEqual([["1", "retro"]]);
    expect(c.conflicts.size).toBe(0);
  });
});

describe("closedIdle", () => {
  const labelled = (stage: string, closed: Closed): Node => node("1", [`lr:stage:${stage}`], closed);

  it("is a closed item no trigger into a closed: run stage could take, and none at one", () => {
    expect(closedIdle(sweep, labelled("done", "dropped"))).toBe(true);
    expect(closedIdle(sweep, labelled("done", "done"))).toBe(false);
    expect(closedIdle(sweep, labelled("retro", "done"))).toBe(false);
  });

  it("is never idle where the node alone cannot say", () => {
    const reading: Workflow = { ...sweep, stages: stages.map((s) => (s.id === "retro" ? { ...s, triggers: [{ when: { "node.closed": "done", "run.outputs.build": { $exists: true } } }] } : s)) };
    expect(closedIdle(reading, labelled("done", "done"))).toBe(false);
    expect(closedIdle(reading, labelled("done", "dropped"))).toBe(true);
  });
});
