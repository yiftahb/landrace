import { DEFAULT_STEP_TIMEOUT_MS, stepTimeoutMs } from "#runner/budget.js";
import type { Workflow } from "#namespace.js";

describe("the step timeout", () => {
  const workflow = (budget?: Record<string, unknown>): Workflow => ({
    version: 1,
    name: "t",
    stages: [{ id: "a", entry: true }],
    ...(budget === undefined ? {} : { budget: budget as NonNullable<Workflow["budget"]> }),
  });

  it("reads the workflow's own budget", () => {
    expect(stepTimeoutMs(workflow({ stepTimeout: "10m" }))).toBe(600_000);
    expect(stepTimeoutMs(workflow({ stepTimeout: "90s" }))).toBe(90_000);
  });

  it("falls back to one number when the workflow names none", () => {
    // Not zero and not infinity: a workflow with no budget still has to bound
    // a step, or a hung agent holds its item's lock until the process dies.
    expect(stepTimeoutMs(workflow())).toBe(DEFAULT_STEP_TIMEOUT_MS);
    expect(stepTimeoutMs(workflow({}))).toBe(DEFAULT_STEP_TIMEOUT_MS);
  });

  it("refuses a budget it cannot read, naming the field", () => {
    for (const bad of ["600", "ten minutes", "", "2 m", 600, null, ["10m"]]) {
      expect(() => stepTimeoutMs(workflow({ stepTimeout: bad }))).toThrow(/stepTimeout/);
    }
  });
});
