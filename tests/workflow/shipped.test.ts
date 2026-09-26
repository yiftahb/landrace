import { readFile } from "node:fs/promises";
import { decide } from "#core/decide.js";
import type { Snapshot } from "#namespace.js";
import { renderPrompt } from "#runner/step.js";
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
      stage: null, counters: {}, outputs: {}, lastOutputValid: null, lastRefused: null, failedStages: [], rounds: {},
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

  it("goes from an approved spec straight to build, and comes back to it only when a build is handed back", async () => {
    const { workflow } = await loadWorkflow(".landrace");
    const build = workflow.stages.find((s) => s.id === "build");
    expect(build?.triggers?.map((t) => t.when)).toEqual([
      { "run.stage": "triage", "run.lastOutputValid": null, "run.outputs.triage.intent": "approve" },
      ...["blocked", "screened"].map((from) => ({
        "run.stage": from,
        "run.lastEvent.actor": "human",
        "run.failedStages": { $in: ["build"] },
        "run.counters.build": { $lt: 3 },
      })),
    ]);
  });
});

/*
 * A failed round goes to exactly one of the two halts: `blocked` for a
 * broken contract, `screened` for a security refusal. Two matching is an
 * ambiguity halt at the one moment a person most needs the ticket placed,
 * and none matching leaves it at the failed stage with nothing to say why.
 */
describe("the shipped workflow splits every failure between blocked and screened", () => {
  const failedAt = (stage: string, refused: boolean): Snapshot => ({
    node: { id: "7", kind: "ticket", title: "t", link: "", closed: null, priority: null, origin: null,
      state: { labels: ["lr:auto", `lr:stage:${stage}`], assignees: [] } },
    rel: { implements: { in: { total: 1, not: { merged: 1 }, sum: { openThreads: 0 }, stage: {} }, out: { total: 0, stage: {} } } },
    run: {
      stage, counters: { spec: 1, triage: 1, build: 1, "code-review": 1, "fix-review": 1 },
      // Every earlier round's output still on the ticket, the way it is at
      // any failure past the first: a trigger routing on one of them must
      // not fire from a round that failed.
      outputs: {
        spec: { kind: "spec" }, triage: { intent: "approve" }, build: { kind: "done" },
        "code-review": { kind: "reviewed" }, "fix-review": { kind: "addressed" },
      },
      lastOutputValid: false, lastRefused: refused,
      failedStages: [stage], rounds: { [stage]: { entered: 2, output: 1 } },
      // A person has spoken — triage requires it — and every loop has run once.
      lastEvent: { actor: "agent", at: null },
      lastHuman: { stage: "-", kind: "human", round: 0, at: "2026-01-01T00:00:00.000Z", byAgent: false },
      unblockedAt: 0,
    },
  } as unknown as Snapshot);

  it.each([true, false])("sends a failed round of every step to exactly one halt (refused: %s)", async (refused) => {
    const { workflow } = await loadWorkflow(".landrace");
    const stepped = workflow.stages.filter((s) => s.step).map((s) => s.id);
    expect(stepped.length).toBeGreaterThan(0);
    for (const stage of stepped) {
      expect(decide(workflow, failedAt(stage, refused))).toMatchObject({
        action: "transition", to: { id: refused ? "screened" : "blocked" },
      });
    }
  });

  /*
   * A reply at a halt goes somewhere, whatever the budgets say — until every
   * budget it could spend is spent. A build whose three rounds were all
   * refused used to have no route at all: the build handback needs budget
   * left and the spec handback excluded a failed build, so a spec text that
   * tripped the screener could be retried until the budget ran out and then
   * never revised.
   */
  it.each(["blocked", "screened"])("hands a reply at %s to exactly one stage while a budget is left", async (halt) => {
    const { workflow } = await loadWorkflow(".landrace");
    const at = (failedStages: string[], build: number, spec: number): Snapshot => {
      const s = failedAt(halt, halt === "screened");
      const run = s.run as object;
      return { ...s, run: { ...run, stage: halt, failedStages, counters: { spec, build },
        lastEvent: { actor: "human", at: null } } } as unknown as Snapshot;
    };
    const to = (failedStages: string[], build: number, spec = 1): string => {
      const d = decide(workflow, at(failedStages, build, spec));
      return d.action === "transition" ? d.to?.id ?? "?" : d.action;
    };

    expect(to(["build"], 1)).toBe("build");
    expect(to(["build"], 3)).toBe("spec");
    expect(to(["code-review", "build"], 3)).toBe("spec");
    expect(to(["spec"], 1)).toBe("spec");
    expect(to([], 3)).toBe("spec");
    expect(to(["build"], 3, 3)).not.toBe("spec");
  });

  it("marks a screened ticket blocked too, and says why beside it", async () => {
    const { workflow } = await loadWorkflow(".landrace");
    const screened = workflow.stages.find((s) => s.id === "screened");
    expect(screened?.on_enter).toContainEqual(
      expect.objectContaining({ type: "tracker.label", add: ["lr:blocked", "lr:screened"] }),
    );
  });

  it("takes lr:screened off again wherever a halt is handed back to", async () => {
    const { workflow } = await loadWorkflow(".landrace");
    const targets = workflow.stages.filter((s) =>
      (s.triggers ?? []).some((t) => t.when["run.stage"] === "screened" || t.when["run.stage"] === "blocked"));
    expect(targets.map((s) => s.id).sort()).toEqual(["build", "spec"]);
    for (const stage of targets) {
      const removed = (stage.on_enter ?? []).flatMap((e) => (e.type === "tracker.label" ? (e.remove as string[]) : []));
      expect(removed).toEqual(expect.arrayContaining(["lr:blocked", "lr:screened"]));
    }
  });
});

