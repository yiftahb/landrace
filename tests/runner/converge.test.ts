import { converge } from "../../src/runner/converge.js";
import { createDispatcher } from "../../src/runner/effects.js";
import { createLogger } from "../../src/runner/events.js";
import { definePostHook, definePreHook, type HookContext } from "../../src/hooks/types.js";
import type { Executor } from "../../src/hooks/types.js";
import type { Step } from "../../src/workflow/load.js";
import type { Workflow } from "../../src/core/index.js";

// A tiny mutable stand-in for the outside world.
function world() {
  const labels = new Set<string>(["lr:auto"]);
  const entries: Array<Record<string, unknown>> = [];
  let clock = 0;
  return {
    labels, entries,
    pre: definePreHook({
      id: "w",
      run: () => ({ ticket: { labels: [...labels] }, entries: [...entries] }),
    }),
    post: definePostHook({
      id: "w",
      handles: ["tracker.status", "tracker.comment"],
      satisfied: (s, e) => {
        const present = (s.ticket as { labels?: string[] }).labels ?? [];
        if (e.type === "tracker.status") return present.includes(`lr:stage:${String(e.value)}`);
        return entries.some((x) => x.marker === e.marker);
      },
      apply: async (e) => {
        if (e.type === "tracker.status") {
          for (const l of [...labels]) if (l.startsWith("lr:stage:")) labels.delete(l);
          labels.add(`lr:stage:${String(e.value)}`);
        } else {
          entries.push({ marker: e.marker, at: clock++ });
        }
      },
    }),
  };
}

const workflow: Workflow = {
  version: 1, name: "t",
  stages: [
    { id: "a", entry: true, triggers: [{ when: { "run.stage": null } }], on_enter: [{ type: "tracker.status", value: "a" }] },
    { id: "b", terminal: true, triggers: [{ when: { "run.stage": "a" } }], on_enter: [{ type: "tracker.status", value: "b" }] },
  ],
};

const deps = (w: ReturnType<typeof world>, over: Record<string, unknown> = {}) => ({
  workflow,
  steps: new Map<string, Step>(),
  pre: [w.pre],
  dispatcher: createDispatcher([w.post]),
  executor: { id: "none", run: async () => ({ text: "", sessionId: null }) } as Executor,
  ctx: {
    ticket: 1, config: {} as HookContext["config"], secrets: new Map(),
    signal: new AbortController().signal, log: () => {},
  },
  log: createLogger({ sink: () => {} }),
  ...over,
});

describe("converge", () => {
  it("keeps acting until the ticket is terminal, in one call", async () => {
    const w = world();
    const r = await converge(1, deps(w));
    expect([...w.labels]).toContain("lr:stage:b");
    expect(r.passes).toBeGreaterThan(1);
  });

  it("re-reads between passes rather than simulating its own writes", async () => {
    const w = world();
    let reads = 0;
    const counting = definePreHook({
      id: "w",
      run: () => { reads++; return { ticket: { labels: [...w.labels] }, entries: [...w.entries] }; },
    });
    await converge(1, deps(w, { pre: [counting] }));
    expect(reads).toBeGreaterThan(1);
  });

  it("settles without acting when nothing has changed", async () => {
    const w = world();
    await converge(1, deps(w));
    const before = w.entries.length;
    const again = await converge(1, deps(w));
    expect(w.entries.length).toBe(before);
    expect(again.passes).toBe(1);
  });

  it("stops at a wait rather than spinning", async () => {
    const waiting: Workflow = {
      version: 1, name: "t",
      stages: [
        { id: "a", entry: true, triggers: [{ when: { "run.stage": null } }], on_enter: [{ type: "tracker.status", value: "a" }] },
        { id: "b", triggers: [{ when: { "run.stage": "a", "ticket.labels": { $in: ["never"] } } }] },
      ],
    };
    const r = await converge(1, deps(world(), { workflow: waiting }));
    expect(r.settled).toBe("wait");
  });

  it("stops at the pass cap and says so, rather than looping forever", async () => {
    const flipflop: Workflow = {
      version: 1, name: "t",
      stages: [
        { id: "a", entry: true, triggers: [{ when: { "run.stage": null } }, { when: { "run.stage": "b" } }], on_enter: [{ type: "tracker.status", value: "a" }] },
        { id: "b", triggers: [{ when: { "run.stage": "a" } }], on_enter: [{ type: "tracker.status", value: "b" }] },
      ],
    };
    const r = await converge(1, deps(world(), { workflow: flipflop, maxPasses: 6 }));
    expect(r.settled).toBe("cap");
    expect(r.passes).toBe(6);
  });

  it("emits an evaluation event per pass", async () => {
    const seen: string[] = [];
    await converge(1, deps(world(), { log: createLogger({ sink: (e) => seen.push(e.name) }) }));
    expect(seen.filter((n) => n === "ticket.evaluated").length).toBeGreaterThan(1);
  });

  // decide() halts on an ambiguous placement or ambiguous triggers rather than
  // picking one — converge must stop right there, not keep spinning through
  // passes as though "halt" were just another kind of "keep going".
  it("stops immediately on a halt decision, without exceeding one pass past it", async () => {
    const ambiguousTriggers: Workflow = {
      version: 1, name: "t",
      stages: [
        { id: "a", entry: true, triggers: [{ when: { "run.stage": null } }], on_enter: [{ type: "tracker.status", value: "a" }] },
        { id: "b", triggers: [{ name: "one", when: { "run.stage": "a" } }] },
        { id: "c", triggers: [{ name: "two", when: { "run.stage": "a" } }] },
      ],
    };
    const r = await converge(1, deps(world(), { workflow: ambiguousTriggers }));
    expect(r.settled).toBe("halt");
    expect(r.passes).toBe(2);
  });

  // The step contract is a hard fail, never a retry: a malformed step output
  // must stop the ticket in the same pass it was produced, and must not be
  // invoked again by a later pass of the same converge call.
  it("halts on a malformed step output without re-invoking the step", async () => {
    const w = world();
    let invocations = 0;
    const stepWorkflow: Workflow = {
      version: 1, name: "t",
      stages: [
        {
          id: "spec", step: "spec", entry: true,
          triggers: [{ when: { "run.stage": null } }],
          on_enter: [{ type: "tracker.status", value: "spec" }],
        },
        { id: "done", terminal: true, triggers: [{ when: { "run.outputs.spec": { $exists: true } } }] },
      ],
    };
    const step: Step = {
      prompt: "write the spec",
      output: {
        discriminator: "kind",
        shapes: { spec: {} },
        routes: [{ when: { kind: "spec" }, effect: { type: "artifact.publish", artifact: "spec" } }],
      },
    };
    const flakyExecutor: Executor = {
      id: "flaky",
      run: async () => {
        invocations++;
        return { text: "no json here, sorry", sessionId: null };
      },
    };
    const r = await converge(1, deps(w, {
      workflow: stepWorkflow,
      steps: new Map([["spec", step]]),
      executor: flakyExecutor,
      maxPasses: 10,
    }));
    expect(r.settled).toBe("halt");
    expect(invocations).toBe(1);
  });
});
