import { stageSchema, stepFrontMatterSchema } from "#workflow/schema.js";
import { createProblems, validate } from "#workflow/validate.js";
import type { Effect, PostHook, Step, Workflow } from "#namespace.js";

/*
 * A route takes `effect` or `effects`, never both and never neither: one
 * destination for the step's prose, or several fed from the output's fields.
 */
describe("a route's effects", () => {
  const front = (route: Record<string, unknown>) => stepFrontMatterSchema.safeParse({
    output: { discriminator: "kind", shapes: { done: { reply: "string" } }, routes: [{ when: { kind: "done" }, ...route }] },
  });

  it("takes one effect, as every workflow written before it does", () => {
    expect(front({ effect: { type: "tracker.comment", marker: "done:{round}" } }).success).toBe(true);
  });

  it("takes a list of effects", () => {
    const parsed = front({ effects: [{ type: "tracker.comment", from: "reply" }, { type: "tracker.comment" }] });
    expect(parsed.success).toBe(true);
  });

  it("refuses a route with both", () => {
    const parsed = front({ effect: { type: "tracker.comment" }, effects: [{ type: "tracker.comment" }] });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/effect or effects, not both/);
  });

  it("refuses a route with neither", () => {
    const parsed = front({});
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/effect or effects/);
  });

  it("refuses an empty list", () => {
    expect(front({ effects: [] }).success).toBe(false);
  });
});

describe("a stage's closed key", () => {
  it("takes run", () => {
    expect(stageSchema.safeParse({ id: "retro", closed: "run" }).success).toBe(true);
  });

  it("takes nothing else", () => {
    expect(stageSchema.safeParse({ id: "retro", closed: true }).success).toBe(false);
    expect(stageSchema.safeParse({ id: "retro", closed: "skip" }).success).toBe(false);
  });
});

const ENTER = { type: "tracker.comment", kind: "enter", marker: "enter:{stage}:{round}" };

type Routes = NonNullable<Step["output"]>["routes"];

/** A support desk whose diagnose step answers through `routes`. */
const desk = (routes: Routes, onEnter: Effect[] = [ENTER]): { w: Workflow; steps: Map<string, Step> } => ({
  w: {
    version: 1, name: "t", description: "test",
    stages: [
      { id: "diagnose", entry: true, step: "diagnose", on_enter: onEnter },
      { id: "answered", terminal: true, triggers: [{ when: { "run.stage": "diagnose", "run.outputs.diagnose": { $exists: true } } }] },
    ],
  },
  steps: new Map([["diagnose", {
    prompt: "diagnose",
    output: { discriminator: "kind", shapes: { answered: { reply: "string", note: "string" }, unsure: { why: "string" } }, routes },
  }]]),
});

const problems = ({ w, steps }: { w: Workflow; steps: Map<string, Step> }, rule: string): string[] =>
  validate(w, steps).filter((p) => p.rule === rule).map((p) => p.message);

