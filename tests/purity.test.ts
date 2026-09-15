import { readdirSync, statSync } from "node:fs";
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
 * "something to say so" — it does not re-check any purity rule (that is
 * eslint's job now), only that the directory the rules are scoped to still
 * exists and still has files for them to apply to.
 */
describe("core purity enforcement has files to enforce it on", () => {
  it("src/core exists and contains at least one .ts file", () => {
    expect(filesUnder("src/core").length).toBeGreaterThan(0);
  });
});
