import type { HookContext } from "../../src/hooks/types.js";
import type { Effect, Snapshot } from "../../src/namespace.js";
import { createFakeTracker } from "../support/fake-tracker.js";
import { renderMarker } from "../../src/conventions.js";

/**
 * reconcile drops an effect its hook calls satisfied, so "has this already
 * happened" is as much control state as "has this step run". Reading it off
 * any comment let a stranger who guesses a marker string suppress the effect
 * permanently.
 */
const effect: Effect = { type: "tracker.comment", marker: "awaiting-review", body: "please review" };

/** A comment shaped the way this hook writes one: prose, then the marker it stamped. */
const ours = (marker: string): string =>
  `please review${renderMarker({ stage: "spec", kind: "enter", round: 1, marker })}`;

const snapshot = (comments: unknown[], bot: string | null = "landrace-bot"): Snapshot =>
  ({ ticket: { labels: [], comments }, ...(bot === null ? {} : { tracker: { bot } }) }) as Snapshot;

describe("an effect counts as done only when we are the ones who did it", () => {
  const hook = () => {
    const [post] = createFakeTracker().registry.post;
    if (!post) throw new Error("the fake tracker registered no post hook");
    return post;
  };

  it("is not satisfied by a stranger's comment that happens to contain the marker", () => {
    const s = snapshot([{ body: "totally unrelated: awaiting-review", user: { login: "mallory" } }]);
    expect(hook().satisfied(s, effect)).toBe(false);
  });

  it("is satisfied by our own comment, whatever the case of the login", () => {
    const s = snapshot([{ body: ours("awaiting-review"), user: { login: "Landrace-Bot" } }]);
    expect(hook().satisfied(s, effect)).toBe(true);
  });

  /*
   * "Has this already happened" is answered by the marker we stamped, parsed
   * and compared whole — never by searching the body for the token. A comment
   * body carries the agent's own prose, and an output comment now carries the
   * agent's own words inside the marker as well, so a substring scan hands
   * the agent the token that means "this effect is already done":
   *
   *  - one round's prose containing "enter:spec:2" makes reconcile drop the
   *    *next* round's entry record, and a stage with no new entry record
   *    reads as complete and is never run again;
   *  - "enter:spec:1" is a substring of "enter:spec:10".
   *
   * The first is reachable at the shipped budget of 3, by any step that can
   * write a comment body — which is every step.
   */
  it("is not satisfied by our own comment merely mentioning the token in its prose", () => {
    const planted = `I will post awaiting-review next${renderMarker({ stage: "spec", kind: "output", round: 1 })}`;
    const s = snapshot([{ body: planted, user: { login: "landrace-bot" } }]);
    expect(hook().satisfied(s, effect)).toBe(false);
  });

  it("is not satisfied by a longer marker that merely starts with this one", () => {
    const s = snapshot([{ body: ours("enter:spec:10"), user: { login: "landrace-bot" } }]);
    const first: Effect = { type: "tracker.comment", marker: "enter:spec:1", body: "round 1" };
    expect(hook().satisfied(s, first)).toBe(false);
    expect(hook().satisfied(s, { ...first, marker: "enter:spec:10" })).toBe(true);
  });

  it("is not satisfied by a comment with no author at all", () => {
    expect(hook().satisfied(snapshot([{ body: ours("awaiting-review") }]), effect)).toBe(false);
  });

  it("refuses to answer rather than guess when the snapshot does not say who we are", () => {
    const s = snapshot([{ body: ours("awaiting-review"), user: { login: "landrace-bot" } }], null);
    expect(() => hook().satisfied(s, effect)).toThrow(/posts as/);
  });

  /*
   * An operator's reply is posted unmarked, because it genuinely is a human
   * turn — which means nothing on the ticket would ever say it had been
   * posted. "Satisfied" would silently drop it and "not satisfied" would
   * re-post it on every tick, so the hook refuses to answer instead; an
   * unmarked comment is applied directly, never planned by a stage.
   */
  it("refuses to reconcile a comment effect that carries no marker at all", () => {
    const s = snapshot([{ body: ours("awaiting-review"), user: { login: "landrace-bot" } }]);
    expect(() => hook().satisfied(s, { type: "tracker.comment", body: "just talking" }))
      .toThrow(/no marker cannot be reconciled/);
  });

  it("the pre hook records the login, so the post hook can read it", async () => {
    const fake = createFakeTracker([{ number: 1 }]);
    const [pre] = fake.registry.pre;
    if (!pre) throw new Error("the fake tracker registered no pre hook");
    const fragment = await pre.run({ ticket: 1 } as unknown as HookContext);
    expect(fragment.tracker).toEqual({ bot: "yiftahb" });
    expect(pre.provides).toContain("tracker.bot");
  });
});
