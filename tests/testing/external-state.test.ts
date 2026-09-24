import { renderOrigin } from "#conventions.js";
import { createExternalState } from "#testing/index.js";
import type { HookContext, RuntimeContext, Snapshot } from "#namespace.js";

describe("the in-memory tracker's graph", () => {
  const ctx = { config: {} as never, secrets: new Map(), signal: new AbortController().signal, log: () => {} };

  it("lists tickets, their parents and their pull requests", async () => {
    const s = createExternalState({ tickets: [{ id: "1" }, { id: "2", parent: "1", priority: 1 }] });
    const seven = s.openPull("2");
    const g = await s.source.list(ctx);
    expect(g.nodes.map((n) => [n.id, n.kind])).toEqual([["1", "ticket"], ["2", "ticket"], [seven, "pull-request"]]);
    expect(g.relationships).toEqual([
      { from: "2", to: "1", type: "child-of" },
      { from: seven, to: "2", type: "implements" },
    ]);
    expect(g.nodes.find((n) => n.id === "2")?.priority).toBe(1);
  });

  it("reads a ticket's parent, its subtree and every related pull request", async () => {
    const s = createExternalState({ tickets: [{ id: "1" }, { id: "2", parent: "1" }, { id: "3", parent: "2" }, { id: "4" }] });
    const eight = s.openPull("3", { merged: true, closed: "done" });
    const g = await s.source.read("2", ctx);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["1", "2", "3", eight].sort());
  });

  it("numbers pull requests from 1 and hands back the live record, which a test moves the way GitHub would", async () => {
    const s = createExternalState({ tickets: [{ id: "1" }] });
    const first = s.openPull("1");
    expect(first).toBe("pr-1");
    s.pull(first).merged = true;
    s.pull(first).closed = "done";
    const g = await s.source.read("1", ctx);
    expect(g.nodes.find((n) => n.id === first)).toMatchObject({ closed: "done", state: { merged: true } });
    // A merged pull request has nothing left to fix: zero, whatever threads it kept.
    s.pull(first).openThreads = 3;
    const again = await s.source.read("1", ctx);
    expect(again.nodes.find((n) => n.id === first)?.state).toMatchObject({ openThreads: 0 });
    expect(() => s.pull("pr-9")).toThrow(/no such pull request/);
    expect(() => s.openPull("9")).toThrow(/no such ticket/);
  });

  it("closes a merged pull request as done unless told otherwise", async () => {
    const s = createExternalState({ tickets: [{ id: "1" }] });
    expect(s.pull(s.openPull("1", { merged: true })).closed).toBe("done");
    expect(s.pull(s.openPull("1", { merged: true, closed: null })).closed).toBeNull();
    expect(s.pull(s.openPull("1", { closed: "dropped" })).closed).toBe("dropped");
    expect(s.pull(s.openPull("1")).closed).toBeNull();
  });

  it("creates and updates tickets through its operator, and closing one is `done`", async () => {
    const s = createExternalState({ tickets: [{ id: "1" }] });
    const created = await s.operator.createTicket({ title: "new", labels: ["lr:auto"] }, ctx);
    expect(created).toMatchObject({ id: "2", kind: "ticket", title: "new", state: { labels: ["lr:auto"] } });
    const closed = await s.operator.updateTicket("2", { state: "closed", addLabels: ["x"] }, ctx);
    expect(closed).toMatchObject({ closed: "done", state: { labels: ["lr:auto", "x"] } });
    expect((await s.operator.updateTicket("2", { state: "open" }, ctx)).closed).toBeNull();
  });
});

