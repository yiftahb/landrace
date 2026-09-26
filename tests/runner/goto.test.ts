import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderMarker } from "#conventions.js";
import { createDispatcher } from "#runner/effects.js";
import { sendTo } from "#runner/goto.js";
import { acquire, held, release } from "#runner/lock.js";
import { buildSnapshot } from "#runner/snapshot.js";
import type { GotoDeps, Source, Workflow } from "#namespace.js";
import { createFakeTracker } from "#tests/support/fake-tracker.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lr-goto-"));
});

const ENTER = { type: "tracker.comment", kind: "enter", marker: "enter:{stage}:{round}" };
const workflow: Workflow = { version: 1, name: "t", stages: [
  { id: "spec", entry: true, step: "steps/spec.md", on_enter: [ENTER], triggers: [{ when: { "run.stage": null } }] },
  { id: "build", step: "steps/build.md", on_enter: [ENTER], triggers: [{ when: { "run.stage": "spec" } }] },
  { id: "blocked", goto: ["spec", { stage: "build", when: { "run.counters.build": { $lt: 3 } } }],
    triggers: [{ when: { "run.lastOutputValid": false } }] },
  { id: "judge", step: "steps/judge.md", goto: ["spec"], on_enter: [ENTER],
    triggers: [{ when: { "run.stage": "build" } }] },
  { id: "done", terminal: true, triggers: [{ when: { "run.stage": "blocked", "x": 1 } }] },
] };

const world = (labels: string[]) => {
  const tracker = createFakeTracker([{ number: 3, labels: ["lr:auto", ...labels] }]);
  const source = tracker.registry.source as Source;
  const deps: GotoDeps = {
    source, pre: tracker.registry.pre, dispatcher: createDispatcher(tracker.registry.post), ctx: tracker.ctx, workflow,
    lock: { root },
  };
  const run = async () =>
    (await buildSnapshot({ ticket: "3", source, hooks: tracker.registry.pre, ctx: { ...tracker.ctx, ticket: "3" } })).run;
  const failed = (stage: string, round: number) =>
    tracker.say(3, `broken${renderMarker({ stage, kind: "malformed", round })}`);
  const settled = (stage: string, round: number) => {
    tracker.say(3, `entered${renderMarker({ stage, kind: "enter", round })}`);
    tracker.say(3, `answered${renderMarker({ stage, kind: "output", round })}`);
  };
  const rejected = (stage: string, round: number) => {
    tracker.say(3, `entered${renderMarker({ stage, kind: "enter", round })}`);
    failed(stage, round);
  };
  return { tracker, deps, run, failed, settled, rejected };
};

