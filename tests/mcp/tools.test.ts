import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMcpServer } from "#mcp/server.js";
import { createTools } from "#mcp/tools.js";
import { compareIds, renderMarker } from "#conventions.js";
import type { Executor, LoadedWorkflow, Registry, Source, Step, Tools, Workflow } from "#namespace.js";
import { acquire, release } from "#runner/lock.js";
import { buildSnapshot } from "#runner/snapshot.js";
import { listWorkspace } from "#runner/tick.js";
import { boardView } from "#ui/board.js";
import { hooked, loaded } from "#tests/support/loaded.js";
import { createFakeTracker, type FakeIssue } from "#tests/support/fake-tracker.js";
import { createExternalState } from "#testing/index.js";

// Its own lock root: these tests must not race the default one a developer's
// own loop might be holding.
let lockRoot: string;
beforeEach(async () => { lockRoot = await mkdtemp(join(tmpdir(), "lr-tools-")); });

/**
 * What the step behind a conversation declared. A turn is held to it, so a
 * conversation that cannot see it refuses to run one — which means a test that
 * drives a turn has to say what the step was, the same as the loop does.
 */
const spec: { workflow: Workflow; steps: Map<string, Step> } = {
  workflow: { version: 1, name: "t", description: "test", stages: [{ id: "spec", step: "spec", triggers: [] }] },
  steps: new Map<string, Step>([["spec", { prompt: "write the spec", capabilities: ["repo:read"] }]]),
};

/** A workflow that starts what it admits with `lr:auto`, eligible on the same label, as the shipped one is. */
const admitting = (admit?: string[]): Workflow => ({
  version: 1, name: "t", description: "test",
  ...(admit ? { admit } : {}),
  eligible: [{ when: { "node.state.labels": { $in: ["lr:auto"] } }, else: "no lr:auto label" }],
  stages: [{ id: "spec", step: "spec", triggers: [] }],
});

/**
 * A workflow where it is a person's turn at two stages: one an item is moved
 * to and labelled, one it is placed at by its own labels alone.
 */
const turns: Workflow = {
  version: 1, name: "t", description: "test", admit: ["lr:auto"],
  eligible: [{ when: { "node.state.labels": { $in: ["lr:auto"] } }, else: "no lr:auto label" }],
  stages: [
    { id: "spec", entry: true, step: "spec", triggers: [{ when: { "run.stage": null } }] },
    { id: "questions", waits: "person", triggers: [{ when: { "run.stage": "spec" } }] },
    { id: "reviewing", waits: "person", identity: { "node.state.labels": { $in: ["needs-my-review"] } },
      triggers: [{ when: { "run.stage": "spec" } }] },
    { id: "blocked", triggers: [{ when: { "run.lastOutputValid": false } }] },
    { id: "done", terminal: true, triggers: [{ when: { "run.stage": "questions" } }] },
  ],
};

const TURNS_SEED: Array<Partial<FakeIssue>> = [
  // At a stage that waits on a person, with no lr:awaiting on it.
  { number: 1, labels: ["lr:auto", "lr:stage:questions"] },
  // lr:awaiting at a stage that runs a step: not read.
  { number: 2, labels: ["lr:auto", "lr:stage:spec", "lr:awaiting"] },
  // Placed by its own labels alone, at a stage that waits.
  { number: 3, labels: ["lr:auto", "needs-my-review"] },
  { number: 4, labels: ["lr:auto", "lr:stage:blocked", "lr:blocked"] },
  // Its label and an identity disagree: halted, so a person's to settle.
  { number: 5, labels: ["lr:auto", "lr:stage:spec", "needs-my-review"] },
  { number: 6, labels: ["lr:auto", "lr:stage:done"] },
  { number: 7, labels: ["needs-my-review"] },
  // Closed, left at a stage that waits: listed under its open parent, and nobody's turn.
  { number: 8, parent: 1, state: "closed", stateReason: "COMPLETED", labels: ["lr:auto", "lr:stage:questions"] },
];

const turnsWorld = (seed: Array<Partial<FakeIssue>> = TURNS_SEED) => {
  const tracker = createFakeTracker(seed);
  return { tracker, tools: createTools([hooked(tracker.registry, loaded(turns, spec.steps))], tracker.ctx, { lock: { root: lockRoot } }) };
};

const world = (seed: Array<Partial<FakeIssue>> = []) => {
  const tracker = createFakeTracker(seed);
  return { tracker, tools: createTools([hooked(tracker.registry, loaded(admitting(["lr:auto"])))], tracker.ctx) };
};

