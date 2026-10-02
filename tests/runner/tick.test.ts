import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LandraceEvent, RunningItem, Step, Workflow } from "#namespace.js";
import { definePreHook, defineSource } from "#hooks/contracts.js";
import type { Executor, Graph, HookContext, Node, RuntimeContext } from "#namespace.js";
import { createExternalState, staticSource } from "#testing/index.js";
import { loadWorkflow } from "#workflow/load.js";
import { createDispatcher } from "#runner/effects.js";
import { createLogger } from "#runner/events.js";
import { acquire, held, release } from "#runner/lock.js";
import { eligibilityOf } from "#runner/tick.js";
import { tick, type TickOptions } from "#tests/support/tick.js";
import { statusLines } from "#runner/status.js";

/**
 * One stage, entered and finished in a single pass, so what a test observes is
 * the tick's own behaviour — which items ran, when, and under what lock —
 * and not something the decision engine did with them.
 */
const workflow: Workflow = {
  version: 1,
  name: "t", description: "test",
  eligible: [{ when: { "node.state.labels": { $in: ["lr:auto"] } }, else: "no lr:auto label" }],
  stages: [{ id: "a", entry: true, terminal: true, triggers: [{ when: { "run.stage": null } }] }],
};

/**
 * An entry trigger the allowlist refuses. decide() compiles every entry
 * stage's triggers to choose between several, and converge does not wrap
 * decide() — so this is a throw the tick itself has to catch rather than one
 * converge turns into a result. Not an identity: those are also asked while
 * the snapshot is built, which converge does wrap.
 */
const exploding: Workflow = {
  ...workflow,
  stages: [
    { id: "a", entry: true, terminal: true, triggers: [{ when: { $where: "1" } }] },
    { id: "b", entry: true, terminal: true, triggers: [{ when: { "run.stage": null } }] },
  ],
};

const itemNode = (id: string, labels: string[] = ["lr:auto"], assignees: string[] = [], priority: number | null = null): Node => ({
  id, kind: "item", title: `issue ${id}`, link: `u/${id}`, closed: null, priority, origin: null, state: { labels, assignees },
});

/** The rule a repository shared between two developers is actually filtered by. */
const mine = (login: string): Workflow => ({
  ...workflow,
  eligible: [{ when: { "node.state.assignees": { $in: [login] } }, else: "assigned to somebody else" }],
});

const source = (nodes: Node[]) => staticSource({ nodes, relationships: [] });

const quietPre = definePreHook({
  id: "fake",
  run: () => ({ entries: [] }),
});

function deps(overrides: Partial<TickOptions["deps"]> = {}): TickOptions["deps"] {
  return {
    workflow,
    steps: new Map<string, Step>(),
    pre: [quietPre],
    dispatcher: createDispatcher([]),
    executor: { id: "none", run: async () => ({ text: "", sessionId: null }) } as Executor,
    ctx: {
      config: {} as HookContext["config"],
      secrets: new Map(),
      signal: new AbortController().signal,
      log: () => {},
    } satisfies RuntimeContext,
    log: createLogger({ sink: () => {} }),
    ...overrides,
  };
}

/**
 * A promise a test resolves by hand, to hold an item's converge open.
 *
 * Every gate is released after the test whether it passed or not: a failed
 * assertion between opening one and closing it would otherwise leave a worker
 * blocked forever, and the file would hang instead of reporting the failure.
 */
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

/** Poll until a condition holds, rather than sleeping a guessed interval. */
async function until(predicate: () => boolean | Promise<boolean>, what: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lr-tick-"));
});

