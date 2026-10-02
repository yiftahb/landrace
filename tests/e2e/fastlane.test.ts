import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDispatcher } from "#runner/effects.js";
import { createLogger } from "#runner/events.js";
import { sendTo } from "#runner/goto.js";
import { BLOCKED_NOTE, laneOf, statusRows } from "#runner/status.js";
import { tickWorkspace } from "#runner/tick.js";
import { compose } from "#kit/compose.js";
import { createExternalState, createHarness, MemoryForge, MemoryTracker } from "#testing/index.js";
import { createFakeTracker } from "#tests/support/fake-tracker.js";
import { loadWorkspace } from "#workflow/workspace.js";
import type {
  Effect, Executor, ExternalPull, ExternalState, GotoDeps, LoadedWorkflow, MergeAnswer, Node, PostHook, RuntimeContext, ScriptedAnswer, StatusRow,
  Workspace,
} from "#namespace.js";

/*
 * Fastlane end to end: this repository's own workflow, loaded from
 * `.landrace` as `landrace start` loads it, driven over the in-memory tracker
 * and forge with only the agent scripted. Each scenario asserts the stages
 * the item went through, where it ended — its labels, the pull request merged
 * or not, the item closed or not — and, where a cap is the point, how many
 * rounds each step was paid for.
 */
jest.setTimeout(60_000);

let workspace: Workspace;
beforeAll(async () => {
  workspace = await loadWorkspace(".landrace");
});

const flow = (id: string): LoadedWorkflow => {
  const found = workspace.workflows.find((w) => w.id === id);
  if (!found) throw new Error(`.landrace has no workflow ${id}`);
  return found;
};

const ctx: RuntimeContext = { config: {} as RuntimeContext["config"], secrets: new Map(), signal: new AbortController().signal, log: () => {} };

/** Set by a scenario to have the next merge fail on the way, as a 502 does. */
let outage = false;

const json = (value: object): string => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

const ANSWERS: Record<string, ScriptedAnswer> = {
  build: json({ kind: "done" }),
  "code-review": json({ kind: "reviewed" }),
  "fix-review": json({ kind: "addressed" }),
  retro: `- \`.landrace/workflows/full-cycle/steps/build.md\`: the build skipped the test run CI then failed\n\n${json({
    kind: "learned", changes: [{ file: ".landrace/workflows/full-cycle/steps/build.md", why: "the build skipped the test run" }],
  })}`,
};

/** What a failed check's log ends with, and the name the briefing heads it with. */
const RED = { name: "test", log: "FAIL src/export.test.ts\n  export > writes a header\n    AssertionError: expected 'a,b' to equal 'a;b'" };

type During = (at: { stage: string; round: number }, pr: () => ExternalPull) => void | Promise<void>;

/**
 * One item labelled lr:fast — or whatever `labels` says — over the in-memory
 * world, with the forge's pull request reachable once publish opened it.
 * `refuse` wraps the composed post hook, to cut in at an effect; every merge
 * asked of it is counted.
 */
function road(opts: {
  answers?: Record<string, ScriptedAnswer>;
  during?: During;
  seed?: (state: ExternalState) => void;
  before?: (effect: Effect, state: ExternalState) => void;
} = {}) {
  const { workflow, steps } = flow("fastlane");
  const state = createExternalState({
    items: [{ id: "1", title: "Export the table as CSV", body: "Add an Export button that downloads the table as one CSV file.", labels: ["lr:fast"] }],
  });
  opts.seed?.(state);
  const pr = (): ExternalPull => state.pull("pr-1");
  let merges = 0;
  const post: PostHook = {
    id: state.post.id,
    handles: state.post.handles,
    satisfied: (s, e) => state.post.satisfied(s, e),
    apply: async (e, c) => {
      if (e.type === "pull.merge") merges++;
      opts.before?.(e, state);
      return state.post.apply(e, c);
    },
  };
  const run = createHarness({
    workflow, steps, source: state.source, pre: [state.pre], post: [post],
    answers: { ...ANSWERS, ...opts.answers },
    ...(opts.during ? { during: (at: { stage: string; round: number }) => opts.during?.(at, pr) } : {}),
  });
  /** A person's goto, as the board and `landrace_goto` send it: to `target`, or Retry with none. */
  const goto = async (target: string | null): Promise<unknown> => {
    const deps: GotoDeps = {
      source: state.source, pre: [state.pre], dispatcher: createDispatcher([post]), ctx, workflow,
      lock: { root: await mkdtemp(join(tmpdir(), "lr-fastlane-")) },
    };
    return sendTo(deps, "1", target);
  };
  const retry = (): Promise<unknown> => goto(null);
  const row = async (): Promise<StatusRow & { lane: string }> => {
    const graph = await state.source.read("1", ctx);
    const [found] = statusRows(workflow, graph.nodes.filter((n: Node) => n.id === "1"));
    if (!found) throw new Error("no status row for #1");
    return { ...found, lane: laneOf(found, workflow) };
  };
  return { state, run, pr, merges: () => merges, retry, goto, row };
}