describe("mcp tools", () => {
  it("opens an item that the orchestrator will pick up", async () => {
    const { tools } = world();
    const r = (await tools.createItem({ title: "Add CSV export" })) as Record<string, unknown>;
    expect(r).toMatchObject({ item: "1", started: true });
    expect(r.labels).toContain("lr:auto");
  });

  it("files an item without starting it when asked", async () => {
    const { tools } = world();
    const r = (await tools.createItem({ title: "Later", start: false })) as Record<string, unknown>;
    expect(r).toMatchObject({ started: false });
    expect(r.labels).not.toContain("lr:auto");
  });

  /*
   * What starts an item is what its workflow admits. The engine used to add
   * `lr:auto` whatever the workflow was, so an item opened for a workflow
   * eligible on something else was started for a different one, or for none.
   */
  it("starts an item with the labels its workflow admits, and not lr:auto", async () => {
    const tracker = createFakeTracker();
    const tools = createTools([hooked(tracker.registry, loaded(admitting(["lr:fast"])))], tracker.ctx);
    const r = (await tools.createItem({ title: "Hotfix", labels: ["bug"] })) as Record<string, unknown>;
    expect(r).toMatchObject({ started: true });
    expect(r.labels).toEqual(expect.arrayContaining(["lr:fast", "bug"]));
    expect(r.labels).not.toContain("lr:auto");
  });

  it("refuses to start an item in a workflow that admits nothing, and creates nothing", async () => {
    const tracker = createFakeTracker();
    const tools = createTools([hooked(tracker.registry, loaded(admitting(), new Map(), "fastlane"))], tracker.ctx);
    await expect(tools.createItem({ title: "Hotfix" })).rejects.toThrow(
      'workflow "fastlane" admits nothing: add admit: [<labels>] to workflows/fastlane/workflow.yaml, or create with start: false',
    );
    expect(tracker.issues.size).toBe(0);
    // Filing it without starting it needs no admission label at all.
    expect(await tools.createItem({ title: "Later", start: false })).toMatchObject({ started: false });
  });

  // The labels here used to be lr: ones, which is the editor writing workflow
  // state; tests/security/mcp-authority.test.ts now pins that refusal.
  it("updates fields and labels together", async () => {
    const { tracker, tools } = world([{ number: 4, labels: ["lr:auto", "needs-design"] }]);
    const r = (await tools.updateItem("4", {
      title: "Renamed", state: "closed", addLabels: ["bug"], removeLabels: ["needs-design"],
    })) as Record<string, unknown>;

    expect(r).toMatchObject({ title: "Renamed" });
    expect(r.labels).toEqual(expect.arrayContaining(["lr:auto", "bug"]));
    expect(r.labels).not.toContain("needs-design");
    // Asked of the tracker rather than of the tool's own echo: a Candidate
    // carries what enumerating work needs, and whether an item closed is
    // something the tracker has to actually show.
    expect(tracker.issues.get(4)?.state).toBe("closed");
  });

  /*
   * An operator's edit is a person's, as on the tracker — not a move through
   * the workflow's stages — so an item no workflow claims is edited through
   * the operator, as long as there is only one it could be edited through.
   */
  it("edits an item filed unstarted, which no workflow claims, and closes and reopens it", async () => {
    const { tracker, tools } = world();
    const { item } = (await tools.createItem({ title: "Later", start: false })) as { item: string };
    expect(await tools.updateItem(item, { title: "Sooner" })).toMatchObject({ item, title: "Sooner", workflow: null });
    await tools.updateItem(item, { state: "closed" });
    expect(tracker.issues.get(Number(item))?.state).toBe("closed");
    expect(await tools.updateItem(item, { state: "open", addLabels: ["bug"] })).toMatchObject({ item, workflow: null });
    expect(tracker.issues.get(Number(item))).toMatchObject({ state: "open", labels: ["bug"] });
  });

  /*
   * Whose turn it is is the stage's to say (`waits: person`), on the stage
   * each item is located at — by its label or by its own state — and the
   * list is the board's Needs you exactly, halts and blocks included: two
   * readers of "who is waiting on you" is how a list and a page disagree.
   */
  it("lists exactly the board's Needs you, read from the stage each item is at", async () => {
    const { tracker, tools } = turnsWorld();

    const waiting = await tools.waiting();
    expect(waiting).toEqual([
      { item: "1", title: "issue 1", url: expect.stringContaining("/1"), workflow: "main" },
      { item: "3", title: "issue 3", url: expect.stringContaining("/3"), workflow: "main" },
      { item: "4", title: "issue 4", url: expect.stringContaining("/4"), workflow: "main" },
      { item: "5", title: "issue 5", url: expect.stringContaining("/5"), workflow: "main" },
    ]);

    const { source } = tracker.registry;
    if (!source) throw new Error("the fake tracker registers no source");
    const listing = await listWorkspace({ workflows: [{ id: "main", source, deps: { workflow: turns } }], ctx: tracker.ctx, log: () => {} });
    const board = boardView({
      workflows: [{ id: "main", workflow: turns }], listing, nest: new Set(), running: new Map(), elsewhere: new Map(),
      now: 0, pid: 1, nextTickAt: null, folder: "landrace", workspace: "/repo/landrace", listed: true,
    });
    // The Needs you page's own copies: a workflow page draws the same items again.
    const needsYou = board.rows.filter((row) => row.page === null && row.badge === "needs-you").map((row) => row.id);
    expect(waiting.map((w) => w.item)).toEqual([...needsYou].sort(compareIds));
  });

  it("does not list a closed item as waiting, whatever stage it was left at", async () => {
    const { tools } = turnsWorld([
      { number: 1, labels: ["lr:auto"] },
      // Listed because it is a sub-issue of an open one; left at a stage that
      // waits on a person, and closed, so nobody's turn.
      { number: 2, parent: 1, state: "closed", stateReason: "COMPLETED", labels: ["lr:auto", "lr:stage:questions"] },
    ]);
    expect(await tools.waiting()).toEqual([]);
  });

  /*
   * One answer to "is this waiting on you", wherever it is asked: an item
   * `landrace_status` says waits on you is one `landrace_waiting` lists, at
   * the stage the board places it — by its label or by its own state.
   */
  it("says in landrace_status where each item is and whether it waits on you, as landrace_waiting does", async () => {
    const { tools } = turnsWorld();
    const waiting = (await tools.waiting()).map((w) => w.item);
    for (const item of ["1", "2", "3", "4", "5", "6", "7", "8"]) {
      expect([item, ((await tools.status(item)) as { waitingOnYou: unknown }).waitingOnYou]).toEqual([item, waiting.includes(item)]);
    }
    expect(await tools.status("1")).toMatchObject({ stage: "questions", waitingOnYou: true, blocked: false });
    expect(await tools.status("3")).toMatchObject({ stage: "reviewing", waitingOnYou: true });
    expect(await tools.status("2")).toMatchObject({ stage: "spec", waitingOnYou: false });
    expect(await tools.status("4")).toMatchObject({ stage: "blocked", waitingOnYou: true, blocked: true });
    expect(await tools.status("5")).toMatchObject({ stage: null, waitingOnYou: true, problem: "cannot place the item: spec, reviewing all match" });
    expect(waiting).not.toContain("8");
    expect(await tools.status("8")).toMatchObject({ closed: "done", waitingOnYou: false });
  });

  /*
   * The note of the stage the item rests at, rendered from its own
   * relationships, as the board and `landrace status` show it — and, being
   * display only, never what says whose turn it is: "blocked by …" is not a
   * halt. Sub-issues stand in for any relationship; nothing reads the type.
   */
  it("says in landrace_status the note of the stage an item rests at, and that it does not wait on you", async () => {
    const noted: Workflow = {
      version: 1, name: "t", description: "test", admit: ["lr:auto"],
      eligible: [{ when: { "node.state.labels": { $in: ["lr:auto"] } }, else: "no lr:auto label" }],
      stages: [
        { id: "spec", entry: true, step: "spec", triggers: [{ when: { "run.stage": null } }] },
        { id: "waiting", note: "blocked by {rel.child-of.in.open}", triggers: [{ when: { "run.stage": "spec" } }] },
      ],
    };
    const tracker = createFakeTracker([
      { number: 1, labels: ["lr:auto", "lr:stage:waiting"] },
      { number: 3, parent: 1 }, { number: 2, parent: 1 },
      { number: 4, parent: 1, state: "closed", stateReason: "COMPLETED" },
    ]);
    const tools = createTools([hooked(tracker.registry, loaded(noted, spec.steps))], tracker.ctx, { lock: { root: lockRoot } });
    expect(await tools.status("1")).toMatchObject({ stage: "waiting", note: "blocked by #2, #3", waitingOnYou: false });
  });

  /*
   * Closed between the read that routes it — open, so its workflow's — and
   * the read its snapshot is built from. The board files a closed item under
   * Done and `landrace_waiting` lists none, so nor does this say it waits.
   */
  it("does not say an item closed since it was routed waits on you, at a stage that waits", async () => {
    const tracker = createFakeTracker([{ number: 1, labels: ["lr:auto", "lr:stage:questions"] }]);
    const { source } = tracker.registry;
    if (!source) throw new Error("the fake tracker registers no source");
    let reads = 0;
    const closing = Object.create(source) as Source;
    closing.read = async (item, ctx) => {
      const graph = await source.read(item, ctx);
      reads += 1;
      return reads === 1 ? graph : { ...graph, nodes: graph.nodes.map((n) => (n.id === item ? { ...n, closed: "done" as const } : n)) };
    };
    const tools = createTools([hooked({ ...tracker.registry, source: closing }, loaded(turns, spec.steps))], tracker.ctx, { lock: { root: lockRoot } });
    expect(await tools.status("1")).toMatchObject({ workflow: "main", closed: "done", stage: "questions", waitingOnYou: false });
  });

  // A closed item is no workflow's: it is read through the one source that
  // lists it — a closed sub-issue is listed under its open parent.
  it("reports whether the item is closed, and how", async () => {
    const { tools } = world([
      { number: 3, labels: ["lr:auto"] },
      { number: 4, parent: 3, state: "closed", stateReason: "NOT_PLANNED" },
    ]);
    expect(await tools.status("3")).toMatchObject({ item: "3", closed: null, title: "issue 3", workflow: "main" });
    const closed = await tools.status("4");
    expect(closed).toMatchObject({ item: "4", closed: "dropped", workflow: null });
    expect(closed).not.toHaveProperty("eligible");
  });

  it("reports position and rounds derived from the comment stream", async () => {
    const { tracker, tools } = world([{ number: 3, labels: ["lr:auto", "lr:stage:spec"] }]);
    tracker.say(3, `draft${renderMarker({ stage: "spec", kind: "output", round: 1 })}`);
    tracker.sayAs("a-person", 3, "please narrow the scope");

    const s = (await tools.status("3")) as Record<string, unknown>;
    expect(s).toMatchObject({ item: "3", stage: "spec", eligible: true, waitingOnYou: false });
    expect(s.rounds).toEqual({ spec: 1 });
    expect(s.lastEvent).toMatchObject({ actor: "human" });
  });

  /*
   * Eligible by the workflow's own rule, the one `decide` gates on, and not by
   * a label name the engine used to hard-code: it names none now.
   */
  // Reads decide nothing: an item the workflow turns away is still shown, as no workflow's and why.
  it("reports eligibility by the workflow's own rule, and an item it turns away as no workflow's, with its reason", async () => {
    const { tools } = world([{ number: 3, labels: ["lr:auto"] }, { number: 4, labels: ["lr:fast"] }]);
    expect(await tools.status("3")).toMatchObject({ eligible: true });
    expect(await tools.status("4")).toMatchObject({
      item: "4", workflow: null, closed: null, eligible: false, why: "claimed by no workflow: no lr:auto label",
    });
  });

  /*
   * A closed item no open parent keeps in the listing is past its window, and
   * one tracker is the only place it can be: it is read there.
   */
  it("reports a closed item the tracker no longer lists, through the workspace's one source", async () => {
    const { tools } = world([{ number: 5, state: "closed", stateReason: "COMPLETED", labels: ["lr:auto"] }]);
    const closed = await tools.status("5");
    expect(closed).toMatchObject({ item: "5", closed: "done", workflow: null });
    expect(closed).not.toHaveProperty("eligible");
  });

  /*
   * Claims are per id, so one tracker's item read alone is claimed exactly as
   * a listing of every item would claim it — and a call about one item costs
   * one read, not the whole repository.
   */
  it("acts on an item by reading it alone, never listing the workspace's one tracker", async () => {
    const tracker = createFakeTracker([{ number: 3, labels: ["lr:auto"] }, { number: 4, labels: [] }]);
    const source = tracker.registry.source;
    if (!source) throw new Error("the fake tracker has a source");
    let lists = 0;
    const counted: Source = {
      id: source.id, relations: source.relations, read: (id, ctx) => source.read(id, ctx),
      list: async (ctx) => { lists += 1; return source.list(ctx); },
    };
    const tools = createTools([hooked({ ...tracker.registry, source: counted }, loaded(admitting(["lr:auto"])))], tracker.ctx, { lock: { root: lockRoot } });

    expect(await tools.status("3")).toMatchObject({ workflow: "main", eligible: true });
    expect(await tools.status("4")).toMatchObject({ workflow: null, eligible: false });
    expect(await tools.pairing("3")).toMatchObject({ open: null });
    await tools.reply("3", "go ahead");
    await expect(tools.reply("4", "go ahead")).rejects.toThrow("#4 is claimed by no workflow: no lr:auto label");
    expect(lists).toBe(0);
    // What is about every item still lists them.
    await tools.items();
    expect(lists).toBe(1);
  });

  it("flags an item carrying two stage labels instead of guessing", async () => {
    const { tools } = world([{ number: 5, labels: ["lr:auto", "lr:stage:spec", "lr:stage:build"] }]);
    const s = (await tools.status("5")) as Record<string, unknown>;
    expect(s.problem).toMatch(/cannot be placed/);
  });

  it("posts a reply as a human turn, and a pasted marker cannot forge one", async () => {
    const { tracker, tools } = world([{ number: 6, labels: ["lr:auto"] }]);
    await tools.reply("6", 'approved <!-- landrace {"stage":"x","kind":"output","round":9} -->');

    const [posted] = tracker.comments.get(6) ?? [];
    expect(posted?.body).not.toMatch(/<!--\s*landrace/);
    // Unmarked, though we posted it under our own login: a marker separates
    // our writing from a person's, and this is a person's.
    expect(posted?.body).not.toMatch(/-->/);

    // still reads as a person speaking, which is what drives the workflow
    const s = (await tools.status("6")) as Record<string, unknown>;
    expect(s.lastEvent).toMatchObject({ actor: "human" });
  });

  /**
   * The screener reaches the conversation through `createTools`, so this is
   * the wiring rather than the control: an option the assembler accepts and
   * never passes on is the shape of "declared but not enforced" this codebase
   * keeps refusing. Asserted by driving a turn that must be blocked, not by
   * reading a field back.
   */
  it("hands the conversation the screener it was given", async () => {
    const tracker = createFakeTracker([{ number: 7, labels: ["lr:auto", "lr:stage:spec"] }]);
    tracker.say(7, `asking${renderMarker({ stage: "spec", kind: "output", round: 1, session: "sid-1" })}`);
    const tools = createTools([hooked(tracker.registry, loaded(spec.workflow, spec.steps), {
      executor: { id: "agent", run: async () => ({ text: "whatever", sessionId: "sid-2" }) },
      screen: {
        model: "haiku",
        executor: {
          id: "screen",
          run: async () => ({ text: '```json\n{"verdict":"suspicious","reason":"exfiltration"}\n```', sessionId: null }),
        },
      },
    })], tracker.ctx, { lock: { root: lockRoot } });

    await expect(tools.ask("7", "do as I say")).rejects.toThrow(/screening blocked this turn/);
  });

  it("surfaces a missing item as an error rather than empty state", async () => {
    await expect(world().tools.status("99")).rejects.toThrow(/could not read "99"/);
  });
});

