import type { Graph, Held, Node, Relationship, Running, Workflow } from "#namespace.js";
import { chatFor } from "#ui/chat.js";
import { boardView, createBoard, laneOf, summaryOf } from "#ui/board.js";

const workflow: Workflow = {
  version: 1, name: "t",
  eligible: [{ when: { "node.state.labels": { $in: ["go"] } }, else: "no go label" }],
  stages: [
    { id: "spec", entry: true, triggers: [{ when: { "run.stage": null } }] },
    { id: "done", terminal: true, triggers: [{ when: { "run.stage": "spec" } }] },
  ],
};

const ticket = (id: string, over: Partial<Node> = {}, labels: string[] = ["go"]): Node => ({
  id, kind: "ticket", title: `t${id}`, link: `https://x/${id}`, closed: null, priority: null, origin: null,
  state: { labels, assignees: [] }, ...over,
});
const pr = (id: string, over: Partial<Node> = {}): Node => ({
  id, kind: "pull-request", title: `PR ${id}`, link: `https://github.com/a/b/pull/${id}`, closed: null,
  priority: null, origin: null, state: { merged: false, openThreads: 0 }, ...over,
});
const edge = (from: string, to: string, type = "child-of"): Relationship => ({ from, to, type });
const graph = (nodes: Node[], relationships: Relationship[] = []): Graph => ({ nodes, relationships });
const NEST = new Set(["child-of", "implements"]);

const view = (g: Graph, over: Partial<Parameters<typeof boardView>[0]> = {}) =>
  boardView({
    workflow, graph: g, nest: NEST, listedAt: 1, now: 100, pid: 1, nextTickAt: null,
    running: new Map(), elsewhere: new Map(), folder: "landrace", workspace: "/repo/landrace", ...over,
  });

type Rows = ReturnType<typeof view>["rows"];
const shape = (rows: Rows): unknown => rows.map((r) => (r.children.length ? [r.id, shape(r.children)] : r.id));
const flatten = (rows: Rows): Rows => rows.flatMap((r) => [r, ...flatten(r.children)]);

describe("laneOf", () => {
  const row = (note: string, stage: string | null = "spec") => ({ ticket: "1", title: "t", stage, note });
  it.each([
    ["skipped: no go label", "not-admitted"],
    ["halted: more than one lr:stage:* label (a, b)", "needs-you"],
    ["blocked: needs a human", "needs-you"],
    ["waiting on you", "needs-you"],
    ["working", "waiting"],
    ["queued", "waiting"],
  ] as const)("%s -> %s", (note, lane) => {
    expect(laneOf(row(note), workflow)).toBe(lane);
  });

  it("puts a ticket at a terminal stage in discharged", () => {
    expect(laneOf(row("queued", "done"), workflow)).toBe("discharged");
  });

  it("never discharges a ticket that needs a human, terminal or not", () => {
    expect(laneOf(row("blocked: needs a human", "done"), workflow)).toBe("needs-you");
  });
});

