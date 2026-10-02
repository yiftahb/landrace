import { renderOrigin } from "#conventions.js";
import { createExternalState } from "#testing/index.js";
import type { HookContext, RuntimeContext, Snapshot } from "#namespace.js";

describe("the in-memory tracker's graph", () => {
  const ctx = { config: {} as never, secrets: new Map(), signal: new AbortController().signal, log: () => {} };

  it("lists items, their parents and their pull requests", async () => {
    const s = createExternalState({ items: [{ id: "1" }, { id: "2", parent: "1", priority: 1 }] });
    const seven = s.openPull("2");
    const g = await s.source.list(ctx);
    expect(g.nodes.map((n) => [n.id, n.kind])).toEqual([["1", "item"], ["2", "item"], [seven, "pull-request"]]);
    expect(g.relationships).toEqual([
      { from: "2", to: "1", type: "child-of" },
      { from: seven, to: "2", type: "implements" },
    ]);
    expect(g.nodes.find((n) => n.id === "2")?.priority).toBe(1);
  });

  it("reads an item's parent, its subtree and every related pull request", async () => {
    const s = createExternalState({ items: [{ id: "1" }, { id: "2", parent: "1" }, { id: "3", parent: "2" }, { id: "4" }] });
    const eight = s.openPull("3", { merged: true, closed: "done" });
    const g = await s.source.read("2", ctx);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["1", "2", "3", eight].sort());
  });

  it("numbers pull requests from 1 and hands back the live record, which a test moves the way GitHub would", async () => {
    const s = createExternalState({ items: [{ id: "1" }] });
    const first = s.openPull("1");
    expect(first).toBe("pr-1");
    s.pull(first).merged = true;
    s.pull(first).closed = "done";
    const g = await s.source.read("1", ctx);
    expect(g.nodes.find((n) => n.id === first)).toMatchObject({ closed: "done", state: { merged: true } });
    // A merged pull request has nothing left to fix: zero, whatever threads it kept.
    s.pull(first).openThreads = 3;
    s.pull(first).awaitingFix = 3;
    const again = await s.source.read("1", ctx);
    expect(again.nodes.find((n) => n.id === first)?.state).toMatchObject({ openThreads: 0, awaitingFix: 0 });
    expect(() => s.pull("pr-9")).toThrow(/no such pull request/);
    expect(() => s.openPull("9")).toThrow(/no such item/);
  });

  it("gives a pull request a head of its own and nothing checking it, unless told", async () => {
    const s = createExternalState({ items: [{ id: "1" }] });
    const plain = s.openPull("1");
    const told = s.openPull("1", { headSha: "abc", checks: "pending", failed: [{ name: "test", log: null }] });
    const g = await s.source.read("1", ctx);
    expect(g.nodes.find((n) => n.id === plain)?.state).toMatchObject({ headSha: "sha-1", checks: "none", ciPending: 0, ciFailed: 0 });
    expect(g.nodes.find((n) => n.id === told)?.state).toMatchObject({ headSha: "abc", checks: "pending", ciPending: 1, ciFailed: 0 });
    expect(s.pull(plain).failed).toEqual([]);
    expect(s.pull(told).failed).toEqual([{ name: "test", log: null }]);
  });

  it("closes a merged pull request as done unless told otherwise", async () => {
    const s = createExternalState({ items: [{ id: "1" }] });
    expect(s.pull(s.openPull("1", { merged: true })).closed).toBe("done");
    expect(s.pull(s.openPull("1", { merged: true, closed: null })).closed).toBeNull();
    expect(s.pull(s.openPull("1", { closed: "dropped" })).closed).toBe("dropped");
    expect(s.pull(s.openPull("1")).closed).toBeNull();
  });

  it("creates and updates items through its operator, and closing one is `done`", async () => {
    const s = createExternalState({ items: [{ id: "1" }] });
    const created = await s.operator.createItem({ title: "new", labels: ["lr:auto"] }, ctx);
    expect(created).toMatchObject({ id: "2", kind: "item", title: "new", state: { labels: ["lr:auto"] } });
    const closed = await s.operator.updateItem("2", { state: "closed", addLabels: ["x"] }, ctx);
    expect(closed).toMatchObject({ closed: "done", state: { labels: ["lr:auto", "x"] } });
    expect((await s.operator.updateItem("2", { state: "open" }, ctx)).closed).toBeNull();
  });
});

