import { MAX_SUBGRAPH_NODES } from "#conventions.js";
import { graphProblem } from "#runner/graph.js";
import type { Graph, Node, RelationDecl } from "#namespace.js";

const n = (id: string, over: Partial<Node> = {}): Node => ({
  id, kind: "ticket", title: id, link: "https://x/" + id, closed: null, priority: null, origin: null, state: {}, ...over,
});
const REL: RelationDecl[] = [{ type: "child-of", singular: true }, { type: "implements", singular: true }];
const g = (nodes: Node[], relationships: Graph["relationships"] = []): Graph => ({ nodes, relationships });

describe("graphProblem", () => {
  it("accepts a healthy graph", () => {
    expect(graphProblem(g([n("1"), n("2")], [{ from: "2", to: "1", type: "child-of" }]), REL, "1")).toBeNull();
  });

  it.each<[string, Graph, RegExp]>([
    ["the ticket itself is missing", g([n("2")]), /"1".*not in/],
    ["a duplicate id", g([n("1"), n("1")]), /duplicate.*"1"/],
    ["a dangling edge", g([n("1")], [{ from: "9", to: "1", type: "child-of" }]), /"9"/],
    ["an undeclared type", g([n("1"), n("2")], [{ from: "2", to: "1", type: "blocks" }]), /"blocks".*declare/],
    ["two parents", g([n("1"), n("2"), n("3")], [
      { from: "1", to: "2", type: "child-of" }, { from: "1", to: "3", type: "child-of" }]), /"1".*two.*child-of/],
    ["a singular cycle", g([n("1"), n("2")], [
      { from: "1", to: "2", type: "child-of" }, { from: "2", to: "1", type: "child-of" }]), /cycle/],
    ["a non-finite priority", g([n("1", { priority: Number.NaN })]), /priority/],
    ["an unknown close reason", g([n("1", { closed: "gone" as never })]), /closed/],
    ["a bad id", g([n("a/b")]), /ticket id/],
    ["state JSON cannot carry", g([n("1", { state: { x: Number.POSITIVE_INFINITY } })]), /Infinity/],
  ])("refuses %s", (_what, graph, why) => {
    expect(graphProblem(graph, REL, "1")).toMatch(why);
  });

  it("refuses a neighbourhood past the cap, saying how big it was", () => {
    const nodes = Array.from({ length: MAX_SUBGRAPH_NODES + 1 }, (_, i) => n(String(i + 1)));
    expect(graphProblem(g(nodes), REL, "1")).toMatch(new RegExp(`${MAX_SUBGRAPH_NODES + 1}`));
  });

  it("applies no cap without an id — list() is the whole tracker", () => {
    const nodes = Array.from({ length: MAX_SUBGRAPH_NODES + 1 }, (_, i) => n(String(i + 1)));
    expect(graphProblem(g(nodes), REL)).toBeNull();
  });
});