describe("boardView: the tree", () => {
  it("nests a child under its parent and a pull request under its ticket", () => {
    const g = graph([ticket("1"), ticket("2"), pr("pr-9")], [edge("2", "1"), edge("pr-9", "2", "implements")]);
    expect(shape(view(g).rows)).toEqual([["1", [["2", ["pr-9"]]]]]);
  });

  it("nests only along the relation types it was told are singular", () => {
    const g = graph([ticket("1"), ticket("2")], [edge("2", "1", "blocks")]);
    expect(shape(view(g).rows)).toEqual(["1", "2"]);
    expect(shape(view(graph([ticket("1"), ticket("2")], [edge("2", "1")]), { nest: new Set() }).rows)).toEqual(["1", "2"]);
  });

  it("makes a node whose parent is not in the graph a root", () => {
    expect(shape(view(graph([ticket("2")], [edge("2", "404")])).rows)).toEqual(["2"]);
  });

  it("makes a node that claims two parents a root, rather than picking one", () => {
    const g = graph([ticket("1"), ticket("2"), ticket("3")], [edge("3", "1"), edge("3", "2")]);
    expect(shape(view(g).rows)).toEqual(["1", "2", "3"]);
  });

  it("makes a node whose singular edges of different types name different parents a root too", () => {
    const g = graph([ticket("1"), ticket("2"), pr("pr-3")], [edge("pr-3", "1"), edge("pr-3", "2", "implements")]);
    expect(shape(view(g).rows)).toEqual(["1", "2", "pr-3"]);
  });

  it("nests a node whose singular edges of different types agree on one parent", () => {
    const g = graph([ticket("1"), pr("pr-3")], [edge("pr-3", "1"), edge("pr-3", "1", "implements")]);
    expect(shape(view(g).rows)).toEqual([["1", ["pr-3"]]]);
  });

  it("shows every node of a cycle exactly once, and returns", () => {
    const g = graph([ticket("1"), ticket("2"), ticket("3")], [edge("1", "2"), edge("2", "3"), edge("3", "1")]);
    expect(flatten(view(g).rows).map((r) => r.id).sort()).toEqual(["1", "2", "3"]);
  });

  it("shows a node listed twice once", () => {
    expect(flatten(view(graph([ticket("1"), ticket("1")])).rows).map((r) => r.id)).toEqual(["1"]);
  });

  it("orders siblings by priority, unprioritised last, then by id as a number would", () => {
    const g = graph([ticket("10"), ticket("9"), ticket("3", { priority: 2 }), ticket("4", { priority: 0 })]);
    expect(view(g).rows.map((r) => r.id)).toEqual(["4", "3", "9", "10"]);
    const kids = graph([ticket("1"), ticket("12"), ticket("11", { priority: 1 }), ticket("2")], [
      edge("12", "1"), edge("11", "1"), edge("2", "1"),
    ]);
    expect(view(kids).rows[0]?.children.map((r) => r.id)).toEqual(["11", "2", "12"]);
  });

  it("expands every ancestor of something that needs you, and nothing else", () => {
    const g = graph(
      [ticket("1"), ticket("2"), ticket("3", {}, ["go", "lr:blocked"]), ticket("4"), ticket("5")],
      [edge("2", "1"), edge("3", "2"), edge("5", "4")],
    );
    const byId = new Map(flatten(view(g).rows).map((r) => [r.id, r]));
    expect(byId.get("1")?.expanded).toBe(true);
    expect(byId.get("2")?.expanded).toBe(true);
    expect(byId.get("3")?.expanded).toBe(false);
    expect(byId.get("4")?.expanded).toBe(false);
  });

  it("expands the ancestors of a running agent too", () => {
    const running = new Map<string, Running>([["2", { stage: "build", round: 1, model: null, since: 5 }]]);
    const rows = view(graph([ticket("1"), ticket("2")], [edge("2", "1")]), { running }).rows;
    expect(rows[0]?.expanded).toBe(true);
    expect(rows[0]?.children[0]?.badge).toBe("running");
  });

  it("keeps a closed or dropped node, marked so the page can grey it", () => {
    const g = graph([ticket("1"), ticket("2", { closed: "dropped" }), ticket("3", { closed: "done" })], [edge("2", "1"), edge("3", "1")]);
    const kids = view(g).rows[0]?.children;
    expect(kids?.map((r) => [r.id, r.closed])).toEqual([["2", "dropped"], ["3", "done"]]);
  });

  it("never gives a closed ticket a needs-you or running badge, and does not open its ancestors for it", () => {
    const running = new Map<string, Running>([["2", { stage: "build", round: 1, model: null, since: 5 }]]);
    const g = graph([ticket("1"), ticket("2", { closed: "done" }), ticket("3", { closed: "dropped" }, ["go", "lr:blocked"])], [
      edge("2", "1"), edge("3", "1"),
    ]);
    const rows = view(g, { running }).rows;
    expect(rows[0]?.children.map((r) => r.badge)).toEqual(["discharged", "discharged"]);
    expect(rows[0]?.expanded).toBe(false);
  });
});

describe("boardView: rows", () => {
  it("gives a ticket row a badge, its stage, a chat, and its system", () => {
    const row = view(graph([ticket("7", { link: "https://github.com/a/b/issues/7" })])).rows[0];
    expect(row).toMatchObject({ id: "7", kind: "ticket", badge: "waiting", system: { name: "GitHub" } });
    expect(row?.chat).toEqual(chatFor("7", "/repo/landrace"));
  });

  it("gives an artifact row no badge and no chat, a summary, and its system", () => {
    const g = graph([ticket("1"), pr("pr-9", { state: { merged: false, openThreads: 2 } })], [edge("pr-9", "1", "implements")]);
    const row = view(g).rows[0]?.children[0];
    expect(row).toMatchObject({ kind: "pull-request", badge: null, chat: null, summary: "open · openThreads 2" });
    expect(row?.system?.name).toBe("GitHub");
  });

  it("drops a link that is not http(s), on artifact rows as on tickets", () => {
    expect(view(graph([pr("pr-9", { link: "javascript:alert(1)" })])).rows[0]).toMatchObject({ link: "", system: null });
    expect(view(graph([ticket("1", { link: "javascript:alert(1)" })])).rows[0]).toMatchObject({ link: "", system: null });
    expect(view(graph([ticket("1", { link: "https://ok/1" })])).rows[0]?.link).toBe("https://ok/1");
  });

  it("flattens titles to one line", () => {
    const row = view(graph([ticket("1", { title: "a\nb\u001b[2Jc" })])).rows[0];
    expect(row?.title).toBe("a b [2Jc");
  });

  it("carries nothing the allowlist does not name", () => {
    const row = view(graph([pr("p", { state: { secret: "hunter2" }, origin: { parent: "1", stage: "s", round: 1 } })])).rows[0];
    expect(Object.keys(row ?? {}).sort()).toEqual([
      "badge", "chat", "children", "closed", "expanded", "id", "kind", "link", "model", "note", "priority",
      "round", "since", "stage", "summary", "system", "title",
    ]);
    expect(JSON.stringify(row)).not.toContain("hunter2");
  });

  it("puts a ticket with an agent running in `running`, over whatever its labels say", () => {
    const running = new Map<string, Running>([["1", { stage: "spec", round: 2, model: "opus", since: 40 }]]);
    const row = view(graph([ticket("1", {}, ["go", "lr:awaiting"])]), { running }).rows[0];
    expect(row).toMatchObject({ badge: "running", round: 2, model: "opus", since: 40, note: "agent running" });
  });

  it("puts a ticket locked by another process in `elsewhere`, and not its own lock", () => {
    const other: Held = { ticket: "1", holder: "conversation:77", kind: "conversation", pid: 77, at: 90, deadlineMs: 1, token: "t" };
    const row = view(graph([ticket("1")]), { elsewhere: new Map([["1", other]]) }).rows[0];
    expect(row).toMatchObject({ badge: "elsewhere", note: "held by conversation (pid 77)" });
    // Held.at is a heartbeat, not when the hold began: no clock beats a wrong one.
    expect(row?.since).toBeNull();
    expect(view(graph([ticket("1")]), { elsewhere: new Map([["1", { ...other, pid: 1 }]]) }).rows[0]?.badge).toBe("waiting");
  });

  it("badges a ticket from its labels otherwise", () => {
    const rows = view(graph([ticket("1", {}, ["go", "lr:blocked"]), ticket("2", {}, [])])).rows;
    expect(rows.map((r) => [r.id, r.badge])).toEqual([["1", "needs-you"], ["2", "not-admitted"]]);
  });

  it("passes nextTickAt, folder and workspace straight through", () => {
    const v = view(graph([]), { nextTickAt: 12345, folder: "widgets", workspace: "/w" });
    expect(v).toMatchObject({ nextTickAt: 12345, folder: "widgets", workspace: "/w", rows: [] });
  });
});

