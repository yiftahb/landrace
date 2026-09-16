import { artifactPreHook } from "../../src/runner/artifacts.js";
import { buildRegistry } from "../../src/hooks/load.js";
import { defineArtifactHook } from "../../src/hooks/contracts.js";
import { buildSnapshot } from "../../src/runner/snapshot.js";
import type { ArtifactHook, HookContext, Snapshot } from "../../src/namespace.js";

const ctx = (snapshot: Snapshot = {}): HookContext => ({
  ticket: 7,
  snapshot,
  config: {} as HookContext["config"],
  secrets: new Map(),
  signal: new AbortController().signal,
  log: () => {},
});

const artifact = (id: string, read: ArtifactHook["read"]): ArtifactHook =>
  defineArtifactHook({ id, handles: [`${id}.publish`], satisfied: () => false, apply: async () => {}, read });

const reading = (id: string, state: Record<string, unknown>): ArtifactHook =>
  artifact(id, async () => state);

/**
 * `snapshot.artifacts.*` is the path every workflow's predicates read, so the
 * hook does not get to choose where its state lands: it returns its own state
 * and the wiring puts it under the hook's id.
 */
describe("an artifact's state lands under its own name", () => {
  it("nests what read() returned under artifacts.<id>", async () => {
    const fragment = await artifactPreHook(reading("spec", { exists: true, url: "https://x/7/" })).run(ctx());
    expect(fragment).toEqual({ artifacts: { spec: { exists: true, url: "https://x/7/" } } });
  });

  it("declares the path it provides, so validate can cover a predicate that reads it", () => {
    expect(artifactPreHook(reading("spec", {})).provides).toEqual(["artifacts.spec.*"]);
  });

  /*
   * The whole reason the wiring owns the nesting. Fragments merge with a
   * shallow spread, so two artifact hooks each returning their own
   * `{ artifacts: { … } }` silently replaced one another: the second one
   * loaded won, the first one's state vanished from the snapshot, and the
   * predicate reading it simply stopped matching.
   */
  it("keeps the artifacts an earlier hook already read", async () => {
    const before = { artifacts: { pr: { number: 7 } } };
    const fragment = await artifactPreHook(reading("spec", { exists: false })).run(ctx(before));
    expect(fragment).toEqual({ artifacts: { pr: { number: 7 }, spec: { exists: false } } });
  });

  it("survives the real snapshot build with both artifacts intact", async () => {
    const snapshot = await buildSnapshot({
      ticket: 7,
      hooks: [artifactPreHook(reading("pr", { number: 7 })), artifactPreHook(reading("spec", { exists: true }))],
      ctx: ctx() as Omit<HookContext, "snapshot">,
      now: 0,
      digest: () => "h",
    });
    expect(snapshot.artifacts).toEqual({ pr: { number: 7 }, spec: { exists: true } });
  });
});

describe("a read that cannot be trusted stops the ticket", () => {
  it("names the artifact whose read failed", async () => {
    const broken = artifact("spec", async () => { throw new Error("404 from pages"); });
    await expect(artifactPreHook(broken).run(ctx())).rejects.toThrow(/artifact "spec".*404 from pages/);
  });

  it.each([
    ["an array", [1, 2]],
    ["a string", "published"],
    ["null", null],
  ])("refuses state that is %s rather than an object", async (_what, state) => {
    const hook = artifact("spec", async () => state as unknown as Record<string, unknown>);
    await expect(artifactPreHook(hook).run(ctx())).rejects.toThrow(/artifact "spec"/);
  });
});

/**
 * Artifact state comes off the network, and it is the one snapshot region a
 * remote document's own shape reaches. Every bound below exists because the
 * value is carried into a hash, a predicate and a prompt after this point.
 */
describe("the state an artifact contributes is bounded", () => {
  it("refuses a reserved key in the state, and pollutes nothing on the way", async () => {
    const hook = artifact("spec", async () => JSON.parse('{"__proto__":{"polluted":"yes"}}') as Record<string, unknown>);
    await expect(artifactPreHook(hook).run(ctx())).rejects.toThrow(/reserved/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("refuses a reserved key nested deeper in the state", async () => {
    const hook = artifact("spec", async () => JSON.parse('{"head":{"constructor":{"x":1}}}') as Record<string, unknown>);
    await expect(artifactPreHook(hook).run(ctx())).rejects.toThrow(/head\.constructor.*reserved/);
  });

  it("refuses an artifact whose own id is a reserved key, before it can ever run", () => {
    expect(() => artifactPreHook(reading("__proto__", {}))).toThrow(/reserved/);
    expect(({} as Record<string, unknown>).exists).toBeUndefined();
  });

  it.each([
    ["a function", () => 1],
    ["undefined", undefined],
    ["NaN", NaN],
    ["a bigint", 10n],
  ])("refuses %s, which the snapshot hash cannot carry", async (_what, value) => {
    const hook = artifact("spec", async () => ({ head: { sha: value } }));
    await expect(artifactPreHook(hook).run(ctx())).rejects.toThrow(/artifact "spec".*head\.sha/s);
  });

  it("refuses state nested deeper than the cap", async () => {
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 12; i++) deep = { next: deep };
    await expect(artifactPreHook(reading("spec", deep)).run(ctx())).rejects.toThrow(/nested deeper/);
  });

  it("refuses state larger than the cap", async () => {
    const hook = reading("spec", { body: "x".repeat(64 * 1024 + 1) });
    await expect(artifactPreHook(hook).run(ctx())).rejects.toThrow(/characters/);
  });

  it("carries a state that sits just inside every bound", async () => {
    const fragment = await artifactPreHook(reading("spec", { body: "x".repeat(1000), n: 1, ok: true, tags: ["a"] })).run(ctx());
    expect((fragment.artifacts as Record<string, unknown>).spec).toEqual({ body: "x".repeat(1000), n: 1, ok: true, tags: ["a"] });
  });
});

/**
 * The loader is what files an artifact in both phases, so the nesting has to
 * happen there rather than in whatever the hook remembered to return.
 */
describe("the loader wires an artifact through the same nesting", () => {
  it("registers the read as a pre hook that nests, and the hook itself as the post half", async () => {
    const spec = reading("spec", { exists: true });
    const r = buildRegistry([{ specifier: "hooks/pages.ts", exports: { spec } }]);

    expect(r.post[0]).toBe(spec);
    await expect(r.pre[0]?.run(ctx())).resolves.toEqual({ artifacts: { spec: { exists: true } } });
  });

  it("halts when two artifacts claim one name, naming both modules", () => {
    expect(() =>
      buildRegistry([
        { specifier: "hooks/pages.ts", exports: { spec: reading("spec", {}) } },
        { specifier: "hooks/notion.ts", exports: { spec: reading("spec", {}) } },
      ]),
    ).toThrow(/hooks\/pages\.ts.*hooks\/notion\.ts/s);
  });

  it("halts when two artifacts claim one effect type, naming both", () => {
    const pages = defineArtifactHook({
      id: "spec", handles: ["artifact.publish"], satisfied: () => false, apply: async () => {}, read: async () => ({}),
    });
    const notion = defineArtifactHook({
      id: "page", handles: ["artifact.publish"], satisfied: () => false, apply: async () => {}, read: async () => ({}),
    });
    expect(() => buildRegistry([{ specifier: "hooks/both.ts", exports: { pages, notion } }]))
      .toThrow(/two post hooks handle "artifact.publish".*"spec".*"page"|two post hooks handle "artifact.publish".*"page".*"spec"/s);
  });
});
