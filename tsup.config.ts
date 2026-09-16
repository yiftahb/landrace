import { defineConfig } from "tsup";
export default defineConfig({
  // `hooks` is what a hook module imports: package.json has declared
  //  "./hooks" since before anything built it, so it resolved to nothing.
  // `testing` is what a workflow author imports to drive their own workflow
  // without a tracker: package.json has declared "./testing" since before
  // anything built it, so it resolved to nothing, exactly as "./hooks" did.
  entry: {
    index: "src/index.ts",
    cli: "src/cli/index.ts",
    hooks: "src/hooks/index.ts",
    testing: "src/testing/index.ts",
  },
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: true,
  banner: { js: "#!/usr/bin/env node" },
});
