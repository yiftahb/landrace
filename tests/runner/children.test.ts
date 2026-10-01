import { CHILD_SERVER_NAME, CHILD_TOOL } from "#conventions.js";
import { childServerFor, createChild } from "#runner/children.js";
import { createExternalState } from "#testing/index.js";
import type { RuntimeContext } from "#namespace.js";

const ctx = { config: {}, secrets: new Map(), signal: new AbortController().signal, log: () => {} } as unknown as RuntimeContext;
const binding = { parent: "1", stage: "breakdown", round: 2 };

describe("createChild", () => {
  const world = () => createExternalState({ items: [{ id: "1", title: "big" }] });

  it("files the child under the bound parent, stage and round, ready to be worked", async () => {
    const state = world();
    const node = await createChild(state.operator, binding, { title: "api", body: "do it", priority: 1 }, ctx);
    const row = state.item(node.id);
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

  it("refuses a binding whose parent is not an item id", async () => {
    await expect(createChild(world().operator, { ...binding, parent: "../1" }, { title: "t" }, ctx)).rejects.toThrow(/item id/);
  });
});

/*
 * The engine starts its own item server and says so in full: which process,
 * with the binding already on its command line, under which name, offering
 * which tool. An executor only has to hand it over, so it never learns
 * landrace's CLI or its tool names.
 */
describe("childServerFor", () => {
  const base = { command: "/usr/bin/node", args: ["cli.js", "mcp", "--workflow", "/w/.landrace"] };

  it("puts the binding on the server's own command line", () => {
    expect(childServerFor(base, { parent: "12", stage: "breakdown", round: 2 })).toEqual({
      name: CHILD_SERVER_NAME,
      command: "/usr/bin/node",
      args: ["cli.js", "mcp", "--workflow", "/w/.landrace", "--child", "12", "--stage", "breakdown", "--round", "2"],
      tools: [CHILD_TOOL],
    });
  });

  it("refuses a binding its command line could not carry as meant", () => {
    expect(() => childServerFor(base, { parent: "-x", stage: "s", round: 1 })).toThrow(/parent/);
    expect(() => childServerFor(base, { parent: "1", stage: "-s", round: 1 })).toThrow(/stage/);
    expect(() => childServerFor(base, { parent: "1", stage: "s", round: 0 })).toThrow(/round/);
  });
});
