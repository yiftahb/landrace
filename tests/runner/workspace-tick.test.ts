import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWorktree, keptSlot, removeWorktree } from "#agent/worktree.js";
import { defineNotifier } from "#hooks/contracts.js";
import type {
  Executor, ExternalState, HookContext, LandraceEvent, NotifyEvent, RuntimeContext, Source, Step, Workflow, WorkflowRuntime,
  WorkspaceListing, WorkspaceRuntime,
} from "#namespace.js";
import { createNotify } from "#runner/notify.js";
import { createExternalState } from "#testing/index.js";
import { createDispatcher } from "#runner/effects.js";
import { createLogger } from "#runner/events.js";
import { held } from "#runner/lock.js";
import { tickWorkspace } from "#runner/tick.js";
import { loadWorkflow } from "#workflow/load.js";
import { gitRepo, removeRepos, worktreesOf as sandboxes } from "#tests/support/repo.js";

/**
 * Two workflows in one loop: `main` takes what carries `lr:auto`, `fast` what
 * carries `lr:fast`, both the one-step minimal fixture. What a test observes
 * is which workflow's executor ran for which item, and when — never what the
 * decision engine did with it, which the converge tests own.
 */
const SPEC = '```json\n{"kind":"spec","title":"T"}\n```';

let minimal: { workflow: Workflow; steps: Map<string, Step> };
beforeAll(async () => {
  minimal = await loadWorkflow("tests/fixtures/minimal");
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lr-workspace-tick-"));
});

/** Released after every test whether it passed or not, so a failed assertion cannot leave a worker blocked. */
const gates: Array<() => void> = [];
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  gates.push(open);
  return { wait, open };
}
afterEach(() => {
  for (const open of gates.splice(0)) open();
});

