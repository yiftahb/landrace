import { converge } from "#runner/converge.js";
import { createDispatcher } from "#runner/effects.js";
import { createLogger } from "#runner/events.js";
import { defineArtifactHook, definePostHook, definePreHook, defineSource } from "#hooks/contracts.js";
import { labelsOf } from "#conventions.js";
import type { HookContext, Node, Source } from "#namespace.js";
import type { Executor } from "#namespace.js";
import type { Step } from "#namespace.js";
import type { Dispatcher, LandraceEvent, Workflow } from "#namespace.js";

/** Whatever ticket is asked for, alone in its graph, carrying the world's labels as they stand. */
const labelSource = (labels: Set<string>): Source => {
  const nodeOf = (id: string): Node => ({
    id, kind: "ticket", title: `ticket ${id}`, link: `u/${id}`, closed: null, priority: null, origin: null,
    state: { labels: [...labels], assignees: [] },
  });
  return defineSource({
    id: "w",
    relations: [],
    list: async () => ({ nodes: [nodeOf("1")], relationships: [] }),
    read: async (id) => ({ nodes: [nodeOf(id)], relationships: [] }),
  });
};

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
    source: labelSource(labels),
    pre: definePreHook({
      id: "w",
      run: () => ({ entries: [...entries] }),
    }),
    post: definePostHook({
      id: "w",
      handles: ["tracker.status", "tracker.comment"],
      satisfied: (s, e) => {
        const present = labelsOf(s.node as Node | undefined);
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
  source: w.source,
  pre: [w.pre],
  dispatcher: createDispatcher([w.post]),
  executor: { id: "none", run: async () => ({ text: "", sessionId: null }) } as Executor,
  ctx: {
    ticket: "1", config: {} as HookContext["config"], secrets: new Map(),
    signal: new AbortController().signal, log: () => {},
  },
  log: createLogger({ sink: () => {} }),
  ...over,
});

describe("converge", () => {
  it("keeps acting until the ticket is terminal, in one call", async () => {
    const w = world();
    const r = await converge("1", deps(w));
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
    await converge("1", deps(w, { pre: [counting] }));
    expect(reads).toBeGreaterThan(1);
  });

  it("settles without acting when nothing has changed", async () => {
    const w = world();
    await converge("1", deps(w));
    const before = w.entries.length;
    const again = await converge("1", deps(w));
    expect(w.entries.length).toBe(before);
    expect(again.passes).toBe(1);
  });

  it("stops at a wait rather than spinning", async () => {
    const waiting: Workflow = {
      version: 1, name: "t",
      stages: [
        { id: "a", entry: true, triggers: [{ when: { "run.stage": null } }], on_enter: [{ type: "tracker.status", value: "a" }] },
        { id: "b", triggers: [{ when: { "run.stage": "a", "node.state.labels": { $in: ["never"] } } }] },
      ],
    };
    const r = await converge("1", deps(world(), { workflow: waiting }));
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
    const r = await converge("1", deps(world(), { workflow: flipflop, maxPasses: 6 }));
    expect(r.settled).toBe("cap");
    expect(r.passes).toBe(6);
  });

  it("emits an evaluation event per pass", async () => {
    const seen: string[] = [];
    await converge("1", deps(world(), { log: createLogger({ sink: (e) => seen.push(e.name) }) }));
    expect(seen.filter((n) => n === "ticket.evaluated").length).toBeGreaterThan(1);
  });

  /**
   * Spec §14: `--debug` dumps the assembled snapshot per pass. It is the one
   * thing a decision was made from, and without it the log says what was
   * decided and never what it was decided on — which is exactly the question
   * asked when a ticket sits in a stage nobody expected.
   */
  it("dumps the snapshot it decided on, per pass, and only when debug is on", async () => {
    const quiet: LandraceEvent[] = [];
    await converge("1", deps(world(), { log: createLogger({ sink: (e) => quiet.push(e) }) }));
    expect(quiet.map((e) => e.name)).not.toContain("snapshot.built");

    const loud: LandraceEvent[] = [];
    await converge("1", deps(world(), { log: createLogger({ sink: (e) => loud.push(e), debug: true }) }));
    const dumps = loud.filter((e) => e.name === "snapshot.built");
    expect(dumps).toHaveLength(loud.filter((e) => e.name === "ticket.evaluated").length);
    expect(labelsOf((dumps[0]?.snapshot as { node?: Node })?.node)).toEqual(["lr:auto"]);
  });

  /**
   * §14 again: the debug dump is "the planned effects, and which of them
   * reconcile discarded and why". "discarded" on its own is the half that
   * reads as a bug — the operator is looking at an effect that did not happen
   * and needs to know which hook said it already had.
   */
  it("names the hook that decided a planned effect had already landed", async () => {
    const w = world();
    w.entries.push({
      stage: "a", kind: "enter", round: 1, marker: "m",
      data: { marker: "m" }, at: new Date(0).toISOString(), byAgent: true,
    });
    const twoEffects: Workflow = {
      version: 1, name: "t",
      stages: [{
        id: "a", entry: true, terminal: true,
        triggers: [{ when: { "run.stage": null } }],
        on_enter: [
          { type: "tracker.comment", kind: "enter", marker: "m", body: "x" },
          { type: "tracker.status", value: "a" },
        ],
      }],
    };

    const seen: LandraceEvent[] = [];
    await converge("1", deps(w, { workflow: twoEffects, log: createLogger({ sink: (e) => seen.push(e) }) }));

    expect(seen.find((e) => e.name === "effect.discarded")).toMatchObject({
      type: "tracker.comment",
      satisfiedBy: "w",
    });
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
    const r = await converge("1", deps(world(), { workflow: ambiguousTriggers }));
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
    const r = await converge("1", deps(w, {
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
    const r = await converge("1", deps(w, {
      workflow: stepWorkflow, steps: new Map([["spec", step]]), executor, maxPasses: 30,
    }));
    expect(r.settled).toBe("halt");
    expect(invocations).toBe(1);
  });

  // N6 (fix round 2) — the invoked-set halt above left no durable record, the
  // same gap M2 was raised to close for an unloaded step, in the same
  // commit. An operator looking at a ticket stuck here saw nothing.
  it("posts a durable record when the invoked-set guard trips, not just a log line", async () => {
    const w = world();
    const stepWorkflow: Workflow = {
      version: 1, name: "t",
      stages: [{
        id: "spec", step: "spec", entry: true,
        triggers: [{ when: { "run.stage": null } }],
        on_enter: [{ type: "tracker.status", value: "spec" }],
      }],
    };
    const step: Step = { prompt: "write the spec" };
    const executor: Executor = { id: "silent", run: async () => ({ text: "no json block", sessionId: null }) };
    await converge("1", deps(w, { workflow: stepWorkflow, steps: new Map([["spec", step]]), executor, maxPasses: 30 }));
    expect(w.entries.some((e) => String(e.marker ?? "").startsWith("malformed:spec"))).toBe(true);
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

      const r1 = await converge("1", deps(w, {
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
      const r2 = await converge("1", deps(w, {
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
    const r = await converge("1", deps(w, { dispatcher: createDispatcher([broken]) }));
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
      satisfied: (s, e) => labelsOf(s.node as Node | undefined).includes(`lr:stage:${String(e.value)}`),
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
    const pre = definePreHook({ id: "w", run: () => ({ entries: [] }) });
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

    const r = await converge("1", {
      workflow: stepWorkflow, steps: new Map([["spec", step]]), source: labelSource(labels), pre: [pre],
      dispatcher: createDispatcher([statusHook, boom]), executor,
      ctx: { ticket: "1", config: {} as HookContext["config"], secrets: new Map(), signal: new AbortController().signal, log: () => {} },
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
    const r = await converge("1", deps(w, { workflow: stepWorkflow, steps: new Map() }));
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
    await converge("1", deps(w, { workflow: stepWorkflow, steps: new Map([["spec", step]]), executor }));
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
    const fixedPoint = await converge("1", deps(world(), { workflow: noOnEnter }));
    expect(fixedPoint.settled).toBe("wait");
    expect(fixedPoint.why).toMatch(/nothing left to apply|fixed point/i);

    const waiting: Workflow = {
      version: 1, name: "t",
      stages: [
        { id: "a", entry: true, triggers: [{ when: { "run.stage": null } }], on_enter: [{ type: "tracker.status", value: "a" }] },
        { id: "b", triggers: [{ when: { "run.stage": "a", "node.state.labels": { $in: ["never"] } } }] },
      ],
    };
    const genuineWait = await converge("1", deps(world(), { workflow: waiting }));
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
      const r = await converge("1", deps(w, {
        pre: [counting],
        ctx: { ticket: "1", config: {} as HookContext["config"], secrets: new Map(), signal: controller.signal, log: () => {} },
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
      const r = await converge("1", deps(w, {
        pre: [counting],
        ctx: { ticket: "1", config: {} as HookContext["config"], secrets: new Map(), signal: controller.signal, log: () => {} },
      }));
      expect(reads).toBe(0);
      expect(r).toMatchObject({ passes: 0, settled: "halt" });
    });
  });

  // N1 (fix round 2) — `reason: (e as Error).message` in tryReconcile/tryApply
  // does not evaluate to undefined on a non-Error rejection, it *throws* —
  // I4's exact defect, reintroduced on the very path built to make a broken
  // hook legible instead of a crash. `effects.ts`'s own dispatcher happens to
  // re-wrap a hook's throw into a real Error first, which would hide this
  // specific bug behind that wrapping — so these use a hand-rolled Dispatcher
  // that throws directly, the same way a Dispatcher implementation that does
  // not go through effects.ts's createDispatcher legitimately could.
  describe("a non-Error rejection from a hand-rolled Dispatcher does not crash converge", () => {
    it("survives satisfied() throwing null directly", async () => {
      const raw: Dispatcher = {
        satisfied: () => { throw null; },
        apply: async () => {},
        handlerFor: () => null,
      };
      const r = await converge("1", deps(world(), { dispatcher: raw }));
      expect(r.settled).toBe("halt");
      expect(r.why).toBeTruthy();
    });

    it("survives apply() rejecting with null directly", async () => {
      const raw: Dispatcher = {
        satisfied: () => false,
        apply: async () => { throw null; },
        handlerFor: () => null,
      };
      const r = await converge("1", deps(world(), { dispatcher: raw }));
      expect(r.settled).toBe("halt");
      expect(r.why).toBeTruthy();
    });
  });

  // N3 — buildSnapshot() was called outside any try in converge, so a pre
  // hook's failure (already attributed and wrapped into a proper Error by
  // buildSnapshot itself) still escaped converge entirely as an unhandled
  // rejection. The GitHub pre hook does network I/O, so this is the likely
  // shape of a real failure, not an exotic one.
  it("halts (without throwing) when a pre hook fails, with the attributed message", async () => {
    const bad = definePreHook({ id: "bad", run: () => { throw new Error("tracker down"); } });
    const r = await converge("1", deps(world(), { pre: [bad] }));
    expect(r.settled).toBe("halt");
    expect(r.why).toMatch(/tracker down/);
  });

  // The same N1 class one level deeper: a pre hook is free to reject with
  // something that is not an Error too, and buildSnapshot's own wrapping
  // must not itself crash trying to describe that.
  it("halts (without throwing) when a pre hook rejects with a non-Error value", async () => {
    const bad = definePreHook({ id: "bad", run: () => { throw null; } });
    const r = await converge("1", deps(world(), { pre: [bad] }));
    expect(r.settled).toBe("halt");
    expect(r.why).toBeTruthy();
  });

  // N2 — a screening refusal is a verdict, not an outage: durable, terminal,
  // routed to blocked (spec §15). Classifying it as "unavailable" (round 1's
  // mistake) meant no durable record ever landed, so every single poll paid
  // for another screener call, forever, with nothing on the ticket to show
  // for it. Proof across three separate converge() calls on the same ticket,
  // matching the brief's own repro shape.
  it("posts a durable record for a screening refusal, so a later poll routes to blocked instead of re-screening forever", async () => {
    const w = world();
    let screenerCalls = 0;
    let agentCalls = 0;
    const screenedWorkflow: Workflow = {
      version: 1, name: "t",
      stages: [
        {
          id: "spec", step: "spec", entry: true,
          triggers: [{ when: { "run.stage": null } }],
          on_enter: [{ type: "tracker.status", value: "spec" }],
        },
        {
          id: "blocked",
          triggers: [{ when: { "run.lastOutputValid": false } }],
          on_enter: [{ type: "tracker.status", value: "blocked" }],
        },
      ],
    };
    const step: Step = {
      prompt: "go",
      output: { discriminator: "kind", shapes: { spec: {} }, routes: [{ when: { kind: "spec" }, effect: { type: "tracker.comment", marker: "spec:{round}" } }] },
    };
    const agentExecutor: Executor = { id: "agent", run: async () => { agentCalls++; return { text: "", sessionId: null }; } };
    const screener: Executor = {
      id: "screen",
      run: async () => { screenerCalls++; return { text: '```json\n{"verdict":"suspicious","reason":"nope"}\n```', sessionId: null }; },
    };

    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(await converge("1", deps(w, {
        workflow: screenedWorkflow, steps: new Map([["spec", step]]),
        executor: agentExecutor, screen: { executor: screener },
      })));
    }

    expect(screenerCalls).toBe(1);
    expect(agentCalls).toBe(0);
    expect(w.entries.length).toBeGreaterThan(0);
    expect([...w.labels]).toContain("lr:stage:blocked");
    expect(results[2]?.settled).not.toBe("halt");
  });

  // N2's reclassification routes a screening failure through
  // malformedEffect, so the screening executor's own error text — including
  // one that failed to run at all, not just one that returned a verdict —
  // now lands in a durable, *public* tracker comment. The shipped executor's
  // real message is "agent exited N: <up to 400 chars of stderr>", and a
  // secret can appear in stderr the same way it can appear anywhere else a
  // subprocess writes. Redaction until now was log-sink only; a comment body
  // is composed and posted entirely outside the logger.
  it("redacts a secret out of the screening executor's own error text before posting it", async () => {
    const w = world();
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
      output: { discriminator: "kind", shapes: { spec: {} }, routes: [{ when: { kind: "spec" }, effect: { type: "tracker.comment", marker: "spec:{round}" } }] },
    };
    const secretValue = "sk-supersecrettoken1234567890";
    const brokenScreener: Executor = {
      id: "screen",
      run: async () => { throw new Error(`agent exited 1: leaked ${secretValue} in stderr`); },
    };
    const agentExecutor: Executor = { id: "agent", run: async () => ({ text: "unused", sessionId: null }) };

    await converge("1", deps(w, {
      workflow: stepWorkflow, steps: new Map([["spec", step]]),
      executor: agentExecutor, screen: { executor: brokenScreener },
      ctx: {
        ticket: "1", config: {} as HookContext["config"], secrets: new Map([["token", secretValue]]),
        signal: new AbortController().signal, log: () => {},
      },
    }));

    const posted = w.entries.find((e) => String(e.marker ?? "").startsWith("malformed:"));
    expect(posted).toBeDefined();
    expect(String(posted?.body ?? "")).not.toContain(secretValue);
  });

  // Fix round 4: redactValuesFrom filtered on the *trimmed* length but
  // redacted with the *untrimmed* value — a secret sourced with surrounding
  // whitespace (a quoted .env line) passed the length check and then never
  // matched its own bare form anywhere it actually appeared in the posted
  // body.
  it("redacts a secret whose configured value has surrounding whitespace, matching its bare form", async () => {
    const w = world();
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
      output: { discriminator: "kind", shapes: { spec: {} }, routes: [{ when: { kind: "spec" }, effect: { type: "tracker.comment", marker: "spec:{round}" } }] },
    };
    const bareSecret = "sk-paddedsecrettoken1234567890";
    const brokenScreener: Executor = {
      id: "screen",
      run: async () => { throw new Error(`agent exited 1: leaked ${bareSecret} in stderr`); },
    };
    const agentExecutor: Executor = { id: "agent", run: async () => ({ text: "unused", sessionId: null }) };

    await converge("1", deps(w, {
      workflow: stepWorkflow, steps: new Map([["spec", step]]),
      executor: agentExecutor, screen: { executor: brokenScreener },
      ctx: {
        ticket: "1", config: {} as HookContext["config"], secrets: new Map([["token", `  ${bareSecret}  `]]),
        signal: new AbortController().signal, log: () => {},
      },
    }));

    const posted = w.entries.find((e) => String(e.marker ?? "").startsWith("malformed:"));
    expect(posted).toBeDefined();
    expect(String(posted?.body ?? "")).not.toContain(bareSecret);
  });
});

/**
 * A briefing is fetched for an invocation, not for a pass.
 *
 * §3.1 asks for artifact *state* every tick, and it is cheap because it is a
 * handful of scalars. A briefing is the opposite: an unbounded read of a
 * remote document, fetched so a step can act on the text. Built per pass it
 * would be paid for on every one of up to thirty, for the passes where no step
 * runs at all — which is most of them.
 */
describe("an artifact's briefing is built for the step, not for the pass", () => {
  const stepWorkflow: Workflow = {
    version: 1, name: "t",
    stages: [
      {
        id: "a", entry: true, step: "s.md",
        triggers: [{ when: { "run.stage": null } }],
        on_enter: [
          { type: "tracker.comment", kind: "enter", marker: "enter:{stage}:{round}", body: "in" },
          { type: "tracker.status", value: "a" },
        ],
      },
      {
        id: "b", terminal: true,
        triggers: [{ when: { "run.stage": "a", "run.counters.a": { $gte: 1 } } }],
        on_enter: [{ type: "tracker.status", value: "b" }],
      },
    ],
  };
  const step: Step = {
    prompt: "Address these:\n{brief.pr.threads}",
    output: {
      discriminator: "kind",
      shapes: { done: {} },
      routes: [{ when: { kind: "done" }, effect: { type: "tracker.comment", marker: "out:{round}" } }],
    },
  };

  const artifact = (brief: () => Record<string, string>) =>
    defineArtifactHook({
      id: "pr", handles: [], read: async () => ({}),
      satisfied: () => false, apply: async () => {}, brief,
    });

  it("asks once per invocation however many passes the call takes", async () => {
    const w = world();
    const prompts: string[] = [];
    let briefed = 0;
    const r = await converge("1", deps(w, {
      workflow: stepWorkflow,
      steps: new Map([["s.md", step]]),
      artifacts: [artifact(() => { briefed++; return { threads: "1. this leaks a handle" }; })],
      executor: {
        id: "f",
        run: async (prompt: string) => { prompts.push(prompt); return { text: '```json\n{"kind":"done"}\n```', sessionId: null }; },
      } as Executor,
    }));

    expect(r.settled).toBe("terminal");
    expect(r.passes).toBeGreaterThan(1);
    expect(briefed).toBe(1);
    expect(prompts[0]).toContain("this leaks a handle");
  });

  /*
   * A step asked to address findings it cannot see is the defect this whole
   * mechanism exists to close, so a briefing that will not read must stop the
   * ticket rather than quietly invoke the step with a placeholder where the
   * findings should be — which is indistinguishable, from inside the agent,
   * from a pull request with nothing on it.
   */
  it("halts before paying for the step when a briefing cannot be read", async () => {
    const w = world();
    let invoked = 0;
    const r = await converge("1", deps(w, {
      workflow: stepWorkflow,
      steps: new Map([["s.md", step]]),
      artifacts: [artifact(() => { throw new Error("the api said no"); })],
      executor: { id: "f", run: async () => { invoked++; return { text: "", sessionId: null }; } } as Executor,
    }));

    expect(invoked).toBe(0);
    expect(r.settled).toBe("halt");
    expect(r.why).toMatch(/briefing for hook "pr".*the api said no/);
  });
});

/**
 * §14: the evaluation event says where the ticket *is*, and it has to say
 * where it is going too.
 *
 * Without the destination the log cannot draw the position trail at all: the
 * last transition of a run is never evaluated from its own destination —
 * nothing evaluates a terminal ticket — so the stage a ticket actually ended
 * in appears nowhere in the stream. Reading it back off the tracker instead
 * means every reader of the log needs to know how that tracker stores a
 * position, which is the one thing the engine refuses to know.
 */
describe("the evaluation event carries the stage the ticket moved to", () => {
  it("names the destination of a transition, and null when it is not moving", async () => {
    const seen: LandraceEvent[] = [];
    await converge("1", deps(world(), { log: createLogger({ sink: (e) => seen.push(e) }) }));

    const evaluated = seen.filter((e) => e.name === "ticket.evaluated");
    expect(evaluated.map((e) => [e.stage, e.to])).toEqual([
      [null, "a"],
      ["a", "b"],
    ]);
  });
});

describe("step.started and step.finished", () => {
  const specWorkflow: Workflow = {
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
  const spec: Step = {
    prompt: "write the spec",
    model: "haiku",
    output: {
      discriminator: "kind",
      shapes: { spec: {} },
      routes: [{ when: { kind: "spec" }, effect: { type: "tracker.comment", marker: "spec:{round}" } }],
    },
  };
  const recorder = () => {
    const events: LandraceEvent[] = [];
    return { events, log: createLogger({ sink: (e) => events.push(e) }) };
  };
  const pairOf = (events: LandraceEvent[]) =>
    events.filter((e) => e.name === "step.started" || e.name === "step.finished").map((e) => e.name);

  it("brackets the invocation with the ticket, stage, round and model", async () => {
    const w = world();
    const { events, log } = recorder();
    const executor: Executor = { id: "ok", run: async () => ({ text: '```json\n{"kind":"spec"}\n```', sessionId: null }) };
    await converge("7", deps(w, { workflow: specWorkflow, steps: new Map([["spec", spec]]), executor, log }));

    const started = events.find((e) => e.name === "step.started");
    const finished = events.find((e) => e.name === "step.finished");
    expect(started).toMatchObject({ ticket: "7", stage: "spec", round: 1, model: "haiku" });
    expect(finished).toMatchObject({ ticket: "7", stage: "spec", round: 1, ok: true });
    expect(pairOf(events)).toEqual(["step.started", "step.finished"]);
  });

  it("says the step did not succeed when the executor throws", async () => {
    // runStep catches an executor's throw and returns {ok:false}, so this
    // pins the `ok` field — not the finally. The next test pins the finally.
    const w = world();
    const { events, log } = recorder();
    const executor: Executor = { id: "boom", run: async () => { throw new Error("gone"); } };
    await converge("7", deps(w, { workflow: specWorkflow, steps: new Map([["spec", spec]]), executor, log }));

    expect(pairOf(events)).toEqual(["step.started", "step.finished"]);
    expect(events.find((e) => e.name === "step.finished")).toMatchObject({ ticket: "7", ok: false });
  });

  it("still finishes when runStep itself throws", async () => {
    // Everything inside runStep catches its own failures except the logger:
    // it calls log("step.invoked") outside any try. A sink that throws — a
    // display with a bug in it, which is exactly what the triage board is —
    // throws straight out of runStep. That is the case the finally exists for.
    const w = world();
    const events: LandraceEvent[] = [];
    const log = createLogger({
      sink: (e) => {
        events.push(e);
        if (e.name === "step.invoked") throw new Error("display broke");
      },
    });
    const executor: Executor = { id: "ok", run: async () => ({ text: '```json\n{"kind":"spec"}\n```', sessionId: null }) };
    await converge("7", deps(w, { workflow: specWorkflow, steps: new Map([["spec", spec]]), executor, log })).catch(() => {});

    expect(pairOf(events)).toEqual(["step.started", "step.finished"]);
    expect(events.find((e) => e.name === "step.finished")).toMatchObject({ ticket: "7", ok: false });
  });

  it("still finishes when the step is refused before the agent runs", async () => {
    // ConvergeDeps.screen is `{ executor: Executor }`, not a bare predicate
    // function — the brief's stub (`async () => ({ ok: false, reason })`)
    // does not match that type. Built instead as an executor whose reply
    // screenPrompt (src/agent/screen.ts) reads as a blocking verdict, the
    // same shape the existing screening tests above already use.
    const w = world();
    const { events, log } = recorder();
    const executor: Executor = { id: "ok", run: async () => ({ text: "", sessionId: null }) };
    const screener: Executor = {
      id: "screen",
      run: async () => ({ text: '```json\n{"verdict":"suspicious","reason":"suspicious"}\n```', sessionId: null }),
    };
    await converge("7", deps(w, {
      workflow: specWorkflow, steps: new Map([["spec", spec]]), executor, log, screen: { executor: screener },
    }));

    // Tightened from comparing the counts of step.started and step.finished,
    // which would pass at 0/0: this also pins that both fired, and in order.
    expect(pairOf(events)).toEqual(["step.started", "step.finished"]);
  });
});
