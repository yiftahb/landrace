import { planEffects, stageBranch } from "#core/plan.js";
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
    expect(planEffects(d, {}, "1")).toEqual([
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
      const planned = planEffects({ action: "transition", to: looping, round: 3 }, {}, "1");
      expect(planned).toEqual([{
        type: "tracker.comment", kind: "enter", stage: "code-review", round: 3,
        marker: "enter:code-review:3", body: "Round 3.",
      }]);
    });

    it("numbers an entry with no round on the decision as the first", () => {
      expect(planEffects({ action: "transition", to: looping }, {}, "1")[0]).toMatchObject({ round: 1, marker: "enter:code-review:1" });
    });

    /*
     * The same rule step.ts applies to a route's effect fields: an effect is
     * structure, not prose. A body is attacker-controlled text once a ticket
     * title or comment can reach it, and a marker assembled from one is a
     * forged control token.
     */
    it("substitutes nothing but the round, the stage and the ticket id, so ticket content cannot reach an effect field", () => {
      const nosy: Stage = {
        id: "s",
        on_enter: [{ type: "tracker.comment", body: "{ticket.body} {run.stage} {outputs.spec.title} {toString}" }],
      };
      expect(planEffects({ action: "transition", to: nosy, round: 1 }, {}, "1")[0]?.body)
        .toBe("{ticket.body} {run.stage} {outputs.spec.title} {toString}");
    });

    /*
     * The ticket's id is the engine's own identity for what it is acting on —
     * a lock name, a worktree, a branch — and it has passed ticketIdProblem
     * before anything is planned for it. It is the one piece of the ticket an
     * effect may name, and it arrives as an argument rather than out of the
     * snapshot, so the snapshot's own text stays unreachable even when it
     * spells an id of its own.
     */
    it("fills {ticket} from the ticket being acted on, and still nothing from the snapshot", () => {
      const pushing: Stage = {
        id: "publish",
        on_enter: [{ type: "branch.push", branch: "landrace/{ticket}", note: "{node.id} {ticket.title} {node.title}" }],
      };
      const snapshot = {
        node: { id: "999", title: "evil/{ticket}" },
        ticket: { title: "hostile", body: "{ticket}" },
      } as unknown as Snapshot;
      expect(planEffects({ action: "transition", to: pushing, round: 1 }, snapshot, "7")[0]).toEqual({
        type: "branch.push", branch: "landrace/7", note: "{node.id} {ticket.title} {node.title}",
        stage: "publish", round: 1,
      });
    });

    it("leaves {ticket} visible when there is no ticket to name", () => {
      const pushing: Stage = { id: "p", on_enter: [{ type: "branch.push", branch: "landrace/{ticket}" }] };
      expect(planEffects({ action: "transition", to: pushing, round: 1 }, {}, null)[0]?.branch).toBe("landrace/{ticket}");
    });

    it("leaves an authored stage or round alone rather than overwriting it", () => {
      const authored: Stage = { id: "s", on_enter: [{ type: "tracker.comment", stage: "other", round: 9 }] };
      expect(planEffects({ action: "transition", to: authored, round: 2 }, {}, "1")[0])
        .toEqual({ type: "tracker.comment", stage: "other", round: 9 });
    });

    it("leaves a non-string field untouched", () => {
      const mixed: Stage = { id: "s", on_enter: [{ type: "tracker.label", add: ["lr:working"], n: 2, ok: true }] };
      expect(planEffects({ action: "transition", to: mixed, round: 1 }, {}, "1")[0])
        .toMatchObject({ add: ["lr:working"], n: 2, ok: true });
    });
  });

  it("plans nothing while waiting", () => {
    expect(planEffects({ action: "wait" }, {}, "1")).toEqual([]);
  });

  it("plans nothing when skipped — a skipped ticket must not be written to", () => {
    expect(planEffects({ action: "skip", why: "no lr:auto label" }, {}, "1")).toEqual([]);
  });

  it("plans nothing for an invoke, which the runner performs directly", () => {
    expect(planEffects({ action: "invoke", step: "s.md", round: 1 }, {}, "1")).toEqual([]);
  });
});

/*
 * The branch a stage's steps work on: named by the workflow, per stage, from
 * what the engine itself knows about this invocation and nothing else.
 */
describe("stageBranch", () => {
  const building: Stage = { id: "build", step: "steps/build.md", branch: "landrace/{ticket}" };

  it("names no branch for a stage that declares none", () => {
    expect(stageBranch({ id: "spec", step: "steps/spec.md" }, "1", 1)).toEqual({ ok: true, branch: null });
  });

  it("fills in the ticket, the stage and the round", () => {
    expect(stageBranch(building, "42", 1)).toEqual({ ok: true, branch: "landrace/42" });
    expect(stageBranch({ ...building, branch: "{stage}/{ticket}-r{round}" }, "PROJ-7", 3))
      .toEqual({ ok: true, branch: "build/PROJ-7-r3" });
  });

  /*
   * `{ticket.title}` is snapshot content, and a branch is argv for git. Left
   * in place it would still be a legal ref — git accepts braces — so it is
   * refused by name instead of by shape.
   */
  it("refuses any other name, rather than leaving it in the branch", () => {
    const r = stageBranch({ ...building, branch: "landrace/{ticket.title}" }, "1", 1);
    expect(r).toMatchObject({ ok: false });
    expect(r.ok ? "" : r.reason).toMatch(/\{ticket\.title\}/);
  });

  /*
   * A valid ticket id is not always a valid ref: "a..b" is a fine id and no
   * branch at all. Refused with the ticket named, before git is asked.
   */
  it("refuses a name git would refuse, saying which ticket made it", () => {
    const r = stageBranch(building, "a..b", 1);
    expect(r).toMatchObject({ ok: false });
    expect(r.ok ? "" : r.reason).toMatch(/#a\.\.b[\s\S]*"landrace\/a\.\.b"/);
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
