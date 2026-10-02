import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UNPLACED } from "#core/index.js";
import { defineNotifier } from "#hooks/contracts.js";
import { createTools } from "#mcp/tools.js";
import type {
  Executor, ExternalState, HookContext, NotifyEvent, Registry, RuntimeContext, Source, Step, Workflow, WorkspaceRuntime,
} from "#namespace.js";
import { createDispatcher } from "#runner/effects.js";
import { createLogger } from "#runner/events.js";
import { acquire, release } from "#runner/lock.js";
import { createNotify } from "#runner/notify.js";
import { laneOf, workspaceStatusRows } from "#runner/status.js";
import { listWorkspace, tickWorkspace } from "#runner/tick.js";
import { loadShipped } from "#tests/support/shipped.js";
import { createExternalState } from "#testing/index.js";
import { boardView } from "#ui/board.js";
import { loadWorkflow } from "#workflow/load.js";

/*
 * A workflow placed by an item's own state, over a tracker it may never
 * write: the shape of "merge requests waiting for my review". `reviewing`
 * and `approved` are each where an item's labels say it is, so it comes into
 * Needs you when a review is asked of you and leaves when you approve, and
 * nothing — no position label, no entry record, no lr:working — is written
 * to say so. Driven through the workspace tick, so claims, converge and
 * every surface that reads where an item is are the real ones.
 */

let review: { workflow: Workflow; steps: Map<string, Step> };
beforeAll(async () => {
  review = await loadWorkflow("tests/fixtures/review");
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lr-readonly-"));
});

/** No stage of a read-only workflow runs a step; one that tried would be a defect, said so. */
const nobody: Executor = {
  id: "nobody",
  run: async () => {
    throw new Error("a stage of a read-only workflow ran an agent");
  },
};

/**
 * A workspace of one workflow over `state`, and every surface that says where
 * its items are — a notifier among them, writing down what it is asked to
 * send. Each call is a process of its own: a second over the same state is
 * the engine restarted.
 */
function workspace(
  state: ExternalState, loaded: { workflow: Workflow; steps: Map<string, Step> }, id: string,
  { executor = nobody, source = state.source }: { executor?: Executor; source?: Source } = {},
) {
  const log = createLogger({ sink: () => {} });
  const stop = new AbortController();
  const ctx: RuntimeContext = { config: {} as HookContext["config"], secrets: new Map(), signal: stop.signal, log: () => {} };
  const { workflow, steps } = loaded;
  const sent: NotifyEvent[] = [];
  const chat = defineNotifier({ id: "chat", send: async (e) => { sent.push(e); } });
  const runtime: WorkspaceRuntime = {
    dir: root,
    workflows: [{
      id, name: workflow.name, description: workflow.description, source,
      deps: {
        workflow, steps, source, pre: [state.pre], artifacts: [state.spec], dispatcher: createDispatcher([state.post, state.spec]),
        executor, ctx, log, scrub: (t) => t,
        notify: createNotify({
          id, workflow, notify: { on: ["needs-you"], via: ["chat"] }, notifiers: new Map([["chat", chat]]), ctx, log, board: () => null,
        }),
      },
    }],
    preflights: [], intervalMs: 60_000, concurrency: 2, stop, running: new Map(), seen: new Map(), log, ctx,
  };
  const registry: Registry = {
    preflights: [state.preflight], pre: [state.pre], post: [state.post], artifacts: [], source: state.source,
    operator: state.operator, executors: new Map(), notifiers: new Map(),
  };
  const tools = createTools([{ id, dir: `/w/workflows/${id}`, workflow, steps, registry }], ctx, { lock: { root } });

  return {
    tools,
    tick: () => tickWorkspace({ runtime, lock: { root } }),
    /** What the notifier was asked to send, once every send has had its turn: sends are fire-and-forget. */
    sent: async (): Promise<Array<[item: string, stage: string | null]>> => {
      await new Promise((resolve) => setImmediate(resolve));
      return sent.map((e) => [e.item, e.stage]);
    },
    events: () => sent,
    /** `landrace status`'s row for `item`, with the board's lane for it. */
    row: async (item: string) => {
      const row = workspaceStatusRows(runtime.workflows, await listWorkspace(runtime)).find((r) => r.item === item);
      if (!row) throw new Error(`no status row for #${item}`);
      return { stage: row.stage, note: row.note, workflow: row.workflow, lane: laneOf(row, workflow) };
    },
    /** The board's row for `item`: where it draws it, and in which lane. */
    board: async (item: string) => {
      const view = boardView({
        workflows: [{ id, workflow }], listing: await listWorkspace(runtime), nest: new Set(), running: new Map(),
        elsewhere: new Map(), now: 0, pid: 1, nextTickAt: null, folder: "landrace", workspace: "/repo/landrace",
      });
      const row = view.rows.find((r) => r.id === item);
      return row && { stage: row.stage, badge: row.badge };
    },
  };
}

