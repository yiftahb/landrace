import { deriveRel } from "#core/index.js";
import type { Graph, Node } from "#namespace.js";

const n = (id: string, over: Partial<Node> = {}): Node => ({
  id, kind: "ticket", title: id, link: "", closed: null, priority: null, origin: null, state: {}, ...over,
});
const pr = (id: string, state: Node["state"], closed: Node["closed"] = null): Node =>
  n(id, { kind: "pull-request", state, closed });

const TYPES = ["child-of", "implements"];

describe("deriveRel", () => {
  it("reports every declared type with zero counts when nothing relates", () => {
    const r = deriveRel({ nodes: [n("1")], relationships: [] }, "1", TYPES);
    expect(r.ok && r.rel["implements"]?.in).toEqual({ total: 0, is: {}, not: {}, sum: {}, stage: {} });
    expect(r.ok && r.rel["child-of"]?.out.total).toBe(0);
  });

  it("counts incoming and outgoing separately", () => {
    const g: Graph = {
      nodes: [n("1"), n("2"), n("3"), n("0")],
      relationships: [
        { from: "2", to: "1", type: "child-of" },
        { from: "3", to: "1", type: "child-of" },
        { from: "1", to: "0", type: "child-of" },
      ],
    };
    const r = deriveRel(g, "1", TYPES);
    expect(r.ok && r.rel["child-of"]?.in.total).toBe(2);
    expect(r.ok && r.rel["child-of"]?.out.total).toBe(1);
  });

  it("counts booleans with is/not, sums finite numbers, and counts done as is.closed", () => {
    const g: Graph = {
      nodes: [
        n("1"),
        pr("pr-1", { merged: true, openThreads: 0 }, "done"),
        pr("pr-2", { merged: false, openThreads: 3 }),
      ],
      relationships: [
        { from: "pr-1", to: "1", type: "implements" },
        { from: "pr-2", to: "1", type: "implements" },
      ],
    };
    const r = deriveRel(g, "1", TYPES);
    expect(r.ok && r.rel["implements"]?.in).toEqual({
      total: 2,
      is: { merged: 1, closed: 1 },
      not: { merged: 1, closed: 1 },
      sum: { openThreads: 3 },
      stage: {},
    });
  });

  it("leaves dropped nodes out of every count", () => {
    const g: Graph = {
      nodes: [n("1"), n("2", { closed: "dropped" }), n("3", { closed: "done" })],
      relationships: [
        { from: "2", to: "1", type: "child-of" },
        { from: "3", to: "1", type: "child-of" },
      ],
    };
    const r = deriveRel(g, "1", TYPES);
    expect(r.ok && r.rel["child-of"]?.in.total).toBe(1);
    expect(r.ok && r.rel["child-of"]?.in.not["closed"]).toBe(0);
  });

  it("counts related tickets by position", () => {
    const g: Graph = {
      nodes: [n("1"), n("2", { state: { labels: ["lr:stage:build"] } }), n("3", { state: { labels: ["lr:stage:done"] } })],
      relationships: [{ from: "2", to: "1", type: "child-of" }, { from: "3", to: "1", type: "child-of" }],
    };
    const r = deriveRel(g, "1", TYPES);
    expect(r.ok && r.rel["child-of"]?.in.stage).toEqual({ build: 1, done: 1 });
  });

  it("halts when a related ticket carries two positions", () => {
    const g: Graph = {
      nodes: [n("1"), n("2", { state: { labels: ["lr:stage:build", "lr:stage:done"] } })],
      relationships: [{ from: "2", to: "1", type: "child-of" }],
    };
    expect(deriveRel(g, "1", TYPES)).toEqual({ ok: false, why: expect.stringMatching(/"2".*two|more than one/) });
  });

  it("halts when one field is a boolean on one node and something else on another", () => {
    const g: Graph = {
      nodes: [n("1"), pr("pr-1", { merged: true }), pr("pr-2", { merged: "yes" })],
      relationships: [{ from: "pr-1", to: "1", type: "implements" }, { from: "pr-2", to: "1", type: "implements" }],
    };
    expect(deriveRel(g, "1", TYPES)).toEqual({ ok: false, why: expect.stringMatching(/merged/) });
  });

  it("refuses a reserved key as a type or field", () => {
    const g: Graph = { nodes: [n("1"), pr("pr-1", { __proto__: true } as never)], relationships: [] };
    expect(deriveRel(g, "1", ["__proto__"]).ok).toBe(false);
    const g2: Graph = {
      nodes: [n("1"), pr("pr-1", JSON.parse('{"constructor": true}'))],
      relationships: [{ from: "pr-1", to: "1", type: "implements" }],
    };
    expect(deriveRel(g2, "1", TYPES).ok).toBe(false);
  });

  it("counts a type the source reported but the caller did not list, rather than dropping it", () => {
    const g: Graph = { nodes: [n("1"), n("2")], relationships: [{ from: "2", to: "1", type: "blocks" }] };
    const r = deriveRel(g, "1", TYPES);
    expect(r.ok && r.rel["blocks"]?.in.total).toBe(1);
  });

  it("halts when a related node's own state has a `closed` field, which is the engine's own", () => {
    const g: Graph = {
      nodes: [n("1"), pr("pr-1", { closed: true })],
      relationships: [{ from: "pr-1", to: "1", type: "implements" }],
    };
    expect(deriveRel(g, "1", TYPES)).toEqual({ ok: false, why: expect.stringMatching(/"pr-1".*closed/) });
  });

  it("zero-fills not.merged when every related node reports merged: true", () => {
    const g: Graph = {
      nodes: [n("1"), pr("pr-1", { merged: true }), pr("pr-2", { merged: true })],
      relationships: [
        { from: "pr-1", to: "1", type: "implements" },
        { from: "pr-2", to: "1", type: "implements" },
      ],
    };
    const r = deriveRel(g, "1", TYPES);
    expect(r.ok && r.rel["implements"]?.in.not["merged"]).toBe(0);
  });
});

