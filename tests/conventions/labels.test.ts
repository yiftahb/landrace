import { stageFromLabels } from "#conventions.js";

/**
 * Position is a label, and two of them is an item that cannot be placed.
 *
 * `stageFromLabels` computed `ambiguous` and then returned `found[0]` anyway,
 * so the one caller that *acts* on the answer — buildSnapshot — ran a paid
 * step at whichever stage happened to come first in the array, while both
 * operator surfaces read the flag and reported the item as unplaceable. It
 * was the only first-match-wins in the codebase.
 */
describe("stageFromLabels", () => {
  it("reads the one stage label", () => {
    expect(stageFromLabels(["lr:auto", "lr:stage:build"])).toEqual({
      stage: "build", ambiguous: false, found: ["build"],
    });
  });

  it("has no stage at all when there is no stage label", () => {
    expect(stageFromLabels(["lr:auto"])).toEqual({ stage: null, ambiguous: false, found: [] });
  });

  it("answers null for two, in either order, rather than picking by array order", () => {
    expect(stageFromLabels(["lr:stage:build", "lr:stage:done"]).stage).toBeNull();
    expect(stageFromLabels(["lr:stage:done", "lr:stage:build"]).stage).toBeNull();
  });

  it("names what it found, so a halt can say which two", () => {
    expect(stageFromLabels(["lr:stage:done", "lr:stage:build"])).toEqual({
      stage: null, ambiguous: true, found: ["done", "build"],
    });
  });
});
