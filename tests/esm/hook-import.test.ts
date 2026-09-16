import { loadHooks } from "../../src/hooks/load.js";
import type { HookContext } from "../../src/hooks/types.js";

/**
 * `loadHooks` end to end, over hook modules that are real files on disk.
 *
 * This file runs in the second jest pass, the one started with
 * `--experimental-vm-modules` (see `jest.esm.config.mjs`). The default pass
 * runs the suite through jest's CommonJS runtime, where a transform rewrites
 * `await import(url)` into a call on jest's own resolver — which cannot
 * resolve a `file:` URL at all, whatever the file's extension. So the loader's
 * one genuinely dynamic moment is unreachable there, and everything about it
 * would go untested: that a path becomes a URL, that a module's exports come
 * back, and that the brands survive the round trip.
 *
 * The default pass is left alone rather than switched over, because ESM mode
 * takes `__dirname` and the `jest` global away from
 * `tests/agent/claude.test.ts`, and breaking a working test to reach this one
 * is the wrong trade.
 */
describe("hook modules are imported from disk and classified by their brand", () => {
  it("assembles a registry out of two real modules", async () => {
    const registry = await loadHooks({ dir: "tests/fixtures", modules: ["hooks/alpha.ts", "hooks/beta.ts"] });

    expect(registry.pre.map((h) => h.id)).toEqual(["alpha"]);
    expect(registry.post.map((h) => h.id)).toEqual(["beta"]);
    expect(registry.source?.id).toBe("alpha");
    // alpha.ts also exports a string and a plain function; neither is a hook.
    expect(registry.operator).toBeNull();
    expect(registry.executors.size).toBe(0);
  });

  it("returns hooks that actually run", async () => {
    const registry = await loadHooks({ dir: "tests/fixtures", modules: ["hooks/alpha.ts"] });

    expect(await registry.pre[0]?.run({} as HookContext)).toEqual({ ticket: { title: "from alpha" } });
    expect(await registry.source?.list({} as HookContext)).toEqual([
      { ticket: 1, title: "one", url: "u/1", labels: ["lr:auto"] },
    ]);
  });

  /**
   * The integration this repository actually runs, loaded the way the CLI
   * loads it: the path out of `.landrace/workflow.yaml`, resolved against
   * `.landrace/`. If the engine's idea of a hook and the reference
   * implementation's ever drift apart, this is what says so.
   */
  it("loads the shipped tracker integration into every slot it fills", async () => {
    const registry = await loadHooks({ dir: ".landrace", modules: ["hooks/github.ts"] });

    expect(registry.pre.map((h) => h.id)).toEqual(["github"]);
    expect(registry.post[0]?.handles).toEqual(
      expect.arrayContaining(["tracker.label", "tracker.status", "tracker.comment"]),
    );
    expect(registry.source?.id).toBe("github");
    expect(registry.operator?.id).toBe("github");
  });
});
