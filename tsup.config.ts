import { defineConfig } from "tsup";
export default defineConfig({
  // `hooks` is what a hook module imports: package.json has declared
  //  "./hooks" since before anything built it, so it resolved to nothing.
  entry: { index: "src/index.ts", cli: "src/cli/index.ts", hooks: "src/hooks/index.ts" },
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: true,
  banner: { js: "#!/usr/bin/env node" },
});
