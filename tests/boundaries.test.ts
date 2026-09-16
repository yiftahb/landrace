import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as contracts from "#hooks/contracts.js";
import { HOOK_KINDS, hookKindOf } from "#hooks/contracts.js";

const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : path.endsWith(".ts") ? [path] : [];
  });

const linesMatching = (pattern: RegExp): string[] =>
  filesUnder("src").flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line, i) => (pattern.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : [])),
  );

/**
 * The engine ships no integrations.
 *
 * This is the rule the whole `.landrace/hooks/` design exists to hold, and it
 * is the one that rots quietly: nothing stops a comment, a type, a default, or
 * "just this one special case" from naming a tracker, and each one makes the
 * next easier. The failure prints file and line, because a rule you have to go
 * hunting for is a rule that gets switched off.
 */
describe("no tracker is named inside the engine", () => {
  it("has no mention of a vendor tracker anywhere under src", () => {
    expect(linesMatching(/github/i)).toEqual([]);
  });

  /*
   * The other direction of the same boundary. `.landrace/` is the user's
   * directory: the engine reaches it by a path out of a config file, resolved
   * and contained at runtime, never by an import — an import would make the
   * reference implementation part of the package.
   *
   * Both spellings of the same import, because there are now two: a path, and
   * the `#landrace/` subpath that package.json's `imports` map resolves to the
   * same files for the tests that exercise the reference hook.
   */
  it("imports nothing out of the workflow directory", () => {
    expect(linesMatching(/from\s+["'][^"']*(\.landrace|#landrace)\//)).toEqual([]);
  });
});

/**
 * A meta-guard on the loader's vocabulary, not a restatement of it.
 *
 * `HOOK_KINDS` is what `buildRegistry` switches on, and a hook is only ever
 * branded by a define* helper. Add a kind to that list with no helper to stamp
 * it and nothing breaks: the loader simply never classifies anything as it,
 * and the new kind is silently unloadable. This makes that a build failure.
 */
describe("every kind the loader classifies has a way to be registered", () => {
  it("has a define* helper per kind, and no helper for a kind the loader ignores", () => {
    const helpers = Object.entries(contracts as Record<string, unknown>)
      .filter(([name, value]) => name.startsWith("define") && typeof value === "function")
      .map(([name, value]) => [name, value as (value: object) => object] as const);

    // Called with an empty object: the helpers brand and return, and what is
    // being asked here is which brand each one stamps, not what it validates.
    const stamped = helpers.map(([name, define]) => [name, hookKindOf(define({}))] as const);

    expect(stamped.filter(([, kind]) => kind === null)).toEqual([]);
    expect([...new Set(stamped.map(([, kind]) => kind))].sort()).toEqual([...HOOK_KINDS].sort());
  });
});