/*
 * Ticket #19: the build prompt said "the approved spec is at <url>", the
 * screener refused it as an instruction to fetch something off the network —
 * which it was — and the URL was a blob in a private repository the agent
 * could not have opened anyway. Every step that works from the spec is handed
 * its text, and a link, where one is kept, is only a reference for a person.
 */
describe("the shipped steps are handed the approved spec as text", () => {
  const WORKING_FROM_THE_SPEC = ["build", "code-review", "fix-review"];
  const snapshot = { node: { id: "7", title: "Add export" }, artifacts: { spec: { url: "https://example.test/specs/7" } } } as unknown as Snapshot;

  it.each(WORKING_FROM_THE_SPEC)("%s embeds the spec and sends nobody off to fetch it", async (id) => {
    const { steps } = await loadWorkflow(".landrace");
    const prompt = steps.get(`steps/${id}.md`)?.prompt ?? "";

    expect(prompt).toContain("{brief.spec.content}");
    // The paragraph that keeps the link tells nobody to go to it: not the
    // sentence #19's screener refused, and no imperative that would be it again.
    const paragraph = prompt.split(/\n\s*\n/).find((p) => p.includes("{artifacts.spec.url}")) ?? "";
    expect(paragraph).not.toMatch(/is at \{artifacts\.spec\.url\}/i);
    expect(paragraph).not.toMatch(/(^|[.:;]\s+)(open|fetch|read|visit|follow|download|go to|see|check|consult|refer to|use)\b/im);
  });

  it.each(WORKING_FROM_THE_SPEC)("%s renders the spec's text, delimited, with no placeholder left", async (id) => {
    const { steps } = await loadWorkflow(".landrace");
    const rendered = renderPrompt(steps.get(`steps/${id}.md`)?.prompt ?? "", snapshot, {
      spec: { content: "# Export CSV\n\nOne file, comma separated." },
      github: { threads: "1. src/x.ts:12 — this leaks a file handle" },
    });

    expect(rendered).toContain("One file, comma separated.");
    expect(rendered).not.toMatch(/\{brief\./);
    // Fenced off as the approved spec, so the agent can tell where it ends.
    expect(rendered).toMatch(/approved spec[\s\S]*One file, comma separated\.[\s\S]*end of the approved spec/i);
  });

  it("says so plainly when no spec was published, rather than leaving a hole in the prompt", async () => {
    const { steps } = await loadWorkflow(".landrace");
    const rendered = renderPrompt(steps.get("steps/build.md")?.prompt ?? "", snapshot, {
      spec: { content: "No spec has been published for this ticket." },
    });
    expect(rendered).toContain("No spec has been published for this ticket.");
    expect(rendered).not.toMatch(/\{brief\./);
  });
});
