import { readFile } from "node:fs/promises";
import { outputValueProblem } from "#conventions.js";
import { decide } from "#core/decide.js";
import type { Node, Snapshot } from "#namespace.js";
import { laneOf, statusRows } from "#runner/status.js";
import { renderPrompt } from "#runner/step.js";
import { loadShipped } from "#tests/support/shipped.js";
import { loadWorkspace } from "#workflow/workspace.js";
import { loadConfig } from "#config/load.js";
import { readClaudeSettings } from "landrace/integrations/claude";

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
 * `artifacts.pr.*` or `"item.labels"` path left in a comment or an unused
 * branch would not fail validation but would still mislead the next reader.
 */
describe("the shipped .landrace workflow", () => {
  it("reads no path the graph removed", async () => {
    const text = await readFile(".landrace/workflows/main/workflow.yaml", "utf8");
    expect(text).not.toMatch(/artifacts\.pr\./);
    expect(text).not.toMatch(/"item\.labels"/);
  });
});

describe("the shipped workspace", () => {
  it("holds main, with a title, a description and the label it admits, beside fastlane", async () => {
    const workspace = await loadWorkspace(".landrace");
    expect(workspace.workflows.map((w) => w.id)).toEqual(["fastlane", "main"]);
    const { workflow } = workspace.workflows.find((w) => w.id === "main")!;
    expect(workflow.name).toBe("Main");
    expect(workflow.description.trim()).not.toBe("");
    expect(workflow.admit).toEqual(["lr:auto"]);
  });

  it("builds from a What to build section holding the spec and the person's message", async () => {
    const { steps } = await loadShipped();
    const prompt = steps.get("steps/build.md")?.prompt ?? "";
    const section = prompt.slice(prompt.indexOf("## What to build"), prompt.indexOf("## Procedure"));
    expect(prompt).toContain("## What to build");
    expect(section).toContain("{brief.spec.content}");
    expect(section).toContain("{run.lastHuman.data.body}");
    expect(prompt.split("## What to build")[0]).not.toContain("{brief.spec.content}");
  });
});

/**
 * This project does not split its work: the shipped workflow is one straight
 * flow, spec to build to review to done. Child items are an engine feature a
 * project enables in its own workflow — `tests/fixtures/children` is the
 * example, and where the feature is tested — so none of it may creep back in
 * here by way of a copied stage.
 */
/*
 * Needs you reads the stage an item is at, not `lr:awaiting`, so main's three
 * person's turns say so on the stage — and an item there is filed exactly
 * where it always was. Main still writes `lr:awaiting`; nothing reads it.
 */
describe("the shipped workflow puts an item in Needs you where it is a person's turn", () => {
  const node = (labels: string[]): Node => ({
    id: "7", kind: "item", title: "t", link: "", closed: null, priority: null, origin: null, state: { labels, assignees: [] },
  });

  it("waits on a person at spec-questions, spec-human-review and pr-human-review, and nowhere else", async () => {
    const { workflow } = await loadShipped();
    expect(workflow.stages.filter((s) => s.waits === "person").map((s) => s.id))
      .toEqual(["spec-questions", "spec-human-review", "pr-human-review"]);
  });

  it.each([
    [["lr:auto", "lr:stage:spec-human-review", "lr:awaiting"], "needs-you"],
    [["lr:auto", "lr:stage:spec-questions", "lr:awaiting"], "needs-you"],
    [["lr:auto", "lr:stage:pr-human-review", "lr:awaiting"], "needs-you"],
    // Before the label effect has landed: the stage alone says whose turn it is.
    [["lr:auto", "lr:stage:pr-human-review", "lr:working"], "needs-you"],
    [["lr:auto", "lr:stage:blocked", "lr:blocked"], "needs-you"],
    [["lr:auto", "lr:stage:build", "lr:working"], "waiting"],
    [["lr:auto", "lr:stage:triage", "lr:working"], "waiting"],
    [["lr:auto", "lr:stage:done"], "discharged"],
  ])("files %j under %s", async (labels, lane) => {
    const { workflow } = await loadShipped();
    const [row] = statusRows(workflow, [node(labels)]);
    expect(row && laneOf(row, workflow)).toBe(lane);
  });
});

describe("the shipped workflow is a single flow", () => {
  const fresh = (origin: boolean): Snapshot => ({
    node: { id: "7", kind: "item", title: "t", link: "", closed: null, priority: null,
      origin: origin ? { parent: "3", stage: "breakdown", round: 1 } : null,
      state: { labels: ["lr:auto"], assignees: [] } },
    rel: { implements: { in: { total: 0, stage: {} }, out: { total: 0, stage: {} } } },
    run: {
      stage: null, counters: {}, outputs: {}, lastOutputValid: null, lastRefused: null, failedStages: [], rounds: {},
      lastEvent: { actor: null, at: null }, lastHuman: null, unblockedAt: 0,
    },
  } as unknown as Snapshot);

  it("has one entry stage, spec, and every fresh item enters it", async () => {
    const { workflow } = await loadShipped();
    expect(workflow.stages.filter((s) => s.entry).map((s) => s.id)).toEqual(["spec"]);
    for (const origin of [false, true]) {
      expect(decide(workflow, fresh(origin))).toMatchObject({ action: "transition", to: { id: "spec" }, round: 1 });
    }
  });

  it("declares no breakdown, no child items and nothing that closes them", async () => {
    const { workflow, steps } = await loadShipped();
    const ids = workflow.stages.map((s) => s.id);
    expect(ids).not.toContain("breakdown");
    expect(ids).not.toContain("children-running");
    expect([...steps.values()].flatMap((s) => s.capabilities ?? [])).not.toContain("items:create");
    expect(workflow.stages.flatMap((s) => (s.on_enter ?? []).map((e) => e.type))).not.toContain("nodes.close");
    const text = await readFile(".landrace/workflows/main/workflow.yaml", "utf8");
    expect(text).not.toMatch(/rel\.child-of|node\.origin/);
  });
});

/*
 * A failed round goes to exactly one of the two halts: `blocked` for a
 * broken contract, `screened` for a security refusal. Two matching is an
 * ambiguity halt at the one moment a person most needs the item placed,
 * and none matching leaves it at the failed stage with nothing to say why.
 */