const requested = () => createExternalState({
  items: [
    { id: "1", title: "Fix the parser", labels: ["review-requested"] },
    { id: "2", title: "Not mine", labels: ["wip"] },
  ],
  readOnly: true,
});

describe("a workflow placed by state alone, over a read-only tracker", () => {
  it("files an item whose review was asked of you under Needs you, tick after tick, and writes nothing", async () => {
    const state = requested();
    const before = structuredClone(state.item("1"));
    const w = workspace(state, review, "review");

    for (let tick = 0; tick < 3; tick++) {
      expect(await w.tick()).toEqual([
        { item: "1", workflow: "review", outcome: "wait after 1 pass(es): no trigger matched" },
        { item: "2", outcome: "skipped: no review was requested" },
      ]);
    }

    expect(await w.row("1")).toEqual({ stage: "reviewing", note: "waiting on you", workflow: "review", lane: "needs-you" });
    expect(await w.board("1")).toEqual({ stage: "reviewing", badge: "needs-you" });
    expect(await w.tools.waiting()).toEqual([
      { item: "1", title: "Fix the parser", url: "memory://items/1", workflow: "review" },
    ]);
    expect(await w.tools.status("1")).toMatchObject({ workflow: "review", stage: "reviewing", waitingOnYou: true, eligible: true });

    expect(state.writes()).toEqual([]);
    expect(state.item("1")).toEqual(before);
  });

  it("discharges it once you approve, and files it again if the approval is taken back, writing nothing either way", async () => {
    const state = requested();
    const w = workspace(state, review, "review");
    await w.tick();

    // A person approves on the tracker: the item's own state, not a write of ours.
    state.label("1", "approved");
    const approved = structuredClone(state.item("1"));
    for (let tick = 0; tick < 2; tick++) {
      expect((await w.tick()).find((r) => r.item === "1")).toEqual(
        { item: "1", workflow: "review", outcome: "wait after 1 pass(es): no trigger matched" });
    }
    expect(await w.row("1")).toMatchObject({ stage: "approved", lane: "discharged" });
    expect(await w.board("1")).toEqual({ stage: "approved", badge: "discharged" });
    expect(await w.tools.waiting()).toEqual([]);
    expect(await w.tools.status("1")).toMatchObject({ stage: "approved", waitingOnYou: false });
    expect(state.item("1")).toEqual(approved);

    state.unlabel("1", "approved");
    await w.tick();
    expect(await w.row("1")).toMatchObject({ stage: "reviewing", lane: "needs-you" });
    expect((await w.tools.waiting()).map((i) => i.item)).toEqual(["1"]);

    expect(state.writes()).toEqual([]);
  });

  it("refuses a stray write out loud, naming the effect, and posts nothing", async () => {
    const state = requested();
    const w = workspace(state, review, "review");
    await w.tick();

    await expect(w.tools.reply("1", "looks good")).rejects.toThrow(
      'post hook "project" failed applying "tracker.comment": this tracker is read-only: comment was asked of #1',
    );
    expect(state.comments("1")).toEqual([]);
    expect(state.writes()).toEqual(["comment #1"]);
  });

  // Identities that leave an item out: nothing places it, and it is not
  // entered anywhere, which would be a write.
  it("halts an item no identity places, saying so, and writes nothing", async () => {
    const gappy: Workflow = { ...review.workflow, stages: [
      { id: "reviewing", waits: "person", identity: { "node.state.labels": { $in: ["mine"] } } },
      { id: "approved", terminal: true, identity: { "node.state.labels": { $in: ["approved"] } } },
    ] };
    const state = requested();
    const w = workspace(state, { workflow: gappy, steps: new Map() }, "review");

    expect((await w.tick()).find((r) => r.item === "1")).toEqual({
      item: "1", workflow: "review",
      outcome: "halt after 1 pass(es): no stage of this workflow places the item: none of its identities match, " +
        "and there is no entry stage to start it at",
    });
    expect(state.writes()).toEqual([]);
  });

  // Each surface that says who is waiting on you says it: the halt is a
  // person's to fix, and read as queued it sat under Waiting for good.
  it("files that halted item under Needs you, on every surface that reads where an item is", async () => {
    const gappy: Workflow = { ...review.workflow, stages: [
      { id: "reviewing", waits: "person", identity: { "node.state.labels": { $in: ["mine"] } } },
      { id: "approved", terminal: true, identity: { "node.state.labels": { $in: ["approved"] } } },
    ] };
    const state = requested();
    const w = workspace(state, { workflow: gappy, steps: new Map() }, "review");
    await w.tick();

    const halted = `halted: ${UNPLACED}`;
    expect(await w.row("1")).toEqual({ stage: null, note: halted, workflow: "review", lane: "needs-you" });
    expect(await w.board("1")).toEqual({ stage: null, badge: "needs-you" });
    expect(await w.tools.waiting()).toEqual([
      { item: "1", title: "Fix the parser", url: "memory://items/1", workflow: "review" },
    ]);
    expect(await w.tools.status("1")).toMatchObject({ workflow: "review", stage: null, waitingOnYou: true });
  });

  /*
   * The same tracker and the same tick under a workflow that does write:
   * main still enters its first stage by recording the entry, and here that
   * record is refused and the item halts naming it — so "nothing written"
   * above is the review workflow asking for nothing, not a tracker that
   * drops what it is asked.
   */
  it("halts a workflow that writes on entry, naming the write it was refused", async () => {
    const state = createExternalState({ items: [{ id: "1", labels: ["lr:auto"] }], readOnly: true });
    const w = workspace(state, await loadShipped(), "main");
    expect(await w.tick()).toEqual([{
      item: "1", workflow: "main",
      outcome: 'halt after 1 pass(es): post hook "project" failed applying "tracker.comment": ' +
        "this tracker is read-only: comment was asked of #1",
    }]);
    expect(state.writes()).toEqual(["comment #1"]);
    expect(state.item("1").labels).toEqual(["lr:auto"]);
  });
});

