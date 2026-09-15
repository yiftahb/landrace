import { githubPostHook, githubPreHook } from "../../src/adapters/github/hooks.js";
import type { HookContext } from "../../src/hooks/types.js";
import type { Effect, Snapshot } from "../../src/core/types.js";
import { createFakeGitHub } from "../mcp/fake-github.js";

/**
 * reconcile drops an effect its hook calls satisfied, so "has this already
 * happened" is as much control state as "has this step run". Reading it off
 * any comment let a stranger who guesses a marker string suppress the effect
 * permanently.
 */
const effect: Effect = { type: "tracker.comment", marker: "awaiting-review", body: "please review" };

const snapshot = (comments: unknown[], bot: string | null = "landrace-bot"): Snapshot =>
  ({ ticket: { labels: [], comments }, ...(bot === null ? {} : { tracker: { bot } }) }) as Snapshot;

describe("an effect counts as done only when we are the ones who did it", () => {
  const hook = () => githubPostHook(createFakeGitHub());

  it("is not satisfied by a stranger's comment that happens to contain the marker", () => {
    const s = snapshot([{ body: "totally unrelated: awaiting-review", user: { login: "mallory" } }]);
    expect(hook().satisfied(s, effect)).toBe(false);
  });

  it("is satisfied by our own comment, whatever the case of the login", () => {
    const s = snapshot([{ body: "please review\n\nawaiting-review", user: { login: "Landrace-Bot" } }]);
    expect(hook().satisfied(s, effect)).toBe(true);
  });

  it("is not satisfied by a comment with no author at all", () => {
    expect(hook().satisfied(snapshot([{ body: "awaiting-review" }]), effect)).toBe(false);
  });

  it("refuses to answer rather than guess when the snapshot does not say who we are", () => {
    const s = snapshot([{ body: "awaiting-review", user: { login: "landrace-bot" } }], null);
    expect(() => hook().satisfied(s, effect)).toThrow(/posts as/);
  });

  it("the pre hook records the login, so the post hook can read it", async () => {
    const fake = createFakeGitHub([{ number: 1 }]);
    const pre = githubPreHook(fake);
    const fragment = await pre.run({ ticket: 1 } as unknown as HookContext);
    expect(fragment.tracker).toEqual({ bot: "yiftahb" });
    expect(pre.provides).toContain("tracker.bot");
  });
});
