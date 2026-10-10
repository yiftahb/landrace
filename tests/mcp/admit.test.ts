import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Executor, ExternalItem, ExternalState, HookContext, Registry, RuntimeContext, Step, Workflow, WorkflowRuntime, WorkspaceRuntime } from "#namespace.js";
import { createTools } from "#mcp/tools.js";
import { createDispatcher } from "#runner/effects.js";
import { createLogger } from "#runner/events.js";
import { tickWorkspace } from "#runner/tick.js";
import { createExternalState } from "#testing/index.js";
import { hooked, loaded } from "#tests/support/loaded.js";
import { loadWorkflow } from "#workflow/load.js";

/*
 * Admitting an item no workflow claims, shaped like this repository's two
 * workflows over one tracker: full-cycle admits `lr:auto` and turns away
 * `lr:fast` in its `eligible`; fastlane admits both and wants both.
 */
const SPEC = '```json\n{"kind":"spec","title":"T"}\n```';

let minimal: { workflow: Workflow; steps: Map<string, Step> };
beforeAll(async () => {
  minimal = await loadWorkflow("tests/fixtures/minimal");
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lr-admit-"));
});

const full = (): Workflow => ({
  ...minimal.workflow, name: "Full cycle", admit: ["lr:auto"],
  eligible: [
    { when: { "node.state.labels": { $in: ["lr:auto"] } }, else: "no lr:auto label" },
    { when: { "node.state.labels": { $nin: ["lr:fast"] } }, else: "a fastlane item (lr:fast)" },
  ],
});
const fast = (): Workflow => ({
  ...minimal.workflow, name: "Fastlane", admit: ["lr:auto", "lr:fast"],
  eligible: [
    { when: { "node.state.labels": { $in: ["lr:auto"] } }, else: "no lr:auto label" },
    { when: { "node.state.labels": { $in: ["lr:fast"] } }, else: "no lr:fast label" },
  ],
});

const registryOf = (state: ExternalState): Registry => ({
  preflights: [], pre: [state.pre], post: [state.post], artifacts: [], source: state.source, operator: state.operator,
  executors: new Map(), notifiers: new Map(),
});

const ctx = (): RuntimeContext => ({ config: {} as HookContext["config"], secrets: new Map(), signal: new AbortController().signal, log: () => {} });

/** Both workflows on one tracker, the tools over them, and one tick of the loop over the same. */
const world = (items: Array<Partial<ExternalItem>> = []) => {
  const state = createExternalState({ items });
  const registry = registryOf(state);
  const wake = jest.fn();
  const tools = createTools([
    hooked(registry, loaded(full(), minimal.steps, "full")),
    hooked(registry, loaded(fast(), minimal.steps, "fast")),
  ], ctx(), { wake });
  const ran: string[] = [];
  const agent = (id: string): Executor => ({ id, run: async () => { ran.push(id); return { text: SPEC, sessionId: null }; } });
  const log = createLogger({ sink: () => {} });
  const stop = new AbortController();
  const rctx: RuntimeContext = { ...ctx(), signal: stop.signal };
  const runtime: WorkspaceRuntime = {
    dir: root,
    workflows: [["full", full()], ["fast", fast()]].map(([id, workflow]): WorkflowRuntime => ({
      id: id as string, name: id as string, description: "test", source: state.source,
      deps: {
        workflow: workflow as Workflow, steps: minimal.steps, source: state.source, pre: [state.pre],
        dispatcher: createDispatcher([state.post]), executor: agent(id as string), ctx: rctx, log, scrub: (t) => t,
      },
    })),
    preflights: [], intervalMs: 60_000, concurrency: 3, agents: 0, checking: false, asking: [], turnedAway: [], stop, running: new Map(), seen: new Map(), log, ctx: rctx,
  };
  return { state, tools, wake, ran, tick: () => tickWorkspace({ runtime, lock: { root } }) };
};

