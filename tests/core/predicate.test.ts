import { compile, assertAllowedOperators, pathsIn, missingPaths } from "#core/predicate.js";

describe("predicate", () => {
  it("matches a dot path", () => {
    expect(compile({ "run.stage": "spec" })({ run: { stage: "spec" } } as never)).toBe(true);
    expect(compile({ "run.stage": "spec" })({ run: { stage: "build" } } as never)).toBe(false);
  });

  it("ANDs keys within one condition", () => {
    const p = compile({ "run.stage": "spec", "item.open": true });
    expect(p({ run: { stage: "spec" }, item: { open: true } } as never)).toBe(true);
    expect(p({ run: { stage: "spec" }, item: { open: false } } as never)).toBe(false);
  });

  it("supports the allowed operators", () => {
    expect(compile({ "n": { $lt: 3 } })({ n: 2 } as never)).toBe(true);
    expect(compile({ "l": { $in: ["a"] } })({ l: "a" } as never)).toBe(true);
    expect(compile({ "l": { $nin: ["a"] } })({ l: ["b"] } as never)).toBe(true);
  });

  it("rejects $where — a fork's workflow.yaml must not be able to run code", () => {
    expect(() => assertAllowedOperators({ x: { $where: "1" } })).toThrow(/\$where/);
    expect(() => assertAllowedOperators({ $or: [{ x: { $where: "1" } }] })).toThrow(/\$where/);
  });

  it("rejects $regex — config patterns against issue bodies is catastrophic backtracking", () => {
    expect(() => assertAllowedOperators({ x: { $regex: ".*" } })).toThrow(/\$regex/);
  });

  it("lists the paths a condition reads, so validate can check coverage", () => {
    expect(pathsIn({ "run.stage": "spec", $or: [{ "a.b": 1 }] }).sort()).toEqual(["a.b", "run.stage"]);
  });

  it("does not treat a literal comparison object's own keys as paths", () => {
    // "outputs.spec" demands the field equal the whole object { title: "x" };
    // "title" is a key of that literal value, not a snapshot path itself.
    expect(pathsIn({ "outputs.spec": { title: "x" } })).toEqual(["outputs.spec"]);
  });

  it("distinguishes a path that is absent from one that is falsy", () => {
    expect(missingPaths({ "a.b": 1 }, {} as never)).toEqual(["a.b"]);
    expect(missingPaths({ "a.b": 1 }, { a: { b: false } } as never)).toEqual([]);
  });

  /*
   * A tracker writes an item's facts only when they hold, and deriveRel
   * counts `not.closed` only over a related node, so an item with no
   * blockers has neither path. A gate saying "not true" or "none" is
   * written as a negation, which an absent path satisfies; the plain
   * spelling matches nothing there, and would hold that item for good.
   */
  it("satisfies a negation where the path is absent, as a plain equality never is", () => {
    const nothing = { node: { state: {} }, rel: { x: { out: { total: 0, dropped: 0, is: {}, not: {} } } } } as never;
    const notTrue = compile({ "node.state.fact": { $ne: true } });
    expect([notTrue(nothing), notTrue({ node: { state: { fact: false } } } as never), notTrue({ node: { state: { fact: true } } } as never)])
      .toEqual([true, true, false]);
    const none = compile({ "rel.x.out.not.closed": { $not: { $gt: 0 } } });
    const counted = (n: number) => ({ rel: { x: { out: { total: 1, not: { closed: n } } } } }) as never;
    expect([none(nothing), none(counted(0)), none(counted(1))]).toEqual([true, true, false]);
    expect([compile({ "node.state.fact": false })(nothing), compile({ "rel.x.out.not.closed": 0 })(nothing)]).toEqual([false, false]);
  });
});
