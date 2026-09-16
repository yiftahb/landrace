import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/**
 * A meta-guard on the purity enforcement itself, not a duplicate of it: the
 * eslint rules in eslint.config.js that keep src/core pure (no clock, no
 * randomness, no node builtins) are scoped to files: ["src/core/**\/*.ts"].
 * If that directory is ever renamed or moved without updating the eslint
 * config, the glob silently matches nothing, pnpm lint stays green, and
 * every purity rule stops firing with nothing to say so. This test is that
 * "something to say so" — it does not re-check the clock and randomness
 * rules (that is eslint's job), only that the directory the rules are scoped
 * to still exists and still has files for them to apply to.
 */
describe("core purity enforcement has files to enforce it on", () => {
  it("src/core exists and contains at least one .ts file", () => {
    expect(filesUnder("src/core").length).toBeGreaterThan(0);
  });
});

/**
 * The import allow-list, asked of the files rather than of the config.
 *
 * Deliberately a second copy of a rule eslint also enforces, which the rest of
 * this file is careful not to be. The reason is what happened to the rule it
 * replaces: it was a deny-list of five directory names, the absolute-imports
 * refactor renamed every specifier in the repository, and the list did not
 * follow — `import { sandboxRoot } from "#sandbox.js"`, which shells out to
 * git, passed `eslint --stdin` clean inside src/core, and nothing said so. A
 * guard whose subject can be renamed out from under it needs one check that
 * names its subject the way the code does.
 *
 * `@ucast/mongo2js` is on the list because it is the predicate compiler core
 * is built on, and it computes rather than does: a package that could reach
 * the network or the disk is refused here exactly as a sibling layer is.
 */
const ALLOWED = [/^#core\//, /^#namespace\.js$/, /^#conventions\.js$/, /^@ucast\//];

describe("src/core imports nothing that could do I/O", () => {
  it("imports only #core/*, #namespace.js, #conventions.js and @ucast/*", () => {
    const offenders = filesUnder("src/core").flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/(?:^|\n)\s*(?:import|export)[^;\n]*?from\s+["']([^"']+)["']/g)]
        .map((m) => m[1] as string)
        .filter((specifier) => !ALLOWED.some((ok) => ok.test(specifier)))
        .map((specifier) => `${file}: ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });
});