describe("route-from", () => {
  it("passes a from naming a field of the shape its route takes", () => {
    const d = desk([
      { when: { kind: "answered" }, effects: [{ type: "tracker.comment", from: "reply" }, { type: "tracker.comment", from: "note" }] },
      { when: { kind: "unsure" }, effects: [{ type: "tracker.comment", from: "why" }] },
    ]);
    expect(validate(d.w, d.steps)).toEqual([]);
  });

  it("refuses a from naming no field of that shape", () => {
    const d = desk([
      { when: { kind: "answered" }, effects: [{ type: "tracker.comment", from: "nosuch" }] },
      { when: { kind: "unsure" }, effects: [{ type: "tracker.comment", from: "reply" }] },
    ]);
    expect(problems(d, "route-from")).toEqual([
      expect.stringMatching(/step diagnose's route for \{"kind":"answered"\}, effect 0, takes its body from "nosuch", which shape "answered" does not declare/),
      expect.stringMatching(/effect 0, takes its body from "reply", which shape "unsure" does not declare/),
    ]);
  });

  it("refuses a from that is not a field name", () => {
    const d = desk([
      { when: { kind: "answered" }, effects: [{ type: "tracker.comment", from: 3 }] },
      { when: { kind: "unsure" }, effects: [{ type: "tracker.comment", from: "__proto__" }] },
    ]);
    expect(problems(d, "route-from")).toHaveLength(2);
  });

  it("holds a route whose shape it cannot read to a field some shape declares", () => {
    const d = desk([{ when: { kind: { $in: ["answered", "unsure"] } }, effects: [{ type: "tracker.comment", from: "why" }] }]);
    expect(problems(d, "route-from")).toEqual([]);
    const wrong = desk([{ when: { kind: { $in: ["answered", "unsure"] } }, effects: [{ type: "tracker.comment", from: "nosuch" }] }]);
    expect(problems(wrong, "route-from")).toEqual([expect.stringMatching(/"nosuch", which no shape of the step declares/)]);
  });

  it("still refuses from on one effect, and on on_enter, where it is the record's", () => {
    const one = desk([
      { when: { kind: "answered" }, effect: { type: "tracker.comment", from: "reply" } },
      { when: { kind: "unsure" }, effects: [{ type: "tracker.comment" }] },
    ]);
    expect(problems(one, "reserved-field")).toEqual([expect.stringMatching(/a "from" field/)]);
    const entering = desk([
      { when: { kind: "answered" }, effects: [{ type: "tracker.comment" }] },
      { when: { kind: "unsure" }, effects: [{ type: "tracker.comment" }] },
    ], [ENTER, { type: "tracker.comment", from: "x", marker: "m" }]);
    expect(problems(entering, "reserved-field")).toEqual([expect.stringMatching(/a "from" field/)]);
  });
});

describe("tracker-create", () => {
  const filing = (effect: Effect) => desk([
    { when: { kind: "answered" }, effects: [{ type: "tracker.comment", from: "reply" }, effect] },
    { when: { kind: "unsure" }, effects: [{ type: "tracker.comment" }] },
  ]);

  it("asks a project and a title of every tracker.create", () => {
    expect(problems(filing({ type: "tracker.create", project: "ENG", title: "Bug", from: "note" }), "tracker-create")).toEqual([]);
    expect(problems(filing({ type: "tracker.create", title: "Bug" }), "tracker-create")).toEqual([expect.stringMatching(/names no project/)]);
    expect(problems(filing({ type: "tracker.create", project: "ENG" }), "tracker-create")).toEqual([expect.stringMatching(/names no title/)]);
  });

  it("refuses one outside a route's effects with no marker of its own", () => {
    const one = desk([
      { when: { kind: "answered" }, effect: { type: "tracker.create", project: "ENG", title: "Bug" } },
      { when: { kind: "unsure" }, effects: [{ type: "tracker.comment" }] },
    ], [ENTER, { type: "tracker.create", project: "ENG", title: "Bug" }]);
    expect(problems(one, "tracker-create")).toEqual([
      expect.stringMatching(/stage "diagnose" files an issue from its on_enter with no marker/),
      expect.stringMatching(/stage "diagnose" files an issue from step diagnose's route with no marker/),
    ]);
    const marked = desk([
      { when: { kind: "answered" }, effects: [{ type: "tracker.comment" }] },
      { when: { kind: "unsure" }, effects: [{ type: "tracker.comment" }] },
    ], [ENTER, { type: "tracker.create", project: "ENG", title: "Bug", marker: "bug:{round}" }]);
    expect(problems(marked, "tracker-create")).toEqual([]);
  });

  const post = (creates?: string[]): PostHook => ({
    id: "project", handles: ["tracker.comment", "tracker.create"], ...(creates ? { creates } : {}),
    satisfied: () => false, apply: async () => {},
  });

  it("refuses a project no loaded tracker creates in, and passes one it does", () => {
    const d = filing({ type: "tracker.create", project: "ENG", title: "Bug", from: "note" });
    expect(createProblems(d.w, d.steps, [post()])).toEqual([{
      rule: "tracker-create",
      message: expect.stringMatching(/stage "diagnose" files an issue in "ENG", but its tracker files issues in no other project: set the tracker's createIn/),
    }]);
    expect(createProblems(d.w, d.steps, [post(["OPS"])])[0]?.message).toMatch(/files issues in "OPS" only/);
    expect(createProblems(d.w, d.steps, [post(["ENG"])])).toEqual([]);
  });

  it("refuses a workflow none of whose hooks handles tracker.create", () => {
    const d = filing({ type: "tracker.create", project: "ENG", title: "Bug", from: "note" });
    const plain: PostHook = { id: "p", handles: ["tracker.comment"], satisfied: () => false, apply: async () => {} };
    expect(createProblems(d.w, d.steps, [plain])).toHaveLength(1);
  });

  it("asks nothing of a workflow that files nothing", () => {
    const d = desk([
      { when: { kind: "answered" }, effects: [{ type: "tracker.comment" }] },
      { when: { kind: "unsure" }, effects: [{ type: "tracker.comment" }] },
    ]);
    expect(createProblems(d.w, d.steps, [post()])).toEqual([]);
  });
});
