import { validateSemantics } from "../../src/workflow/validate.js";
import type { Step } from "../../src/workflow/load.js";
import type { Workflow } from "../../src/core/types.js";

const noSteps = new Map<string, Step>();
const rules = (w: Workflow, steps = noSteps, provided?: string[]) =>
  validateSemantics(w, steps, provided).map((p) => p.rule);

describe("semantic validation", () => {
  it("flags a loop with no counter bound", () => {
    const w: Workflow = { version: 1, name: "t", stages: [
      { id: "a", entry: true, triggers: [{ when: { "run.stage": "b" } }] },
      { id: "b", triggers: [{ when: { "run.stage": "a" } }] },
    ] };
    expect(rules(w)).toContain("cycle-bound");
  });

  it("accepts a loop bounded by a counter comparison", () => {
    const w: Workflow = { version: 1, name: "t", stages: [
      { id: "a", entry: true, triggers: [{ when: { "run.stage": "b", "run.counters.a": { $lt: 3 } } }] },
      { id: "b", triggers: [{ when: { "run.stage": "a" } }] },
    ] };
    expect(rules(w)).not.toContain("cycle-bound");
  });

  it("flags a declared output shape with no route", () => {
    const steps = new Map<string, Step>([["s.md", {
      prompt: "",
      output: { discriminator: "kind", shapes: { spec: {}, questions: {} },
                routes: [{ when: { kind: "spec" }, effect: { type: "x" } }] },
    }]]);
    const w: Workflow = { version: 1, name: "t", stages: [{ id: "a", entry: true, step: "s.md" }] };
    expect(rules(w, steps)).toContain("totality");
  });

  it("flags two stages whose identities can both hold", () => {
    const w: Workflow = { version: 1, name: "t", stages: [
      { id: "a", entry: true, identity: { "run.stage": "a" } },
      { id: "b", identity: { "run.stage": "a" } },
    ] };
    expect(rules(w)).toContain("identity");
  });

  it("flags a non-terminal stage nothing leads away from", () => {
    const w: Workflow = { version: 1, name: "t", stages: [
      { id: "a", entry: true, triggers: [{ when: { "run.stage": "z" } }] },
      { id: "b", triggers: [{ when: { "run.stage": "a" } }] },
    ] };
    expect(rules(w)).toContain("dead-end");
  });

  it("flags a predicate path nothing provides", () => {
    const w: Workflow = { version: 1, name: "t", stages: [
      { id: "a", entry: true, triggers: [{ when: { "ticket.nonsense": 1 } }] },
    ] };
    expect(rules(w, noSteps, ["ticket.labels", "run.stage"])).toContain("path-coverage");
  });

  it("checks no paths when no hook declares what it provides", () => {
    const w: Workflow = { version: 1, name: "t", stages: [
      { id: "a", entry: true, triggers: [{ when: { "ticket.nonsense": 1 } }] },
    ] };
    expect(rules(w, noSteps, undefined)).not.toContain("path-coverage");
  });
});
