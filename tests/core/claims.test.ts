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
  it("halts an item two workflows claim, naming both", () => {
    const c = claimItems(
      [{ id: "main", workflow: wf("main", "lr:auto"), source: 0 }, { id: "fast", workflow: wf("fast", "lr:fast"), source: 0 }],
      [graph(item("3", ["lr:auto", "lr:fast"]))],
    );
    expect(c.owner.has("3")).toBe(false);
    expect(c.conflicts.get("3")).toEqual(["fast", "main"]);
  });
  it("halts an id two different sources both report", () => {
    const c = claimItems(
      [{ id: "gh", workflow: wf("gh", "lr:auto"), source: 0 }, { id: "gl", workflow: wf("gl", "lr:auto"), source: 1 }],
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
  it("judges a workflow only on the items its own source listed", () => {
    const c = claimItems(
      [{ id: "a", workflow: wf("a", "x"), source: 0 }, { id: "b", workflow: wf("b", "x"), source: 1 }],
      [graph(item("5", ["x"])), graph()],
    );
    expect(c.owner.get("5")).toBe("a");
  });
  it("ignores closed items and non-items", () => {
    const closed = node("6", ["x"], { closed: "done" });
    const pull = node("7", ["x"], { kind: "pull-request" });
    const c = claimItems([{ id: "a", workflow: wf("a", "x"), source: 0 }], [graph(closed, pull)]);
    for (const m of [c.owner, c.conflicts, c.clashes, c.unclaimed]) expect(m.size).toBe(0);
  });
});