describe("tick", () => {
  it("acts on every eligible item", async () => {
    const out = await tick({ source: source([1, 2, 3].map((n) => itemNode(String(n)))), deps: deps(), lock: { root } });
    expect(out.map((r) => r.item)).toEqual(["1", "2", "3"]);
    expect(out.map((r) => r.outcome)).toEqual([
      "terminal after 1 pass(es)",
      "terminal after 1 pass(es)",
      "terminal after 1 pass(es)",
    ]);
  });

  // Eligible by its labels, and still nobody's work: it is a relationship's
  // far end, not an item the source lists.
  it("gives a placeholder no row and works nothing for it", async () => {
    const far: Node = { ...itemNode("x-far-5"), placeholder: true };
    const out = await tick({ source: source([itemNode("1"), far]), deps: deps(), lock: { root } });
    expect(out.map((r) => r.item)).toEqual(["1"]);
  });

  it("orders rows 9 before 10, as it did when ids were numbers", async () => {
    // Ineligible (no lr:auto label), so nothing converges and no lock is taken.
    const out = await tick({ source: source([itemNode("10", []), itemNode("9", [])]), deps: deps(), lock: { root } });
    expect(out.map((r) => r.item)).toEqual(["9", "10"]);
  });

  it("refuses a hostile id as that row's error and carries on with the rest", async () => {
    const out = await tick({ source: source([itemNode("../../etc"), itemNode("7", [])]), deps: deps(), lock: { root } });
    expect(out.find((r) => r.item === "../../etc")?.outcome).toMatch(/^error: .*item id/);
    expect(out.find((r) => r.item === "7")?.outcome).toMatch(/^skipped/);
  });

  it("skips a locked item without acting on it, and still does the others", async () => {
    const seen: string[] = [];
    const recording = definePreHook({
      id: "fake",
      run: ({ item }) => {
        seen.push(item);
        return { entries: [] };
      },
    });

    await acquire("1", "conversation", { root, holder: "mcp:ask" });
    const out = await tick({
      source: source([itemNode("1"), itemNode("2")]),
      deps: deps({ pre: [recording] }),
      lock: { root },
    });

    expect(out.find((r) => r.item === "1")?.outcome).toMatch(/locked by mcp:ask/);
    expect(out.find((r) => r.item === "2")?.outcome).not.toMatch(/locked/);
    // A skip is a skip: nothing about the locked item was read or decided.
    expect(seen).toEqual(["2"]);
    await release("1", { root });
  });

  it("releases each lock when the item is done", async () => {
    await tick({ source: source([itemNode("1")]), deps: deps(), lock: { root } });
    expect(await acquire("1", "tick", { root })).toBe(true);
    await release("1", { root });
  });

  it("releases the lock even when the item threw", async () => {
    const out = await tick({ source: source([itemNode("1")]), deps: deps({ workflow: exploding }), lock: { root } });

    expect(out[0]?.outcome).toMatch(/^error: .*\$where/);
    expect(await acquire("1", "tick", { root })).toBe(true);
    await release("1", { root });
  });

  it("reports an item that threw without abandoning the rest", async () => {
    const out = await tick({
      source: source([itemNode("1"), itemNode("2")]),
      deps: deps({ workflow: exploding }),
      lock: { root },
    });

    expect(out).toHaveLength(2);
    expect(out.map((r) => r.outcome)).toEqual([
      expect.stringMatching(/^error: /),
      expect.stringMatching(/^error: /),
    ]);
  });

  /*
   * An identity the allowlist refuses is asked of every item before any is
   * worked — where each one is, to tell a person of one that came to wait on
   * them — and that ask is no item's own row. It rejected the whole tick,
   * where a refused identity had always been one item's error.
   */
  it("reports each item whose stage's identity the allowlist refuses, and still finishes the tick", async () => {
    const refused: Workflow = { ...workflow, stages: [{ id: "a", entry: true, terminal: true, identity: { $where: "1" } }] };
    const out = await tick({ source: source([itemNode("1"), itemNode("2")]), deps: deps({ workflow: refused }), lock: { root } });

    expect(out.map((r) => r.item)).toEqual(["1", "2"]);
    for (const row of out) expect(row.outcome).toMatch(/operator \$where is not allowed in a predicate/);
  });

  it("reports an item whose hook rejected with something that is not an Error", async () => {
    const weird = definePreHook({
      id: "weird",
      run: () => {
        throw Object.assign(Object.create(null) as object, { message: "no prototype here" });
      },
    });
    const out = await tick({ source: source([itemNode("1")]), deps: deps({ pre: [weird] }), lock: { root } });

    // converge turns a pre-hook failure into a halt rather than a throw, so
    // what this pins is that the reason survives into the row either way —
    // "halt after 1 pass(es)" on its own tells an operator nothing.
    expect(out[0]?.outcome).toMatch(/no prototype here/);
  });

  it("keeps a reason that spans lines to one line", async () => {
    const shouty = definePreHook({
      id: "shouty",
      run: () => {
        throw new Error("first line\n#99 terminal after 1 pass(es)");
      },
    });
    const out = await tick({ source: source([itemNode("1")]), deps: deps({ pre: [shouty] }), lock: { root } });

    expect(out[0]?.outcome).not.toContain("\n");
  });

  /**
   * The reason mutual exclusion is per item and not "is a tick running":
   * one item's ten-minute agent must not stop every other item moving.
   */
  it("does not let one slow item hold up the others", async () => {
    const slow = gate();
    const done: string[] = [];
    const blocking = definePreHook({
      id: "blocking",
      run: async ({ item }) => {
        if (item === "1") await slow.wait;
        done.push(item);
        return { entries: [] };
      },
    });

    const running = tick({
      source: source([1, 2, 3].map((n) => itemNode(String(n)))),
      deps: deps({ pre: [blocking] }),
      concurrency: 3,
      lock: { root },
    });

    await until(() => done.includes("2") && done.includes("3"), "items 2 and 3 to finish while 1 is still blocked");
    expect(done).not.toContain("1");
    slow.open();
    await running;
    // Order between 2 and 3 is whichever won the race for a worker; what is
    // pinned is that neither of them waited on 1.
    expect(done.at(-1)).toBe("1");
    expect([...done].sort()).toEqual(["1", "2", "3"]);
  });

  it("never runs more items at once than the concurrency bound allows", async () => {
    const open = gate();
    let inFlight = 0;
    let peak = 0;
    const counting = definePreHook({
      id: "counting",
      run: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await open.wait;
        inFlight--;
        return { entries: [] };
      },
    });

    const running = tick({
      source: source([1, 2, 3, 4, 5].map((n) => itemNode(String(n)))),
      deps: deps({ pre: [counting] }),
      concurrency: 2,
      lock: { root },
    });

    // Every item blocks on one gate, so an unbounded implementation reaches
    // five in flight and this reaches two and stays there.
    await until(() => peak >= 2, "the bound to be reached");
    await new Promise((r) => setTimeout(r, 25));
    expect(peak).toBe(2);

    open.open();
    expect(await running).toHaveLength(5);
    expect(peak).toBe(2);
  });

  it("holds the item's lock for as long as it is working on it", async () => {
    const slow = gate();
    const blocking = definePreHook({
      id: "blocking",
      run: async () => {
        await slow.wait;
        return { entries: [] };
      },
    });

    const running = tick({ source: source([itemNode("1")]), deps: deps({ pre: [blocking] }), lock: { root } });

    await until(async () => (await held("1", { root })) !== null, "the tick to take the lock");
    expect((await held("1", { root }))?.kind).toBe("tick");
    expect(await acquire("1", "conversation", { root })).toBe(false);

    slow.open();
    await running;
    expect(await held("1", { root })).toBeNull();
  });

  it("skips an ineligible item with the workflow's own reason, and never locks it", async () => {
    const out = await tick({
      source: source([itemNode("1", []), itemNode("2")]),
      deps: deps(),
      lock: { root },
    });

    expect(out.find((r) => r.item === "1")?.outcome).toBe("skipped: no lr:auto label");
    expect(out.find((r) => r.item === "2")?.outcome).toMatch(/^terminal/);
    // Never locked, so there was never anything to release.
    expect(await acquire("1", "tick", { root })).toBe(true);
    await release("1", { root });
  });

  /**
   * The point of carrying the assignee on the listed node, measured rather than
   * asserted: a rule the tick cannot answer abstains, and abstaining means
   * eligible — so somebody else's item was enumerated, snapshot-built and
   * locked before converge skipped it. What this counts is the reads, because
   * "skipped" is the same word either way and the cost is the whole feature.
   */
  it("pays nothing for an item assigned to somebody else: no snapshot build, no lock", async () => {
    const read: string[] = [];
    const recording = definePreHook({
      id: "fake",
      run: ({ item }) => {
        read.push(item);
        return { entries: [] };
      },
    });

    const out = await tick({
      source: source([itemNode("1", ["lr:auto"], ["ann"]), itemNode("2", ["lr:auto"], ["bo"])]),
      deps: deps({ workflow: mine("ann"), pre: [recording] }),
      lock: { root },
    });

    expect(read).toEqual(["1"]);
    expect(out.find((r) => r.item === "2")?.outcome).toBe("skipped: assigned to somebody else");
    // Never locked either, so two instances on one machine never contend over
    // an item neither of them will work.
    expect(await acquire("2", "tick", { root })).toBe(true);
    await release("2", { root });
  });

  it("surfaces a failure to enumerate, rather than reporting an empty tick", async () => {
    const broken = defineSource({
      id: "broken",
      relations: [],
      read: async () => ({ nodes: [], relationships: [] }),
      list: async () => {
        throw new Error("GET /issues → 401");
      },
    });
    await expect(tick({ source: broken, deps: deps(), lock: { root } })).rejects.toThrow(/401/);
  });

  it("hands work out by priority, unprioritised last", async () => {
    const order: string[] = [];
    const recording = definePreHook({ id: "rec", provides: [], run: ({ item }) => { order.push(item); return {}; } });
    await tick({
      source: source([itemNode("1"), itemNode("2", ["lr:auto"], [], 0), itemNode("3", ["lr:auto"], [], 1)]),
      deps: deps({ pre: [recording] }), concurrency: 1, lock: { root },
    });
    expect(order[0]).toBe("2");
    expect(order.indexOf("3")).toBeLessThan(order.indexOf("1"));
  });

  it("never works a closed item, whatever labels it still carries", async () => {
    const read: string[] = [];
    const recording = definePreHook({ id: "rec", provides: [], run: ({ item }) => { read.push(item); return {}; } });
    const done: Node = { ...itemNode("1"), closed: "done" };
    const dropped: Node = { ...itemNode("3"), closed: "dropped" };
    const out = await tick({ source: source([done, itemNode("2"), dropped]), deps: deps({ pre: [recording] }), lock: { root } });
    expect(out.map((r) => r.item)).toEqual(["2"]);
    expect(read).toEqual(["2"]);
  });

  it("halts an item whose graph has a dangling edge, naming it, and still works the others", async () => {
    const one = itemNode("1");
    const two = itemNode("2");
    const byId: Record<string, Graph> = {
      "1": { nodes: [one], relationships: [{ from: "ghost", to: "1", type: "child-of" }] },
      "2": { nodes: [two], relationships: [] },
    };
    const split = defineSource({
      id: "split",
      relations: [{ type: "child-of", singular: true }],
      list: async () => ({ nodes: [one, two], relationships: [] }),
      read: async (id) => byId[id] ?? { nodes: [], relationships: [] },
    });
    const out = await tick({ source: split, deps: deps(), lock: { root } });
    expect(out.find((r) => r.item === "1")?.outcome).toMatch(/^halt.*ghost/);
    expect(out.find((r) => r.item === "2")?.outcome).toMatch(/^terminal/);
  });

  it("works only item nodes — a pull request in the list is not an item to converge", async () => {
    const pr: Node = { ...itemNode("pr-9"), kind: "pull-request" };
    const out = await tick({ source: source([itemNode("1", []), pr]), deps: deps(), lock: { root } });
    expect(out.map((r) => r.item)).toEqual(["1"]);
  });

  it("logs the tick's own boundaries, an acquired lock and a denied one", async () => {
    const seen: LandraceEvent[] = [];
    await acquire("1", "conversation", { root, holder: "mcp:ask" });
    await tick({
      source: source([itemNode("1"), itemNode("2")]),
      deps: deps({ log: createLogger({ sink: (e) => seen.push(e) }) }),
      lock: { root },
    });
    await release("1", { root });

    const names = seen.map((e) => e.name);
    expect(names[0]).toBe("tick.started");
    expect(names.at(-1)).toBe("tick.finished");
    expect(names).toContain("lock.denied");
    expect(names).toContain("lock.acquired");
    // Item 2's own: the board waits on its release before a list may
    // vouch for labels a step was changing.
    expect(names.indexOf("lock.released")).toBeGreaterThan(names.indexOf("lock.acquired"));
    expect(seen.find((e) => e.name === "lock.released")).toMatchObject({ item: "2", kind: "tick" });
  });
});

