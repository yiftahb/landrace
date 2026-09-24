import { planEffects, planNodesClose, staleClosure } from "#core/index.js";
import type { Graph, Node, Snapshot, Stage } from "#namespace.js";

const t = (id: string, o: Partial<Node> = {}): Node => ({
  id, kind: "ticket", title: id, link: "", closed: null, priority: null, origin: null, state: {}, ...o,
});
const child = (id: string, round: number, o: Partial<Node> = {}) =>
  t(id, { origin: { parent: "P", stage: "breakdown", round }, ...o });
const pr = (id: string, o: Partial<Node> = {}) => t(id, { kind: "pull-request", ...o });
const edge = (from: string, to: string, type: string) => ({ from, to, type });
const FOLLOW = ["child-of", "implements"];

const graph: Graph = {
  nodes: [
    t("P"),
    child("A", 1), child("B", 1), child("C", 2),
    t("H"),                               // a person made this one: origin null
    t("A1", { origin: null }),            // A's own child, made by A's step or a person
    pr("pr-7"), pr("pr-8", { closed: "done" }), pr("pr-9"),
    child("D", 1, { closed: "done" }),    // stale but already finished
  ],
  relationships: [
    edge("A", "P", "child-of"), edge("B", "P", "child-of"), edge("C", "P", "child-of"),
    edge("H", "P", "child-of"), edge("D", "P", "child-of"),
    edge("A1", "A", "child-of"),
    edge("pr-7", "A1", "implements"), edge("pr-8", "B", "implements"), edge("pr-9", "H", "implements"),
    edge("B", "A", "blocks"),              // not followed
  ],
};

describe("staleClosure", () => {
  it("drops earlier rounds and everything they own, deepest first", () => {
    expect(staleClosure(graph, "P", "breakdown", 2, FOLLOW)).toEqual(["pr-7", "A1", "A", "B"]);
  });

  it("leaves the round being entered alone — its children are the ones about to exist", () => {
    expect(staleClosure(graph, "P", "breakdown", 2, FOLLOW)).not.toContain("C");
  });

  it("takes this round too when asked to, which is how a crashed attempt is cleaned", () => {
    expect(staleClosure(graph, "P", "breakdown", 3, FOLLOW)).toContain("C");
  });

  it("never touches what a person made, or what hangs off it", () => {
    const ids = staleClosure(graph, "P", "breakdown", 9, FOLLOW);
    expect(ids).not.toContain("H");
    expect(ids).not.toContain("pr-9");
  });

  it("leaves out what is already closed — a merged pull request can never be dropped", () => {
    const ids = staleClosure(graph, "P", "breakdown", 2, FOLLOW);
    expect(ids).not.toContain("pr-8");
    expect(ids).not.toContain("D");
  });

  it("follows only the edge types it is told to", () => {
    expect(staleClosure(graph, "P", "breakdown", 2, ["child-of"])).toEqual(["A1", "A", "B"]);
  });

  it("only counts children of this stage", () => {
    const other: Graph = { ...graph, nodes: [...graph.nodes, t("X", { origin: { parent: "P", stage: "spec", round: 1 } })] };
    expect(staleClosure(other, "P", "breakdown", 9, FOLLOW)).not.toContain("X");
  });

  it("terminates on a cycle, and never closes the parent", () => {
    const looped: Graph = {
      nodes: [t("P"), child("A", 1), t("Z")],
      relationships: [edge("A", "P", "child-of"), edge("Z", "A", "child-of"), edge("A", "Z", "child-of"), edge("P", "Z", "child-of")],
    };
    const ids = staleClosure(looped, "P", "breakdown", 2, FOLLOW);
    expect(new Set(ids)).toEqual(new Set(["A", "Z"]));
    expect(ids).not.toContain("P");
  });

  it("is deterministic whatever order the source listed things in", () => {
    const shuffled: Graph = { nodes: [...graph.nodes].reverse(), relationships: [...graph.relationships].reverse() };
    expect(staleClosure(shuffled, "P", "breakdown", 2, FOLLOW)).toEqual(staleClosure(graph, "P", "breakdown", 2, FOLLOW));
  });
});

const breakdown: Stage = {
  id: "breakdown", step: "steps/breakdown.md",
  on_enter: [
    { type: "nodes.close", follow: FOLLOW },
    { type: "tracker.status", value: "breakdown" },
  ],
};
const snap: Snapshot = { node: t("P"), graph };

describe("planNodesClose / planEffects", () => {
  it("expands the declaration into a concrete list, and leaves every other effect alone", () => {
    const effects = planEffects({ action: "transition", to: breakdown, round: 2 }, snap);
    expect(effects[0]).toEqual({ type: "nodes.close", ids: ["pr-7", "A1", "A", "B"], stage: "breakdown", round: 2 });
    expect(effects[1]).toEqual({ type: "tracker.status", value: "breakdown", stage: "breakdown", round: 2 });
  });

  it("plans an empty list on round one, which reconciles away as already satisfied", () => {
    expect(planNodesClose(breakdown, snap, 1)).toEqual([{ type: "nodes.close", ids: [], stage: "breakdown", round: 1 }]);
  });

  it("refuses to plan a cascade it cannot see", () => {
    expect(() => planNodesClose(breakdown, { node: t("P") }, 2)).toThrow(/graph/);
    expect(() => planNodesClose(breakdown, { graph }, 2)).toThrow(/node/);
  });

  it("refuses a declaration with nothing to follow", () => {
    const bare: Stage = { ...breakdown, on_enter: [{ type: "nodes.close" }] };
    expect(() => planNodesClose(bare, snap, 2)).toThrow(/follow/);
  });

  it("plans nothing for a stage with no nodes.close", () => {
    expect(planNodesClose({ id: "x" }, snap, 2)).toEqual([]);
  });
});