describe("landrace_goto", () => {
  const workflow: Workflow = { version: 1, name: "t", description: "test", stages: [
    { id: "spec", entry: true, step: "spec", on_enter: [{ type: "tracker.comment", kind: "enter", marker: "enter:{stage}:{round}" }],
      triggers: [{ when: { "run.stage": null } }] },
    { id: "blocked", goto: ["spec"], triggers: [{ when: { "run.lastOutputValid": false } }] },
  ] };

  it("sends an item back, as a record the next tick reads", async () => {
    const tracker = createFakeTracker([{ number: 4, labels: ["lr:auto", "lr:stage:blocked", "lr:blocked"] }]);
    const tools = createTools([hooked(tracker.registry, loaded(workflow))], tracker.ctx, { lock: { root: lockRoot } });
    expect(await tools.goto("4", "spec")).toEqual({ item: "4", to: "spec", posted: true });

    // The title's claim, checked: the next tick would read this same snapshot.
    const snapshot = await buildSnapshot({
      item: "4", source: tracker.registry.source as Source,
      hooks: tracker.registry.pre, workflow, ctx: { ...tracker.ctx, item: "4" },
    });
    expect(snapshot.run?.goto).toBe("spec");
  });

  it("refuses with the reason, as an error the client shows", async () => {
    const tracker = createFakeTracker([{ number: 4, labels: ["lr:auto", "lr:stage:blocked", "lr:blocked"] }]);
    const tools = createTools([hooked(tracker.registry, loaded(workflow))], tracker.ctx, { lock: { root: lockRoot } });
    await expect(tools.goto("4", "build")).rejects.toThrow(/"blocked" sends an item only to "spec", not to "build"/);
  });

  // The same lock the conversation takes, where this process was told the
  // locks live — the loop's, so a goto waits on the tick that would take it.
  it("takes the item's lock where this process's locks live, and says so when it is held", async () => {
    const tracker = createFakeTracker([{ number: 4, labels: ["lr:auto", "lr:stage:blocked", "lr:blocked"] }]);
    const tools = createTools([hooked(tracker.registry, loaded(workflow))], tracker.ctx, { lock: { root: lockRoot, waitMs: 50 } });
    await acquire("4", "tick", { root: lockRoot, holder: "tick:9" });
    try {
      await expect(tools.goto("4", "spec")).rejects.toThrow("#4 is busy; try again in a moment");
    } finally {
      await release("4", { root: lockRoot });
    }
  });

});

/*
 * The operator plane's half of a clearance: a person, here, deciding a
 * refused step may run once without the screener. Never a reply's to make.
 */
describe("landrace_clear", () => {
  const workflow: Workflow = { version: 1, name: "t", description: "test", stages: [
    { id: "spec", entry: true, step: "spec", on_enter: [{ type: "tracker.comment", kind: "enter", marker: "enter:{stage}:{round}" }],
      triggers: [{ when: { "run.stage": null } }] },
    { id: "screened", goto: ["spec"], triggers: [{ when: { "run.lastOutputValid": false } }] },
  ] };
  const refused = (labels: string[]) => {
    const tracker = createFakeTracker([{ number: 4, labels: ["lr:auto", ...labels] }]);
    tracker.say(4, `entered${renderMarker({ stage: "spec", kind: "enter", round: 1 })}`);
    tracker.say(4, `refused${renderMarker({ stage: "spec", kind: "refused", round: 1 })}`);
    return tracker;
  };
  const runOf = async (tracker: ReturnType<typeof refused>) => (await buildSnapshot({
    item: "4", source: tracker.registry.source as Source, hooks: tracker.registry.pre, workflow, ctx: { ...tracker.ctx, item: "4" },
  })).run;

  it("clears the refused step's next round and sends the item back to it", async () => {
    const tracker = refused(["lr:stage:screened", "lr:blocked", "lr:screened"]);
    const tools = createTools([hooked(tracker.registry, loaded(workflow))], tracker.ctx, { lock: { root: lockRoot } });
    expect(await tools.clear("4")).toEqual({ item: "4", to: "spec", cleared: true, posted: true });
    expect((await runOf(tracker))?.cleared).toEqual({ stage: "spec", round: 2 });
  });

  it("refuses, as an error the client shows, where no security check stopped the item", async () => {
    const tracker = refused(["lr:stage:screened", "lr:blocked"]);
    const tools = createTools([hooked(tracker.registry, loaded(workflow))], tracker.ctx, { lock: { root: lockRoot } });
    await expect(tools.clear("4")).rejects.toThrow(/not stopped by a security check/);
  });
});

