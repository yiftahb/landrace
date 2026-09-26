import { validateStructure } from "#workflow/validate.js";
import type { Stage, Step, Workflow } from "#namespace.js";

const wf = (stages: Workflow["stages"]): Workflow => ({ version: 1, name: "t", stages });
const rules = (w: Workflow) => validateStructure(w).map((p) => p.rule);

describe("structural validation", () => {
  it("accepts a sound graph", () => {
    const w = wf([
      { id: "a", entry: true, triggers: [{ when: { x: 1 } }] },
      { id: "b", terminal: true, triggers: [{ when: { y: 1 } }] },
    ]);
    expect(validateStructure(w)).toEqual([]);
  });

  it("requires at least one entry stage", () => {
    expect(rules(wf([{ id: "a" }, { id: "b", terminal: true, triggers: [{ when: { y: 1 } }] }]))).toContain("entry");
  });

  it("accepts several entry stages that each say which fresh tickets they take", () => {
    const w = wf([
      { id: "a", entry: true, triggers: [{ when: { "run.stage": null, "rel.child-of.out.total": 0 } }] },
      { id: "b", entry: true, triggers: [{ when: { "run.stage": null, "rel.child-of.out.total": 1 } }] },
      { id: "c", terminal: true, triggers: [{ when: { "run.stage": "a" } }, { when: { "run.stage": "b" } }] },
    ]);
    expect(rules(w)).not.toContain("entry");
  });

  it("refuses a trigger-less entry stage beside another, naming it", () => {
    const problems = validateStructure(wf([
      { id: "a", entry: true },
      { id: "b", entry: true, triggers: [{ when: { "run.stage": null } }] },
    ]));
    const entry = problems.filter((p) => p.rule === "entry");
    expect(entry).toHaveLength(1);
    expect(entry[0]?.message).toMatch(/"a"/);
  });

  it("refuses an entry trigger that could fire mid-workflow", () => {
    // Not anchored on run.stage: null, so decide() would evaluate it from
    // every other stage too and drag a running ticket back to b.
    const problems = validateStructure(wf([
      { id: "a", entry: true, triggers: [{ when: { "run.stage": null } }] },
      { id: "b", entry: true, triggers: [{ when: { "rel.child-of.out.total": 1 } }] },
    ]));
    const entry = problems.filter((p) => p.rule === "entry");
    expect(entry).toHaveLength(1);
    expect(entry[0]?.message).toMatch(/"b".*"run\.stage": null/);
  });

  it("asks nothing new of a sole entry stage", () => {
    const w = wf([
      { id: "a", entry: true, triggers: [{ when: { "run.stage": "b" } }] },
      { id: "b", terminal: true, triggers: [{ when: { "run.stage": "a" } }] },
    ]);
    expect(rules(w)).not.toContain("entry");
  });

  it("recognizes an entry trigger anchored with \"run.stage\": { $eq: null }", () => {
    const w = wf([
      { id: "a", entry: true, triggers: [{ when: { "run.stage": { $eq: null }, x: 0 } }] },
      { id: "b", entry: true, triggers: [{ when: { "run.stage": null, x: 1 } }] },
    ]);
    expect(rules(w)).not.toContain("entry");
  });

  it("recognizes an entry trigger anchored on \"run.stage\": null nested under $and", () => {
    const w = wf([
      { id: "a", entry: true, triggers: [{ when: { $and: [{ "run.stage": null }, { x: 0 }] } }] },
      { id: "b", entry: true, triggers: [{ when: { "run.stage": null, x: 1 } }] },
    ]);
    expect(rules(w)).not.toContain("entry");
  });

  it("abstains, rather than flags, an entry trigger that mentions run.stage only under $or", () => {
    // Could hold on a fresh ticket, could hold on one at "b" — unreadable, so
    // this must not be reported as either anchored or refused.
    const w = wf([
      { id: "a", entry: true, triggers: [{ when: { $or: [{ "run.stage": null }, { "run.stage": "b" }] } }] },
      { id: "b", entry: true, triggers: [{ when: { "run.stage": null, x: 1 } }] },
    ]);
    expect(rules(w)).not.toContain("entry");
  });

  it("still refuses an entry trigger that mentions run.stage nowhere at all", () => {
    const problems = validateStructure(wf([
      { id: "a", entry: true, triggers: [{ when: { x: 0 } }] },
      { id: "b", entry: true, triggers: [{ when: { "run.stage": null, x: 1 } }] },
    ]));
    const entry = problems.filter((p) => p.rule === "entry");
    expect(entry).toHaveLength(1);
    expect(entry[0]?.message).toMatch(/"a".*"run\.stage": null/);
  });

  it("flags only the unanchored trigger when an entry stage also has an anchored one", () => {
    const problems = validateStructure(wf([
      { id: "a", entry: true, triggers: [
        { when: { "run.stage": null } },
        { when: { "rel.child-of.out.total": 1 } },
      ] },
      { id: "b", entry: true, triggers: [{ when: { "run.stage": null } }] },
    ]));
    const entry = problems.filter((p) => p.rule === "entry");
    expect(entry).toHaveLength(1);
    expect(entry[0]?.message).toMatch(/"a".*could also fire mid-workflow/);
  });

  it("refuses an entry stage whose only trigger names a specific stage, not null — a literal is readable", () => {
    const problems = validateStructure(wf([
      { id: "a", entry: true, triggers: [{ when: { "run.stage": null } }] },
      { id: "b", entry: true, triggers: [{ when: { "run.stage": "x" } }] },
    ]));
    const entry = problems.filter((p) => p.rule === "entry");
    expect(entry).toHaveLength(1);
    expect(entry[0]?.message).toMatch(/"b".*"run\.stage": null/);
  });

  /**
   * Shaped after tests/fixtures/children's build stage with its null anchor
   * deleted: one trigger with no run.stage mention at all, one with a
   * readable, non-null "run.stage": "triage". Neither is null and both are
   * readable, so this must be refused, not abstained on — the earlier round
   * of this rule treated "mentions run.stage at all" as ambiguous and missed
   * exactly this case.
   */
  it("refuses an entry stage whose triggers are all readable but none is null — the children build repro", () => {
    const problems = validateStructure(wf([
      { id: "a", entry: true, triggers: [{ when: { "run.stage": null } }] },
      {
        id: "build",
        entry: true,
        triggers: [
          { when: { "rel.child-of.out.total": 1 } },
          { when: { "run.stage": "triage", "run.outputs.triage.intent": "approve" } },
        ],
      },
      { id: "triage", terminal: true },
    ]));
    const entry = problems.filter((p) => p.rule === "entry");
    expect(entry).toHaveLength(1);
    expect(entry[0]?.message).toMatch(/"build".*"run\.stage": null/);
  });

  it("does not flag a readable non-null loop-back trigger as could fire mid-workflow", () => {
    const w = wf([
      { id: "a", entry: true, triggers: [
        { when: { "run.stage": null } },
        { when: { "run.stage": "b" } },
      ] },
      { id: "b", entry: true, triggers: [{ when: { "run.stage": null } }] },
    ]);
    expect(rules(w)).not.toContain("entry");
  });

  it("flags a stage nothing can reach", () => {
    const w = wf([{ id: "a", entry: true }, { id: "orphan", terminal: true }]);
    expect(rules(w)).toContain("reachability");
  });

  it("rejects a disallowed operator anywhere in the graph", () => {
    const w = wf([{ id: "a", entry: true }, { id: "b", terminal: true, triggers: [{ when: { x: { $where: "1" } } }] }]);
    expect(rules(w)).toContain("operator");
  });

  it("flags a trigger anchored on its own stage — it can never fire and the stage deadlocks", () => {
    const w = wf([
      { id: "a", entry: true, terminal: true },
      { id: "revise", triggers: [{ when: { "run.stage": "revise", "run.counters.revise": { $lt: 3 } } }] },
    ]);
    expect(rules(w)).toContain("self-loop");
  });

  it("flags a trigger naming a stage id that does not exist in the workflow", () => {
    const w = wf([
      { id: "a", entry: true, terminal: true },
      { id: "b", triggers: [{ when: { "run.stage": "typo" } }] },
    ]);
    expect(rules(w)).toContain("unknown-stage");
  });

  /**
   * Before the workflow ever runs, and in the report a person reads: a
   * capability nothing enforces is the operator believing in a restriction
   * that was never applied. Meeting it at runtime instead means finding out on
   * a ticket already in flight, one refused step at a time.
   */
  it("flags a step declaring a capability the engine cannot enforce", () => {
    const steps = new Map<string, Step>([["s.md", { prompt: "", capabilities: ["repo:read", "net:egress"] }]]);
    const w = wf([{ id: "a", entry: true, terminal: true, step: "s.md" }]);
    const problems = validateStructure(w, steps);

    expect(problems.map((p) => p.rule)).toContain("capability");
    expect(problems.find((p) => p.rule === "capability")?.message).toMatch(/net:egress/);
  });

  /**
   * The rule that used to stand here refused a step whose output shape
   * declared a field called `session`, because the engine wrote its own id
   * into that same object. It does not any more — the session rides beside
   * the value on the record (namespace.ts, `Marker.session`) — so the
   * collision cannot happen and a guard against nothing was deleted rather
   * than kept for reassurance. What replaces it is the attack itself:
   * tests/mcp/conversation.test.ts runs a step whose shape declares the name
   * and pins that the turn resumes the engine's session, not the agent's.
   */
  it("does not object to a step whose output shape declares a field named session", () => {
    const steps = new Map<string, Step>([["s.md", {
      prompt: "",
      output: {
        discriminator: "kind",
        shapes: { spec: { title: "string", session: "string" } },
        routes: [{ when: { kind: "spec" }, effect: { type: "x" } }],
      },
    }]]);
    const w = wf([{ id: "a", entry: true, terminal: true, step: "s.md" }]);

    expect(validateStructure(w, steps)).toEqual([]);
  });

  it("accepts the capabilities the engine does enforce", () => {
    const steps = new Map<string, Step>([["s.md", { prompt: "", capabilities: ["repo:read", "repo:write"] }]]);
    const w = wf([{ id: "a", entry: true, terminal: true, step: "s.md" }]);
    expect(validateStructure(w, steps).map((p) => p.rule)).not.toContain("capability");
  });

  it("rejects a disallowed operator in a step's route condition", () => {
    const steps = new Map<string, Step>([["s.md", {
      prompt: "",
      output: {
        discriminator: "kind",
        shapes: { spec: {} },
        routes: [{ when: { kind: { $where: "evil()" } }, effect: { type: "x" } }],
      },
    }]]);
    const w = wf([{ id: "a", entry: true, terminal: true, step: "s.md" }]);
    expect(validateStructure(w, steps).map((p) => p.rule)).toContain("operator");
  });
});

