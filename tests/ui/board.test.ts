import type { Entry, Graph, Held, Node, Relationship, Running, Workflow } from "#namespace.js";
import { chatFor } from "#ui/chat.js";
import { boardView, conversationOf, createBoard } from "#ui/board.js";
import { laneOf } from "#runner/status.js";

const workflow: Workflow = {
  version: 1, name: "t",
  eligible: [{ when: { "node.state.labels": { $in: ["go"] } }, else: "no go label" }],
  stages: [
    { id: "spec", entry: true, step: "steps/spec.md", goto: ["spec"], triggers: [{ when: { "run.stage": null } }] },
    { id: "blocked", goto: ["spec"], triggers: [{ when: { "run.lastOutputValid": false } }] },
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
    ["blocked by a security check", "needs-you"],
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
    const running = new Map<string, Running>([["7", { stage: "build", round: 2, model: null, effort: null, since: 1 }]]);
    expect(rowFor(["lr:stage:blocked", "lr:blocked"], {}, { running })?.retry).toBeNull();
  });

  it("offers none on an artifact", () => {
    expect(view(graph([pr("pr-9")])).rows[0]?.retry).toBeNull();
  });
});

/*
 * "Go to step…" is offered wherever a person's turn might be: the board holds
 * labels, not records, so it cannot tell a judge whose round is settled from
 * one whose step is still owed — `sendTo` is the authority on that, and
 * refuses an owed step in a sentence. A stage that runs a step still lists
 * its own goto targets, so long as nothing is running now.
 */
describe("boardView: where a row may send its ticket back to", () => {
  const rowFor = (labels: string[], over: Partial<Node> = {}, opts: Partial<Parameters<typeof boardView>[0]> = {}) =>
    view(graph([ticket("7", over, ["go", ...labels])]), opts).rows[0];

  it("offers the targets its stage lists, as paths the server built", () => {
    expect(rowFor(["lr:stage:blocked", "lr:blocked"])?.goto).toEqual([{ stage: "spec", path: "/tickets/7/goto/spec" }]);
  });

  it("offers a stepped stage's targets too, while nothing is running on it", () => {
    expect(rowFor(["lr:stage:spec"])?.goto).toEqual([{ stage: "spec", path: "/tickets/7/goto/spec" }]);
  });

  it("offers none on a closed ticket, or while its agent runs", () => {
    expect(rowFor(["lr:stage:blocked"], { closed: "done" })?.goto).toEqual([]);
    const running = new Map<string, Running>([["7", { stage: "spec", round: 2, model: null, effort: null, since: 1 }]]);
    expect(rowFor(["lr:stage:blocked"], {}, { running })?.goto).toEqual([]);
  });

  it("offers none on a row held elsewhere", () => {
    const other: Held = { ticket: "7", holder: "conversation:77", kind: "conversation", pid: 77, at: 90, deadlineMs: 1, token: "t" };
    expect(rowFor(["lr:stage:blocked"], {}, { elsewhere: new Map([["7", other]]) })?.goto).toEqual([]);
  });
});

/*
 * Every ticket opens a panel, whatever it is doing; nothing else does. The
 * paths come from the server, built from an id it has checked, so the page
 * never puts a URL together itself.
 */
describe("boardView: a ticket's panel", () => {
  const PATHS = {
    activity: "/tickets/7/activity", conversation: "/tickets/7/conversation",
    reply: "/tickets/7/reply", ask: "/tickets/7/ask", resolve: "/tickets/7/resolve",
    pairing: "/tickets/7/pairing", pair: "/tickets/7/pair", finish: "/tickets/7/finish", release: "/tickets/7/release",
  };

  it("names its panel's paths on every ticket — waiting, running, needing you or closed", () => {
    const running = new Map<string, Running>([["8", { stage: "spec", round: 1, model: null, effort: null, since: 1 }]]);
    const rows = view(graph([
      ticket("7"), ticket("8"), ticket("9", {}, ["go", "lr:stage:blocked", "lr:blocked"]), ticket("10", { closed: "done" }),
    ]), { running }).rows;
    expect(rows.map((r) => r.panel?.reply)).toEqual(["/tickets/7/reply", "/tickets/8/reply", "/tickets/9/reply", "/tickets/10/reply"]);
    expect(rows[0]?.panel).toEqual(PATHS);
  });

  it("gives an artifact none, and a ticket whose id is not one none", () => {
    expect(view(graph([pr("pr-9")])).rows[0]?.panel).toBeNull();
    expect(view(graph([ticket("../7")])).rows[0]?.panel).toBeNull();
  });
});

