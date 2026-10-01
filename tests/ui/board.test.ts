import { claimItems } from "#core/index.js";
import type { Entry, Graph, Held, Node, Relationship, Running, Workflow } from "#namespace.js";
import { chatFor } from "#ui/chat.js";
import { boardView, conversationOf, createBoard } from "#ui/board.js";
import { laneOf } from "#runner/status.js";

const workflow: Workflow = {
  version: 1, name: "t", description: "test",
  eligible: [{ when: { "node.state.labels": { $in: ["go"] } }, else: "no go label" }],
  stages: [
    { id: "spec", entry: true, step: "steps/spec.md", goto: ["spec"], triggers: [{ when: { "run.stage": null } }] },
    { id: "blocked", goto: ["spec"], triggers: [{ when: { "run.lastOutputValid": false } }] },
    { id: "spec-human-review", waits: "person", triggers: [{ when: { "run.stage": "spec" } }] },
    { id: "done", terminal: true, triggers: [{ when: { "run.stage": "spec" } }] },
  ],
};

const item = (id: string, over: Partial<Node> = {}, labels: string[] = ["go"]): Node => ({
  id, kind: "item", title: `t${id}`, link: `https://x/${id}`, closed: null, priority: null, origin: null,
  state: { labels, assignees: [] }, ...over,
});
const pr = (id: string, over: Partial<Node> = {}): Node => ({
  id, kind: "pull-request", title: `PR ${id}`, link: `https://github.com/a/b/pull/${id}`, closed: null,
  priority: null, origin: null, state: { merged: false, openThreads: 0 }, ...over,
});
const edge = (from: string, to: string, type = "child-of"): Relationship => ({ from, to, type });
const graph = (nodes: Node[], relationships: Relationship[] = []): Graph => ({ nodes, relationships });
const NEST = new Set(["child-of", "implements"]);

/** A workspace of the one workflow above, `t`, and what a tick would list of `g` in it. */
const ONLY = [{ id: "t", workflow }];
const listingOf = (g: Graph) => ({ graphs: [g], sourceOf: new Map([["t", 0]]), claims: claimItems([{ id: "t", workflow, source: 0 }], [g]) });

const view = (g: Graph, over: Partial<Parameters<typeof boardView>[0]> = {}) =>
  boardView({
    workflows: ONLY, listing: listingOf(g), nest: NEST, now: 100, pid: 1, nextTickAt: null,
    running: new Map(), elsewhere: new Map(), folder: "landrace", workspace: "/repo/landrace", ...over,
  });

type Rows = ReturnType<typeof view>["rows"];
const shape = (rows: Rows): unknown => rows.map((r) => (r.children.length ? [r.id, shape(r.children)] : r.id));
const flatten = (rows: Rows): Rows => rows.flatMap((r) => [r, ...flatten(r.children)]);

describe("laneOf", () => {
  const row = (note: string, stage: string | null = "spec") => ({ item: "1", title: "t", stage, note });
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

  it("puts an item at a terminal stage in discharged", () => {
    expect(laneOf(row("queued", "done"), workflow)).toBe("discharged");
  });

  it("never discharges an item that needs a human, terminal or not", () => {
    expect(laneOf(row("blocked: needs a human", "done"), workflow)).toBe("needs-you");
  });
});

/*
 * Needs you, like any blocked item — it is one — with the reason on the row,
 * so the person who opens it knows to read a security verdict rather than an
 * agent's broken answer. The reason itself is on the item, in a comment the
 * board does not read: it is drawn from the listed labels, and a comment read
 * per item per tick is a cost this page does not get to add.
 */
describe("boardView: an item a security check stopped", () => {
  it("is in Needs you, marked screened, and says it was a security check", () => {
    const [row] = view(graph([item("1", {}, ["go", "lr:stage:screened", "lr:blocked", "lr:screened"])])).rows;
    expect(row).toMatchObject({ badge: "needs-you", lane: "needs-you", screened: true, note: "blocked by a security check" });
  });

  it("marks an item blocked for any other reason as not screened", () => {
    const [row] = view(graph([item("1", {}, ["go", "lr:stage:blocked", "lr:blocked"])])).rows;
    expect(row).toMatchObject({ badge: "needs-you", screened: false, note: "blocked: needs a human" });
  });

  it("marks no artifact screened", () => {
    const [row] = view(graph([pr("pr-9")])).rows;
    expect(row?.screened).toBe(false);
  });
});

/*
 * Retry is offered on exactly the items a human turn would hand back: the
 * blocked and the screened. The path comes from the server, built from an id
 * it has checked, so the page never puts a URL together itself.
 */
