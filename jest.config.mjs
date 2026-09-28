import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * One resolution table, three readers.
 *
 * package.json's `imports` is what node, tsc and tsup all resolve `#core/index.js`
 * from. jest has two resolvers of its own and neither reads it: `moduleNameMapper`
 * for the runtime, and ts-jest's compiler for the types. Both are derived from that
 * same map below rather than written out beside it — two copies of a resolution
 * table drift, and the copy that drifts is the one nobody notices until a specifier
 * means two different files in two runtimes.
 */
const { imports } = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8"));

const escape = (literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Longest pattern first: node picks the most specific match and
// `moduleNameMapper` picks the first one that matches, so
// `#tests/support/x.js` — which matches both `#tests/*.js` and `#*.js` — has
// to meet the specific one first.
const subpathImports = Object.fromEntries(
  Object.entries(imports)
    .sort(([a], [b]) => b.indexOf("*") - a.indexOf("*"))
    .map(([specifier, target]) => {
      const [head = "", tail = ""] = specifier.split("*");
      return [`^${escape(head)}(.*)${escape(tail)}$`, target.replace("./", "<rootDir>/").replace("*", "$1")];
    }),
);

// The same map again as `paths`, which is the form ts-jest's compiler resolves
// reliably. It reads `imports` too — but only in the module modes ts-jest does
// not use, and asking for them gets a cold compile that resolves
// `#core/index.js` on some files and not others, which is worse than not
// asking. Merged with the project's own `paths` rather than handed over as
// them: ts-jest replaces the option wholesale, and dropping `landrace/hooks`
// takes the hook modules' own import with it.
const { config } = ts.readConfigFile(fileURLToPath(new URL("tsconfig.json", import.meta.url)), ts.sys.readFile);
const paths = {
  ...config.compilerOptions.paths,
  ...Object.fromEntries(Object.entries(imports).map(([specifier, target]) => [specifier, [target]])),
};

/*
 * Whether this process may bind 127.0.0.1. A write step's OS sandbox forbids
 * it, deliberately: with loopback open an agent could reach the board's write
 * routes and every local service. There the tests that start a server are
 * skipped (tests/support/loopback.ts) and this says so once, rather than 71
 * EPERMs an agent then has to explain away. Everywhere else they run.
 */
const canBindLoopback = () => new Promise((resolve) => {
  const probe = createServer();
  probe.once("error", () => resolve(false));
  probe.listen(0, "127.0.0.1", () => probe.close(() => resolve(true)));
});

// A function, not a value: jest loads this file with require(), which cannot
// wait on a top-level await, and the probe has to finish before any test runs.
export default async () => {
  // jest calls this more than once in one process; say it the first time.
  if (process.env.LANDRACE_NO_LOOPBACK !== "1" && !(await canBindLoopback())) {
    process.env.LANDRACE_NO_LOOPBACK = "1";
    console.warn("landrace: 127.0.0.1 cannot be bound here (a sandbox), so the tests that start a local server are skipped.");
  }
  return jestConfig;
};

const jestConfig = {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    ...subpathImports,
    // .landrace/hooks/*.ts import `landrace/hooks` the way a consumer's do.
    // Node resolves that to dist/ by package self-reference; here it has to
    // reach the source, so tests never depend on a build having run.
    "^landrace/hooks$": "<rootDir>/src/hooks/index.ts",
  },
  transform: { "^.+\\.ts$": ["ts-jest", { useESM: true, tsconfig: { paths } }] },
  // tests/esm/** needs jest's ESM runtime, which is a process-wide node flag,
  // so it runs as a second pass under jest.esm.config.mjs. See that file.
  testPathIgnorePatterns: ["/node_modules/", "<rootDir>/tests/esm/"],
};
