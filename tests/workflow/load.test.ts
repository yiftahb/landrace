import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  const graph = (extra: string) => `version: 1\nname: t\ndescription: test\n${extra}stages:\n  - id: a\n    entry: true\n`;

  afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }); });

  // JSON is YAML, so the helper's string form takes an object unchanged.
  const wf = (extra: Record<string, unknown>): string =>
    workflowDir(JSON.stringify({ version: 1, name: "Main", stages: [{ id: "a", entry: true, terminal: true }], ...extra }));

  it("requires a description", async () => {
    await expect(loadWorkflow(wf({}))).rejects.toThrow(/description/);
  });

  it("reads name as the display title, description and admit", async () => {
    const { workflow } = await loadWorkflow(wf({ name: "Technical Support", description: "Support items assigned to me.", admit: ["lr:support"] }));
    expect(workflow).toMatchObject({ name: "Technical Support", description: "Support items assigned to me.", admit: ["lr:support"] });
  });

  it("refuses an empty admit label", async () => {
    await expect(loadWorkflow(wf({ description: "d", admit: [""] }))).rejects.toThrow(/admit/);
  });

  it("refuses a step declaring skills: plugins come from agent.plugins for every step, never from front matter", () => {
    expect(() => parseStep("---\nskills: [superpowers:brainstorming]\n---\nbody"))
      .toThrow(/skills/);
  });

  it("still accepts the front matter fields the engine does read", () => {
    const step = parseStep("---\nmodel: haiku\ncapabilities: []\n---\nbody");
    expect(step.model).toBe("haiku");
  });

  it("reads a step's own timeout, and refuses one that is not a duration it could keep", () => {
    expect(parseStep("---\ntimeout: 120m\n---\nbody").timeout).toBe("120m");
    for (const bad of ["120", "2 hours", "0m", "1.5h", "999999h"]) {
      expect(() => parseStep(`---\ntimeout: ${bad}\n---\nbody`)).toThrow(/timeout/);
    }
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
    await expect(loadWorkflow(workflowDir("version: 1\nname: t\ndescription: test\nstages:\n  - id: a\n    entry: true\n    on_exit: []\n")))
      .rejects.toThrow(/on_exit/);
  });

  it("reads a goto list written once and repeated by YAML reference, and refuses a key a goto entry does not have", async () => {
    const yaml = [
      "version: 1", "name: t", "description: test", "stages:",
      "  - id: a", "    entry: true",
      "  - id: b", "    goto: &back", "      - a", '      - { stage: a, when: { "run.counters.a": { $lt: 3 } } }',
      "  - id: c", "    goto: *back", "",
    ].join("\n");
    const { workflow } = await loadWorkflow(workflowDir(yaml));
    const listed = (id: string) => workflow.stages.find((s) => s.id === id)?.goto;
    expect(listed("c")).toEqual(listed("b"));
    expect(listed("b")).toEqual(["a", { stage: "a", when: { "run.counters.a": { $lt: 3 } } }]);

    await expect(loadWorkflow(workflowDir(yaml.replace("{ stage: a, when", "{ stage: a, cap: 3, when"))))
      .rejects.toThrow(/cap/);
  });
});

/**
 * A stage's `branch` is a template the runner fills per item and hands to
 * git as argv. What it can be is decided here, once, with an example item —
 * a workflow whose branch git would refuse for every item is found by
 * `landrace validate`, not by the first build that runs.
 */
describe("a stage's branch", () => {
  const dirs: string[] = [];
  const withBranch = (branch: string, step = true): string => {
    const dir = mkdtempSync(join(tmpdir(), "landrace-wf-"));
    dirs.push(dir);
    mkdirSync(join(dir, "steps"));
    writeFileSync(join(dir, "steps", "build.md"), "---\ncapabilities: [repo:read, repo:write]\n---\nbuild\n");
    writeFileSync(join(dir, "workflow.yaml"), [
      "version: 1",
      "name: t", "description: test",
      "stages:",
      "  - id: build",
      "    entry: true",
      ...(step ? ["    step: steps/build.md"] : []),
      `    branch: ${JSON.stringify(branch)}`,
      "",
    ].join("\n"));
    return dir;
  };

  afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }); });

  it("loads a template that makes a branch git accepts", async () => {
    const { workflow } = await loadWorkflow(withBranch("landrace/{item}"));
    expect(workflow.stages[0]?.branch).toBe("landrace/{item}");
  });

  it("refuses a template git could never accept, naming the stage and the rendered name", async () => {
    await expect(loadWorkflow(withBranch("feat..{item}")))
      .rejects.toMatchObject({ rule: "branch", message: expect.stringMatching(/stage "build"[\s\S]*"feat\.\.1"/) });
    await expect(loadWorkflow(withBranch("-{item}"))).rejects.toMatchObject({ rule: "branch" });
  });

  /*
   * Snapshot content is not branch material: `{node.title}` would be
   * whatever a person typed, handed to git. Left in place it is even a legal
   * ref, braces and all, which is why it is refused by name.
   */
  it("refuses a name outside {item}, {stage} and {round}", async () => {
    await expect(loadWorkflow(withBranch("landrace/{node.title}")))
      .rejects.toMatchObject({ rule: "branch", message: expect.stringMatching(/\{node\.title\}/) });
  });

  /*
   * A declaration nothing reads: the branch is where a step's worktree is
   * checked out, and a stage with no step has no worktree.
   */
  it("refuses a branch on a stage that runs no step", async () => {
    await expect(loadWorkflow(withBranch("landrace/{item}", false)))
      .rejects.toMatchObject({ rule: "branch", message: expect.stringMatching(/no step/) });
  });
});
