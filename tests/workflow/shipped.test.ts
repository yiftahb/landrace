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
      unblockedAt: 0, goto: null, previousStage: null,
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

  it("marks a screened ticket blocked too, and says why beside it", async () => {
    const { workflow } = await loadWorkflow(".landrace");
    const screened = workflow.stages.find((s) => s.id === "screened");
    expect(screened?.on_enter).toContainEqual(
      expect.objectContaining({ type: "tracker.label", add: ["lr:blocked", "lr:screened"] }),
    );
  });
});

const HOMES = ["spec-questions", "spec-human-review", "pr-human-review", "blocked", "screened"] as const;

const snapshotAt = (stage: string, run: object, rel = { total: 1, merged: 0, openThreads: 0 }): Snapshot => ({
  node: { id: "7", kind: "ticket", title: "t", link: "", closed: null, priority: null, origin: null,
    state: { labels: ["lr:auto", `lr:stage:${stage}`], assignees: [] } },
  rel: { implements: { in: {
    total: rel.total, not: { merged: rel.total - rel.merged }, sum: { openThreads: rel.openThreads }, stage: {},
  }, out: { total: 0, stage: {} } } },
  run: {
    stage, counters: { spec: 1, triage: 1, build: 1, "code-review": 1 }, outputs: { spec: { kind: "spec" } },
    lastOutputValid: null, lastRefused: null, failedStages: [], rounds: {},
    lastEvent: { actor: "agent", at: null },
    lastHuman: { stage: "-", kind: "human", round: 0, at: "2026-01-01T00:00:00.000Z", byAgent: false },
    unblockedAt: 0, goto: null, previousStage: null, ...run,
  },
} as unknown as Snapshot);

const destination = async (s: Snapshot): Promise<string> => {
  const { workflow } = await loadWorkflow(".landrace");
  const d = decide(workflow, s);
  return d.action === "transition" ? d.to?.id ?? "?" : `${d.action}: ${d.why ?? ""}`;
};

