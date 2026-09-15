import { loadWorkflow, WorkflowLoadError } from "../../src/workflow/load.js";
import { runValidate } from "../../src/cli/validate.js";

/**
 * `.landrace/workflow.yaml` is a repo file, so a contributor's PR can edit it,
 * and a step's body goes straight into an agent's prompt. A step path that
 * leaves the workflow directory is an exfiltration primitive.
 */
describe("a step file cannot come from outside the workflow directory", () => {
  it("refuses a step path that climbs out of the directory", async () => {
    const err = await loadWorkflow("tests/fixtures/escape-step").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowLoadError);
    expect((err as WorkflowLoadError).rule).toBe("step-path");
    expect((err as Error).message).toContain("../outside-secret.md");
    // whatever is out there stays out there
    expect((err as Error).message).not.toContain("very-secret-material");
  });

  it("refuses an absolute step path", async () => {
    const err = await loadWorkflow("tests/fixtures/absolute-step").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowLoadError);
    expect((err as WorkflowLoadError).rule).toBe("step-path");
  });

  it("reports it as a validation problem rather than an exception", async () => {
    for (const dir of ["tests/fixtures/escape-step", "tests/fixtures/absolute-step"]) {
      const { ok, problems } = await runValidate(dir);
      expect(ok).toBe(false);
      expect(problems).toContainEqual(expect.objectContaining({ rule: "step-path" }));
    }
  });

  it("still loads a step that sits inside the directory", async () => {
    const { steps } = await loadWorkflow("tests/fixtures/minimal");
    expect(steps.get("steps/spec.md")).toBeDefined();
  });
});
