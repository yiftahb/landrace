import { validateStructure } from "../../src/workflow/validate.js";
import type { Workflow } from "../../src/core/types.js";

const wf = (stages: Workflow["stages"]): Workflow => ({ version: 1, name: "t", stages });
const rules = (w: Workflow) => validateStructure(w).map((p) => p.rule);

describe("structural validation", () => {
  it("accepts a sound graph", () => {
    const w = wf([
      { id: "a", entry: true, triggers: [{ when: { x: 1 } }] },
      { id: "b", terminal: true, triggers: [{ when: { y: 1 } }] },
    ]);
    expect(validateStructure(w)).toEqual([]);
  });

  it("requires exactly one entry stage", () => {
    expect(rules(wf([{ id: "a" }, { id: "b", terminal: true, triggers: [{ when: { y: 1 } }] }]))).toContain("entry");
    expect(rules(wf([{ id: "a", entry: true }, { id: "b", entry: true }]))).toContain("entry");
  });

  it("flags a stage nothing can reach", () => {
    const w = wf([{ id: "a", entry: true }, { id: "orphan", terminal: true }]);
    expect(rules(w)).toContain("reachability");
  });

  it("rejects a disallowed operator anywhere in the graph", () => {
    const w = wf([{ id: "a", entry: true }, { id: "b", terminal: true, triggers: [{ when: { x: { $where: "1" } } }] }]);
    expect(rules(w)).toContain("operator");
  });

  it("flags a trigger anchored on its own stage — it can never fire and the stage deadlocks", () => {
    const w = wf([
      { id: "a", entry: true, terminal: true },
      { id: "revise", triggers: [{ when: { "run.stage": "revise", "run.counters.revise": { $lt: 3 } } }] },
    ]);
    expect(rules(w)).toContain("self-loop");
  });
});
