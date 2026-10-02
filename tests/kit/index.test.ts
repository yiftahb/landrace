import * as kit from "landrace/kit";

/*
 * `landrace/kit` is what an integration author imports, whichever role it
 * plays: an executor, a tracker, a forge or a docs integration.
 */
describe("landrace/kit", () => {
  it("carries the executor base and the shared tracker, forge, docs and git code", () => {
    for (const name of [
      "BaseExecutor", "itemNode", "commentSatisfied", "pullNode", "threadsBrief", "specNode", "publishSatisfied", "gitIn", "pushBranch",
      "EffectRefused", "isEffectRefused",
    ]) {
      expect(typeof (kit as Record<string, unknown>)[name]).toBe("function");
    }
  });

  it("carries the tracker, forge and docs bases, and compose", () => {
    for (const name of ["BaseTracker", "BaseForge", "BaseDocs", "compose"]) {
      expect(typeof (kit as Record<string, unknown>)[name]).toBe("function");
    }
  });
});
