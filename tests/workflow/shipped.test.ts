import { readFile } from "node:fs/promises";
import { decide } from "#core/decide.js";
import type { Snapshot } from "#namespace.js";
import { loadWorkflow } from "#workflow/load.js";

/**
 * `tests/esm/cli-validate.test.ts` already proves the shipped workflow
 * validates clean against the GitHub hook's declared paths and relations —
 * "validates the shipped .landrace workflow clean, on every rule" runs
 * `runValidate(".landrace")`, which is `validate()` plus `snapshotProvides()`
 * plus the config and secret checks. A second case here asking the narrower
 * question would only re-run the same coverage rule against the same files.
 *
 * What that file does not check is that the old, pre-graph vocabulary is
 * actually gone from the source rather than merely unreachable — a stale
 * `artifacts.pr.*` or `"ticket.labels"` path left in a comment or an unused
 * branch would not fail validation but would still mislead the next reader.
 */
describe("the shipped .landrace workflow", () => {
  it("reads no path the graph removed", async () => {
    const text = await readFile(".landrace/workflow.yaml", "utf8");
    expect(text).not.toMatch(/artifacts\.pr\./);
    expect(text).not.toMatch(/"ticket\.labels"/);
  });
});

/**
 * This project does not split its work: the shipped workflow is one straight
 * flow, spec to build to review to done. Child tickets are an engine feature a
 * project enables in its own workflow — `tests/fixtures/children` is the
 * example, and where the feature is tested — so none of it may creep back in
 * here by way of a copied stage.
 */
describe("the shipped workflow is a single flow", () => {
  const fresh = (origin: boolean): Snapshot => ({
    node: { id: "7", kind: "ticket", title: "t", link: "", closed: null, priority: null,
      origin: origin ? { parent: "3", stage: "breakdown", round: 1 } : null,
      state: { labels: ["lr:auto"], assignees: [] } },
    rel: { implements: { in: { total: 0, stage: {} }, out: { total: 0, stage: {} } } },
    run: {
      stage: null, counters: {}, outputs: {}, lastOutputValid: null, failedStages: [], rounds: {},
      lastEvent: { actor: null, at: null }, lastHuman: null, unblockedAt: 0,
    },
  } as unknown as Snapshot);

  it("has one entry stage, spec, and every fresh ticket enters it", async () => {
    const { workflow } = await loadWorkflow(".landrace");
    expect(workflow.stages.filter((s) => s.entry).map((s) => s.id)).toEqual(["spec"]);
    for (const origin of [false, true]) {
      expect(decide(workflow, fresh(origin))).toMatchObject({ action: "transition", to: { id: "spec" }, round: 1 });
    }
  });

  it("declares no breakdown, no child tickets and nothing that closes them", async () => {
    const { workflow, steps } = await loadWorkflow(".landrace");
    const ids = workflow.stages.map((s) => s.id);
    expect(ids).not.toContain("breakdown");
    expect(ids).not.toContain("children-running");
    expect([...steps.values()].flatMap((s) => s.capabilities ?? [])).not.toContain("tickets:create");
    expect(workflow.stages.flatMap((s) => (s.on_enter ?? []).map((e) => e.type))).not.toContain("nodes.close");
    const text = await readFile(".landrace/workflow.yaml", "utf8");
    expect(text).not.toMatch(/rel\.child-of|node\.origin/);
  });

  it("goes from an approved spec straight to build", async () => {
    const { workflow } = await loadWorkflow(".landrace");
    const build = workflow.stages.find((s) => s.id === "build");
    expect(build?.triggers?.map((t) => t.when)).toEqual([
      { "run.stage": "triage", "run.outputs.triage.intent": "approve" },
    ]);
  });
});
