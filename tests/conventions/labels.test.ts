import { isEngineLabel, stageFromLabels } from "#conventions.js";
import { admitProblems } from "#workflow/validate.js";

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

/*
 * One definition of the engine's own labels, shared by the operator's tools
 * and validate's admit rule (separation review I2): the labels the engine's
 * vocabulary names, and every position. A workflow's own `lr:` label — the
 * ones its `admit` starts items with — is the project's.
 */
describe("isEngineLabel", () => {
  const ENGINE = ["lr:working", "lr:awaiting", "lr:blocked", "lr:screened", "lr:stage:build", " LR:Stage:Done ", "LR:BLOCKED"];
  // lr:approved too: nothing writes or reads it any more (separation review M5).
  const PROJECT = ["lr:fast", "lr:auto", "lr:stagehand", "needs-design", "blocked", "lr:approved"];

  it("is every label the engine names, and any position, whatever the case", () => {
    expect(ENGINE.filter((l) => !isEngineLabel(l))).toEqual([]);
  });

  it("is never a workflow's own lr: label, nor anyone else's", () => {
    expect(PROJECT.filter(isEngineLabel)).toEqual([]);
  });

  it("is exactly what validate refuses a workflow to admit", () => {
    const stages = [{ id: "s", entry: true, terminal: true }];
    const refused = (label: string): boolean =>
      admitProblems("w", { version: 1, name: "w", description: "d", admit: [label], stages }).some((p) => p.message.includes("the engine writes itself"));
    expect([...ENGINE, ...PROJECT].filter(refused)).toEqual(ENGINE);
  });
});