describe("sending a ticket back to a step", () => {
  it("writes a goto the engine reads back as Landrace's own", async () => {
    const { deps, run } = world(["lr:stage:blocked", "lr:blocked"]);
    expect(await sendTo(deps, "3", "spec")).toEqual({ to: "spec" });
    expect((await run())?.goto).toBe("spec");
  });

  it("retries the stage that failed last when no step is named", async () => {
    const { deps, run, rejected } = world(["lr:stage:blocked", "lr:blocked"]);
    rejected("spec", 1);
    rejected("build", 1);
    expect(await sendTo(deps, "3", null)).toEqual({ to: "build" });
    expect((await run())?.goto).toBe("build");
  });

  // The ordinary conversation at a halt: a question goes through the judge
  // and comes home. That round trip is not what put the ticket here.
  it("retries the failed step after a question at the halt came home from the judge", async () => {
    const { deps, run, rejected, tracker } = world(["lr:stage:blocked", "lr:blocked"]);
    rejected("build", 1);
    tracker.sayAs("someone", 3, "why did it stop?");
    tracker.say(3, `entered${renderMarker({ stage: "judge", kind: "enter", round: 1, from: "blocked" })}`);
    tracker.say(3, `answered${renderMarker({ stage: "judge", kind: "output", round: 1, output: { intent: "question" } })}`);
    expect(await sendTo(deps, "3", null)).toEqual({ to: "build" });
    expect((await run())?.goto).toBe("build");
  });

  it("refuses a retry of an older failure the ticket was since sent around, and writes nothing", async () => {
    // spec failed, a person sent the ticket on to build, and it came back
    // here for another reason. spec is still failed — nothing has run it
    // since — but it is not what put the ticket here, and a Retry that
    // reached back to it would pay for a round nobody asked for.
    const { deps, tracker, rejected, settled } = world(["lr:stage:blocked", "lr:blocked"]);
    rejected("spec", 1);
    settled("build", 1);
    const before = tracker.comments.get(3)?.length ?? 0;
    expect(await sendTo(deps, "3", null)).toEqual({ refused: expect.stringMatching(/nothing has failed on #3/) });
    expect(tracker.comments.get(3)?.length ?? 0).toBe(before);
  });

  it("says so, and writes nothing, when nothing has failed and a retry is asked", async () => {
    const { deps, tracker } = world(["lr:stage:blocked", "lr:blocked"]);
    const before = tracker.comments.get(3)?.length ?? 0;
    expect(await sendTo(deps, "3", null)).toEqual({ refused: expect.stringMatching(/nothing has failed on #3/) });
    expect(tracker.comments.get(3)?.length ?? 0).toBe(before);
  });

  it("refuses a retry once the stage it would retry has since passed", async () => {
    // failedStages (core/derive.ts) drops a rejection the moment a later round
    // of the same stage settles — Retry must answer the same question
    // decide() does, or it could reach back past a success and redo work
    // nothing asked to redo.
    const { deps, tracker, failed, settled } = world(["lr:stage:blocked", "lr:blocked"]);
    failed("spec", 1);
    settled("spec", 2);
    const before = tracker.comments.get(3)?.length ?? 0;
    expect(await sendTo(deps, "3", null)).toEqual({ refused: expect.stringMatching(/nothing has failed on #3/) });
    expect(tracker.comments.get(3)?.length ?? 0).toBe(before);
  });

  it("refuses a step its stage does not send tickets to, naming what it does", async () => {
    const { deps, tracker } = world(["lr:stage:blocked", "lr:blocked"]);
    const before = tracker.comments.get(3)?.length ?? 0;
    expect(await sendTo(deps, "3", "done")).toEqual({ refused: expect.stringMatching(/"blocked".*"spec" or "build".*"done"/) });
    expect(tracker.comments.get(3)?.length ?? 0).toBe(before);
  });

  it("refuses a step past its cap, saying which", async () => {
    const { deps, tracker, failed } = world(["lr:stage:blocked", "lr:blocked"]);
    for (const round of [1, 2, 3]) failed("build", round);
    const before = tracker.comments.get(3)?.length ?? 0;
    expect(await sendTo(deps, "3", "build")).toEqual({ refused: expect.stringMatching(/run\.counters\.build/) });
    expect(tracker.comments.get(3)?.length ?? 0).toBe(before);
  });

  it("refuses a stage that runs a step while that step's round is still owed", async () => {
    const { deps, tracker } = world(["lr:stage:build", "lr:working"]);
    const before = tracker.comments.get(3)?.length ?? 0;
    expect(await sendTo(deps, "3", "spec")).toEqual({ refused: expect.stringMatching(/"build".*still to run/) });
    expect(tracker.comments.get(3)?.length ?? 0).toBe(before);
  });

  it("accepts a goto at a stepped stage once its own round has settled", async () => {
    // A judge sits at its own stage, step and all, once its verdict has
    // landed — no agent left at work there, so a goto must be allowed to land.
    const { deps, run, settled } = world(["lr:stage:judge"]);
    settled("judge", 1);
    expect(await sendTo(deps, "3", "spec")).toEqual({ to: "spec" });
    expect((await run())?.goto).toBe("spec");
  });

  it("accepts a goto at a stepped stage whose latest round was rejected", async () => {
    // entered > output is true here too — the rejection produced no output —
    // and the old rule refused this. assess() calls it "failed", not
    // "pending" (a rejection is checked first), and a rejected round has no
    // agent left at work either: this is exactly the judge-recovery case the
    // brief's own rule change exists for.
    const { deps, run, rejected } = world(["lr:stage:judge"]);
    rejected("judge", 1);
    expect(await sendTo(deps, "3", "spec")).toEqual({ to: "spec" });
    expect((await run())?.goto).toBe("spec");
  });

  /*
   * Read, decide, write: a tick moving the ticket between the read and the
   * write would leave a goto recorded against a stage the ticket has left,
   * which reads as consumed — after the page had already said "sent".
   */
  it("refuses, and writes nothing, while something else holds the ticket", async () => {
    const { deps, tracker, run } = world(["lr:stage:blocked", "lr:blocked"]);
    await acquire("3", "tick", { root, holder: "tick:9" });
    try {
      const before = tracker.comments.get(3)?.length ?? 0;
      expect(await sendTo({ ...deps, lock: { root, waitMs: 50 } }, "3", "spec")).toEqual({
        refused: "#3 is busy; try again in a moment",
      });
      expect(tracker.comments.get(3)?.length ?? 0).toBe(before);
    } finally {
      await release("3", { root });
    }
    expect(await sendTo(deps, "3", "spec")).toEqual({ to: "spec" });
    expect((await run())?.goto).toBe("spec");
  });

  it("gives the ticket's lock back, whether it sent the ticket or refused", async () => {
    const { deps } = world(["lr:stage:blocked", "lr:blocked"]);
    expect(await sendTo(deps, "3", "spec")).toEqual({ to: "spec" });
    expect(await held("3", { root })).toBeNull();
    expect(await sendTo(deps, "3", "done")).toHaveProperty("refused");
    expect(await held("3", { root })).toBeNull();
  });

  // decide() skips a ticket the workflow's `eligible` rules turn away before
  // it reads anything else, so a goto written there would sit unread.
  it("refuses, with the workflow's own reason, a ticket its eligible rules skip", async () => {
    const eligible: Workflow = {
      ...workflow, eligible: [{ when: { "node.state.labels": { $in: ["lr:auto"] } }, else: "no lr:auto label" }],
    };
    const tracker = createFakeTracker([{ number: 13, labels: ["lr:stage:blocked", "lr:blocked"] }]);
    const deps: GotoDeps = {
      source: tracker.registry.source as Source, pre: tracker.registry.pre,
      dispatcher: createDispatcher(tracker.registry.post), ctx: tracker.ctx, workflow: eligible, lock: { root },
    };
    const before = tracker.comments.get(13)?.length ?? 0;
    expect(await sendTo(deps, "13", "spec")).toEqual({ refused: expect.stringMatching(/#13 .*no lr:auto label/) });
    expect(tracker.comments.get(13)?.length ?? 0).toBe(before);
  });

  it("refuses a ticket it cannot place", async () => {
    const { deps, tracker } = world(["lr:stage:blocked", "lr:stage:spec"]);
    const before = tracker.comments.get(3)?.length ?? 0;
    expect(await sendTo(deps, "3", "spec")).toEqual({ refused: expect.stringMatching(/cannot be placed/) });
    expect(tracker.comments.get(3)?.length ?? 0).toBe(before);
  });

  it("names every stage it matches, rather than refusing to place it at all", async () => {
    // Two stages whose identity both read the one label a ticket may carry:
    // ambiguous, and locate() already says which — the refusal should too.
    const ambiguous: Workflow = { version: 1, name: "t", stages: [
      { id: "blocked", identity: { "run.stage": "blocked" }, goto: ["spec"] },
      { id: "blocked-too", identity: { "run.stage": "blocked" }, goto: ["spec"] },
      { id: "spec", entry: true, triggers: [{ when: { "run.stage": null } }] },
    ] };
    const tracker = createFakeTracker([{ number: 11, labels: ["lr:auto", "lr:stage:blocked"] }]);
    const source = tracker.registry.source as Source;
    const deps: GotoDeps = {
      source, pre: tracker.registry.pre, dispatcher: createDispatcher(tracker.registry.post), ctx: tracker.ctx,
      workflow: ambiguous, lock: { root },
    };
    expect(await sendTo(deps, "11", "spec")).toEqual({
      refused: expect.stringMatching(/matches more than one stage.*blocked.*blocked-too/s),
    });
  });

  it("refuses a goto at a stage matched only by a custom identity foreign to the label", async () => {
    // deriveRun scopes a goto record to the *label* stage, never locate()'s —
    // writing one here would be silently dropped on the very next read.
    const custom: Workflow = { version: 1, name: "t", stages: [
      { id: "weird", identity: { "node.priority": 5 }, goto: ["spec"] },
      { id: "spec", entry: true, triggers: [{ when: { "run.stage": null } }] },
    ] };
    const tracker = createFakeTracker([{ number: 9, labels: ["lr:auto", "lr:stage:elsewhere", "P5"] }]);
    const source = tracker.registry.source as Source;
    const deps: GotoDeps = {
      source, pre: tracker.registry.pre, dispatcher: createDispatcher(tracker.registry.post), ctx: tracker.ctx, workflow: custom, lock: { root },
    };
    const before = tracker.comments.get(9)?.length ?? 0;
    expect(await sendTo(deps, "9", "spec")).toEqual({
      refused: expect.stringMatching(/"weird".*custom identity.*"elsewhere"/s),
    });
    expect(tracker.comments.get(9)?.length ?? 0).toBe(before);
  });

  it("refuses a goto at a stage whose own precondition does not hold", async () => {
    const gated: Workflow = { version: 1, name: "t", stages: [
      { id: "blocked", requires: { "run.unblockedAt": { $gt: 0 } }, goto: ["spec"] },
      { id: "spec", entry: true, triggers: [{ when: { "run.stage": null } }] },
    ] };
    const tracker = createFakeTracker([{ number: 12, labels: ["lr:auto", "lr:stage:blocked"] }]);
    const source = tracker.registry.source as Source;
    const deps: GotoDeps = {
      source, pre: tracker.registry.pre, dispatcher: createDispatcher(tracker.registry.post), ctx: tracker.ctx, workflow: gated, lock: { root },
    };
    const before = tracker.comments.get(12)?.length ?? 0;
    expect(await sendTo(deps, "12", "spec")).toEqual({
      refused: expect.stringMatching(/#12 is halted at "blocked": its precondition does not hold/),
    });
    expect(tracker.comments.get(12)?.length ?? 0).toBe(before);
  });
});