describe("boardView: which rows offer a Retry", () => {
  const rowFor = (labels: string[], over: Partial<Node> = {}, opts: Partial<Parameters<typeof boardView>[0]> = {}) =>
    view(graph([item("7", over, ["go", ...labels])]), opts).rows[0];

  it.each([
    ["blocked", ["lr:stage:blocked", "lr:blocked"]],
    ["screened", ["lr:stage:screened", "lr:blocked", "lr:screened"]],
  ])("offers it on a %s item, as the path to post to", (_, labels) => {
    expect(rowFor(labels)?.retry).toBe("/items/7/retry");
  });

  it.each([
    ["waiting on you", ["lr:stage:spec-human-review", "lr:awaiting"]],
    ["working", ["lr:stage:build", "lr:working"]],
    ["queued", ["lr:stage:spec"]],
  ])("offers none on an item that is %s", (_, labels) => {
    expect(rowFor(labels)?.retry).toBeNull();
  });

  it("offers none on a closed item, whatever its labels still say", () => {
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

// A clearance waives the screener, so only an item a security check stopped
// is offered one — and only where a Retry would be.
describe("boardView: which rows offer Clear & retry", () => {
  const rowFor = (labels: string[], opts: Partial<Parameters<typeof boardView>[0]> = {}) =>
    view(graph([item("7", {}, ["go", ...labels])]), opts).rows[0];

  it("offers it on a screened item, as the path to post to", () => {
    expect(rowFor(["lr:stage:screened", "lr:blocked", "lr:screened"])?.clear).toBe("/items/7/clear");
  });

  it.each([
    ["blocked for a broken contract", ["lr:stage:blocked", "lr:blocked"]],
    ["waiting on you", ["lr:stage:spec-human-review", "lr:awaiting"]],
    ["working", ["lr:stage:build", "lr:working"]],
  ])("offers none on an item %s", (_, labels) => {
    expect(rowFor(labels)?.clear).toBeNull();
  });

  it("offers none while an agent is running on it", () => {
    const running = new Map<string, Running>([["7", { stage: "spec", round: 2, model: null, effort: null, since: 1 }]]);
    expect(rowFor(["lr:stage:screened", "lr:blocked", "lr:screened"], { running })?.clear).toBeNull();
  });
});

/*
 * "Go to step…" is offered wherever a person's turn might be: the board holds
 * labels, not records, so it cannot tell a judge whose round is settled from
 * one whose step is still owed — `sendTo` is the authority on that, and
 * refuses an owed step in a sentence. A stage that runs a step still lists
 * its own goto targets, so long as nothing is running now.
 */
describe("boardView: where a row may send its item back to", () => {
  const rowFor = (labels: string[], over: Partial<Node> = {}, opts: Partial<Parameters<typeof boardView>[0]> = {}) =>
    view(graph([item("7", over, ["go", ...labels])]), opts).rows[0];

  it("offers the targets its stage lists, as paths the server built", () => {
    expect(rowFor(["lr:stage:blocked", "lr:blocked"])?.goto).toEqual([{ stage: "spec", path: "/items/7/goto/spec" }]);
  });

  it("offers a stepped stage's targets too, while nothing is running on it", () => {
    expect(rowFor(["lr:stage:spec"])?.goto).toEqual([{ stage: "spec", path: "/items/7/goto/spec" }]);
  });

  it("offers none on a closed item, or while its agent runs", () => {
    expect(rowFor(["lr:stage:blocked"], { closed: "done" })?.goto).toEqual([]);
    const running = new Map<string, Running>([["7", { stage: "spec", round: 2, model: null, effort: null, since: 1 }]]);
    expect(rowFor(["lr:stage:blocked"], {}, { running })?.goto).toEqual([]);
  });

  it("offers none on a row held elsewhere", () => {
    const other: Held = { item: "7", holder: "conversation:77", kind: "conversation", pid: 77, at: 90, deadlineMs: 1, token: "t" };
    expect(rowFor(["lr:stage:blocked"], {}, { elsewhere: new Map([["7", other]]) })?.goto).toEqual([]);
  });
});

/*
 * Every item opens a panel, whatever it is doing; nothing else does. The
 * paths come from the server, built from an id it has checked, so the page
 * never puts a URL together itself.
 */
describe("boardView: an item's panel", () => {
  const PATHS = {
    activity: "/items/7/activity", conversation: "/items/7/conversation",
    reply: "/items/7/reply", ask: "/items/7/ask", resolve: "/items/7/resolve",
    pairing: "/items/7/pairing", pair: "/items/7/pair", finish: "/items/7/finish", release: "/items/7/release",
  };

  it("names its panel's paths on every item — waiting, running, needing you or closed", () => {
    const running = new Map<string, Running>([["8", { stage: "spec", round: 1, model: null, effort: null, since: 1 }]]);
    const rows = view(graph([
      item("7"), item("8"), item("9", {}, ["go", "lr:stage:blocked", "lr:blocked"]), item("10", { closed: "done" }),
    ]), { running }).rows;
    // Drawn lane by lane: needs you, running, waiting, done.
    expect(rows.map((r) => r.panel?.conversation)).toEqual([
      "/items/9/conversation", "/items/8/conversation", "/items/7/conversation", "/items/10/conversation",
    ]);
    expect(rows.find((r) => r.id === "7")?.panel).toEqual(PATHS);
  });

  // Nothing is written to a closed item: its panel reads, and offers nothing to write.
  it("gives a closed item a panel that only reads", () => {
    expect(view(graph([item("10", { closed: "done" })])).rows[0]?.panel).toEqual({
      ...PATHS, activity: "/items/10/activity", conversation: "/items/10/conversation", pairing: "/items/10/pairing",
      reply: null, ask: null, resolve: null, pair: null, finish: null, release: null,
    });
  });

  it("gives an artifact none, and an item whose id is not one none", () => {
    expect(view(graph([pr("pr-9")])).rows[0]?.panel).toBeNull();
    expect(view(graph([item("../7")])).rows[0]?.panel).toBeNull();
  });
});

describe("conversationOf", () => {
  const entry = (over: Partial<Entry>): Entry => ({ stage: "-", kind: "human", round: 0, at: "2026-01-01T00:00:01Z", byAgent: false, ...over });

  it("reads the item's records oldest first, ours as landrace's and a person's as theirs", () => {
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

describe("boardView: when a row's node was created, and last changed", () => {
  it("carries the source's creation time onto the row, and null where the source gave none", () => {
    const rows = flatten(view(graph([item("1"), pr("pr-2", { createdAt: 42 })], [edge("pr-2", "1", "implements")])).rows);
    expect(rows.find((r) => r.id === "pr-2")?.createdAt).toBe(42);
    expect(rows.find((r) => r.id === "1")?.createdAt).toBeNull();
  });

  it("carries the source's last update time onto the row, and null where the source gave none", () => {
    const rows = flatten(view(graph([item("1", { updatedAt: 7 }), pr("pr-2", { updatedAt: 43 }), item("3")], [
      edge("pr-2", "1", "implements"),
    ])).rows);
    expect(rows.map((r) => [r.id, r.updatedAt])).toEqual([["1", 7], ["pr-2", 43], ["3", null]]);
  });
});

describe("boardView: the tree", () => {
  it("nests a child under its parent and a pull request under its item", () => {
    const g = graph([item("1"), item("2"), pr("pr-9")], [edge("2", "1"), edge("pr-9", "2", "implements")]);
    expect(shape(view(g).rows)).toEqual([["1", [["2", ["pr-9"]]]]]);
  });

  it("nests only along the relation types it was told are singular", () => {
    const g = graph([item("1"), item("2")], [edge("2", "1", "blocks")]);
    expect(shape(view(g).rows)).toEqual(["1", "2"]);
    expect(shape(view(graph([item("1"), item("2")], [edge("2", "1")]), { nest: new Set() }).rows)).toEqual(["1", "2"]);
  });

  it("makes a node whose parent is not in the graph a root", () => {
    expect(shape(view(graph([item("2")], [edge("2", "404")])).rows)).toEqual(["2"]);
  });

  it("makes a node that claims two parents a root, rather than picking one", () => {
    const g = graph([item("1"), item("2"), item("3")], [edge("3", "1"), edge("3", "2")]);
    expect(shape(view(g).rows)).toEqual(["1", "2", "3"]);
  });

  it("makes a node whose singular edges of different types name different parents a root too", () => {
    const g = graph([item("1"), item("2"), pr("pr-3")], [edge("pr-3", "1"), edge("pr-3", "2", "implements")]);
    expect(shape(view(g).rows)).toEqual(["1", "2", "pr-3"]);
  });

  it("nests a node whose singular edges of different types agree on one parent", () => {
    const g = graph([item("1"), pr("pr-3")], [edge("pr-3", "1"), edge("pr-3", "1", "implements")]);
    expect(shape(view(g).rows)).toEqual([["1", ["pr-3"]]]);
  });

  it("shows every node of a cycle exactly once, and returns", () => {
    const g = graph([item("1"), item("2"), item("3")], [edge("1", "2"), edge("2", "3"), edge("3", "1")]);
    expect(flatten(view(g).rows).map((r) => r.id).sort()).toEqual(["1", "2", "3"]);
  });

  it("shows a node listed twice once", () => {
    expect(flatten(view(graph([item("1"), item("1")])).rows).map((r) => r.id)).toEqual(["1"]);
  });

  it("orders undated siblings in a waiting branch by id as a number would, whatever their priority", () => {
    const g = graph([item("10"), item("9"), item("3", { priority: 2 }), item("4", { priority: 0 })]);
    expect(view(g).rows.map((r) => r.id)).toEqual(["3", "4", "9", "10"]);
    const kids = graph([item("1"), item("12"), item("11", { priority: 1 }), item("2")], [
      edge("12", "1"), edge("11", "1"), edge("2", "1"),
    ]);
    expect(view(kids).rows[0]?.children.map((r) => r.id)).toEqual(["2", "11", "12"]);
  });

  it("keeps a closed or dropped node, marked so the page can grey it", () => {
    const g = graph([item("1"), item("2", { closed: "dropped" }), item("3", { closed: "done" })], [edge("2", "1"), edge("3", "1")]);
    const kids = view(g).rows[0]?.children;
    expect(kids?.map((r) => [r.id, r.closed])).toEqual([["2", "dropped"], ["3", "done"]]);
  });

  it("never gives a closed item a needs-you or running badge", () => {
    const running = new Map<string, Running>([["2", { stage: "build", round: 1, model: null, effort: null, since: 5 }]]);
    const g = graph([item("1"), item("2", { closed: "done" }), item("3", { closed: "dropped" }, ["go", "lr:blocked"])], [
      edge("2", "1"), edge("3", "1"),
    ]);
    const rows = view(g, { running }).rows;
    expect(rows[0]?.children.map((r) => r.badge)).toEqual(["discharged", "discharged"]);
  });
});

describe("boardView: lanes", () => {
  const blocked = ["go", "lr:blocked"];

  it("puts a branch whose child needs you in needs-you, and the child keeps its own badge", () => {
    const rows = view(graph([item("1"), item("2", {}, blocked)], [edge("2", "1")])).rows;
    expect(rows[0]).toMatchObject({ id: "1", lane: "needs-you", badge: "waiting" });
    expect(rows[0]?.children[0]).toMatchObject({ id: "2", badge: "needs-you" });
  });

  it("raises a branch for a grandchild that needs you", () => {
    const g = graph([item("1"), item("2"), item("3", {}, blocked)], [edge("2", "1"), edge("3", "2")]);
    expect(view(g).rows[0]?.lane).toBe("needs-you");
  });

  it("puts a branch with a running child in running", () => {
    const running = new Map<string, Running>([["2", { stage: "build", round: 1, model: null, effort: null, since: 5 }]]);
    expect(view(graph([item("1"), item("2")], [edge("2", "1")]), { running }).rows[0]?.lane).toBe("running");
  });

  it("ranks needs-you over running over elsewhere over waiting, whichever sub-branch they sit in", () => {
    const running = new Map<string, Running>([["2", { stage: "build", round: 1, model: null, effort: null, since: 5 }]]);
    const g = graph([item("1"), item("2"), item("3"), item("4", {}, blocked)], [edge("2", "1"), edge("3", "1"), edge("4", "3")]);
    expect(view(g, { running }).rows[0]?.lane).toBe("needs-you");
    expect(view(graph([item("1"), item("2"), item("3")], [edge("2", "1"), edge("3", "1")]), { running }).rows[0]?.lane)
      .toBe("running");
  });

  it("never lets a closed item raise its branch, whatever its stale labels say", () => {
    const g = graph([item("1"), item("2", { closed: "done" }, blocked), item("3", { closed: "dropped" }, blocked)], [
      edge("2", "1"), edge("3", "1"),
    ]);
    const rows = view(g).rows;
    expect(rows[0]).toMatchObject({ lane: "waiting" });
  });

  it("still raises a closed parent's branch for an open child that needs you", () => {
    const g = graph([item("1", { closed: "done" }), item("2", {}, blocked)], [edge("2", "1")]);
    expect(view(g).rows[0]).toMatchObject({ badge: "discharged", lane: "needs-you" });
  });

  it("puts an item with no sub-items in the lane of its own badge", () => {
    const running = new Map<string, Running>([["2", { stage: "spec", round: 1, model: null, effort: null, since: 5 }]]);
    const other: Held = { item: "3", holder: "conversation:77", kind: "conversation", pid: 77, at: 90, deadlineMs: 1, token: "t" };
    const g = graph([
      item("1", {}, blocked), item("2"), item("3"), item("4"), item("5", {}, []), item("6", { closed: "done" }),
    ]);
    const rows = view(g, { running, elsewhere: new Map([["3", other]]) }).rows;
    expect(rows.map((r) => [r.id, r.lane, r.badge])).toEqual([
      ["1", "needs-you", "needs-you"], ["2", "running", "running"], ["3", "elsewhere", "elsewhere"],
      ["4", "waiting", "waiting"], ["5", "not-admitted", "not-admitted"], ["6", "discharged", "discharged"],
    ]);
  });

  it("files a branch under Held elsewhere for a grandchild held elsewhere, whatever its root's own badge", () => {
    const other: Held = { item: "3", holder: "conversation:77", kind: "conversation", pid: 77, at: 90, deadlineMs: 1, token: "t" };
    const g = graph([item("1", {}, []), item("2", {}, []), item("3")], [edge("2", "1"), edge("3", "2")]);
    expect(view(g, { elsewhere: new Map([["3", other]]) }).rows[0]).toMatchObject({ badge: "not-admitted", lane: "elsewhere" });
  });

  it("never lets an artifact raise a branch", () => {
    const g = graph([item("1", {}, []), pr("pr-9")], [edge("pr-9", "1", "implements")]);
    expect(view(g).rows[0]).toMatchObject({ lane: "not-admitted" });
  });

  it("puts a branch with no item in it in waiting while open, and in discharged once closed", () => {
    const rows = view(graph([pr("pr-1"), pr("pr-2", { closed: "done" })])).rows;
    expect(rows.map((r) => [r.id, r.lane])).toEqual([["pr-1", "waiting"], ["pr-2", "discharged"]]);
  });

  it("gives a lane only to a root: a nested row is drawn in its root's", () => {
    const g = graph([item("1"), item("2", {}, blocked), pr("pr-9")], [edge("2", "1"), edge("pr-9", "2", "implements")]);
    const nested = flatten(view(g).rows).filter((r) => r.id !== "1");
    expect(nested.map((r) => [r.id, r.lane])).toEqual([["2", null], ["pr-9", null]]);
  });
});

/*
 * Needs you is a queue: the most urgent first, and within a priority whoever
 * has waited longest. Every other lane is a feed: whatever moved last on top,
 * priority ignored. A branch reads like its lane at every depth, and a row
 * with no update time has no place in time, so it goes last.
 */
describe("boardView: the order within a lane", () => {
  const blocked = ["go", "lr:blocked"];
  const ids = (rows: Rows): string[] => rows.map((r) => r.id);

  it("puts Needs you in priority order, P0 first and unprioritised last, whatever their update times", () => {
    const g = graph([
      item("1", { updatedAt: 1 }, blocked), item("2", { priority: 1, updatedAt: 5 }, blocked),
      item("3", { priority: 0, updatedAt: 9 }, blocked),
    ]);
    expect(ids(view(g).rows)).toEqual(["3", "2", "1"]);
  });

  it("puts the least recently updated first within a priority in Needs you, and the undated below both", () => {
    const g = graph([
      item("4", { priority: 1, updatedAt: 30 }, blocked), item("5", { priority: 1 }, blocked),
      item("6", { priority: 1, updatedAt: 10 }, blocked), item("7", { updatedAt: 2 }, blocked), item("8", {}, blocked),
    ]);
    expect(ids(view(g).rows)).toEqual(["6", "4", "5", "7", "8"]);
  });

  const held = (id: string): Held => ({ item: id, holder: "conversation:77", kind: "conversation", pid: 77, at: 90, deadlineMs: 1, token: "t" });
  const run: Running = { stage: "spec", round: 1, model: null, effort: null, since: 5 };
  it.each([
    ["Agent running", "running", [], {}, { running: new Map([["1", run], ["2", run], ["3", run]]) }],
    ["Held elsewhere", "elsewhere", [], {}, { elsewhere: new Map(["1", "2", "3"].map((id): [string, Held] => [id, held(id)])) }],
    ["Waiting", "waiting", [], {}, {}],
    ["Not admitted", "not-admitted", null, {}, {}],
    ["Done", "discharged", [], { closed: "done" }, {}],
  ] as const)("puts %s newest first, priority ignored, the undated last", (_, lane, labels, over, opts) => {
    const at = (id: string, fields: Partial<Node>) => item(id, { ...over, ...fields }, labels === null ? [] : ["go", ...labels]);
    const g = graph([at("1", { priority: 0, updatedAt: 10 }), at("2", { updatedAt: 30 }), at("3", { priority: 1 })]);
    const rows = view(g, opts).rows;
    expect(rows.map((r) => [r.id, r.lane])).toEqual([["2", lane], ["1", lane], ["3", lane]]);
  });

  it("breaks a tie on equal keys by id as a number would, in every lane", () => {
    expect(ids(view(graph([item("10", { updatedAt: 5 }), item("9", { updatedAt: 5 })])).rows)).toEqual(["9", "10"]);
    expect(ids(view(graph([item("10"), item("9")])).rows)).toEqual(["9", "10"]);
    const needs = graph([item("10", { priority: 2, updatedAt: 5 }, blocked), item("9", { priority: 2, updatedAt: 5 }, blocked)]);
    expect(ids(view(needs).rows)).toEqual(["9", "10"]);
  });

  it("orders a Waiting branch's children newest first at every depth, priority ignored", () => {
    const g = graph([
      item("1", { updatedAt: 100 }), item("2", { priority: 0, updatedAt: 10 }), item("3", { updatedAt: 30 }),
      item("4", { priority: 1 }), pr("pr-5", { updatedAt: 1 }), item("6", { priority: 0, updatedAt: 2 }),
    ], [edge("2", "1"), edge("3", "1"), edge("4", "1"), edge("pr-5", "3", "implements"), edge("6", "3")]);
    expect(shape(view(g).rows)).toEqual([["1", [["3", ["6", "pr-5"]], "2", "4"]]]);
  });

  it("orders a Needs you branch's children by priority, then oldest first, at every depth", () => {
    const g = graph([
      item("1", {}, blocked), item("2", { priority: 1, updatedAt: 10 }), item("3", { priority: 0, updatedAt: 50 }),
      item("4", { priority: 1, updatedAt: 5 }), item("5", { updatedAt: 1 }),
      item("6", { updatedAt: 9 }), item("7", { priority: 3, updatedAt: 99 }),
    ], [edge("2", "1"), edge("3", "1"), edge("4", "1"), edge("5", "1"), edge("6", "3"), edge("7", "3")]);
    expect(shape(view(g).rows)).toEqual([["1", [["3", ["7", "6"]], "4", "2", "5"]]]);
  });

  it("places a root a child lifted into Needs you by the root's own priority and update time, not the child's", () => {
    const g = graph([
      item("10", { priority: 2, updatedAt: 1 }), item("2", { priority: 0, updatedAt: 0 }, blocked),
      item("3", { priority: 1, updatedAt: 100 }, blocked), item("4", { priority: 2, updatedAt: 50 }, blocked),
    ], [edge("2", "10")]);
    expect(view(g).rows.map((r) => [r.id, r.lane])).toEqual([["3", "needs-you"], ["10", "needs-you"], ["4", "needs-you"]]);
  });

  it("draws the lanes most urgent first, whatever their rows' update times", () => {
    const g = graph([item("1", { closed: "done", updatedAt: 99 }), item("2", { updatedAt: 50 }), item("3", { updatedAt: 1 }, blocked)]);
    expect(view(g).rows.map((r) => [r.id, r.lane])).toEqual([["3", "needs-you"], ["2", "waiting"], ["1", "discharged"]]);
  });
});

describe("boardView: rows", () => {
  it("notes a closed item as closed or dropped, not as whatever its stale labels last said", () => {
    const g = graph([item("2", { closed: "done" }, ["go", "lr:blocked"]), item("3", { closed: "dropped" }, ["go", "lr:blocked"])]);
    expect(view(g).rows.map((r) => [r.id, r.note])).toEqual([["2", "closed"], ["3", "dropped"]]);
  });

  it("draws an item whose id no chat link may carry, without its chat, instead of blanking the page", () => {
    const g = graph([item("1"), item("bad id")]);
    const rows = view(g).rows;
    expect(rows.map((r) => [r.id, r.chat === null])).toEqual([["1", false], ["bad id", true]]);
  });

  // One workflow: every item is its, and a tag saying so on each row would say nothing.
  it("names the workflow an item is in, but draws no tag for it in a workspace of one", () => {
    expect(view(graph([item("1")])).rows[0]).toMatchObject({ workflow: "t", tag: null });
  });

  it("gives an item row a badge, its stage, a chat, and its system", () => {
    const row = view(graph([item("7", { link: "https://github.com/a/b/issues/7" })])).rows[0];
    expect(row).toMatchObject({ id: "7", kind: "item", badge: "waiting", system: { name: "GitHub" } });
    expect(row?.chat).toEqual(chatFor("7", "/repo/landrace"));
  });

  it("gives an artifact row no badge and no chat, and its system", () => {
    const g = graph([item("1"), pr("pr-9", { state: { merged: false, openThreads: 2 } })], [edge("pr-9", "1", "implements")]);
    const row = view(g).rows[0]?.children[0];
    expect(row).toMatchObject({ kind: "pull-request", badge: null, chat: null });
    expect(row?.system?.name).toBe("GitHub");
  });

  /*
   * Item #19 sat at spec-human-review with its spec published and nothing on
   * the board to open. A source reports the page as a document with a
   * singular `documents` edge, and that is all the board needs: it nests it
   * under its item as an artifact row, and says where the page lives.
   */
  it("nests a published spec under its item as a document row, linked to it on GitHub Pages", () => {
    const spec: Node = {
      id: "spec-19", kind: "document", title: "Spec", link: "https://acme.github.io/widgets/specs/19/",
      closed: null, priority: null, origin: null, state: {},
    };
    const g = graph([item("19"), spec], [edge("spec-19", "19", "documents")]);
    const rows = view(g, { nest: new Set([...NEST, "documents"]) }).rows;

    expect(shape(rows)).toEqual([["19", ["spec-19"]]]);
    expect(rows[0]?.children[0]).toMatchObject({
      id: "spec-19", kind: "document", title: "Spec", link: "https://acme.github.io/widgets/specs/19/",
      system: { name: "GitHub Pages" }, badge: null, chat: null, lane: null,
    });
    // Not work: the item's own badge decides its lane.
    expect(rows[0]).toMatchObject({ badge: "waiting", lane: "waiting" });
  });

  it("drops a link that is not http(s), on artifact rows as on items", () => {
    expect(view(graph([pr("pr-9", { link: "javascript:alert(1)" })])).rows[0]).toMatchObject({ link: "", system: null });
    expect(view(graph([item("1", { link: "javascript:alert(1)" })])).rows[0]).toMatchObject({ link: "", system: null });
    expect(view(graph([item("1", { link: "https://ok/1" })])).rows[0]?.link).toBe("https://ok/1");
  });

  it("flattens titles to one line", () => {
    const row = view(graph([item("1", { title: "a\nb\u001b[2Jc" })])).rows[0];
    expect(row?.title).toBe("a b [2Jc");
  });

  it("carries nothing the allowlist does not name", () => {
    const row = view(graph([pr("p", { state: { secret: "hunter2" }, origin: { parent: "1", stage: "s", round: 1 } })])).rows[0];
    expect(Object.keys(row ?? {}).sort()).toEqual([
      "badge", "chat", "children", "clear", "closed", "createdAt", "effort", "goto", "id", "kind", "lane", "link", "model", "note", "panel",
      "priority", "retry", "round", "screened", "since", "stage", "stale", "system", "tag", "title", "updatedAt", "workflow",
    ]);
    expect(JSON.stringify(row)).not.toContain("hunter2");
  });

  // At a stage that waits on you: without the override, the row would be needs-you.
  it("puts an item with an agent running in `running`, over whatever its labels say", () => {
    const running = new Map<string, Running>([["1", { stage: "spec", round: 2, model: "opus", effort: "high", since: 40 }]]);
    const row = view(graph([item("1", {}, ["go", "lr:stage:spec-human-review"])]), { running }).rows[0];
    expect(row).toMatchObject({ badge: "running", round: 2, model: "opus", effort: "high", since: 40, note: "agent running" });
  });

  it("puts an item locked by another process in `elsewhere`, and not its own lock", () => {
    const other: Held = { item: "1", holder: "conversation:77", kind: "conversation", pid: 77, at: 90, deadlineMs: 1, token: "t" };
    const row = view(graph([item("1")]), { elsewhere: new Map([["1", other]]) }).rows[0];
    expect(row).toMatchObject({ badge: "elsewhere", note: "held by conversation (pid 77)" });
    // Held.at is a heartbeat, not when the hold began: no clock beats a wrong one.
    expect(row?.since).toBeNull();
    expect(view(graph([item("1")]), { elsewhere: new Map([["1", { ...other, pid: 1 }]]) }).rows[0]?.badge).toBe("waiting");
  });

  it("badges an item from its labels otherwise", () => {
    const rows = view(graph([item("1", {}, ["go", "lr:blocked"]), item("2", {}, [])])).rows;
    expect(rows.map((r) => [r.id, r.badge])).toEqual([["1", "needs-you"], ["2", "not-admitted"]]);
  });

  it("passes nextTickAt, folder and workspace straight through", () => {
    const v = view(graph([]), { nextTickAt: 12345, folder: "widgets", workspace: "/w" });
    expect(v).toMatchObject({ nextTickAt: 12345, folder: "widgets", workspace: "/w", rows: [] });
  });
});

describe("createBoard", () => {
  const shell = (now: () => number, held: (t: string) => Promise<Held | null> = async () => null) =>
    createBoard({ workflows: ONLY, held, now, pid: 1, folder: "landrace", workspace: "/repo/landrace", nest: [...NEST] });

  /*
   * The note says a person sent the item back, for as long as it is at the
   * step it was sent to — taken from the tick's own events, the way
   * `running` is.
   */
  it("says a running item was sent back, until it moves on", () => {
    const board = shell(() => 0);
    board.list(listingOf(graph([item("1", {}, ["go", "lr:stage:spec", "lr:working"])])));
    board.observe({ name: "item.evaluated", item: "1", decision: "transition", to: "spec", why: "goto" });
    board.observe({ name: "step.started", item: "1", stage: "spec", round: 2 });
    return board.view().then((v) => {
      expect(v.rows[0]?.note).toBe("agent running — sent back to spec");
      board.observe({ name: "item.evaluated", item: "1", decision: "transition", to: "done", why: "the spec was published" });
      return board.view();
    }).then((v) => expect(v.rows[0]?.note).toBe("agent running"));
  });

  /*
   * `sent` never clears on its own the way `running` does (no event says
   * "nobody will ever goto this again"), so an item that leaves the graph —
   * closed, or simply not relisted — has to be the thing that prunes it, or
   * a stale "sent back to X" could resurface if the same id is ever listed
   * again with no fresh goto behind it.
   */
  it("prunes sent for an item once it leaves the graph, so a stale note cannot resurface", async () => {
    const board = shell(() => 0);
    board.list(listingOf(graph([item("1", {}, ["go", "lr:stage:spec", "lr:working"])])));
    board.observe({ name: "item.evaluated", item: "1", decision: "transition", to: "spec", why: "goto" });
    board.list(listingOf(graph([]))); // item 1 is gone from this listing
    board.list(listingOf(graph([item("1", {}, ["go", "lr:stage:spec", "lr:working"])]))); // and back, with no new goto
    board.observe({ name: "step.started", item: "1", stage: "spec", round: 3 });
    expect((await board.view()).rows[0]?.note).toBe("agent running");
  });

  /*
   * A pairing is learned from the evaluations the board already observes —
   * re-derived every tick, with no label or lock of its own — and held
   * elsewhere for as long as the latest one says so.
   */
  it("holds a paired item elsewhere, saying where and since when, until an evaluation stops naming it", async () => {
    const board = shell(() => 5_000);
    board.list(listingOf(graph([item("1", {}, ["go", "lr:stage:spec", "lr:working"])])));
    const at = "1970-01-01T00:00:02.000Z";
    board.observe({ name: "item.evaluated", item: "1", decision: "wait", stage: "spec", paired: { stage: "spec", round: 2, n: 1, at } });
    expect((await board.view()).rows[0]).toMatchObject({
      badge: "elsewhere", lane: "elsewhere", stage: "spec", round: 2, note: "Pairing — spec, round 2", since: 2_000,
    });
    board.observe({ name: "item.evaluated", item: "1", decision: "invoke", stage: "spec", paired: null });
    expect((await board.view()).rows[0]?.note).not.toMatch(/Pairing/);
  });

  it("opens a running row on step.started and closes it on step.finished", async () => {
    let t = 10;
    const board = shell(() => t);
    board.list(listingOf(graph([item("1")])));
    board.observe({ name: "step.started", item: "1", stage: "spec", round: 1, model: "opus", effort: "low" });
    t = 20;
    expect((await board.view()).rows[0]).toMatchObject({ badge: "running", since: 10, model: "opus", effort: "low" });
    board.observe({ name: "step.finished", item: "1", stage: "spec", round: 1, ok: true });
    expect((await board.view()).rows[0]?.badge).toBe("waiting");
  });

  /*
   * After a step, the graph's labels are the ones from before it: a list
   * read while the tick still holds the item may predate the transition
   * too. Only a list after the tick lets the item go vouches for them.
   */
  it("marks a stepped item's labels stale until a list after its tick let it go", async () => {
    const board = shell(() => 0);
    const blocked = ["go", "lr:stage:blocked", "lr:blocked"];
    const listed = graph([item("1", {}, blocked), item("2", {}, blocked)]);
    const stale = async () => (await board.view()).rows.map((r) => [r.id, r.badge, r.stale]);
    board.list(listingOf(listed));
    expect(await stale()).toEqual([["1", "needs-you", false], ["2", "needs-you", false]]);
    board.observe({ name: "step.started", item: "1", stage: "spec", round: 1 });
    board.observe({ name: "step.finished", item: "1", stage: "spec", round: 1, ok: true });
    expect(await stale()).toEqual([["1", "needs-you", true], ["2", "needs-you", false]]);
    board.list(listingOf(listed));
    expect(await stale()).toEqual([["1", "needs-you", true], ["2", "needs-you", false]]);
    board.observe({ name: "lock.released", item: "1", kind: "tick" });
    board.observe({ name: "lock.released", item: "2", kind: "tick" });
    expect(await stale()).toEqual([["1", "needs-you", true], ["2", "needs-you", false]]);
    board.list(listingOf(listed));
    expect(await stale()).toEqual([["1", "needs-you", false], ["2", "needs-you", false]]);
  });

  // No effort on the step is the executor's default, not a level: null, as
  // model is, and never whatever else an event put under the key.
  it("carries no effort for a step that named none, or named something not a string", async () => {
    const board = shell(() => 0);
    board.list(listingOf(graph([item("1"), item("2")])));
    board.observe({ name: "step.started", item: "1", stage: "spec", round: 1 });
    board.observe({ name: "step.started", item: "2", stage: "spec", round: 1, effort: { level: "max" } });
    const rows = (await board.view()).rows;
    expect(rows.map((r) => [r.badge, r.effort])).toEqual([["running", null], ["running", null]]);
  });

  it("ignores a step event that names no item", async () => {
    const board = shell(() => 0);
    board.list(listingOf(graph([item("1")])));
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
    const board = createBoard({ workflows: ONLY, held: async () => null, nextTickAt: () => next, folder: "f", workspace: "/w", nest: [] });
    expect((await board.view()).nextTickAt).toBe(111);
    next = 222;
    expect((await board.view()).nextTickAt).toBe(222);
  });

  it("nests along the relation types it was given", async () => {
    const board = shell(() => 0);
    board.list(listingOf(graph([item("1"), item("2")], [edge("2", "1")])));
    expect(shape((await board.view()).rows)).toEqual([["1", ["2"]]]);
  });

  it("asks the lock only about open item nodes, never about a pull request or a closed item", async () => {
    const asked: string[] = [];
    const board = shell(() => 0, async (t) => { asked.push(t); return null; });
    board.list(listingOf(graph([item("4"), item("9"), item("5", { closed: "done" }), pr("pr-1")], [edge("pr-1", "4", "implements")])));
    await board.view();
    expect(asked.sort()).toEqual(["4", "9"]);
  });
});

/*
 * One page over every workflow of the workspace. Two workflows on one
 * tracker, `main` and `fast`, each admitting its own label and placing an
 * item by its own stages, and `gl` on a second tracker. An item no one
 * workflow owns is shown, never placed by whichever workflow came first.
 */
describe("the board over several workflows", () => {
  const main: Workflow = {
    version: 1, name: "Main", description: "test",
    eligible: [{ when: { "node.state.labels": { $in: ["lr:auto"] } }, else: "no lr:auto label" }],
    stages: [
      { id: "spec", entry: true, step: "steps/spec.md", goto: ["spec"], triggers: [{ when: { "run.stage": null } }] },
      { id: "blocked", goto: ["spec"], triggers: [{ when: { "run.lastOutputValid": false } }] },
      { id: "done", terminal: true, triggers: [{ when: { "run.stage": "spec" } }] },
    ],
  };
  const fast: Workflow = {
    version: 1, name: "Fastlane", description: "test",
    eligible: [{ when: { "node.state.labels": { $in: ["lr:fast"] } }, else: "no lr:fast label" }],
    stages: [
      { id: "build", entry: true, step: "steps/build.md", goto: ["build"], triggers: [{ when: { "run.stage": null } }] },
      { id: "blocked", goto: ["build"], triggers: [{ when: { "run.lastOutputValid": false } }] },
      { id: "shipped", terminal: true, triggers: [{ when: { "run.stage": "build" } }] },
    ],
  };
  const WORKFLOWS = [{ id: "main", workflow: main }, { id: "fast", workflow: fast }, { id: "gl", workflow: { ...main, name: "Lab" } }];
  /** What a tick lists: the first tracker's graph, read by main and fast, and the second's, read by gl. */
  const across = (first: Graph, second: Graph = graph([])) => ({
    graphs: [first, second],
    sourceOf: new Map(WORKFLOWS.map((w) => [w.id, w.id === "gl" ? 1 : 0])),
    claims: claimItems(WORKFLOWS.map((w) => ({ ...w, source: w.id === "gl" ? 1 : 0 })), [first, second]),
  });
  const several = (first: Graph, second?: Graph, over: Partial<Parameters<typeof boardView>[0]> = {}) =>
    boardView({
      workflows: WORKFLOWS, listing: across(first, second), nest: NEST, now: 100, pid: 1, nextTickAt: null,
      running: new Map(), elsewhere: new Map(), folder: "landrace", workspace: "/repo/landrace", ...over,
    });
  /** What an item no one workflow owns may still do in its panel: read. */
  const reads = (id: string) => ({
    activity: `/items/${id}/activity`, conversation: `/items/${id}/conversation`, pairing: `/items/${id}/pairing`,
    reply: null, ask: null, resolve: null, pair: null, finish: null, release: null,
  });
  const blocked = (admit: string[]) => [...admit, "lr:stage:blocked", "lr:blocked"];
  // Screened as well: a row its labels alone would offer every action on.
  const screened = (admit: string[]) => [...blocked(admit), "lr:screened"];

  it("places each item by the stages of the workflow that owns it, and names that workflow", () => {
    const rows = several(graph([
      item("1", {}, blocked(["lr:auto"])), item("2", {}, blocked(["lr:fast"])), item("3", {}, ["lr:fast", "lr:stage:shipped"]),
    ])).rows;
    const row = (id: string) => rows.find((r) => r.id === id);
    expect(row("1")).toMatchObject({
      workflow: "main", tag: "Main", badge: "needs-you", stage: "blocked", retry: "/items/1/retry",
      goto: [{ stage: "spec", path: "/items/1/goto/spec" }],
    });
    expect(row("2")).toMatchObject({
      workflow: "fast", tag: "Fastlane", badge: "needs-you", stage: "blocked", retry: "/items/2/retry",
      goto: [{ stage: "build", path: "/items/2/goto/build" }],
    });
    // Terminal in fast, and a stage main has never heard of.
    expect(row("3")).toMatchObject({ workflow: "fast", tag: "Fastlane", badge: "discharged", lane: "discharged" });
    // Its panel writes too: the page's writes reach its owner.
    expect(row("1")?.panel?.reply).toBe("/items/1/reply");
  });

  it("files an item two workflows claim under Needs you, naming both, with no Retry, Go to or Clear", () => {
    const [row] = several(graph([item("4", {}, screened(["lr:auto", "lr:fast"]))])).rows;
    expect(row).toMatchObject({
      id: "4", workflow: null, tag: null, badge: "needs-you", lane: "needs-you", note: "claimed by fast and main",
      stage: null, retry: null, clear: null, goto: [], panel: reads("4"),
    });
  });

  /*
   * The halt is the news: an item a person pairs on under main, then labels
   * lr:fast too, is no longer main's to pair on — the tick stops it for
   * exactly this — and its row says so over whatever it is doing.
   */
  it("says an item two workflows claim, or two trackers report, over its running, pairing or being held elsewhere", () => {
    const run: Running = { stage: "spec", round: 1, model: null, effort: null, since: 5 };
    const pairing = { stage: "spec", round: 2, n: 1, at: "1970-01-01T00:00:02.000Z" };
    const other: Held = { item: "13", holder: "conversation:77", kind: "conversation", pid: 77, at: 90, deadlineMs: 1, token: "t" };
    const both = ["lr:auto", "lr:fast", "lr:stage:spec"];
    const rows = several(graph([item("11", {}, both), item("12", {}, both), item("13", {}, both), item("14", {}, ["lr:auto"])]),
      graph([item("14", {}, ["lr:auto"])]), {
        running: new Map([["11", run], ["14", run]]), paired: new Map([["12", pairing]]), elsewhere: new Map([["13", other]]),
      }).rows;
    expect(rows.map((r) => [r.id, r.badge, r.note])).toEqual([
      ["11", "needs-you", "claimed by fast and main"], ["12", "needs-you", "claimed by fast and main"],
      ["13", "needs-you", "claimed by fast and main"], ["14", "needs-you", "reported by the sources of fast, gl and main"],
    ]);
  });

  /*
   * An id one tracker has closed and another has open is the open one's: the
   * claims gave it to the workflow that tracker serves, and a row drawn from
   * the closed node said "closed" over an agent running on it.
   */
  it("draws an item open in one tracker and closed in another from the open one, as its owner places it", () => {
    const run: Running = { stage: "spec", round: 1, model: null, effort: null, since: 5 };
    const [row] = several(graph([item("3", { closed: "done" }, ["lr:auto"])]), graph([item("3", {}, ["lr:auto", "lr:stage:spec"])]), {
      running: new Map([["3", run]]),
    }).rows;
    expect(row).toMatchObject({ id: "3", closed: null, workflow: "gl", badge: "running", note: "agent running" });
  });

  it("files an id two trackers both report under Needs you, naming the workflows reading each, with nothing to act on", () => {
    const [row] = several(graph([item("5", {}, screened(["lr:auto"]))]), graph([item("5", {}, screened(["lr:auto"]))])).rows;
    expect(row).toMatchObject({
      id: "5", workflow: null, tag: null, badge: "needs-you", lane: "needs-you", note: "reported by the sources of fast, gl and main",
      stage: null, retry: null, clear: null, goto: [], panel: reads("5"),
    });
  });

  it("files an item no workflow claims under Not admitted, with each workflow's reason and nothing to act on", () => {
    const [row] = several(graph([item("6", {}, screened([]))])).rows;
    expect(row).toMatchObject({
      id: "6", workflow: null, tag: null, badge: "not-admitted", lane: "not-admitted", note: "skipped: no lr:auto label; no lr:fast label",
      retry: null, clear: null, goto: [], panel: reads("6"),
    });
  });

  describe("whose an item is, by the last listing", () => {
    const board = () => createBoard({ workflows: WORKFLOWS, held: async () => null, folder: "f", workspace: "/w", nest: [] });

    it("is nobody's before the first listing", () => {
      expect(board().ownerOf("1")).toEqual({ refused: "#1 has not been listed yet; act on it after the first tick" });
    });

    it("is the one workflow that claims it, and otherwise a sentence saying why it is no one's", () => {
      const b = board();
      b.list(across(graph([
        item("1", {}, ["lr:auto"]), item("2", {}, ["lr:fast"]), item("4", {}, ["lr:auto", "lr:fast"]), item("5", {}, ["lr:auto"]),
        item("6", {}, []), item("7", { closed: "done" }, ["lr:auto"]), pr("pr-8"),
      ]), graph([item("5", {}, ["lr:auto"])])));

      expect(b.ownerOf("1")).toEqual({ workflow: "main" });
      expect(b.ownerOf("2")).toEqual({ workflow: "fast" });
      expect(b.ownerOf("4")).toEqual({ refused: "#4 is claimed by fast and main; act on it after one workflow alone claims it" });
      expect(b.ownerOf("5")).toEqual({
        refused: "#5 is reported by the sources of fast, gl and main; act on it after one source alone reports it",
      });
      expect(b.ownerOf("6")).toEqual({ refused: "#6 is claimed by no workflow: no lr:auto label; no lr:fast label" });
      // Nothing is written to a closed item, whoever's it was.
      expect(b.ownerOf("7")).toEqual({ refused: "#7 is closed, so nothing is written to it" });
      for (const id of ["pr-8", "99"]) expect(b.ownerOf(id)).toEqual({ refused: `#${id} is not an item the last tick listed` });
    });

    /*
     * Reads decide nothing, so only an id two trackers report is refused: which
     * of the two items was meant is not the reader's to pick. Any other item
     * one source lists — owned, claimed twice, turned away by every workflow,
     * or closed — reads through that source; an owned one through its owner.
     */
    it("reads an open item through its owner, and any other item through the one source that lists it", () => {
      const b = board();
      b.list(across(graph([
        item("1", {}, ["lr:auto"]), item("4", {}, ["lr:auto", "lr:fast"]), item("6", {}, []), item("7", { closed: "done" }, ["lr:auto"]),
        item("9", { closed: "done" }, ["lr:auto"]), item("11", {}, ["lr:auto"]), pr("pr-8"),
      ]), graph([item("10", { closed: "dropped" }, ["lr:auto"]), item("9", { closed: "done" }, ["lr:auto"]), item("11", {}, ["lr:auto"])])));

      expect(b.readerOf("1")).toEqual({ workflow: "main" });
      expect(b.readerOf("4")).toEqual({ source: 0 });
      expect(b.readerOf("6")).toEqual({ source: 0 });
      expect(b.readerOf("7")).toEqual({ source: 0 });
      expect(b.readerOf("10")).toEqual({ source: 1 });
      expect(b.readerOf("9")).toEqual({ refused: "#9 is reported by the sources of fast, gl and main; read it in its own tracker" });
      expect(b.readerOf("11")).toEqual({ refused: "#11 is reported by the sources of fast, gl and main; read it in its own tracker" });
      // Two trackers, and neither listed it: either could be the one it is in.
      for (const id of ["pr-8", "99"]) expect(b.readerOf(id)).toEqual({ refused: `#${id} is not an item the last tick listed` });
    });

    /*
     * One tracker has no one to clash with: an id its listing did not show —
     * a closed item past the window it lists — can only be in it.
     */
    it("reads an id the last listing did not show through the workspace's one source", () => {
      const b = createBoard({ workflows: WORKFLOWS.slice(0, 2), held: async () => null, folder: "f", workspace: "/w", nest: [] });
      const only = graph([item("1", {}, ["lr:auto"])]);
      b.list({
        graphs: [only], sourceOf: new Map([["main", 0], ["fast", 0]]),
        claims: claimItems(WORKFLOWS.slice(0, 2).map((w) => ({ ...w, source: 0 })), [only]),
      });
      expect(b.readerOf("99")).toEqual({ source: 0 });
      // Writes are still the owner's alone, and an id no listing showed has none.
      expect(b.ownerOf("99")).toEqual({ refused: "#99 is not an item the last tick listed" });
    });

    it("follows the latest listing: an item relabelled is its new workflow's", () => {
      const b = board();
      b.list(across(graph([item("1", {}, ["lr:auto"])])));
      b.list(across(graph([item("1", {}, ["lr:fast"])])));
      expect(b.ownerOf("1")).toEqual({ workflow: "fast" });
    });
  });
});
