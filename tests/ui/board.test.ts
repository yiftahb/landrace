import type { Graph, Held, Node, Relationship, Running, Workflow } from "#namespace.js";
import { chatFor } from "#ui/chat.js";
import { boardView, createBoard, laneOf } from "#ui/board.js";

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
    workflow, graph: g, nest: NEST, now: 100, pid: 1, nextTickAt: null,
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
    ["blocked: security check refused a step", "needs-you"],
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

/*
 * Needs you, like any blocked ticket — it is one — with the reason on the row,
 * so the person who opens it knows to read a security verdict rather than an
 * agent's broken answer. The reason itself is on the ticket, in a comment the
 * board does not read: it is drawn from the listed labels, and a comment read
 * per ticket per tick is a cost this page does not get to add.
 */
describe("boardView: a ticket a security check stopped", () => {
  it("is in Needs you, marked screened, and says it was a security check", () => {
    const [row] = view(graph([ticket("1", {}, ["go", "lr:stage:screened", "lr:blocked", "lr:screened"])])).rows;
    expect(row).toMatchObject({ badge: "needs-you", lane: "needs-you", screened: true, note: "blocked by a security check" });
  });

  it("marks a ticket blocked for any other reason as not screened", () => {
    const [row] = view(graph([ticket("1", {}, ["go", "lr:stage:blocked", "lr:blocked"])])).rows;
    expect(row).toMatchObject({ badge: "needs-you", screened: false, note: "blocked: needs a human" });
  });

  it("marks no artifact screened", () => {
    const [row] = view(graph([pr("pr-9")])).rows;
    expect(row?.screened).toBe(false);
  });
});

/*
 * Retry is offered on exactly the tickets a human turn would hand back: the
 * blocked and the screened. The path comes from the server, built from an id
 * it has checked, so the page never puts a URL together itself.
 */
