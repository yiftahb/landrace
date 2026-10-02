import { validate, validateSemantics } from "#workflow/validate.js";
import { loadWorkflow } from "#workflow/load.js";
import { loadShipped } from "#tests/support/shipped.js";
import type { Effect, Problem, Step, Workflow } from "#namespace.js";
import { fastest } from "#tests/support/timing.js";

const noSteps = new Map<string, Step>();
const rules = (w: Workflow, steps = noSteps, provided?: string[]) =>
  validateSemantics(w, steps, provided).map((p) => p.rule);

describe("semantic validation", () => {
  it("flags a loop with no counter bound", () => {
    const w: Workflow = { version: 1, name: "t", description: "test", stages: [
      { id: "a", entry: true, triggers: [{ when: { "run.stage": "b" } }] },
      { id: "b", triggers: [{ when: { "run.stage": "a" } }] },
    ] };
    expect(rules(w)).toContain("cycle-bound");
  });

  /*
   * A loop that waits for a person's message every time round cannot run away
   * on its own: each lap needs someone to write. Triage's loops are this
   * shape, and a round cap on them only cut a real conversation short.
   */
  it("accepts a loop one of whose edges waits for a person to write", () => {
    const w: Workflow = { version: 1, name: "t", description: "test", stages: [
      { id: "a", entry: true, triggers: [{ when: { "run.stage": "b" } }] },
      { id: "b", triggers: [{ when: { "run.stage": "a", "run.lastEvent.actor": "human" } }] },
    ] };
    expect(rules(w)).not.toContain("cycle-bound");
  });

  it("still flags a loop whose actor check is anything but a person, exactly", () => {
    for (const actor of [{ $ne: "human" }, "agent", { $in: ["human", "agent"] }]) {
      const w: Workflow = { version: 1, name: "t", description: "test", stages: [
        { id: "a", entry: true, triggers: [{ when: { "run.stage": "b" } }] },
        { id: "b", triggers: [{ when: { "run.stage": "a", "run.lastEvent.actor": actor } }] },
      ] };
      expect(rules(w)).toContain("cycle-bound");
    }
  });

  it("accepts a loop bounded by a counter comparison", () => {
    const w: Workflow = { version: 1, name: "t", description: "test", stages: [
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
      version: 1, name: "t", description: "test", stages: [
        { id: "a", entry: true, step: "s.md", on_enter: aOnEnter,
          triggers: [{ when: { "run.stage": "b", "run.counters.a": { $lt: 3 } } }] },
        { id: "b", triggers: [{ when: { "run.stage": "a" } }] },
      ],
    });

    /*
     * Without an entry record assess() reads a stage's first round as its
     * last one forever, so the loop runs its body exactly once and the item
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
      const w: Workflow = { version: 1, name: "t", description: "test", stages: [
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
      const w: Workflow = { version: 1, name: "t", description: "test", stages: [
        { id: "a", entry: true, step: "s.md", triggers: [{ when: { "run.stage": null } }] },
        { id: "b", terminal: true, triggers: [{ when: { "run.stage": "a" } }] },
      ] };
      expect(rules(w, step)).toContain("entry-record");
    });

    it("still checks a graph no other rule will look at", () => {
      const w: Workflow = { version: 1, name: "t", description: "test", stages: [
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
    const w: Workflow = { version: 1, name: "t", description: "test", stages: [{ id: "a", entry: true, step: "s.md" }] };
    expect(rules(w, steps)).toContain("totality");
  });

  /*
   * A declared shape decides which of an agent's fields become snapshot state,
   * so a field it names but the engine can never carry is a rule that silently
   * does nothing: the value is dropped at the step boundary (a reserved id is
   * not a name, it is a reachable key on a plain object), the trigger reading
   * it never matches, and the item waits forever with nothing to explain it.
   */
  it("flags a declared shape field that can never travel, because it is a reserved object key", () => {
    const steps = new Map<string, Step>([["s.md", {
      prompt: "",
      // A computed key, because `__proto__:` written plainly in an object
      // literal is the prototype setter and defines no own property at all —
      // the shape would have no such field and this would test nothing. YAML
      // does define it as an own key (confirmed against the parser the loader
      // uses), so a real step file reaches this rule; a literal does not.
      output: { discriminator: "kind", shapes: { spec: { ["__proto__"]: "string", title: "string" } },
                routes: [{ when: { kind: "spec" }, effect: { type: "x" } }] },
    }]]);
    const w: Workflow = { version: 1, name: "t", description: "test", stages: [{ id: "a", entry: true, step: "s.md" }] };
    expect(rules(w, steps)).toContain("shape-field");
  });

  it("does not flag an ordinary declared field", () => {
    const steps = new Map<string, Step>([["s.md", {
      prompt: "",
      output: { discriminator: "kind", shapes: { spec: { title: "string" } },
                routes: [{ when: { kind: "spec" }, effect: { type: "x" } }] },
    }]]);
    const w: Workflow = { version: 1, name: "t", description: "test", stages: [{ id: "a", entry: true, step: "s.md" }] };
    expect(rules(w, steps)).not.toContain("shape-field");
  });

  it("flags two stages whose identities can both hold", () => {
    const w: Workflow = { version: 1, name: "t", description: "test", stages: [
      { id: "a", entry: true, identity: { "run.stage": "a" } },
      { id: "b", identity: { "run.stage": "a" } },
    ] };
    expect(rules(w)).toContain("identity");
  });

  it("flags a non-terminal stage nothing leads away from", () => {
    const w: Workflow = { version: 1, name: "t", description: "test", stages: [
      { id: "a", entry: true, triggers: [{ when: { "run.stage": "z" } }] },
      { id: "b", triggers: [{ when: { "run.stage": "a" } }] },
    ] };
    expect(rules(w)).toContain("dead-end");
  });

  it("flags a predicate path nothing provides", () => {
    const w: Workflow = { version: 1, name: "t", description: "test", stages: [
      { id: "a", entry: true, triggers: [{ when: { "item.nonsense": 1 } }] },
    ] };
    expect(rules(w, noSteps, ["item.labels", "run.stage"])).toContain("path-coverage");
  });

  it("points a retired `ticket` path at its new name", () => {
    const w: Workflow = { version: 1, name: "t", description: "test", stages: [
      { id: "a", entry: true, triggers: [{ when: { "ticket.labels": "x" } }] },
    ] };
    const messages = validateSemantics(w, noSteps, ["item.labels", "run.stage"])
      .filter((p) => p.rule === "path-coverage").map((p) => p.message);
    expect(messages).toEqual([
      'stage "a" reads ticket.labels, which no hook provides; "ticket.labels" is now "item.labels"',
    ]);
  });

  /*
   * An eligibility rule reads the same snapshot every trigger does, and an
   * uncovered path there is the quieter failure of the two: a trigger that
   * matches nothing leaves one item where it is, while an `eligible` rule
   * that matches nothing skips *every* item in the repository — reported by
   * `status` as the workflow's own `else`, which reads exactly like the rule
   * working. `item.assignee` beside a hook providing `item.assignees` is
   * the shape it arrives in.
   */
  it("flags an eligibility rule reading a path nothing provides", () => {
    const w: Workflow = {
      version: 1, name: "t", description: "test",
      eligible: [{ when: { "item.assignee": "ann" }, else: "not yours" }],
      stages: [{ id: "a", entry: true, triggers: [{ when: { "run.stage": null } }] }],
    };
    expect(rules(w, noSteps, ["item.assignees", "run.stage"])).toContain("path-coverage");
  });

  it("says nothing about an eligibility rule reading a path a hook does provide", () => {
    const w: Workflow = {
      version: 1, name: "t", description: "test",
      eligible: [{ when: { "item.assignees": { $in: ["ann"] } }, else: "not yours" }],
      stages: [{ id: "a", entry: true, triggers: [{ when: { "run.stage": null } }] }],
    };
    expect(rules(w, noSteps, ["item.assignees", "run.stage"])).not.toContain("path-coverage");
  });

  it("checks no paths when no hook declares what it provides", () => {
    const w: Workflow = { version: 1, name: "t", description: "test", stages: [
      { id: "a", entry: true, triggers: [{ when: { "item.nonsense": 1 } }] },
    ] };
    expect(rules(w, noSteps, undefined)).not.toContain("path-coverage");
  });

  /*
   * A trigger whose run.stage mention edges() cannot read — nested under $or,
   * an $in list, a $ne — used to switch all three graph rules off for the
   * whole workflow. It does not any more: each rule reads the approximation
   * that cannot invent a problem, so a hidden edge weakens an answer rather
   * than withdrawing every answer.
   */
  it("still reports a cycle of plain anchors when another trigger hides its run.stage inside $or", () => {
    // a <-> b is a genuinely unbounded loop written with plain anchors. Stage
    // c's hidden edges can only *add* cycles to the graph, never remove this
    // one, so reporting it is not a guess about the part that cannot be seen.
    const w: Workflow = { version: 1, name: "t", description: "test", stages: [
      { id: "a", entry: true, triggers: [{ when: { "run.stage": "b" } }] },
      { id: "b", triggers: [{ when: { "run.stage": "a" } }] },
      { id: "c", triggers: [{ when: { $or: [{ "run.stage": "a" }, { "run.stage": "b" }] } }] },
    ] };
    expect(rules(w)).toContain("cycle-bound");
  });

  it("does not credit a hidden trigger with being a way out of the stage that owns it", () => {
    // decide() never evaluates the current stage's own triggers, so whatever
    // c's condition hides, it is not an edge *from* c — and c is a dead end.
    const w: Workflow = { version: 1, name: "t", description: "test", stages: [
      { id: "a", entry: true, triggers: [{ when: { "run.stage": null } }] },
      { id: "b", terminal: true, triggers: [{ when: { "run.stage": "a" } }] },
      { id: "c", triggers: [{ when: { $or: [{ "run.stage": "a" }] } }] },
    ] };
    expect(rules(w).filter((r) => r === "dead-end")).toEqual(["dead-end"]);
  });

  it("treats a trigger that names no stage as reachable from anywhere but its own stage", () => {
    // `blocked` in the shipped workflow: `{ "run.lastOutputValid": false }`
    // says nothing about position, so it can fire wherever the item is.
    // Counting it as no edge at all reported `a` as having no way out.
    const w: Workflow = { version: 1, name: "t", description: "test", stages: [
      { id: "a", entry: true, triggers: [
        { when: { "run.stage": null } },
        { when: { "run.stage": "blocked", "run.counters.a": { $lt: 3 } } },
      ] },
      { id: "blocked", triggers: [{ when: { "run.lastOutputValid": false } }] },
    ] };
    const found = rules(w);
    expect(found).not.toContain("dead-end");
    expect(found).not.toContain("reachability");
    // And the catch-all is not read as half of a cycle: only `blocked -> a` is
    // an edge the graph definitely has, and one edge is not a loop.
    expect(found).not.toContain("cycle-bound");
  });

  it("fully analyses a graph whose triggers use only plain top-level run.stage anchors", () => {
    const w: Workflow = { version: 1, name: "t", description: "test", stages: [
      { id: "a", entry: true, triggers: [{ when: { "run.stage": "b" } }] },
      { id: "b", triggers: [{ when: { "run.stage": "a" } }] },
    ] };
    expect(rules(w)).toContain("cycle-bound");
  });

  it("reports a three-stage cycle exactly once regardless of which stage the DFS starts from", () => {
    const w: Workflow = { version: 1, name: "t", description: "test", stages: [
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
    const w: Workflow = { version: 1, name: "t", description: "test", stages: [
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
    const w: Workflow = { version: 1, name: "t", description: "test", stages };

    expect(fastest(() => validateSemantics(w, noSteps))).toBeLessThan(2000);
    const cycleProblems = validateSemantics(w, noSteps).filter((p) => p.rule === "cycle-bound");
    // One strongly connected component containing every stage is one real
    // cycle, so exactly one problem, not one per simple path through it.
    expect(cycleProblems).toHaveLength(1);
  });

  it("recognizes a counter bound nested under $and, not just at the top level", () => {
    const w: Workflow = { version: 1, name: "t", description: "test", stages: [
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
  // .landrace/workflows/full-cycle/workflow.yaml for build, code-review and fix-review: 30 paid
  // opus invocations in a single converge() call, then the same again on the
  // next poll. Under current assess() semantics such a stage is
  // unreachable-past, so it belongs with the other reachability rules.
  it("flags a stage whose step declares no output, since assess() can never mark it complete", () => {
    const steps = new Map<string, Step>([["s.md", { prompt: "go" }]]);
    const w: Workflow = { version: 1, name: "t", description: "test", stages: [
      { id: "a", entry: true, step: "s.md", triggers: [{ when: { "run.outputs.a": { $exists: true } } }] },
    ] };
    expect(rules(w, steps)).toContain("step-output-required");
  });

  it("does not flag a stage with a step that does declare an output", () => {
    const steps = new Map<string, Step>([["s.md", {
      prompt: "go",
      output: { discriminator: "kind", shapes: { done: {} }, routes: [{ when: { kind: "done" }, effect: { type: "x" } }] },
    }]]);
    const w: Workflow = { version: 1, name: "t", description: "test", stages: [{ id: "a", entry: true, step: "s.md" }] };
    expect(rules(w, steps)).not.toContain("step-output-required");
  });

  it("does not flag a stage with no step at all", () => {
    const w: Workflow = { version: 1, name: "t", description: "test", stages: [{ id: "a", entry: true, terminal: true }] };
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
    const w: Workflow = { version: 1, name: "t", description: "test", stages: [{ id: "a", entry: true, step: "s.md" }] };
    expect(rules(w, steps)).toContain("step-output-required");
  });

  /*
   * The overrides only reach a record the *route* carries. A route that sends
   * its content off the tracker gets a record beside it that the workflow does
   * not write, so `kind` there names the destination's own field and retargets
   * nothing. Flagging it would report a healthy workflow as broken, which is
   * how a validator gets switched off.
   */
  it("does not flag a route whose destination is not the tracker, whatever kind it names", () => {
    const steps = new Map<string, Step>([["s.md", {
      prompt: "go",
      output: {
        discriminator: "kind",
        shapes: { spec: {} },
        routes: [{ when: { kind: "spec" }, effect: { type: "artifact.publish", artifact: "spec", kind: "note" } }],
      },
    }]]);
    const w: Workflow = { version: 1, name: "t", description: "test", stages: [{ id: "a", entry: true, step: "s.md" }] };
    expect(rules(w, steps)).not.toContain("step-output-required");
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
    const w: Workflow = { version: 1, name: "t", description: "test", stages: [{ id: "a", entry: true, step: "s.md" }] };
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
    const w: Workflow = { version: 1, name: "t", description: "test", stages: [{ id: "a", entry: true, step: "s.md" }] };
    expect(rules(w, steps)).not.toContain("step-output-required");
  });

  it("flags a stage that is structurally connected but unreachable from the entry stage", () => {
    // b and c point at each other, but nothing (not even indirectly) leads
    // to either of them from the entry stage a.
    const w: Workflow = { version: 1, name: "t", description: "test", stages: [
      { id: "a", entry: true, terminal: true },
      { id: "b", triggers: [{ when: { "run.stage": "c" } }] },
      { id: "c", triggers: [{ when: { "run.stage": "b" } }] },
    ] };
    expect(rules(w)).toContain("reachability");
  });

  it("counts a stage reachable from any entry stage as reachable", () => {
    const w: Workflow = { version: 1, name: "t", description: "test", stages: [
      { id: "a", entry: true, triggers: [{ when: { "run.stage": null, "rel.child-of.out.total": 0 } }] },
      { id: "b", entry: true, triggers: [{ when: { "run.stage": null, "rel.child-of.out.total": 1 } }] },
      // Only b leads here.
      { id: "only-from-b", terminal: true, triggers: [{ when: { "run.stage": "b" } }] },
      { id: "done", terminal: true, triggers: [{ when: { "run.stage": "a" } }] },
    ] };
    expect(rules(w)).not.toContain("reachability");
  });

  it("still flags a stage no entry stage reaches, naming them all", () => {
    const w: Workflow = { version: 1, name: "t", description: "test", stages: [
      { id: "a", entry: true, terminal: true, triggers: [{ when: { "run.stage": null, x: 0 } }] },
      { id: "b", entry: true, terminal: true, triggers: [{ when: { "run.stage": null, x: 1 } }] },
      { id: "island", terminal: true, triggers: [{ when: { "run.stage": "island2" } }] },
      { id: "island2", terminal: true, triggers: [{ when: { "run.stage": "island" } }] },
    ] };
    const problems = validateSemantics(w, new Map()).filter((p) => p.rule === "reachability");
    expect(problems.map((p) => p.message).join("\n")).toMatch(/"island" is not reachable from any entry stage \(a, b\)/);
  });
});

/**
 * The rules, against the workflows that actually ship.
 *
 * `isPlainAnchor` demanded a string, and the only way to say "a fresh item"
 * is `{ "run.stage": null }`, so dead-end, cycle-bound and reachability were
 * off for every workflow with an entry stage — which is every workflow. The
 * proof that they are on is that a workflow with a planted defect reports it.
 */
describe("the graph rules, on a workflow that has an entry stage", () => {
  it("reports nothing on the shipped workflow", async () => {
    const { workflow, steps } = await loadShipped();
    expect(validate(workflow, steps)).toEqual([]);
  });

  it("reports nothing on the children fixture, whose two entry stages are chosen by origin", async () => {
    const { workflow, steps } = await loadWorkflow("tests/fixtures/children");
    expect(validate(workflow, steps)).toEqual([]);
  });

  it("reports nothing on the minimal fixture, whose only exit trigger names no stage", async () => {
    const { workflow, steps } = await loadWorkflow("tests/fixtures/minimal");
    expect(validate(workflow, steps)).toEqual([]);
  });

  it("reports nothing on the review fixture, whose every stage is where the item's own labels place it", async () => {
    const { workflow, steps } = await loadWorkflow("tests/fixtures/review");
    expect(validate(workflow, steps)).toEqual([]);
  });

  it("names an unbounded cycle and an unreachable pair planted in the shipped workflow", async () => {
    const { workflow, steps } = await loadShipped();
    const tampered: Workflow = {
      ...workflow,
      stages: [
        ...workflow.stages,
        { id: "loop-a", triggers: [{ when: { "run.stage": "loop-b" } }] },
        { id: "loop-b", triggers: [{ when: { "run.stage": "loop-a" } }] },
      ],
    };
    const found = validate(tampered, steps);
    expect(found.map((p) => p.rule)).toEqual(expect.arrayContaining(["cycle-bound", "reachability"]));
    expect(found.filter((p) => p.rule === "cycle-bound")[0]?.message).toMatch(/loop-a, loop-b/);
    expect(found.filter((p) => p.rule === "reachability").map((p) => p.message).join(" "))
      .toMatch(/loop-a[\s\S]*loop-b|loop-b[\s\S]*loop-a/);
  });
});

/**
 * §11.5's second half — "every declared enum value has an outbound edge".
 *
 * Only the first half was implemented (`totality`: every shape has a *route*,
 * somewhere for the content to go). `triage` declared `question` and `unclear`
 * and routed both to a comment, and nothing in the graph fired on either, so an
 * item that reached one sat at `triage` wearing `lr:awaiting` for good —
 * decide() excludes the current stage's own triggers, so even the human's next
 * reply did nothing. Nothing reported it.
 */
describe("every declared output shape has somewhere to go next", () => {
  const twoShapes = new Map<string, Step>([["s.md", {
    prompt: "",
    output: {
      discriminator: "kind",
      shapes: { a: {}, b: {} },
      routes: [
        { when: { kind: "a" }, effect: { type: "tracker.comment" } },
        { when: { kind: "b" }, effect: { type: "tracker.comment" } },
      ],
    },
  }]]);

  it("names the shape nothing routes away from", () => {
    const w: Workflow = { version: 1, name: "t", description: "test", stages: [
      { id: "s", entry: true, step: "s.md" },
      { id: "next", terminal: true, triggers: [{ when: { "run.stage": "s", "run.outputs.s.kind": "a" } }] },
    ] };
    const found = validateSemantics(w, twoShapes).filter((p) => p.rule === "shape-edge");
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toMatch(/"b"/);
  });

  it("accepts a trigger from the stage that does not care which shape arrived", () => {
    const w: Workflow = { version: 1, name: "t", description: "test", stages: [
      { id: "s", entry: true, step: "s.md" },
      { id: "next", terminal: true, triggers: [{ when: { "run.stage": "s" } }] },
    ] };
    expect(rules(w, twoShapes)).not.toContain("shape-edge");
  });

  it("accepts a trigger that names the shape without naming the stage it comes from", () => {
    const w: Workflow = { version: 1, name: "t", description: "test", stages: [
      { id: "s", entry: true, step: "s.md" },
      { id: "x", terminal: true, triggers: [{ when: { "run.stage": "s", "run.outputs.s.kind": "a" } }] },
      { id: "y", terminal: true, triggers: [{ when: { "run.outputs.s.kind": "b" } }] },
    ] };
    expect(rules(w, twoShapes)).not.toContain("shape-edge");
  });

  it("does not credit the stage's own trigger, which decide() never evaluates", () => {
    const w: Workflow = { version: 1, name: "t", description: "test", stages: [
      { id: "s", entry: true, step: "s.md", triggers: [{ when: { "run.stage": "s", "run.outputs.s.kind": "b" } }] },
      { id: "next", terminal: true, triggers: [{ when: { "run.stage": "s", "run.outputs.s.kind": "a" } }] },
    ] };
    expect(rules(w, twoShapes)).toContain("shape-edge");
  });

  it("catches the two triage shapes that stranded a real item", async () => {
    const { workflow, steps } = await loadShipped();
    // The shipped workflow as it was: `question` and `unclear` declared, routed
    // to a comment, and led away from by nothing — every trigger that mentions
    // triage without demanding an answer by name taken out, which leaves only
    // the ones that read `approve` or `revise`. "Mentions" is the rule's own
    // test: anchored on triage, or reading its output from another stage, as
    // spec's amendment triggers do.
    const mentionsTriage = (when: Record<string, unknown>): boolean =>
      when["run.stage"] === "triage" || Object.keys(when).some((k) => k.startsWith("run.outputs.triage"));
    const stranded: Workflow = {
      ...workflow,
      stages: workflow.stages.map((stage) => ({
        ...stage,
        triggers: (stage.triggers ?? []).filter((t) =>
          !mentionsTriage(t.when) || typeof t.when["run.outputs.triage.intent"] === "string"),
      })),
    };
    const found = validateSemantics(stranded, steps).filter((p) => p.rule === "shape-edge");
    expect(found.map((p) => p.message).join(" ")).toMatch(/"question"/);
    expect(found.map((p) => p.message).join(" ")).toMatch(/"unclear"/);
  });
});

describe("children", () => {
  const breakdownStep = { prompt: "p", capabilities: ["items:create"] } as Step;
  const stepsWith = (s: Step) => new Map([["steps/b.md", s]]);
  const wf = (on_enter: Effect[]): Workflow => ({
    version: 1, name: "t", description: "test",
    stages: [
      { id: "b", entry: true, step: "steps/b.md", on_enter },
      { id: "done", terminal: true, triggers: [{ when: { "run.stage": "b" } }] },
    ],
  });
  const children = (ps: Problem[]) => ps.filter((p) => p.rule === "children").map((p) => p.message);
  const enter = { type: "tracker.comment", kind: "enter", marker: "enter:{stage}:{round}", body: "round {round}" } as Effect;
  const close = { type: "nodes.close", follow: ["child-of"] } as Effect;

  it("flags a step that creates children with nothing to clean them on a re-run", () => {
    expect(children(validate(wf([enter]), stepsWith(breakdownStep)))).toEqual([expect.stringMatching(/"b".*items:create.*nodes\.close/)]);
  });

  /*
   * Supersession counts a child out once its origin round is below the
   * round its stage was last entered — and `entered` is counted from the
   * entry records. A creating stage that writes none never moves past round
   * one, so a re-run's children and the last round's all count, forever.
   */
  it("flags a step that creates children in a stage that writes no entry record", () => {
    expect(children(validate(wf([close]), stepsWith(breakdownStep))))
      .toEqual([expect.stringMatching(/"b".*items:create.*entry record/)]);
    const other = { ...enter, kind: "output" } as Effect;
    expect(children(validate(wf([other, close]), stepsWith(breakdownStep))))
      .toEqual([expect.stringMatching(/"b".*entry record/)]);
  });

  it("flags a close with nothing that could have made what it closes", () => {
    const ps = validate(wf([{ type: "nodes.close", follow: ["child-of"] }]), stepsWith({ prompt: "p", capabilities: [] } as Step));
    expect(children(ps)).toEqual([expect.stringMatching(/"b".*nodes\.close.*items:create/)]);
  });

  it("flags a close with nothing to follow", () => {
    expect(children(validate(wf([enter, { type: "nodes.close" }]), stepsWith(breakdownStep)))).toEqual([expect.stringMatching(/follow/)]);
  });

  /*
   * The declared relation types are read off the same `provided` list §11.8
   * already takes, filtered to the bare `rel.<type>` entries snapshotProvides
   * emits — never a separate argument. Leaving `provided` out entirely (as
   * path coverage itself abstains) must abstain this check too, rather than
   * report a "owns" that might turn out to be real.
   */
  it("flags a follow type no source declares, and abstains when relations are unknown", () => {
    const w = wf([enter, { type: "nodes.close", follow: ["child-of", "owns"] }]);
    expect(children(validate(w, stepsWith(breakdownStep), ["rel.child-of", "rel.implements"])))
      .toEqual([expect.stringMatching(/"owns"/)]);
    expect(children(validate(w, stepsWith(breakdownStep)))).toEqual([]);
  });

  it("passes the pair", () => {
    expect(children(validate(wf([enter, close]), stepsWith(breakdownStep)))).toEqual([]);
  });
});

describe("goto edges", () => {
  const enter = { type: "tracker.comment", kind: "enter", marker: "enter:{stage}:{round}" };
  const loop = (goto: NonNullable<Workflow["stages"][number]["goto"]>): Workflow => ({
    version: 1, name: "t", description: "test", stages: [
      { id: "a", entry: true, on_enter: [enter], triggers: [{ when: { "run.stage": null } }] },
      { id: "b", goto, triggers: [{ when: { "run.stage": "a" } }] },
    ],
  });

  it("counts a goto as an edge a cycle can run along, bounded only by its `when`", () => {
    expect(rules(loop(["a"]))).toContain("cycle-bound");
    expect(rules(loop([{ stage: "a", when: { "run.counters.a": { $lt: 3 } } }]))).not.toContain("cycle-bound");
  });

  // A `when` is a bound only when it bounds a counter: a goto that may run
  // for as long as some unrelated field holds loops for as long as it does.
  it("does not take a goto's `when` for a bound unless it bounds a counter", () => {
    expect(rules(loop([{ stage: "a", when: { x: 1 } }]))).toContain("cycle-bound");
  });

  it("counts a goto as a way out of a stage", () => {
    expect(rules(loop([{ stage: "a", when: { "run.counters.a": { $lt: 3 } } }]))).not.toContain("dead-end");
  });

  it("counts a route's goto as the edge its shape leads along", () => {
    const steps = new Map<string, Step>([["s.md", {
      prompt: "",
      output: {
        discriminator: "i", shapes: { back: {} },
        routes: [{ when: { i: "back" }, goto: "a", effect: { type: "tracker.comment", marker: "i:{round}" } }],
      },
    }]]);
    const w: Workflow = { version: 1, name: "t", description: "test", stages: [
      { id: "a", entry: true, step: "s.md", on_enter: [enter], goto: [{ stage: "a", when: { "run.counters.a": { $lt: 3 } } }],
        triggers: [{ when: { "run.stage": null } }] },
      { id: "z", terminal: true, triggers: [{ when: { "run.stage": "a", "run.outputs.a.i": "never" } }] },
    ] };
    expect(rules(w, steps)).not.toContain("shape-edge");
  });

  it("checks the paths a goto's `when` reads, like any trigger's", () => {
    const problems = validateSemantics(loop([{ stage: "a", when: { "run.nope": 1 } }]), noSteps, ["run.stage", "run.counters.*"]);
    expect(problems.map((p) => p.message)).toContainEqual(expect.stringMatching(/"b" reads run\.nope/));
  });
});

/*
 * The graph rules over stages an item's own state places it at. Such a stage
 * is reached by its identity holding and left by it ceasing to, so it is a
 * root of reachability and no dead end for lacking triggers out. Each rule
 * still reports the stage a transition alone would have to reach or leave.
 */
describe("the graph rules, on stages the item's own state places it at", () => {
  const mine = (...labels: string[]) => ({ "node.state.labels": { $in: labels } });
  const notMine = (...labels: string[]) => ({ "node.state.labels": { $nin: labels } });
  const flow = (stages: Workflow["stages"]): Workflow => ({ version: 1, name: "t", description: "test", stages });

  it("takes a stage its identity places an item at for one it can leave", () => {
    const w = flow([
      { id: "reviewing", waits: "person", identity: notMine("approved") },
      { id: "approved", terminal: true, identity: mine("approved") },
    ]);
    expect(rules(w)).not.toContain("dead-end");
  });

  it("still reports a dead end whose identity reads nothing but the position", () => {
    const w = flow([
      { id: "a", entry: true, triggers: [{ when: { "run.stage": null } }] },
      { id: "stuck", identity: { "run.stage": "stuck" }, triggers: [{ when: { "run.stage": "a" } }] },
    ]);
    expect(validateSemantics(w, noSteps).filter((p) => p.rule === "dead-end")).toEqual([
      { rule: "dead-end", message: 'stage "stuck" has no way out and is not terminal' },
    ]);
  });

  it("reaches what a trigger leads to from a stage the item's state places it at", () => {
    const w = flow([
      { id: "reviewing", waits: "person", identity: notMine("approved") },
      { id: "approved", terminal: true, identity: mine("approved") },
      { id: "nudged", terminal: true, triggers: [{ when: { "run.stage": "reviewing", "node.state.labels": "stale" } }] },
    ]);
    expect(rules(w)).not.toContain("reachability");
  });

  it("still reports stages only each other reach, naming the stages it reached them from", () => {
    const w = flow([
      { id: "reviewing", waits: "person", identity: notMine("approved") },
      { id: "approved", terminal: true, identity: mine("approved") },
      { id: "island", terminal: true, triggers: [{ when: { "run.stage": "island2" } }] },
      { id: "island2", terminal: true, triggers: [{ when: { "run.stage": "island" } }] },
    ]);
    expect(validateSemantics(w, noSteps).filter((p) => p.rule === "reachability").map((p) => p.message)).toEqual([
      'stage "island" is not reachable from a stage an item\'s own state places it at (reviewing, approved)',
      'stage "island2" is not reachable from a stage an item\'s own state places it at (reviewing, approved)',
    ]);
  });

  it("names both kinds of root when a workflow has an entry stage and stages placed by state", () => {
    const w = flow([
      { id: "a", entry: true, terminal: true, triggers: [{ when: { "run.stage": null } }] },
      { id: "flagged", terminal: true, identity: mine("flagged") },
      { id: "island", terminal: true, triggers: [{ when: { "run.stage": "island" } }] },
    ]);
    expect(validateSemantics(w, noSteps).filter((p) => p.rule === "reachability").map((p) => p.message)).toEqual([
      'stage "island" is not reachable from the entry stage "a", nor from a stage an item\'s own state places it at (flagged)',
    ]);
  });

  describe("two identities", () => {
    const identities = (a: Workflow["stages"][number]["identity"], b: Workflow["stages"][number]["identity"]) =>
      validateSemantics(flow([
        { id: "a", waits: "person", ...(a ? { identity: a } : {}) },
        { id: "b", terminal: true, ...(b ? { identity: b } : {}) },
      ]), noSteps).filter((p) => p.rule === "identity");

    it.each([
      ["$in and $nin of one label", mine("approved"), notMine("approved")],
      ["$in and $nin of the same labels", mine("approved", "merged"), notMine("approved", "merged")],
      ["$in and a $nin that holds every label it names", mine("approved"), notMine("approved", "merged")],
      ["$all and a $nin of one of its labels", { "node.state.labels": { $all: ["a", "b"] } }, notMine("b")],
      ["$all and a $ne of one of its labels", { "node.state.labels": { $all: ["a", "b"] } }, { "node.state.labels": { $ne: "a" } }],
      ["a label and its $ne", { "node.state.labels": "a" }, { "node.state.labels": { $ne: "a" } }],
      ["two default identities", undefined, undefined],
    ])("finds no item both hold: %s", (_, a, b) => {
      expect(identities(a, b)).toEqual([]);
    });

    // Abstained on, not proved: nothing here reasons about numeric ranges,
    // so a split it cannot see into is not reported — it once was, on
    // every workflow that wrote one.
    it("finds no item both hold of a range split on one path", () => {
      expect(identities({ "run.counters.a": { $lt: 3 } }, { "run.counters.a": { $gte: 3 } })).toEqual([]);
    });

    // Nothing proved is nothing reported: no value built from the operands
    // falls strictly between 1 and 2, though 1.5 would.
    it("abstains on two custom identities it cannot build a common item for", () => {
      expect(identities({ "run.counters.a": { $gt: 1, $lt: 2 }, "node.state.labels": "x" }, { "run.counters.a": { $gt: 1 } })).toEqual([]);
      expect(identities({ $or: [{ "node.state.labels": "x" }] }, { $or: [{ "node.state.labels": "y" }] })).toEqual([]);
    });

    /*
     * A stage placed by its label beside one whose identity leaves the
     * position alone: any item that identity holds, at the labelled stage,
     * matches both — so only an identity nothing can satisfy escapes, and
     * that is a defect too. Where the witness cannot build that item, the
     * pair is reported as it was before the witness, not abstained on: each
     * of these once validated clean and then halted every such item.
     */
    const asBefore = [{
      rule: "identity",
      message: 'stages "a" and "b" can both be the current position' +
        ": one is placed by its stage label alone and the other's identity reads no position, so an item at the first that the second matches is at both",
    }];
    it.each([
      ["a $regex", { "node.title": { $regex: "^WIP" } }],
      ["a field it must lack", { "node.priority": { $exists: false } }],
      ["a top-level $or", { $or: [{ "node.state.labels": { $in: ["x"] } }, { "node.priority": 1 }] }],
      ["a $size", { "node.state.labels": { $size: 2 } }],
      ["a range no counter falls in", { "run.counters.a": { $gt: 1, $lt: 2 } }],
    ])("reports a default identity beside one reading %s it cannot build an item for", (_, custom) => {
      expect(identities(custom, undefined)).toEqual(asBefore);
      expect(identities(undefined, custom)).toEqual(asBefore);
    });

    // Pinning the position is a position of its own, which a default
    // identity's never equals: there is nothing to report.
    it("does not report a default identity beside one that pins the position elsewhere", () => {
      expect(identities({ "run.stage": null, "node.title": { $regex: "^WIP" } }, undefined)).toEqual([]);
    });

    it.each([
      ["one label and a set that holds it", mine("x"), mine("x", "y"), '{"node.state.labels":["x"]}'],
      ["two labels an item can carry together", mine("x"), mine("y"), '{"node.state.labels":["x","y"]}'],
      ["two labels it may lack together", notMine("x"), notMine("y"), '{"node.state.labels":[]}'],
      ["a label and a $nin of another", mine("x"), notMine("y"), '{"node.state.labels":["x"]}'],
      ["one identity twice", { "run.stage": "a" }, { "run.stage": "a" }, '{"run.stage":"a"}'],
      ["a position and a label", { "run.stage": "a" }, mine("x"), '{"run.stage":"a","node.state.labels":["x"]}'],
      // One side's operator on a path the other leaves alone: any value it
      // accepts makes the item, built from its own operand.
      ["a position and a counter bound", undefined, { "run.counters.review": { $gte: 3 } }, '{"run.stage":"a","run.counters.review":3}'],
      ["a position and an output it lists", undefined, { "run.outputs.a.verdict": { $in: ["reject", "hold"] } },
        '{"run.stage":"a","run.outputs.a.verdict":"reject"}'],
      ["a position and an output it refuses", undefined, { "run.outputs.a.verdict": { $nin: ["approve"] } },
        '{"run.stage":"a","run.outputs.a.verdict":"other"}'],
      ["a position and an output it lacks", undefined, { "run.outputs.a.verdict": { $ne: "other" } },
        '{"run.stage":"a","run.outputs.a.verdict":"other-2"}'],
      ["a position and an output that exists", undefined, { "run.outputs.a": { $exists: true } }, '{"run.stage":"a","run.outputs.a":"other"}'],
      ["two bounds on one counter that overlap", { "run.counters.a": { $lt: 5 } }, { "run.counters.a": { $lt: 3 } }, '{"run.counters.a":2}'],
    ])("reports two that one item holds: %s, naming that item", (_, a, b, item) => {
      expect(identities(a, b)).toEqual([{
        rule: "identity", message: `stages "a" and "b" can both be the current position: an item with ${item} matches both`,
      }]);
    });
  });

  /*
   * Placed by state means placed by what the tracker holds — the item's own
   * fields and its relations. An identity reading what the engine writes (a
   * counter, an output) or pinning the position a transition writes places an
   * item nowhere a transition did not first take it, and owes the graph rules
   * every answer an ordinary stage does. Each of these validated clean once
   * any custom identity was read as placement by state.
   */
  describe("a stage the engine's own records place an item at", () => {
    const at = (id: string): Workflow["stages"] => [
      { id: "a", entry: true, triggers: [{ when: { "run.stage": null } }] },
      { id: "b", triggers: [{ when: { "run.stage": "a" } }] },
      { id: "done", terminal: true, triggers: [{ when: { "run.stage": "b" } }] },
      { id, identity: {} },
    ];
    const reported = (w: Workflow) => validate(w, noSteps).map((p) => `${p.rule}: ${p.message}`);
    const unplaced = (id: string, from: string) => [
      `reachability: nothing can reach stage "${id}"`,
      `dead-end: stage "${id}" has no way out and is not terminal`,
      `reachability: stage "${id}" is not reachable from ${from}`,
    ];
    const both = (other: string, id: string, item: string) =>
      `identity: stages "${other}" and "${id}" can both be the current position: an item with ${item} matches both`;

    it("reports a stage whose identity pins the position beside a label, as it would without one", () => {
      const w = flow([
        { id: "a", entry: true, triggers: [{ when: { "run.stage": null } }] },
        { id: "done", terminal: true, triggers: [{ when: { "run.stage": "a" } }] },
        { id: "x", identity: { "run.stage": "x", "node.state.labels": { $in: ["ready"] } } },
      ]);
      expect(reported(w)).toEqual(unplaced("x", 'the entry stage "a"'));
    });

    it.each([
      ["a counter", { "run.counters.review": { $gte: 3 } }, '"run.counters.review":3'],
      ["a step's output", { "run.outputs.b.verdict": { $in: ["reject"] } }, '"run.outputs.b.verdict":"reject"'],
    ])("reports a stage whose identity reads %s, and the stages it overlaps", (_, identity, value) => {
      const w = flow(at("escalated").map((s) => (s.id === "escalated" ? { ...s, identity } : s)));
      expect(reported(w)).toEqual([
        ...unplaced("escalated", 'the entry stage "a"'),
        ...["a", "b", "done"].map((other) => both(other, "escalated", `{"run.stage":"${other}",${value}}`)),
      ]);
    });

    it("does not exempt from an entry stage a workflow whose every stage pins the position", () => {
      const w = flow([
        { id: "r", waits: "person", identity: { "run.stage": "r", "node.state.labels": { $nin: ["ok"] } } },
        { id: "ok", terminal: true, identity: { "run.stage": "ok", "node.state.labels": { $in: ["ok"] } } },
      ]);
      expect(reported(w)).toEqual([
        "entry: no stage has entry: true, so no item can start",
        'reachability: nothing can reach stage "r"',
        'reachability: nothing can reach stage "ok"',
        'dead-end: stage "r" has no way out and is not terminal',
      ]);
    });

    // An item at no stage yet: the one position an item's own state can
    // stand for, since nothing has been written.
    it("takes an identity that reads the labels of an item at no stage for a placement by state", () => {
      const w = flow([
        { id: "reviewing", waits: "person", identity: { "run.stage": null, "node.state.labels": { $nin: ["approved"] } } },
        { id: "approved", terminal: true, identity: { "run.stage": null, "node.state.labels": { $in: ["approved"] } } },
      ]);
      expect(reported(w)).toEqual([]);
    });
  });
});