describe("the shipped workflow reads every reply with one judge, and sends each answer somewhere", () => {
  it.each(HOMES)("takes a reply at %s to triage, and not once triage's budget is spent", async (home) => {
    const at = (triage: number) => snapshotAt(home, { lastEvent: { actor: "human", at: null }, counters: { spec: 1, build: 1, triage } });
    expect(await destination(at(19))).toBe("triage");
    expect(await destination(at(20))).toMatch(/^wait/);
  });

  it("leaves a reply at pr-human-review to done once the pull request merged, and to fix-review while a thread is open", async () => {
    const replied = { lastEvent: { actor: "human", at: null } };
    expect(await destination(snapshotAt("pr-human-review", replied, { total: 1, merged: 1, openThreads: 0 }))).toBe("done");
    expect(await destination(snapshotAt("pr-human-review", replied, { total: 1, merged: 0, openThreads: 1 }))).toBe("fix-review");
  });

  const judged = (home: string, intent: string, over: object = {}) => snapshotAt("triage", {
    previousStage: home, outputs: { spec: { kind: "spec" }, triage: { intent } },
    rounds: { triage: { entered: 1, output: 1 } }, ...over,
  });

  it.each([
    ["spec-questions", "revise", "spec"],
    ["spec-questions", "approve", "spec-questions"],
    ["spec-questions", "question", "spec-questions"],
    ["spec-questions", "unclear", "spec-questions"],
    ["spec-human-review", "approve", "build"],
    ["spec-human-review", "revise", "spec"],
    ["spec-human-review", "question", "spec-human-review"],
    ["spec-human-review", "unclear", "spec-human-review"],
    ...["pr-human-review", "blocked", "screened"].flatMap((home) =>
      ["approve", "revise", "question", "unclear"].map((intent) => [home, intent, home])),
  ])("from %s, %s goes to %s", async (home, intent, to) => {
    expect(await destination(judged(home, intent))).toBe(to);
  });

  it.each(HOMES)("from %s, a goto answer is taken while its step has rounds left", async (home) => {
    expect(await destination(judged(home, "goto-spec", { goto: "spec" }))).toBe("spec");
    expect(await destination(judged(home, "goto-build", { goto: "build" }))).toBe("build");
  });

  it.each(HOMES)("from %s, a goto past its step's rounds comes home, never left at triage", async (home) => {
    expect(await destination(judged(home, "goto-build", { goto: "build", counters: { spec: 1, triage: 1, build: 3 } }))).toBe(home);
  });

  it.each(["spec-questions", "spec-human-review"])("from %s, a revision past the spec's rounds comes home", async (home) => {
    expect(await destination(judged(home, "revise", { counters: { spec: 3, triage: 1, build: 1 } }))).toBe(home);
  });

  it("lets every stage where it is your turn send the ticket back to spec and build, three rounds each", async () => {
    const { workflow } = await loadWorkflow(".landrace");
    const capped = [
      { stage: "spec", when: { "run.counters.spec": { $lt: 3 } } },
      { stage: "build", when: { "run.counters.build": { $lt: 3 } } },
    ];
    for (const id of ["spec-questions", "spec-human-review", "pr-human-review", "triage"]) {
      expect(workflow.stages.find((s) => s.id === id)?.goto).toEqual(capped);
    }
    expect(workflow.stages.filter((s) => s.goto).map((s) => s.id).sort()).toEqual([...HOMES, "triage"].sort());
  });

  /*
   * Retry is a goto to the stage whose round failed, and any step can fail:
   * a halt listing only spec and build left a broken review with no retry at
   * all. Each target is capped by its own rounds — fix-review by code-review's
   * too, the loop the two share — and offered only where it could run: a
   * review needs a pull request, and the judge a message to read. A goto
   * that landed on a stage whose precondition fails would halt there, and
   * nothing could send the ticket on.
   */
  it("lets a halt send the ticket back to every step, within that step's rounds and only where it can run", async () => {
    const { workflow } = await loadWorkflow(".landrace");
    const every = [
      { stage: "spec", when: { "run.counters.spec": { $lt: 3 } } },
      { stage: "build", when: { "run.counters.build": { $lt: 3 } } },
      { stage: "code-review", when: { "run.counters.code-review": { $lt: 4 }, "rel.implements.in.total": { $gt: 0 } } },
      { stage: "fix-review", when: {
        "run.counters.code-review": { $lt: 4 }, "run.counters.fix-review": { $lt: 4 }, "rel.implements.in.total": { $gt: 0 },
      } },
      { stage: "triage", when: { "run.counters.triage": { $lt: 20 }, "run.lastHuman": { $ne: null } } },
    ];
    for (const id of ["blocked", "screened"]) {
      expect(workflow.stages.find((s) => s.id === id)?.goto).toEqual(every);
    }
    expect(every.map((g) => g.stage).sort()).toEqual(workflow.stages.filter((s) => s.step).map((s) => s.id).sort());
  });

  it.each(["blocked", "screened"])("from %s, a goto to a review or the judge is taken within its rounds, and declined past them", async (halt) => {
    const at = (goto: string, counters: object = {}) =>
      snapshotAt(halt, { goto, counters: { spec: 1, triage: 1, build: 1, "code-review": 1, ...counters } });
    expect(await destination(at("code-review"))).toBe("code-review");
    expect(await destination(at("fix-review"))).toBe("fix-review");
    expect(await destination(at("triage"))).toBe("triage");
    expect(await destination(at("code-review", { "code-review": 4 }))).toMatch(/^wait: .*only while/);
    expect(await destination(at("fix-review", { "code-review": 4 }))).toMatch(/^wait: .*only while/);
    // A failed fix round advances only its own counter, so code-review's
    // alone would let Retry run it for ever.
    expect(await destination(at("fix-review", { "fix-review": 4 }))).toMatch(/^wait: .*only while.*run\.counters\.fix-review/);
    expect(await destination(at("triage", { triage: 20 }))).toMatch(/^wait: .*only while/);
  });

  it.each(["blocked", "screened"])("from %s, declines a review with no pull request and the judge with no message", async (halt) => {
    const noPull = { total: 0, merged: 0, openThreads: 0 };
    expect(await destination(snapshotAt(halt, { goto: "code-review" }, noPull)))
      .toMatch(/^wait: .*"code-review" only while.*rel\.implements\.in\.total/);
    expect(await destination(snapshotAt(halt, { goto: "fix-review" }, noPull)))
      .toMatch(/^wait: .*"fix-review" only while.*rel\.implements\.in\.total/);
    expect(await destination(snapshotAt(halt, { goto: "triage", lastHuman: null })))
      .toMatch(/^wait: .*"triage" only while.*run\.lastHuman/);
  });

  /*
   * Every target but triage. It is sent to only from a halt, and its answers
   * go home to that halt or on to spec or build, each of which sets the
   * labels right.
   */
  it("takes lr:blocked and lr:screened off wherever a ticket can be sent back to", async () => {
    const { workflow } = await loadWorkflow(".landrace");
    const targets = new Set(workflow.stages.flatMap((s) => (s.goto ?? []).map((g) => (typeof g === "string" ? g : g.stage))));
    targets.delete("triage");
    expect([...targets].sort()).toEqual(["build", "code-review", "fix-review", "spec"]);
    for (const id of targets) {
      const removed = (workflow.stages.find((s) => s.id === id)?.on_enter ?? [])
        .flatMap((e) => (e.type === "tracker.label" ? (e.remove as string[]) : []));
      expect(removed).toEqual(expect.arrayContaining(["lr:blocked", "lr:screened"]));
    }
  });

  it("builds only from an approved spec, or when a person sends it back", async () => {
    const { workflow } = await loadWorkflow(".landrace");
    expect(workflow.stages.find((s) => s.id === "build")?.triggers?.map((t) => t.when)).toEqual([{
      "run.stage": "triage", "run.lastOutputValid": null,
      "run.previousStage": "spec-human-review", "run.outputs.triage.intent": "approve",
    }]);
  });
});

