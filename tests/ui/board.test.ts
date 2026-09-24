import type { Graph, Held, Node, Running, Workflow } from "#namespace.js";
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

const c = (ticket: string, labels: string[], title = `t${ticket}`, url = `https://x/${ticket}`): Node => ({
  id: ticket, kind: "ticket", title, link: url, closed: null, priority: null, origin: null, state: { labels, assignees: [] },
});

/** What a tick hands the board: a graph, of which only the tickets are rows. */
const graph = (nodes: Node[]): Graph => ({ nodes, relationships: [] });

const view = (nodes: Node[], over: Partial<Parameters<typeof boardView>[0]> = {}) =>
  boardView({
    workflow, nodes, listedAt: 1, now: 100, pid: 1, nextTickAt: null,
    running: new Map(), elsewhere: new Map(), folder: "landrace", workspace: "/repo/landrace", ...over,
  });

const laneFor = (candidate: Node, over = {}) => view([candidate], over).rows[0]?.lane;

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

describe("boardView", () => {
  it("puts a ticket with an agent running in `running`, over whatever its labels say", () => {
    const running = new Map<string, Running>([["1", { stage: "spec", round: 2, model: "opus", since: 40 }]]);
    const row = view([c("1", ["go", "lr:awaiting"])], { running }).rows[0];
    expect(row).toMatchObject({ lane: "running", round: 2, model: "opus", since: 40 });
  });

  it("puts a ticket locked by another process in `elsewhere`, naming the holder", () => {
    const held: Held = { ticket: "1", holder: "conversation:77", kind: "conversation", pid: 77, at: 90, deadlineMs: 1, token: "t" };
    const row = view([c("1", ["go"])], { elsewhere: new Map([["1", held]]) }).rows[0];
    expect(row?.lane).toBe("elsewhere");
    expect(row?.note).toContain("conversation");
    // Held.at is refreshed every deadlineMs/4 by withLock — "when the holder
    // last said it was still working", not when the hold began — so it would
    // sawtooth between 0 and ~75s rather than answer BoardRow.since ("when
    // the current state began"). Nothing else tells us when a foreign hold
    // started, so it reports null rather than a wrong clock.
    expect(row?.since).toBeNull();
  });

  it("does not report this process's own lock as elsewhere", () => {
    const own: Held = { ticket: "1", holder: "tick:1", kind: "tick", pid: 1, at: 90, deadlineMs: 1, token: "t" };
    expect(laneFor(c("1", ["go"]), { elsewhere: new Map([["1", own]]) })).toBe("waiting");
  });

  it("orders rows by lane, then by ticket", () => {
    const rows = view([c("3", ["go"]), c("1", ["go", "lr:blocked"]), c("2", [])]).rows;
    expect(rows.map((r) => [r.lane, r.ticket])).toEqual([["needs-you", "1"], ["waiting", "3"], ["not-admitted", "2"]]);
  });

  it("drops a url that is not http(s), because it becomes an href", () => {
    expect(view([c("1", ["go"], "t", "javascript:alert(1)")]).rows[0]?.url).toBe("");
    expect(view([c("1", ["go"], "t", "https://ok/1")]).rows[0]?.url).toBe("https://ok/1");
  });

  it("flattens a title to one line", () => {
    expect(view([c("1", ["go"], "a\nb\u001b[2Jc")]).rows[0]?.title).toBe("a b [2Jc");
  });

  it("passes nextTickAt straight through, whatever the schedule reports", () => {
    expect(view([], { nextTickAt: 12345 }).nextTickAt).toBe(12345);
    expect(view([], { nextTickAt: null }).nextTickAt).toBeNull();
  });

  it("passes folder and workspace straight through, for the header chip", () => {
    const v = view([], { folder: "widgets", workspace: "/Users/me/widgets" });
    expect(v.folder).toBe("widgets");
    expect(v.workspace).toBe("/Users/me/widgets");
  });

  it("gives every row a chat prompt/links built from its own ticket and the board's workspace", () => {
    const row = view([c("41", ["go"])], { workspace: "/Users/me/widgets" }).rows[0];
    expect(row?.chat).toEqual(chatFor("41", "/Users/me/widgets"));
  });
});

describe("createBoard", () => {
  const shell = (now: () => number, held: (t: string) => Promise<Held | null> = async () => null) =>
    createBoard({ workflow, held, now, pid: 1, folder: "landrace", workspace: "/repo/landrace" });

  it("opens a running row on step.started and closes it on step.finished", async () => {
    let t = 10;
    const board = shell(() => t);
    board.list(graph([c("1", ["go"])]));
    board.observe({ name: "step.started", ticket: "1", stage: "spec", round: 1, model: "opus" });
    t = 20;
    expect((await board.view()).rows[0]).toMatchObject({ lane: "running", since: 10 });
    board.observe({ name: "step.finished", ticket: "1", stage: "spec", round: 1, ok: true });
    expect((await board.view()).rows[0]?.lane).toBe("waiting");
  });

  it("ignores a step event that names no ticket", async () => {
    const board = shell(() => 0);
    board.list(graph([c("1", ["go"])]));
    board.observe({ name: "step.started", stage: "spec", round: 1 });
    expect((await board.view()).rows[0]?.lane).toBe("waiting");
  });

  it("reports no rows and a null listedAt before the first tick lands", async () => {
    expect(await shell(() => 5).view()).toEqual({
      generatedAt: 5, listedAt: null, rows: [], nextTickAt: null, folder: "landrace", workspace: "/repo/landrace",
    });
  });

  it("defaults nextTickAt to null when nothing schedules", async () => {
    const board = createBoard({ workflow, held: async () => null, folder: "f", workspace: "/w" });
    expect((await board.view()).nextTickAt).toBeNull();
  });

  it("reports nextTickAt from the function it was given, read fresh on each view()", async () => {
    let next: number | null = 111;
    const board = createBoard({ workflow, held: async () => null, nextTickAt: () => next, folder: "f", workspace: "/w" });
    expect((await board.view()).nextTickAt).toBe(111);
    next = 222;
    expect((await board.view()).nextTickAt).toBe(222);
  });

  it("passes folder and workspace through view(), unchanged across ticks", async () => {
    const board = createBoard({ workflow, held: async () => null, folder: "widgets", workspace: "/Users/me/widgets" });
    const v = await board.view();
    expect(v.folder).toBe("widgets");
    expect(v.workspace).toBe("/Users/me/widgets");
  });

  it("asks the lock only about tickets it has listed", async () => {
    const asked: string[] = [];
    const board = shell(() => 0, async (t) => { asked.push(t); return null; });
    board.list(graph([c("4", ["go"]), c("9", ["go"])]));
    await board.view();
    expect(asked.sort()).toEqual(["4", "9"]);
  });

  it("tracks a running agent from events whose ticket is a string", () => {
    const board = createBoard({ workflow, held: async () => null, folder: "f", workspace: "/w" });
    board.list(graph([c("7", [], "t", "")]));
    board.observe({ name: "step.started", ticket: "7", stage: "build", round: 1 });
    return board.view().then((v) => expect(v.rows[0]?.lane).toBe("running"));
  });

  it("lists only the tickets in the graph — a pull request is not a row", async () => {
    const board = shell(() => 0);
    board.list(graph([c("1", ["go"]), { ...c("pr-3", []), kind: "pull-request" }]));
    expect((await board.view()).rows.map((r) => r.ticket)).toEqual(["1"]);
  });
});
