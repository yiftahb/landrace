import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflow, parseStep } from "#workflow/load.js";

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
    expect(step?.prompt.trim()).toBe("Write the spec for {node.title}.");
  });

  it("rejects a workflow with a duplicate stage id rather than silently overwriting", async () => {
    await expect(loadWorkflow("tests/fixtures/duplicate-id")).rejects.toThrow(/duplicate stage id/);
  });

  it("fails loudly when a step file a stage names does not exist", async () => {
    await expect(loadWorkflow("tests/fixtures/missing-step")).rejects.toThrow(/steps\/nope\.md/);
  });
});

/**
 * A field a workflow author writes and the engine silently ignores is a lie in
 * a file they are relying on. `capabilities:` has always been refused when
 * nothing enforces it (unknownCapabilities); `skills:`, `budget.spec` and
 * `artifacts:` were parsed, dropped, and never mentioned again. Both schemas
 * are strict now, so the whole class is refused at load rather than only the
 * three that were noticed.
 */
describe("a declaration the engine does not read is refused, not ignored", () => {
  const dirs: string[] = [];
  const workflowDir = (yaml: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "landrace-wf-"));
    writeFileSync(join(dir, "workflow.yaml"), yaml);
    dirs.push(dir);
    return dir;
  };
  const graph = (extra: string) => `version: 1\nname: t\n${extra}stages:\n  - id: a\n    entry: true\n`;

  afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }); });

  it("refuses a step declaring skills, which nothing hands to an agent", () => {
    expect(() => parseStep("---\nskills: [superpowers:brainstorming]\n---\nbody"))
      .toThrow(/skills/);
  });

  it("still accepts the front matter fields the engine does read", () => {
    const step = parseStep("---\nmodel: haiku\ncapabilities: []\n---\nbody");
    expect(step.model).toBe("haiku");
  });

  it("refuses a budget key nothing reads, while keeping the one that is read", async () => {
    await expect(loadWorkflow(workflowDir(graph("budget:\n  spec: 3\n  review: 4\n"))))
      .rejects.toThrow(/spec/);
    const { workflow } = await loadWorkflow(workflowDir(graph("budget:\n  stepTimeout: 10m\n")));
    expect(workflow.budget?.stepTimeout).toBe("10m");
  });

  it("refuses an artifacts block, which no reader in the engine has ever had", async () => {
    await expect(loadWorkflow(workflowDir(graph("artifacts:\n  spec: { hook: pages, ref: x }\n"))))
      .rejects.toThrow(/artifacts/);
  });

  it("refuses a stage key the engine does not read, such as the on_exit that must never exist", async () => {
    await expect(loadWorkflow(workflowDir("version: 1\nname: t\nstages:\n  - id: a\n    entry: true\n    on_exit: []\n")))
      .rejects.toThrow(/on_exit/);
  });
});
