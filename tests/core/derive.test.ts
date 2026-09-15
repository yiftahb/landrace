import { deriveRun } from "../../src/core/derive.js";
import type { Entry } from "../../src/core/types.js";

let t = 0;
const at = () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)).toISOString();
const out = (stage: string, round: number, data: unknown = {}): Entry =>
  ({ stage, kind: "output", round, data, at: at(), byAgent: true });
const human = (): Entry => ({ stage: "-", kind: "human", round: 0, at: at(), byAgent: false });

describe("deriveRun", () => {
  it("counts rounds, not entries — two entries for one round are one round", () => {
    expect(deriveRun([out("spec", 1), out("spec", 1)], "spec").counters.spec).toBe(1);
  });

  it("counts distinct rounds per stage independently", () => {
    const r = deriveRun([out("spec", 1), out("spec", 2), out("review", 1)], "spec");
    expect(r.counters).toEqual({ spec: 2, review: 1 });
  });

  it("takes the highest round as the current output", () => {
    const r = deriveRun([out("spec", 1, { v: "old" }), out("spec", 2, { v: "new" })], "spec");
    expect(r.outputs.spec).toEqual({ v: "new" });
  });

  it("names who moved last", () => {
    expect(deriveRun([out("spec", 1)], "spec").lastEvent.actor).toBe("agent");
    expect(deriveRun([out("spec", 1), human()], "spec").lastEvent.actor).toBe("human");
    expect(deriveRun([], null).lastEvent.actor).toBeNull();
  });

  it("exposes the last human entry so a step can be given it", () => {
    const h = human();
    expect(deriveRun([out("spec", 1), h], "spec").lastHuman).toEqual(h);
  });

  it("marks output invalid when the newest agent entry is a rejection", () => {
    const bad: Entry = { stage: "spec", kind: "malformed", round: 1, at: at(), byAgent: true };
    expect(deriveRun([out("spec", 1), bad], "spec").lastOutputValid).toBe(false);
    expect(deriveRun([out("spec", 1)], "spec").lastOutputValid).toBeNull();
  });

  it("reads the unblock point so a returned ticket gets a fresh budget", () => {
    const unblocked: Entry = { stage: "spec", kind: "unblocked", round: 3, at: at(), byAgent: true };
    expect(deriveRun([out("spec", 3), unblocked], "spec").unblockedAt).toBe(3);
    expect(deriveRun([out("spec", 1)], "spec").unblockedAt).toBe(0);
  });

  it("orders by timestamp, not array position", () => {
    const later = out("spec", 1);
    const earlier: Entry = { ...human(), at: "2025-01-01T00:00:00Z" };
    expect(deriveRun([later, earlier], "spec").lastEvent.actor).toBe("agent");
  });
});
