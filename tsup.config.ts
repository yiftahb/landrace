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
    "integrations/claude": "integrations/claude/index.ts",
    "integrations/codex": "integrations/codex/index.ts",
    "integrations/slack": "integrations/slack/index.ts",
  },
  external: [/^landrace\//],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: true,
  banner: { js: "#!/usr/bin/env node" },
});
