import { planEffects } from "../../src/core/plan.js";
import { reconcile } from "../../src/core/reconcile.js";
import type { Decision, Effect, Snapshot, Stage } from "../../src/core/types.js";

const target: Stage = {
  id: "review",
  on_enter: [
    { type: "tracker.label", add: ["lr:working"] },
    { type: "tracker.comment", marker: "ready:1", body: "hi" },
  ],
};

describe("planEffects", () => {
  it("plans the effects of the state being entered", () => {
    const d: Decision = { action: "transition", to: target };
    expect(planEffects(d)).toEqual(target.on_enter);
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
