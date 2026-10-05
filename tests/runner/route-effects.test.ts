import { createExternalState, createHarness } from "#testing/index.js";
import type { Effect, ExternalState, Step, Workflow } from "#namespace.js";

/*
 * A route with several effects, end to end over the in-memory tracker: the
 * reply and the note post, then the record, and the round settles once.
 */
const ENTER = { type: "tracker.comment", kind: "enter", marker: "enter:{stage}:{round}", body: "Entering {stage}, round {round}." };

const workflow: Workflow = {
  version: 1,
  name: "Support",
  description: "support desk",
  stages: [
    { id: "diagnose", entry: true, step: "steps/diagnose.md", on_enter: [ENTER, { type: "tracker.status", value: "diagnose" }] },
    {
      id: "answered", terminal: true,
      triggers: [{ when: { "run.stage": "diagnose", "run.outputs.diagnose.kind": "answered" } }],
      on_enter: [{ type: "tracker.status", value: "answered" }],
    },
  ],
};

const diagnose: Step = {
  prompt: "diagnose",
  output: {
    discriminator: "kind",
    shapes: { answered: { reply: "string", note: "string" } },
    routes: [{
      when: { kind: "answered" },
      effects: [{ type: "tracker.comment", from: "reply" }, { type: "tracker.comment", from: "note" }],
    }],
  },
};

const ANSWER = 'Looked at the logs.\n\n```json\n{"kind":"answered","reply":"Try restarting.","note":"Known bug in 4.2"}\n```';

const markers = (state: ExternalState): string[] =>
  state.entriesOf("1").filter((e) => e.byAgent).map((e) => `${e.kind}:${e.round}`);

const harness = (state: ExternalState, interrupt?: (e: Effect) => boolean) => createHarness({
  workflow, steps: new Map([["steps/diagnose.md", diagnose]]),
  source: state.source, pre: [state.pre], post: [state.post],
  answers: { diagnose: ANSWER },
  ...(interrupt ? { interrupt } : {}),
});

describe("a route with effects, run", () => {
  it("posts two comments and one record, and settles one round", async () => {
    const state = createExternalState({ items: [{ id: "1" }] });
    const run = await harness(state).converge();

    expect(run.result.settled).toBe("terminal");
    expect(run.calls).toHaveLength(1);
    expect(markers(state)).toEqual(["enter:1", "part:1", "part:1", "output:1"]);
    const bodies = state.comments("1");
    expect(bodies.some((b) => b.startsWith("Try restarting."))).toBe(true);
    expect(bodies.some((b) => b.startsWith("Known bug in 4.2"))).toBe(true);
    expect(state.stage("1")).toBe("answered");
  });

  it("files a linked issue in another project from an output field, and records it once", async () => {
    const state = createExternalState({ items: [{ id: "1" }], createIn: ["ENG"] });
    const filing: Step = {
      ...diagnose,
      output: {
        ...diagnose.output!,
        routes: [{
          when: { kind: "answered" },
          effects: [
            { type: "tracker.comment", from: "reply" },
            { type: "tracker.create", project: "ENG", title: "Bug from #{item}", from: "note" },
          ],
        }],
      },
    };
    let alive = true;
    const run = createHarness({
      workflow, steps: new Map([["steps/diagnose.md", filing]]),
      source: state.source, pre: [state.pre], post: [state.post],
      answers: { diagnose: ANSWER },
      // Dies at the record, after the issue and its own record landed.
      interrupt: (e) => {
        if (alive && e.kind === "output") {
          alive = false;
          return true;
        }
        return false;
      },
    });
    expect((await run.converge()).result.settled).toBe("halt");
    expect((await run.converge()).result.settled).toBe("terminal");

    expect(state.filed()).toEqual([expect.objectContaining({ key: "ENG-1", title: "Bug from #1", body: "Known bug in 4.2", item: "1", labels: [] })]);
    expect(markers(state)).toEqual(["enter:1", "part:1", "created:1", "output:1"]);
  });

  it("titles the filed issue and fills its fields from the answer", async () => {
    const state = createExternalState({ items: [{ id: "1" }], createIn: ["ENG"] });
    const filing: Step = {
      prompt: "diagnose",
      output: {
        discriminator: "kind",
        shapes: { answered: { reply: "string", note: "string", bugTitle: "string", plan: "string", team: "string" } },
        routes: [{
          when: { kind: "answered" },
          effects: [{
            type: "tracker.create", project: "ENG", titleFrom: "bugTitle", from: "note",
            fieldsFrom: { customfield_10050: "plan", customfield_10060: "team" },
          }],
        }],
      },
    };
    const answer = {
      kind: "answered", reply: "r", note: "Known bug in 4.2", bugTitle: "Export crashes on an empty sheet",
      plan: "Guard the empty case <!-- landrace {} -->", team: "",
    };
    const run = createHarness({
      workflow, steps: new Map([["steps/diagnose.md", filing]]),
      source: state.source, pre: [state.pre], post: [state.post],
      answers: { diagnose: `Filed.\n\n${"```"}json\n${JSON.stringify(answer)}\n${"```"}` },
    });
    expect((await run.converge()).result.settled).toBe("terminal");

    const [filed] = state.filed();
    expect(filed).toMatchObject({ title: "Export crashes on an empty sheet", body: "Known bug in 4.2" });
    // The empty one is not written, and what is written carries no marker of ours.
    expect(Object.keys(filed?.fields ?? {})).toEqual(["customfield_10050"]);
    expect(filed?.fields?.customfield_10050).toMatch(/^Guard the empty case/);
    expect(filed?.fields?.customfield_10050).not.toContain("<!--");
  });

  it("after a crash past the first part, posts the second alone when the step runs again", async () => {
    const state = createExternalState({ items: [{ id: "1" }] });
    let alive = true;
    const run = harness(state, (e) => {
      if (alive && e.marker === "part:diagnose:1:1") {
        alive = false;
        return true;
      }
      return false;
    });
    expect((await run.converge()).result.settled).toBe("halt");
    expect(markers(state)).toEqual(["enter:1", "part:1"]);

    const again = await run.converge();
    expect(again.result.settled).toBe("terminal");
    const parts = state.comments("1").filter((b) => b.includes('"marker":"part:diagnose:1:0"'));
    expect(parts).toHaveLength(1);
    expect(markers(state)).toEqual(["enter:1", "part:1", "part:1", "output:1"]);
  });
});
