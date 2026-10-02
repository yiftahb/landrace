import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTools } from "#mcp/tools.js";
import type {
  Executor, ExternalState, HookContext, Registry, RuntimeContext, Step, Workflow, WorkspaceRuntime,
} from "#namespace.js";
import { createDispatcher } from "#runner/effects.js";
import { createLogger } from "#runner/events.js";
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

/** A workspace of one workflow over `state`, and every surface that says where its items are. */
function workspace(state: ExternalState, loaded: { workflow: Workflow; steps: Map<string, Step> }, id: string) {
  const log = createLogger({ sink: () => {} });
  const stop = new AbortController();
  const ctx: RuntimeContext = { config: {} as HookContext["config"], secrets: new Map(), signal: stop.signal, log: () => {} };
  const { workflow, steps } = loaded;
  const runtime: WorkspaceRuntime = {
    dir: root,
    workflows: [{
      id, name: workflow.name, description: workflow.description, source: state.source,
      deps: {
        workflow, steps, source: state.source, pre: [state.pre], dispatcher: createDispatcher([state.post]),
        executor: nobody, ctx, log, scrub: (t) => t,
      },
    }],
    preflights: [], intervalMs: 60_000, concurrency: 2, stop, running: new Map(), log, ctx,
  };
  const registry: Registry = {
    preflights: [state.preflight], pre: [state.pre], post: [state.post], artifacts: [], source: state.source,
    operator: state.operator, executors: new Map(), notifiers: new Map(),
  };
  const tools = createTools([{ id, dir: `/w/workflows/${id}`, workflow, steps, registry }], ctx, { lock: { root } });

  return {
    tools,
    tick: () => tickWorkspace({ runtime, lock: { root } }),
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
