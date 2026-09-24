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
 * No tracker is *named* inside the engine — which is a claim about vocabulary,
 * and deliberately not the larger claim that the engine is tracker-agnostic.
 *
 * This is the rule the whole `.landrace/hooks/` design exists to hold, and it
 * is the one that rots quietly: nothing stops a comment, a type, a default, or
 * "just this one special case" from naming a tracker, and each one makes the
 * next easier. The failure prints file and line, because a rule you have to go
 * hunting for is a rule that gets switched off.
 *
 * What it catches is the word. What it cannot catch is the shape, and three
 * GitHub-shaped assumptions live in `src/` and pass this test clean today:
 *
 *   1. a ticket's position is derived only from an `lr:stage:*` label
 *      (`src/runner/snapshot.ts:94`), so a tracker with real statuses has to
 *      synthesise a label array it does not have — and §6's "a human moving a
 *      card moves the ticket" is delivered on no tracker at all;
 *   2. `TrackerComment` (`src/namespace.ts:197`) is the GitHub REST wire
 *      shape, `created_at` and `user.login` and all, rather than the neutral
 *      `{ id, body, at, author }` the name promises;
 *   3. `TicketPatch.state` (`src/namespace.ts:386`) is `"open" | "closed"`,
 *      which a Jira workflow status or a Linear per-team state must collapse
 *      into.
 *
 * Each is a real design change rather than a rename, so this comment is the
 * honest half of the job: a passing test here is not evidence that a second
 * tracker is one file. `.superpowers/sdd/2026-09-15-landrace-main-loop/
 * review-cleanliness.md` carries the same list where the next person will
 * find it.
 */
describe("no tracker is named inside the engine", () => {
  it("has no mention of a vendor tracker's name anywhere under src", () => {
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
