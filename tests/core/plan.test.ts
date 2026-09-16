import { planEffects } from "#core/plan.js";
import { reconcile } from "#core/reconcile.js";
import type { Decision, Effect, Snapshot, Stage } from "#namespace.js";

const target: Stage = {
  id: "review",
  on_enter: [
    { type: "tracker.label", add: ["lr:working"] },
    { type: "tracker.comment", marker: "ready:1", body: "hi" },
  ],
};

describe("planEffects", () => {
  it("plans the effects of the state being entered", () => {
    const d: Decision = { action: "transition", to: target, round: 1 };
    expect(planEffects(d)).toEqual([
      { type: "tracker.label", add: ["lr:working"], stage: "review", round: 1 },
      { type: "tracker.comment", marker: "ready:1", body: "hi", stage: "review", round: 1 },
    ]);
  });

  describe("the round of the entry being planned", () => {
    const looping: Stage = {
      id: "code-review",
      on_enter: [{ type: "tracker.comment", kind: "enter", marker: "enter:{stage}:{round}", body: "Round {round}." }],
    };

    /*
     * Without this the entry record for round 2 would carry round 1's marker,
     * the post hook's satisfied() would find round 1's comment already
     * posted, reconcile would drop the effect — and the stage would never
     * record that it had been entered a second time.
     */
    it("fills {round} and {stage} in from the decision, not from the workflow file", () => {
      const planned = planEffects({ action: "transition", to: looping, round: 3 });
      expect(planned).toEqual([{
        type: "tracker.comment", kind: "enter", stage: "code-review", round: 3,
        marker: "enter:code-review:3", body: "Round 3.",
      }]);
    });

    it("numbers an entry with no round on the decision as the first", () => {
      expect(planEffects({ action: "transition", to: looping })[0]).toMatchObject({ round: 1, marker: "enter:code-review:1" });
    });

    /*
     * The same rule step.ts applies to a route's effect fields: an effect is
     * structure, not prose. A body is attacker-controlled text once a ticket
     * title or comment can reach it, and a marker assembled from one is a
     * forged control token.
     */
    it("substitutes nothing but the round and the stage, so ticket content cannot reach an effect field", () => {
      const nosy: Stage = {
        id: "s",
        on_enter: [{ type: "tracker.comment", body: "{ticket.body} {run.stage} {outputs.spec.title} {toString}" }],
      };
      expect(planEffects({ action: "transition", to: nosy, round: 1 })[0]?.body)
        .toBe("{ticket.body} {run.stage} {outputs.spec.title} {toString}");
    });

    it("leaves an authored stage or round alone rather than overwriting it", () => {
      const authored: Stage = { id: "s", on_enter: [{ type: "tracker.comment", stage: "other", round: 9 }] };
      expect(planEffects({ action: "transition", to: authored, round: 2 })[0])
        .toEqual({ type: "tracker.comment", stage: "other", round: 9 });
    });

    it("leaves a non-string field untouched", () => {
      const mixed: Stage = { id: "s", on_enter: [{ type: "tracker.label", add: ["lr:working"], n: 2, ok: true }] };
      expect(planEffects({ action: "transition", to: mixed, round: 1 })[0])
        .toMatchObject({ add: ["lr:working"], n: 2, ok: true });
    });
  });

  it("plans nothing while waiting", () => {
    expect(planEffects({ action: "wait" })).toEqual([]);
  });

  it("plans nothing when skipped — a skipped ticket must not be written to", () => {
    expect(planEffects({ action: "skip", why: "no lr:auto label" })).toEqual([]);
  });

  it("plans nothing for an invoke, which the runner performs directly", () => {
    expect(planEffects({ action: "invoke", step: "s.md", round: 1 })).toEqual([]);
  });
});

describe("reconcile", () => {
  const snap = {} as Snapshot;
  const satisfied = (_s: Snapshot, e: Effect) => e.type === "tracker.label";

  it("drops effects the externals already satisfy", () => {
    const effects: Effect[] = [
      { type: "tracker.label", add: ["lr:working"] },
      { type: "tracker.comment", marker: "ready:1" },
    ];
    expect(reconcile(snap, effects, satisfied)).toEqual([{ type: "tracker.comment", marker: "ready:1" }]);
  });

  it("is a no-op on a settled state, which is what makes a re-tick free", () => {
    expect(reconcile(snap, [{ type: "tracker.label" }], satisfied)).toEqual([]);
  });

  it("preserves order for what survives", () => {
    const effects: Effect[] = [{ type: "a" }, { type: "b" }];
    expect(reconcile(snap, effects, () => false)).toEqual(effects);
  });
});
