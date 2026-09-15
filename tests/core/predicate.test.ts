import { compile, assertAllowedOperators, pathsIn, missingPaths } from "../../src/core/predicate.js";

describe("predicate", () => {
  it("matches a dot path", () => {
    expect(compile({ "run.stage": "spec" })({ run: { stage: "spec" } } as never)).toBe(true);
    expect(compile({ "run.stage": "spec" })({ run: { stage: "build" } } as never)).toBe(false);
  });

  it("ANDs keys within one condition", () => {
    const p = compile({ "run.stage": "spec", "ticket.open": true });
    expect(p({ run: { stage: "spec" }, ticket: { open: true } } as never)).toBe(true);
    expect(p({ run: { stage: "spec" }, ticket: { open: false } } as never)).toBe(false);
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
});
