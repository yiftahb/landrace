import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExternalState } from "#testing/index.js";
import { createDispatcher } from "#runner/effects.js";
import { createLogger } from "#runner/events.js";
import { sendTo } from "#runner/goto.js";
import { tick } from "#tests/support/tick.js";
import type { Executor, HookContext, LandraceEvent, RunningItem, Step, Workflow } from "#namespace.js";

/*
 * A retro after a ticket is resolved, through the tick: a closed item is
 * work only where a workflow with a `closed: run` stage claims it, and a run
 * that started on a closed item is not stopped for being closed.
 */
const ENTER = { type: "tracker.comment", kind: "enter", marker: "enter:{stage}:{round}" };

const workflow: Workflow = {
  version: 1, name: "t", description: "test",
  eligible: [{ when: { "node.state.labels": { $in: ["lr:auto"] } }, else: "no lr:auto label" }],
  stages: [
    { id: "spec", entry: true, step: "spec", triggers: [{ when: { "run.stage": null } }], on_enter: [ENTER, { type: "tracker.status", value: "spec" }] },
    { id: "done", terminal: true, triggers: [{ when: { "run.outputs.spec": { $exists: true } } }], on_enter: [{ type: "tracker.status", value: "done" }] },
    {
      id: "retro", step: "retro", closed: "run",
      triggers: [{ name: "resolved", when: { "node.closed": "done" } }],
      on_enter: [ENTER, { type: "tracker.status", value: "retro" }],
    },
  ],
};

const answering = (kind: string): Step => ({
  prompt: kind,
  output: { discriminator: "kind", shapes: { [kind]: {} }, routes: [{ when: { kind }, effect: { type: "tracker.comment", marker: `${kind}:{round}` } }] },
});
const steps = new Map<string, Step>([["spec", answering("spec")], ["retro", answering("retro")]]);

const gates: Array<() => void> = [];
afterEach(() => {
  for (const open of gates.splice(0)) open();
});