/*
 * #33: #29's own merge closed it mid-build, and its agent ran on until it was
 * killed by hand. Ticks overlap, so the next one lists the item while its
 * step still runs: closed, or no longer the workflow's to work, that run is
 * stopped, and a stopped run writes nothing.
 */
describe("an item stopped while its step runs", () => {
  const SPEC = '```json\n{"kind":"spec","title":"T"}\n```';

  async function world() {
    const state = createExternalState({ items: [{ id: "1", labels: ["lr:auto"] }] });
    const loaded = await loadWorkflow("tests/fixtures/minimal");
    const finish = gate();
    const runs: Array<{ round: number; stopped: boolean }> = [];
    // Runs until its run is stopped or the test lets it finish, and answers
    // either way: an answer got out as it was killed is the worst case for
    // "writes nothing".
    const executor: Executor = {
      id: "agent",
      run: async (_prompt, { round, signal }) => {
        const run = { round, stopped: false };
        runs.push(run);
        const stopped = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        await Promise.race([stopped, finish.wait]);
        run.stopped = signal.aborted;
        return { text: SPEC, sessionId: null };
      },
    };
    const events: LandraceEvent[] = [];
    const running = new Map<string, RunningItem>();
    const stop = new AbortController();
    const once = (source = state.source) => tick({
      source, running, lock: { root },
      deps: deps({
        workflow: { ...loaded.workflow, eligible: workflow.eligible ?? [] }, steps: loaded.steps,
        pre: [state.pre], dispatcher: createDispatcher([state.post]), executor,
        ctx: { config: {} as HookContext["config"], secrets: new Map(), signal: stop.signal, log: () => {} },
        log: createLogger({ sink: (e) => events.push(e) }),
      }),
    });
    const started = (n: number) => until(() => runs.length === n, `step run ${n} to start`);
    const aborted = () => events.filter((e) => e.name === "item.aborted");
    return { state, runs, events, running, stop, finish, once, started, aborted };
  }

  it("stops the step of an item closed while it ran, and writes nothing", async () => {
    const w = await world();
    const first = w.once();
    await w.started(1);
    const before = w.state.comments("1");
    w.state.item("1").closed = "done";

    await w.once();
    expect(w.aborted()).toEqual([expect.objectContaining({ item: "1", reason: "the item was closed" })]);
    expect((await first)[0]?.outcome).toMatch(/^halt .*the run was aborted/);
    expect(w.runs).toEqual([{ round: 1, stopped: true }]);
    expect(w.state.comments("1")).toEqual(before);
    expect(w.running.size).toBe(0);
    expect(await held("1", { root })).toBeNull();
  });

  it("stops it when lr:auto comes off, and runs the same round again once it is back on", async () => {
    const w = await world();
    const first = w.once();
    await w.started(1);
    w.state.unlabel("1", "lr:auto");

    expect(await w.once()).toEqual([{ item: "1", outcome: "skipped: no lr:auto label" }]);
    expect(w.aborted()).toEqual([expect.objectContaining({ item: "1", reason: "no lr:auto label" })]);
    await first;

    w.state.label("1", "lr:auto");
    const again = w.once();
    await w.started(2);
    w.finish.open();
    expect((await again)[0]?.outcome).toMatch(/^terminal/);
    expect(w.runs).toEqual([{ round: 1, stopped: true }, { round: 1, stopped: false }]);
  });

  it("leaves a run alone while its item is open and eligible, or missing from the list", async () => {
    const w = await world();
    const first = w.once();
    await w.started(1);

    await w.once();
    await w.once(source([]));
    // Only another item's relationship naming it, closed: that is not the item.
    await w.once(source([{ ...itemNode("1"), closed: "done", placeholder: true }]));
    expect(w.aborted()).toEqual([]);
    w.finish.open();
    expect((await first)[0]?.outcome).toMatch(/^terminal/);
    expect(w.runs).toEqual([{ round: 1, stopped: false }]);
  });

  it("still stops every run on Ctrl-C", async () => {
    const w = await world();
    const first = w.once();
    await w.started(1);
    w.stop.abort();
    expect((await first)[0]?.outcome).toMatch(/^halt .*the run was aborted/);
    expect(w.runs).toEqual([{ round: 1, stopped: true }]);
  });
});

