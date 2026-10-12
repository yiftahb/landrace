import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordMarker, renderMarker } from "#conventions.js";
import { createDispatcher } from "#runner/effects.js";
import { createLogger } from "#runner/events.js";
import { sendTo } from "#runner/goto.js";
import { BLOCKED_NOTE, laneOf, statusRows } from "#runner/status.js";
import { tickWorkspace } from "#runner/tick.js";
import { compose } from "#kit/compose.js";
import { defineSource } from "#hooks/contracts.js";
import { createExternalState, createHarness, MemoryForge, MemoryTracker } from "#testing/index.js";
import { createFakeTracker } from "#tests/support/fake-tracker.js";
import { loadWorkspace } from "#workflow/workspace.js";
import type {
  Effect, Executor, ExternalPull, ExternalState, GotoDeps, LoadedWorkflow, Logger, MergeAnswer, Node, PostHook, RuntimeContext, ScriptedAnswer,
  StatusRow, Workspace,
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

/** As .landrace/landrace.yaml configures it: the retro's landrace/{item}-retro is the item's branch too (#158). */
const config = { branchVariants: ["retro"] } as RuntimeContext["config"];
const ctx: RuntimeContext = { config, secrets: new Map(), signal: new AbortController().signal, log: () => {} };

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
 * One item labelled lr:auto and lr:fast — fastlane's, by the label model — over the in-memory
 * world, with the forge's pull request reachable once publish opened it.
 * `refuse` wraps the composed post hook, to cut in at an effect; every merge
 * asked of it is counted.
 */
function road(opts: {
  answers?: Record<string, ScriptedAnswer>;
  during?: During;
  seed?: (state: ExternalState) => void;
  before?: (effect: Effect, state: ExternalState) => void;
  log?: Logger;
  /** One converge's passes: a road past the default's thirty settles over more ticks than one. */
  maxPasses?: number;
} = {}) {
  const { workflow, steps } = flow("fastlane");
  const state = createExternalState({
    items: [{ id: "1", title: "Export the table as CSV", body: "Add an Export button that downloads the table as one CSV file.", labels: ["lr:auto", "lr:fast"] }],
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
    workflow, steps, source: state.source, pre: [state.pre], post: [post], config,
    answers: { ...ANSWERS, ...opts.answers },
    startedAt: (branch) => headOn(state, branch),
    ...(opts.during ? { during: (at: { stage: string; round: number }) => opts.during?.(at, pr) } : {}),
    ...(opts.log ? { log: opts.log } : {}),
    ...(opts.maxPasses === undefined ? {} : { maxPasses: opts.maxPasses }),
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

/**
 * Where a step on `branch` starts, as a worktree cut now would: the head of
 * the open pull request from it, there being no repository here. The
 * reviewer's round records it, and the merge is held to it.
 */
const headOn = (state: ExternalState, branch: string): string | null => {
  for (let n = 1; ; n++) {
    let pull: ExternalPull;
    try {
      pull = state.pull(`pr-${n}`);
    } catch {
      return null;
    }
    if (pull.branch === branch && pull.closed === null) return pull.headSha;
  }
};

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
   * A finding, its fix, red CI and the build that fixes it, the merge, and
   * on the closed item the retro the corrections earn (#158): every stage of
   * the road, in order.
   */
  it("1. takes the whole road: a finding, red CI, the merge, then on the closed item a retro", async () => {
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
      "build", "publish", "code-review", "ci", "merge", "done",
    ]);
    expect(r.result.settled).toBe("terminal");
    expect(run.counts()).toEqual({ build: 2, "code-review": 3, "fix-review": 1 });

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
    // Finished, it keeps what admitted it: the board files it under fastlane's Done.
    expect(state.item("1").labels).toEqual(expect.arrayContaining(["lr:auto", "lr:fast"]));
    expect(state.item("1").labels).not.toContain("lr:working");

    // The next tick, the closed item's retro, once.
    expect((await run.converge()).trail).toEqual(["retro"]);
    expect(run.counts()).toEqual({ build: 2, "code-review": 3, "fix-review": 1, retro: 1 });
    expect(state.item("1")).toMatchObject({ closed: "done" });
    expect(state.stage("1")).toBe("retro");
  });

  it("2. merges a clean review with no CI configured, and never runs the retro", async () => {
    const { state, run, pr } = road();
    const r = await run.converge();
    // Nor on the closed item, with nothing corrected on the way.
    expect((await run.converge()).trail).toEqual([]);

    expect(run.trail()).toEqual(["build", "publish", "code-review", "ci", "merge", "done"]);
    expect(r.result.settled).toBe("terminal");
    expect(run.counts()).toEqual({ build: 1, "code-review": 1 });
    expect(pr()).toMatchObject({ checks: "none", merged: true });
    expect(state.item("1").closed).toBe("done");
    expect(state.item("1").labels).toEqual(expect.arrayContaining(["lr:auto", "lr:fast"]));
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
    expect(state.item("1").labels).toEqual(expect.arrayContaining(["lr:auto", "lr:fast"]));
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
    const tracker = new MemoryTracker({ items: [{ id: "1", title: "Export", body: "Export as CSV.", labels: ["lr:auto", "lr:fast"] }] });
    const forge = new RacingForge();
    const hooks = compose({ tracker, forge });
    const { workflow, steps } = flow("fastlane");
    const run = createHarness({
      workflow, steps, source: hooks.source, pre: [hooks.pre], post: [hooks.post], answers: ANSWERS,
      startedAt: () => forge.rows.get("pr-1")?.headSha ?? null,
    });
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
    expect(state.item("1").labels).toEqual(expect.arrayContaining(["lr:auto", "lr:fast"]));
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
   * rest of the way: its review, green CI and the merge. The retro its
   * corrections earn runs on the closed item, the next tick (#158).
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

    expect(r.trail).toEqual(["triage", "build", "publish", "code-review", "ci", "merge", "done"]);
    expect(r.result.settled).toBe("terminal");
    expect(run.counts()).toEqual({ build: 4, "code-review": 4, triage: 1 });
    const fourth = run.calls().filter((c) => c.stage === "build")[3];
    expect(fourth?.prompt).toContain("The test expects semicolons");
    expect(pr()).toMatchObject({ merged: true });
    expect(state.item("1").closed).toBe("done");
    expect((await run.converge()).trail).toEqual(["retro"]);
  });

  it("7. leaves the item stuck once six reviews have each left a finding", async () => {
    const { state, run, pr } = road({
      during: ({ stage }, pull) => {
        if (stage === "code-review") Object.assign(pull(), { awaitingFix: 1, openThreads: 1 });
        if (stage === "fix-review") Object.assign(pull(), { awaitingFix: 0, openThreads: 0 });
      },
    });
    const r = await run.converge();

    expect(run.trail()).toEqual([
      "build", "publish", "code-review", "fix-review", "code-review", "fix-review", "code-review", "fix-review",
      "code-review", "fix-review", "code-review", "fix-review", "code-review", "stuck",
    ]);
    expect(r.result.settled).toBe("wait");
    expect(run.counts()).toEqual({ build: 1, "code-review": 6, "fix-review": 5 });
    expect(state.stage("1")).toBe("stuck");
    expect(state.item("1").labels).toContain("lr:awaiting");
    expect(state.item("1").labels).not.toContain("lr:working");
    expect(pr()).toMatchObject({ merged: false, awaitingFix: 1 });
  });

  /*
   * #71, as #56 went, at #154's caps: five reviews each found behaviour to
   * fix, and a sixth found only wording in `docs/`, flagged so. That goes
   * round once more instead of to `stuck`; round 7 is clean, and Landrace
   * merges — no person anywhere on the road. The retro the fix rounds earn
   * runs after the merge (#158).
   */
  const CHANGED = [
    { path: "src/export.ts", status: "modified", additions: 20, deletions: 0 },
    { path: "docs/export.md", status: "modified", additions: 4, deletions: 0 },
  ];
  const reviewer = (rounds: Record<number, object>) => (round: number): string =>
    json({ kind: "reviewed", findings: [], replies: [], resolved: [], ...rounds[round] });
  const fixer = json({ kind: "addressed", replies: [{ thread: "T", body: "Fixed." }] });
  const behaviour = (round: number) => ({
    ...(round > 1 ? { resolved: [`T${round - 1}`] } : {}),
    findings: [{ file: "src/export.ts", line: round, body: "Handle an empty table." }],
  });
  const wording = (round: number) => ({
    resolved: [`T${round - 1}`],
    findings: [{ file: "docs/export.md", line: 2, body: "Say semicolon, not comma.", wording: true }],
  });

  it("7b. merges an item whose sixth review found only wording in docs/, with no person", async () => {
    const { state, run, pr, merges } = road({ maxPasses: 60,
      answers: {
        "code-review": reviewer({
          1: behaviour(1), 2: behaviour(2), 3: behaviour(3), 4: behaviour(4), 5: behaviour(5), 6: wording(6), 7: { resolved: ["T6"] },
        }),
        "fix-review": fixer,
        retro: json({ kind: "nothing", reason: "Each finding was this item's own." }),
      },
      during: ({ stage, round }, pull) => {
        if (stage === "code-review" && round === 1) Object.assign(pull(), { files: CHANGED });
      },
    });
    const r = await run.converge();

    expect(run.trail()).toEqual([
      "build", "publish", "code-review", "fix-review", "code-review", "fix-review", "code-review", "fix-review",
      "code-review", "fix-review", "code-review", "fix-review", "code-review", "fix-review",
      "code-review", "ci", "merge", "done",
    ]);
    expect(r.result.settled).toBe("terminal");
    expect(run.counts()).toEqual({ build: 1, "code-review": 7, "fix-review": 6 });
    expect(merges()).toBe(1);
    expect(pr()).toMatchObject({ merged: true, closed: "done", openThreads: 0, awaitingFix: 0 });
    expect(state.item("1").closed).toBe("done");
    expect(state.item("1").labels).toContain("lr:stage:done");
    expect(state.item("1").labels).not.toContain("lr:awaiting");
  });

  /*
   * #120: code review's only finding was on a file the pull request did not
   * touch. Listed in the review's text, it counted toward nothing, and the
   * item went to ci and on to merge nine seconds later. Threaded on a changed
   * file, it awaits a fix like any other.
   */
  it("7d. sends a review whose only finding is on a file the pull request does not touch to fix-review, not ci", async () => {
    const { run } = road({
      answers: {
        "code-review": reviewer({
          1: { findings: [{ file: "src/testing/harness.ts", line: 125, body: "Still fills the default branch." }] },
          2: { resolved: ["T1"] },
        }),
        "fix-review": fixer,
        retro: json({ kind: "nothing", reason: "The finding was this item's own." }),
      },
      during: ({ stage, round }, pull) => {
        if (stage === "code-review" && round === 1) Object.assign(pull(), { files: CHANGED });
      },
    });
    await run.converge();

    expect(run.trail().slice(0, 5)).toEqual(["build", "publish", "code-review", "fix-review", "code-review"]);
    expect(run.trail()).not.toContain("stuck");
  });

  it("7e. halts a review with a finding when the pull request changes no file to put it on, naming the finding", async () => {
    const { state, run, merges } = road({
      answers: { "code-review": reviewer({ 1: { findings: [{ file: "src/b.ts", line: 4, body: "Off by one." }] } }) },
      during: ({ stage, round }, pull) => {
        if (stage === "code-review" && round === 1) Object.assign(pull(), { files: [] });
      },
    });
    const r = await run.converge();

    expect(run.trail()).toEqual(["build", "publish", "code-review", "blocked"]);
    expect(r.result.settled).toBe("wait");
    expect(merges()).toBe(0);
    expect(state.comments("1").at(-1)).toContain("`src/b.ts:4`");
  });

  it("7c. leaves the item stuck on the wording budget once an eighth review still finds only wording", async () => {
    const why: unknown[] = [];
    const { state, run, pr } = road({ maxPasses: 60,
      answers: {
        "code-review": reviewer({
          1: behaviour(1), 2: behaviour(2), 3: behaviour(3), 4: behaviour(4), 5: behaviour(5), 6: wording(6), 7: wording(7), 8: wording(8),
        }),
        "fix-review": fixer,
      },
      log: (name, data = {}) => {
        if (name === "item.evaluated" && data.to === "stuck") why.push(data.why);
      },
    });
    const r = await run.converge();

    expect(run.trail()).toEqual([
      "build", "publish", "code-review", "fix-review", "code-review", "fix-review", "code-review", "fix-review",
      "code-review", "fix-review", "code-review", "fix-review", "code-review", "fix-review",
      "code-review", "fix-review", "code-review", "stuck",
    ]);
    expect(r.result.settled).toBe("wait");
    expect(why).toEqual(["the wording budget is exhausted"]);
    expect(run.counts()).toEqual({ build: 1, "code-review": 8, "fix-review": 7 });
    expect(state.item("1").labels).toContain("lr:awaiting");
    expect(pr()).toMatchObject({ merged: false, awaitingFix: 1, awaitingWordingFix: 1 });
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
    expect(state.item("1").labels).toEqual(expect.arrayContaining(["lr:auto", "lr:fast"]));
    expect(state.item("1").labels).not.toContain("lr:blocked");
  });

  /*
   * Re-review N1: a step file's front matter is configuration — the probe
   * made code review's route a merge with one line — so a pull request
   * changing a step file is a person's to merge, as one changing a workflow is.
   */
  it("13b. halts a build that changed a step file, merging nothing", async () => {
    const step = ".landrace/workflows/full-cycle/steps/code-review.md";
    const { state, run, pr } = road({
      seed: (s) => {
        s.openPull("1", { files: [
          { path: "src/export.ts", status: "added", additions: 40, deletions: 0 },
          { path: step, status: "modified", additions: 1, deletions: 1 },
        ] });
      },
    });
    const r = await run.converge();

    expect(run.trail()).toEqual(["build", "publish", "code-review", "ci", "merge", "ci", "blocked"]);
    expect(r.result.settled).toBe("wait");
    expect(pr()).toMatchObject({ merged: false, closed: null });
    expect(state.comments("1").at(-1)).toContain(`it changes ${step}, which this workflow protects, so a person must merge it`);
  });

  /*
   * And the retro's own lessons (#158): learned after the merge, on the
   * closed item, they are a pull request of their own from
   * landrace/{item}-retro, which nothing here reviews or merges — a
   * person's, every file a lesson goes in being one only a person merges.
   */
  it("15b. leaves the pull request the retro opens for a person to merge, and the item closed", async () => {
    const { state, run, merges } = road({
      during: ({ stage, round }, pull) => {
        if (stage === "code-review" && round === 1) Object.assign(pull(), { awaitingFix: 1, openThreads: 1 });
        if (stage === "fix-review") Object.assign(pull(), { awaitingFix: 0, openThreads: 0 });
      },
    });
    await run.converge();
    expect(state.pull("pr-1")).toMatchObject({ merged: true });
    expect((await run.converge()).trail).toEqual(["retro"]);
    expect(merges()).toBe(1);
    expect(state.pull("pr-2")).toMatchObject({ branch: "landrace/1-retro", merged: false, closed: null });
    expect(state.item("1").closed).toBe("done");
  });

  /*
   * Security audit H1, probe P3: a push lands after the review read the pull
   * request and before the merge. CI goes green on it, and nobody reviewed
   * it. The merge is held to the head the review's round started at, so it
   * answers as a moved head does: back to review, which reads the new head,
   * and only then the merge, at that head.
   */
  it("14. sends a head pushed after the review back to review before it merges, and merges what the review read", async () => {
    const { state, run, pr, merges } = road({
      during: ({ stage, round }, pull) => {
        if (stage === "code-review" && round === 1) Object.assign(pull(), { headSha: "sha-unreviewed" });
      },
    });
    const r = await run.converge();

    expect(run.trail()).toEqual(["build", "publish", "code-review", "ci", "merge", "code-review", "ci", "merge", "done"]);
    expect(r.result.settled).toBe("terminal");
    expect(run.counts()).toEqual({ build: 1, "code-review": 2 });
    expect(merges()).toBe(2);
    expect(pr()).toMatchObject({ merged: true, headSha: "sha-unreviewed" });
    // Each review round's record says the head it read: the second one is the head that merged.
    const reviews = state.entriesOf("1").filter((e) => e.kind === "output" && e.stage === "code-review");
    expect(reviews.map((e) => e.head)).toEqual(["sha-1", "sha-unreviewed"]);
    expect(state.item("1").closed).toBe("done");
  });

  /*
   * Re-review N2, its loop simulation: the push is someone else's — a
   * person's, or the forge's "Update branch" — so this checkout never made
   * the commit, and a step's worktree starts from what the checkout has
   * heard of origin's branch. Unfetched, every review recorded the old head,
   * the merge answered "unreviewed" each time, and four paid reviews later
   * the item was stuck. Fetched before each step, the second review reads
   * the push, and the merge takes it.
   */
  it("14b. reviews a push someone else made once, fetched before the step, and merges it — never stuck", async () => {
    const { workflow, steps } = flow("fastlane");
    const state = createExternalState({
      items: [{ id: "1", title: "Export the table as CSV", body: "Add an Export button.", labels: ["lr:auto", "lr:fast"] }],
    });
    /** This checkout's own branch: what its build committed, and what a fetch of origin's brought it. */
    const checkout = new Map<string, string>();
    const source = defineSource({
      ...state.source,
      remoteHead: async (branch: string, c: RuntimeContext) => {
        const head = (await state.source.remoteHead?.(branch, c)) ?? null;
        if (head !== null) checkout.set(branch, head);
        return head;
      },
    });
    const run = createHarness({
      workflow, steps, source, pre: [state.pre], post: [state.post], answers: ANSWERS,
      startedAt: (branch) => checkout.get(branch) ?? null,
      during: ({ stage, round }) => {
        // The build's commit is this checkout's own; publish opens pr-1 at it.
        if (stage === "build") checkout.set("landrace/1", "sha-1");
        // Pushed elsewhere while the first review ran.
        if (stage === "code-review" && round === 1) state.pull("pr-1").headSha = "sha-theirs";
      },
    });
    const r = await run.converge();

    expect(run.trail()).toEqual(["build", "publish", "code-review", "ci", "merge", "code-review", "ci", "merge", "done"]);
    expect(r.result.settled).toBe("terminal");
    expect(run.counts()).toEqual({ build: 1, "code-review": 2 });
    const reviews = state.entriesOf("1").filter((e) => e.kind === "output" && e.stage === "code-review");
    expect(reviews.map((e) => e.head)).toEqual(["sha-1", "sha-theirs"]);
    expect(state.pull("pr-1")).toMatchObject({ merged: true, headSha: "sha-theirs" });
  });

  /*
   * The fixer's commits move the head too, and are reviewed before they can
   * merge: they go back through a review round, which records the head it
   * read, so the head that merges is always one a review round started at.
   */
  it("15. reviews the fixer's commits at the head they made, and merges it", async () => {
    const { state, run, pr } = road({
      during: ({ stage, round }, pull) => {
        if (stage === "code-review" && round === 1) Object.assign(pull(), { awaitingFix: 1, openThreads: 1 });
        if (stage === "fix-review") Object.assign(pull(), { awaitingFix: 0, openThreads: 0, headSha: "sha-fixed" });
      },
    });
    const r = await run.converge();

    expect(run.trail()).toEqual(["build", "publish", "code-review", "fix-review", "code-review", "ci", "merge", "done"]);
    expect(r.result.settled).toBe("terminal");
    const reviews = state.entriesOf("1").filter((e) => e.kind === "output" && e.stage === "code-review");
    expect(reviews.map((e) => e.head)).toEqual(["sha-1", "sha-fixed"]);
    expect(pr()).toMatchObject({ merged: true, headSha: "sha-fixed" });
  });

  /*
   * #158: the retro runs after the merge, on the closed item. Merged after a
   * fix round, the item closes at `done`; the next tick runs the retro once,
   * on landrace/1-retro, which its `learned` answer pushes and opens one pull
   * request from, `1: retro lessons`. Later ticks run nothing: the item rests
   * at `retro`, closed. The item's own pull request answers nothing for it.
   */
  const fixRound: During = ({ stage, round }, pull) => {
    if (stage === "code-review" && round === 1) Object.assign(pull(), { awaitingFix: 1, openThreads: 1 });
    if (stage === "fix-review") Object.assign(pull(), { awaitingFix: 0, openThreads: 0 });
  };

  it("16. runs the retro once on the closed item, pushing landrace/1-retro and opening one pull request from it", async () => {
    const { state, run } = road({ during: fixRound });
    const merged = await run.converge();
    expect(merged.trail.slice(-2)).toEqual(["merge", "done"]);
    expect(state.pushes()).not.toContain("landrace/1-retro");

    const retro = await run.converge();
    expect(retro.trail).toEqual(["retro"]);
    expect(run.counts().retro).toBe(1);
    expect(state.pushes().filter((b) => b === "landrace/1-retro")).toEqual(["landrace/1-retro"]);
    const opened = [...["pr-2", "pr-3"]].flatMap((id) => { try { return [state.pull(id)]; } catch { return []; } });
    expect(opened).toEqual([expect.objectContaining({ branch: "landrace/1-retro", item: "1", opened: { title: "1: retro lessons", description: undefined } })]);
    // The step ran on its own branch: a variant of the item's, never the merged one.
    expect(run.calls().filter((c) => c.stage === "retro")).toHaveLength(1);
    expect(state.item("1")).toMatchObject({ closed: "done" });
    expect(state.stage("1")).toBe("retro");
    // Its summary is on the item, beside the record of the round.
    expect(state.comments("1").some((c) => c.includes("the build skipped the test run CI then failed"))).toBe(true);

    const pushed = state.pushes().length;
    for (let tick = 0; tick < 2; tick++) expect((await run.converge()).trail).toEqual([]);
    expect(run.counts().retro).toBe(1);
    expect(state.pushes()).toHaveLength(pushed);
    expect(() => state.pull("pr-3")).toThrow();
  });

  it("16b. publishes nothing when the retro answers nothing", async () => {
    const { state, run } = road({ during: fixRound, answers: { retro: json({ kind: "nothing", reason: "The finding was this item's own." }) } });
    await run.converge();
    expect((await run.converge()).trail).toEqual(["retro"]);
    expect(state.pushes()).not.toContain("landrace/1-retro");
    expect(() => state.pull("pr-2")).toThrow();
    expect(state.stage("1")).toBe("retro");
    expect((await run.converge()).trail).toEqual([]);
  });

  /*
   * The failure #158 was filed for: a person merges the pull request first,
   * after friction, before Landrace's merge. The item goes to `done` all the
   * same, and the retro still runs on it.
   */
  it("16c. runs the retro after a person merged the pull request by hand", async () => {
    const { state, run, merges } = road({
      during: (at, pull) => {
        fixRound(at, pull);
        if (at.stage === "code-review" && at.round === 2) Object.assign(pull(), { merged: true, closed: "done" });
      },
    });
    const merged = await run.converge();
    expect(merged.trail).toEqual(["build", "publish", "code-review", "fix-review", "code-review", "done"]);
    expect(merges()).toBe(0);
    expect((await run.converge()).trail).toEqual(["retro"]);
    expect(state.pull("pr-2")).toMatchObject({ branch: "landrace/1-retro", opened: { title: "1: retro lessons", description: undefined } });
  });

  /*
   * Reopened at the retro, the item has nothing left to run there: it is a
   * person's, at `stuck`.
   */
  it("16d. leaves an item reopened at the retro stuck for a person", async () => {
    const { state, run } = road({ during: fixRound });
    await run.converge();
    await run.converge();
    expect(state.stage("1")).toBe("retro");
    state.item("1").closed = null;
    expect((await run.converge()).trail).toEqual(["stuck"]);
    expect(run.counts().retro).toBe(1);
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
      expect(await broken.goto(to)).toEqual({ refused: expect.stringMatching(new RegExp(`"blocked" sends an item to "${to}" only as the Retry`)) });
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
   * is, and the workflow says so itself on the engine's count of pull
   * requests closed unmerged. After a build, the item is stuck instead of
   * publishing: no second pull request is opened, let alone merged. During a
   * review, the item is stuck too, a person's to settle.
   */
  it("10. leaves the item stuck, and opens no second pull request, when a person closed it during a build", async () => {
    const { state, run, pr } = road({
      during: ({ stage, round }, pull) => {
        if (stage === "code-review" && round === 1) red(pull);
        if (stage === "build" && round === 2) pull().closed = "dropped";
      },
    });
    const r = await run.converge();

    expect(run.trail()).toEqual(["build", "publish", "code-review", "ci", "build", "stuck"]);
    expect(r.result.settled).toBe("wait");
    expect(pr()).toMatchObject({ merged: false, closed: "dropped" });
    expect(() => state.pull("pr-2")).toThrow();
    expect(state.item("1").labels).toEqual(expect.arrayContaining(["lr:stage:stuck", "lr:awaiting"]));
    expect(state.item("1").labels).not.toContain("lr:working");
    // No refusal on the way: the kit was never asked to open another.
    expect(state.entriesOf("1").filter((e) => e.kind === "refused" || e.kind === "malformed")).toEqual([]);
  });

  /*
   * A replacement a person opened from the item's branch, beside the one
   * they closed, is them carrying on: the build publishes, its push lands on
   * the open one, and review goes on — no second pull request is opened by
   * landrace, and none is left to stop on.
   */
  it("10b. goes on to publish and review when a person closed the pull request and opened a replacement during a build", async () => {
    let world: ExternalState | undefined;
    const { state, run, pr } = road({
      seed: (s) => { world = s; },
      during: ({ stage, round }, pull) => {
        if (stage === "code-review" && round === 1) red(pull);
        if (stage === "build" && round === 2) {
          pull().closed = "dropped";
          world?.openPull("1", { branch: "landrace/1" });
        }
      },
    });
    const r = await run.converge();

    expect(run.trail().slice(0, 7)).toEqual(["build", "publish", "code-review", "ci", "build", "publish", "code-review"]);
    expect(r.result.settled).toBe("terminal");
    expect(pr()).toMatchObject({ merged: false, closed: "dropped" });
    expect(state.pull("pr-2")).toMatchObject({ branch: "landrace/1", merged: true });
    expect(() => state.pull("pr-3")).toThrow();
    expect(state.item("1").closed).toBe("done");
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
   * outage on the close leaves it at merge, and the next tick closes it.
   * Closed after them, it was left open and done, with nothing left to do
   * that would close it.
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
    expect(state.item("1").labels).toEqual(expect.arrayContaining(["lr:auto", "lr:fast"]));
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
    const gh = createFakeTracker([{ number: 1, labels: ["lr:auto", "lr:fast", "lr:stage:ci"] }]);
    const opened = gh.openPull({ head: "landrace/1", number: 8, headSha: "abc1234", closes: [1], checks: "SUCCESS" });
    // The review that passed it, at the head it read.
    gh.sayAs("yiftahb", 1, `Reviewed.${renderMarker(recordMarker({
      type: "tracker.comment", kind: "output", stage: "code-review", round: 1, marker: "review:1", output: { kind: "reviewed" }, head: "abc1234",
    }))}`);
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
   * The label model: lr:auto is "Landrace manages this item", and lr:fast
   * routes it to fastlane instead of full-cycle. One tick of the whole workspace
   * over one item: carrying both, it is fastlane's alone and starts at build;
   * lr:auto alone, full-cycle's, at spec; lr:fast alone, nobody's, and nothing is
   * written.
   */
  const tickOne = async (labels: string[]) => {
    const state = createExternalState({ items: [{ id: "1", title: "Export", body: "Export as CSV.", labels }] });
    const ran: string[] = [];
    const executor: Executor = { id: "agent", run: async () => { ran.push("ran"); throw new Error("the agent is not here"); } };
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
      dir: root, workflows: listed, preflights: [], intervalMs: 60_000, concurrency: 2, agents: 0, checking: false, asking: [], turnedAway: [], stop,
      running: new Map(), seen: new Map(), log, ctx: runtimeCtx,
    };
    const rows = await tickWorkspace({ runtime, lock: { root } });
    return { state, rows, ran };
  };

  it("9. gives an item labelled lr:auto and lr:fast to fastlane alone, which starts it at build", async () => {
    const { state, rows, ran } = await tickOne(["lr:auto", "lr:fast"]);
    expect(rows).toEqual([expect.objectContaining({ item: "1", workflow: "fastlane" })]);
    expect(ran).toEqual(["ran"]);
    expect(state.item("1").labels).toEqual(expect.arrayContaining(["lr:auto", "lr:fast", "lr:stage:build"]));
  });

  it("9b. admits an item labelled lr:fast alone to neither workflow, fastlane saying it has no lr:auto, writing nothing", async () => {
    const { state, rows, ran } = await tickOne(["lr:fast"]);
    expect(rows).toEqual([{ item: "1", outcome: "skipped: no lr:auto label" }]);
    expect(ran).toEqual([]);
    expect(state.writes()).toEqual([]);
    expect(state.item("1").labels).toEqual(["lr:fast"]);
  });

  it("9c. gives an item labelled lr:auto alone to full-cycle, which starts it at spec", async () => {
    const { state, rows } = await tickOne(["lr:auto"]);
    expect(rows).toEqual([expect.objectContaining({ item: "1", workflow: "full-cycle" })]);
    expect(state.item("1").labels).toEqual(expect.arrayContaining(["lr:auto", "lr:stage:spec"]));
    expect(state.item("1").labels).not.toContain("lr:fast");
  });
});
