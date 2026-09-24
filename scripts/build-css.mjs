#!/usr/bin/env node
/*
 * `pnpm css`: writes src/ui/styles.generated.ts from src/ui/styles.css.
 *
 * The actual generation lives in src/ui/generate-css.ts (a normal TS module
 * under src/, imported the same way by this script and by the freshness
 * test in tests/ui/styles.test.ts) so there is exactly one implementation
 * to keep in sync with the committed output, not two that can drift.
 *
 * Run with `--experimental-strip-types`: this is a plain .mjs entry point
 * importing a .ts module by its `#ui/...` package-imports specifier, and on
 * node < 22.18 that needs the flag node's own type-stripping ships behind
 * (see src/cli/reexec.ts for the same fact elsewhere in this codebase).
 */
import { writeFile } from "node:fs/promises";
import { generateCss, moduleFor, OUTPUT } from "#ui/generate-css.js";

async function main() {
  const css = await generateCss();
  await writeFile(OUTPUT, moduleFor(css));
  console.log(`wrote ${OUTPUT} (${css.length} bytes of CSS)`);
}

main().catch((e) => {
  console.error(`pnpm css: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