describe("summaryOf", () => {
  it("says open/done/dropped, then true flags and non-zero counts, in key order", () => {
    expect(summaryOf(pr("p", { closed: "done", state: { merged: true, openThreads: 0 } }))).toBe("done · merged");
    expect(summaryOf(pr("p", { state: { b: true, a: 3, s: "text", z: false } }))).toBe("open · a 3 · b");
    expect(summaryOf(pr("p", { closed: "dropped", state: {} }))).toBe("dropped");
  });

  it("keeps it to a one-liner however much state there is", () => {
    expect(summaryOf(pr("p", { state: { a: 1, b: 2, c: 3, d: 4, e: 5, f: true } }))).toBe("open · a 1 · b 2 · c 3 · d 4");
  });
});

describe("createBoard", () => {
  const shell = (now: () => number, held: (t: string) => Promise<Held | null> = async () => null) =>
    createBoard({ workflow, held, now, pid: 1, folder: "landrace", workspace: "/repo/landrace", nest: [...NEST] });

  it("opens a running row on step.started and closes it on step.finished", async () => {
    let t = 10;
    const board = shell(() => t);
    board.list(graph([ticket("1")]));
    board.observe({ name: "step.started", ticket: "1", stage: "spec", round: 1, model: "opus" });
    t = 20;
    expect((await board.view()).rows[0]).toMatchObject({ badge: "running", since: 10 });
    board.observe({ name: "step.finished", ticket: "1", stage: "spec", round: 1, ok: true });
    expect((await board.view()).rows[0]?.badge).toBe("waiting");
  });

  it("ignores a step event that names no ticket", async () => {
    const board = shell(() => 0);
    board.list(graph([ticket("1")]));
    board.observe({ name: "step.started", stage: "spec", round: 1 });
    expect((await board.view()).rows[0]?.badge).toBe("waiting");
  });

  it("reports no rows and a null listedAt before the first tick lands", async () => {
    expect(await shell(() => 5).view()).toEqual({
      generatedAt: 5, listedAt: null, rows: [], nextTickAt: null, folder: "landrace", workspace: "/repo/landrace",
    });
  });

  it("reports nextTickAt from the function it was given, read fresh on each view()", async () => {
    let next: number | null = 111;
    const board = createBoard({ workflow, held: async () => null, nextTickAt: () => next, folder: "f", workspace: "/w", nest: [] });
    expect((await board.view()).nextTickAt).toBe(111);
    next = 222;
    expect((await board.view()).nextTickAt).toBe(222);
  });

  it("nests along the relation types it was given", async () => {
    const board = shell(() => 0);
    board.list(graph([ticket("1"), ticket("2")], [edge("2", "1")]));
    expect(shape((await board.view()).rows)).toEqual([["1", ["2"]]]);
  });

  it("asks the lock only about open ticket nodes, never about a pull request or a closed ticket", async () => {
    const asked: string[] = [];
    const board = shell(() => 0, async (t) => { asked.push(t); return null; });
    board.list(graph([ticket("4"), ticket("9"), ticket("5", { closed: "done" }), pr("pr-1")], [edge("pr-1", "4", "implements")]));
    await board.view();
    expect(asked.sort()).toEqual(["4", "9"]);
  });
});
