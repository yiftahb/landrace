import { readdirSync, readFileSync } from "node:fs";
import { defineConfig } from "tsup";
export default defineConfig({
  // `hooks` is what a hook module imports: package.json has declared
  //  "./hooks" since before anything built it, so it resolved to nothing.
  // `testing` is what a workflow author imports to drive their own workflow
  // without a tracker: package.json has declared "./testing" since before
  // anything built it, so it resolved to nothing, exactly as "./hooks" did.
  // `kit` is what an integration builds on, and `integrations/<vendor>` the
  // ones landrace ships. An integration imports `landrace/kit` and
  // `landrace/hooks` as anyone's would, so both stay imports in its bundle,
  // resolved by package self-reference, rather than a second copy inlined.
  entry: {
    index: "src/index.ts",
    cli: "src/cli/index.ts",
    hooks: "src/hooks/index.ts",
    kit: "src/kit/index.ts",
    testing: "src/testing/index.ts",
    // One entry per folder, so a new vendor — Jira, GitLab, Notion built side
    // by side — never edits this file and never conflicts with another here.
    ...Object.fromEntries(
      readdirSync("integrations", { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => [`integrations/${d.name}`, `integrations/${d.name}/index.ts`]),
    ),
  },
  external: [/^landrace\//],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: true,
  banner: { js: "#!/usr/bin/env node" },
  // `landrace --version` and the update check read this, so an installed copy
  // never has to find its own package.json at run time.
  define: { __LANDRACE_VERSION__: JSON.stringify((JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version) },
});
