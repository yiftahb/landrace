import { validateStructure } from "../../src/workflow/validate.js";
import type { Step, Workflow } from "../../src/namespace.js";

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

  it("flags a trigger naming a stage id that does not exist in the workflow", () => {
    const w = wf([
      { id: "a", entry: true, terminal: true },
      { id: "b", triggers: [{ when: { "run.stage": "typo" } }] },
    ]);
    expect(rules(w)).toContain("unknown-stage");
  });

  /**
   * Before the workflow ever runs, and in the report a person reads: a
   * capability nothing enforces is the operator believing in a restriction
   * that was never applied. Meeting it at runtime instead means finding out on
   * a ticket already in flight, one refused step at a time.
   */
  it("flags a step declaring a capability the engine cannot enforce", () => {
    const steps = new Map<string, Step>([["s.md", { prompt: "", capabilities: ["repo:read", "net:egress"] }]]);
    const w = wf([{ id: "a", entry: true, terminal: true, step: "s.md" }]);
    const problems = validateStructure(w, steps);

    expect(problems.map((p) => p.rule)).toContain("capability");
    expect(problems.find((p) => p.rule === "capability")?.message).toMatch(/net:egress/);
  });

  /**
   * The engine writes the agent's session id into the same object a step's
   * output value travels in (conventions.ts, SESSION_KEY), because that is the
   * one field a tracker hook carries into the marker it stamps. A shape that
   * declared the same name would be silently overwritten — and what it would
   * cost is the thing the id is for: the conversation would resume whatever
   * the agent happened to put there.
   */
  it("flags a step whose output shape declares the field the engine records the session in", () => {
    const steps = new Map<string, Step>([["s.md", {
      prompt: "",
      output: {
        discriminator: "kind",
        shapes: { spec: { title: "string", session: "string" } },
        routes: [{ when: { kind: "spec" }, effect: { type: "x" } }],
      },
    }]]);
    const w = wf([{ id: "a", entry: true, terminal: true, step: "s.md" }]);
    const problems = validateStructure(w, steps);

    expect(problems.map((p) => p.rule)).toContain("reserved-field");
    expect(problems.find((p) => p.rule === "reserved-field")?.message).toMatch(/session/);
  });

  it("accepts the capabilities the engine does enforce", () => {
    const steps = new Map<string, Step>([["s.md", { prompt: "", capabilities: ["repo:read", "repo:write"] }]]);
    const w = wf([{ id: "a", entry: true, terminal: true, step: "s.md" }]);
    expect(validateStructure(w, steps).map((p) => p.rule)).not.toContain("capability");
  });

  it("rejects a disallowed operator in a step's route condition", () => {
    const steps = new Map<string, Step>([["s.md", {
      prompt: "",
      output: {
        discriminator: "kind",
        shapes: { spec: {} },
        routes: [{ when: { kind: { $where: "evil()" } }, effect: { type: "x" } }],
      },
    }]]);
    const w = wf([{ id: "a", entry: true, terminal: true, step: "s.md" }]);
    expect(validateStructure(w, steps).map((p) => p.rule)).toContain("operator");
  });
});
