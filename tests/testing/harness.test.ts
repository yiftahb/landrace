import { createExternalState, createHarness, scriptedExecutor } from "#testing/index.js";
import { loadWorkflow } from "#workflow/load.js";
import type { Harness, ScriptedAnswer } from "#namespace.js";

/**
 * The harness itself, asked the questions a workflow author would trip over
 * first. Everything here used to be hand-rolled in whichever test file needed
 * it, which is why it is worth a test of its own: a shared helper that lies
 * quietly is worse than three copies that each lie differently.
 */
const SPEC = '# The spec\n\nDo it.\n\n```json\n{"kind":"spec","title":"T"}\n```';

async function harness(answers: Record<string, ScriptedAnswer>): Promise<Harness> {
  const state = createExternalState({ tickets: [{ id: "1", labels: ["lr:auto"] }] });
  const { workflow, steps } = await loadWorkflow("tests/fixtures/minimal");
  return createHarness({ workflow, steps, source: state.source, pre: [state.pre], post: [state.post], answers });
}

describe("the scripted executor", () => {
  it("answers as the stage the engine is actually in, not as one it guessed from the prompt", async () => {
    let at = { stage: "spec", round: 1 };
    const executor = scriptedExecutor({ spec: "from spec", triage: "from triage" }, () => at);
    const opts = { round: 1, signal: new AbortController().signal };

    expect((await executor.run("Write the spec for X.", opts)).text).toBe("from spec");
    at = { stage: "triage", round: 1 };
    // The prompt still says "spec" all over it; the engine says triage.
    expect((await executor.run("Read the reply to the spec.", opts)).text).toBe("from triage");
  });

  it("is handed the round, because a looping stage answers differently the second time", async () => {
    const at = { stage: "spec", round: 2 };
    const executor = scriptedExecutor({ spec: (round) => `round ${round}` }, () => at);

    expect((await executor.run("", { round: 2, signal: new AbortController().signal })).text).toBe("round 2");
  });

  /*
   * Loud and named. A default answer would be a step that "ran" and produced
   * something nobody wrote — which is the one thing a scripted executor exists
   * to rule out, and it would show up as a workflow bug somewhere else.
   */
  it("names the stage it has nothing scripted for, and what it does have", async () => {
    const executor = scriptedExecutor({ triage: "x" }, () => ({ stage: "spec", round: 1 }));

    await expect(executor.run("", { round: 1, signal: new AbortController().signal }))
      .rejects.toThrow(/nothing is scripted for stage "spec".*"triage"/);
  });
});

describe("what the harness writes down", () => {
  it("counts each stage's invocations and keeps the prompt each one was sent", async () => {
    const run = await harness({ spec: SPEC });
    await run.converge();

    expect(run.counts()).toEqual({ spec: 1 });
    expect(run.calls()).toMatchObject([{ stage: "spec", round: 1 }]);
    // Rendered, not the template: what the harness writes down is what the
    // agent was actually sent.
    expect(run.calls()[0]?.prompt.trim()).toBe("Write the spec for ticket 1.");
  });

  /*
   * The trail is read off the events rather than off the tracker, which is
   * what lets it work for a tracker the engine has never heard of — and the
   * destination is the half that makes the stage a ticket *ended* in visible.
   */
  it("draws the trail across several calls, collapsing the stage a call resumes at", async () => {
    const run = await harness({ spec: SPEC });
    const first = await run.converge();
    const second = await run.converge();

    expect(first.trail).toEqual(["spec", "done"]);
    expect(second.trail).toEqual([]);
    expect(run.trail()).toEqual(["spec", "done"]);
  });
});