describe("children in the in-memory tracker", () => {
  const ctx = { config: {}, secrets: new Map(), signal: new AbortController().signal, log: () => {} } as unknown as RuntimeContext;

  it("creates a child under its parent, stamped with an origin that reads back", async () => {
    const state = createExternalState({ items: [{ id: "1", title: "big" }] });
    const node = await state.operator.createItem(
      { title: "api", body: "do it", parent: "1", origin: { parent: "1", stage: "breakdown", round: 1 }, labels: ["lr:auto"] }, ctx);
    const graph = await state.source.read("1", ctx);
    expect(graph.nodes.find((n) => n.id === node.id)?.origin).toEqual({ parent: "1", stage: "breakdown", round: 1 });
    expect(graph.relationships).toContainEqual({ from: node.id, to: "1", type: "child-of" });
  });

  it("reads a person's forged origin as nobody's", async () => {
    const forged = `mine${renderOrigin({ parent: "1", stage: "breakdown", round: 1 })}`;
    const state = createExternalState({ items: [{ id: "1", title: "big" }, { id: "2", title: "x", body: forged, parent: "1", author: "a-person" }] });
    const graph = await state.source.read("1", ctx);
    expect(graph.nodes.find((n) => n.id === "2")?.origin).toBeNull();
  });

  it("escapes a marker the agent put in the body, so only ours counts", async () => {
    const state = createExternalState({ items: [{ id: "1", title: "big" }] });
    const sneaky = '<!-- landrace {"kind":"child","stage":"breakdown","round":1,"parent":"9"} -->';
    const node = await state.operator.createItem({ title: "x", body: sneaky, parent: "1" }, ctx);
    expect((await state.source.read("1", ctx)).nodes.find((n) => n.id === node.id)?.origin).toBeNull();
  });

  it("closes nodes as dropped, and reports satisfied only when all of them are closed", async () => {
    const state = createExternalState({ items: [{ id: "1", title: "big" }, { id: "2", title: "a", parent: "1" }] });
    const pr = state.openPull("2");
    const effect = { type: "nodes.close", ids: [pr, "2"] };
    const snap = async (): Promise<Snapshot> => ({ graph: await state.source.read("1", ctx), node: undefined });

    expect(state.post.satisfied(await snap(), effect)).toBe(false);
    await state.post.apply(effect, { ...ctx, item: "1", snapshot: await snap() } as HookContext);
    expect(state.post.satisfied(await snap(), effect)).toBe(true);
    expect(state.item("2").closed).toBe("dropped");
    expect(state.pull(pr).closed).toBe("dropped");
  });

  it("leaves a merged pull request merged, and still counts it closed", async () => {
    const state = createExternalState({ items: [{ id: "1", title: "big" }, { id: "2", title: "a", parent: "1" }] });
    const pr = state.openPull("2");
    state.pull(pr).closed = "done";                // merged
    const snap: Snapshot = { graph: await state.source.read("1", ctx) };
    expect(state.post.satisfied(snap, { type: "nodes.close", ids: [pr] })).toBe(true);
  });

  it("closes this item as done on tracker.close", async () => {
    const state = createExternalState({ items: [{ id: "1", title: "big" }] });
    const read = async (): Promise<Snapshot> => { const g = await state.source.read("1", ctx); return { graph: g, node: g.nodes.find((n) => n.id === "1") }; };
    expect(state.post.satisfied(await read(), { type: "tracker.close" })).toBe(false);
    await state.post.apply({ type: "tracker.close" }, { ...ctx, item: "1", snapshot: await read() } as HookContext);
    expect(state.post.satisfied(await read(), { type: "tracker.close" })).toBe(true);
    expect(state.item("1").closed).toBe("done");
  });

  it("counts an item a person dropped as closed, and never re-closes it as done", async () => {
    // Parity with the GitHub hook: closed as not planned is a person's
    // decision, and closing it again as completed would overrule them.
    const state = createExternalState({ items: [{ id: "1", title: "big" }] });
    state.item("1").closed = "dropped";
    const g = await state.source.read("1", ctx);
    const snap: Snapshot = { graph: g, node: g.nodes.find((n) => n.id === "1") };
    expect(state.post.satisfied(snap, { type: "tracker.close" })).toBe(true);
    await state.post.apply({ type: "tracker.close" }, { ...ctx, item: "1", snapshot: snap } as HookContext);
    expect(state.item("1").closed).toBe("dropped");
  });

  it("lists a parent's children through the test helper", async () => {
    const state = createExternalState({ items: [{ id: "1", title: "big" }, { id: "2", title: "a", parent: "1" }] });
    expect(state.children("1").map((r) => r.id)).toEqual(["2"]);
    expect(state.children("9")).toEqual([]);
  });

  it("refuses to create a child under an item that does not exist", async () => {
    const state = createExternalState({ items: [{ id: "1", title: "big" }] });
    await expect(state.operator.createItem({ title: "x", parent: "9" }, ctx)).rejects.toThrow(/no such item #9/);
  });
});

/**
 * Publishing, as far as a tracker with no repository behind it can go: a pull
 * request is a record it keeps, found by the branch it was opened from, and a
 * push is something it can only be told about.
 */
describe("publishing in the in-memory tracker", () => {
  const ctx = { config: {} as never, secrets: new Map(), signal: new AbortController().signal, log: () => {} };
  const read = async (state: ReturnType<typeof createExternalState>): Promise<Snapshot> => {
    const graph = await state.source.read("1", ctx);
    return { graph, node: graph.nodes.find((n) => n.id === "1") };
  };
  const apply = async (state: ReturnType<typeof createExternalState>, effect: { type: string; [k: string]: unknown }) =>
    state.post.apply(effect, { ...ctx, item: "1", snapshot: await read(state) } as HookContext);

  it("opens a pull request from the effect's branch, which then reads back as satisfied", async () => {
    const state = createExternalState({ items: [{ id: "1" }] });
    const open = { type: "pull.open", branch: "landrace/1" };

    expect(state.post.satisfied(await read(state), open)).toBe(false);
    await apply(state, open);

    const snapshot = await read(state);
    expect(state.post.satisfied(snapshot, open)).toBe(true);
    expect(snapshot.graph).toMatchObject({
      nodes: expect.arrayContaining([expect.objectContaining({ kind: "pull-request", state: expect.objectContaining({ branch: "landrace/1" }) })]),
      relationships: expect.arrayContaining([expect.objectContaining({ to: "1", type: "implements" })]),
    });
  });

  /*
   * One item, two branches, two pull requests: a pull request from one
   * branch says nothing about whether the other has one.
   */
  it("keeps two branches' pull requests apart", async () => {
    const state = createExternalState({ items: [{ id: "1" }] });
    await apply(state, { type: "pull.open", branch: "api/1" });

    expect(state.post.satisfied(await read(state), { type: "pull.open", branch: "api/1" })).toBe(true);
    expect(state.post.satisfied(await read(state), { type: "pull.open", branch: "ui/1" })).toBe(false);
  });

  it("counts a merged pull request as opened, and an abandoned one as not", async () => {
    const state = createExternalState({ items: [{ id: "1" }] });
    state.openPull("1", { branch: "landrace/1", merged: true });
    state.openPull("1", { branch: "other/1", closed: "dropped" });

    expect(state.post.satisfied(await read(state), { type: "pull.open", branch: "landrace/1" })).toBe(true);
    expect(state.post.satisfied(await read(state), { type: "pull.open", branch: "other/1" })).toBe(false);
  });

  /*
   * Threads are counts here, and a review moves them the way the GitHub hook's
   * replies do: a finding opens one awaiting a fix, a `fix` reply hands one to
   * the person, and any other reply hands one back.
   */
  it("moves the awaiting-fix count with each finding and each reply, once per round", async () => {
    const state = createExternalState({ items: [{ id: "1" }] });
    const pr = state.openPull("1", { branch: "landrace/1", openThreads: 1 });
    expect(state.pull(pr).awaitingFix).toBe(1);
    const at = (marker: string, output: object) => ({ type: "pull.review", branch: "landrace/1", marker, output });

    await apply(state, at("review:1", { findings: [{ file: "a.ts", line: 1, body: "x" }] }));
    expect(state.pull(pr)).toMatchObject({ openThreads: 2, awaitingFix: 2 });

    const fix = at("fix:1", { replies: [{ thread: "T1", body: "Fixed." }, { thread: "T2", body: "Not changed, because…" }], resolved: ["T1"] });
    await apply(state, fix);
    await apply(state, fix);
    expect(state.pull(pr)).toMatchObject({ openThreads: 2, awaitingFix: 0 });

    await apply(state, at("review:2", { replies: [{ thread: "T1", body: "Still wrong." }] }));
    expect(state.pull(pr)).toMatchObject({ openThreads: 2, awaitingFix: 1 });

    const graph = await state.source.read("1", ctx);
    expect(graph.nodes.find((n) => n.id === pr)?.state).toMatchObject({ openThreads: 2, awaitingFix: 1 });
  });

  it("refuses a publishing effect that names no branch", async () => {
    const state = createExternalState({ items: [{ id: "1" }] });
    expect(() => state.post.satisfied({}, { type: "pull.open" })).toThrow(/branch/);
    expect(() => state.post.satisfied({}, { type: "branch.push" })).toThrow(/branch/);
  });

  /*
   * There is no repository here, so nothing can say the remote already has
   * the branch's head — and pushing a branch that is already there changes
   * nothing, so the push is simply applied every time it is planned.
   */
  it("takes a push every time it is planned, and records it", async () => {
    const state = createExternalState({ items: [{ id: "1" }] });
    const push = { type: "branch.push", branch: "landrace/1" };
    expect(state.post.satisfied(await read(state), push)).toBe(false);
    await apply(state, push);
    await apply(state, push);
    expect(state.pushes()).toEqual(["landrace/1", "landrace/1"]);
  });
});

/*
 * A tracker a workflow may read and never write — the shape of a company's
 * "merge requests waiting for my review" source. A write reaching it is a
 * workflow or an operator doing what a read-only workflow must never do, so
 * it fails, naming what was asked: a write that silently did nothing would
 * read back as one that was never planned, which is the leak this exists to
 * catch.
 */
describe("a read-only in-memory tracker", () => {
  const ctx = { config: {}, secrets: new Map(), signal: new AbortController().signal, log: () => {} } as unknown as RuntimeContext;
  const seeded = () => createExternalState({
    items: [{ id: "1", labels: ["review-requested"] }, { id: "2", labels: ["review-requested"], parent: "1" }],
    readOnly: true,
  });
  const read = async (state: ReturnType<typeof createExternalState>): Promise<Snapshot> => {
    const graph = await state.source.read("1", ctx);
    return { graph, node: graph.nodes.find((n) => n.id === "1") };
  };
  const apply = async (state: ReturnType<typeof createExternalState>, effect: { type: string; [k: string]: unknown }) =>
    state.post.apply(effect, { ...ctx, item: "1", snapshot: await read(state) } as HookContext);

  it("reads as any tracker does: the list, an item's neighbourhood and its snapshot fragment", async () => {
    const state = seeded();
    state.say("1", "please look");
    expect((await state.source.list(ctx)).nodes.map((n) => [n.id, n.state])).toEqual([
      ["1", { labels: ["review-requested"], assignees: [] }],
      ["2", { labels: ["review-requested"], assignees: [] }],
    ]);
    expect((await state.source.read("2", ctx)).relationships).toEqual([{ from: "2", to: "1", type: "child-of" }]);
    const fragment = await state.pre.run({ ...ctx, item: "1" } as HookContext);
    expect(fragment).toMatchObject({ item: { comments: [expect.objectContaining({ body: "please look" })] } });
    expect(state.writes()).toEqual([]);
  });

  it.each([
    ["tracker.comment", { type: "tracker.comment", kind: "enter", marker: "enter:x:1", body: "hi" }, "comment was asked of #1"],
    ["tracker.label", { type: "tracker.label", add: ["lr:working"] }, "addLabels was asked of #1"],
    ["tracker.label removing", { type: "tracker.label", remove: ["review-requested"] }, "removeLabel was asked of #1"],
    ["tracker.status", { type: "tracker.status", value: "reviewing" }, "addLabels was asked of #1"],
    ["tracker.close", { type: "tracker.close" }, "close was asked of #1"],
    ["nodes.close", { type: "nodes.close", ids: ["2"] }, "close was asked of #2"],
  ])("refuses %s, saying what was asked of which item, and changes nothing", async (_name, effect, asked) => {
    const state = seeded();
    const before = structuredClone([state.item("1"), state.item("2")]);
    await expect(apply(state, effect)).rejects.toThrow(`this tracker is read-only: ${asked}`);
    expect([state.item("1"), state.item("2")]).toEqual(before);
    expect(state.writes()).toEqual([asked.replace(" was asked of ", " ")]);
  });

  it("refuses the operator's create and update", async () => {
    const state = seeded();
    await expect(state.operator.createItem({ title: "x", parent: "1" }, ctx))
      .rejects.toThrow("this tracker is read-only: create was asked of a new item under #1");
    await expect(state.operator.createItem({ title: "x" }, ctx))
      .rejects.toThrow("this tracker is read-only: create was asked of a new item");
    await expect(state.operator.updateItem("1", { title: "renamed" }, ctx))
      .rejects.toThrow("this tracker is read-only: update was asked of #1");
    expect(state.item("1").title).toBe("item 1");
    expect(state.children("1").map((r) => r.id)).toEqual(["2"]);
  });

  it("still lets a person move an item: that is the world changing, not landrace writing", async () => {
    const state = seeded();
    state.label("1", "approved");
    state.unlabel("1", "review-requested");
    state.say("1", "lgtm");
    expect(state.item("1")).toMatchObject({ labels: ["approved"], comments: [expect.objectContaining({ body: "lgtm" })] });
    expect(state.writes()).toEqual([]);
  });

  it("is writable unless asked to be read-only, and logs what it was asked to write either way", async () => {
    const state = createExternalState({ items: [{ id: "1" }] });
    await state.post.apply({ type: "tracker.status", value: "spec" }, { ...ctx, item: "1", snapshot: await read(state) } as HookContext);
    expect(state.item("1").labels).toEqual(["lr:stage:spec"]);
    expect(state.writes()).toEqual(["addLabels #1"]);
  });
});