/*
 * One judge serves every stage where it is a person's turn, so it is told
 * which one the reply was made at — and, at a halt, which step failed: "try
 * again" means that step, and only the judge's two goto answers can reach it.
 */
describe("the shipped judge is told where the reply was made, and which step failed", () => {
  // The failure that put the ticket at the halt, not every stage still
  // failed: spec failed before a person sent the ticket on to build, and a
  // judge told "spec" would send "try again" there.
  it("renders the halt and the failed step into triage's prompt", async () => {
    const { steps } = await loadWorkflow(".landrace");
    const snapshot = {
      run: {
        previousStage: "blocked", failedStages: ["spec", "build"], failedStage: "build",
        lastHuman: { data: { body: "try again" } },
      },
    } as unknown as Snapshot;
    const rendered = renderPrompt(steps.get("steps/triage.md")?.prompt ?? "", snapshot);

    expect(rendered).toContain("The ticket was waiting at: blocked");
    expect(rendered).toMatch(/The step that failed, if any: build$/m);
    expect(rendered).toContain("try again");
    expect(rendered).not.toMatch(/\{run\./);
  });

  it("says plainly that nothing failed, rather than showing the judge a placeholder", async () => {
    const { steps } = await loadWorkflow(".landrace");
    const snapshot = {
      run: { previousStage: "spec-human-review", failedStages: [], failedStage: null, lastHuman: { data: { body: "ship it" } } },
    } as unknown as Snapshot;
    const rendered = renderPrompt(steps.get("steps/triage.md")?.prompt ?? "", snapshot);

    expect(rendered).toMatch(/The step that failed, if any: none$/m);
    expect(rendered).not.toMatch(/\{run\./);
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
