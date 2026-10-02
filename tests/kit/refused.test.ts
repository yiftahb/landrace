import { compose, EffectRefused, isEffectRefused, nothingCommitted } from "landrace/kit";
import { createDispatcher } from "#runner/effects.js";
import { createExternalState, MemoryForge, MemoryTracker } from "#testing/index.js";
import type { ComposedHooks, Effect, Graph, HookContext, RuntimeContext, Snapshot } from "#namespace.js";

/*
 * An effect the forge or the tracker refuses on purpose — a pull request
 * that cannot be merged, a guard the kit will not pass, a permission the
 * token lacks — is told apart from one that failed on the way, a network
 * error or a 5xx: the engine records the first as the stage's rejected
 * round, and leaves the second to the next tick, which may well succeed.
 * Told apart by a mark on the error, never by its words.
 */
const ctx = { config: {}, secrets: new Map(), signal: new AbortController().signal, log: () => {} } as unknown as RuntimeContext;
const merge: Effect = { type: "pull.merge", branch: "landrace/7" };

const read = async (hooks: ComposedHooks): Promise<Snapshot & { graph: Graph }> => {
  const graph = await hooks.source.read("7", ctx);
  return { graph, node: graph.nodes.find((n) => n.id === "7") };
};

const apply = (hooks: ComposedHooks, effect: Effect, snapshot: Snapshot): Promise<void> =>
  hooks.post.apply(effect, { ...ctx, item: "7", snapshot } as HookContext);

/** What a rejected promise was: its sentence, and whether it carries the mark. */
const failure = (p: Promise<unknown>): Promise<{ message: string; refused: boolean } | "resolved"> =>
  p.then(() => "resolved" as const, (e: unknown) => ({ message: (e as Error).message, refused: isEffectRefused(e) }));

describe("the mark", () => {
  it("is on an EffectRefused, keeps its sentence, and is on nothing else", () => {
    const e = new EffectRefused("pr-1 cannot be merged");
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe("pr-1 cannot be merged");
    expect(isEffectRefused(e)).toBe(true);
    for (const other of [new Error("pr-1 cannot be merged"), Object.assign(new Error("x"), { refused: true }), "refused", null, undefined, {}]) {
      expect(isEffectRefused(other)).toBe(false);
    }
  });

  // A symbol from the global registry, so a second copy of the kit — an
  // integration's bundle beside the engine's own — marks it the same way.
  it("is read off the registry's symbol, not the class a copy of the kit defines", () => {
    const copy = Object.defineProperty(new Error("from another copy"), Symbol.for("landrace.effect.refused"), { value: true });
    expect(isEffectRefused(copy)).toBe(true);
  });

  it("never throws, whatever it is asked about", () => {
    const hostile = new Proxy({}, { get: () => { throw new Error("no"); } });
    expect(isEffectRefused(hostile)).toBe(false);
  });

  it("survives the dispatcher's wrapping, and a plain error stays plain", async () => {
    const hook = (thrown: Error) => ({ id: "x", handles: ["pull.merge"], satisfied: () => false, apply: async () => { throw thrown; } });
    const refused = await failure(createDispatcher([hook(new EffectRefused("it cannot be merged"))]).apply(merge, {} as HookContext));
    expect(refused).toEqual({ message: 'post hook "x" failed applying "pull.merge": it cannot be merged', refused: true });
    const plain = await failure(createDispatcher([hook(new Error("502 Bad Gateway"))]).apply(merge, {} as HookContext));
    expect(plain).toEqual({ message: 'post hook "x" failed applying "pull.merge": 502 Bad Gateway', refused: false });
  });

  it("is on the sentence for a branch nothing was committed to", () => {
    expect(isEffectRefused(nothingCommitted("landrace/7", "7"))).toBe(true);
  });
});

