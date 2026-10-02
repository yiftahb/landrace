import { validateStructure } from "#workflow/validate.js";
import type { Stage, Step, Workflow } from "#namespace.js";

const wf = (stages: Workflow["stages"]): Workflow => ({ version: 1, name: "t", description: "test", stages });
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

  it("accepts several entry stages that each say which fresh items they take", () => {
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
    // every other stage too and drag a running item back to b.
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
    // Could hold on a fresh item, could hold on one at "b" — unreadable, so
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
   * an item already in flight, one refused step at a time.
   */
  it("flags a step declaring a capability the engine cannot enforce", () => {
    const steps = new Map<string, Step>([["s.md", { prompt: "", capabilities: ["repo:read", "net:egress"] }]]);
    const w = wf([{ id: "a", entry: true, terminal: true, step: "s.md" }]);
    const problems = validateStructure(w, steps);

    expect(problems.map((p) => p.rule)).toContain("capability");
    expect(problems.find((p) => p.rule === "capability")?.message).toMatch(/net:egress/);
  });

  it("flags the retired capability tickets:create, naming items:create", () => {
    const steps = new Map<string, Step>([["s.md", { prompt: "", capabilities: ["repo:read", "tickets:create"] }]]);
    const w = wf([{ id: "a", entry: true, terminal: true, step: "s.md" }]);
    const problems = validateStructure(w, steps);
    expect(problems.find((p) => p.rule === "capability")?.message).toMatch(/"tickets:create" is now "items:create"/);
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

  // A person's turn runs no agent: a stage saying both would put an item in
  // Needs you while a paid step runs on it.
  it("refuses a stage that waits on a person and runs a step, naming it", () => {
    const w = wf([
      { id: "a", entry: true, triggers: [{ when: { "run.stage": null } }] },
      { id: "ask", step: "ask.md", waits: "person", triggers: [{ when: { "run.stage": "a" } }] },
      { id: "z", terminal: true, triggers: [{ when: { "run.stage": "ask" } }] },
    ]);
    expect(validateStructure(w).filter((p) => p.rule === "waits")).toEqual([{
      rule: "waits",
      message: 'stage "ask" waits on a person and runs step ask.md: a person\'s turn runs no agent, so it cannot do both',
    }]);
  });

  // Needs you reads a stage's waits before it reads terminal, so an item
  // there stayed in Needs you, its work done, until someone closed it.
  it("refuses a terminal stage that waits on a person, naming it", () => {
    const w = wf([
      { id: "a", entry: true, triggers: [{ when: { "run.stage": null } }] },
      { id: "z", terminal: true, waits: "person", triggers: [{ when: { "run.stage": "a" } }] },
    ]);
    expect(validateStructure(w).filter((p) => p.rule === "waits")).toEqual([{
      rule: "waits",
      message: 'stage "z" is terminal and waits on a person: an item\'s work is done at a terminal stage, so it waits on no one there',
    }]);
  });

  it("accepts a stage that waits on a person and runs no step", () => {
    const w = wf([
      { id: "a", entry: true, triggers: [{ when: { "run.stage": null } }] },
      { id: "ask", waits: "person", triggers: [{ when: { "run.stage": "a" } }] },
      { id: "z", terminal: true, triggers: [{ when: { "run.stage": "ask" } }] },
    ]);
    expect(validateStructure(w)).toEqual([]);
  });
});

/*
 * A step file or workflow written before the rename of ticket to item. Every
 * pass leaves a name nobody answers for visible rather than failing, so
 * `{ticket.body}` would reach the agent as those eleven characters and a
 * marker would carry the literal `{ticket}` — nothing at runtime says so.
 */
describe("placeholders retired by the rename", () => {
  const placeholders = (w: Workflow, steps?: Map<string, Step>) =>
    validateStructure(w, steps).filter((p) => p.rule === "placeholder").map((p) => p.message);

  it("flags {ticket.body} in a step's prompt, naming the step and what it is now", () => {
    const steps = new Map<string, Step>([["s.md", { prompt: "The item:\n\n{ticket.body}\n" }]]);
    const w = wf([{ id: "a", entry: true, terminal: true, step: "s.md" }]);
    expect(placeholders(w, steps)).toEqual([expect.stringMatching(/^step s\.md.*"\{ticket\.body\}" is now "\{item\.body\}"$/)]);
  });

  it("flags {ticket} in an on_enter effect's marker, naming the stage and what it is now", () => {
    const w = wf([{ id: "a", entry: true, terminal: true, on_enter: [{ type: "tracker.comment", marker: "enter:{ticket}:{round}" }] }]);
    expect(placeholders(w)).toEqual([expect.stringMatching(/^stage "a".*"\{ticket\}" is now "\{item\}"$/)]);
  });

  it("flags {ticket} in a step route's effect", () => {
    const steps = new Map<string, Step>([["s.md", {
      prompt: "",
      output: {
        discriminator: "kind", shapes: { spec: {} },
        routes: [{ when: { kind: "spec" }, effect: { type: "tracker.comment", marker: "spec:{round}", body: "Done with #{ticket}." } }],
      },
    }]]);
    const w = wf([{ id: "a", entry: true, terminal: true, step: "s.md" }]);
    expect(placeholders(w, steps)).toEqual([expect.stringMatching(/^stage "a".*"\{ticket\}" is now "\{item\}"$/)]);
  });

  it("says nothing of the names that replaced them", () => {
    const steps = new Map<string, Step>([["s.md", {
      prompt: "{item.body}\n{item.comments}",
      output: {
        discriminator: "kind", shapes: { spec: {} },
        routes: [{ when: { kind: "spec" }, effect: { type: "tracker.comment", marker: "spec:{round}", body: "#{item}" } }],
      },
    }]]);
    const w = wf([{
      id: "a", entry: true, terminal: true, step: "s.md",
      on_enter: [{ type: "branch.push", branch: "landrace/{item}" }],
    }]);
    expect(placeholders(w, steps)).toEqual([]);
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

  it("accepts a stage sending items to one that records its entry, bare or capped", () => {
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
   * stage does not list halts the item there.
   */
  it("refuses a target whose entry writes no record", () => {
    expect(said(w(["c"]))).toEqual([expect.stringMatching(/"c".*records no "enter"/)]);
  });

  it("refuses a route that sends items somewhere its stage does not list", () => {
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

/*
 * A workflow placed by the item's own state — "merge requests waiting for my
 * review" — has no stage an item is entered at: every stage is where an
 * item's labels say it is, and it leaves when they change. Nothing is ever
 * "entered", so an entry stage it lacks is not a defect, and a stage no
 * trigger leads to is reached by its identity. A stage only the engine can
 * put an item at — by a transition, or an identity that reads nothing but the
 * position the engine writes — still needs a way in.
 */
describe("structural validation, of a workflow placed by the item's own state", () => {
  const mine = (label: string) => ({ "node.state.labels": { $in: [label] } });
  const notMine = (label: string) => ({ "node.state.labels": { $nin: [label] } });

  it("asks no entry stage of a workflow whose every open stage its identity places", () => {
    const w = wf([
      { id: "reviewing", waits: "person", identity: notMine("approved") },
      { id: "approved", terminal: true, identity: mine("approved") },
    ]);
    expect(validateStructure(w)).toEqual([]);
  });

  it("still asks for one when an open stage only a transition could place an item at", () => {
    const w = wf([
      { id: "reviewing", waits: "person", identity: notMine("approved") },
      { id: "chasing", triggers: [{ when: { "run.stage": "reviewing" } }] },
      { id: "approved", terminal: true, identity: mine("approved") },
    ]);
    expect(rules(w)).toContain("entry");
  });

  it("does not take an identity reading only the position for a placement by state", () => {
    const w = wf([
      { id: "reviewing", identity: { "run.stage": "reviewing" } },
      { id: "approved", terminal: true, identity: mine("approved") },
    ]);
    expect(rules(w)).toContain("entry");
  });

  // Every unwritten item is at no stage, whatever its own state: an identity
  // reading only that reads nothing the tracker holds.
  it("does not take an identity reading only that nothing was written for a placement by state", () => {
    const w = wf([
      { id: "fresh", identity: { "run.stage": null } },
      { id: "approved", terminal: true, identity: mine("approved") },
    ]);
    expect(rules(w)).toContain("entry");
  });

  /*
   * A relation is not on the listed node: Needs you, a notification and the
   * MCP place an item from the node alone, so a stage only its relations put
   * it at showed it nowhere — queued, at no stage, never told — while the
   * engine waited on it there.
   */
  it("still asks for one of a workflow whose open stage its relations place", () => {
    const w = wf([
      { id: "reviewing", waits: "person", identity: { "rel.implements.in.not.merged": { $gt: 0 } } },
      { id: "idle", terminal: true, identity: { "rel.implements.in.not.merged": 0 } },
    ]);
    expect(validateStructure(w)).toContainEqual({ rule: "entry", message: "no stage has entry: true, so no item can start" });
  });

  it("still asks for one of a workflow whose every stage is terminal", () => {
    expect(rules(wf([{ id: "done", terminal: true, identity: mine("done") }]))).toContain("entry");
  });

  it("still flags a stage nothing reaches beside ones the item's state places it at", () => {
    const problems = validateStructure(wf([
      { id: "reviewing", waits: "person", identity: notMine("approved") },
      { id: "approved", terminal: true, identity: mine("approved") },
      { id: "archived", terminal: true },
    ]));
    expect(problems).toEqual([{ rule: "reachability", message: 'nothing can reach stage "archived"' }]);
  });
});

/*
 * `pull.merge`'s guards, as the workflow writes them. A `refuse` the kit
 * would read as nothing protected is the gate quietly off, so a shape it
 * cannot read is said at load, not met on an item merging.
 */
describe("a merge's guards", () => {
  const merging = (merge: Record<string, unknown>): Workflow => wf([
    { id: "a", entry: true, triggers: [{ when: { "run.stage": null } }] },
    { id: "m", triggers: [{ when: { "run.stage": "a" } }], on_enter: [{ type: "pull.merge", branch: "landrace/{item}", ...merge }] },
    { id: "z", terminal: true, triggers: [{ when: { "run.stage": "m" } }] },
  ]);
  const said = (w: Workflow) => validateStructure(w).filter((p) => p.rule === "merge-guard").map((p) => p.message);

  it("accepts a merge with no guards, and one whose refuse is a list of globs", () => {
    expect(said(merging({}))).toEqual([]);
    expect(said(merging({ refuse: [".landrace/hooks/**", "package.json"] }))).toEqual([]);
  });

  it.each([
    ["a string", "package.json"],
    ["an empty list", []],
    ["a list with an empty glob", ["package.json", ""]],
    ["a list with a number", ["package.json", 7]],
    ["nothing at all", null],
  ])("refuses a refuse that is %s, naming the stage", (_what, refuse) => {
    expect(said(merging({ refuse }))).toEqual([expect.stringMatching(/stage "m".*refuse/)]);
  });

  /*
   * `reviewedBy` holds the merge to the head a stage's step started at, which
   * the runner records only for a step on a branch: a stage with no step or
   * no branch would record none, and every merge would answer unreviewed.
   */
  const reviewing = (review: Partial<Stage>, by: unknown = "r"): Workflow => wf([
    { id: "a", entry: true, triggers: [{ when: { "run.stage": null } }] },
    { id: "r", triggers: [{ when: { "run.stage": "a" } }], on_enter: [enter], ...review },
    { id: "m", triggers: [{ when: { "run.stage": "r" } }], on_enter: [{ type: "pull.merge", branch: "landrace/{item}", reviewedBy: by }] },
    { id: "z", terminal: true, triggers: [{ when: { "run.stage": "m" } }] },
  ]);
  const enter = { type: "tracker.comment", kind: "enter", marker: "enter:{stage}:{round}" };

  it("accepts a reviewedBy naming a stage with a step and a branch", () => {
    expect(said(reviewing({ step: "review.md", branch: "landrace/{item}" }))).toEqual([]);
  });

  it.each([
    ["a stage that runs no step", { branch: "landrace/{item}" }, "r", /"r".*no step/],
    ["a stage on no branch", { step: "review.md" }, "r", /"r".*no branch/],
    ["no stage at all", { step: "review.md", branch: "landrace/{item}" }, "nope", /"nope".*not a stage/],
    ["no stage's name", { step: "review.md", branch: "landrace/{item}" }, 7, /reviewedBy/],
  ])("refuses a reviewedBy naming %s", (_what, review, by, message) => {
    expect(said(reviewing(review, by))).toEqual([expect.stringMatching(message)]);
  });
});

/* `head` is the engine's to stamp on a step's record, as `goto` and `from` are. */
describe("the head a record carries", () => {
  it("is refused in an effect the workflow writes", () => {
    const w = wf([
      { id: "a", entry: true, triggers: [{ when: { "run.stage": null } }], on_enter: [{ type: "tracker.comment", kind: "enter", head: "abc" }] },
      { id: "z", terminal: true, triggers: [{ when: { "run.stage": "a" } }] },
    ]);
    expect(validateStructure(w)).toContainEqual(expect.objectContaining({ rule: "reserved-field", message: expect.stringMatching(/"head"/) }));
  });
});

/*
 * The halt labels are the shared vocabulary's contract (separation review
 * I3): the engine never writes `lr:blocked` or `lr:screened`, yet the board's
 * Retry and Clear, MCP's `blocked` and Needs you's note read them. So a stage
 * entered on a failed round writes them itself: `lr:blocked` on any failure,
 * and `lr:screened` beside it on a refusal.
 */
describe("a halt's labels", () => {
  const halting = (when: Record<string, unknown>, on_enter: NonNullable<Stage["on_enter"]>): Workflow => wf([
    { id: "a", entry: true, triggers: [{ when: { "run.stage": null } }] },
    { id: "h", triggers: [{ name: "it failed", when }], on_enter },
    { id: "z", terminal: true, triggers: [{ when: { "run.stage": "a" } }] },
  ]);
  const said = (w: Workflow) => validateStructure(w).filter((p) => p.rule === "halt-labels").map((p) => p.message);
  const label = (add: string[], remove: string[] = []) => ({ type: "tracker.label", add, remove });
  const broken = { "run.lastOutputValid": false, "run.lastRefused": false };
  const refused = { "run.lastOutputValid": false, "run.lastRefused": true };

  it("accepts a halt that adds lr:blocked on a broken contract, and both on a refusal", () => {
    expect(said(halting(broken, [{ type: "tracker.status", value: "h" }, label(["lr:blocked"], ["lr:working"])]))).toEqual([]);
    expect(said(halting(refused, [label(["lr:blocked", "lr:screened"])]))).toEqual([]);
    // Across two label effects, and spelled with $eq, it is the same.
    expect(said(halting({ "run.lastOutputValid": { $eq: false }, "run.lastRefused": { $eq: true } }, [label(["lr:blocked"]), label(["lr:screened"])])))
      .toEqual([]);
  });

  it("refuses a stage entered on a broken contract that does not add lr:blocked, naming it and the trigger", () => {
    expect(said(halting(broken, [{ type: "tracker.status", value: "h" }, label(["lr:awaiting"])]))).toEqual([
      expect.stringMatching(/stage "h".*"it failed".*lr:blocked/),
    ]);
    expect(said(halting({ "run.lastOutputValid": false }, []))).toEqual([expect.stringMatching(/lr:blocked/)]);
  });

  it("refuses a stage entered on a refusal that adds lr:blocked without lr:screened, or neither", () => {
    expect(said(halting(refused, [label(["lr:blocked"])]))).toEqual([expect.stringMatching(/stage "h".*lr:screened/)]);
    expect(said(halting(refused, [label([], ["lr:blocked", "lr:screened"])]))).toEqual([expect.stringMatching(/lr:blocked, lr:screened/)]);
  });

  it("asks nothing of a stage no failed round enters", () => {
    expect(said(halting({ "run.stage": "a", "run.lastOutputValid": null }, []))).toEqual([]);
  });
});
