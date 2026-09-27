import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// `process.cwd()`, not a path resolved from this module's own file — both
// callers (`pnpm css` and `pnpm test`) run from the repository root, and
// `import.meta.url` does not survive ts-jest's default (non-ESM) pass, which
// mis-detects this project's "hybrid" NodeNext module kind as CommonJS and
// rejects it with TS1343 (see the identical note on tests/hooks/claude.test.ts).
const ROOT = process.cwd();
// Named `resolve`, not `require`: ts-jest's default pass mis-detects this
// project's "hybrid" NodeNext module kind as CommonJS and, on that path,
// treats `require` as a reserved ambient global — a local `const require`
// collides with it (TS2441) even though this is never actually run as CJS.
const resolve = createRequire(join(ROOT, "package.json"));
const INPUT = join(ROOT, "src", "ui", "styles.css");
export const OUTPUT = join(ROOT, "src", "ui", "styles.generated.ts");

export const HEADER = "// generated — do not edit, run `pnpm css`\n";

/** The Tailwind CLI's own entry point, resolved through node_modules rather than assumed to be on PATH. */
function cliEntry(): string {
  const pkg = resolve.resolve("@tailwindcss/cli/package.json");
  return join(dirname(pkg), "dist", "index.mjs");
}

/**
 * Tailwind's minified output for styles.css, right now — the same call
 * `pnpm css` makes. Exported (not just used by `main` below) so the
 * freshness test in tests/ui/styles.test.ts can run this exact generation
 * in-memory and compare it to what is committed: a class added to page.ts
 * without re-running `pnpm css` then fails the suite instead of silently
 * shipping a page that renders unstyled.
 */
export async function generateCss(): Promise<string> {
  const { stdout } = await run(process.execPath, [cliEntry(), "-i", INPUT, "-m"], { cwd: ROOT });
  return stdout;
}

/** The committed module's exact text, from a CSS string. */
export function moduleFor(css: string): string {
  return `${HEADER}export const APP_CSS = ${JSON.stringify(css)};\n`;
}
