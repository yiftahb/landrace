import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as contracts from "#hooks/contracts.js";
import { HOOK_KINDS, hookKindOf } from "#hooks/contracts.js";

const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : path.endsWith(".ts") ? [path] : [];
  });

/**
 * The one file under src/ allowed to name a vendor, by exact path: a table
 * from a link's hostname to a display name and a coloured letter. It is a
 * label for a URL a hook already handed us, not an integration — and the
 * describe block below is what keeps it that way.
 */
const DISPLAY_ONLY = join("src", "ui", "systems.ts");

const linesMatching = (pattern: RegExp): string[] =>
  filesUnder("src").filter((file) => file !== DISPLAY_ONLY).flatMap((file) =>
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
 *   1. an item's run is read first from its `lr:stage:*` label
 *      (`buildSnapshot`, `src/runner/snapshot.ts`), and a stage's `identity`
 *      places only an item with no such label (`locatedRun`,
 *      `src/core/derive.ts`), never overriding one — so a tracker with real
 *      statuses must still be read through identities, or synthesise a label
 *      array it does not have;
 *   2. `TrackerComment` (`src/namespace.ts`) is the GitHub REST wire shape,
 *      `created_at` and `user.login` and all, rather than the neutral
 *      `{ id, body, at, author }` the name promises;
 *   3. `ItemPatch.state` (`src/namespace.ts`) is `"open" | "closed"`, which a
 *      Jira workflow status or a Linear per-team state must collapse into.
 *
 * Cited by name, not by line: a line number goes stale with the next edit
 * above it, as the last three did.
 *
 * Each is a real design change rather than a rename, so this comment is the
 * honest half of the job: a passing test here is not evidence that a second
 * tracker is one file. `.superpowers/sdd/2026-09-15-landrace-main-loop/
 * review-cleanliness.md` carries the same list where the next person will
 * find it.
 */
/**
 * Every integration landrace ships, by its folder's name: a new one is
 * guarded the day it lands, with nothing here to remember to edit.
 */
const VENDORS = readdirSync("integrations", { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();

/**
 * Files that may name a vendor, and which — each for a reason that is not an
 * integration: the board's links into the person's own apps, a label on a
 * deep link as systems.ts is a label on a URL. systems.ts is left out of
 * every sweep by `linesMatching` itself.
 */
const AGENT_DISPLAY = [join("src", "ui", "chat.ts"), join("src", "ui", "page.ts")];
const DISPLAY_FOR: Record<string, string[]> = { claude: AGENT_DISPLAY, codex: AGENT_DISPLAY };

describe("no tracker is named inside the engine", () => {
  it("knows the integrations it guards from integrations/ itself", () => {
    expect(VENDORS).toEqual(expect.arrayContaining(["claude", "codex", "github", "gitlab", "jira", "notion", "slack"]));
  });

  /*
   * As a word, in code and comments alike, whatever the case — "a Jira hook
   * would" in a comment is how the next special case starts. CLAUDE.md, the
   * instructions file comments cite, is not the agent.
   */
  it.each(VENDORS)("has no mention of %s anywhere under src, bar its display-only files", (vendor) => {
    const word = new RegExp(`\\b${vendor}\\b${vendor === "claude" ? "(?!\\.md)" : ""}`, "i");
    const allowed = DISPLAY_FOR[vendor] ?? [];
    expect(linesMatching(word).filter((line) => !allowed.some((file) => line.startsWith(`${file}:`)))).toEqual([]);
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

/*
 * The other side of the same boundary: an integration builds on what any
 * integration author has — `landrace/kit`, `landrace/hooks` and node — and
 * never on the engine's own modules, which would make it part of the engine
 * and a second agent a change to landrace rather than a file beside it.
 *
 * And its own files, beside it: `./client.js` inside one integration's
 * directory, never `../` into another's — a sibling integration is not
 * something any author has either.
 */
describe("an integration imports only what any integration author can", () => {
  it("imports nothing but landrace/kit, landrace/hooks, node:* and its own ./<file>.js", () => {
    const strays = filesUnder("integrations").flatMap((file) =>
      readFileSync(file, "utf8").split("\n").flatMap((line, i) =>
        // Every specifier on the line: `from "x"`, `import "x"` and `import("x")`.
        [...line.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)]
          .filter(([, specifier]) => !/^(landrace\/(kit|hooks)|node:.+|\.\/[A-Za-z0-9_-]+\.js)$/.test(specifier ?? ""))
          .map(() => `${file}:${i + 1}: ${line.trim()}`)));
    expect(filesUnder("integrations").length).toBeGreaterThan(0);
    expect(strays).toEqual([]);
  });
});

/*
 * The kit is what every integration builds on, published as `landrace/kit`,
 * so it is held to what any integration author has beside it: the shared
 * vocabulary, the namespace's types, the hook brands, node, and itself —
 * never the runner, the core or the loader, which would make an integration
 * part of the engine without anyone writing an engine import.
 */
const KIT = filesUnder(join("src", "kit"));

/** Every specifier a source line imports from: `from "x"`, `import "x"` and `import("x")`. */
const specifiers = (line: string): string[] =>
  [...line.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].flatMap(([, specifier]) => (specifier === undefined ? [] : [specifier]));

/**
 * The names a base logs in, by the file that holds it: its role's. The
 * executor's are the agent's own events and the step's end, which the
 * engine's activity feed reads by those names.
 */
const ROLE_EVENTS: Record<string, RegExp> = {
  [join("src", "kit", "forge.ts")]: /^forge\./,
  [join("src", "kit", "docs.ts")]: /^docs\./,
  [join("src", "kit", "tracker.ts")]: /^tracker\./,
  [join("src", "kit", "executor.ts")]: /^(agent|step)\./,
};

/** Each line a top-level class covers, from `class` to the closing brace in the first column. */
const classLines = (lines: string[]): Set<number> => {
  const inside = new Set<number>();
  let open = false;
  lines.forEach((line, i) => {
    if (/^export (abstract )?class\b/.test(line)) open = true;
    if (open) inside.add(i);
    if (open && line === "}") open = false;
  });
  return inside;
};

describe("the kit holds to what an integration author has", () => {
  it("imports only #conventions, #namespace, #hooks/contracts, node:* and its own files", () => {
    const strays = KIT.flatMap((file) => readFileSync(file, "utf8").split("\n").flatMap((line, i) =>
      specifiers(line)
        .filter((specifier) => !/^(#conventions\.js|#namespace\.js|#hooks\/contracts\.js|#kit\/[A-Za-z0-9_-]+\.js|node:.+)$/.test(specifier))
        .map((specifier) => `${file}:${i + 1}: ${specifier}`)));
    expect(KIT.length).toBeGreaterThan(0);
    expect(strays).toEqual([]);
  });

  /*
   * A function the kit exports is called by an integration not built on a
   * base, in that integration's name, so it never logs: what it says, it
   * says by returning or throwing. A base logs — through the context the
   * engine hands it — and only in its role's name, so an event names the
   * role that said it, whichever integration extends the base.
   */
  it("logs only inside a base, through the context's log, in its role's name", () => {
    const strays = KIT.flatMap((file) => {
      const lines = readFileSync(file, "utf8").split("\n");
      const inside = classLines(lines);
      return lines.flatMap((line, i) => {
        const where = `${file}:${i + 1}: ${line.trim()}`;
        if (/\bconsole\./.test(line)) return [`${where} (console)`];
        const calls = [...line.matchAll(/(?<![\w.])(?:ctx\.)?log(?:\?\.)?\(\s*(?:["'`]([^"'`]*)["'`])?/g)];
        return calls.flatMap(([, name]) => {
          if (!inside.has(i)) return [`${where} (outside a base)`];
          const role = ROLE_EVENTS[file];
          if (name === undefined || role === undefined || !role.test(name)) return [`${where} (not in its role's name)`];
          return [];
        });
      });
    });
    expect(strays).toEqual([]);
  });

  it("finds every log call there is to judge", () => {
    const calls = KIT.flatMap((file) => [...readFileSync(file, "utf8").matchAll(/(?<![\w.])(?:ctx\.)?log(?:\?\.)?\(/g)]);
    expect(calls.length).toBeGreaterThanOrEqual(8);
  });
});

describe("the one display-only file that may name a vendor", () => {
  const source = readFileSync(DISPLAY_ONLY, "utf8");

  it("imports nothing but types from the namespace", () => {
    const imports = source.split("\n").filter((line) => /^\s*import\b/.test(line));
    expect(imports.every((line) => /^import type .* from "#namespace\.js";$/.test(line.trim()))).toBe(true);
  });

  it("exports only the table and the lookup", async () => {
    const mod = (await import("#ui/systems.js")) as Record<string, unknown>;
    expect(Object.keys(mod).sort()).toEqual(["SYSTEMS", "systemOf"]);
  });

  it("makes no call out of the process", () => {
    expect(source).not.toMatch(/\bfetch\(|XMLHttpRequest|node:|require\(|\bimport\(/);
  });
});