/** CI as a push leaves it: the checks on the new head, nothing failed. */
const green = (pr: () => ExternalPull): void => {
  Object.assign(pr(), { checks: "success", failed: [] });
};
const red = (pr: () => ExternalPull): void => {
  Object.assign(pr(), { checks: "failure", failed: [RED] });
};

/** Every build red, so three builds go to `stuck`: CI fails on each review's head. */
const failingCI: During = ({ stage }, pr) => {
  if (stage === "code-review") red(pr);
};

const ROAD_TO_STUCK = [
  "build", "publish", "code-review", "ci",
  "build", "publish", "code-review", "ci",
  "build", "publish", "code-review", "ci", "stuck",
];

describe("fastlane, end to end", () => {
  /*
   * A finding, its fix, red CI and the build that fixes it, the retro the
   * corrections earn, and the merge: every stage of the road, in order.
   */
  it("1. takes the whole road: a finding, red CI, a retro, then the merge, and closes the item", async () => {
    const { state, run, pr } = road({
      during: ({ stage, round }, pull) => {
        if (stage === "code-review" && round === 1) Object.assign(pull(), { awaitingFix: 1, openThreads: 1 });
        if (stage === "fix-review") Object.assign(pull(), { awaitingFix: 0, openThreads: 0 });
        if (stage === "code-review" && round === 2) red(pull);
        if (stage === "build" && round === 2) green(pull);
      },
    });
    const r = await run.converge();

    expect(run.trail()).toEqual([
      "build", "publish", "code-review", "fix-review", "code-review", "ci",
      "build", "publish", "code-review", "ci", "retro", "code-review", "ci", "merge", "done",
    ]);
    expect(r.result.settled).toBe("terminal");
    expect(run.counts()).toEqual({ build: 2, "code-review": 4, "fix-review": 1, retro: 1 });

    // The second build was shown what failed, and the first the item's own text.
    const [first, second] = run.calls().filter((c) => c.stage === "build");
    expect(first?.prompt).toContain("Add an Export button that downloads the table as one CSV file.");
    expect(second?.prompt).toContain("#### test");
    expect(second?.prompt).toContain("AssertionError: expected 'a,b' to equal 'a;b'");

    expect(pr()).toMatchObject({ merged: true, closed: "done", headSha: "sha-1" });
    // Each build's publish is a round of its own.
    expect(state.comments("1").filter((c) => c.startsWith("Publishing, round"))).toEqual([
      expect.stringContaining("Publishing, round 1."), expect.stringContaining("Publishing, round 2."),
    ]);
    expect(state.item("1").closed).toBe("done");
    expect(state.item("1").labels).toContain("lr:stage:done");
    expect(state.item("1").labels).not.toEqual(expect.arrayContaining(["lr:fast"]));
    expect(state.item("1").labels).not.toContain("lr:working");
  });

  it("2. merges a clean review with no CI configured, and never runs the retro", async () => {
    const { state, run, pr } = road();
    const r = await run.converge();

    expect(run.trail()).toEqual(["build", "publish", "code-review", "ci", "merge", "done"]);
    expect(r.result.settled).toBe("terminal");
    expect(run.counts()).toEqual({ build: 1, "code-review": 1 });
    expect(pr()).toMatchObject({ checks: "none", merged: true });
    expect(state.item("1").closed).toBe("done");
    expect(state.item("1").labels).not.toContain("lr:fast");
  });

  /*
   * The race: green on the head the snapshot read, and a push lands before
   * the merge applies — the forge's row moves after the read. The kit's own
   * re-read just before the merge sees the new head and answers moved without
   * asking the forge to merge (scenario 3c has the forge itself say it). The
   * new head is code nobody reviewed: back to review, then CI on it, and only
   * then the merge, at the new head.
   */
  it("3. sends a head that moved before the merge back to review, and merges at the new head", async () => {
    let raced = false;
    const { state, run, pr } = road({
      before: (effect, s) => {
        if (effect.type !== "pull.merge" || raced) return;
        raced = true;
        Object.assign(s.pull("pr-1"), { headSha: "sha-new", checks: "pending" });
      },
      during: ({ stage, round }, pull) => {
        if (stage === "code-review" && round === 2) green(pull);
      },
    });
    const r = await run.converge();

    expect(run.trail()).toEqual(["build", "publish", "code-review", "ci", "merge", "code-review", "ci", "merge", "done"]);
    expect(r.result.settled).toBe("terminal");
    expect(run.counts()).toEqual({ build: 1, "code-review": 2 });
    expect(pr()).toMatchObject({ merged: true, headSha: "sha-new" });
    expect(state.item("1").closed).toBe("done");
    expect(state.item("1").labels).toContain("lr:stage:done");
    expect(state.item("1").labels).not.toContain("lr:fast");
    // Each visit to merge is a round of its own, with its own record.
    expect(state.comments("1").filter((c) => c.startsWith("Merging the pull request"))).toEqual([
      expect.stringContaining("round 1."), expect.stringContaining("round 2."),
    ]);
  });

  /*
   * The same race, then the forge refuses the merge on the new head. The
   * second visit to merge is a round of its own, so its refusal is read where
   * the item stands and the forge is asked once — not a refusal recorded
   * against the first visit's entry, unread, and the forge asked again.
   */
  it("3b. halts at the refusal on a later visit to merge, asking the forge once, with Retry still to give", async () => {
    let raced = false;
    const { state, run, pr, merges, retry } = road({
      before: (effect, s) => {
        if (effect.type !== "pull.merge" || raced) return;
        raced = true;
        Object.assign(s.pull("pr-1"), { headSha: "sha-new", checks: "pending" });
      },
      during: ({ stage, round }, pull) => {
        if (stage === "code-review" && round === 2) Object.assign(pull(), { checks: "success", mergeable: false });
      },
    });
    const r = await run.converge();

    expect(run.trail()).toEqual(["build", "publish", "code-review", "ci", "merge", "code-review", "ci", "merge", "ci", "blocked"]);
    expect(r.result.settled).toBe("wait");
    expect(merges()).toBe(2);
    expect(state.entriesOf("1").filter((e) => e.kind === "malformed")).toEqual([expect.objectContaining({ stage: "merge", round: 2, from: "ci" })]);
    expect(pr()).toMatchObject({ merged: false, closed: null });
    expect(state.item("1").labels).toEqual(expect.arrayContaining(["lr:stage:blocked", "lr:blocked"]));
    expect(await retry()).toEqual({ to: "merge" });
  });

  /*
   * The head moves after the kit's re-read and before the forge merges: the
   * forge's own guard, the head the merge was asked at, answers moved.
   */
  it("3c. sends the item back to review when the forge itself answers that the head moved", async () => {
    class RacingForge extends MemoryForge {
      raced = false;
      override async merge(pull: number, headSha: string): Promise<MergeAnswer> {
        if (!this.raced) {
          this.raced = true;
          Object.assign(this.pull(`pr-${pull}`), { headSha: "sha-new" });
        }
        return super.merge(pull, headSha);
      }
    }
    const tracker = new MemoryTracker({ items: [{ id: "1", title: "Export", body: "Export as CSV.", labels: ["lr:fast"] }] });
    const forge = new RacingForge();
    const hooks = compose({ tracker, forge });
    const { workflow, steps } = flow("fastlane");
    const run = createHarness({ workflow, steps, source: hooks.source, pre: [hooks.pre], post: [hooks.post], answers: ANSWERS });
    const r = await run.converge();

    expect(forge.raced).toBe(true);
    expect(run.trail()).toEqual(["build", "publish", "code-review", "ci", "merge", "code-review", "ci", "merge", "done"]);
    expect(r.result.settled).toBe("terminal");
    expect(forge.pull("pr-1")).toMatchObject({ merged: true, headSha: "sha-new" });
    expect(tracker.row("1").labels).toContain("lr:stage:done");
  });

  it("4. leaves the item stuck for a person after three builds CI keeps failing", async () => {
    const { state, run, pr, row } = road({ during: failingCI });
    const r = await run.converge();

    expect(run.trail()).toEqual(ROAD_TO_STUCK);
    expect(r.result.settled).toBe("wait");
    expect(run.counts()).toEqual({ build: 3, "code-review": 3 });
    expect(state.item("1").labels).toEqual(expect.arrayContaining(["lr:fast", "lr:stage:stuck", "lr:awaiting"]));
    expect(state.item("1").labels).not.toContain("lr:working");
    expect(await row()).toMatchObject({ stage: "stuck", note: "waiting on you", lane: "needs-you" });
    expect(pr()).toMatchObject({ merged: false, closed: null });
    expect(state.item("1").closed).toBeNull();
  });

  /*
   * A person's answer to stuck: drop it. The pull request is closed, not
   * merged, then the item, as dropped; and nothing a later tick reads
   * reopens either.
   */
  it("5. closes the pull request and the item when a person at stuck asks to drop it, and nothing reopens", async () => {
    const { state, run, pr } = road({ during: failingCI, answers: { triage: json({ intent: "close" }) } });
    await run.converge();
    state.say("1", "Not worth it after all, please drop this.");
    const r = await run.converge();

    // From stuck, where the last converge left it: a trail starts with the stage it moved to.
    expect(r.trail).toEqual(["triage", "closed"]);
    expect(r.result.settled).toBe("terminal");
    expect(pr()).toMatchObject({ merged: false, closed: "dropped" });
    expect(state.item("1").closed).toBe("dropped");
    expect(state.item("1").labels).not.toContain("lr:fast");
    expect(state.item("1").labels).not.toContain("lr:awaiting");

    const writes = state.writes().length;
    const again = await run.converge();
    expect(again.calls).toEqual([]);
    expect(state.writes()).toHaveLength(writes);
    expect(pr()).toMatchObject({ merged: false, closed: "dropped" });
    expect(state.item("1").closed).toBe("dropped");
  });

  /*
   * A person's answer to stuck: do more. That build is the fourth, past the
   * three CI fixes may take — the edge a person's reply takes is uncapped,
   * since each one waits for someone to write — and the item then goes the
   * rest of the way: its review, green CI, the retro its corrections earn,
   * and the merge.
   */
  it("6. builds a fourth time when a person at stuck asks for rework, and goes on to the merge", async () => {
    let fixed = false;
    const { state, run, pr } = road({
      during: (at, pull) => {
        if (at.stage === "build" && at.round === 4) fixed = true;
        if (fixed) green(pull);
        else failingCI(at, pull);
      },
      answers: { triage: json({ intent: "rework" }) },
    });
    await run.converge();
    state.say("1", "The test expects semicolons: use ';' as the separator.");
    const r = await run.converge();

    expect(r.trail).toEqual(["triage", "build", "publish", "code-review", "ci", "retro", "code-review", "ci", "merge", "done"]);
    expect(r.result.settled).toBe("terminal");
    expect(run.counts()).toEqual({ build: 4, "code-review": 5, triage: 1, retro: 1 });
    const fourth = run.calls().filter((c) => c.stage === "build")[3];
    expect(fourth?.prompt).toContain("The test expects semicolons");
    expect(pr()).toMatchObject({ merged: true });
    expect(state.item("1").closed).toBe("done");
  });

  it("7. leaves the item stuck once four reviews have each left a finding", async () => {
    const { state, run, pr } = road({
      during: ({ stage }, pull) => {
        if (stage === "code-review") Object.assign(pull(), { awaitingFix: 1, openThreads: 1 });
        if (stage === "fix-review") Object.assign(pull(), { awaitingFix: 0, openThreads: 0 });
      },
    });
    const r = await run.converge();

    expect(run.trail()).toEqual([
      "build", "publish", "code-review", "fix-review", "code-review", "fix-review",
      "code-review", "fix-review", "code-review", "stuck",
    ]);
    expect(r.result.settled).toBe("wait");
    expect(run.counts()).toEqual({ build: 1, "code-review": 4, "fix-review": 3 });
    expect(state.stage("1")).toBe("stuck");
    expect(state.item("1").labels).toContain("lr:awaiting");
    expect(state.item("1").labels).not.toContain("lr:working");
    expect(pr()).toMatchObject({ merged: false, awaitingFix: 1 });
  });

  /*
   * A merge the forge refuses — the pull request is not mergeable — is
   * merge's rejected round: read at ci where the item still is, it goes to
   * `blocked`, in Needs you with the forge's sentence on the item. Nothing
   * asks the forge again on a later tick; a person's Retry does, once.
   */
  it("8. halts on the board when the forge refuses the merge, asks it once, and merges on a Retry", async () => {
    const { state, run, pr, merges, retry, row } = road({
      seed: (s) => { s.openPull("1", { branch: "landrace/1", mergeable: false }); },
    });
    const r = await run.converge();

    expect(run.trail()).toEqual(["build", "publish", "code-review", "ci", "merge", "ci", "blocked"]);
    expect(r.result.settled).toBe("wait");
    expect(merges()).toBe(1);
    expect(pr()).toMatchObject({ merged: false, closed: null });
    expect(state.item("1").labels).toEqual(expect.arrayContaining(["lr:stage:blocked", "lr:blocked"]));
    expect(await row()).toMatchObject({ stage: "blocked", note: BLOCKED_NOTE, lane: "needs-you" });
    expect(state.entriesOf("1").filter((e) => e.kind === "malformed")).toEqual([expect.objectContaining({ stage: "merge", round: 1, from: "ci" })]);
    expect(state.comments("1").at(-1)).toContain("pr-1 for #1 cannot be merged: the forge finds it not mergeable");

    const later = await run.converge();
    expect(later.result.settled).toBe("wait");
    expect(merges()).toBe(1);

    delete pr().mergeable;
    expect(await retry()).toEqual({ to: "merge" });
    const retried = await run.converge();
    expect(retried.trail).toEqual(["merge", "done"]);
    expect(merges()).toBe(2);
    expect(pr()).toMatchObject({ merged: true });
    expect(state.item("1").closed).toBe("done");
    expect(state.item("1").labels).not.toContain("lr:blocked");
  });

  /*
   * Security audit C1: a build that changed one of the engine's own hooks —
   * TypeScript the engine imports with the project's secrets on its next
   * start — reviewed clean and green, is not merged by Landrace. The kit
   * reads the pull request's changed files before the merge and refuses: the
   * item halts with the path named, and a person merges it or not. Merged by
   * hand, the item is done.
   */
  it("13. halts a build that changed .landrace/hooks/github.ts, merging nothing, and finishes once a person merges it", async () => {
    const { state, run, pr, row } = road({
      seed: (s) => {
        s.openPull("1", { files: [
          { path: "src/export.ts", status: "added", additions: 40, deletions: 0 },
          { path: ".landrace/hooks/github.ts", status: "modified", additions: 2, deletions: 0 },
        ] });
      },
    });
    const r = await run.converge();

    expect(run.trail()).toEqual(["build", "publish", "code-review", "ci", "merge", "ci", "blocked"]);
    expect(r.result.settled).toBe("wait");
    expect(pr()).toMatchObject({ merged: false, closed: null });
    expect(state.item("1").closed).toBeNull();
    expect(state.item("1").labels).toEqual(expect.arrayContaining(["lr:stage:blocked", "lr:blocked", "lr:fast"]));
    expect(await row()).toMatchObject({ stage: "blocked", note: BLOCKED_NOTE, lane: "needs-you" });
    const said = state.comments("1").at(-1) ?? "";
    expect(said).toContain("will not merge pr-1 for #1: it changes .landrace/hooks/github.ts, which this workflow protects, so a person must merge it");
    expect(said).not.toContain("src/export.ts");

    // A person reads it, and merges it themselves.
    Object.assign(pr(), { merged: true, closed: "done" });
    const merged = await run.converge();
    // From blocked, where the last converge left it: a trail starts with the stage it moved to.
    expect(merged.trail).toEqual(["done"]);
    expect(merged.result.settled).toBe("terminal");
    expect(merged.calls).toEqual([]);
    expect(state.item("1").closed).toBe("done");
    expect(state.item("1").labels).toContain("lr:stage:done");
    expect(state.item("1").labels).not.toEqual(expect.arrayContaining(["lr:fast"]));
    expect(state.item("1").labels).not.toContain("lr:blocked");
  });

  /*
   * publish, merge and closed are Retry's alone: after any other failure a
   * person cannot send the item there — "Go to step… merge" after a broken
   * review would merge code no review passed — and after one of them was
   * refused, they can.
   */
  it("8d. lets a person into publish, merge or closed only as the Retry of a refused one", async () => {
    const broken = road({ answers: { "code-review": "I looked, and it is fine." } });
    await broken.run.converge(); // the broken answer is recorded
    await broken.run.converge(); // and the next tick routes it to the halt
    expect(broken.state.stage("1")).toBe("blocked");
    for (const to of ["publish", "merge", "closed"]) {
      expect(await broken.goto(to)).toEqual({ refused: expect.stringMatching(new RegExp(`"blocked" sends an item to "${to}" only while`)) });
    }
    expect(await broken.retry()).toEqual({ to: "code-review" });

    const refused = road({ seed: (s) => { s.openPull("1", { branch: "landrace/1", mergeable: false }); } });
    await refused.run.converge();
    expect(refused.state.stage("1")).toBe("blocked");
    expect(await refused.goto("merge")).toEqual({ to: "merge" });
  });

  /*
   * A Retry of the refused merge that meets something still settling —
   * checks running on the head a person just pushed, or a 502 — leaves the
   * item at the halt with the merge's way in unfinished. Retry takes it
   * again, at the same round, and once the forge allows it the item merges:
   * never stranded at a halt where Retry answers "nothing has failed".
   */
  it.each([
    ["checks still running", (pull: ExternalPull) => { pull.checks = "pending"; }, (pull: ExternalPull) => { pull.checks = "success"; }],
    ["a 502", () => { outage = true; }, () => { outage = false; }],
  ] as const)("8e. takes a Retry of the merge that met %s again, and merges", async (_what, unsettle, settle) => {
    outage = false;
    const { state, run, pr, merges, retry, goto } = road({
      seed: (s) => { s.openPull("1", { branch: "landrace/1", mergeable: false }); },
      before: (effect) => {
        if (effect.type === "pull.merge" && outage) throw new Error("502 Bad Gateway");
      },
    });
    await run.converge();
    expect(state.stage("1")).toBe("blocked");

    delete pr().mergeable;
    unsettle(pr());
    expect(await retry()).toEqual({ to: "merge" });
    const met = await run.converge();
    expect(met.result.settled).toBe("halt");
    expect(state.stage("1")).toBe("blocked");
    expect(pr().merged).toBe(false);

    settle(pr());
    expect((await run.converge()).result.settled).toBe("wait");
    expect(await goto("merge")).toEqual({ to: "merge" });
    const done = await run.converge();

    expect(done.trail).toEqual(["merge", "done"]);
    expect(pr().merged).toBe(true);
    expect(merges()).toBe(3);
    expect(state.entriesOf("1").filter((e) => e.kind === "enter" && e.stage === "merge").map((e) => e.round)).toEqual([1, 2]);
    expect(state.item("1").closed).toBe("done");
  });

  /*
   * The merge needs every thread resolved, a Retry's merge as much as the
   * first: a reviewer's thread opened while the item was halted declines the
   * Retry, in a sentence, and nothing merges.
   */
  it("8f. declines a Retry of the merge while a thread awaits a fix, merging nothing", async () => {
    const { state, run, pr, merges, retry } = road({
      seed: (s) => { s.openPull("1", { branch: "landrace/1", mergeable: false }); },
    });
    await run.converge();
    expect(state.stage("1")).toBe("blocked");

    delete pr().mergeable;
    Object.assign(pr(), { openThreads: 1, awaitingFix: 1 });
    expect(await retry()).toEqual({ refused: expect.stringMatching(/"blocked" sends an item to "merge" only while .*openThreads/) });
    await run.converge();

    expect(merges()).toBe(1);
    expect(pr()).toMatchObject({ merged: false, closed: null });
    expect(state.stage("1")).toBe("blocked");
  });

  /*
   * A person closing the pull request unmerged is a stop, wherever the item
   * is. During a build, the next publish refuses to open another: the item
   * halts with the reason, and no second pull request is opened, let alone
   * merged. During a review, the item is stuck, a person's to settle.
   */
  it("10. halts, and opens no second pull request, when a person closed it during a build", async () => {
    const { state, run, pr } = road({
      during: ({ stage, round }, pull) => {
        if (stage === "code-review" && round === 1) red(pull);
        if (stage === "build" && round === 2) pull().closed = "dropped";
      },
    });
    const r = await run.converge();

    expect(run.trail()).toEqual(["build", "publish", "code-review", "ci", "build", "publish", "build", "blocked"]);
    expect(r.result.settled).toBe("wait");
    expect(pr()).toMatchObject({ merged: false, closed: "dropped" });
    expect(() => state.pull("pr-2")).toThrow();
    expect(state.item("1").labels).toEqual(expect.arrayContaining(["lr:stage:blocked", "lr:blocked"]));
    expect(state.comments("1").at(-1)).toMatch(/pr-1 from landrace\/1 for #1 was closed unmerged/);
  });

  it("11. leaves the item stuck when a person closed the pull request during a review", async () => {
    const { state, run, pr } = road({
      during: ({ stage }, pull) => {
        if (stage === "code-review") pull().closed = "dropped";
      },
    });
    const r = await run.converge();

    expect(run.trail()).toEqual(["build", "publish", "code-review", "stuck"]);
    expect(r.result.settled).toBe("wait");
    expect(pr()).toMatchObject({ merged: false, closed: "dropped" });
    expect(state.item("1").labels).toEqual(expect.arrayContaining(["lr:stage:stuck", "lr:awaiting"]));
    expect(state.item("1").labels).not.toContain("lr:working");
  });

  /*
   * The item is closed before its position and labels say it is done: an
   * outage on the close leaves it at merge, still labelled lr:fast, and the
   * next tick closes it. Closed after them, it was left open, done and no
   * longer admitted, which nothing works again.
   */
  it("12. closes the item on the next tick when the close met an outage at done", async () => {
    let down = true;
    const { state, run, pr } = road({
      before: (effect) => {
        if (effect.type === "tracker.close" && down) {
          down = false;
          throw new Error("502 Bad Gateway");
        }
      },
    });
    const first = await run.converge();
    expect(first.result).toMatchObject({ settled: "halt", why: expect.stringContaining("502") });
    expect(pr().merged).toBe(true);
    expect(state.item("1").closed).toBeNull();

    const next = await run.converge();
    expect(next.result.settled).toBe("terminal");
    expect(state.item("1").closed).toBe("done");
    expect(state.item("1").labels).toContain("lr:stage:done");
    expect(state.item("1").labels).not.toContain("lr:fast");
  });

  /*
   * A merge that failed on the way — a 502, a dropped connection — is not a
   * refusal: nothing is recorded, the item stays at ci for this tick, and the
   * next tick merges. Over the in-memory forge, and over the fake GitHub,
   * where the 502 is GitHub's own answer to the merge.
   */
  it("8b. leaves a merge that failed on the way unrecorded, at ci, and merges on the next tick", async () => {
    let down = true;
    const { state, run, pr, merges } = road({
      before: (effect) => {
        if (effect.type === "pull.merge" && down) throw new Error("502 Bad Gateway");
      },
    });
    const first = await run.converge();

    expect(first.result).toMatchObject({ settled: "halt", why: expect.stringContaining("502 Bad Gateway") });
    expect(state.stage("1")).toBe("ci");
    expect(state.entriesOf("1").filter((e) => e.kind === "malformed")).toEqual([]);
    expect(state.item("1").labels).not.toContain("lr:blocked");

    down = false;
    const next = await run.converge();
    expect(next.trail).toEqual(["ci", "merge", "done"]);
    expect(merges()).toBe(2);
    expect(pr().merged).toBe(true);
  });

  it("8c. leaves GitHub's 502 on the merge unrecorded, and merges on the next tick", async () => {
    const gh = createFakeTracker([{ number: 1, labels: ["lr:fast", "lr:stage:ci"] }]);
    const opened = gh.openPull({ head: "landrace/1", number: 8, headSha: "abc1234", closes: [1], checks: "SUCCESS" });
    const { workflow, steps } = flow("fastlane");
    const { source, pre, post } = gh.registry;
    if (!source) throw new Error("the fake GitHub registered no source");
    const run = createHarness({ workflow, steps, source, pre, post, answers: {} });
    gh.breakOn((r) => r.method === "PUT" && r.path === "/pulls/8/merge", 502);
    const first = await run.converge();

    expect(first.result).toMatchObject({ settled: "halt", why: expect.stringContaining("GitHub answered 502") });
    expect(gh.labelsOf(1)).toContain("lr:stage:ci");
    expect(gh.entriesOf(1).filter((e) => e.kind === "malformed")).toEqual([]);
    expect(opened.merged).toBe(false);

    gh.breakOn(() => false);
    const next = await run.converge();
    expect(next.result.settled).toBe("terminal");
    expect(opened.merged).toBe(true);
    expect(gh.labelsOf(1)).toContain("lr:stage:done");
  });

  /*
   * main starts lr:auto and fastlane lr:fast; an item carrying both is
   * claimed by both, which halts it, naming both, before either writes.
   */
  it("9. halts an item labelled lr:auto and lr:fast as claimed by both workflows, writing nothing", async () => {
    const state = createExternalState({ items: [{ id: "1", labels: ["lr:auto", "lr:fast"] }] });
    const ran: string[] = [];
    const executor: Executor = { id: "agent", run: async () => { ran.push("ran"); throw new Error("no step may run"); } };
    const stop = new AbortController();
    const runtimeCtx: RuntimeContext = { ...ctx, signal: stop.signal };
    const log = createLogger({ sink: () => {} });
    const listed = workspace.workflows.map((w) => ({
      id: w.id, name: w.workflow.name, description: w.workflow.description, source: state.source,
      deps: {
        workflow: w.workflow, steps: w.steps, source: state.source, pre: [state.pre], dispatcher: createDispatcher([state.post]),
        executor, ctx: runtimeCtx, log, scrub: (t: string) => t,
      },
    }));
    const root = await mkdtemp(join(tmpdir(), "lr-fastlane-claims-"));
    const runtime = {
      dir: root, workflows: listed, preflights: [], intervalMs: 60_000, concurrency: 2, stop,
      running: new Map(), seen: new Map(), log, ctx: runtimeCtx,
    };

    expect(await tickWorkspace({ runtime, lock: { root } })).toEqual([{ item: "1", outcome: "claimed by fastlane and full-cycle" }]);
    expect(ran).toEqual([]);
    expect(state.writes()).toEqual([]);
    expect(state.item("1").labels).toEqual(["lr:auto", "lr:fast"]);
    expect(state.comments("1")).toEqual([]);
  });
});
