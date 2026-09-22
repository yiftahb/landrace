import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflow, WorkflowLoadError } from "#workflow/load.js";
import { substituteVars } from "#workflow/vars.js";

const vars = (entries: Record<string, string>): Map<string, string> => new Map(Object.entries(entries));

/**
 * A variable is configuration, not state: it is the same for every ticket, so
 * it is resolved once and substituted into the workflow at load, and the
 * validator then sees a literal exactly as if it had been typed.
 *
 * Substitution walks the *parsed* tree rather than the file's text, and that
 * is the property most of these tests are about. A value carrying a colon, a
 * newline or a quote would otherwise reshape the YAML around it — the same
 * class of hole as an unescaped marker, arriving through the operator's own
 * environment instead of through a comment.
 */
describe("substituting vars over a parsed tree", () => {
  it("fills a reference in a predicate operand", () => {
    const tree = { eligible: [{ when: { "ticket.assignees": { $in: ["{vars.assignee}"] } }, else: "not yours" }] };
    const out = substituteVars(tree, vars({ assignee: "ann" }), "workflow.yaml");
    expect(out.value).toEqual({ eligible: [{ when: { "ticket.assignees": { $in: ["ann"] } }, else: "not yours" }] });
    expect(out.used).toEqual(["assignee"]);
    expect(out.unresolved).toEqual([]);
  });

  /*
   * The reason this walks the tree. Substituted into the text, a value like
   * this ends the mapping it sits in and starts a list of its own — and the
   * workflow that loads is not the workflow anybody wrote.
   */
  it("keeps a value carrying a colon, a newline and a quote as one string", () => {
    const hostile = 'a: b\n- c\n"quoted"';
    const out = substituteVars({ stages: [{ id: "s", on_enter: [{ body: "{vars.note}" }] }] }, vars({ note: hostile }), "w");
    expect(out.value).toEqual({ stages: [{ id: "s", on_enter: [{ body: hostile }] }] });
  });

  /*
   * The engine's own templates share the syntax and must survive untouched:
   * `{round}` and `{stage}` are filled per entry by expandEffectFields, and
   * `{ticket.title}` per invocation by renderPrompt. A substitution pass that
   * ate them would leave a marker with no round in it, which is how a looping
   * stage stops being able to tell it owes another pass.
   */
  it("leaves every template that is not a var exactly as it found it", () => {
    const body = "Round {round} of {stage}, shape {shape}, for {ticket.title} — {vars.team}";
    const out = substituteVars({ body }, vars({ team: "platform" }), "w");
    expect(out.value).toEqual({ body: "Round {round} of {stage}, shape {shape}, for {ticket.title} — platform" });
    // And not merely left in place: a pass that *considered* `{round}` a var
    // reference would leave the text identical and report it as undefined,
    // which is the same workflow refused at load for no reason.
    expect(out.unresolved).toEqual([]);
  });

  /*
   * The namespace, attacked from the other side: a var called `round` must not
   * be able to fill in `{round}`, which the engine owns and fills per entry.
   * Only `{vars.round}` is this pass's to answer for.
   */
  it("cannot shadow an engine template even when a var is named after one", () => {
    const out = substituteVars({ marker: "enter:{stage}:{round}" }, vars({ round: "9", stage: "x" }), "w");
    expect(out.value).toEqual({ marker: "enter:{stage}:{round}" });
    expect(out.used).toEqual([]);
  });

  it("reports a reference no var defines, with the file and the field it was written in", () => {
    const out = substituteVars(
      { stages: [{ id: "s", on_enter: [{ type: "tracker.comment", body: "hi {vars.nope}" }] }] },
      vars({ assignee: "ann" }),
      "workflow.yaml",
    );
    expect(out.unresolved).toEqual(["workflow.yaml stages[0].on_enter[0].body uses {vars.nope}"]);
  });

  it("reports every unresolved reference rather than the first", () => {
    const out = substituteVars({ a: "{vars.x}", b: ["{vars.y}"] }, vars({}), "w");
    expect(out.unresolved).toHaveLength(2);
    expect(out.unresolved.join("\n")).toMatch(/w a uses \{vars\.x\}[\s\S]*w b\[0\] uses \{vars\.y\}/);
  });

  /*
   * Counted from what was actually filled in, not from what was declared:
   * "this var is never referenced" is the other half of the rule, and a
   * `used` that merely echoed the map back would make it unfalsifiable.
   */
  it("names only the vars it really filled in", () => {
    const out = substituteVars({ a: "{vars.x}" }, vars({ x: "1", y: "2" }), "w");
    expect(out.used).toEqual(["x"]);
  });

  /*
   * One pass, never a second over its own output. A value is data, not more
   * template — otherwise what an environment variable holds decides what the
   * next substitution reads, and `{ticket.body}` planted in an env var would
   * be filled in by renderPrompt at invocation time with whoever opened the
   * ticket's words.
   */
  it("does not expand what a value itself contains", () => {
    const out = substituteVars({ a: "{vars.x}" }, vars({ x: "{vars.y}", y: "z" }), "w");
    expect(out.value).toEqual({ a: "{vars.y}" });
    expect(out.used).toEqual(["x"]);
  });

  it("leaves a tree with no templates in it alone, and uses nothing", () => {
    const out = substituteVars({ n: 3, ok: true, nil: null, s: "plain" }, vars({ x: "1" }), "w");
    expect(out.value).toEqual({ n: 3, ok: true, nil: null, s: "plain" });
    expect(out.used).toEqual([]);
  });
});

