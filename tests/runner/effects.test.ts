import { createDispatcher } from "#runner/effects.js";
import { definePostHook } from "#hooks/contracts.js";
import type { HookContext } from "#namespace.js";
import type { Effect, Snapshot } from "#namespace.js";

const ctx = (): HookContext => ({
  ticket: "1", snapshot: {}, config: {} as HookContext["config"],
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

  it("names the hook and effect type when satisfied throws, instead of propagating raw", () => {
    const boom = definePostHook({
      id: "boom", handles: ["y"],
      satisfied: () => { throw new Error("db unreachable"); },
      apply: async () => {},
    });
    const d = createDispatcher([boom]);
    expect(() => d.satisfied({} as Snapshot, { type: "y" }))
      .toThrow(/post hook "boom" failed checking "y".*db unreachable/);
  });

  it("does not blame an unrelated hook, and lets other effect types keep checking normally", () => {
    const boom = definePostHook({
      id: "boom", handles: ["y"],
      satisfied: () => { throw new Error("db unreachable"); },
      apply: async () => {},
    });
    const d = createDispatcher([boom, labelHook()]);
    expect(() => d.satisfied({} as Snapshot, { type: "y" })).toThrow(/post hook "boom"/);
    try {
      d.satisfied({} as Snapshot, { type: "y" });
      throw new Error("expected satisfied to throw");
    } catch (err) {
      expect((err as Error).message).not.toMatch(/labels/);
    }
    const s = { ticket: { labels: ["lr:working"] } } as Snapshot;
    expect(d.satisfied(s, { type: "tracker.label", add: "lr:working" })).toBe(true);
  });

  it("returns false, not a throw, for an effect with no handler", () => {
    const d = createDispatcher([labelHook()]);
    expect(() => d.satisfied({} as Snapshot, { type: "notion.push" })).not.toThrow();
    expect(d.satisfied({} as Snapshot, { type: "notion.push" })).toBe(false);
  });

  // Round 3: `(err as Error).message` is reachable here — any post hook
  // throwing a non-Error hits it — and the try/catch one level up
  // (converge's tryReconcile/tryApply) does stop it from crashing the
  // process, but only after the attribution this dispatcher exists to add
  // is already lost: the caller sees a raw, unattributed message instead of
  // "post hook X failed checking/applying Y: ...".
  it("still attributes to the right hook when satisfied() throws a non-Error", () => {
    const boom = definePostHook({
      id: "broken", handles: ["tracker.status"],
      satisfied: () => { throw null; },
      apply: async () => {},
    });
    const d = createDispatcher([boom]);
    expect(() => d.satisfied({} as Snapshot, { type: "tracker.status" }))
      .toThrow(/post hook "broken" failed checking "tracker.status"/);
  });

  it("still attributes to the right hook when apply() rejects with a non-Error", async () => {
    const boom = definePostHook({
      id: "broken", handles: ["tracker.status"],
      satisfied: () => false,
      apply: async () => { throw "socket hang up"; },
    });
    const d = createDispatcher([boom]);
    await expect(d.apply({ type: "tracker.status" }, ctx()))
      .rejects.toThrow(/post hook "broken" failed applying "tracker\.status": socket hang up/);
  });
});