/**
 * A write through the MCP tells a running loop at once, rather than leaving
 * the person who made it to wait out the interval. After the write only: a
 * throw wrote nothing a pass could pick up.
 */
describe("waking the loop", () => {
  const workflow: Workflow = { version: 1, name: "t", description: "test", admit: ["lr:auto"], stages: [
    { id: "spec", entry: true, step: "spec", on_enter: [{ type: "tracker.comment", kind: "enter", marker: "enter:{stage}:{round}" }],
      triggers: [{ when: { "run.stage": null } }] },
    { id: "blocked", goto: ["spec"], triggers: [{ when: { "run.lastOutputValid": false } }] },
  ] };

  /** An item a step has spoken on, with a session a turn can join. */
  const asked = () => {
    const tracker = createFakeTracker([{ number: 1, labels: ["lr:auto", "lr:stage:spec", "lr:awaiting"] }]);
    tracker.say(1, `Here are my questions.${renderMarker({ stage: "spec", kind: "output", round: 1, session: "sid-1" })}`);
    return tracker;
  };

  const woken = (tracker = createFakeTracker([{ number: 4, labels: ["lr:auto", "lr:stage:blocked", "lr:blocked"] }])) => {
    const wake = jest.fn();
    const tools = createTools([hooked(tracker.registry, loaded(workflow, spec.steps), {
      executor: { id: "agent", run: async () => ({ text: "Understood.", sessionId: "sid-2" }) },
    })], tracker.ctx, { lock: { root: lockRoot }, wake });
    return { wake, tools };
  };

  it.each([
    ["landrace_create_item", () => woken(), (t: Tools) => t.createItem({ title: "Add CSV export" })],
    ["landrace_update_item", () => woken(), (t: Tools) => t.updateItem("4", { title: "Renamed" })],
    ["landrace_reply", () => woken(), (t: Tools) => t.reply("4", "go ahead")],
    ["landrace_goto", () => woken(), (t: Tools) => t.goto("4", "spec")],
    ["landrace_clear", () => woken(createFakeTracker([{ number: 4, labels: ["lr:auto", "lr:stage:blocked", "lr:blocked", "lr:screened"] }])),
      (t: Tools) => t.clear("4", "spec")],
    ["landrace_ask", () => woken(asked()), (t: Tools) => t.ask("1", "B2B only")],
    ["landrace_resolve", () => woken(asked()), (t: Tools) => t.resolve("1")],
  ])("%s wakes the loop once its write succeeds", async (_name, make, call) => {
    const { wake, tools } = make();
    await call(tools);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("does not wake the loop when the write throws, nor for a read", async () => {
    const { wake, tools } = woken();
    await expect(tools.updateItem("4", { addLabels: ["lr:stage:done"] })).rejects.toThrow(/workflow's own state/);
    await expect(tools.goto("4", "build")).rejects.toThrow(/only to "spec"/);
    await tools.waiting();
    await tools.status("4");
    expect(wake).not.toHaveBeenCalled();
  });

  it("still answers when waking fails, because the write has already happened", async () => {
    const tracker = createFakeTracker([{ number: 6 }]);
    const logged: string[] = [];
    const tools = createTools([hooked(tracker.registry)], { ...tracker.ctx, log: (event) => logged.push(event) }, {
      wake: () => { throw new Error("ENOSPC"); },
    });
    expect(await tools.reply("6", "go ahead")).toEqual({ item: "6", posted: true });
    expect(tracker.comments.get(6)).toHaveLength(1);
    expect(logged).toContain("wake.failed");
  });
});

/**
 * An operator hook is optional, and the two tools that need one have to say so
 * when it is missing: a crash hands an editor a stack trace, and a silent
 * success is worse than either.
 */
describe("with no operator hook configured", () => {
  const empty: Registry = {
    preflights: [], pre: [], post: [], artifacts: [], source: null, operator: null, executors: new Map(), notifiers: new Map(),
  };
  const tools = () => createTools([hooked(empty)], createFakeTracker().ctx);

  it("reports that creating an item is not configured, and what to do about it", async () => {
    await expect(tools().createItem({ title: "x" })).rejects.toThrow(/no operator hook is configured/);
    await expect(tools().createItem({ title: "x" })).rejects.toThrow(/defineOperator/);
  });

  it("reports that updating an item is not configured", async () => {
    await expect(tools().updateItem("1", { title: "x" })).rejects.toThrow(/no operator hook is configured/);
  });

  it("reports that there is nothing to enumerate rather than an empty list", async () => {
    await expect(tools().waiting()).rejects.toThrow(/no source hook is configured/);
  });
});

/*
 * One MCP over every workflow. An item is acted on through the workflow that
 * claims it, found by listing every source as a tick does — never through
 * whichever workflow comes first. An item two workflows claim, two sources
 * report, or none claims is refused with the reason, and nothing is written.
 */
describe("over a workspace of two workflows", () => {
  /** Eligible on, and admitting with, `label`; its blocked stage sends an item back to `sends`. */
  const flow = (id: string, name: string, label: string, sends: string[]): LoadedWorkflow => loaded({
    version: 1, name, description: `the ${name} flow`, admit: [label],
    eligible: [{ when: { "node.state.labels": { $in: [label] } }, else: `no ${label} label` }],
    stages: [
      { id: "spec", entry: true, step: "spec", on_enter: [{ type: "tracker.comment", kind: "enter", marker: "enter:{stage}:{round}" }],
        triggers: [{ when: { "run.stage": null } }] },
      { id: "questions", waits: "person", triggers: [{ when: { "run.stage": "spec", "run.outputs.spec.kind": "questions" } }] },
      { id: "blocked", goto: sends, triggers: [{ when: { "run.lastOutputValid": false } }] },
    ],
  }, spec.steps, id);
  const MAIN = flow("main", "Main", "lr:auto", []);
  const FAST = flow("fast", "Fastlane", "lr:fast", ["spec"]);

  /** Each workflow's agent says whose it is, so a turn shows which workflow held it. */
  const says = (who: string): Executor => ({ id: who, run: async () => ({ text: `from ${who}`, sessionId: "sid-2" }) });

  const SEED: Array<Partial<FakeIssue>> = [
    { number: 1, labels: ["lr:auto", "lr:stage:spec"] },
    { number: 2, labels: ["lr:fast", "lr:stage:questions"] },
    { number: 3, labels: ["lr:auto", "lr:fast", "lr:awaiting"] },
    { number: 4, labels: [] },
    { number: 5, labels: ["lr:fast", "lr:stage:blocked", "lr:blocked"] },
    { number: 6, labels: ["lr:auto", "lr:stage:blocked", "lr:blocked"] },
    { number: 8, parent: 1, state: "closed", stateReason: "NOT_PLANNED", labels: ["lr:auto", "lr:stage:spec"] },
  ];

  /** Both workflows on one tracker, as two workflows loading one hook module are. */
  const two = (opts: { scope?: string; mainRegistry?: (r: Registry) => Registry } = {}) => {
    const tracker = createFakeTracker(SEED);
    tracker.say(2, `questions${renderMarker({ stage: "spec", kind: "output", round: 1, session: "sid-1" })}`);
    const tools = createTools([
      hooked(opts.mainRegistry?.(tracker.registry) ?? tracker.registry, MAIN, { executor: says("main") }),
      hooked(tracker.registry, FAST, { executor: says("fast") }),
    ], tracker.ctx, { lock: { root: lockRoot }, ...(opts.scope ? { scope: opts.scope } : {}) });
    return { tracker, tools };
  };

  it("lists each workflow with how many items it claims and how many need you", async () => {
    expect(await two().tools.workflows()).toEqual([
      { id: "main", name: "Main", description: "the Main flow", creates: true, claimed: 2, needsYou: 1 },
      { id: "fast", name: "Fastlane", description: "the Fastlane flow", creates: true, claimed: 2, needsYou: 2 },
    ]);
  });

  it("lists every claimed item with its workflow, stage and lane, and every halt with why", async () => {
    expect(await two().tools.items()).toEqual([
      { item: "1", title: "issue 1", workflow: "main", stage: "spec", lane: "waiting" },
      { item: "2", title: "issue 2", workflow: "fast", stage: "questions", lane: "needs-you" },
      { item: "3", title: "issue 3", workflow: null, stage: null, lane: "needs-you", why: "halted: claimed by fast and main" },
      { item: "5", title: "issue 5", workflow: "fast", stage: "blocked", lane: "needs-you" },
      { item: "6", title: "issue 6", workflow: "main", stage: "blocked", lane: "needs-you" },
    ]);
  });

  // A halt fast is party to is fast's to see: the conflict on #3 names it.
  it("lists one workflow's items and the halts it is party to when asked, and refuses a workflow it does not have", async () => {
    const { tools } = two();
    expect((await tools.items({ workflow: "fast" })).map((i) => i.item)).toEqual(["2", "3", "5"]);
    expect((await tools.items({ workflow: "main" })).map((i) => i.item)).toEqual(["1", "3", "6"]);
    await expect(tools.items({ workflow: "nope" })).rejects.toThrow('no workflow "nope"; the workspace has main, fast');
  });

  // Every item the board files under Needs you: a person's turn, a halt and a block.
  it("lists what waits on you with each item's workflow, and one workflow's alone when asked", async () => {
    const { tools } = two();
    expect(await tools.waiting()).toEqual([
      { item: "2", title: "issue 2", url: expect.stringContaining("/2"), workflow: "fast" },
      { item: "3", title: "issue 3", url: expect.stringContaining("/3"), workflow: null, why: "halted: claimed by fast and main" },
      { item: "5", title: "issue 5", url: expect.stringContaining("/5"), workflow: "fast" },
      { item: "6", title: "issue 6", url: expect.stringContaining("/6"), workflow: "main" },
    ]);
    expect((await tools.waiting({ workflow: "fast" })).map((w) => w.item)).toEqual(["2", "3", "5"]);
    expect((await tools.waiting({ workflow: "main" })).map((w) => w.item)).toEqual(["3", "6"]);
  });

  it("refuses to create an item without a workflow when two can create, naming them, and creates nothing", async () => {
    const { tracker, tools } = two();
    await expect(tools.createItem({ title: "Hotfix" })).rejects.toThrow(/which workflow\? main, fast/);
    expect(tracker.issues.size).toBe(SEED.length);
  });

  it("creates an item in the workflow named, started with that workflow's admit labels", async () => {
    const { tools } = two();
    const r = (await tools.createItem({ workflow: "fast", title: "Hotfix" })) as Record<string, unknown>;
    expect(r).toMatchObject({ workflow: "fast", started: true });
    expect(r.labels).toContain("lr:fast");
    expect(r.labels).not.toContain("lr:auto");
  });

  it("refuses a workflow the workspace does not have, naming those it does, and creates nothing", async () => {
    const { tracker, tools } = two();
    await expect(tools.createItem({ workflow: "nope", title: "Hotfix" })).rejects.toThrow('no workflow "nope"; the workspace has main, fast');
    expect(tracker.issues.size).toBe(SEED.length);
  });

  it("creates in the one workflow that can when none is named, and says which can", async () => {
    const { tools } = two({ mainRegistry: (r) => ({ ...r, operator: null }) });
    expect(await tools.workflows()).toEqual([expect.objectContaining({ id: "main", creates: false }), expect.objectContaining({ id: "fast", creates: true })]);
    expect(await tools.createItem({ title: "Hotfix" })).toMatchObject({ workflow: "fast", labels: expect.arrayContaining(["lr:fast"]) });
  });

  it("reads an item through the workflow that claims it", async () => {
    const { tools } = two();
    expect(await tools.status("2")).toMatchObject({ item: "2", workflow: "fast", eligible: true, stage: "questions" });
    expect(await tools.status("1")).toMatchObject({ item: "1", workflow: "main", eligible: true });
  });

  it("reads a closed item through the one source that lists it, as no workflow's, and writes nothing to it", async () => {
    const { tracker, tools } = two();
    const closed = await tools.status("8");
    expect(closed).toMatchObject({ item: "8", closed: "dropped", workflow: null });
    expect(closed).not.toHaveProperty("eligible");
    await expect(tools.reply("8", "reopen this")).rejects.toThrow("#8 is closed, so nothing is written to it");
    expect(tracker.comments.get(8) ?? []).toEqual([]);
  });

  // Two trackers, and neither lists it: either could be the one it is in.
  it("refuses an id no source lists, where there are two it could be in", async () => {
    const github = createFakeTracker([{ number: 1, labels: ["lr:auto"] }]);
    const other = createFakeTracker([{ number: 2, labels: ["lr:fast"] }]);
    const tools = createTools([hooked(github.registry, MAIN), hooked(other.registry, FAST)], github.ctx, { lock: { root: lockRoot } });
    await expect(tools.status("99")).rejects.toThrow("#99 is not an item any source lists");
    await expect(tools.pairing("99")).rejects.toThrow("#99 is not an item any source lists");
  });

  it("refuses an id its one tracker cannot read, with the tracker's reason", async () => {
    await expect(two().tools.status("99")).rejects.toThrow(/could not read "99"/);
  });

  // Main's blocked stage sends nowhere and fast's sends to spec: which one
  // answered says which workflow the item was routed through.
  it("sends an item back by the stages of the workflow that claims it", async () => {
    const { tools } = two();
    expect(await tools.goto("5", "spec")).toEqual({ item: "5", to: "spec", posted: true });
    await expect(tools.goto("6", "spec")).rejects.toThrow(/"blocked" sends an item to no step/);
  });

  it("holds a turn with the agent of the workflow that claims the item", async () => {
    const { tools } = two();
    expect(await tools.ask("2", "B2B only")).toMatchObject({ reply: "from fast" });
  });

  /** What reads an item: refused only where two trackers report it. */
  const reads: Array<[string, (t: Tools, item: string) => Promise<unknown>]> = [
    ["landrace_status", (t, i) => t.status(i)],
    ["landrace_pair without a stage", (t, i) => t.pairing(i)],
  ];
  /** What writes the workflow's own state: its owner's alone, and only while every source lists. */
  const stateWrites: Array<[string, (t: Tools, item: string) => Promise<unknown>]> = [
    ["landrace_reply", (t, i) => t.reply(i, "go ahead")],
    ["landrace_goto", (t, i) => t.goto(i, "spec")],
    ["landrace_clear", (t, i) => t.clear(i)],
    ["landrace_ask", (t, i) => t.ask(i, "carry on")],
    ["landrace_resolve", (t, i) => t.resolve(i)],
    ["landrace_pair", (t, i) => t.pair(i, "spec")],
    ["landrace_finish", (t, i) => t.finish(i)],
    ["landrace_release", (t, i) => t.release(i)],
  ];
  const calls: Array<[string, (t: Tools, item: string) => Promise<unknown>]> = [
    ...reads, ["landrace_update_item", (t, i) => t.updateItem(i, { title: "Renamed" })], ...stateWrites,
  ];

  it.each(stateWrites)("%s refuses an item two workflows claim, naming both, and writes nothing", async (_name, call) => {
    const { tracker, tools } = two();
    await expect(call(tools, "3")).rejects.toThrow("#3 is claimed by fast and main; act on it after one workflow alone claims it");
    expect(tracker.comments.get(3) ?? []).toEqual([]);
    expect(tracker.issues.get(3)).toMatchObject({ title: "issue 3", labels: ["lr:auto", "lr:fast", "lr:awaiting"] });
  });

  it.each(stateWrites)("%s refuses an item no workflow claims, with each workflow's reason, and writes nothing", async (_name, call) => {
    const { tracker, tools } = two();
    await expect(call(tools, "4")).rejects.toThrow("#4 is claimed by no workflow: no lr:auto label; no lr:fast label");
    expect(tracker.comments.get(4) ?? []).toEqual([]);
    expect(tracker.issues.get(4)).toMatchObject({ title: "issue 4", labels: [] });
  });

  // Reads decide nothing: an item one tracker lists is read there, whoever claims it.
  it("reads an item two workflows claim, and one none claims, through the one source that lists it, as no workflow's", async () => {
    const { tools } = two();
    expect(await tools.status("3")).toMatchObject({ item: "3", workflow: null, eligible: false, why: "claimed by fast and main", waitingOnYou: true });
    expect(await tools.status("4")).toMatchObject({ item: "4", workflow: null, eligible: false, why: "claimed by no workflow: no lr:auto label; no lr:fast label" });
    expect(await tools.pairing("3")).toEqual({ open: null, offers: [] });
    expect(await tools.pairing("4")).toEqual({ open: null, offers: [] });
  });

  /*
   * Both workflows load one hook module, so they edit through one operator:
   * an edit of an item neither owns goes through it, and is no pick.
   */
  it("edits an item two workflows claim, and one none claims, through the one operator they share", async () => {
    const { tracker, tools } = two();
    expect(await tools.updateItem("3", { title: "Split in two", addLabels: ["bug"] })).toMatchObject({ item: "3", title: "Split in two", workflow: null });
    expect(tracker.issues.get(3)?.labels).toEqual(["lr:auto", "lr:fast", "lr:awaiting", "bug"]);
    expect(await tools.updateItem("4", { title: "Renamed" })).toMatchObject({ item: "4", title: "Renamed", workflow: null });
    expect(await tools.updateItem("8", { state: "open" })).toMatchObject({ item: "8", workflow: null });
    expect(tracker.issues.get(8)?.state).toBe("open");
  });

  it("refuses to edit an item no one workflow owns where its workflows edit through different operators, naming them", async () => {
    const { tracker, tools } = two({
      mainRegistry: (r) => {
        const shared = r.operator;
        if (!shared) throw new Error("the fake tracker has an operator");
        return { ...r, operator: { ...shared, id: "own" } };
      },
    });
    for (const id of ["3", "4"]) {
      await expect(tools.updateItem(id, { title: "Renamed" })).rejects.toThrow(`and fast and main edit items through different operators; edit it in its tracker`);
    }
    await expect(tools.updateItem("4", { title: "Renamed" })).rejects.toThrow(
      "#4 is claimed by no workflow: no lr:auto label; no lr:fast label, and fast and main edit items through different operators; edit it in its tracker",
    );
    expect(tracker.issues.get(4)?.title).toBe("issue 4");
    // An owned item is its owner's operator's to edit, as it always was.
    expect(await tools.updateItem("1", { title: "Renamed" })).toMatchObject({ item: "1", workflow: "main" });
  });

  it("relates an item through the operator of the workflow that claims it, and only that one", async () => {
    const asked: string[] = [];
    const { tracker, tools } = two({
      mainRegistry: (r) => {
        const shared = r.operator;
        if (!shared) throw new Error("the fake tracker has an operator");
        return {
          ...r,
          operator: {
            ...shared, id: "own",
            checkRelate: async (i, t, o, ctx) => { asked.push(`check ${i} ${o}`); return shared.checkRelate(i, t, o, ctx); },
            relate: async (i, t, o, ctx) => { asked.push(`relate ${i} ${o}`); return shared.relate(i, t, o, ctx); },
          },
        };
      },
    });
    await tools.updateItem("1", { relate: [{ type: "blocked-by", item: "6" }] });
    await tools.updateItem("2", { relate: [{ type: "blocked-by", item: "5" }] });
    // #1 is main's, through its own operator; #2 is fast's, through the shared one, which main's never hears of.
    expect(asked).toEqual(["check 1 6", "relate 1 6"]);
    expect(tracker.issues.get(1)?.blockedBy).toEqual([6]);
    expect(tracker.issues.get(2)?.blockedBy).toEqual([5]);
  });

  /*
   * A read through a source, rather than through one workflow, is made with
   * the pre hooks every workflow on it loads. Two that share none would read
   * it with nothing — an empty history said as if it were the item's.
   */
  it("refuses to read through a source whose workflows share no pre hook, naming them", async () => {
    const other = { id: "other", run: () => ({}) };
    const { tools } = two({ mainRegistry: (r) => ({ ...r, pre: [other] }) });
    await expect(tools.status("4")).rejects.toThrow(
      "#4 cannot be read here: the workflows reading its source, fast and main, load no pre hook in common, and a read with none would leave out what each of them reads",
    );
    // Its owner's own pre hooks read an owned item, as they always have.
    expect(await tools.status("2")).toMatchObject({ workflow: "fast" });
  });

  it.each(calls)("%s refuses an id two sources both report, naming the workflows reading them, and writes nothing", async (_name, call) => {
    const github = createFakeTracker([{ number: 7, labels: ["lr:auto"] }]);
    const other = createFakeTracker([{ number: 7, labels: ["lr:fast"] }]);
    const tools = createTools([hooked(github.registry, MAIN, { executor: says("main") }), hooked(other.registry, FAST, { executor: says("fast") })],
      github.ctx, { lock: { root: lockRoot } });
    await expect(call(tools, "7")).rejects.toThrow("#7 is reported by the sources of fast and main");
    for (const t of [github, other]) {
      expect(t.comments.get(7) ?? []).toEqual([]);
      expect(t.issues.get(7)?.title).toBe("issue 7");
    }
  });

  // A clash with a source that could not list cannot be ruled out, so nothing
  // is listed or acted on until it lists again — as `landrace status` refuses.
  it("refuses to list or act while a source cannot list, naming it", async () => {
    const tracker = createFakeTracker(SEED);
    const down: Source = {
      id: "down", relations: [],
      list: async () => { throw new Error("tracker down"); },
      read: async () => { throw new Error("tracker down"); },
    };
    const tools = createTools([hooked(tracker.registry, MAIN), hooked({ ...tracker.registry, source: down }, FAST)], tracker.ctx, { lock: { root: lockRoot } });
    await expect(tools.items()).rejects.toThrow("could not list the source of fast: tracker down");
    await expect(tools.reply("1", "go ahead")).rejects.toThrow("could not list the source of fast: tracker down");
    await expect(tools.updateItem("1", { title: "Renamed" })).rejects.toThrow("could not list the source of fast: tracker down");
    expect(tracker.comments.get(1) ?? []).toEqual([]);
    expect(tracker.issues.get(1)?.title).toBe("issue 1");
  });

  /*
   * Reads decide nothing, so they still go where the sources that did list
   * say — but an id none of them showed could be in the one that did not.
   */
  it("still reads what a working source lists while another cannot list, and nothing it did not", async () => {
    const tracker = createFakeTracker(SEED);
    const down: Source = {
      id: "down", relations: [],
      list: async () => { throw new Error("tracker down"); },
      read: async () => { throw new Error("tracker down"); },
    };
    const tools = createTools([hooked(tracker.registry, MAIN), hooked({ ...tracker.registry, source: down }, FAST)], tracker.ctx, { lock: { root: lockRoot } });
    expect(await tools.status("1")).toMatchObject({ item: "1", workflow: "main" });
    await expect(tools.status("99")).rejects.toThrow("#99 is not an item any source lists; could not list the source of fast: tracker down");
  });

  /*
   * `landrace mcp --workflow fast` — the server a pairing hands the person's
   * session: it acts for that workflow alone. Claims are still judged over
   * every workflow, so an item fast shares with main is refused here too.
   */
  describe("bound to one workflow", () => {
    // A pairing's session sees a conflict its own workflow is party to.
    it("lists that workflow alone, and the halts it is party to", async () => {
      const { tools } = two({ scope: "fast" });
      expect((await tools.workflows()).map((w) => w.id)).toEqual(["fast"]);
      expect((await tools.items()).map((i) => i.item)).toEqual(["2", "3", "5"]);
      expect((await tools.items()).find((i) => i.item === "3")).toMatchObject({ workflow: null, why: "halted: claimed by fast and main" });
      expect((await tools.waiting()).map((w) => w.item)).toEqual(["2", "3", "5"]);
    });

    it("does not list a halt it is no party to", async () => {
      const tracker = createFakeTracker([
        { number: 1, labels: ["lr:auto", "lr:slow", "lr:awaiting"] },
        { number: 2, labels: ["lr:fast", "lr:slow", "lr:awaiting"] },
      ]);
      const tools = createTools([hooked(tracker.registry, MAIN), hooked(tracker.registry, FAST), hooked(tracker.registry, flow("slow", "Slow", "lr:slow", []))],
        tracker.ctx, { lock: { root: lockRoot }, scope: "fast" });
      expect((await tools.items()).map((i) => [i.item, i.why])).toEqual([["2", "halted: claimed by fast and slow"]]);
      expect((await tools.waiting()).map((w) => w.item)).toEqual(["2"]);
    });

    it("refuses an item another workflow claims, and one it shares", async () => {
      const { tools } = two({ scope: "fast" });
      await expect(tools.status("1")).rejects.toThrow("#1 belongs to main; this server acts for fast alone");
      await expect(tools.reply("3", "go ahead")).rejects.toThrow("#3 is claimed by fast and main");
      expect(await tools.status("2")).toMatchObject({ workflow: "fast" });
    });

    // Its own operator edits what no workflow claims; what another claims is not its to touch.
    it("edits an item no workflow claims, and refuses one another workflow claims too", async () => {
      const { tracker, tools } = two({ scope: "fast" });
      expect(await tools.updateItem("4", { title: "Renamed" })).toMatchObject({ item: "4", workflow: null });
      await expect(tools.updateItem("3", { title: "Renamed" })).rejects.toThrow("#3 is claimed by fast and main; act on it after one workflow alone claims it");
      expect(tracker.issues.get(3)?.title).toBe("issue 3");
    });

    const writes: Array<[string, (t: Tools, item: string) => Promise<unknown>]> = [
      ["landrace_update_item", (t, i) => t.updateItem(i, { title: "Renamed", addLabels: ["bug"] })],
      ["landrace_update_item relate", (t, i) => t.updateItem(i, { relate: [{ type: "blocked-by", item: "1" }] })],
      ["landrace_reply", (t, i) => t.reply(i, "go ahead")],
      ["landrace_goto", (t, i) => t.goto(i, "spec")],
      ["landrace_clear", (t, i) => t.clear(i, "spec")],
      ["landrace_ask", (t, i) => t.ask(i, "carry on")],
      ["landrace_resolve", (t, i) => t.resolve(i)],
      ["landrace_pair", (t, i) => t.pair(i, "spec")],
      ["landrace_finish", (t, i) => t.finish(i)],
      ["landrace_release", (t, i) => t.release(i)],
    ];

    it.each(writes)("%s refuses an item main claims, and writes nothing", async (_name, call) => {
      const { tracker, tools } = two({ scope: "fast" });
      await expect(call(tools, "6")).rejects.toThrow("#6 belongs to main; this server acts for fast alone");
      expect(tracker.comments.get(6) ?? []).toEqual([]);
      expect(tracker.issues.get(6)).toMatchObject({ title: "issue 6", labels: ["lr:auto", "lr:stage:blocked", "lr:blocked"] });
    });

    // A closed item is no workflow's, so it is its source that says whose it is to read.
    it("reads a closed item only through its own workflow's source", async () => {
      const github = createFakeTracker([{ number: 1, labels: ["lr:auto"] }, { number: 8, parent: 1, state: "closed", stateReason: "NOT_PLANNED" }]);
      const other = createFakeTracker([{ number: 2, labels: ["lr:fast"] }, { number: 9, parent: 2, state: "closed", stateReason: "COMPLETED" }]);
      const tools = createTools([hooked(github.registry, MAIN), hooked(other.registry, FAST)], github.ctx, { lock: { root: lockRoot }, scope: "fast" });
      await expect(tools.status("8")).rejects.toThrow("#8 is not listed by fast's source; this server acts for fast alone");
      await expect(tools.pairing("8")).rejects.toThrow("#8 is not listed by fast's source");
      await expect(tools.updateItem("8", { state: "open" })).rejects.toThrow("#8 is not listed by fast's source; this server acts for fast alone");
      expect(github.issues.get(8)?.state).toBe("closed");
      expect(await tools.status("9")).toMatchObject({ item: "9", closed: "done", workflow: null });
    });

    it("creates in its own workflow unasked, and refuses another", async () => {
      const { tracker, tools } = two({ scope: "fast" });
      expect(await tools.createItem({ title: "Hotfix" })).toMatchObject({ workflow: "fast" });
      await expect(tools.createItem({ workflow: "main", title: "Other" })).rejects.toThrow("this server acts for fast alone, not main");
      await expect(tools.items({ workflow: "main" })).rejects.toThrow("this server acts for fast alone, not main");
      expect(tracker.issues.size).toBe(SEED.length + 1);
    });
  });
});

/*
 * The engine never reads a relationship type: each entry is shaped, checked
 * against what the routed operator writes, and handed to it. A refused entry
 * refuses the whole call before anything is written.
 */
describe("relationships by hand", () => {
  const relating = (writes: string[] = ["blocked-by"]) => {
    const tracker = createFakeTracker([{ number: 4, labels: ["lr:auto"] }, { number: 10 }]);
    const calls: string[] = [];
    const real = tracker.registry.operator;
    if (!real) throw new Error("the fake tracker has an operator");
    const operator = {
      ...real,
      relates: () => writes,
      createItem: async (...a: Parameters<typeof real.createItem>) => { calls.push(`create ${JSON.stringify(a[0].relate ?? null)}`); return real.createItem({ title: a[0].title, labels: a[0].labels, body: a[0].body }, a[1]); },
      updateItem: async (...a: Parameters<typeof real.updateItem>) => { calls.push("update"); return real.updateItem(...a); },
      relate: async (i: string, t: string, o: string) => { calls.push(`relate ${i} ${t} ${o}`); },
      unrelate: async (i: string, t: string, o: string) => { calls.push(`unrelate ${i} ${t} ${o}`); },
      checkRelate: async (i: string, t: string, o: string) => { calls.push(`check ${i} ${t} ${o}`); return null; },
    };
    const tools = createTools([hooked({ ...tracker.registry, operator }, loaded(admitting(["lr:auto"])))], tracker.ctx);
    return { tracker, tools, calls };
  };

  it("hands a created item's relationships to the operator with the item", async () => {
    const { tools, calls } = relating();
    await tools.createItem({ title: "Later", relate: [{ type: "blocked-by", item: "10" }] });
    expect(calls).toEqual(['create [{"type":"blocked-by","item":"10"}]']);
  });

  it("relates and unrelates after the label changes, and reports what it related", async () => {
    const { tools, calls } = relating();
    const r = await tools.updateItem("4", {
      addLabels: ["bug"], relate: [{ type: "blocked-by", item: "10" }], unrelate: [{ type: "blocked-by", item: "9" }],
    });
    expect(calls).toEqual(["check 4 blocked-by 10", "check 4 blocked-by 9", "update", "relate 4 blocked-by 10", "unrelate 4 blocked-by 9"]);
    expect(r).toMatchObject({
      related: [{ type: "blocked-by", item: "10" }], unrelated: [{ type: "blocked-by", item: "9" }],
    });
  });

  it("relates and unrelates each entry once, however often it is asked for", async () => {
    const { tools, calls } = relating();
    const r = await tools.updateItem("4", {
      relate: [{ type: "blocked-by", item: "10" }, { type: "blocked-by", item: "10" }],
      unrelate: [{ type: "blocked-by", item: "9" }, { type: "blocked-by", item: "9" }],
    });
    expect(calls).toEqual(["check 4 blocked-by 10", "check 4 blocked-by 9", "update", "relate 4 blocked-by 10", "unrelate 4 blocked-by 9"]);
    expect(r).toMatchObject({ related: [{ type: "blocked-by", item: "10" }], unrelated: [{ type: "blocked-by", item: "9" }] });
  });

  it("refuses a type its tracker does not write, naming the ones it does, and writes nothing", async () => {
    const { tracker, tools, calls } = relating();
    const before = tracker.issues.size;
    await expect(tools.createItem({ title: "x", relate: [{ type: "x", item: "10" }] })).rejects.toThrow(
      'cannot relate a new item to #10 as "x": this workflow\'s tracker writes only "blocked-by"',
    );
    await expect(tools.updateItem("4", { addLabels: ["bug"], relate: [{ type: "x", item: "10" }] })).rejects.toThrow(
      'cannot relate #4 to #10 as "x": this workflow\'s tracker writes only "blocked-by"',
    );
    await expect(tools.updateItem("4", { unrelate: [{ type: "x", item: "10" }] })).rejects.toThrow(/writes only "blocked-by"/);
    expect(calls).toEqual([]);
    expect(tracker.issues.size).toBe(before);
    expect(tracker.issues.get(4)?.labels).toEqual(["lr:auto"]);
  });

  it("refuses an entry that is a self-relation, or an unusable id, or any type from a tracker that writes none, writing nothing", async () => {
    const { tools, calls } = relating();
    await expect(tools.updateItem("4", { relate: [{ type: "blocked-by", item: "10" }, { type: "blocked-by", item: "4" }] }))
      .rejects.toThrow('cannot relate #4 to itself as "blocked-by"');
    await expect(tools.createItem({ title: "x", relate: [{ type: "blocked-by", item: "../1" }] })).rejects.toThrow(/not a usable item id/);
    const none = relating([]);
    await expect(none.tools.updateItem("4", { relate: [{ type: "blocked-by", item: "10" }] })).rejects.toThrow(/writes no relationship/);
    expect(calls).toEqual([]);
    expect(none.calls).toEqual([]);
  });
});

/*
 * What only the tracker can tell — whether the other end is an item it may
 * relate at all — is asked of it for every entry of both lists before the
 * first write, labels included. Through the real GitHub integration over its
 * fake, and over the in-memory tracker: a refused entry leaves the item
 * exactly as it was, and wakes nothing.
 */
describe("relationships by hand, asked of the tracker before anything is written", () => {
  const github = () => {
    const tracker = createFakeTracker([
      { number: 4, labels: ["lr:auto"], blockedBy: [9] }, { number: 9 }, { number: 10 }, { number: 11 },
    ]);
    tracker.openPull({ number: 20, head: "feature" });
    const wake = jest.fn();
    const tools = createTools([hooked(tracker.registry, loaded(admitting(["lr:auto"])))], tracker.ctx, { wake });
    return { tracker, tools, wake };
  };
  // Every write the fake heard: a GraphQL query is a POST that writes nothing.
  const writesTo = (tracker: ReturnType<typeof createFakeTracker>) =>
    tracker.requests.filter((r) => r.method !== "GET" && r.path !== "/graphql");

  it.each([
    ["a blocker in another repository", "x.other.api.5", /cannot relate #4 to #x\.other\.api\.5 as "blocked-by": landrace writes relationships only within acme\/widgets/],
    ["a blocker that is no issue", "99", /cannot relate #4 to #99 as "blocked-by": #99 could not be read: .*404/],
    ["a pull request's number", "20", /cannot relate #4 to #20 as "blocked-by": #20 is a pull request, not an issue/],
  ])("refuses %s on GitHub with nothing written, labels included", async (_what, other, refusal) => {
    const { tracker, tools, wake } = github();
    await expect(tools.updateItem("4", {
      addLabels: ["bug"], relate: [{ type: "blocked-by", item: "10" }, { type: "blocked-by", item: other }],
    })).rejects.toThrow(refusal);
    expect(writesTo(tracker)).toEqual([]);
    expect(tracker.issues.get(4)).toMatchObject({ labels: ["lr:auto"], blockedBy: [9] });
    expect(wake).not.toHaveBeenCalled();
  });

  it("refuses an unrelate entry the same way, before the relate entries are written", async () => {
    const { tracker, tools } = github();
    await expect(tools.updateItem("4", {
      relate: [{ type: "blocked-by", item: "10" }], unrelate: [{ type: "blocked-by", item: "x.other.api.5" }],
    })).rejects.toThrow(/cannot unrelate #4 from #x\.other\.api\.5 as "blocked-by": landrace writes relationships only within/);
    expect(writesTo(tracker)).toEqual([]);
  });

  it("names every entry it refuses, not the first alone", async () => {
    const { tools } = github();
    await expect(tools.updateItem("4", {
      relate: [{ type: "blocked-by", item: "99" }, { type: "blocked-by", item: "20" }],
    })).rejects.toThrow(/#99 could not be read[\s\S]*#20 is a pull request/);
  });

  it("says what it wrote and what failed when a write fails partway through the list, and wakes the loop", async () => {
    const { tracker, tools, wake } = github();
    let posts = 0;
    tracker.breakOn((r) => r.method === "POST" && r.path === "/issues/4/dependencies/blocked_by" && ++posts === 2, 500);
    const failed = tools.updateItem("4", {
      addLabels: ["bug"],
      relate: [{ type: "blocked-by", item: "10" }, { type: "blocked-by", item: "11" }],
      unrelate: [{ type: "blocked-by", item: "9" }],
    });
    await expect(failed).rejects.toThrow(
      /^#4 was changed only in part\. Written: its labels and fields, relate blocked-by #10\. Failed: relate blocked-by #11, saying [\s\S]*500[\s\S]* Not tried: unrelate blocked-by #9\.$/,
    );
    expect(tracker.issues.get(4)).toMatchObject({ labels: ["lr:auto", "bug"], blockedBy: [9, 10] });
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("says it left the item as it was when the first write fails and nothing else was asked for", async () => {
    const { tracker, tools, wake } = github();
    tracker.breakOn((r) => r.method === "POST" && r.path === "/issues/4/dependencies/blocked_by", 500);
    await expect(tools.updateItem("4", { relate: [{ type: "blocked-by", item: "10" }] }))
      .rejects.toThrow(/^#4 was left as it was\. Failed: relate blocked-by #10, saying /);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  const memory = () => {
    const state = createExternalState({ items: [{ id: "4", labels: ["lr:auto"] }, { id: "10" }] });
    const registry: Registry = {
      preflights: [], pre: [state.pre], post: [state.post], artifacts: [], source: state.source, operator: state.operator,
      executors: new Map(), notifiers: new Map(),
    };
    const tools = createTools([hooked(registry, loaded(admitting(["lr:auto"])))], { ...createFakeTracker().ctx });
    return { state, tools };
  };

  it.each([
    ["an item it does not hold", "99"],
    ["a pull request", "pr-1"],
  ])("refuses %s in memory, with nothing written", async (_what, other) => {
    const { state, tools } = memory();
    state.openPull("10");
    await expect(tools.updateItem("4", {
      addLabels: ["bug"], relate: [{ type: "blocked-by", item: "10" }, { type: "blocked-by", item: other }],
    })).rejects.toThrow(new RegExp(`cannot relate #4 to #${other} as "blocked-by": #${other} is not one of this tracker's own items`));
    expect(state.writes()).toEqual([]);
    expect(state.item("4").labels).toEqual(["lr:auto"]);
  });

  it("relates in memory once every entry passes", async () => {
    const { state, tools } = memory();
    await tools.updateItem("4", { relate: [{ type: "blocked-by", item: "10" }] });
    expect(state.writes()).toEqual(["relate #4 blocked-by #10"]);
  });
});

describe("landrace_admit", () => {
  const listed = async () => {
    const tracker = createFakeTracker([{ number: 4 }]);
    const server = createMcpServer(createTools([hooked(tracker.registry, loaded(admitting(["lr:auto"])))], tracker.ctx));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return { client, tracker };
  };

  it("is listed with item and workflow, both required, and says what it refuses", async () => {
    const { client } = await listed();
    const tool = (await client.listTools()).tools.find((t) => t.name === "landrace_admit");
    const schema = tool?.inputSchema as { properties: Record<string, unknown>; required?: string[] } | undefined;
    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual(["item", "workflow"]);
    expect([...(schema?.required ?? [])].sort()).toEqual(["item", "workflow"]);
    expect(tool?.description).toMatch(/^Start work on a Not admitted item by admitting it to the workflow/);
    for (const refusal of [/closed/, /already/, /two workflows claim/, /does not list/, /admits nothing/, /another workflow would claim it/]) {
      expect(tool?.description).toMatch(refusal);
    }
    await client.close();
  });

  it("admits through the protocol, answering the labels it added", async () => {
    const { client, tracker } = await listed();
    const r = await client.callTool({ name: "landrace_admit", arguments: { item: "4", workflow: "main" } });
    expect(JSON.parse((r as { content: Array<{ text: string }> }).content[0]?.text ?? "")).toEqual({ item: "4", workflow: "main", labels: ["lr:auto"] });
    expect(tracker.issues.get(4)?.labels).toEqual(["lr:auto"]);
    await client.close();
  });
});
