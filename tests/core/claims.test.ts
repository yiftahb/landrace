import { claimItems } from "#core/index.js";
import type { Graph, Node, Workflow } from "#namespace.js";

const node = (id: string, labels: string[], over: Partial<Node> = {}): Node => ({
  id, kind: "item", title: id, link: "", closed: null, priority: null, origin: null, state: { labels }, ...over,
});
const item = (id: string, labels: string[]): Node => node(id, labels);
const graph = (...nodes: Node[]): Graph => ({ nodes, relationships: [] });
const wf = (_id: string, label: string): Workflow =>
  ({ eligible: [{ when: { "node.state.labels": { $in: [label] } }, else: `no ${label}` }] }) as unknown as Workflow;

describe("claimItems", () => {
  it("gives an item to the one workflow that claims it", () => {
    const c = claimItems(
      [{ id: "main", workflow: wf("main", "lr:auto"), source: 0 }, { id: "fast", workflow: wf("fast", "lr:fast"), source: 0 }],
      [graph(item("1", ["lr:auto"]), item("2", ["lr:fast"]))],
    );
    expect([...c.owner]).toEqual([["1", "main"], ["2", "fast"]]);
  });
  it("halts an item several workflows claim, sorted whatever their declared order", () => {
    const c = claimItems(
      ["m", "a", "z"].map((id) => ({ id, workflow: wf(id, "lr:auto"), source: 0 })),
      [graph(item("3", ["lr:auto"]))],
    );
    expect(c.owner.has("3")).toBe(false);
    expect(c.conflicts.get("3")).toEqual(["a", "m", "z"]);
  });
  it("halts an id two different sources both report", () => {
    const c = claimItems(
      [{ id: "gl", workflow: wf("gl", "lr:auto"), source: 1 }, { id: "gh", workflow: wf("gh", "lr:auto"), source: 0 }],
      [graph(item("pr-12", ["lr:auto"])), graph(item("pr-12", ["lr:auto"]))],
    );
    expect(c.clashes.get("pr-12")).toEqual(["gh", "gl"]);
    expect(c.owner.has("pr-12")).toBe(false);
    expect(c.conflicts.has("pr-12")).toBe(false);
  });
  it("keeps each workflow's reason for an item nobody claims", () => {
    const c = claimItems([{ id: "main", workflow: wf("main", "lr:auto"), source: 0 }], [graph(item("4", []))]);
    expect(c.unclaimed.get("4")).toEqual(["no lr:auto"]);
  });
  it("judges a workflow only on the graph at its own source index", () => {
    const c = claimItems(
      [{ id: "a", workflow: wf("a", "x"), source: 0 }, { id: "b", workflow: wf("b", "y"), source: 1 }],
      [graph(item("5", ["x"])), graph()],
    );
    expect(c.owner.get("5")).toBe("a");
    expect(c.conflicts.size + c.clashes.size + c.unclaimed.size).toBe(0);
    const d = claimItems(
      [{ id: "a", workflow: wf("a", "x"), source: 0 }, { id: "b", workflow: wf("b", "x"), source: 1 }],
      [graph(item("6", ["x"])), graph()],
    );
    expect(d.owner.get("6")).toBe("a");
    expect(d.conflicts.size).toBe(0);
  });
  it("ignores closed items and non-items", () => {
    const closed = node("6", ["x"], { closed: "done" });
    const pull = node("7", ["x"], { kind: "pull-request" });
    const w = [{ id: "a", workflow: wf("a", "x"), source: 0 }, { id: "b", workflow: wf("b", "y"), source: 0 }];
    for (const n of [closed, pull]) {
      const c = claimItems(w, [graph(n)]);
      for (const m of [c.owner, c.conflicts, c.clashes, c.unclaimed]) expect(m.size).toBe(0);
    }
  });
});