/*
 * A child an earlier round of the stage made is superseded once the stage is
 * entered again: that round's plan was replaced, whether the child was
 * dropped (open) or had already finished (done). A finished one cannot be
 * dropped, so without this it would still count — and a re-run that created
 * nothing would read as "every child is finished".
 */
describe("deriveRel, and children a later round superseded", () => {
  const origin = (parent: string, round: number, stage = "breakdown") => ({ parent, stage, round });
  const child = (id: string, over: Partial<Node>) => n(id, over);
  const under = (...kids: Node[]): Graph => ({
    nodes: [n("1"), ...kids],
    relationships: kids.map((k) => ({ from: k.id, to: "1", type: "child-of" })),
  });

  it("leaves a child an earlier round made out of every count, finished or not", () => {
    const g = under(
      child("2", { origin: origin("1", 1), closed: "done" }),
      child("3", { origin: origin("1", 1) }),
      child("4", { origin: origin("1", 2) }),
    );
    const r = deriveRel(g, "1", TYPES, { breakdown: 2 });
    expect(r.ok && r.rel["child-of"]?.in).toMatchObject({ total: 1, not: { closed: 1 }, is: { closed: 0 } });
  });

  it("keeps a child the current round made", () => {
    const r = deriveRel(under(child("2", { origin: origin("1", 2), closed: "done" })), "1", TYPES, { breakdown: 2 });
    expect(r.ok && r.rel["child-of"]?.in.total).toBe(1);
  });

  it("keeps a child whose origin names another parent", () => {
    const r = deriveRel(under(child("2", { origin: origin("9", 1) })), "1", TYPES, { breakdown: 2 });
    expect(r.ok && r.rel["child-of"]?.in.total).toBe(1);
  });

  it("keeps a child a person made, whatever round the stage is on", () => {
    const r = deriveRel(under(child("2", { origin: null, closed: "done" })), "1", TYPES, { breakdown: 5 });
    expect(r.ok && r.rel["child-of"]?.in.total).toBe(1);
  });

  it("keeps a child whose stage has never been entered again, or when no rounds are known", () => {
    const g = under(child("2", { origin: origin("1", 1) }));
    const other = deriveRel(g, "1", TYPES, { build: 3 });
    expect(other.ok && other.rel["child-of"]?.in.total).toBe(1);
    const none = deriveRel(g, "1", TYPES);
    expect(none.ok && none.rel["child-of"]?.in.total).toBe(1);
  });
});
