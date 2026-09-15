import { createDispatcher } from "../../src/runner/effects.js";
import { definePostHook } from "../../src/hooks/types.js";
import type { HookContext } from "../../src/hooks/types.js";
import type { Effect, Snapshot } from "../../src/core/index.js";

const ctx = (): HookContext => ({
  ticket: 1, snapshot: {}, config: {} as HookContext["config"],
  secrets: new Map(), signal: new AbortController().signal, log: () => {},
});

const applied: Effect[] = [];
const labelHook = () =>
  definePostHook({
    id: "labels",
    handles: ["tracker.label"],
    satisfied: (s: Snapshot, e: Effect) =>
      ((s.ticket as { labels?: string[] })?.labels ?? []).includes(String(e.add)),
    apply: async (e) => { applied.push(e); },
  });

beforeEach(() => { applied.length = 0; });

describe("createDispatcher", () => {
  it("routes an effect to the hook that handles it", async () => {
    const d = createDispatcher([labelHook()]);
    await d.apply({ type: "tracker.label", add: "lr:working" }, ctx());
    expect(applied).toHaveLength(1);
  });

  it("asks the handling hook whether an effect is already satisfied", () => {
    const d = createDispatcher([labelHook()]);
    const s = { ticket: { labels: ["lr:working"] } } as Snapshot;
    expect(d.satisfied(s, { type: "tracker.label", add: "lr:working" })).toBe(true);
    expect(d.satisfied(s, { type: "tracker.label", add: "lr:blocked" })).toBe(false);
  });

  it("treats an unhandled effect as unsatisfied, so it is never silently dropped", () => {
    const d = createDispatcher([labelHook()]);
    expect(d.satisfied({} as Snapshot, { type: "notion.push" })).toBe(false);
  });

  it("refuses to apply an effect nothing handles, naming the type", async () => {
    const d = createDispatcher([labelHook()]);
    await expect(d.apply({ type: "notion.push" }, ctx())).rejects.toThrow(/no post hook handles "notion.push"/);
  });

  it("rejects two hooks claiming one effect type instead of picking one", () => {
    const other = definePostHook({
      id: "other", handles: ["tracker.label"], satisfied: () => false, apply: async () => {},
    });
    expect(() => createDispatcher([labelHook(), other])).toThrow(/tracker\.label.*labels.*other/);
  });

  it("names the hook that threw while applying", async () => {
    const boom = definePostHook({
      id: "boom", handles: ["x"], satisfied: () => false,
      apply: async () => { throw new Error("rate limited"); },
    });
    await expect(createDispatcher([boom]).apply({ type: "x" }, ctx()))
      .rejects.toThrow(/post hook "boom".*rate limited/);
  });
});
