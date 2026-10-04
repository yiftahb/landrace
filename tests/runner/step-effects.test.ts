import { routeEffects, settleOutput } from "#runner/step.js";
import type { Step, StepResult } from "#namespace.js";

type Ok = Extract<StepResult, { ok: true }>;

/*
 * A support desk's diagnosis, in one round: a public reply and an internal
 * note from two fields of the answer, then the record that settles the round.
 */
const diagnose: Step = {
  prompt: "diagnose",
  output: {
    discriminator: "kind",
    shapes: { answered: { reply: "string", note: "string", count: "number" } },
    routes: [{
      when: { kind: "answered" },
      goto: "wait",
      effects: [
        { type: "tracker.comment", from: "reply" },
        { type: "tracker.comment", from: "note", internal: true },
        { type: "tracker.comment" },
      ],
    }],
  },
};

const settle = (text: string, step: Step = diagnose) =>
  settleOutput({ step, item: "7", stageId: "diagnose", round: 2, text, sessionId: "sid", by: "agent", head: "abc" });

const answer = (value: Record<string, unknown>, prose = "Prose for the record.") =>
  `${prose}\n\n\`\`\`json\n${JSON.stringify({ kind: "answered", ...value })}\n\`\`\``;

describe("a route with effects", () => {
  it("plans each effect in order, marked as its part, and the output record last", () => {
    const r = settle(answer({ reply: "Try restarting.", note: "Known bug in 4.2" })) as Ok;
    expect(r.ok).toBe(true);
    expect(r.effects).toHaveLength(4);
    expect(r.effects.slice(0, 3)).toEqual([
      expect.objectContaining({ type: "tracker.comment", kind: "part", marker: "part:diagnose:2:0", stage: "diagnose", round: 2, body: "Try restarting." }),
      expect.objectContaining({ type: "tracker.comment", kind: "part", marker: "part:diagnose:2:1", body: "Known bug in 4.2", internal: true }),
      expect.objectContaining({ type: "tracker.comment", kind: "part", marker: "part:diagnose:2:2", body: "Prose for the record." }),
    ]);
    expect(r.effects[3]).toMatchObject({
      type: "tracker.comment", kind: "output", stage: "diagnose", round: 2, marker: "output:diagnose:2",
      output: { kind: "answered", reply: "Try restarting.", note: "Known bug in 4.2" }, goto: "wait", session: "sid", head: "abc",
    });
  });

  it("strips from, a field only the engine writes on a record", () => {
    const r = settle(answer({ reply: "a", note: "b" })) as Ok;
    for (const e of r.effects) expect(e).not.toHaveProperty("from");
  });

  it("puts the engine's own bookkeeping on the record alone", () => {
    const r = settle(answer({ reply: "a", note: "b" })) as Ok;
    for (const e of r.effects.slice(0, 3)) {
      expect(e).not.toHaveProperty("goto");
      expect(e).not.toHaveProperty("session");
      expect(e).not.toHaveProperty("head");
    }
  });

  it("refuses an answer missing a field an effect takes its body from, as a broken contract", () => {
    const r = settle(answer({ reply: "a" }));
    expect(r).toMatchObject({ ok: false, kind: "contract" });
    expect(r.ok === false && r.reason).toMatch(/effect 1 takes its body from "note", which the output does not carry as a string/);
  });

  it("refuses a field that is there but not a string", () => {
    const step: Step = {
      ...diagnose,
      output: { ...diagnose.output!, routes: [{ when: { kind: "answered" }, effects: [{ type: "tracker.comment", from: "count" }] }] },
    };
    const r = settle(answer({ count: 3 }), step);
    expect(r).toMatchObject({ ok: false, kind: "contract" });
    expect(r.ok === false && r.reason).toMatch(/takes its body from "count"/);
  });

  it("refuses a field the shape never declared, which never travels", () => {
    const step: Step = {
      ...diagnose,
      output: { ...diagnose.output!, routes: [{ when: { kind: "answered" }, effects: [{ type: "tracker.comment", from: "secret" }] }] },
    };
    expect(settle(answer({ secret: "x" }), step)).toMatchObject({ ok: false, kind: "contract" });
  });

  it("refuses a part's prose a record cannot carry", () => {
    // The prose, which the third effect carries: a field that long is refused
    // sooner, as an output value no marker can carry.
    const r = settle(answer({ reply: "a", note: "b" }, "x".repeat(40_000)));
    expect(r).toMatchObject({ ok: false, kind: "contract" });
    expect(r.ok === false && r.reason).toMatch(/effect 2's body is \d+ characters once escaped/);
  });

  it("marks every part, whatever kind or marker the route wrote", () => {
    const step: Step = {
      ...diagnose,
      output: {
        ...diagnose.output!,
        routes: [{ when: { kind: "answered" }, effects: [{ type: "tracker.comment", kind: "output", marker: "mine", stage: "elsewhere" }] }],
      },
    };
    const r = settle(answer({}), step) as Ok;
    expect(r.effects[0]).toMatchObject({ kind: "part", marker: "part:diagnose:2:0", stage: "diagnose" });
  });

  it("hands an effect off the tracker the output, as one effect would be", () => {
    const step: Step = {
      ...diagnose,
      output: {
        ...diagnose.output!,
        routes: [{ when: { kind: "answered" }, effects: [{ type: "tracker.create", project: "ENG", title: "Bug on {item}", from: "note" }] }],
      },
    };
    const r = settle(answer({ note: "Stack trace" }), step) as Ok;
    expect(r.effects[0]).toMatchObject({
      type: "tracker.create", project: "ENG", title: "Bug on 7", body: "Stack trace", marker: "part:diagnose:2:0",
      output: { kind: "answered", note: "Stack trace" },
    });
  });
});

describe("routeEffects", () => {
  it("is the one effect of a route that names one, and the list of one that names several", () => {
    expect(routeEffects({ when: {}, effect: { type: "a" } })).toEqual([{ type: "a" }]);
    expect(routeEffects({ when: {}, effects: [{ type: "a" }, { type: "b" }] })).toEqual([{ type: "a" }, { type: "b" }]);
  });
});
