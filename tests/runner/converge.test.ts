import { converge } from "../../src/runner/converge.js";
import { createDispatcher } from "../../src/runner/effects.js";
import { createLogger } from "../../src/runner/events.js";
import { definePostHook, definePreHook, type HookContext } from "../../src/hooks/types.js";
import type { Executor } from "../../src/hooks/types.js";
import type { Step } from "../../src/workflow/load.js";
import type { Workflow } from "../../src/core/index.js";

// A tiny mutable stand-in for the outside world.
//
// The pushed "entries" are shaped as real core Entry objects (stage/kind/
// round/data/at/byAgent), not just {marker, at}: deriveRun only recognises
// kind "output" (to populate run.outputs and run.counters) and kind
// "malformed" (to populate run.failedStages) when those fields are actually
// present. A fixture that dropped them could never demonstrate a step
// actually completing or a retry actually succeeding — every stage would
// look "pending" forever regardless of what converge did, which would have
// hidden rather than exercised the fix-round behaviour below.
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
          entries.push({
            stage: String(e.stage ?? "-"),
            kind: String(e.kind ?? "note"),
            round: Number(e.round ?? 0),
            data: { marker: e.marker },
            marker: e.marker,
            body: String(e.body ?? ""),
            at: new Date(clock++).toISOString(),
            byAgent: true,
          });
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

  // C1 — the worst defect the review found, live in the shipped
  // .landrace/workflow.yaml: a stage whose step declares no output can never
  // be marked complete by assess(), so decide() invokes it again on every
  // single pass with no memory that it just ran. Measured against the real
  // file: 30 paid opus invocations in one converge() call, then cap, then
  // the same again on the next poll. This is the general case — any hook
  // whose apply() "succeeds" but leaves nothing readable back loops the same
  // way, which is why the fix lives here (a per-call fixed-point check) and
  // not only in validate.ts (which only catches the *no output declared*
  // special case, and only before the workflow ever runs).
  it("halts a stage that keeps deciding the same invoke, instead of re-invoking it every pass", async () => {
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
    // No output: block — exactly the shipped defect. runStep returns
    // {ok: true, effects: []} on every call, so run.outputs.spec is never
    // set and decide() computes the same round (1) forever.
    const step: Step = { prompt: "write the spec" };
    const executor: Executor = {
      id: "silent",
      run: async () => { invocations++; return { text: "done, but no json block", sessionId: null }; },
    };
    const r = await converge(1, deps(w, {
      workflow: stepWorkflow, steps: new Map([["spec", step]]), executor, maxPasses: 30,
    }));
    expect(r.settled).toBe("halt");
    expect(invocations).toBe(1);
  });

  // C3 — CLAUDE.md's hard-fail rule is about *output*: a step whose output
  // was rejected has produced nothing. A step that never ran (the executor
  // threw — a network blip, a timeout, a Ctrl-C) is the opposite case, and
  // collapsing the two permanently poisoned a stage that had nothing to
  // reject. Proof: the same ticket, same stage, first an outage then a
  // recovery, across two separate converge() calls — the second one must
  // actually retry and actually reach the end, not stay stuck on the first
  // call's non-event forever.
  describe("a step that never ran does not permanently block the stage it was trying to leave", () => {
    const stepWorkflowFor = (): Workflow => ({
      version: 1, name: "t",
      stages: [
        {
          id: "spec", step: "spec", entry: true,
          triggers: [{ when: { "run.stage": null } }],
          on_enter: [{ type: "tracker.status", value: "spec" }],
        },
        {
          id: "done", terminal: true,
          triggers: [{ when: { "run.outputs.spec": { $exists: true } } }],
          on_enter: [{ type: "tracker.status", value: "done" }],
        },
      ],
    });
    const stepFor = (): Step => ({
      prompt: "write the spec",
      output: {
        discriminator: "kind",
        shapes: { spec: {} },
        routes: [{ when: { kind: "spec" }, effect: { type: "tracker.comment", marker: "spec:{round}" } }],
      },
    });

    it("does not post any durable record for the outage, and retries successfully once it ends", async () => {
      const w = world();
      let invocations = 0;
      const aborted: Executor = {
        id: "aborted",
        run: async () => { invocations++; throw new Error("The operation was aborted"); },
      };

      const r1 = await converge(1, deps(w, {
        workflow: stepWorkflowFor(), steps: new Map([["spec", stepFor()]]), executor: aborted,
      }));
      expect(r1.settled).toBe("halt");
      expect(invocations).toBe(1);
      // The whole point: nothing was produced, so nothing should have been
      // recorded as rejected.
      expect(w.entries).toHaveLength(0);

      const healthy: Executor = {
        id: "healthy",
        run: async () => { invocations++; return { text: '```json\n{"kind":"spec"}\n```', sessionId: null }; },
      };
      const r2 = await converge(1, deps(w, {
        workflow: stepWorkflowFor(), steps: new Map([["spec", stepFor()]]), executor: healthy,
      }));
      expect(invocations).toBe(2);
      expect(r2.settled).toBe("terminal");
      expect([...w.labels]).toContain("lr:stage:done");
    });
  });

  // I4 — CLAUDE.md says errors report, they do not crash. The dispatcher's
  // satisfied() rethrows a throwing hook's error (attributed) rather than
  // treating it as "not satisfied", by design — but converge called it from
  // inside reconcile() with nothing catching the throw, so a broken hook
  // escaped converge entirely as an unhandled rejection with no halt record
  // and no event, even though ConvergeResult promises a value, not a crash.
  it("halts (without throwing) when a post hook's satisfied() throws while reconciling a transition", async () => {
    const broken = definePostHook({
      id: "broken",
      handles: ["tracker.status"],
      satisfied: () => { throw new Error("cannot tell"); },
      apply: async () => {},
    });
    const w = world();
    const r = await converge(1, deps(w, { dispatcher: createDispatcher([broken]) }));
    expect(r.settled).toBe("halt");
  });

  // The same crash risk exists on the other side of the dispatcher — apply()
  // can throw too (a rate limit, a broken hook) — and it is reached from the
  // invoke path as well as the transition path, so both must be guarded the
  // same way, not just the one satisfied() repro the review happened to run.
  it("halts (without throwing) when applying a step's own output effect fails", async () => {
    const labels = new Set<string>(["lr:auto"]);
    const statusHook = definePostHook({
      id: "status",
      handles: ["tracker.status"],
      satisfied: (s, e) => ((s.ticket as { labels?: string[] })?.labels ?? []).includes(`lr:stage:${String(e.value)}`),
      apply: async (e) => {
        for (const l of [...labels]) if (l.startsWith("lr:stage:")) labels.delete(l);
        labels.add(`lr:stage:${String(e.value)}`);
      },
    });
    const boom = definePostHook({
      id: "boom", handles: ["tracker.comment"],
      satisfied: () => false,
      apply: async () => { throw new Error("rate limited"); },
    });
    const pre = definePreHook({ id: "w", run: () => ({ ticket: { labels: [...labels] }, entries: [] }) });
    const stepWorkflow: Workflow = {
      version: 1, name: "t",
      stages: [{
        id: "spec", step: "spec", entry: true,
        triggers: [{ when: { "run.stage": null } }],
        on_enter: [{ type: "tracker.status", value: "spec" }],
      }],
    };
    const step: Step = {
      prompt: "go",
      output: {
        discriminator: "kind",
        shapes: { spec: {} },
        routes: [{ when: { kind: "spec" }, effect: { type: "tracker.comment", marker: "spec:{round}" } }],
      },
    };
    const executor: Executor = { id: "e", run: async () => ({ text: '```json\n{"kind":"spec"}\n```', sessionId: null }) };

    const r = await converge(1, {
      workflow: stepWorkflow, steps: new Map([["spec", step]]), pre: [pre],
      dispatcher: createDispatcher([statusHook, boom]), executor,
      ctx: { ticket: 1, config: {} as HookContext["config"], secrets: new Map(), signal: new AbortController().signal, log: () => {} },
      log: createLogger({ sink: () => {} }),
    });
    expect(r.settled).toBe("halt");
  });

  // M2 — the malformed path already posts a durable record when a step
  // breaks its output contract; a stage naming a step that failed to load at
  // all halted with zero trace, leaving an operator looking at a stuck
  // ticket with nothing explaining why.
  it("posts a durable record when a stage names a step that was never loaded", async () => {
    const w = world();
    const stepWorkflow: Workflow = {
      version: 1, name: "t",
      stages: [{
        id: "spec", step: "spec", entry: true,
        triggers: [{ when: { "run.stage": null } }],
        on_enter: [{ type: "tracker.status", value: "spec" }],
      }],
    };
    // "spec" is named by the stage but never loaded into `steps`.
    const r = await converge(1, deps(w, { workflow: stepWorkflow, steps: new Map() }));
    expect(r.settled).toBe("halt");
    expect(w.entries.length).toBeGreaterThan(0);
    expect(w.entries.some((e) => String(e.marker ?? "").startsWith("malformed:spec"))).toBe(true);
  });

  // I3 — an agent-chosen (or, here, a workflow-declared) value is unbounded.
  // step.ts now bounds the *unvalidated* discriminator value it reports, but
  // a validated shape name can still be arbitrarily long (it is whatever the
  // workflow author wrote), and that name is embedded whole into an
  // "ambiguous route" / "no route claims it" reason — this is converge's own,
  // independent cap on the body it assembles from that reason, regardless of
  // where the length came from.
  it("caps the assembled malformed comment body even when the underlying reason is very large", async () => {
    const w = world();
    const hugeShape = "s".repeat(5000);
    const stepWorkflow: Workflow = {
      version: 1, name: "t",
      stages: [{
        id: "spec", step: "spec", entry: true,
        triggers: [{ when: { "run.stage": null } }],
        on_enter: [{ type: "tracker.status", value: "spec" }],
      }],
    };
    const step: Step = {
      prompt: "go",
      output: {
        discriminator: "kind",
        shapes: { [hugeShape]: {} },
        // The condition demands a field the model's output will not carry,
        // so the validated shape still matches no route.
        routes: [{ when: { kind: hugeShape, extra: true }, effect: { type: "tracker.comment", marker: "x" } }],
      },
    };
    const executor: Executor = {
      id: "e",
      run: async () => ({ text: `\`\`\`json\n${JSON.stringify({ kind: hugeShape })}\n\`\`\``, sessionId: null }),
    };
    await converge(1, deps(w, { workflow: stepWorkflow, steps: new Map([["spec", step]]), executor }));
    const posted = w.entries.find((e) => String(e.marker ?? "").startsWith("malformed:"));
    expect(posted).toBeDefined();
    expect(String(posted?.body ?? "").length).toBeLessThan(5000);
  });

  // M1 — a transition into a stage with nothing left to apply reports the
  // same settled: "wait" as a genuine wait on a human or an external trigger,
  // even though the two are completely different situations. The `why` on
  // the result is what makes them distinguishable without also cross-
  // referencing the whole log stream.
  it("says why it settled at a wait: a fixed point after a transition, distinct from a genuine wait on a trigger", async () => {
    const noOnEnter: Workflow = {
      version: 1, name: "t",
      stages: [{ id: "a", entry: true, triggers: [{ when: { "run.stage": null } }] }],
    };
    const fixedPoint = await converge(1, deps(world(), { workflow: noOnEnter }));
    expect(fixedPoint.settled).toBe("wait");
    expect(fixedPoint.why).toMatch(/nothing left to apply|fixed point/i);

    const waiting: Workflow = {
      version: 1, name: "t",
      stages: [
        { id: "a", entry: true, triggers: [{ when: { "run.stage": null } }], on_enter: [{ type: "tracker.status", value: "a" }] },
        { id: "b", triggers: [{ when: { "run.stage": "a", "ticket.labels": { $in: ["never"] } } }] },
      ],
    };
    const genuineWait = await converge(1, deps(world(), { workflow: waiting }));
    expect(genuineWait.settled).toBe("wait");
    expect(genuineWait.why).toBeTruthy();
    expect(genuineWait.why).not.toMatch(/nothing left to apply|fixed point/i);
  });

  // Ctrl-C between passes: nothing in the loop previously consulted the
  // abort signal itself (only the executor did, deep inside runStep), so an
  // abort that landed between two passes was not noticed until whatever ran
  // next happened to touch something that checked it.
  describe("checks the abort signal at the top of every pass", () => {
    it("does not start another pass (or build another snapshot) once the signal is aborted mid-call", async () => {
      const w = world();
      const controller = new AbortController();
      let reads = 0;
      const counting = definePreHook({
        id: "w",
        run: () => {
          reads++;
          if (reads === 1) controller.abort();
          return { ticket: { labels: [...w.labels] }, entries: [...w.entries] };
        },
      });
      const r = await converge(1, deps(w, {
        pre: [counting],
        ctx: { ticket: 1, config: {} as HookContext["config"], secrets: new Map(), signal: controller.signal, log: () => {} },
      }));
      expect(reads).toBe(1);
      expect(r.settled).toBe("halt");
    });

    it("does nothing at all when the signal is already aborted before the first pass", async () => {
      const w = world();
      const controller = new AbortController();
      controller.abort();
      let reads = 0;
      const counting = definePreHook({
        id: "w",
        run: () => { reads++; return { ticket: { labels: [...w.labels] }, entries: [...w.entries] }; },
      });
      const r = await converge(1, deps(w, {
        pre: [counting],
        ctx: { ticket: 1, config: {} as HookContext["config"], secrets: new Map(), signal: controller.signal, log: () => {} },
      }));
      expect(reads).toBe(0);
      expect(r).toMatchObject({ passes: 0, settled: "halt" });
    });
  });
});