describe("eligibilityOf", () => {
  it("reads the workflow's own rule off the labels a listed node already carries", () => {
    expect(eligibilityOf(workflow, itemNode("1"))).toEqual({ eligible: true });
    expect(eligibilityOf(workflow, itemNode("1", []))).toEqual({ eligible: false, reason: "no lr:auto label" });
  });

  /**
   * Abstain rather than guess: a rule reading anything a listed node cannot
   * carry is unanswerable from labels alone, and answering it "ineligible"
   * would silently park every item in the repository.
   */
  it("abstains when the rule reads something a listed node cannot answer", () => {
    // An equality against a derived path, not a range: mongo semantics make
    // `{ $lt: 3 }` match a *missing* field, so a rule written that way would
    // come back eligible with or without this guard — a test that could never
    // fail, pinning nothing.
    const derived: Workflow = {
      ...workflow,
      eligible: [{ when: { "run.stage": "spec" }, else: "not in the spec phase" }],
    };
    expect(eligibilityOf(derived, itemNode("1", []))).toEqual({ eligible: true });
  });

  /**
   * And who an item belongs to is answerable, not abstained on. It reads like
   * every other eligibility rule from here, and that is the claim: an instance
   * filtered to one developer decides the whole repository off what `list`
   * already returned.
   */
  it("answers a rule about who the item belongs to from the listed node itself", () => {
    expect(eligibilityOf(mine("ann"), itemNode("1", ["lr:auto"], ["ann"]))).toEqual({ eligible: true });
    expect(eligibilityOf(mine("ann"), itemNode("2", ["lr:auto"], ["bo", "cy"]))).toEqual({
      eligible: false,
      reason: "assigned to somebody else",
    });
  });

  /**
   * Nobody's item is nobody's. An empty list is a list — the rule is
   * answerable and claims nothing — where an absent one would be unanswerable,
   * and an unanswerable rule abstains, so every instance would work it.
   */
  it("leaves an unassigned item to nobody rather than to everybody", () => {
    expect(eligibilityOf(mine("ann"), itemNode("1"))).toEqual({
      eligible: false,
      reason: "assigned to somebody else",
    });
  });

  it("abstains for the whole rule set when only one rule is unanswerable", () => {
    const mixed: Workflow = {
      ...workflow,
      eligible: [
        { when: { "node.state.labels": { $in: ["lr:auto"] } }, else: "no lr:auto label" },
        { when: { "run.stage": "spec" }, else: "not in the spec phase" },
      ],
    };
    expect(eligibilityOf(mixed, itemNode("1", []))).toEqual({ eligible: true });
  });

  it("treats a workflow with no eligibility rule as taking every item", () => {
    const open: Workflow = { version: 1, name: "t", description: "test", stages: workflow.stages };
    expect(eligibilityOf(open, itemNode("1", []))).toEqual({ eligible: true });
  });
});