describe("the in-memory forge's refusals", () => {
  it("marks a pull request it finds not mergeable", async () => {
    const forge = new MemoryForge();
    forge.add("7", { branch: "landrace/7", headSha: "abc", mergeable: false });
    expect(await failure(forge.merge(1, "abc"))).toEqual({ message: "pr-1 for #7 cannot be merged: the forge finds it not mergeable", refused: true });
  });

  it("marks one a person closed unmerged", async () => {
    const forge = new MemoryForge();
    forge.add("7", { branch: "landrace/7", headSha: "abc", closed: "dropped" });
    expect(await failure(forge.merge(1, "abc"))).toMatchObject({ refused: true });
  });

  it("answers a moved head, which is no refusal at all", async () => {
    const forge = new MemoryForge();
    forge.add("7", { branch: "landrace/7", headSha: "new", mergeable: false });
    expect(await forge.merge(1, "old")).toBe("moved");
  });
});

describe("the kit's own merge guards", () => {
  const state = () => createExternalState({ items: [{ id: "7" }] });

  it("marks a merge with no open pull request from the branch", async () => {
    const s = state();
    expect(await failure(apply(s, merge, await read(s)))).toEqual({
      message: "cannot merge for #7: there is no open pull request from landrace/7", refused: true,
    });
  });

  it.each(["pending", "failure"] as const)("marks a merge whose checks are %s", async (checks) => {
    const s = state();
    s.openPull("7", { branch: "landrace/7", checks, headSha: "abc" });
    expect(await failure(apply(s, merge, await read(s)))).toEqual({ message: `will not merge pr-1 for #7: its checks on abc are ${checks}`, refused: true });
  });

  it("marks a merge whose checks were never read", async () => {
    const s = state();
    const pr = s.openPull("7", { branch: "landrace/7", checks: "success", headSha: "abc" });
    const snapshot = await read(s);
    const node = snapshot.graph.nodes.find((n) => n.id === pr);
    if (!node) throw new Error(`no ${pr} in the read`);
    delete node.state.checks;
    expect(await failure(apply(s, merge, snapshot))).toEqual({ message: "will not merge pr-1 for #7: its checks on abc are unread", refused: true });
  });

  it("marks a merge whose head was not read", async () => {
    const s = state();
    s.openPull("7", { branch: "landrace/7", checks: "success", headSha: "" });
    expect(await failure(apply(s, merge, await read(s)))).toMatchObject({ refused: true });
  });

  it("marks two pull requests open from the branch", async () => {
    const s = state();
    s.openPull("7", { branch: "landrace/7", checks: "success", headSha: "a" });
    s.openPull("7", { branch: "landrace/7", checks: "success", headSha: "b" });
    expect(await failure(apply(s, merge, await read(s)))).toMatchObject({ refused: true });
  });

  it("marks one closed, or gone, since the read", async () => {
    const tracker = new MemoryTracker({ items: [{ id: "7" }] });
    const forge = new MemoryForge();
    const hooks = compose({ tracker, forge });
    const pr = forge.add("7", { branch: "landrace/7", checks: "success", headSha: "abc" });
    const snapshot = await read(hooks);
    forge.pull(pr).closed = "dropped";
    expect(await failure(apply(hooks, merge, snapshot))).toEqual({
      message: "will not merge pr-1 for #7: it was closed without being merged after it was read", refused: true,
    });
    forge.rows.delete(pr);
    expect(await failure(apply(hooks, merge, snapshot))).toMatchObject({ refused: true });
  });

  it("leaves a forge that failed on the way unmarked", async () => {
    const tracker = new MemoryTracker({ items: [{ id: "7" }] });
    const forge = new MemoryForge();
    const hooks = compose({ tracker, forge });
    forge.add("7", { branch: "landrace/7", checks: "success", headSha: "abc" });
    const snapshot = await read(hooks);
    forge.merge = async () => { throw new Error("502 Bad Gateway"); };
    expect(await failure(apply(hooks, merge, snapshot))).toEqual({ message: "502 Bad Gateway", refused: false });
  });
});
