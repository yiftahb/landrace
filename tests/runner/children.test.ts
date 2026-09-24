import { createChild } from "#runner/children.js";
import { createExternalState } from "#testing/index.js";
import type { RuntimeContext } from "#namespace.js";

const ctx = { config: {}, secrets: new Map(), signal: new AbortController().signal, log: () => {} } as unknown as RuntimeContext;
const binding = { parent: "1", stage: "breakdown", round: 2 };

describe("createChild", () => {
  const world = () => createExternalState({ tickets: [{ id: "1", title: "big" }] });

  it("files the child under the bound parent, stage and round, ready to be worked", async () => {
    const state = world();
    const node = await createChild(state.operator, binding, { title: "api", body: "do it", priority: 1 }, ctx);
    const row = state.ticket(node.id);
    expect(row.parent).toBe("1");
    expect(row.labels).toContain("lr:auto");
    expect((await state.source.read("1", ctx)).nodes.find((n) => n.id === node.id)?.origin).toEqual(binding);
  });

  it("refuses an empty title, a body too long to post, and a priority that is not a small integer", async () => {
    const state = world();
    await expect(createChild(state.operator, binding, { title: "  " }, ctx)).rejects.toThrow(/title/);
    await expect(createChild(state.operator, binding, { title: "t", body: "x".repeat(40_000) }, ctx)).rejects.toThrow(/body/);
    await expect(createChild(state.operator, binding, { title: "t", priority: -1 }, ctx)).rejects.toThrow(/priority/);
    await expect(createChild(state.operator, binding, { title: "t", priority: 1.5 }, ctx)).rejects.toThrow(/priority/);
    expect(state.children("1")).toEqual([]);
  });

  it("says so when no operator hook is configured", async () => {
    await expect(createChild(null, binding, { title: "t" }, ctx)).rejects.toThrow(/no operator hook/);
  });

  it("refuses a binding whose parent is not a ticket id", async () => {
    await expect(createChild(world().operator, { ...binding, parent: "../1" }, { title: "t" }, ctx)).rejects.toThrow(/ticket id/);
  });
});
