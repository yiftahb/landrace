import { createExternalState } from "#testing/index.js";

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