describe("goto", () => {
  const enter = { type: "tracker.comment", kind: "enter", marker: "enter:{stage}:{round}" };
  const w = (goto: Stage["goto"], b: Partial<Stage> = {}): Workflow => wf([
    { id: "a", entry: true, step: "a.md", on_enter: [enter], triggers: [{ when: { "run.stage": null } }] },
    { id: "b", goto, triggers: [{ when: { "run.stage": "a" } }], ...b },
    { id: "c", terminal: true, triggers: [{ when: { "run.stage": "b" } }] },
  ]);
  const said = (wk: Workflow, steps?: Map<string, Step>) =>
    validateStructure(wk, steps).filter((p) => p.rule === "goto").map((p) => p.message);

  it("accepts a stage sending tickets to one that records its entry, bare or capped", () => {
    expect(said(w(["a"]))).toEqual([]);
    expect(said(w([{ stage: "a", when: { "run.counters.a": { $lt: 3 } } }]))).toEqual([]);
  });

  it("refuses a target that is not a stage, naming both", () => {
    expect(said(w(["zz"]))).toEqual([expect.stringMatching(/"b".*"zz".*not in the workflow/)]);
  });

  it("refuses a target named twice", () => {
    expect(said(w(["a", { stage: "a" }]))).toEqual([expect.stringMatching(/"a" twice/)]);
  });

  /*
   * The target's entry record is what consumes a goto. A target that writes
   * none leaves the goto pending on arrival — and a pending goto its new
   * stage does not list halts the ticket there.
   */
  it("refuses a target whose entry writes no record", () => {
    expect(said(w(["c"]))).toEqual([expect.stringMatching(/"c".*records no "enter"/)]);
  });

  it("refuses a route that sends tickets somewhere its stage does not list", () => {
    const steps = new Map<string, Step>([["j.md", {
      prompt: "",
      output: {
        discriminator: "i", shapes: { back: {} },
        routes: [{ when: { i: "back" }, goto: "c", effect: { type: "tracker.comment", marker: "i:{round}" } }],
      },
    }]]);
    expect(said(w(["a"], { step: "j.md", on_enter: [enter] }), steps)).toEqual([expect.stringMatching(/route.*"c".*"b"/)]);
  });

  it("checks a goto's `when` against the operator allowlist", () => {
    expect(rules(w([{ stage: "a", when: { x: { $where: "1" } } }]))).toContain("operator");
  });

  it("refuses a goto or a from written into an effect, which only the engine writes", () => {
    for (const field of ["goto", "from"]) {
      expect(rules(w(["a"], { on_enter: [{ type: "tracker.label", [field]: "a" }] }))).toContain("reserved-field");
    }
  });

  // The route-effect half: a judge's route writes its record through its
  // effect, and a goto there would carry a target past the check that the
  // route's own `goto` gets — the stage's list.
  it("refuses a goto or a from written into a step route's effect", () => {
    for (const field of ["goto", "from"]) {
      const steps = new Map<string, Step>([["j.md", {
        prompt: "",
        output: {
          discriminator: "i", shapes: { back: {} },
          routes: [{ when: { i: "back" }, effect: { type: "tracker.comment", marker: "i:{round}", [field]: "a" } }],
        },
      }]]);
      expect(validateStructure(w(["a"], { step: "j.md", on_enter: [enter] }), steps).map((p) => p.rule))
        .toContain("reserved-field");
    }
  });

  it("refuses a trigger named like a goto transition", () => {
    expect(rules(w(["a"], { triggers: [{ name: "goto", when: { "run.stage": "a" } }] }))).toContain("trigger-name");
  });
});