async function until(predicate: () => boolean, what: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function world(item: { labels: string[]; closed?: "done" | "dropped" }, held = false, w: Workflow = workflow, broken = 0) {
  const root = await mkdtemp(join(tmpdir(), "lr-closed-"));
  const state = createExternalState({ items: [{ id: "1", ...item }] });
  let open!: () => void;
  const finish = new Promise<void>((resolve) => {
    open = resolve;
  });
  gates.push(open);
  const runs: Array<{ stage: string; stopped: boolean }> = [];
  const executor: Executor = {
    id: "agent",
    run: async (prompt, { signal }) => {
      const run = { stage: prompt, stopped: false };
      runs.push(run);
      if (held) {
        const stopped = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        await Promise.race([stopped, finish]);
      }
      run.stopped = signal.aborted;
      if (broken > 0) {
        broken -= 1;
        return { text: "no json here", sessionId: null };
      }
      return { text: `\`\`\`json\n{"kind":"${prompt}"}\n\`\`\``, sessionId: null };
    },
  };
  const events: LandraceEvent[] = [];
  const running = new Map<string, RunningItem>();
  const once = () => tick({
    source: state.source, running, lock: { root },
    deps: {
      workflow: w, steps, pre: [state.pre], dispatcher: createDispatcher([state.post]), executor,
      ctx: { config: {} as HookContext["config"], secrets: new Map(), signal: new AbortController().signal, log: () => {} },
      log: createLogger({ sink: (e) => events.push(e) }),
    },
  });
  const aborted = () => events.filter((e) => e.name === "item.aborted");
  const goto = (target: string | null) => sendTo({
    source: state.source, pre: [state.pre], dispatcher: createDispatcher([state.post]), workflow: w, lock: { root },
    ctx: { config: {} as HookContext["config"], secrets: new Map(), signal: new AbortController().signal, log: () => {} },
  }, "1", target);
  return { state, runs, once, open, aborted, goto };
}

describe("a closed item, through the tick", () => {
  it("enters retro when closed as done, runs its step once, and then rests there", async () => {
    const w = await world({ labels: ["lr:auto", "lr:stage:done"], closed: "done" });
    const [row] = await w.once();
    expect(row).toMatchObject({ item: "1", outcome: expect.stringMatching(/^wait .*rests at "retro"/) });
    expect(w.runs.map((r) => r.stage)).toEqual(["retro"]);
    expect(w.state.stage("1")).toBe("retro");

    await w.once();
    expect(w.runs).toHaveLength(1);
  });

  it("is not worked when closed as dropped, and says nothing of it", async () => {
    const w = await world({ labels: ["lr:auto", "lr:stage:done"], closed: "dropped" });
    expect(await w.once()).toEqual([]);
    expect(w.runs).toEqual([]);
  });

  it("is not worked when the workflow does not claim it", async () => {
    const w = await world({ labels: ["lr:stage:done"], closed: "done" });
    expect(await w.once()).toEqual([]);
  });

  it("stops a build its item was closed in the middle of", async () => {
    const w = await world({ labels: ["lr:auto"] }, true);
    const first = w.once();
    await until(() => w.runs.length === 1, "the spec step to start");
    w.state.item("1").closed = "done";

    void w.once();
    await until(() => w.aborted().length === 1, "the run to be stopped");
    expect(w.aborted()).toEqual([expect.objectContaining({ item: "1", reason: "the item was closed" })]);
    expect((await first)[0]?.outcome).toMatch(/aborted/);
    expect(w.runs[0]).toEqual({ stage: "spec", stopped: true });
  });

  it("lets a retro run on, the item closed when it started", async () => {
    const w = await world({ labels: ["lr:auto", "lr:stage:done"], closed: "done" }, true);
    const first = w.once();
    await until(() => w.runs.length === 1, "the retro step to start");

    await w.once();
    expect(w.aborted()).toEqual([]);
    w.open();
    expect((await first)[0]?.outcome).toMatch(/rests at "retro"/);
    expect(w.runs).toEqual([{ stage: "retro", stopped: false }]);
  });
});

/*
 * A retro whose step failed, retried by a person: retro lists itself
 * `retry: only`, and Retry — `landrace_goto` naming retro, or the board's,
 * naming nothing — reruns it once while the item stays closed and at retro.
 */
describe("a closed item's Retry at retro", () => {
  const retrying: Workflow = {
    ...workflow,
    stages: workflow.stages.map((s) => (s.id === "retro" ? { ...s, goto: [{ stage: "retro", retry: "only" as const }] } : s)),
  };
  const CLOSED_AT_DONE = { labels: ["lr:auto", "lr:stage:done"], closed: "done" as const };

  it.each([["the board's Retry", null], ["landrace_goto naming retro", "retro"]])("reruns the failed step once, by %s", async (_how, target) => {
    const w = await world(CLOSED_AT_DONE, false, retrying, 1);
    await w.once();
    expect(w.runs.map((r) => r.stage)).toEqual(["retro"]);
    await w.once();
    expect(w.runs).toHaveLength(1);

    expect(await w.goto(target)).toEqual({ to: "retro" });
    await w.once();
    expect(w.runs.map((r) => r.stage)).toEqual(["retro", "retro"]);
    expect(w.state.stage("1")).toBe("retro");
    expect(w.state.item("1").closed).toBe("done");

    await w.once();
    expect(w.runs).toHaveLength(2);
  });

  it("retries again after a second failure", async () => {
    const w = await world(CLOSED_AT_DONE, false, retrying, 2);
    await w.once();
    expect(await w.goto(null)).toEqual({ to: "retro" });
    await w.once();
    expect(await w.goto(null)).toEqual({ to: "retro" });
    await w.once();
    expect(w.runs).toHaveLength(3);
    await w.once();
    expect(w.runs).toHaveLength(3);
  });

  it("is refused where the round did not fail, saying nothing failed there", async () => {
    const w = await world(CLOSED_AT_DONE, false, retrying);
    await w.once();
    expect(w.runs).toHaveLength(1);
    for (const target of [null, "retro"]) {
      expect(await w.goto(target)).toEqual({ refused: expect.stringMatching(/#1 is closed and rests at "retro", where nothing failed/) });
    }
  });

  it("is refused where retro does not list itself retry: only, saying so", async () => {
    const w = await world(CLOSED_AT_DONE, false, workflow, 1);
    await w.once();
    expect(await w.goto(null)).toEqual({ refused: expect.stringMatching(/"retro" does not list itself with retry: only/) });
  });

  it("refuses a goto to any other stage, naming the one it may retry", async () => {
    const w = await world(CLOSED_AT_DONE, false, retrying, 1);
    await w.once();
    expect(await w.goto("spec")).toEqual({ refused: expect.stringMatching(/#1 is closed, so it is retried only at "retro".*not sent to "spec"/) });
  });

  it("refuses goto and Retry on a closed item at an ordinary stage, saying so", async () => {
    const w = await world({ labels: ["lr:auto", "lr:stage:done"], closed: "dropped" }, false, retrying);
    for (const target of [null, "retro", "spec"]) {
      expect(await w.goto(target)).toEqual({ refused: expect.stringMatching(/#1 is closed at "done", which runs nothing on a closed item, so there is nothing to send back/) });
    }
  });
});