describe("loadWorkflow substitutes vars into the graph and the steps", () => {
  const dirs: string[] = [];
  afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }); });

  const workflowDir = (yaml: string, step?: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "landrace-vars-"));
    writeFileSync(join(dir, "workflow.yaml"), yaml);
    if (step !== undefined) {
      mkdirSync(join(dir, "steps"));
      writeFileSync(join(dir, "steps", "spec.md"), step);
    }
    dirs.push(dir);
    return dir;
  };

  const GRAPH = `version: 1
name: t
eligible:
  - when: { "ticket.assignees": { $in: ["{vars.assignee}"] } }
    else: "assigned to somebody else"
stages:
  - id: a
    entry: true
    step: steps/spec.md
    on_enter:
      - { type: tracker.comment, kind: enter, marker: "enter:{stage}:{round}", body: "{vars.assignee} is on this, round {round}." }
`;
  const STEP = `---
output:
  discriminator: kind
  shapes: { spec: {} }
  routes:
    - when: { kind: spec }
      effect: { type: tracker.comment, marker: "spec:{round}", label: "{vars.team}" }
---
Write the spec for {ticket.title}, for the {vars.team} team.
`;

  it("fills a predicate operand, an effect field and a step prompt from one map", async () => {
    const { workflow, steps } = await loadWorkflow(
      workflowDir(GRAPH, STEP),
      vars({ assignee: "ann", team: "platform" }),
    );

    expect(workflow.eligible?.[0]?.when).toEqual({ "ticket.assignees": { $in: ["ann"] } });
    // And the engine's own per-entry templates are still there to be filled.
    expect(workflow.stages[0]?.on_enter?.[0]?.body).toBe("ann is on this, round {round}.");
    const step = steps.get("steps/spec.md");
    expect(step?.prompt.trim()).toBe("Write the spec for {ticket.title}, for the platform team.");
    expect(step?.output?.routes[0]?.effect.label).toBe("platform");
  });

  it("refuses a reference no var defines, naming the variable, where it was used and what is declared", async () => {
    const err = await loadWorkflow(workflowDir(GRAPH, STEP), vars({ assignee: "ann" })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowLoadError);
    expect((err as WorkflowLoadError).rule).toBe("vars");
    expect((err as Error).message).toMatch(/\{vars\.team\}/);
    expect((err as Error).message).toMatch(/steps\/spec\.md/);
    expect((err as Error).message).toMatch(/assignee/);
  });

  /*
   * The typo at the other end: `vars: { asignee: ... }` resolves, substitutes
   * nothing, and leaves the reference in the graph — so the unknown-reference
   * rule above catches one half and this catches the other. Harmless on its
   * own, which is exactly why it has to be said out loud.
   */
  it("refuses a declared var that nothing in the workflow references", async () => {
    const err = await loadWorkflow(
      workflowDir(GRAPH, STEP),
      vars({ assignee: "ann", team: "platform", unused: "x" }),
    ).catch((e: unknown) => e);
    expect((err as WorkflowLoadError).rule).toBe("vars");
    expect((err as Error).message).toMatch(/"unused"/);
  });

  /*
   * The tree-not-text rule, asked of the loader rather than of the walker,
   * because the loader is where the choice between them lives. Substituted
   * into the file's text, this value closes the flow mapping it sits in and
   * opens a second rule: the document still parses and the schema still
   * passes, so nothing downstream would notice. Pinned by loading a workflow
   * that survives it — a text pass fails this test rather than producing a
   * graph nobody wrote, which is the whole property.
   */
  it("loads a var whose value is itself YAML without letting it reshape the document", async () => {
    const graph = `version: 1
name: t
eligible:
  - { when: { "ticket.labels": { $in: ["lr:auto"] } }, else: "{vars.note}" }
stages:
  - id: a
    entry: true
`;
    const note = 'nope" }\n  - { when: {}, else: "owned';
    const { workflow } = await loadWorkflow(workflowDir(graph), vars({ note }));
    expect(workflow.eligible).toHaveLength(1);
    expect(workflow.eligible?.[0]?.else).toBe(note);
  });

  it("loads a workflow with no vars at all exactly as before", async () => {
    const plain = `version: 1\nname: t\nstages:\n  - id: a\n    entry: true\n`;
    const { workflow } = await loadWorkflow(workflowDir(plain));
    expect(workflow.stages).toHaveLength(1);
  });

  /*
   * A var in the graph with nothing supplying it is the same unknown
   * reference, and it has to be reported as one rather than left in place:
   * `$in: ["{vars.assignee}"]` is a filter that matches no ticket, and a
   * silent pass here is a repository where nothing ever happens.
   */
  it("refuses a graph that references a var when none were supplied at all", async () => {
    const err = await loadWorkflow(workflowDir(GRAPH, STEP)).catch((e: unknown) => e);
    expect((err as WorkflowLoadError).rule).toBe("vars");
    expect((err as Error).message).toMatch(/no vars are declared/);
  });
});
