import { renderMarker } from "#conventions.js";
import { createDispatcher } from "#runner/effects.js";
import { sendTo } from "#runner/goto.js";
import { buildSnapshot } from "#runner/snapshot.js";
import type { GotoDeps, Source, Workflow } from "#namespace.js";
import { createFakeTracker } from "#tests/support/fake-tracker.js";

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
  };
  const run = async () =>
    (await buildSnapshot({ ticket: "3", source, hooks: tracker.registry.pre, ctx: { ...tracker.ctx, ticket: "3" } })).run;
  const failed = (stage: string, round: number) =>
    tracker.say(3, `broken${renderMarker({ stage, kind: "malformed", round })}`);
  const settled = (stage: string, round: number) => {
    tracker.say(3, `entered${renderMarker({ stage, kind: "enter", round })}`);
    tracker.say(3, `answered${renderMarker({ stage, kind: "output", round })}`);
  };
  return { tracker, deps, run, failed, settled };
};

describe("sending a ticket back to a step", () => {
  it("writes a goto the engine reads back as Landrace's own", async () => {
    const { deps, run } = world(["lr:stage:blocked", "lr:blocked"]);
    expect(await sendTo(deps, "3", "spec")).toEqual({ to: "spec" });
    expect((await run())?.goto).toBe("spec");
  });

  it("retries the stage that failed last when no step is named", async () => {
    const { deps, run, failed } = world(["lr:stage:blocked", "lr:blocked"]);
    failed("spec", 1);
    failed("build", 1);
    expect(await sendTo(deps, "3", null)).toEqual({ to: "build" });
    expect((await run())?.goto).toBe("build");
  });

  it("says so, and writes nothing, when nothing has failed and a retry is asked", async () => {
    const { deps, tracker } = world(["lr:stage:blocked", "lr:blocked"]);
    const before = tracker.comments.get(3)?.length ?? 0;
    expect(await sendTo(deps, "3", null)).toEqual({ refused: expect.stringMatching(/nothing has failed on #3/) });
    expect(tracker.comments.get(3)?.length ?? 0).toBe(before);
  });

  it("refuses a step its stage does not send tickets to, naming what it does", async () => {
    const { deps } = world(["lr:stage:blocked", "lr:blocked"]);
    expect(await sendTo(deps, "3", "done")).toEqual({ refused: expect.stringMatching(/"blocked".*"spec" or "build".*"done"/) });
  });

  it("refuses a step past its cap, saying which", async () => {
    const { deps, failed } = world(["lr:stage:blocked", "lr:blocked"]);
    for (const round of [1, 2, 3]) failed("build", round);
    expect(await sendTo(deps, "3", "build")).toEqual({ refused: expect.stringMatching(/run\.counters\.build/) });
  });

  it("refuses a stage that runs a step while that step's round is still owed", async () => {
    const { deps } = world(["lr:stage:build", "lr:working"]);
    expect(await sendTo(deps, "3", "spec")).toEqual({ refused: expect.stringMatching(/"build".*still to run/) });
  });

  it("accepts a goto at a stepped stage once its own round has settled", async () => {
    // A judge sits at its own stage, step and all, once its verdict has
    // landed — no agent left at work there, so a goto must be allowed to land.
    const { deps, run, settled } = world(["lr:stage:judge"]);
    settled("judge", 1);
    expect(await sendTo(deps, "3", "spec")).toEqual({ to: "spec" });
    expect((await run())?.goto).toBe("spec");
  });

  it("refuses a ticket it cannot place", async () => {
    const { deps } = world(["lr:stage:blocked", "lr:stage:spec"]);
    expect(await sendTo(deps, "3", "spec")).toEqual({ refused: expect.stringMatching(/cannot be placed/) });
  });
});