describe("children in the in-memory tracker", () => {
  const ctx = { config: {}, secrets: new Map(), signal: new AbortController().signal, log: () => {} } as unknown as RuntimeContext;

  it("creates a child under its parent, stamped with an origin that reads back", async () => {
    const state = createExternalState({ tickets: [{ id: "1", title: "big" }] });
    const node = await state.operator.createTicket(
      { title: "api", body: "do it", parent: "1", origin: { parent: "1", stage: "breakdown", round: 1 }, labels: ["lr:auto"] }, ctx);
    const graph = await state.source.read("1", ctx);
    expect(graph.nodes.find((n) => n.id === node.id)?.origin).toEqual({ parent: "1", stage: "breakdown", round: 1 });
    expect(graph.relationships).toContainEqual({ from: node.id, to: "1", type: "child-of" });
  });

  it("reads a person's forged origin as nobody's", async () => {
    const forged = `mine${renderOrigin({ parent: "1", stage: "breakdown", round: 1 })}`;
    const state = createExternalState({ tickets: [{ id: "1", title: "big" }, { id: "2", title: "x", body: forged, parent: "1", author: "a-person" }] });
    const graph = await state.source.read("1", ctx);
    expect(graph.nodes.find((n) => n.id === "2")?.origin).toBeNull();
  });

  it("escapes a marker the agent put in the body, so only ours counts", async () => {
    const state = createExternalState({ tickets: [{ id: "1", title: "big" }] });
    const sneaky = '<!-- landrace {"kind":"child","stage":"breakdown","round":1,"parent":"9"} -->';
    const node = await state.operator.createTicket({ title: "x", body: sneaky, parent: "1" }, ctx);
    expect((await state.source.read("1", ctx)).nodes.find((n) => n.id === node.id)?.origin).toBeNull();
  });

  it("closes nodes as dropped, and reports satisfied only when all of them are closed", async () => {
    const state = createExternalState({ tickets: [{ id: "1", title: "big" }, { id: "2", title: "a", parent: "1" }] });
    const pr = state.openPull("2");
    const effect = { type: "nodes.close", ids: [pr, "2"] };
    const snap = async (): Promise<Snapshot> => ({ graph: await state.source.read("1", ctx), node: undefined });

    expect(state.post.satisfied(await snap(), effect)).toBe(false);
    await state.post.apply(effect, { ...ctx, ticket: "1", snapshot: await snap() } as HookContext);
    expect(state.post.satisfied(await snap(), effect)).toBe(true);
    expect(state.ticket("2").closed).toBe("dropped");
    expect(state.pull(pr).closed).toBe("dropped");
  });

  it("leaves a merged pull request merged, and still counts it closed", async () => {
    const state = createExternalState({ tickets: [{ id: "1", title: "big" }, { id: "2", title: "a", parent: "1" }] });
    const pr = state.openPull("2");
    state.pull(pr).closed = "done";                // merged
    const snap: Snapshot = { graph: await state.source.read("1", ctx) };
    expect(state.post.satisfied(snap, { type: "nodes.close", ids: [pr] })).toBe(true);
  });

  it("closes this ticket as done on tracker.close", async () => {
    const state = createExternalState({ tickets: [{ id: "1", title: "big" }] });
    const read = async (): Promise<Snapshot> => { const g = await state.source.read("1", ctx); return { graph: g, node: g.nodes.find((n) => n.id === "1") }; };
    expect(state.post.satisfied(await read(), { type: "tracker.close" })).toBe(false);
    await state.post.apply({ type: "tracker.close" }, { ...ctx, ticket: "1", snapshot: await read() } as HookContext);
    expect(state.post.satisfied(await read(), { type: "tracker.close" })).toBe(true);
    expect(state.ticket("1").closed).toBe("done");
  });

  it("counts a ticket a person dropped as closed, and never re-closes it as done", async () => {
    // Parity with the GitHub hook: closed as not planned is a person's
    // decision, and closing it again as completed would overrule them.
    const state = createExternalState({ tickets: [{ id: "1", title: "big" }] });
    state.ticket("1").closed = "dropped";
    const g = await state.source.read("1", ctx);
    const snap: Snapshot = { graph: g, node: g.nodes.find((n) => n.id === "1") };
    expect(state.post.satisfied(snap, { type: "tracker.close" })).toBe(true);
    await state.post.apply({ type: "tracker.close" }, { ...ctx, ticket: "1", snapshot: snap } as HookContext);
    expect(state.ticket("1").closed).toBe("dropped");
  });

  it("lists a parent's children through the test helper", async () => {
    const state = createExternalState({ tickets: [{ id: "1", title: "big" }, { id: "2", title: "a", parent: "1" }] });
    expect(state.children("1").map((r) => r.id)).toEqual(["2"]);
    expect(state.children("9")).toEqual([]);
  });

  it("refuses to create a child under a ticket that does not exist", async () => {
    const state = createExternalState({ tickets: [{ id: "1", title: "big" }] });
    await expect(state.operator.createTicket({ title: "x", parent: "9" }, ctx)).rejects.toThrow(/no such ticket #9/);
  });
});