describe("conversationOf", () => {
  const entry = (over: Partial<Entry>): Entry => ({ stage: "-", kind: "human", round: 0, at: "2026-01-01T00:00:01Z", byAgent: false, ...over });

  it("reads the ticket's records oldest first, ours as landrace's and a person's as theirs", () => {
    expect(conversationOf([
      entry({ at: "2026-01-01T00:00:02Z", byAgent: false, data: { author: "yiftahb" }, text: "B2B only" }),
      entry({ at: "2026-01-01T00:00:01Z", byAgent: true, stage: "spec", kind: "output", round: 1, text: "Questions" }),
    ])).toEqual([
      { at: "2026-01-01T00:00:01Z", by: "landrace", byAgent: true, stage: "spec", kind: "output", round: 1, text: "Questions" },
      { at: "2026-01-01T00:00:02Z", by: "yiftahb", byAgent: false, stage: "-", kind: "human", round: 0, text: "B2B only" },
    ]);
  });

  it("leaves out a record with nothing to read, and names a person the source did not", () => {
    const lines = conversationOf([entry({ text: "" }), entry({}), entry({ text: "hi", data: { author: 7 } })]);
    expect(lines.map((l) => [l.by, l.text])).toEqual([["someone", "hi"]]);
  });
});

describe("boardView: when a row's node was created", () => {
  it("carries the source's creation time onto the row, and null where the source gave none", () => {
    const rows = flatten(view(graph([ticket("1"), pr("pr-2", { createdAt: 42 })], [edge("pr-2", "1", "implements")])).rows);
    expect(rows.find((r) => r.id === "pr-2")?.createdAt).toBe(42);
    expect(rows.find((r) => r.id === "1")?.createdAt).toBeNull();
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
    const running = new Map<string, Running>([["2", { stage: "build", round: 1, model: null, effort: null, since: 5 }]]);
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
    const running = new Map<string, Running>([["2", { stage: "build", round: 1, model: null, effort: null, since: 5 }]]);
    expect(view(graph([ticket("1"), ticket("2")], [edge("2", "1")]), { running }).rows[0]?.lane).toBe("running");
  });

  it("ranks needs-you over running over elsewhere over waiting, whichever sub-branch they sit in", () => {
    const running = new Map<string, Running>([["2", { stage: "build", round: 1, model: null, effort: null, since: 5 }]]);
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
    const running = new Map<string, Running>([["2", { stage: "spec", round: 1, model: null, effort: null, since: 5 }]]);
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
      "badge", "chat", "children", "closed", "createdAt", "effort", "goto", "id", "kind", "lane", "link", "model", "note", "panel",
      "priority", "retry", "round", "screened", "since", "stage", "stale", "system", "title",
    ]);
    expect(JSON.stringify(row)).not.toContain("hunter2");
  });

  it("puts a ticket with an agent running in `running`, over whatever its labels say", () => {
    const running = new Map<string, Running>([["1", { stage: "spec", round: 2, model: "opus", effort: "high", since: 40 }]]);
    const row = view(graph([ticket("1", {}, ["go", "lr:awaiting"])]), { running }).rows[0];
    expect(row).toMatchObject({ badge: "running", round: 2, model: "opus", effort: "high", since: 40, note: "agent running" });
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
   * The note says a person sent the ticket back, for as long as it is at the
   * step it was sent to — taken from the tick's own events, the way
   * `running` is.
   */
  it("says a running ticket was sent back, until it moves on", () => {
    const board = shell(() => 0);
    board.list(graph([ticket("1", {}, ["go", "lr:stage:spec", "lr:working"])]));
    board.observe({ name: "ticket.evaluated", ticket: "1", decision: "transition", to: "spec", why: "goto" });
    board.observe({ name: "step.started", ticket: "1", stage: "spec", round: 2 });
    return board.view().then((v) => {
      expect(v.rows[0]?.note).toBe("agent running — sent back to spec");
      board.observe({ name: "ticket.evaluated", ticket: "1", decision: "transition", to: "done", why: "the spec was published" });
      return board.view();
    }).then((v) => expect(v.rows[0]?.note).toBe("agent running"));
  });

  /*
   * `sent` never clears on its own the way `running` does (no event says
   * "nobody will ever goto this again"), so a ticket that leaves the graph —
   * closed, or simply not relisted — has to be the thing that prunes it, or
   * a stale "sent back to X" could resurface if the same id is ever listed
   * again with no fresh goto behind it.
   */
  it("prunes sent for a ticket once it leaves the graph, so a stale note cannot resurface", async () => {
    const board = shell(() => 0);
    board.list(graph([ticket("1", {}, ["go", "lr:stage:spec", "lr:working"])]));
    board.observe({ name: "ticket.evaluated", ticket: "1", decision: "transition", to: "spec", why: "goto" });
    board.list(graph([])); // ticket 1 is gone from this listing
    board.list(graph([ticket("1", {}, ["go", "lr:stage:spec", "lr:working"])])); // and back, with no new goto
    board.observe({ name: "step.started", ticket: "1", stage: "spec", round: 3 });
    expect((await board.view()).rows[0]?.note).toBe("agent running");
  });

  /*
   * A pairing is learned from the evaluations the board already observes —
   * re-derived every tick, with no label or lock of its own — and held
   * elsewhere for as long as the latest one says so.
   */
  it("holds a paired ticket elsewhere, saying where and since when, until an evaluation stops naming it", async () => {
    const board = shell(() => 5_000);
    board.list(graph([ticket("1", {}, ["go", "lr:stage:spec", "lr:working"])]));
    const at = "1970-01-01T00:00:02.000Z";
    board.observe({ name: "ticket.evaluated", ticket: "1", decision: "wait", stage: "spec", paired: { stage: "spec", round: 2, n: 1, at } });
    expect((await board.view()).rows[0]).toMatchObject({
      badge: "elsewhere", lane: "elsewhere", stage: "spec", round: 2, note: "Pairing — spec, round 2", since: 2_000,
    });
    board.observe({ name: "ticket.evaluated", ticket: "1", decision: "invoke", stage: "spec", paired: null });
    expect((await board.view()).rows[0]?.note).not.toMatch(/Pairing/);
  });

  it("opens a running row on step.started and closes it on step.finished", async () => {
    let t = 10;
    const board = shell(() => t);
    board.list(graph([ticket("1")]));
    board.observe({ name: "step.started", ticket: "1", stage: "spec", round: 1, model: "opus", effort: "low" });
    t = 20;
    expect((await board.view()).rows[0]).toMatchObject({ badge: "running", since: 10, model: "opus", effort: "low" });
    board.observe({ name: "step.finished", ticket: "1", stage: "spec", round: 1, ok: true });
    expect((await board.view()).rows[0]?.badge).toBe("waiting");
  });

  /*
   * After a step, the graph's labels are the ones from before it: a list
   * read while the tick still holds the ticket may predate the transition
   * too. Only a list after the tick lets the ticket go vouches for them.
   */
  it("marks a stepped ticket's labels stale until a list after its tick let it go", async () => {
    const board = shell(() => 0);
    const blocked = ["go", "lr:stage:blocked", "lr:blocked"];
    const listed = graph([ticket("1", {}, blocked), ticket("2", {}, blocked)]);
    const stale = async () => (await board.view()).rows.map((r) => [r.id, r.badge, r.stale]);
    board.list(listed);
    expect(await stale()).toEqual([["1", "needs-you", false], ["2", "needs-you", false]]);
    board.observe({ name: "step.started", ticket: "1", stage: "spec", round: 1 });
    board.observe({ name: "step.finished", ticket: "1", stage: "spec", round: 1, ok: true });
    expect(await stale()).toEqual([["1", "needs-you", true], ["2", "needs-you", false]]);
    board.list(listed);
    expect(await stale()).toEqual([["1", "needs-you", true], ["2", "needs-you", false]]);
    board.observe({ name: "lock.released", ticket: "1", kind: "tick" });
    board.observe({ name: "lock.released", ticket: "2", kind: "tick" });
    expect(await stale()).toEqual([["1", "needs-you", true], ["2", "needs-you", false]]);
    board.list(listed);
    expect(await stale()).toEqual([["1", "needs-you", false], ["2", "needs-you", false]]);
  });

  // No effort on the step is the executor's default, not a level: null, as
  // model is, and never whatever else an event put under the key.
  it("carries no effort for a step that named none, or named something not a string", async () => {
    const board = shell(() => 0);
    board.list(graph([ticket("1"), ticket("2")]));
    board.observe({ name: "step.started", ticket: "1", stage: "spec", round: 1 });
    board.observe({ name: "step.started", ticket: "2", stage: "spec", round: 1, effort: { level: "max" } });
    const rows = (await board.view()).rows;
    expect(rows.map((r) => [r.badge, r.effort])).toEqual([["running", null], ["running", null]]);
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
