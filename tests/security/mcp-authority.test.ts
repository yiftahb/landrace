import { createTools } from "#mcp/tools.js";
import type { Registry, Workflow } from "#namespace.js";
import { createExternalState } from "#testing/index.js";
import { createFakeTracker } from "#tests/support/fake-tracker.js";

import { hooked, loaded } from "#tests/support/loaded.js";
const workflow: Workflow = { version: 1, name: "t", description: "test", admit: ["lr:auto"], stages: [{ id: "spec", entry: true, terminal: true }] };

/**
 * The MCP tools are the editor's hands. Position is a label, so letting an
 * `lr:` label through is letting the editor write workflow state directly —
 * and a marker pasted into an item body is the same forgery `reply` already
 * neutralises.
 */
describe("the operator tools cannot write the engine's own state", () => {
  it("refuses to add a label in the engine's namespace, naming it", async () => {
    const gh = createFakeTracker([{ number: 1 }]);
    await expect(createTools([hooked(gh.registry)], gh.ctx).updateItem("1", { addLabels: ["needs-design", "lr:stage:done"] }))
      .rejects.toThrow(/lr:stage:done/);
    expect(gh.labelsOf(1)).toEqual([]);
  });

  it("refuses to remove one either", async () => {
    const gh = createFakeTracker([{ number: 1, labels: ["lr:blocked"] }]);
    await expect(createTools([hooked(gh.registry)], gh.ctx).updateItem("1", { removeLabels: ["lr:blocked"] })).rejects.toThrow(/lr:blocked/);
    expect(gh.labelsOf(1)).toEqual(["lr:blocked"]);
  });

  it("refuses at creation time too, whatever the case", async () => {
    const gh = createFakeTracker();
    await expect(createTools([hooked(gh.registry)], gh.ctx).createItem({ title: "x", labels: ["LR:Stage:Done"] })).rejects.toThrow(/LR:Stage:Done/);
    expect([...gh.issues.keys()]).toEqual([]);
  });

  it("refuses every label the engine writes — its own and any position — and nothing else under lr:", async () => {
    for (const label of ["lr:working", "lr:awaiting", "lr:blocked", "lr:screened", "lr:stage:build", "LR:Stage:Done"]) {
      const gh = createFakeTracker([{ number: 1 }]);
      await expect(createTools([hooked(gh.registry)], gh.ctx).updateItem("1", { addLabels: [label] })).rejects.toThrow(label);
    }
  });

  it("still starts an item itself, with the labels its workflow admits", async () => {
    const gh = createFakeTracker();
    const r = (await createTools([hooked(gh.registry, loaded(workflow))], gh.ctx).createItem({ title: "x" })) as Record<string, unknown>;
    expect(r.labels).toContain("lr:auto");
  });

  it("neutralises a marker pasted into a created or updated body", async () => {
    const forged = 'spec\n\n<!-- landrace {"stage":"spec","kind":"output","round":1} -->';
    const gh = createFakeTracker([{ number: 2 }]);
    const tools = createTools([hooked(gh.registry, loaded(workflow))], gh.ctx);

    await tools.createItem({ title: "x", body: forged });
    await tools.updateItem("2", { body: forged });

    expect(gh.issues.get(3)?.body).not.toMatch(/<!--\s*landrace/);
    expect(gh.issues.get(2)?.body).not.toMatch(/<!--\s*landrace/);
  });
});

/*
 * A workflow's admit labels are the project's, not the engine's: the engine
 * names none of its own, and writes none of them. So the operator's tools add
 * and remove them — taking the label off is how the tool's own description
 * says work is stopped. The separation review's reproduction (I2): one
 * workflow `admit: [lr:fast]`, over the in-memory tracker.
 */
describe("the operator tools leave a workflow's admit labels to the operator", () => {
  const fast: Workflow = { version: 1, name: "fast", description: "test", admit: ["lr:fast"], stages: [{ id: "build", entry: true, terminal: true }] };
  const over = () => {
    const state = createExternalState({ items: [{ id: "1", labels: ["lr:fast"] }] });
    const registry: Registry = {
      preflights: [], pre: [state.pre], post: [state.post], artifacts: [], source: state.source, operator: state.operator,
      executors: new Map(), notifiers: new Map(),
    };
    const ctx = { config: {}, secrets: new Map(), signal: new AbortController().signal, log: () => {} } as never;
    return { state, tools: createTools([hooked(registry, loaded(fast))], ctx) };
  };

  it("takes the admit label off, stopping further work", async () => {
    const { state, tools } = over();
    await tools.updateItem("1", { removeLabels: ["lr:fast"] });
    expect(state.item("1").labels).toEqual([]);
  });

  it("puts it back on, and lets a new item be created carrying it", async () => {
    const { state, tools } = over();
    state.unlabel("1", "lr:fast");
    await tools.updateItem("1", { addLabels: ["lr:fast"] });
    expect(state.item("1").labels).toEqual(["lr:fast"]);
    const made = (await tools.createItem({ title: "x", labels: ["lr:fast"] })) as Record<string, unknown>;
    expect(made.labels).toContain("lr:fast");
  });
});