/*
 * Converge tells a person when an item comes to rest at their turn after a
 * transition, and an item placed by its own state never makes one: it is
 * simply there, by its labels, one tick and not the last. So the tick tells
 * them, comparing where each item is with where it was the tick before —
 * in-process, never stored, so a restart tells once more of every item
 * already waiting.
 */
describe("telling you an item placed by its own state waits on you", () => {
  it("tells you once when it comes to wait on you, and not again while it stays", async () => {
    const state = requested();
    const w = workspace(state, review, "review");

    for (let tick = 0; tick < 3; tick++) await w.tick();

    expect(await w.sent()).toEqual([["1", "reviewing"]]);
    expect(w.events()[0]).toEqual({
      event: "needs-you", item: "1", workflow: "review", workflowName: "review", title: "Fix the parser",
      link: "memory://items/1", stage: "reviewing", why: "waiting on you", board: null,
    });
    expect(state.writes()).toEqual([]);
  });

  it("tells you again when it leaves your turn and comes back to it", async () => {
    const state = requested();
    const w = workspace(state, review, "review");
    await w.tick();

    state.label("1", "approved");
    await w.tick();
    await w.tick();
    expect(await w.sent()).toEqual([["1", "reviewing"]]);

    state.unlabel("1", "approved");
    await w.tick();
    await w.tick();
    expect(await w.sent()).toEqual([["1", "reviewing"], ["1", "reviewing"]]);
    expect(state.writes()).toEqual([]);
  });

  it("tells you once more of an item already waiting when the engine restarts, as it keeps nothing", async () => {
    const state = requested();
    const before = workspace(state, review, "review");
    await before.tick();
    await before.tick();
    expect(await before.sent()).toEqual([["1", "reviewing"]]);

    const after = workspace(state, review, "review");
    await after.tick();
    await after.tick();
    expect(await after.sent()).toEqual([["1", "reviewing"]]);
  });

  // A tick whose source cannot list knows nothing of where the item is, and
  // forgets nothing either: the tracker coming back tells no one again.
  it("does not tell again of an item it lost sight of for a tick its source could not list", async () => {
    const state = requested();
    let down = false;
    const flaky: Source = { ...state.source, list: (ctx) => (down ? Promise.reject(new Error("GET /issues → 502")) : state.source.list(ctx)) };
    const w = workspace(state, review, "review", { source: flaky });
    await w.tick();

    down = true;
    expect(await w.tick()).toEqual([]);
    down = false;
    await w.tick();

    expect(await w.sent()).toEqual([["1", "reviewing"]]);
  });

  /*
   * Where an item is listed is where it was when the tick began. One a
   * trigger takes on in that same tick never waited on anyone, and is not
   * said to: the tell waits for converge to leave it where it was listed.
   */
  it("tells nothing of an item a trigger moves on in the tick it arrives", async () => {
    const nudging: Workflow = {
      version: 1, name: "nudging", description: "test",
      eligible: [{ when: { "node.state.labels": { $in: ["lr:auto"] } }, else: "no lr:auto label" }],
      stages: [
        { id: "waiting", waits: "person", identity: { "node.state.labels": { $nin: ["nudged"] } } },
        {
          id: "nudged", terminal: true, identity: { "node.state.labels": { $in: ["nudged"] } },
          triggers: [{ when: { "node.state.labels": "stale" } }], on_enter: [{ type: "tracker.label", add: ["nudged"] }],
        },
      ],
    };
    const state = createExternalState({ items: [{ id: "1", title: "Old review", labels: ["lr:auto", "stale"] }] });
    const w = workspace(state, { workflow: nudging, steps: new Map() }, "nudging");

    await w.tick();
    expect(state.item("1").labels).toEqual(["lr:auto", "stale", "nudged"]);
    await w.tick();

    expect(await w.sent()).toEqual([]);
  });

  /*
   * A tick that could not see the item settle — its snapshot failed — did
   * not tell anyone. Noted as seen there all the same, it was never told of
   * until it left and came back.
   */
  it("tells you on the next clean tick of an item whose first tick failed to read it", async () => {
    const state = requested();
    let failing = true;
    const flaky: Source = {
      ...state.source,
      read: (item, ctx) => (failing ? Promise.reject(new Error("GET /issues/1 → 502")) : state.source.read(item, ctx)),
    };
    const w = workspace(state, review, "review", { source: flaky });

    expect((await w.tick()).find((r) => r.item === "1")?.outcome).toMatch(/^halt after 1 pass\(es\): .*502/);
    expect(await w.sent()).toEqual([]);

    failing = false;
    await w.tick();
    await w.tick();
    expect(await w.sent()).toEqual([["1", "reviewing"]]);
  });

  /*
   * Ticks overlap. One that lists while another is still working the item
   * finds it not yet told of, and its converge waits on the other's lock:
   * whichever tells first is the one tell.
   */
  it("tells you once of an item two overlapping ticks both find arriving", async () => {
    const state = requested();
    let hold: (() => void) | null = null;
    const held = new Promise<void>((resolve) => { hold = resolve; });
    let reads = 0;
    const slow: Source = {
      ...state.source,
      read: async (item, ctx) => {
        if (item === "1" && reads++ === 0) await held;
        return state.source.read(item, ctx);
      },
    };
    const w = workspace(state, review, "review", { source: slow });

    const first = w.tick();
    // The first tick holds the item's lock while its read waits.
    while (reads === 0) await new Promise((resolve) => setImmediate(resolve));
    expect((await w.tick()).find((r) => r.item === "1")?.outcome).toMatch(/lock/);
    (hold as unknown as () => void)();
    await first;
    await w.tick();

    expect(await w.sent()).toEqual([["1", "reviewing"]]);
  });

  // Held by something else — a goto, a person pairing — the item is not
  // converged this tick, and where it was listed is all that is known.
  it("tells you of an item that arrives while something else holds its lock", async () => {
    const state = requested();
    const w = workspace(state, review, "review");
    expect(await acquire("1", "tick", { root })).toBe(true);
    try {
      expect((await w.tick()).find((r) => r.item === "1")?.outcome).toMatch(/lock/);
    } finally {
      await release("1", { root });
    }
    await w.tick();

    expect(await w.sent()).toEqual([["1", "reviewing"]]);
  });

  /*
   * A stage placed by state can still be entered by a transition, which
   * converge tells of as it lands. The tick after must not tell it again for
   * having found it somewhere new.
   */
  it("does not tell twice of an item a transition took to a stage its state then places it at", async () => {
    const asked: Workflow = {
      version: 1, name: "asked", description: "test",
      eligible: [{ when: { "node.state.labels": { $in: ["lr:auto"] } }, else: "no lr:auto label" }],
      stages: [{
        id: "ask", entry: true, waits: "person", identity: { "node.state.labels": { $in: ["asked"] } },
        triggers: [{ when: { "run.stage": null } }], on_enter: [{ type: "tracker.label", add: ["asked"] }],
      }],
    };
    const state = createExternalState({ items: [{ id: "1", title: "Pick a vendor", labels: ["lr:auto"] }] });
    const w = workspace(state, { workflow: asked, steps: new Map() }, "asked");

    await w.tick();
    expect(state.item("1").labels).toEqual(["lr:auto", "asked"]);
    expect(await w.sent()).toEqual([["1", "ask"]]);

    await w.tick();
    await w.tick();
    expect(await w.sent()).toEqual([["1", "ask"]]);
  });

  // Main's own path, unchanged: converge tells of the transition, and the
  // ticks after — which see the item at a stage only its label places it at
  // — tell nothing more.
  it("tells you once when main's spec comes to rest for your review, however many ticks follow", async () => {
    const SPEC = '# The spec\n\nDo the thing.\n\n```json\n{"kind":"spec","title":"T"}\n```';
    const answering: Executor = { id: "agent", run: async () => ({ text: SPEC, sessionId: null }) };
    const state = createExternalState({ items: [{ id: "1", title: "Add export", labels: ["lr:auto"] }] });
    const w = workspace(state, await loadShipped(), "main", { executor: answering });

    for (let tick = 0; tick < 3; tick++) await w.tick();

    expect(state.stage("1")).toBe("spec-human-review");
    expect(await w.sent()).toEqual([["1", "spec-human-review"]]);
  });

  // A stage only its label places an item at was told of on the transition
  // that wrote the label; a restart finding it there tells nothing, as before.
  it("tells nothing of an item main already has waiting on you when the engine starts", async () => {
    const state = createExternalState({
      items: [{ id: "1", title: "Add export", labels: ["lr:auto", "lr:stage:spec-questions", "lr:awaiting"] }],
    });
    const w = workspace(state, await loadShipped(), "main");

    // Waiting where it was listed, so nothing but the stage decides the tell.
    for (let tick = 0; tick < 2; tick++) {
      expect(await w.tick()).toEqual([{ item: "1", workflow: "main", outcome: "wait after 1 pass(es): no trigger matched" }]);
    }

    expect(await w.row("1")).toMatchObject({ stage: "spec-questions", lane: "needs-you" });
    expect(await w.sent()).toEqual([]);
  });
});