describe("statusLines", () => {
  it("renders position and reason in one line per item", () => {
    const lines = statusLines([
      { item: "12", title: "Add export", stage: "spec", note: "waiting on you" },
      { item: "15", title: "Old bug", stage: null, note: "skipped: no lr:auto label" },
    ]);
    expect(lines[0]).toMatch(/#12.*spec.*waiting on you/);
    expect(lines[1]).toMatch(/#15.*skipped: no lr:auto label/);
  });

  it("names the item, so a line is readable without opening the tracker", () => {
    const [line] = statusLines([{ item: "12", title: "Add export", stage: "spec", note: "queued" }]);
    expect(line).toContain("Add export");
  });

  it("lines the note column up across rows whose stages are different widths", () => {
    const [first, second] = statusLines([
      { item: "3", title: "a", stage: "spec", note: "queued" },
      { item: "4", title: "b", stage: "code-review", note: "working" },
    ]);
    expect((first as string).indexOf("queued")).toBe((second as string).indexOf("working"));
  });

  /**
   * A title is a tracker field anyone can write, and a status line is what a
   * person reads to decide what the loop is doing. A newline in a title would
   * let whoever opened the item print a row of their own.
   */
  it("cannot be made to print a second row by a title containing a newline", () => {
    const lines = statusLines([
      { item: "1", title: "fine\n#99    spec   waiting on you", stage: "spec", note: "queued" },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
  });

  it("strips the escape character out of a title, so a line cannot repaint the terminal", () => {
    const [line] = statusLines([
      { item: "1", title: "plain\u001b[31mred\u001b[0m\rrewritten", stage: null, note: "queued" },
    ]);
    // eslint-disable-next-line no-control-regex
    expect(line).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it("truncates a very long title rather than letting it run the line away", () => {
    const [line] = statusLines([{ item: "1", title: "x".repeat(200), stage: null, note: "queued" }]);
    expect((line as string).length).toBeLessThan(120);
    expect(line).toContain("…");
  });

  it("renders nothing for no rows", () => {
    expect(statusLines([])).toEqual([]);
  });

  // One workflow has nothing to tell apart: `[main]` on every row is noise.
  it("tags each item with its workflow only where the workspace has several", () => {
    const rows = [{ item: "12", title: "Add export", stage: "spec", note: "queued", workflow: "main" }, { item: "13", title: "Halted", stage: null, note: "halted: claimed by fast and main" }];
    expect(statusLines(rows)).toEqual([expect.stringMatching(/^#12 {2}spec {2}/), expect.stringMatching(/^#13 {2}— {2}/)]);
    expect(statusLines(rows, { several: true })).toEqual([expect.stringMatching(/^#12 \[main\] {2}spec {2}/), expect.stringMatching(/^#13 {9}— /)]);
  });
});

describe("onList", () => {
  it("hands over every node the source returned, eligible or not, once per tick", async () => {
    const root = await mkdtemp(join(tmpdir(), "lr-onlist-"));
    const seen: Graph[] = [];
    const listed = [itemNode("1"), itemNode("2", ["other"])];
    await tick({ source: source(listed), deps: deps(), lock: { root }, onList: (g) => seen.push(g) });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.nodes.map((n) => n.id)).toEqual(["1", "2"]);
  });

  it("hands the display the graph it listed", async () => {
    const root = await mkdtemp(join(tmpdir(), "lr-onlist-"));
    let listed: Graph | undefined;
    await tick({ source: source([itemNode("1", [])]), deps: deps(), lock: { root }, onList: (g) => { listed = g; } });
    expect(listed?.nodes.map((n) => n.id)).toEqual(["1"]);
  });

  it("does not stop the tick when the listener throws", async () => {
    const root = await mkdtemp(join(tmpdir(), "lr-onlist-"));
    const events: LandraceEvent[] = [];
    const log = createLogger({ sink: (e) => events.push(e) });
    const rows = await tick({
      source: source([itemNode("1")]), deps: deps({ log }), lock: { root },
      onList: () => { throw new Error("display broke"); },
    });
    expect(rows).toHaveLength(1);
    const failed = events.find((e) => e.name === "display.failed");
    expect(failed).toBeDefined();
    expect(failed?.reason).toContain("display broke");
  });
});