describe("the shipped workflow splits every failure between blocked and screened", () => {
  const failedAt = (stage: string, refused: boolean): Snapshot => ({
    node: { id: "7", kind: "item", title: "t", link: "", closed: null, priority: null, origin: null,
      state: { labels: ["lr:auto", `lr:stage:${stage}`], assignees: [] } },
    rel: { implements: { in: { total: 1, not: { merged: 1 }, sum: { awaitingFix: 0 }, stage: {} }, out: { total: 0, stage: {} } } },
    run: {
      stage, counters: { spec: 1, triage: 1, build: 1, "code-review": 1, "fix-review": 1 },
      // Every earlier round's output still on the item, the way it is at
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
    const { workflow } = await loadShipped();
    const stepped = workflow.stages.filter((s) => s.step).map((s) => s.id);
    expect(stepped.length).toBeGreaterThan(0);
    for (const stage of stepped) {
      expect(decide(workflow, failedAt(stage, refused))).toMatchObject({
        action: "transition", to: { id: refused ? "screened" : "blocked" },
      });
    }
  });

  it("marks a screened item blocked too, and says why beside it", async () => {
    const { workflow } = await loadShipped();
    const screened = workflow.stages.find((s) => s.id === "screened");
    expect(screened?.on_enter).toContainEqual(
      expect.objectContaining({ type: "tracker.label", add: ["lr:blocked", "lr:screened"] }),
    );
  });
});

const HOMES = ["spec-questions", "spec-human-review", "pr-human-review", "blocked", "screened"] as const;

/** `openThreads` defaults to `awaitingFix`: every open thread awaits a fix unless a test says some were answered. */
type Pulls = { total: number; merged: number; awaitingFix: number; openThreads?: number };

const snapshotAt = (stage: string, run: object, rel: Pulls = { total: 1, merged: 0, awaitingFix: 0 }): Snapshot => ({
  node: { id: "7", kind: "item", title: "t", link: "", closed: null, priority: null, origin: null,
    state: { labels: ["lr:auto", `lr:stage:${stage}`], assignees: [] } },
  rel: { implements: { in: {
    total: rel.total, not: { merged: rel.total - rel.merged },
    sum: { openThreads: rel.openThreads ?? rel.awaitingFix, awaitingFix: rel.awaitingFix }, stage: {},
  }, out: { total: 0, stage: {} } } },
  run: {
    stage, counters: { spec: 1, triage: 1, build: 1, "code-review": 1 }, outputs: { spec: { kind: "spec" } },
    lastOutputValid: null, lastRefused: null, failedStages: [], rounds: {},
    lastEvent: { actor: "agent", at: null },
    lastHuman: { stage: "-", kind: "human", round: 0, at: "2026-01-01T00:00:00.000Z", byAgent: false },
    unblockedAt: 0, goto: null, previousStage: null, pairing: null, lastOutputBy: "agent", ...run,
  },
} as unknown as Snapshot);

const destination = async (s: Snapshot): Promise<string> => {
  const { workflow } = await loadShipped();
  const d = decide(workflow, s);
  return d.action === "transition" ? d.to?.id ?? "?" : `${d.action}: ${d.why ?? ""}`;
};

describe("the shipped workflow reads every reply with one judge, and sends each answer somewhere", () => {
  // No round cap: each round waits for a person to write, which is bound
  // enough, and a cap only ended a real back-and-forth.
  it.each(HOMES)("takes a reply at %s to triage, however many came before it", async (home) => {
    const at = (triage: number) => snapshotAt(home, { lastEvent: { actor: "human", at: null }, counters: { spec: 1, build: 1, triage } });
    expect(await destination(at(1))).toBe("triage");
    expect(await destination(at(200))).toBe("triage");
  });

  it("leaves a reply at pr-human-review to done once the pull request merged, and to fix-review while a thread is open", async () => {
    const replied = { lastEvent: { actor: "human", at: null } };
    expect(await destination(snapshotAt("pr-human-review", replied, { total: 1, merged: 1, awaitingFix: 0 }))).toBe("done");
    expect(await destination(snapshotAt("pr-human-review", replied, { total: 1, merged: 0, awaitingFix: 1 }))).toBe("fix-review");
  });

  it("takes a reply at pr-human-review to triage while every open thread is answered and waiting on the person", async () => {
    const replied = { lastEvent: { actor: "human", at: null } };
    expect(await destination(snapshotAt("pr-human-review", replied, { total: 1, merged: 0, awaitingFix: 0, openThreads: 2 }))).toBe("triage");
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
    ["spec-questions", "rework", "spec-questions"],
    ["spec-human-review", "approve", "build"],
    ["spec-human-review", "revise", "spec"],
    ["spec-human-review", "question", "spec-human-review"],
    ["spec-human-review", "unclear", "spec-human-review"],
    ["spec-human-review", "rework", "spec-human-review"],
    // #27: a change asked for on the pull request amends the spec first, so
    // build, code-review and fix-review all read it from the one authority.
    ["pr-human-review", "revise", "spec"],
    // #34: "resolve conflicts first" changes no requirement, and a spec round
    // spent on it amends nothing. The fixer works on the open pull request.
    ["pr-human-review", "rework", "fix-review"],
    ...["approve", "question", "unclear"].map((intent) => ["pr-human-review", intent, "pr-human-review"]),
    ...["blocked", "screened"].flatMap((home) =>
      ["approve", "revise", "rework", "question", "unclear"].map((intent) => [home, intent, home])),
  ])("from %s, %s goes to %s", async (home, intent, to) => {
    expect(await destination(judged(home, intent))).toBe(to);
  });

  it("amends the spec for a change asked for at pr-human-review, however many spec rounds already ran", async () => {
    const later = { counters: { spec: 5, triage: 5, build: 7, "code-review": 3 } };
    expect(await destination(judged("pr-human-review", "revise", later))).toBe("spec");
  });

  it("sends work asked for at pr-human-review to the fixer, however many rounds already ran", async () => {
    const later = { counters: { spec: 3, triage: 5, build: 3, "code-review": 5, "fix-review": 12 } };
    expect(await destination(judged("pr-human-review", "rework", later))).toBe("fix-review");
  });

  // An amended spec needs no second approval — the person asked for exactly
  // this change — but a spec redone from scratch, or one before any pull
  // request, is reviewed as ever.
  it("builds an amended spec, and asks for review of a redone one or one before any pull request", async () => {
    const published = (pulls: number, intent: string) => snapshotAt("spec", {
      outputs: { spec: { kind: "spec" }, triage: { intent } }, rounds: { spec: { entered: 2, output: 2 } },
      counters: { spec: 2, triage: 2, build: 1, "code-review": 1 },
    }, { total: pulls, merged: 0, awaitingFix: 0 });
    expect(await destination(published(1, "revise"))).toBe("build");
    expect(await destination(published(1, "goto-spec"))).toBe("spec-human-review");
    expect(await destination(published(0, "revise"))).toBe("spec-human-review");
  });

  // A person who wrote the spec with the agent has reviewed it as they
  // wrote it: it goes straight to build, whenever it was written, and never
  // waits at spec-human-review for the approval it already has.
  it.each([
    [0, "approve"], [0, "revise"], [1, "revise"], [1, "goto-spec"],
  ])("builds a spec written together, with %i pull requests and the last reply read as %s", async (pulls, intent) => {
    const together = snapshotAt("spec", {
      outputs: { spec: { kind: "spec" }, triage: { intent } }, rounds: { spec: { entered: 2, output: 2 } },
      counters: { spec: 2, triage: 2, build: 0 }, lastOutputBy: "pair",
    }, { total: pulls, merged: 0, awaitingFix: 0 });
    expect(await destination(together)).toBe("build");
  });

  it("asks nothing of a spec written together that came back with questions", async () => {
    const asked = snapshotAt("spec", {
      outputs: { spec: { kind: "questions" } }, rounds: { spec: { entered: 1, output: 1 } }, lastOutputBy: "pair",
    }, { total: 0, merged: 0, awaitingFix: 0 });
    expect(await destination(asked)).toBe("spec-questions");
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

  it("lets every stage where it is your turn, and build itself, send the item back to spec and build, three rounds each", async () => {
    const { workflow } = await loadShipped();
    const capped = [
      { stage: "spec", when: { "run.counters.spec": { $lt: 3 } } },
      { stage: "build", when: { "run.counters.build": { $lt: 3 } } },
    ];
    for (const id of ["spec-questions", "spec-human-review", "pr-human-review", "triage"]) {
      expect(workflow.stages.find((s) => s.id === id)?.goto).toEqual(capped);
    }
    expect(workflow.stages.filter((s) => s.goto).map((s) => s.id).sort()).toEqual([...HOMES, "triage", "build"].sort());
  });

  /*
   * Retry is a goto to the step whose failure put the item there, and any step can fail:
   * a halt listing only spec and build left a broken review with no retry at
   * all. Each target is capped by its own rounds — fix-review by its own
   * twenty alone, so a person's thread is never stranded behind the review's
   * five — and offered only where it could run: a
   * review needs a pull request, and the judge a message to read. A goto
   * that landed on a stage whose precondition fails would halt there, and
   * nothing could send the item on.
   */
  it("lets a halt send the item back to every step, within that step's rounds and only where it can run", async () => {
    const { workflow } = await loadShipped();
    const every = [
      { stage: "spec", when: { "run.counters.spec": { $lt: 3 } } },
      { stage: "build", when: { "run.counters.build": { $lt: 3 } } },
      { stage: "code-review", when: { "run.counters.code-review": { $lt: 8 }, "rel.implements.in.total": { $gt: 0 } } },
      { stage: "fix-review", when: { "run.counters.fix-review": { $lt: 20 }, "rel.implements.in.total": { $gt: 0 } } },
      { stage: "retro", when: {
        "run.counters.retro": { $lt: 3 }, "rel.implements.in.total": { $gt: 0 }, "rel.implements.in.not.merged": { $gt: 0 },
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
    // #33: past the loop's own five reviews, and the one a later build
    // round adds, two Retries are left — #29 was refused one after its fifth.
    expect(await destination(at("code-review", { "code-review": 5 }))).toBe("code-review");
    expect(await destination(at("code-review", { "code-review": 7 }))).toBe("code-review");
    expect(await destination(at("code-review", { "code-review": 8 }))).toMatch(/^wait: .*only while.*run\.counters\.code-review/);
    // Past the review's five, a fix is still offered: a person's thread
    // needs one, and it is bounded by its own twenty.
    expect(await destination(at("fix-review", { "code-review": 9 }))).toBe("fix-review");
    expect(await destination(at("fix-review", { "fix-review": 20 }))).toMatch(/^wait: .*only while.*run\.counters\.fix-review/);
    expect(await destination(at("triage", { triage: 20 }))).toMatch(/^wait: .*only while/);
  });

  it.each(["blocked", "screened"])("from %s, declines a review with no pull request and the judge with no message", async (halt) => {
    const noPull = { total: 0, merged: 0, awaitingFix: 0 };
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
  it("takes lr:blocked and lr:screened off wherever an item can be sent back to", async () => {
    const { workflow } = await loadShipped();
    const targets = new Set(workflow.stages.flatMap((s) => (s.goto ?? []).map((g) => (typeof g === "string" ? g : g.stage))));
    targets.delete("triage");
    expect([...targets].sort()).toEqual(["build", "code-review", "fix-review", "retro", "spec"]);
    for (const id of targets) {
      const removed = (workflow.stages.find((s) => s.id === id)?.on_enter ?? [])
        .flatMap((e) => (e.type === "tracker.label" ? (e.remove as string[]) : []));
      expect(removed).toEqual(expect.arrayContaining(["lr:blocked", "lr:screened"]));
    }
  });

  it("builds only from an approved spec, a spec amended on the pull request, one written together, or when a person sends it back", async () => {
    const { workflow } = await loadShipped();
    expect(workflow.stages.find((s) => s.id === "build")?.triggers?.map((t) => t.when)).toEqual([{
      "run.stage": "triage", "run.lastOutputValid": null,
      "run.previousStage": "spec-human-review", "run.outputs.triage.intent": "approve",
    }, {
      "run.stage": "spec", "run.lastOutputValid": null, "run.outputs.spec.kind": "spec", "run.lastOutputBy": "agent",
      "rel.implements.in.total": { $gt: 0 }, "run.outputs.triage.intent": "revise",
    }, {
      "run.stage": "spec", "run.lastOutputValid": null, "run.outputs.spec.kind": "spec", "run.lastOutputBy": "pair",
    }]);
  });
});

/*
 * One judge serves every stage where it is a person's turn, so it is told
 * which one the reply was made at — and, at a halt, which step failed: "try
 * again" means that step, and only the judge's two goto answers can reach it.
 */
describe("the shipped judge is told where the reply was made, and which step failed", () => {
  // The failure that put the item at the halt, not every stage still
  // failed: spec failed before a person sent the item on to build, and a
  // judge told "spec" would send "try again" there.
  it("renders the halt and the failed step into triage's prompt", async () => {
    const { steps } = await loadShipped();
    const snapshot = {
      run: {
        previousStage: "blocked", failedStages: ["spec", "build"], failedStage: "build",
        lastHuman: { data: { body: "try again" } },
      },
    } as unknown as Snapshot;
    const rendered = renderPrompt(steps.get("steps/triage.md")?.prompt ?? "", snapshot);

    expect(rendered).toContain("The item was waiting at: blocked");
    expect(rendered).toMatch(/The step that failed, if any: build$/m);
    expect(rendered).toContain("try again");
    expect(rendered).not.toMatch(/\{run\./);
  });

  /*
   * `landrace_resolve` posts a fixed "Carry on — this is answered." as the
   * person's turn. On main that went straight back to spec; now the judge
   * reads it, and at spec-questions anything but `revise` sends it home to
   * spec-questions — where resolving again loops. The answers are in the
   * conversation above it, so the judge has to be told that is `revise`.
   */
  it("tells the judge at spec-questions that 'answered, carry on' is revise", async () => {
    const { steps } = await loadShipped();
    const snapshot = {
      run: { previousStage: "spec-questions", failedStage: null, lastHuman: { data: { body: "Carry on — this is answered." } } },
    } as unknown as Snapshot;
    const rendered = renderPrompt(steps.get("steps/triage.md")?.prompt ?? "", snapshot);

    expect(rendered).toContain("The item was waiting at: spec-questions");
    const place = rendered.split("\n").find((line) => line.startsWith("- `spec-questions`")) ?? "";
    expect(place).toMatch(/answered/);
    expect(place).toMatch(/carry on/i);
    expect(place).toMatch(/conversation above/);
  });

  it("says plainly that nothing failed, rather than showing the judge a placeholder", async () => {
    const { steps } = await loadShipped();
    const snapshot = {
      run: { previousStage: "spec-human-review", failedStages: [], failedStage: null, lastHuman: { data: { body: "ship it" } } },
    } as unknown as Snapshot;
    const rendered = renderPrompt(steps.get("steps/triage.md")?.prompt ?? "", snapshot);

    expect(rendered).toMatch(/The step that failed, if any: none$/m);
    expect(rendered).not.toMatch(/\{run\./);
  });
});

/*
 * Item #19: the build prompt said "the approved spec is at <url>", the
 * screener refused it as an instruction to fetch something off the network —
 * which it was — and the URL was a blob in a private repository the agent
 * could not have opened anyway. Every step that works from the spec is handed
 * its text, and a link, where one is kept, is only a reference for a person.
 */
describe("the shipped steps are handed the approved spec as text", () => {
  const WORKING_FROM_THE_SPEC = ["build", "code-review", "fix-review"];
  const snapshot = { node: { id: "7", title: "Add export" }, artifacts: { spec: { url: "https://example.test/specs/7" } } } as unknown as Snapshot;

  it.each(WORKING_FROM_THE_SPEC)("%s embeds the spec and sends nobody off to fetch it", async (id) => {
    const { steps } = await loadShipped();
    const prompt = steps.get(`steps/${id}.md`)?.prompt ?? "";

    expect(prompt).toContain("{brief.spec.content}");
    // The paragraph that keeps the link tells nobody to go to it: not the
    // sentence #19's screener refused, and no imperative that would be it again.
    const paragraph = prompt.split(/\n\s*\n/).find((p) => p.includes("{artifacts.spec.url}")) ?? "";
    expect(paragraph).not.toMatch(/is at \{artifacts\.spec\.url\}/i);
    expect(paragraph).not.toMatch(/(^|[.:;]\s+)(open|fetch|read|visit|follow|download|go to|see|check|consult|refer to|use)\b/im);
  });

  it.each(WORKING_FROM_THE_SPEC)("%s renders the spec's text, delimited, with no placeholder left", async (id) => {
    const { steps } = await loadShipped();
    const rendered = renderPrompt(steps.get(`steps/${id}.md`)?.prompt ?? "", snapshot, {
      spec: { content: "# Export CSV\n\nOne file, comma separated." },
      project: { threads: "1. src/x.ts:12 — this leaks a file handle", diff: "## PR #5 — 1 files changed" },
    });

    expect(rendered).toContain("One file, comma separated.");
    expect(rendered).not.toMatch(/\{brief\./);
    // Fenced off as the approved spec, so the agent can tell where it ends.
    expect(rendered).toMatch(/approved spec[\s\S]*One file, comma separated\.[\s\S]*end of the approved spec/i);
  });

  it("says so plainly when no spec was published, rather than leaving a hole in the prompt", async () => {
    const { steps } = await loadShipped();
    const rendered = renderPrompt(steps.get("steps/build.md")?.prompt ?? "", snapshot, {
      spec: { content: "No spec has been published for this item." },
    });
    expect(rendered).toContain("No spec has been published for this item.");
    expect(rendered).not.toMatch(/\{brief\./);
  });
});

/*
 * Item #19: the build agent was told it could not push and could run no
 * command, so it edited files, committed nothing and reported done; publish
 * failed "nothing was committed", and the worktree went with the edits. A
 * write step now does its own git work, inside the sandbox, and a person can
 * send a build whose push failed back to build.
 */
/*
 * Every stepped prompt walks the agent through the same numbered procedure:
 * a Progress checklist, then one **Step N** section per item, in order, each
 * ending in what "done" means. Where the step's summary becomes an item
 * comment, it opens with that checklist ticked, so a person can see which
 * steps ran. Spec's text is the spec itself and triage answers json alone, so
 * neither echoes it.
 */
describe("the shipped prompts follow a numbered procedure", () => {
  const ECHO = "Start your final summary with the Progress checklist";
  it.each([
    ["spec", false], ["triage", false], ["build", true], ["code-review", true], ["fix-review", true], ["retro", true],
  ] as const)("%s has a Procedure whose checklist items each have their own Step section, in order", async (id, echoes) => {
    const { steps } = await loadShipped();
    const prompt = steps.get(`steps/${id}.md`)?.prompt ?? "";
    const procedure = prompt.indexOf("## Procedure");
    expect(procedure).toBeGreaterThanOrEqual(0);
    const items = [...prompt.matchAll(/^- \[ \] Step (\d+): \S/gm)].map((m) => Number(m[1]));
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items).toEqual(items.map((_, i) => i + 1));
    const sections = items.map((n) => prompt.indexOf(`**Step ${n} — `));
    expect(sections.every((at) => at > procedure)).toBe(true);
    expect([...sections].sort((a, b) => a - b)).toEqual(sections);
    expect(prompt.includes(ECHO)).toBe(echoes);
  });
});

/*
 * code-review ran on #19, #20 and #21 and never raised a thread: it had no
 * tool to post one and no shell to see the diff, so every review ended with
 * "no threads are open" and fix-review never ran. It now reads the diff from
 * its briefing and answers with a list; pull.review puts that list on the
 * pull request, where the open-thread count routes the item.
 */
// The 71 "listen EPERM" failures every sandboxed build reported, and the two
// validate problems no worktree can avoid: expected, and said so, so an agent
// neither chases them nor waves a real failure through beside them.
it.each(["build", "fix-review", "retro"])("%s says which sandbox skips and validate problems are expected", async (id) => {
  const { steps } = await loadShipped();
  const prose = (steps.get(`steps/${id}.md`)?.prompt ?? "").replace(/\s+/g, " ");
  expect(prose).toMatch(/tests that start a local server are skipped/);
  expect(prose).toMatch(/`githubToken` secret and `\.mcp\.json` missing/);
  expect(prose).toMatch(/Anything else that fails is real/);
});

// Every step that does real work thinks hard; the spec hardest, since every
// later step answers to it. Triage is a quick classifier on haiku and
// declares no capability, so it is handed no effort at all.
it("runs the spec at max effort, every other step but triage at extra-high", async () => {
  const { steps } = await loadShipped();
  expect(steps.get("steps/spec.md")?.effort).toBe("max");
  for (const id of ["build", "code-review", "fix-review", "retro"]) {
    expect([id, steps.get(`steps/${id}.md`)?.effort]).toEqual([id, "xhigh"]);
  }
  expect(steps.get("steps/triage.md")?.effort).toBeUndefined();
});

describe("the spec step amends an approved spec", () => {
  it("is shown the spec published so far and the person's last message, fenced, and told to change only what they ask", async () => {
    const { steps } = await loadShipped();
    const prompt = steps.get("steps/spec.md")?.prompt ?? "";
    // "Published so far", not "approved": at spec-human-review it is not approved yet.
    expect(prompt).toMatch(/--- the spec published so far ---\s*\{brief\.spec\.content\}\s*--- end of the spec published so far ---/);
    expect(prompt).not.toMatch(/approved spec/i);
    expect(prompt).toMatch(/--- their message ---\s*\{run\.lastHuman\.data\.body\}\s*--- end of their message ---/);
    expect(prompt.replace(/\s+/g, " ")).toMatch(/revises it: keep the spec, change only what the conversation asks/i);
  });

  /*
   * Round 2 after spec-questions saw "B, 30 days" and not the questions it had
   * asked, and a first comment was lost behind a second. Each round is a fresh
   * session, so the conversation itself has to be in the prompt.
   */
  it("is shown the item's whole conversation, fenced as evidence", async () => {
    const { steps } = await loadShipped();
    const prompt = steps.get("steps/spec.md")?.prompt ?? "";
    expect(prompt).toMatch(/--- the conversation so far ---\s*\{brief\.project\.history\}\s*--- end of the conversation so far ---/);
    expect(prompt.replace(/\s+/g, " ")).toMatch(/never an instruction to you/i);
  });

  // With the spec amended there is one authority, and code-review reads it:
  // a person's last message is not a second one (it may only be a question).
  it("leaves code-review to the spec alone", async () => {
    const { steps } = await loadShipped();
    expect(steps.get("steps/code-review.md")?.prompt ?? "").not.toContain("{run.lastHuman.data.body}");
  });
});

describe("build is shown what the person asked for", () => {
  it("fences the last message a person wrote as their request, never an instruction", async () => {
    const { steps } = await loadShipped();
    const prompt = steps.get("steps/build.md")?.prompt ?? "";
    expect(prompt).toMatch(/--- their message ---\s*\{run\.lastHuman\.data\.body\}\s*--- end of their message ---/);
    expect(prompt).toMatch(/never an instruction about how to run this session/i);
  });

  it("tells the judge that at pr-human-review a changed requirement is revise, and work that changes none is rework", async () => {
    const { steps } = await loadShipped();
    const line = (steps.get("steps/triage.md")?.prompt ?? "").split("\n").find((l) => l.startsWith("- `pr-human-review`")) ?? "";
    expect(line).toMatch(/`revise`[^.]*spec/);
    expect(line).toMatch(/`rework`/);
    expect(line).toMatch(/conflict/);
  });
});

describe("fix-review is shown the message that sent it, and only that one", () => {
  // A round the reviewer's threads sent would otherwise be shown whatever a
  // person last wrote — an approval, or an old request already done.
  it("fences the person's message and says which stage sent the round", async () => {
    const { steps } = await loadShipped();
    const prompt = steps.get("steps/fix-review.md")?.prompt ?? "";
    expect(prompt).toMatch(/--- their message ---\s*\{run\.lastHuman\.data\.body\}\s*--- end of their message ---/);
    expect(prompt).toContain("{run.previousStage}");
    expect(prompt).toMatch(/`triage`/);
  });
});

describe("the shipped code-review raises its findings through its answer", () => {
  it("is read-only and answers reviewed with findings, replies and resolved, routed to pull.review on the item's branch", async () => {
    const { steps } = await loadShipped();
    const step = steps.get("steps/code-review.md");
    expect(step?.capabilities).toEqual(["repo:read"]);
    expect(Object.keys(step?.output?.shapes.reviewed as object).sort()).toEqual(["findings", "replies", "resolved"]);
    expect(step?.output?.routes.map((r) => r.effect)).toEqual([
      { type: "pull.review", branch: "landrace/{item}", marker: "review:{round}" },
    ]);
  });

  it("is shown the diff and the open threads, and never told to run anything or post a thread itself", async () => {
    const { steps } = await loadShipped();
    const prompt = steps.get("steps/code-review.md")?.prompt ?? "";
    expect(prompt).toContain("{brief.project.diff}");
    expect(prompt).toContain("{brief.project.threads}");
    expect(prompt).toMatch(/no shell/i);
    // The instructions #19–#21's reviewers could not follow.
    expect(prompt).not.toMatch(/verify a claim by running|raise one thread per finding, on the line/i);
    expect(prompt).toMatch(/never list a thread a person raised/i);
    // Its own threads, re-checked: resolved when fixed, answered when not.
    expect(prompt).toMatch(/still wrong/i);
  });
});

/*
 * #19–#21's specs ran 770–1,300 words, most of it a step-by-step plan and a
 * test list, written because the spec step was told to use writing-plans. A
 * person approves the product flow and the shape of the change; build plans
 * the steps itself.
 */
describe("the shipped spec is short, and build does the planning", () => {
  it("asks for problem, decisions, a file-level design and checks, in caveman style, with no step list", async () => {
    const { steps } = await loadShipped();
    const prompt = steps.get("steps/spec.md")?.prompt ?? "";
    const at = ["## Problem", "## Decisions", "## Technical design", "## Done when"].map((s) => prompt.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(prompt).toMatch(/caveman/i);
    expect(prompt).toMatch(/400 words/);
    expect(prompt).toMatch(/no step list/i);
    expect(prompt).not.toContain("superpowers:writing-plans");
  });

  it("has build plan the work from the spec before it executes the plan", async () => {
    const { steps } = await loadShipped();
    const prompt = steps.get("steps/build.md")?.prompt ?? "";
    expect(prompt).toMatch(/`superpowers:writing-plans`[\s\S]*`superpowers:executing-plans`/);
  });
});

describe("the shipped write steps merge, test, commit and push their own branch", () => {
  it.each(["build", "fix-review"])("%s tells the agent to merge origin/main, test, commit and push only its branch", async (id) => {
    const { steps } = await loadShipped();
    const step = steps.get(`steps/${id}.md`);
    expect(step?.capabilities).toEqual(["repo:read", "repo:write"]);
    const prompt = step?.prompt ?? "";
    expect(prompt).toContain("`git fetch origin`");
    expect(prompt).toContain("`git merge origin/main`");
    expect(prompt).toContain("`pnpm install`");
    expect(prompt).toMatch(/commit as you go/i);
    expect(prompt).toContain("`git push origin HEAD`");
    expect(prompt).toMatch(/never push any other branch, never force-push, and never touch `main`/i);
    // The sentence #19's build obeyed: it was told it had no way to push.
    expect(prompt).not.toMatch(/cannot push|orchestrator pushes/i);
    // A rejected push (a person's commit, or the forge's "Update branch")
    // still has to end in a push, never a force-push.
    expect(prompt).toMatch(/push is rejected/i);
    expect(prompt).toContain("git branch --show-current");
    expect(prompt).toMatch(/git merge origin\//);
    // Commits and fetches also write the repo's shared git directory
    // (README, "A write step's sandbox"), not only the worktree.
    expect(prompt).toContain("only inside this worktree and the repository's git directory");
  });

  /*
   * #31: a pushback in the round's summary was lost, and a person's thread
   * the fixer answered still read as open. The fixer answers each thread in
   * its json instead, and pull.review posts each answer where it was raised.
   */
  it("fix-review answers each thread through its json, routed to pull.review, and resolves none", async () => {
    const { steps } = await loadShipped();
    const step = steps.get("steps/fix-review.md");
    expect(Object.keys(step?.output?.shapes.addressed as object)).toEqual(["replies"]);
    expect(step?.output?.routes.map((r) => r.effect)).toEqual([
      { type: "pull.review", branch: "landrace/{item}", marker: "fix:{round}" },
    ]);
    const prompt = step?.prompt ?? "";
    expect(prompt).toContain("Fixed in `");
    expect(prompt).toContain("Not changed, because");
    expect(prompt).not.toMatch(/cannot reply on the thread|your final summary is where a pushback goes/i);
    expect(prompt).toMatch(/do not resolve any thread/i);
  });

  /*
   * The replies ride in the round's output record, which a marker bounds. A
   * round answering every thread the briefing lists — twenty — at the length
   * the prompt allows has to fit, or the round fails after its commits are
   * pushed and no reply is posted at all.
   */
  it("fix-review bounds each reply so a round answering twenty threads fits its record", async () => {
    const { steps } = await loadShipped();
    const prompt = steps.get("steps/fix-review.md")?.prompt ?? "";
    const limit = Number(/at most (\d+) characters/.exec(prompt)?.[1]);
    expect(limit).toBeGreaterThan(0);
    const reply = { thread: "PRRT_kwDOLandraceAbCdEfGh1234", body: `Fixed in \`abc1234\`: <T> ${"x".repeat(limit)}`.slice(0, limit) };
    expect(outputValueProblem({ kind: "addressed", replies: Array.from({ length: 20 }, () => reply) })).toBeNull();
  });

  it("sandboxes this repository's write steps to GitHub and the npm registry, away from its credentials", async () => {
    const { config } = await loadConfig(".landrace");
    expect(readClaudeSettings(config.agent).sandbox).toEqual({
      hosts: ["github.com", "registry.npmjs.org"],
      deny: ["~/.config/gh", "~/.ssh", "~/.aws", "~/.npmrc"],
    });
  });

  /*
   * publish pushes before it moves the position, so a push that fails leaves
   * the item labelled build, its round settled and publish's trigger firing
   * every tick. The goto has to be build's own: a stage sends an item only
   * where it lists, and the item is never at publish.
   */
  const builtAndUnpushed = (rounds: number) => snapshotAt("build", {
    goto: "build",
    counters: { spec: 1, triage: 1, build: rounds },
    outputs: { spec: { kind: "spec" }, triage: { intent: "approve" }, build: { kind: "done" } },
    rounds: { build: { entered: rounds, output: rounds } },
  }, { total: 0, merged: 0, awaitingFix: 0 });

  it("lets a person send a settled build back to build, within build's three rounds", async () => {
    const { workflow } = await loadShipped();
    expect(workflow.stages.find((s) => s.id === "build")?.goto).toEqual([
      { stage: "build", when: { "run.counters.build": { $lt: 3 } } },
    ]);
    expect(await destination(builtAndUnpushed(2))).toBe("build");
  });

  it("declines it past build's rounds, and publish's own trigger stands", async () => {
    expect(await destination(builtAndUnpushed(3))).toBe("publish");
  });
});

/*
 * #31: a thread is a conversation, and the loop routes on each one's last
 * word. A thread the fixer answered waits on the person and never loops; a
 * person's reply, or the reviewer's "still wrong", sends it back to be fixed.
 * code-review runs five rounds; fix-review twenty, and only its own twenty
 * bounds the way back to review, so a person's thread is never stranded.
 */
describe("the shipped review loop routes on whether a thread awaits a fix", () => {
  const reviewed = (reviews: number, pulls: Pulls) => snapshotAt("code-review", {
    counters: { spec: 1, triage: 1, build: 1, "code-review": reviews, "fix-review": reviews - 1 },
    outputs: { spec: { kind: "spec" }, build: { kind: "done" }, "code-review": { kind: "reviewed" } },
    rounds: { "code-review": { entered: reviews, output: reviews } },
  }, pulls);
  const fixed = (fixes: number, reviews: number) => snapshotAt("fix-review", {
    counters: { spec: 1, triage: 1, build: 1, "code-review": reviews, "fix-review": fixes },
    outputs: { spec: { kind: "spec" }, build: { kind: "done" }, "fix-review": { kind: "addressed" } },
    rounds: { "fix-review": { entered: fixes, output: fixes } },
  }, { total: 1, merged: 0, awaitingFix: 0, openThreads: 1 });

  it("sends a review with threads awaiting a fix to fix-review within five reviews, and to blocked on the fifth", async () => {
    const waiting = { total: 1, merged: 0, awaitingFix: 1 };
    expect(await destination(reviewed(4, waiting))).toBe("fix-review");
    expect(await destination(reviewed(5, waiting))).toBe("blocked");
  });

  it("never loops on a thread the fixer answered: open, but waiting on the person", async () => {
    expect(await destination(reviewed(2, { total: 1, merged: 0, awaitingFix: 0, openThreads: 3 }))).toBe("retro");
    expect(await destination(reviewed(1, { total: 1, merged: 0, awaitingFix: 0, openThreads: 3 }))).toBe("pr-human-review");
  });

  it("sends a thread the person commented on at pr-human-review to fix-review, however many reviews ran", async () => {
    const at = (reviews: number) => snapshotAt("pr-human-review", {
      counters: { spec: 1, triage: 1, build: 1, "code-review": reviews, "fix-review": 3 },
    }, { total: 1, merged: 0, awaitingFix: 1, openThreads: 2 });
    expect(await destination(at(1))).toBe("fix-review");
    expect(await destination(at(9))).toBe("fix-review");
  });

  // #33: "Go to step… fix-review" from the spent review budget fixes, and
  // the fix is reviewed.
  it("lets a person send the spent review budget to fix-review, and reviews that fix", async () => {
    const exhausted = snapshotAt("blocked", {
      goto: "fix-review", counters: { spec: 1, triage: 1, build: 1, "code-review": 5, "fix-review": 4 },
    }, { total: 1, merged: 0, awaitingFix: 1 });
    expect(await destination(exhausted)).toBe("fix-review");
    expect(await destination(fixed(5, 5))).toBe("code-review");
  });

  it("reviews every fix within fix-review's twenty, past the review's five, and blocks on the twentieth", async () => {
    expect(await destination(fixed(19, 7))).toBe("code-review");
    expect(await destination(fixed(20, 7))).toBe("blocked");
  });
});

/*
 * #20: a correction fixed only the item it was made on. Once the review
 * settles, an item that was corrected anywhere — a spec revised, a build
 * redone, a finding fixed — stops at `retro` on its way to the person, and
 * one that was not goes straight there.
 */
describe("the shipped workflow learns from a corrected item before a person reviews it", () => {
  const settled = (counters: Record<string, number>, merged = 0) => snapshotAt("code-review", {
    counters: { spec: 1, triage: 1, build: 1, "code-review": 1, ...counters },
    outputs: { spec: { kind: "spec" }, build: { kind: "done" }, "code-review": { kind: "reviewed" } },
    rounds: { "code-review": { entered: 1, output: 1 } },
  }, { total: 1, merged, awaitingFix: 0 });

  /*
   * A person who merged while the review ran has shipped it. Lessons
   * committed after that land on a branch nothing will merge again, and the
   * retro that wrote them is paid for nothing.
   */
  it("skips the retro once the pull request has merged", async () => {
    expect(await destination(settled({ "fix-review": 1 }, 1))).toBe("pr-human-review");
  });

  it("goes straight to pr-human-review when nothing was corrected", async () => {
    expect(await destination(settled({ spec: 1, build: 1, "fix-review": 0 }))).toBe("pr-human-review");
    expect(await destination(settled({ spec: 1, build: 1 }))).toBe("pr-human-review");
  });

  it.each([
    [{ spec: 2 }],
    [{ build: 2 }],
    [{ "fix-review": 1 }],
  ])("goes to retro after a correction (%j)", async (correction) => {
    expect(await destination(settled(correction))).toBe("retro");
  });

  it("goes to pr-human-review once the retro's three rounds are spent", async () => {
    expect(await destination(settled({ "fix-review": 1, retro: 3 }))).toBe("pr-human-review");
  });

  /* Two triggers matching is an ambiguity halt, and none is an item parked in review. */
  it("sends every settled review to exactly one of the two", async () => {
    const { workflow } = await loadShipped();
    const destination = (s: Snapshot): string => {
      const d = decide(workflow, s);
      return d.action === "transition" ? d.to?.id ?? "?" : `${d.action}: ${d.why ?? ""}`;
    };
    for (const spec of [1, 2, 3]) {
      for (const build of [1, 2, 3]) {
        for (const fix of [undefined, 0, 1, 3]) {
          for (const retro of [undefined, 0, 1, 2, 3]) {
            for (const merged of [0, 1]) {
              const counters = { spec, build, ...(fix === undefined ? {} : { "fix-review": fix }), ...(retro === undefined ? {} : { retro }) };
              const corrected = spec > 1 || build > 1 || (fix ?? 0) > 0;
              const want = corrected && (retro ?? 0) < 3 && merged === 0 ? "retro" : "pr-human-review";
              expect([counters, merged, destination(settled(counters, merged))]).toEqual([counters, merged, want]);
            }
          }
        }
      }
    }
  });

  it.each(["learned", "nothing"])("goes on to pr-human-review once the retro answers %s", async (kind) => {
    expect(await destination(snapshotAt("retro", {
      counters: { spec: 1, triage: 1, build: 1, "code-review": 2, "fix-review": 1, retro: 1 },
      outputs: { spec: { kind: "spec" }, "code-review": { kind: "reviewed" }, retro: { kind } },
      rounds: { retro: { entered: 1, output: 1 } },
    }))).toBe("pr-human-review");
  });

  it("pushes the branch as it enters pr-human-review, before anything else", async () => {
    const { workflow } = await loadShipped();
    expect(workflow.stages.find((s) => s.id === "pr-human-review")?.on_enter?.[0])
      .toEqual({ type: "branch.push", branch: "landrace/{item}" });
  });

  it.each(["blocked", "screened"])("from %s, Retry offers retro only while it has rounds left", async (halt) => {
    const at = (retro: number) =>
      snapshotAt(halt, { goto: "retro", counters: { spec: 1, triage: 1, build: 1, "code-review": 1, "fix-review": 1, retro } });
    expect(await destination(at(2))).toBe("retro");
    expect(await destination(at(3))).toMatch(/^wait: .*"retro" only while.*run\.counters\.retro/);
    const merged = snapshotAt(halt, { goto: "retro", counters: { spec: 1, triage: 1, build: 1, "code-review": 1, "fix-review": 1 } },
      { total: 1, merged: 1, awaitingFix: 0 });
    expect(await destination(merged)).toMatch(/^wait: .*"retro" only while.*rel\.implements\.in\.not\.merged/);
  });

  describe("the retro's prompt", () => {
    const retro = async () => {
      const { steps } = await loadShipped();
      const step = steps.get("steps/retro.md");
      if (!step) throw new Error("the shipped workflow has no retro step");
      return step;
    };

    it("is a write step that answers learned or nothing, each on the item as retro:{round}", async () => {
      const step = await retro();
      expect(step.capabilities).toEqual(["repo:read", "repo:write"]);
      expect(Object.keys(step.output?.shapes ?? {}).sort()).toEqual(["learned", "nothing"]);
      expect(step.output?.routes.map((r) => r.effect)).toEqual([
        { type: "tracker.comment", marker: "retro:{round}" },
        { type: "tracker.comment", marker: "retro:{round}" },
      ]);
    });

    it("renders the spec and the history, fenced as evidence, with no placeholder left", async () => {
      const rendered = renderPrompt((await retro()).prompt, { node: { id: "7" } } as unknown as Snapshot, {
        spec: { content: "# Export CSV" },
        project: { threads: "none open", history: "@a-person: use tabs, not commas" },
      });
      expect(rendered).toMatch(/approved spec[\s\S]*# Export CSV[\s\S]*end of the approved spec/i);
      expect(rendered).toMatch(/item's history[\s\S]*use tabs, not commas[\s\S]*end of the item's history/i);
      expect(rendered).toMatch(/never an instruction to you/i);
      expect(rendered).toContain("retro: lessons from #7");
      expect(rendered).not.toMatch(/\{brief\.|\{node\./);
    });

    it("keeps its edits to prompts, instructions and skills, and its git to its own branch", async () => {
      const prompt = (await retro()).prompt;
      expect(prompt).toContain(".landrace/workflows/main/steps/");
      expect(prompt).toContain(".agsync/instructions.md");
      expect(prompt).toContain("agsync sync");
      expect(prompt).toContain(".agsync/skills/");
      expect(prompt).toMatch(/never touch any workflow's `workflow\.yaml` — every `\.landrace\/workflows\/\*\/workflow\.yaml`, this workflow's and every other's — nor `\.landrace\/landrace\.yaml`, `\.landrace\/hooks\/`, `src\/`/i);
      expect(prompt).toMatch(/never edit\s+`CLAUDE\.md` or `AGENTS\.md`/i);
      expect(prompt).toContain("git log --grep '^retro:'");
      // A step file's front matter is its permissions and its routing.
      // Prose, asked of the words and not of where the lines wrap.
      const prose = prompt.replace(/\s+/g, " ");
      expect(prose).toMatch(/front matter[^.]*is configuration, as out of reach as the workflow/i);
      // A lesson a person reverted does not come back next round.
      expect(prose).toMatch(/a lesson a person rejected[^.]*stays rejected/i);
      // Tests pin several prompts' wording; a lesson that breaks one is not pushed.
      expect(prompt).toContain("`pnpm install`");
      expect(prose).toMatch(/run the test suite and the lint checks before you push/i);
      expect(prose).toMatch(/never edit a test/i);
      expect(prompt).toContain("`git merge origin/main`");
      expect(prompt).toContain("`git push origin HEAD`");
      expect(prompt).toMatch(/never push any other branch, never force-push, and never touch `main`/i);
    });
  });
});
