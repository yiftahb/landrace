import { decide } from "#core/decide.js";
import type { Snapshot } from "#namespace.js";
import { loadWorkflow } from "#workflow/load.js";
import { validate } from "#workflow/validate.js";

const run = (o: object = {}) => ({
  stage: null, counters: {}, outputs: {}, lastOutputValid: null, failedStages: [], rounds: {},
  lastEvent: { actor: null, at: null }, lastHuman: null, unblockedAt: 0, ...o,
});
/** A fresh, eligible ticket with `parents` outgoing child-of edges. */
const fresh = (parents: number): Snapshot => ({
  node: { id: "7", kind: "ticket", title: "t", link: "", closed: null, priority: null, origin: null,
    state: { labels: ["lr:auto"], assignees: [] } },
  rel: {
    "child-of": { in: { total: 0 }, out: { total: parents } },
    implements: { in: { total: 0 }, out: { total: 0 } },
  },
  run: run(),
} as unknown as Snapshot);

describe("the shipped workflow's entry stages", () => {
  it("validates clean", async () => {
    const { workflow, steps } = await loadWorkflow(".landrace");
    expect(validate(workflow, steps)).toEqual([]);
  });

  it("has exactly two, spec and build", async () => {
    const { workflow } = await loadWorkflow(".landrace");
    expect(workflow.stages.filter((s) => s.entry).map((s) => s.id).sort()).toEqual(["build", "spec"]);
  });

  it("starts a top-level ticket at spec", async () => {
    const { workflow } = await loadWorkflow(".landrace");
    expect(decide(workflow, fresh(0))).toMatchObject({ action: "transition", to: { id: "spec" }, round: 1 });
  });

  it("starts a child at build, skipping planning", async () => {
    const { workflow } = await loadWorkflow(".landrace");
    expect(decide(workflow, fresh(1))).toMatchObject({ action: "transition", to: { id: "build" }, round: 1 });
  });

  it("does not drag a child already under review back to build", async () => {
    const { workflow } = await loadWorkflow(".landrace");
    const s = { ...fresh(1), run: run({ stage: "code-review", rounds: { "code-review": { entered: 1, output: 0 } } }) } as Snapshot;
    // Requires a PR to be there (code-review's `requires`); what matters is it
    // is not a transition to build.
    expect(decide(workflow, s)).not.toMatchObject({ action: "transition", to: { id: "build" } });
  });

  it("tells the build step what to work from when there is no spec", async () => {
    const { steps } = await loadWorkflow(".landrace");
    const build = steps.get("steps/build.md")?.prompt ?? "";
    expect(build).toContain("{ticket.body}");
    expect(build).toContain("{artifacts.spec.url}");
    const review = steps.get("steps/code-review.md")?.prompt ?? "";
    expect(review).toContain("{ticket.body}");
  });
});