describe("admitting an item no workflow claims", () => {
  it.each([
    ["full", ["lr:auto"]],
    ["fast", ["lr:auto", "lr:fast"]],
  ])("admits a bare item to %s, which alone claims it, and the next tick works it", async (workflow, labels) => {
    const w = world([{ id: "4", labels: ["bug"] }]);
    expect(await w.tick()).toEqual([{ item: "4", outcome: "skipped: no lr:auto label" }]);

    expect(await w.tools.admit("4", workflow)).toEqual({ item: "4", workflow, labels });
    expect(w.state.item("4").labels).toEqual(["bug", ...labels]);
    expect(w.wake).toHaveBeenCalledTimes(1);

    expect(await w.tick()).toEqual([{ item: "4", workflow, outcome: expect.stringMatching(/^terminal/) }]);
    expect(w.ran).toEqual([workflow]);
  });

  // Its lr:stage:* label is kept when its admit label goes, so it picks up where it stopped, not at the start.
  it("resumes an item that lost its admit label at the stage it stopped at", async () => {
    const w = world([{ id: "4", labels: ["lr:stage:done"] }]);
    await w.tools.admit("4", "full");
    expect(await w.tick()).toEqual([{ item: "4", workflow: "full", outcome: expect.any(String) }]);
    // Never started again at the entry stage: no step ran, and it stays where it was.
    expect(w.ran).toEqual([]);
    expect(w.state.stage("4")).toBe("done");
  });

  it("adds only the admit labels the item lacks", async () => {
    const w = world([{ id: "4", labels: ["lr:fast"] }]);
    expect(await w.tools.admit("4", "fast")).toEqual({ item: "4", workflow: "fast", labels: ["lr:auto"] });
    expect(w.state.item("4").labels).toEqual(["lr:fast", "lr:auto"]);
  });

  it("refuses an item carrying lr:fast to full-cycle, naming fastlane as the one that would claim it, and writes nothing", async () => {
    const w = world([{ id: "4", labels: ["lr:fast"] }]);
    await expect(w.tools.admit("4", "full")).rejects.toThrow("#4 would be claimed by fast, not full, with lr:auto added");
    expect(w.state.item("4").labels).toEqual(["lr:fast"]);
    expect(w.state.writes()).toEqual([]);
    expect(w.wake).not.toHaveBeenCalled();
  });

  it("refuses where the workflow's own eligible rule still turns the item away, with its else", async () => {
    const state = createExternalState({ items: [{ id: "4", labels: ["lr:fast"] }] });
    const registry = registryOf(state);
    // full-cycle alone: nobody else would claim it, and it still will not.
    const tools = createTools([hooked(registry, loaded(full(), minimal.steps, "full"))], ctx());
    await expect(tools.admit("4", "full")).rejects.toThrow("full would still turn #4 away, with lr:auto added: a fastlane item (lr:fast)");
    expect(state.writes()).toEqual([]);
  });

  /** full-cycle beside a workflow that wants lr:auto too, so the two can both claim one item. */
  const greedy = (items: Array<Partial<ExternalItem>>) => {
    const state = createExternalState({ items });
    const registry = registryOf(state);
    const tools = createTools([
      hooked(registry, loaded(full(), minimal.steps, "full")),
      hooked(registry, loaded({
        ...minimal.workflow, name: "Greedy", admit: ["lr:auto"],
        eligible: [{ when: { "node.state.labels": { $in: ["lr:auto"] } }, else: "no lr:auto label" }],
      }, minimal.steps, "greedy")),
    ], ctx());
    return { state, tools };
  };

  it("refuses where two workflows would claim it, naming both", async () => {
    const { state, tools } = greedy([{ id: "4" }]);
    await expect(tools.admit("4", "full")).rejects.toThrow("#4 would be claimed by full and greedy, with lr:auto added");
    expect(state.writes()).toEqual([]);
  });

  it("refuses an item two workflows claim now: a halt, not Not admitted", async () => {
    const { state, tools } = greedy([{ id: "4", labels: ["lr:auto"] }]);
    await expect(tools.admit("4", "full")).rejects.toThrow("#4 is claimed by full and greedy; act on it after one workflow alone claims it");
    expect(state.writes()).toEqual([]);
  });

  it("refuses an id two sources report: a halt, not Not admitted", async () => {
    const here = createExternalState({ items: [{ id: "4" }] });
    const there = createExternalState({ items: [{ id: "4" }] });
    const tools = createTools([
      hooked(registryOf(here), loaded(full(), minimal.steps, "full")),
      hooked(registryOf(there), loaded(fast(), minimal.steps, "fast")),
    ], ctx());
    await expect(tools.admit("4", "full")).rejects.toThrow("#4 is reported by the sources of fast and full; act on it after one source alone reports it");
    expect([here.writes(), there.writes()]).toEqual([[], []]);
  });

  it.each([
    ["a closed item", [{ id: "4", closed: "done" as const, labels: [] }], "4", "full", "#4 is closed, so nothing is written to it"],
    ["an item a workflow already claims", [{ id: "4", labels: ["lr:auto"] }], "4", "fast", "#4 is already in full"],
  ])("refuses %s, writing nothing", async (_what, items, item, workflow, said) => {
    const w = world(items);
    const before = [...w.state.item(item).labels];
    await expect(w.tools.admit(item, workflow)).rejects.toThrow(said);
    expect(w.state.item(item).labels).toEqual(before);
    expect(w.state.writes()).toEqual([]);
    expect(w.wake).not.toHaveBeenCalled();
  });

  it("refuses an item its workflow's source does not list, writing nothing", async () => {
    const here = createExternalState({ items: [{ id: "4" }] });
    const there = createExternalState({ items: [{ id: "9" }] });
    const tools = createTools([
      hooked(registryOf(here), loaded(full(), minimal.steps, "full")),
      hooked(registryOf(there), loaded(fast(), minimal.steps, "fast")),
    ], ctx());
    await expect(tools.admit("4", "fast")).rejects.toThrow("#4 is not listed by fast's source");
    expect([here.writes(), there.writes()]).toEqual([[], []]);
  });

  it("refuses a workflow that admits nothing, in createItem's words, writing nothing", async () => {
    const state = createExternalState({ items: [{ id: "4" }] });
    const { admit: _none, ...bare } = full();
    const tools = createTools([hooked(registryOf(state), loaded(bare, minimal.steps, "full"))], ctx());
    await expect(tools.admit("4", "full")).rejects.toThrow('workflow "full" admits nothing: add admit: [<labels>] to workflows/full/workflow.yaml');
    expect(state.writes()).toEqual([]);
  });

  it("refuses a workflow with no operator to write through, writing nothing", async () => {
    const state = createExternalState({ items: [{ id: "4" }] });
    const tools = createTools([hooked({ ...registryOf(state), operator: null }, loaded(full(), minimal.steps, "full"))], ctx());
    await expect(tools.admit("4", "full")).rejects.toThrow("cannot admit an item: no operator hook is configured");
    expect(state.writes()).toEqual([]);
  });

  it("refuses a workflow the workspace does not have, naming those it does", async () => {
    const w = world([{ id: "4" }]);
    await expect(w.tools.admit("4", "nope")).rejects.toThrow('no workflow "nope"; the workspace has full, fast');
  });

  it("refuses a workflow other than its own on a server bound to one", async () => {
    const state = createExternalState({ items: [{ id: "4" }] });
    const registry = registryOf(state);
    const tools = createTools([
      hooked(registry, loaded(full(), minimal.steps, "full")),
      hooked(registry, loaded(fast(), minimal.steps, "fast")),
    ], ctx(), { scope: "fast" });
    await expect(tools.admit("4", "full")).rejects.toThrow("this server acts for fast alone, not full");
    expect(await tools.admit("4", "fast")).toMatchObject({ workflow: "fast" });
  });

  it("refuses through a tracker that writes nothing, as every other write is", async () => {
    const state = createExternalState({ items: [{ id: "4" }], readOnly: true });
    const tools = createTools([hooked(registryOf(state), loaded(full(), minimal.steps, "full"))], ctx());
    await expect(tools.admit("4", "full")).rejects.toThrow(/read-only/);
    expect(state.item("4").labels).toEqual([]);
  });
});
