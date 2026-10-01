import { createExternalState, createHarness } from "#testing/index.js";
import type { Step, Workflow } from "#namespace.js";
import { validateStructure } from "#workflow/validate.js";

const status = (value: string) => ({ type: "tracker.status", value });
const enter = { type: "tracker.comment", kind: "enter", marker: "enter:{stage}:{round}", body: "round {round}" };

const workflow: Workflow = {
  version: 1,
  name: "multi-entry", description: "test",
  stages: [
    { id: "spec", entry: true, step: "steps/spec.md",
      triggers: [{ name: "top-level item", when: { "run.stage": null, "rel.child-of.out.total": 0 } }],
      on_enter: [enter, status("spec")] },
    { id: "build", entry: true, step: "steps/build.md",
      triggers: [{ name: "child from a breakdown", when: { "run.stage": null, "rel.child-of.out.total": 1 } }],
      on_enter: [enter, status("build")] },
    { id: "done", terminal: true,
      triggers: [
        { name: "specced", when: { "run.stage": "spec", "run.outputs.spec.kind": "done" } },
        { name: "built", when: { "run.stage": "build", "run.outputs.build.kind": "done" } },
      ],
      on_enter: [status("done")] },
  ],
};

const step = (): Step => ({
  prompt: "go",
  output: { discriminator: "kind", shapes: { done: {} }, routes: [{ when: { kind: "done" }, effect: { type: "tracker.comment", kind: "output", marker: "output:{stage}:{round}", body: "ok" } }] },
} as Step);
const steps = new Map([["steps/spec.md", step()], ["steps/build.md", step()]]);

describe("several entry stages, end to end", () => {
  it("the workflow validates", () => {
    expect(validateStructure(workflow, steps).filter((p) => p.rule === "entry")).toEqual([]);
  });

  it("a top-level item starts at spec and a child at build", async () => {
    const world = createExternalState({ items: [
      { id: "1", labels: ["lr:auto"] },
      { id: "2", labels: ["lr:auto"], parent: "1" },
    ] });

    const parent = createHarness({ workflow, steps, source: world.source, pre: [world.pre], post: [world.post], item: "1",
      answers: { spec: '```json\n{"kind":"done"}\n```' } });
    const child = createHarness({ workflow, steps, source: world.source, pre: [world.pre], post: [world.post], item: "2",
      answers: { build: '```json\n{"kind":"done"}\n```' } });

    await parent.converge();
    await child.converge();

    expect(parent.trail()).toEqual(["spec", "done"]);
    expect(child.trail()).toEqual(["build", "done"]);
    expect(parent.counts()).toEqual({ spec: 1 });
    expect(child.counts()).toEqual({ build: 1 });
  });
});
