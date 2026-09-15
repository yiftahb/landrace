import { loadWorkflow } from "../../src/workflow/load.js";

describe("loadWorkflow", () => {
  it("parses the graph", async () => {
    const { workflow } = await loadWorkflow("tests/fixtures/minimal");
    expect(workflow.name).toBe("minimal");
    expect(workflow.stages.map((s) => s.id)).toEqual(["spec", "done"]);
  });

  it("parses a step's front matter and keeps the body as the prompt", async () => {
    const { steps } = await loadWorkflow("tests/fixtures/minimal");
    const step = steps.get("steps/spec.md");
    expect(step?.capabilities).toEqual(["repo:read"]);
    expect(step?.output?.discriminator).toBe("kind");
    expect(step?.prompt.trim()).toBe("Write the spec for {ticket.title}.");
  });

  it("rejects a workflow with a duplicate stage id rather than silently overwriting", async () => {
    await expect(loadWorkflow("tests/fixtures/duplicate-id")).rejects.toThrow(/duplicate stage id/);
  });

  it("fails loudly when a step file a stage names does not exist", async () => {
    await expect(loadWorkflow("tests/fixtures/missing-step")).rejects.toThrow(/steps\/nope\.md/);
  });
});