async function until(predicate: () => boolean | Promise<boolean>, what: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Every run of every executor in one workspace, and how many were in flight at once. */
interface Agents {
  runs: Array<{ workflow: string; stopped: boolean }>;
  peak: () => number;
  /** An executor for `workflow` that answers once `hold` (if any) lets it, or once its run is stopped. */
  agent: (workflow: string, hold?: (signal: AbortSignal) => Promise<void>) => Executor;
}

function agents(): Agents {
  const runs: Agents["runs"] = [];
  let inFlight = 0;
  let peak = 0;
  return {
    runs,
    peak: () => peak,
    agent: (workflow, hold) => ({
      id: `agent-${workflow}`,
      run: async (_prompt, { signal }) => {
        const run = { workflow, stopped: false };
        runs.push(run);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        try {
          // Every run yields at least once, so two that overlap are seen to.
          await new Promise((r) => setTimeout(r, 10));
          if (hold) {
            const stopped = signal.aborted
              ? Promise.resolve()
              : new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
            await Promise.race([stopped, hold(signal)]);
          }
          run.stopped = signal.aborted;
          return { text: SPEC, sessionId: null };
        } finally {
          inFlight -= 1;
        }
      },
    }),
  };
}

interface World {
  runtime: WorkspaceRuntime;
  events: LandraceEvent[];
  listings: WorkspaceListing[];
  once: () => ReturnType<typeof tickWorkspace>;
  named: (name: LandraceEvent["name"]) => LandraceEvent[];
}

/** A workspace of the given workflows, each `[id, label, state, source, executor]`. */
function world(
  workflows: Array<[id: string, label: string, state: ExternalState, source: Source, executor: Executor]>,
  concurrency = 3,
): World {
  const events: LandraceEvent[] = [];
  const listings: WorkspaceListing[] = [];
  const log = createLogger({ sink: (e) => events.push(e) });
  const stop = new AbortController();
  const ctx: RuntimeContext = { config: {} as HookContext["config"], secrets: new Map(), signal: stop.signal, log: () => {} };
  const runtime: WorkspaceRuntime = {
    dir: root,
    workflows: workflows.map(([id, label, state, source, executor]): WorkflowRuntime => ({
      id, name: id, description: "test", source,
      deps: {
        workflow: { ...minimal.workflow, name: id, eligible: [{ when: { "node.state.labels": { $in: [label] } }, else: `no ${label} label` }] },
        steps: minimal.steps, source, pre: [state.pre], dispatcher: createDispatcher([state.post]), executor, ctx, log, scrub: (t) => t,
      },
    })),
    preflights: [], intervalMs: 60_000, concurrency, agents: 0, checking: false, asking: [], turnedAway: [], stop, running: new Map(), seen: new Map(), log, ctx,
  };
  return {
    runtime, events, listings,
    once: () => tickWorkspace({ runtime, lock: { root }, onList: (l) => listings.push(l) }),
    named: (name) => events.filter((e) => e.name === name),
  };
}

/** The same source object, counting its lists: what two workflows loading one hook module share. */
function counted(state: ExternalState): Source & { lists: () => number } {
  let lists = 0;
  return { ...state.source, list: (ctx) => { lists += 1; return state.source.list(ctx); }, lists: () => lists };
}

describe("one tick over every workflow", () => {
  it("works each item under the one workflow that claims it, in the same tick, listing their shared source once", async () => {
    const state = createExternalState({ items: [{ id: "1", labels: ["lr:auto"] }, { id: "2", labels: ["lr:fast"] }] });
    const source = counted(state);
    const a = agents();
    const w = world([["main", "lr:auto", state, source, a.agent("main")], ["fast", "lr:fast", state, source, a.agent("fast")]]);

    const rows = await w.once();

    expect(rows).toEqual([
      { item: "1", workflow: "main", outcome: expect.stringMatching(/^terminal/) },
      { item: "2", workflow: "fast", outcome: expect.stringMatching(/^terminal/) },
    ]);
    expect(a.runs.map((r) => r.workflow).sort()).toEqual(["fast", "main"]);
    expect([state.stage("1"), state.stage("2")]).toEqual(["done", "done"]);
    expect(source.lists()).toBe(1);
  });

  it("works neither workflow's way an item both claim: nothing written, and a row and an event naming both", async () => {
    const state = createExternalState({ items: [{ id: "3", labels: ["lr:auto", "lr:fast"] }] });
    const a = agents();
    const w = world([["main", "lr:auto", state, state.source, a.agent("main")], ["fast", "lr:fast", state, state.source, a.agent("fast")]]);

    const rows = await w.once();

    expect(rows).toEqual([{ item: "3", outcome: "claimed by fast and main" }]);
    expect(w.named("item.skipped")).toEqual([expect.objectContaining({ item: "3", reason: "claimed by fast and main" })]);
    expect(a.runs).toEqual([]);
    expect(state.comments("3")).toEqual([]);
    expect(state.item("3").labels).toEqual(["lr:auto", "lr:fast"]);
    expect(await held("3", { root })).toBeNull();
  });

  it("works neither workflow's way an id two different sources both report, naming both", async () => {
    const one = createExternalState({ items: [{ id: "12", labels: ["lr:auto"] }] });
    const two = createExternalState({ items: [{ id: "12", labels: ["lr:fast"] }] });
    const a = agents();
    const w = world([["main", "lr:auto", one, one.source, a.agent("main")], ["fast", "lr:fast", two, two.source, a.agent("fast")]]);

    expect(await w.once()).toEqual([{ item: "12", outcome: "reported by the sources of fast and main" }]);
    expect(w.named("item.skipped")).toEqual([expect.objectContaining({ item: "12", reason: "reported by the sources of fast and main" })]);
    expect(a.runs).toEqual([]);
    expect([one.comments("12"), two.comments("12")]).toEqual([[], []]);
  });

  it("keeps tick.concurrency workspace-wide: one at a time across both workflows", async () => {
    const state = createExternalState({ items: [{ id: "1", labels: ["lr:auto"] }, { id: "2", labels: ["lr:fast"] }] });
    const a = agents();
    const w = world([["main", "lr:auto", state, state.source, a.agent("main")], ["fast", "lr:fast", state, state.source, a.agent("fast")]], 1);

    expect(await w.once()).toHaveLength(2);
    expect(a.runs.map((r) => r.workflow).sort()).toEqual(["fast", "main"]);
    expect(a.peak()).toBe(1);
  });

  /*
   * Review focus 1: relabelled from lr:auto to lr:fast while main's step
   * runs. The next tick stops main's run — which writes nothing — and works
   * the item under fast in that same tick, never beside it.
   */
  it("stops a run whose item another workflow now claims, and works it under that workflow in the same tick", async () => {
    const state = createExternalState({ items: [{ id: "1", labels: ["lr:auto"] }] });
    const a = agents();
    const relabel = gate();
    const w = world([
      ["main", "lr:auto", state, state.source, a.agent("main", async () => {
        state.unlabel("1", "lr:auto");
        state.label("1", "lr:fast");
        await relabel.wait;
      })],
      ["fast", "lr:fast", state, state.source, a.agent("fast")],
    ]);

    const first = w.once();
    await until(() => state.item("1").labels.includes("lr:fast"), "main's step to relabel its item");
    const before = state.comments("1");

    const second = await w.once();

    expect(w.named("item.aborted")).toEqual([expect.objectContaining({ item: "1", workflow: "main", reason: expect.stringContaining("fast") })]);
    expect(second).toEqual([{ item: "1", workflow: "fast", outcome: expect.stringMatching(/^terminal/) }]);
    expect(await first).toEqual([{ item: "1", workflow: "main", outcome: expect.stringMatching(/^halt .*aborted/) }]);
    expect(a.runs).toEqual([{ workflow: "main", stopped: true }, { workflow: "fast", stopped: false }]);
    expect(a.peak()).toBe(1);
    // Main's stopped round wrote nothing; fast's own round is what followed.
    expect(state.comments("1").slice(0, before.length)).toEqual(before);
    expect(state.stage("1")).toBe("done");
    expect(w.runtime.running.size).toBe(0);
  });

  it("stops a run whose item a second workflow now also claims, and works it under neither", async () => {
    const state = createExternalState({ items: [{ id: "1", labels: ["lr:auto"] }] });
    const a = agents();
    const finish = gate();
    const w = world([
      ["main", "lr:auto", state, state.source, a.agent("main", () => finish.wait)],
      ["fast", "lr:fast", state, state.source, a.agent("fast")],
    ]);

    const first = w.once();
    await until(() => a.runs.length === 1, "main's step to start");
    state.label("1", "lr:fast");

    expect(await w.once()).toEqual([{ item: "1", outcome: "claimed by fast and main" }]);
    expect(w.named("item.aborted")).toEqual([expect.objectContaining({ item: "1", workflow: "main", reason: "claimed by fast and main" })]);
    expect((await first)[0]?.outcome).toMatch(/^halt .*aborted/);
    expect(a.runs).toEqual([{ workflow: "main", stopped: true }]);
  });

  /*
   * Review focus 3, as ruled: one tracker down stops nothing that runs, but
   * with two sources nothing is worked while one cannot list — whether it
   * also reports an id the other lists, a clash, is unknown until it does.
   * The event still says whose source it was, and the next tick that lists
   * both works as before.
   */
  it("works no item and stops no run while one of two sources cannot list, and works again once both list", async () => {
    const one = createExternalState({ items: [{ id: "10", labels: ["lr:auto"] }] });
    const two = createExternalState({ items: [{ id: "20", labels: ["lr:fast"] }] });
    let failing = false;
    const flaky: Source = { ...two.source, list: async (ctx) => {
      if (failing) throw new Error("GET /issues → 502");
      return two.source.list(ctx);
    } };
    const a = agents();
    const finish = gate();
    const w = world([
      ["main", "lr:auto", one, one.source, a.agent("main")],
      ["fast", "lr:fast", two, flaky, a.agent("fast", () => finish.wait)],
    ]);

    const first = w.once();
    await until(() => a.runs.some((r) => r.workflow === "fast"), "fast's step to start");
    await until(async () => one.stage("10") === "done" && (await held("10", { root })) === null, "main's item to finish");
    const comments = one.comments("10");
    failing = true;

    const second = await w.once();

    expect(second).toEqual([{ item: "10", outcome: "whether the source of fast also reports #10 is unknown: GET /issues → 502" }]);
    expect(w.named("item.skipped")).toEqual([
      expect.objectContaining({ item: "10", reason: "whether the source of fast also reports #10 is unknown: GET /issues → 502" }),
    ]);
    expect(one.comments("10")).toEqual(comments);
    expect(w.named("item.aborted")).toEqual([]);
    expect(w.runtime.running.get("20")?.controller.signal.aborted).toBe(false);
    expect(w.named("source.failed")).toEqual([expect.objectContaining({ workflows: ["fast"], reason: expect.stringContaining("502") })]);
    expect([...(w.listings.at(-1)?.failed.values() ?? [])]).toEqual([expect.stringContaining("502")]);

    finish.open();
    expect(await first).toEqual([
      { item: "10", workflow: "main", outcome: expect.stringMatching(/^terminal/) },
      { item: "20", workflow: "fast", outcome: expect.stringMatching(/^terminal/) },
    ]);
    expect(a.runs.filter((r) => r.workflow === "fast")).toEqual([{ workflow: "fast", stopped: false }]);

    failing = false;
    expect(await w.once()).toEqual([
      { item: "10", workflow: "main", outcome: expect.stringMatching(/ after 1 pass\(es\)/) },
      { item: "20", workflow: "fast", outcome: expect.stringMatching(/ after 1 pass\(es\)/) },
    ]);
  });

  /*
   * The probe that found it: #12 is a clash while both sources list, and
   * must not become main's to work the tick fast's source fails to.
   */
  it("does not settle a clash in favour of the source that still lists while the other cannot", async () => {
    const one = createExternalState({ items: [{ id: "12", labels: ["lr:auto"] }] });
    const two = createExternalState({ items: [{ id: "12", labels: ["lr:fast"] }] });
    let failing = false;
    const flaky: Source = { ...two.source, list: async (ctx) => {
      if (failing) throw new Error("GET /issues → 502");
      return two.source.list(ctx);
    } };
    const a = agents();
    const w = world([["main", "lr:auto", one, one.source, a.agent("main")], ["fast", "lr:fast", two, flaky, a.agent("fast")]]);

    expect(await w.once()).toEqual([{ item: "12", outcome: "reported by the sources of fast and main" }]);
    failing = true;

    expect(await w.once()).toEqual([{ item: "12", outcome: "whether the source of fast also reports #12 is unknown: GET /issues → 502" }]);
    expect(a.runs).toEqual([]);
    expect([one.comments("12"), two.comments("12")]).toEqual([[], []]);
    expect(one.item("12").labels).toEqual(["lr:auto"]);
  });

  it("stops a run whose id a second source now reports too, and works it under neither", async () => {
    const one = createExternalState({ items: [{ id: "12", labels: ["lr:auto"] }] });
    const two = createExternalState({ items: [{ id: "12", labels: ["lr:fast"] }] });
    let reported = false;
    const late: Source = { ...two.source, list: async (ctx) => {
      const graph = await two.source.list(ctx);
      return reported ? graph : { ...graph, nodes: graph.nodes.filter((n) => n.id !== "12") };
    } };
    const a = agents();
    const finish = gate();
    const w = world([
      ["main", "lr:auto", one, one.source, a.agent("main", () => finish.wait)],
      ["fast", "lr:fast", two, late, a.agent("fast")],
    ]);

    const first = w.once();
    await until(() => a.runs.length === 1, "main's step to start");
    reported = true;

    expect(await w.once()).toEqual([{ item: "12", outcome: "reported by the sources of fast and main" }]);
    expect(w.named("item.aborted")).toEqual([
      expect.objectContaining({ item: "12", workflow: "main", reason: "reported by the sources of fast and main" }),
    ]);
    expect((await first)[0]?.outcome).toMatch(/^halt .*aborted/);
    expect(a.runs).toEqual([{ workflow: "main", stopped: true }]);
    expect(two.comments("12")).toEqual([]);
  });
});

/*
 * #65: ticks overlap, so one tick's pool is not the bound. The board showed
 * four agents running under `concurrency: 3` — two started by one tick, two
 * more by the next while the first two still ran.
 */
describe("tick.concurrency across overlapping ticks", () => {
  const WAITING = "waiting for a free agent slot (tick.concurrency 2)";

  /*
   * A hold for each run, in the order the runs ask for one, released by hand:
   * one, or every one from now on. A run is counted before it asks, so the
   * nth hold may be released before it is asked for, and stays released.
   */
  function holds(): { hold: () => Promise<void>; release: (n: number) => void; all: () => void } {
    const held: Array<ReturnType<typeof gate>> = [];
    const nth = (n: number) => (held[n] ??= gate());
    let asked = 0;
    let free = false;
    return {
      hold: () => (free ? Promise.resolve() : nth(asked++).wait),
      release: (n) => nth(n).open(),
      all: () => {
        free = true;
        for (const g of held) g?.open();
      },
    };
  }

  /*
   * Until the `n`th tick has finished, or an agent past `max` has started: a
   * tick that starts one too many waits on its hold, and awaiting it would
   * hang the test instead of failing it.
   */
  const finishedOrOver = (w: World, a: Agents, n: number, max: number) =>
    until(() => w.named("tick.finished").length === n || a.runs.length > max, `tick ${n} to finish`);

  it("starts no agent in a tick that overlaps runs holding every slot, and exactly one when one frees", async () => {
    const state = createExternalState({
      items: [{ id: "1", labels: ["lr:auto"] }, { id: "2", labels: ["lr:auto"] }, ...["3", "4", "5"].map((id) => ({ id, labels: [] }))],
    });
    const a = agents();
    const h = holds();
    const w = world([["main", "lr:auto", state, state.source, a.agent("main", h.hold)]], 2);

    const first = w.once();
    await until(() => a.runs.length === 2 && !w.runtime.checking, "the first tick to fill both slots");
    for (const id of ["3", "4", "5"]) state.label(id, "lr:auto");

    const second = w.once();
    await finishedOrOver(w, a, 1, 2);
    expect(a.runs).toHaveLength(2);
    expect(await second).toEqual([
      { item: "1", workflow: "main", outcome: expect.stringMatching(/locked by/) },
      { item: "2", workflow: "main", outcome: expect.stringMatching(/locked by/) },
      { item: "3", workflow: "main", outcome: WAITING },
      { item: "4", workflow: "main", outcome: WAITING },
      { item: "5", workflow: "main", outcome: WAITING },
    ]);
    expect(w.named("item.skipped").filter((e) => e.reason === WAITING).map((e) => e.item).sort()).toEqual(["3", "4", "5"]);

    h.release(0);
    await until(() => a.runs.length === 3, "item 1's freed slot to start one");
    await new Promise((r) => setTimeout(r, 30));
    expect(a.runs).toHaveLength(3);
    // Whichever of 1 and 2 asked for its hold first ended; 3 is the most urgent turned away.
    expect([...w.runtime.running.keys()]).toContain("3");
    expect(w.runtime.running.size).toBe(2);
    expect(a.peak()).toBe(2);

    h.all();
    await first;
    expect(a.runs).toHaveLength(5);
    expect(a.peak()).toBe(2);
    expect(w.runtime.agents).toBe(0);
  });

  it("holds the bound across two workflows sharing the workspace", async () => {
    const state = createExternalState({
      items: [{ id: "1", labels: ["lr:auto"] }, { id: "2", labels: ["lr:fast"] }, { id: "3", labels: [] }, { id: "4", labels: [] }],
    });
    const a = agents();
    const h = holds();
    const w = world([["main", "lr:auto", state, state.source, a.agent("main", h.hold)], ["fast", "lr:fast", state, state.source, a.agent("fast", h.hold)]], 2);

    const first = w.once();
    await until(() => a.runs.length === 2 && !w.runtime.checking, "one run under each workflow");
    state.label("3", "lr:auto");
    state.label("4", "lr:fast");

    const second = w.once();
    await finishedOrOver(w, a, 1, 2);
    expect(a.runs).toHaveLength(2);
    expect(await second).toEqual([
      { item: "1", workflow: "main", outcome: expect.stringMatching(/locked by/) },
      { item: "2", workflow: "fast", outcome: expect.stringMatching(/locked by/) },
      { item: "3", workflow: "main", outcome: WAITING },
      { item: "4", workflow: "fast", outcome: WAITING },
    ]);

    h.all();
    await first;
    expect(a.peak()).toBe(2);
    expect(w.runtime.agents).toBe(0);
  });

  /*
   * Review of #65: a tick whose own run ended took the freed slot for the
   * next item of its own listing, however stale, before any later tick could
   * — so an urgent item filed since waited behind the whole of that queue.
   */
  it("gives a freed slot to the most urgent item the latest checks turned away, never to an older tick's", async () => {
    const state = createExternalState({
      items: [{ id: "1", labels: ["lr:auto"] }, { id: "2", labels: ["lr:auto"] }, { id: "3", labels: [], priority: 0 }],
    });
    const a = agents();
    const h = holds();
    const w = world([["main", "lr:auto", state, state.source, a.agent("main", h.hold)]], 1);
    const waiting = "waiting for a free agent slot (tick.concurrency 1)";

    const first = w.once();
    await until(() => a.runs.length === 1 && !w.runtime.checking, "item 1's run to start and item 2 to be turned away");
    state.label("3", "lr:auto");
    expect(await w.once()).toEqual([
      { item: "1", workflow: "main", outcome: expect.stringMatching(/locked by/) },
      { item: "2", workflow: "main", outcome: waiting },
      { item: "3", workflow: "main", outcome: waiting },
    ]);

    h.release(0);
    await until(() => a.runs.length === 2, "item 1's freed slot to start the most urgent item");
    expect([...w.runtime.running.keys()]).toEqual(["3"]);
    h.all();
    expect((await first).find((r) => r.item === "2")).toEqual({ item: "2", workflow: "main", outcome: waiting });
    expect(a.runs).toHaveLength(3);
    expect(w.runtime.agents).toBe(0);
  });

  it("takes no slot for a busy item, and still starts the free one behind it", async () => {
    const state = createExternalState({ items: [{ id: "1", labels: ["lr:auto"] }, { id: "2", labels: [] }, { id: "3", labels: [] }] });
    const a = agents();
    const h = holds();
    const w = world([["main", "lr:auto", state, state.source, a.agent("main", h.hold)]], 2);

    const first = w.once();
    await until(() => a.runs.length === 1, "item 1's run to start");
    state.label("2", "lr:auto");
    state.label("3", "lr:auto");

    const second = w.once();
    await until(() => a.runs.length >= 2, "the overlapping tick to start item 2");
    await new Promise((r) => setTimeout(r, 30));
    expect(a.runs).toHaveLength(2);
    expect(w.runtime.agents).toBe(2);

    h.all();
    const rows = await second;
    expect(rows.find((r) => r.item === "1")?.outcome).toMatch(/locked by/);
    expect(rows.find((r) => r.item === "2")?.outcome).toMatch(/^terminal/);
    await first;
    expect(a.peak()).toBe(2);
    expect(w.runtime.agents).toBe(0);
  });

  /*
   * Review of #65: two workers turned away in one round put their items back
   * in the order they resumed, so the queue read `[5, 4]` and the slot the
   * tick's own run freed went to 5 ahead of the more urgent 4.
   */
  it("gives a slot its own run frees to the most urgent item it was refused for", async () => {
    const state = createExternalState({
      items: [
        { id: "1", labels: ["lr:auto"] }, { id: "2", labels: ["lr:auto"] },
        { id: "3", labels: [], priority: 0 }, { id: "4", labels: [], priority: 1 }, { id: "5", labels: [], priority: 2 },
      ],
    });
    const a = agents();
    const h = holds();
    const w = world([["main", "lr:auto", state, state.source, a.agent("main", h.hold)]], 3);

    const first = w.once();
    await until(() => a.runs.length === 2, "the first tick to start items 1 and 2");
    for (const id of ["3", "4", "5"]) state.label(id, "lr:auto");

    const second = w.once();
    await until(() => a.runs.length === 3 && !w.runtime.checking, "one of 3, 4 and 5 to take the last slot");
    // Checks run side by side: the one whose read answered first may ask first.
    const took = [...w.runtime.running.keys()].find((id) => id !== "1" && id !== "2");
    h.release(2);
    await until(() => a.runs.length === 4, "the freed slot to go to the next item");
    const next = ["3", "4", "5"].find((id) => id !== took);
    expect([...w.runtime.running.keys()].sort()).toEqual(["1", "2", next]);

    h.all();
    await Promise.all([first, second]);
    expect(w.runtime.agents).toBe(0);
  });
});

/*
 * #136: a slot is an agent. Checking an item, entering a stage and its
 * effects, and a merge take none; only a step's agent does. Probed against the
 * old tick, a check took a slot whether or not an agent ran, and a tick every
 * 100 ms over slow reads never reached a new item at all.
 */
describe("a slot is an agent", () => {
  const WAITING = "waiting for a free agent slot (tick.concurrency 1)";

  /** One stage, run by no step, that merges the item's pull request, moves its status and waits on a person. */
  const PARK: Workflow = {
    version: 1, name: "park", description: "test",
    stages: [{
      id: "parked", entry: true, waits: "person", triggers: [{ when: { "run.stage": null } }],
      on_enter: [{ type: "pull.merge", branch: "landrace/{item}" }, { type: "tracker.status", value: "parked" }],
    }],
  };
  const parking = (w: World): void => {
    for (const wf of w.runtime.workflows) {
      if (wf.id === "park") wf.deps.workflow = { ...PARK, eligible: wf.deps.workflow.eligible ?? [] };
    }
  };

  it("checks a fresh item, merges it and moves its status while an agent holds every slot", async () => {
    const state = createExternalState({ items: [{ id: "1", labels: ["lr:auto"] }, { id: "2", labels: [] }] });
    const pull = state.openPull("2");
    const a = agents();
    const finish = gate();
    const w = world([
      ["main", "lr:auto", state, state.source, a.agent("main", () => finish.wait)],
      ["park", "lr:park", state, state.source, a.agent("park")],
    ], 1);
    parking(w);

    const first = w.once();
    await until(() => a.runs.length === 1, "item 1's agent to take the only slot");
    state.label("2", "lr:park");

    expect(await w.once()).toEqual([
      { item: "1", workflow: "main", outcome: expect.stringMatching(/locked by/) },
      { item: "2", workflow: "park", outcome: expect.stringMatching(/^wait after 2 pass\(es\)/) },
    ]);
    expect(state.stage("2")).toBe("parked");
    expect(state.pull(pull).merged).toBe(true);
    expect(a.runs).toHaveLength(1);

    finish.open();
    await first;
  });

  it("leaves a step owed when no slot is free, writing nothing for it, and runs it once a slot frees", async () => {
    const state = createExternalState({ items: [{ id: "1", labels: ["lr:auto"] }, { id: "2", labels: [] }] });
    const a = agents();
    const finish = gate();
    const w = world([["main", "lr:auto", state, state.source, a.agent("main", () => finish.wait)]], 1);

    const first = w.once();
    await until(() => a.runs.length === 1, "item 1's agent to take the only slot");
    state.label("2", "lr:auto");

    expect((await w.once()).find((r) => r.item === "2")).toEqual({ item: "2", workflow: "main", outcome: WAITING });
    expect(w.named("item.skipped").filter((e) => e.reason === WAITING)).toEqual([expect.objectContaining({ item: "2", workflow: "main" })]);
    // Entered, so its stage is shown; its step's round is still owed.
    expect(state.stage("2")).toBe("spec");
    const entered = state.comments("2");
    expect(entered).toHaveLength(1);

    finish.open();
    await first;
    await until(async () => state.stage("2") === "done" && (await held("2", { root })) === null, "item 2's step to run");
    // A later tick finds both at their end, and runs nothing again.
    expect(await w.once()).toEqual([
      { item: "1", workflow: "main", outcome: expect.stringMatching(/^wait after 1 pass/) },
      { item: "2", workflow: "main", outcome: expect.stringMatching(/^wait after 1 pass/) },
    ]);
    expect(a.runs).toHaveLength(2);
    const comments = state.comments("2");
    expect(comments.slice(0, 1)).toEqual(entered);
    expect(new Set(comments).size).toBe(comments.length);
    expect(w.runtime.agents).toBe(0);
  });

  it("starts nothing turned away once the loop is stopping, and gives every slot back", async () => {
    const state = createExternalState({ items: [{ id: "1", labels: ["lr:auto"] }, { id: "2", labels: [] }] });
    const a = agents();
    const w = world([["main", "lr:auto", state, state.source, a.agent("main", () => new Promise(() => {}))]], 1);

    const first = w.once();
    await until(() => a.runs.length === 1, "item 1's agent to take the only slot");
    state.label("2", "lr:auto");
    expect((await w.once()).find((r) => r.item === "2")?.outcome).toBe(WAITING);
    expect(w.runtime.turnedAway.map((t) => t.node.id)).toEqual(["2"]);

    const checks = () => w.named("lock.acquired").filter((e) => e.item === "2").length;
    expect(checks()).toBe(1);
    w.runtime.stop.abort();
    expect((await first).find((r) => r.item === "1")?.outcome).toMatch(/^halt .*aborted/);
    expect(a.runs).toEqual([{ workflow: "main", stopped: true }]);
    expect(checks()).toBe(1);
    expect(w.runtime.agents).toBe(0);
  });

  it("starts a new item behind slow parked ones when ticks come faster than a pass", async () => {
    const parked = ["11", "12", "13", "14", "15", "16"];
    const state = createExternalState({ items: [...parked.map((id) => ({ id, labels: ["lr:park"], priority: 0 })), { id: "20", labels: [] }] });
    for (const id of parked) state.openPull(id);
    let slow = false;
    const reading: Source = { ...state.source, read: async (item, ctx) => {
      if (slow) await new Promise((r) => setTimeout(r, 40));
      return state.source.read(item, ctx);
    } };
    const a = agents();
    const w = world([["main", "lr:auto", state, reading, a.agent("main")], ["park", "lr:park", state, reading, a.agent("park")]], 1);
    parking(w);
    await w.once();
    expect(parked.map((id) => state.stage(id))).toEqual(parked.map(() => "parked"));

    slow = true;
    state.label("20", "lr:auto");
    const ticks: Array<Promise<unknown>> = [];
    const every = setInterval(() => ticks.push(w.once()), 100);
    try {
      await until(() => a.runs.length === 1, "the new item's agent to start", 3000);
    } finally {
      clearInterval(every);
    }
    await Promise.all(ticks);
    expect(state.stage("20")).toBe("done");
    expect(w.named("tick.skipped").length).toBeGreaterThan(0);
  });

  it("skips a tick that starts while an earlier one is still checking, and says why", async () => {
    const state = createExternalState({ items: [{ id: "1", labels: ["lr:park"] }] });
    state.openPull("1");
    const reads = gate();
    const reading: Source = { ...state.source, read: async (item, ctx) => {
      await reads.wait;
      return state.source.read(item, ctx);
    } };
    const a = agents();
    const w = world([["park", "lr:park", state, reading, a.agent("park")]], 1);
    parking(w);

    const first = w.once();
    await until(() => w.named("lock.acquired").length === 1, "the first tick to start checking");

    expect(await w.once()).toEqual([]);
    expect(w.named("tick.skipped")).toEqual([expect.objectContaining({ reason: "an earlier tick is still checking its items" })]);
    expect(w.named("tick.started")).toHaveLength(1);

    reads.open();
    expect(await first).toEqual([{ item: "1", workflow: "park", outcome: expect.stringMatching(/^wait/) }]);
  });
});

/*
 * One notifier object, loaded by both workflows from one hook module: each
 * workflow's notify sends through it for that workflow's own items only, so
 * an item coming to rest waiting on you is said once, not once per workflow.
 */
describe("a notifier two workflows share", () => {
  /** One stage that asks a person at once: entered, the item waits on you. */
  const ASKING: Workflow = {
    version: 1, name: "asking", description: "test",
    stages: [{
      id: "ask", entry: true, waits: "person", triggers: [{ when: { "run.stage": null } }],
      on_enter: [{ type: "tracker.status", value: "ask" }],
    }],
  };

  it("sends once per item that comes to rest waiting on you, naming the workflow it is in", async () => {
    const state = createExternalState({ items: [{ id: "1", labels: ["lr:auto"] }, { id: "2", labels: ["lr:fast"] }] });
    const a = agents();
    const w = world([["main", "lr:auto", state, state.source, a.agent("main")], ["fast", "lr:fast", state, state.source, a.agent("fast")]]);
    const sent: NotifyEvent[] = [];
    const chat = defineNotifier({ id: "chat", send: async (e) => { sent.push(e); } });
    for (const wf of w.runtime.workflows) {
      wf.deps.workflow = { ...ASKING, name: wf.id === "main" ? "Main" : "Fastlane", eligible: wf.deps.workflow.eligible ?? [] };
      wf.deps.notify = createNotify({
        id: wf.id, workflow: wf.deps.workflow, notify: { on: ["needs-you"], via: ["chat"] }, notifiers: new Map([["chat", chat]]),
        ctx: w.runtime.ctx, log: w.runtime.log, board: () => null,
      });
    }

    await w.once();
    await new Promise((r) => setImmediate(r));

    expect(sent.map((e) => [e.item, e.workflow, e.workflowName]).sort()).toEqual([["1", "main", "Main"], ["2", "fast", "Fastlane"]]);
    expect(a.runs).toEqual([]);
  });
});

/*
 * A converge removes an item's kept write worktree as it reaches a terminal
 * stage, but a merge that closes the item first is never converged there: the
 * tick does not converge a closed item. Nor is one a person closed, or one a
 * crash stopped between the terminal transition and the removal.
 */
describe("an item's kept write worktree", () => {
  afterAll(removeRepos);

  it("is removed once the item is closed, unlisted or at a terminal stage, and kept while it is open work", async () => {
    const repo = await gitRepo();
    const state = createExternalState({
      items: [
        { id: "5", labels: ["lr:auto"], closed: "done" },
        { id: "6", labels: ["lr:other"] },
        { id: "1", labels: ["lr:auto"] },
      ],
    });
    const a = agents();
    const w = world([["main", "lr:auto", state, state.source, a.agent("main")]]);
    for (const wf of w.runtime.workflows) wf.deps.sandbox = { root: repo };
    // Item 1 reaches its terminal stage on this tick, and its run removes its own.
    await w.once();
    expect(state.stage("1")).toBe("done");

    for (const item of ["1", "5", "6", "7"]) {
      await ensureWorktree(item, repo, { branch: `landrace/${item}`, write: true }, keptSlot(item));
    }
    await w.once();

    expect((await sandboxes(repo)).map((line) => line.split("/").pop()).sort()).toEqual(["6.write"]);
    await removeWorktree("6", repo, keptSlot("6"));
  });
});
