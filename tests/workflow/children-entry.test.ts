import { decide } from "#core/decide.js";
import type { Snapshot } from "#namespace.js";
import { loadWorkflow } from "#workflow/load.js";
import { validate } from "#workflow/validate.js";

/**
 * Two entry stages, chosen by origin: the engine's child-ticket feature as a
 * project enables it. The shipped workflow is a single flow and has none of
 * this, so it is driven through the fixture that does.
 */
const FIXTURE = "tests/fixtures/children";

const run = (o: object = {}) => ({
  stage: null, counters: {}, outputs: {}, lastOutputValid: null, failedStages: [], rounds: {},
  lastEvent: { actor: null, at: null }, lastHuman: null, unblockedAt: 0, ...o,
});
/**
 * A fresh, eligible ticket with `parents` outgoing child-of edges, made by a
 * breakdown (an origin) or by a person (none), whose parent — if any — sits
 * at `parentStage`.
 */
const fresh = (parents: number, o: { origin?: boolean; parentStage?: string } = {}): Snapshot => ({
  node: { id: "7", kind: "ticket", title: "t", link: "", closed: null, priority: null,
    origin: o.origin ? { parent: "3", stage: "breakdown", round: 1 } : null,
    state: { labels: ["lr:auto"], assignees: [] } },
  rel: {
    "child-of": { in: { total: 0, stage: {} }, out: { total: parents, stage: o.parentStage ? { [o.parentStage]: 1 } : {} } },
    implements: { in: { total: 0, stage: {} }, out: { total: 0, stage: {} } },
  },
  run: run(),
} as unknown as Snapshot);

describe("the children fixture's entry stages", () => {
  it("validates clean", async () => {
    const { workflow, steps } = await loadWorkflow(FIXTURE);
    expect(validate(workflow, steps)).toEqual([]);
  });

  it("has exactly two, spec and build", async () => {
    const { workflow } = await loadWorkflow(FIXTURE);
    expect(workflow.stages.filter((s) => s.entry).map((s) => s.id).sort()).toEqual(["build", "spec"]);
  });

  it("starts a top-level ticket at spec", async () => {
    const { workflow } = await loadWorkflow(FIXTURE);
    expect(decide(workflow, fresh(0))).toMatchObject({ action: "transition", to: { id: "spec" }, round: 1 });
  });

  it("starts a breakdown's child at build once its parent waits on children, skipping planning", async () => {
    const { workflow } = await loadWorkflow(FIXTURE);
    expect(decide(workflow, fresh(1, { origin: true, parentStage: "children-running" })))
      .toMatchObject({ action: "transition", to: { id: "build" }, round: 1 });
  });

  it("holds a breakdown's child while its parent is still breaking down", async () => {
    // The breakdown may yet fail or be revised, dropping this child: building
    // it now would spend a paid step on work that may be thrown away.
    const { workflow } = await loadWorkflow(FIXTURE);
    expect(decide(workflow, fresh(1, { origin: true, parentStage: "breakdown" })))
      .toMatchObject({ action: "halt", why: expect.stringMatching(/no entry stage accepts/) });
  });

  it("starts a sub-issue a person made at spec: nobody planned it", async () => {
    const { workflow } = await loadWorkflow(FIXTURE);
    expect(decide(workflow, fresh(1, { parentStage: "children-running" })))
      .toMatchObject({ action: "transition", to: { id: "spec" }, round: 1 });
  });

  it("does not drag a child already under review back to build", async () => {
    const { workflow } = await loadWorkflow(FIXTURE);
    const s = { ...fresh(1, { origin: true, parentStage: "children-running" }), run: run({ stage: "code-review", rounds: { "code-review": { entered: 1, output: 0 } } }) } as Snapshot;
    // Requires a PR to be there (code-review's `requires`); what matters is it
    // is not a transition to build.
    expect(decide(workflow, s)).not.toMatchObject({ action: "transition", to: { id: "build" } });
  });

  it("tells the build step what to work from when there is no spec", async () => {
    const { steps } = await loadWorkflow(FIXTURE);
    const build = steps.get("steps/build.md")?.prompt ?? "";
    expect(build).toContain("{ticket.body}");
    expect(build).toContain("{artifacts.spec.url}");
    const review = steps.get("steps/code-review.md")?.prompt ?? "";
    expect(review).toContain("{ticket.body}");
  });
});