describe("boardView: which rows offer a Retry", () => {
  const rowFor = (labels: string[], over: Partial<Node> = {}, opts: Partial<Parameters<typeof boardView>[0]> = {}) =>
    view(graph([ticket("7", over, ["go", ...labels])]), opts).rows[0];

  it.each([
    ["blocked", ["lr:stage:blocked", "lr:blocked"]],
    ["screened", ["lr:stage:screened", "lr:blocked", "lr:screened"]],
  ])("offers it on a %s ticket, as the path to post to", (_, labels) => {
    expect(rowFor(labels)?.retry).toBe("/tickets/7/retry");
  });

  it.each([
    ["waiting on you", ["lr:stage:spec-human-review", "lr:awaiting"]],
    ["working", ["lr:stage:build", "lr:working"]],
    ["queued", ["lr:stage:spec"]],
  ])("offers none on a ticket that is %s", (_, labels) => {
    expect(rowFor(labels)?.retry).toBeNull();
  });

  it("offers none on a closed ticket, whatever its labels still say", () => {
    expect(rowFor(["lr:stage:blocked", "lr:blocked"], { closed: "done" })?.retry).toBeNull();
  });

  it("offers none while an agent is running on it", () => {
    const running = new Map<string, Running>([["7", { stage: "build", round: 2, model: null, since: 1 }]]);
    expect(rowFor(["lr:stage:blocked", "lr:blocked"], {}, { running })?.retry).toBeNull();
  });

  it("offers none on an artifact", () => {
    expect(view(graph([pr("pr-9")])).rows[0]?.retry).toBeNull();
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

  it("keeps a closed or dropped node, marked so the page can grey it", () => {
    const g = graph([ticket("1"), ticket("2", { closed: "dropped" }), ticket("3", { closed: "done" })], [edge("2", "1"), edge("3", "1")]);
    const kids = view(g).rows[0]?.children;
    expect(kids?.map((r) => [r.id, r.closed])).toEqual([["2", "dropped"], ["3", "done"]]);
  });

  it("never gives a closed ticket a needs-you or running badge", () => {
    const running = new Map<string, Running>([["2", { stage: "build", round: 1, model: null, since: 5 }]]);
    const g = graph([ticket("1"), ticket("2", { closed: "done" }), ticket("3", { closed: "dropped" }, ["go", "lr:blocked"])], [
      edge("2", "1"), edge("3", "1"),
    ]);
    const rows = view(g, { running }).rows;
    expect(rows[0]?.children.map((r) => r.badge)).toEqual(["discharged", "discharged"]);
  });
});

describe("boardView: lanes", () => {
  const blocked = ["go", "lr:blocked"];

  it("puts a branch whose child needs you in needs-you, and the child keeps its own badge", () => {
    const rows = view(graph([ticket("1"), ticket("2", {}, blocked)], [edge("2", "1")])).rows;
    expect(rows[0]).toMatchObject({ id: "1", lane: "needs-you", badge: "waiting" });
    expect(rows[0]?.children[0]).toMatchObject({ id: "2", badge: "needs-you" });
  });

  it("raises a branch for a grandchild that needs you", () => {
    const g = graph([ticket("1"), ticket("2"), ticket("3", {}, blocked)], [edge("2", "1"), edge("3", "2")]);
    expect(view(g).rows[0]?.lane).toBe("needs-you");
  });

  it("puts a branch with a running child in running", () => {
    const running = new Map<string, Running>([["2", { stage: "build", round: 1, model: null, since: 5 }]]);
    expect(view(graph([ticket("1"), ticket("2")], [edge("2", "1")]), { running }).rows[0]?.lane).toBe("running");
  });

  it("ranks needs-you over running over elsewhere over waiting, whichever sub-branch they sit in", () => {
    const running = new Map<string, Running>([["2", { stage: "build", round: 1, model: null, since: 5 }]]);
    const g = graph([ticket("1"), ticket("2"), ticket("3"), ticket("4", {}, blocked)], [edge("2", "1"), edge("3", "1"), edge("4", "3")]);
    expect(view(g, { running }).rows[0]?.lane).toBe("needs-you");
    expect(view(graph([ticket("1"), ticket("2"), ticket("3")], [edge("2", "1"), edge("3", "1")]), { running }).rows[0]?.lane)
      .toBe("running");
  });

  it("never lets a closed ticket raise its branch, whatever its stale labels say", () => {
    const g = graph([ticket("1"), ticket("2", { closed: "done" }, blocked), ticket("3", { closed: "dropped" }, blocked)], [
      edge("2", "1"), edge("3", "1"),
    ]);
    const rows = view(g).rows;
    expect(rows[0]).toMatchObject({ lane: "waiting" });
  });

  it("still raises a closed parent's branch for an open child that needs you", () => {
    const g = graph([ticket("1", { closed: "done" }), ticket("2", {}, blocked)], [edge("2", "1")]);
    expect(view(g).rows[0]).toMatchObject({ badge: "discharged", lane: "needs-you" });
  });

  it("puts a ticket with no sub-tickets in the lane of its own badge", () => {
    const running = new Map<string, Running>([["2", { stage: "spec", round: 1, model: null, since: 5 }]]);
    const other: Held = { ticket: "3", holder: "conversation:77", kind: "conversation", pid: 77, at: 90, deadlineMs: 1, token: "t" };
    const g = graph([
      ticket("1", {}, blocked), ticket("2"), ticket("3"), ticket("4"), ticket("5", {}, []), ticket("6", { closed: "done" }),
    ]);
    const rows = view(g, { running, elsewhere: new Map([["3", other]]) }).rows;
    expect(rows.map((r) => [r.id, r.lane, r.badge])).toEqual([
      ["1", "needs-you", "needs-you"], ["2", "running", "running"], ["3", "elsewhere", "elsewhere"],
      ["4", "waiting", "waiting"], ["5", "not-admitted", "not-admitted"], ["6", "discharged", "discharged"],
    ]);
  });

  it("files a branch under Held elsewhere for a grandchild held elsewhere, whatever its root's own badge", () => {
    const other: Held = { ticket: "3", holder: "conversation:77", kind: "conversation", pid: 77, at: 90, deadlineMs: 1, token: "t" };
    const g = graph([ticket("1", {}, []), ticket("2", {}, []), ticket("3")], [edge("2", "1"), edge("3", "2")]);
    expect(view(g, { elsewhere: new Map([["3", other]]) }).rows[0]).toMatchObject({ badge: "not-admitted", lane: "elsewhere" });
  });

  it("never lets an artifact raise a branch", () => {
    const g = graph([ticket("1", {}, []), pr("pr-9")], [edge("pr-9", "1", "implements")]);
    expect(view(g).rows[0]).toMatchObject({ lane: "not-admitted" });
  });

  it("puts a branch with no ticket in it in waiting while open, and in discharged once closed", () => {
    const rows = view(graph([pr("pr-1"), pr("pr-2", { closed: "done" })])).rows;
    expect(rows.map((r) => [r.id, r.lane])).toEqual([["pr-1", "waiting"], ["pr-2", "discharged"]]);
  });

  it("gives a lane only to a root: a nested row is drawn in its root's", () => {
    const g = graph([ticket("1"), ticket("2", {}, blocked), pr("pr-9")], [edge("2", "1"), edge("pr-9", "2", "implements")]);
    const nested = flatten(view(g).rows).filter((r) => r.id !== "1");
    expect(nested.map((r) => [r.id, r.lane])).toEqual([["2", null], ["pr-9", null]]);
  });
});

describe("boardView: rows", () => {
  it("notes a closed ticket as closed or dropped, not as whatever its stale labels last said", () => {
    const g = graph([ticket("2", { closed: "done" }, ["go", "lr:blocked"]), ticket("3", { closed: "dropped" }, ["go", "lr:blocked"])]);
    expect(view(g).rows.map((r) => [r.id, r.note])).toEqual([["2", "closed"], ["3", "dropped"]]);
  });

  it("draws a ticket whose id no chat link may carry, without its chat, instead of blanking the page", () => {
    const g = graph([ticket("1"), ticket("bad id")]);
    const rows = view(g).rows;
    expect(rows.map((r) => [r.id, r.chat === null])).toEqual([["1", false], ["bad id", true]]);
  });

  it("gives a ticket row a badge, its stage, a chat, and its system", () => {
    const row = view(graph([ticket("7", { link: "https://github.com/a/b/issues/7" })])).rows[0];
    expect(row).toMatchObject({ id: "7", kind: "ticket", badge: "waiting", system: { name: "GitHub" } });
    expect(row?.chat).toEqual(chatFor("7", "/repo/landrace"));
  });

  it("gives an artifact row no badge and no chat, and its system", () => {
    const g = graph([ticket("1"), pr("pr-9", { state: { merged: false, openThreads: 2 } })], [edge("pr-9", "1", "implements")]);
    const row = view(g).rows[0]?.children[0];
    expect(row).toMatchObject({ kind: "pull-request", badge: null, chat: null });
    expect(row?.system?.name).toBe("GitHub");
  });

  /*
   * Ticket #19 sat at spec-human-review with its spec published and nothing on
   * the board to open. A source reports the page as a document with a
   * singular `documents` edge, and that is all the board needs: it nests it
   * under its ticket as an artifact row, and says where the page lives.
   */
  it("nests a published spec under its ticket as a document row, linked to it on GitHub Pages", () => {
    const spec: Node = {
      id: "spec-19", kind: "document", title: "Spec", link: "https://acme.github.io/widgets/specs/19/",
      closed: null, priority: null, origin: null, state: {},
    };
    const g = graph([ticket("19"), spec], [edge("spec-19", "19", "documents")]);
    const rows = view(g, { nest: new Set([...NEST, "documents"]) }).rows;

    expect(shape(rows)).toEqual([["19", ["spec-19"]]]);
    expect(rows[0]?.children[0]).toMatchObject({
      id: "spec-19", kind: "document", title: "Spec", link: "https://acme.github.io/widgets/specs/19/",
      system: { name: "GitHub Pages" }, badge: null, chat: null, lane: null,
    });
    // Not work: the ticket's own badge decides its lane.
    expect(rows[0]).toMatchObject({ badge: "waiting", lane: "waiting" });
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
      "badge", "chat", "children", "closed", "id", "kind", "lane", "link", "model", "note", "priority",
      "retry", "round", "screened", "since", "stage", "system", "title",
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

describe("createBoard", () => {
  const shell = (now: () => number, held: (t: string) => Promise<Held | null> = async () => null) =>
    createBoard({ workflow, held, now, pid: 1, folder: "landrace", workspace: "/repo/landrace", nest: [...NEST] });

  /*
   * What the server asks before it posts anything: the board's own latest
   * listing, not the page's. A ticket handed back since the page last polled
   * is no longer blocked, and a second reply would be a second handback.
   */
  it("answers whether a ticket may be retried from what the tick last listed", () => {
    const board = shell(() => 0);
    expect(board.retryable("1")).toBe(false);

    board.list(graph([
      ticket("1", {}, ["go", "lr:stage:blocked", "lr:blocked"]),
      ticket("2", {}, ["go", "lr:stage:screened", "lr:blocked", "lr:screened"]),
      ticket("3", {}, ["go", "lr:stage:spec", "lr:working"]),
      ticket("4", { closed: "done" }, ["go", "lr:stage:blocked", "lr:blocked"]),
      pr("pr-5"),
    ]));
    expect(["1", "2", "3", "4", "pr-5", "99"].map((id) => board.retryable(id))).toEqual([true, true, false, false, false, false]);

    board.list(graph([ticket("1", {}, ["go", "lr:stage:spec", "lr:working"])]));
    expect(board.retryable("1")).toBe(false);
  });

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

  // No listedAt: the header's "listed … ago" was the only thing that read it,
  // and it is gone.
  it("reports no rows before the first tick lands", async () => {
    expect(await shell(() => 5).view()).toEqual({
      generatedAt: 5, rows: [], nextTickAt: null, folder: "landrace", workspace: "/repo/landrace",
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
