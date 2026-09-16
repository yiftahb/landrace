import { validateSemantics } from "../../src/workflow/validate.js";
import type { Step } from "../../src/workflow/load.js";
import type { Effect, Workflow } from "../../src/core/types.js";

const noSteps = new Map<string, Step>();
const rules = (w: Workflow, steps = noSteps, provided?: string[]) =>
  validateSemantics(w, steps, provided).map((p) => p.rule);

describe("semantic validation", () => {
  it("flags a loop with no counter bound", () => {
    const w: Workflow = { version: 1, name: "t", stages: [
      { id: "a", entry: true, triggers: [{ when: { "run.stage": "b" } }] },
      { id: "b", triggers: [{ when: { "run.stage": "a" } }] },
    ] };
    expect(rules(w)).toContain("cycle-bound");
  });

  it("accepts a loop bounded by a counter comparison", () => {
    const w: Workflow = { version: 1, name: "t", stages: [
      { id: "a", entry: true, triggers: [{ when: { "run.stage": "b", "run.counters.a": { $lt: 3 } } }] },
      { id: "b", triggers: [{ when: { "run.stage": "a" } }] },
    ] };
    expect(rules(w)).not.toContain("cycle-bound");
  });

  describe("a stage that runs a step must record that it was entered", () => {
    const step = new Map<string, Step>([["s.md", {
      prompt: "",
      output: { discriminator: "kind", shapes: { ok: {} }, routes: [{ when: { kind: "ok" }, effect: { type: "x" } }] },
    }]]);
    const entryRecord = { type: "tracker.comment", kind: "enter", marker: "enter:{stage}:{round}" };

    const looping = (aOnEnter: Effect[]): Workflow => ({
      version: 1, name: "t", stages: [
        { id: "a", entry: true, step: "s.md", on_enter: aOnEnter,
          triggers: [{ when: { "run.stage": "b", "run.counters.a": { $lt: 3 } } }] },
        { id: "b", triggers: [{ when: { "run.stage": "a" } }] },
      ],
    });

    /*
     * Without an entry record assess() reads a stage's first round as its
     * last one forever, so the loop runs its body exactly once and the ticket
     * ping-pongs between two "complete" stages until the pass cap. Silent, and
     * paid for in agent invocations, so it is caught here rather than there.
     */
    it("flags a stepped stage in a cycle that records no entry", () => {
      expect(rules(looping([{ type: "tracker.status", value: "a" }]), step)).toContain("entry-record");
    });

    it("accepts one that does", () => {
      expect(rules(looping([entryRecord, { type: "tracker.status", value: "a" }]), step)).not.toContain("entry-record");
    });

    /*
     * A record that is identical every time round is reconciled away as
     * already satisfied the second time, which stalls the loop exactly as
     * having no record at all does — and looks fine in the file.
     */
    it("flags an entry record that does not name the round, since the second one is dropped as a duplicate", () => {
      const fixed = { type: "tracker.comment", kind: "enter", marker: "enter:a" };
      expect(rules(looping([fixed]), step)).toContain("entry-record");
    });

    it("does not ask a stage with no step to record anything", () => {
      const w: Workflow = { version: 1, name: "t", stages: [
        { id: "a", entry: true, triggers: [{ when: { "run.stage": "b", "run.counters.a": { $lt: 3 } } }] },
        { id: "b", triggers: [{ when: { "run.stage": "a" } }] },
      ] };
      expect(rules(w)).not.toContain("entry-record");
    });

    /*
     * Deliberately not scoped to the stages on a cycle. Whether a stage is on
     * one is a question about the derived run.stage graph, and that graph
     * abstains whenever a trigger mentions run.stage in a way edges() cannot
     * read — which `{ "run.stage": null }`, how every entry trigger is
     * written, does. A cycle-scoped rule therefore reported nothing at all on
     * the shipped workflow, and a rule that silently stops checking is worse
     * than none.
     */
    it("asks a stage on no cycle at all, because whether it is on one is not reliably knowable", () => {
      const w: Workflow = { version: 1, name: "t", stages: [
        { id: "a", entry: true, step: "s.md", triggers: [{ when: { "run.stage": null } }] },
        { id: "b", terminal: true, triggers: [{ when: { "run.stage": "a" } }] },
      ] };
      expect(rules(w, step)).toContain("entry-record");
    });

    it("still checks a graph no other rule will look at", () => {
      const w: Workflow = { version: 1, name: "t", stages: [
        { id: "a", entry: true, step: "s.md",
          triggers: [{ when: { $or: [{ "run.stage": "b" }], "run.counters.a": { $lt: 3 } } }] },
        { id: "b", triggers: [{ when: { "run.stage": "a" } }] },
      ] };
      expect(rules(w, step)).toContain("entry-record");
      expect(rules(w, step)).not.toContain("cycle-bound");
    });
  });

  it("flags a declared output shape with no route", () => {
    const steps = new Map<string, Step>([["s.md", {
      prompt: "",
      output: { discriminator: "kind", shapes: { spec: {}, questions: {} },
                routes: [{ when: { kind: "spec" }, effect: { type: "x" } }] },
    }]]);
    const w: Workflow = { version: 1, name: "t", stages: [{ id: "a", entry: true, step: "s.md" }] };
    expect(rules(w, steps)).toContain("totality");
  });

  it("flags two stages whose identities can both hold", () => {
    const w: Workflow = { version: 1, name: "t", stages: [
      { id: "a", entry: true, identity: { "run.stage": "a" } },
      { id: "b", identity: { "run.stage": "a" } },
    ] };
    expect(rules(w)).toContain("identity");
  });

  it("flags a non-terminal stage nothing leads away from", () => {
    const w: Workflow = { version: 1, name: "t", stages: [
      { id: "a", entry: true, triggers: [{ when: { "run.stage": "z" } }] },
      { id: "b", triggers: [{ when: { "run.stage": "a" } }] },
    ] };
    expect(rules(w)).toContain("dead-end");
  });

  it("flags a predicate path nothing provides", () => {
    const w: Workflow = { version: 1, name: "t", stages: [
      { id: "a", entry: true, triggers: [{ when: { "ticket.nonsense": 1 } }] },
    ] };
    expect(rules(w, noSteps, ["ticket.labels", "run.stage"])).toContain("path-coverage");
  });

  it("checks no paths when no hook declares what it provides", () => {
    const w: Workflow = { version: 1, name: "t", stages: [
      { id: "a", entry: true, triggers: [{ when: { "ticket.nonsense": 1 } }] },
    ] };
    expect(rules(w, noSteps, undefined)).not.toContain("path-coverage");
  });

  it("abstains cycle-bound and dead-end across the whole graph when a trigger nests run.stage inside $or", () => {
    // a <-> b is a genuinely unbounded loop expressed with plain top-level
    // anchors — on its own it would trip cycle-bound. Stage c's trigger hides
    // its run.stage mentions inside $or, which edges() cannot see, so the
    // derived graph is missing edges and both rules must abstain entirely
    // rather than report on the part they can see.
    const w: Workflow = { version: 1, name: "t", stages: [
      { id: "a", entry: true, triggers: [{ when: { "run.stage": "b" } }] },
      { id: "b", triggers: [{ when: { "run.stage": "a" } }] },
      { id: "c", triggers: [{ when: { $or: [{ "run.stage": "a" }, { "run.stage": "b" }] } }] },
    ] };
    const found = rules(w);
    expect(found).not.toContain("cycle-bound");
    expect(found).not.toContain("dead-end");
  });

  it("fully analyses a graph whose triggers use only plain top-level run.stage anchors", () => {
    const w: Workflow = { version: 1, name: "t", stages: [
      { id: "a", entry: true, triggers: [{ when: { "run.stage": "b" } }] },
      { id: "b", triggers: [{ when: { "run.stage": "a" } }] },
    ] };
    expect(rules(w)).toContain("cycle-bound");
  });

  it("reports a three-stage cycle exactly once regardless of which stage the DFS starts from", () => {
    const w: Workflow = { version: 1, name: "t", stages: [
      { id: "a", entry: true, triggers: [{ when: { "run.stage": "c" } }] },
      { id: "b", triggers: [{ when: { "run.stage": "a" } }] },
      { id: "c", triggers: [{ when: { "run.stage": "b" } }] },
    ] };
    const cycleProblems = validateSemantics(w, noSteps).filter((p) => p.rule === "cycle-bound");
    expect(cycleProblems).toHaveLength(1);
  });

  it("reports an unbounded cycle even when it shares a hub stage with a bounded one", () => {
    // hub -> a -> b -> hub is bounded (the b -> hub edge, i.e. hub's trigger
    // naming "b", carries a run.counters bound). hub -> c -> d -> hub is not
    // bounded anywhere. Both loops pass through "hub", so a whole-component
    // SCC check would let the bounded loop silence the unbounded one; this
    // must still report the c/d loop as unbounded.
    const w: Workflow = { version: 1, name: "t", stages: [
      { id: "hub", entry: true, triggers: [
        { when: { "run.stage": "b", "run.counters.hub": { $lt: 5 } } },
        { when: { "run.stage": "d" } },
      ] },
      { id: "a", triggers: [{ when: { "run.stage": "hub" } }] },
      { id: "b", triggers: [{ when: { "run.stage": "a" } }] },
      { id: "c", triggers: [{ when: { "run.stage": "hub" } }] },
      { id: "d", triggers: [{ when: { "run.stage": "c" } }] },
    ] };
    const cycleProblems = validateSemantics(w, noSteps).filter((p) => p.rule === "cycle-bound");
    expect(cycleProblems).toHaveLength(1);
    expect(cycleProblems[0]?.message).toBe(
      "the cycle among stages c, d, hub is not bounded by a run.counters.* comparison",
    );
  });

  it("handles a densely connected graph of many stages quickly instead of enumerating every simple path", () => {
    // Every stage triggers off every other stage: one strongly connected
    // component of 12 members. The old path-enumeration implementation was
    // combinatorial in the number of simple paths through a graph like this
    // (measured: 4.4M paths for 24 stages with only 3 inbound triggers
    // each, and a memory crash at just 10 densely connected stages); Tarjan's
    // algorithm is linear in stages + edges, so this must stay fast and
    // report sensibly regardless of density.
    const n = 12;
    const ids = Array.from({ length: n }, (_, i) => `s${i}`);
    const stages: Workflow["stages"] = ids.map((id, i) => ({
      id,
      entry: i === 0,
      triggers: ids.filter((other) => other !== id).map((other) => ({ when: { "run.stage": other } })),
    }));
    const w: Workflow = { version: 1, name: "t", stages };

    const start = Date.now();
    const cycleProblems = validateSemantics(w, noSteps).filter((p) => p.rule === "cycle-bound");
    expect(Date.now() - start).toBeLessThan(2000);
    // One strongly connected component containing every stage is one real
    // cycle, so exactly one problem, not one per simple path through it.
    expect(cycleProblems).toHaveLength(1);
  });

  it("recognizes a counter bound nested under $and, not just at the top level", () => {
    const w: Workflow = { version: 1, name: "t", stages: [
      { id: "a", entry: true, triggers: [
        { when: { "run.stage": "b", $and: [{ "run.counters.a": { $lt: 3 } }] } },
      ] },
      { id: "b", triggers: [{ when: { "run.stage": "a" } }] },
    ] };
    expect(rules(w)).not.toContain("cycle-bound");
  });

  // C1 — a stage with a step but no declared output can never be marked
  // complete by assess() (it only ever sees run.outputs[stage.id] ===
  // undefined), so decide() invokes it forever. This was live in the shipped
  // .landrace/workflow.yaml for build, code-review and fix-review: 30 paid
  // opus invocations in a single converge() call, then the same again on the
  // next poll. Under current assess() semantics such a stage is
  // unreachable-past, so it belongs with the other reachability rules.
  it("flags a stage whose step declares no output, since assess() can never mark it complete", () => {
    const steps = new Map<string, Step>([["s.md", { prompt: "go" }]]);
    const w: Workflow = { version: 1, name: "t", stages: [
      { id: "a", entry: true, step: "s.md", triggers: [{ when: { "run.outputs.a": { $exists: true } } }] },
    ] };
    expect(rules(w, steps)).toContain("step-output-required");
  });

  it("does not flag a stage with a step that does declare an output", () => {
    const steps = new Map<string, Step>([["s.md", {
      prompt: "go",
      output: { discriminator: "kind", shapes: { done: {} }, routes: [{ when: { kind: "done" }, effect: { type: "x" } }] },
    }]]);
    const w: Workflow = { version: 1, name: "t", stages: [{ id: "a", entry: true, step: "s.md" }] };
    expect(rules(w, steps)).not.toContain("step-output-required");
  });

  it("does not flag a stage with no step at all", () => {
    const w: Workflow = { version: 1, name: "t", stages: [{ id: "a", entry: true, terminal: true }] };
    expect(rules(w)).not.toContain("step-output-required");
  });

  // N5 — declaring an output block is not sufficient: assess() only counts
  // an entry of kind "output" against *this* stage's own id, and a route's
  // effect can override both fields. A step whose only route retargets
  // `kind` away from "output" (or `stage` away from its own stage) can still
  // never complete, the same way a step with no output block at all cannot —
  // the runtime invoked-set guard catches this too (defence in depth), but
  // the validator is where an author should learn it, before it ever runs.
  it("flags a stage whose only route overrides kind: off \"output\", so it can never actually complete", () => {
    const steps = new Map<string, Step>([["s.md", {
      prompt: "go",
      output: {
        discriminator: "kind",
        shapes: { done: {} },
        routes: [{ when: { kind: "done" }, effect: { type: "tracker.comment", kind: "note" } }],
      },
    }]]);
    const w: Workflow = { version: 1, name: "t", stages: [{ id: "a", entry: true, step: "s.md" }] };
    expect(rules(w, steps)).toContain("step-output-required");
  });

  it("flags a stage whose only route retargets stage: to a different stage", () => {
    const steps = new Map<string, Step>([["s.md", {
      prompt: "go",
      output: {
        discriminator: "kind",
        shapes: { done: {} },
        routes: [{ when: { kind: "done" }, effect: { type: "tracker.comment", stage: "elsewhere" } }],
      },
    }]]);
    const w: Workflow = { version: 1, name: "t", stages: [{ id: "a", entry: true, step: "s.md" }] };
    expect(rules(w, steps)).toContain("step-output-required");
  });

  it("does not flag a step where at least one route produces a genuine same-stage output entry", () => {
    const steps = new Map<string, Step>([["s.md", {
      prompt: "go",
      output: {
        discriminator: "kind",
        shapes: { done: {}, note: {} },
        routes: [
          // Overrides away from "output" — this route alone would flag.
          { when: { kind: "note" }, effect: { type: "tracker.comment", kind: "note" } },
          // Leaves kind/stage at their defaults — this one is enough to save it.
          { when: { kind: "done" }, effect: { type: "tracker.comment" } },
        ],
      },
    }]]);
    const w: Workflow = { version: 1, name: "t", stages: [{ id: "a", entry: true, step: "s.md" }] };
    expect(rules(w, steps)).not.toContain("step-output-required");
  });

  it("flags a stage that is structurally connected but unreachable from the entry stage", () => {
    // b and c point at each other, but nothing (not even indirectly) leads
    // to either of them from the entry stage a.
    const w: Workflow = { version: 1, name: "t", stages: [
      { id: "a", entry: true, terminal: true },
      { id: "b", triggers: [{ when: { "run.stage": "c" } }] },
      { id: "c", triggers: [{ when: { "run.stage": "b" } }] },
    ] };
    expect(rules(w)).toContain("reachability");
  });
});
