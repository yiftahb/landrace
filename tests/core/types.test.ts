import type { Entry, Snapshot, Decision } from "../../src/core/types.js";

describe("core types", () => {
  it("models an entry the way a tracker hook produces one", () => {
    const e: Entry = {
      stage: "spec", kind: "output", round: 1,
      data: { kind: "questions" }, at: "2026-01-01T00:00:00Z", byAgent: true,
    };
    expect(e.round).toBe(1);
  });

  it("models a snapshot as open with conventional keys", () => {
    const s: Snapshot = { entries: [], now: 0, anythingAHookInvented: true };
    expect(s.anythingAHookInvented).toBe(true);
  });

  it("models every decision the engine can reach", () => {
    const actions: Decision["action"][] = ["invoke", "wait", "transition", "halt", "skip"];
    expect(actions).toHaveLength(5);
  });
});
