export default {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    // .landrace/hooks/*.ts import `landrace/hooks` the way a consumer's do.
    // Node resolves that to dist/ by package self-reference; here it has to
    // reach the source, so tests never depend on a build having run.
    "^landrace/hooks$": "<rootDir>/src/hooks/index.ts",
  },
  transform: { "^.+\\.ts$": ["ts-jest", { useESM: true }] },
  // tests/esm/** needs jest's ESM runtime, which is a process-wide node flag,
  // so it runs as a second pass under jest.esm.config.mjs. See that file.
  testPathIgnorePatterns: ["/node_modules/", "<rootDir>/tests/esm/"],
};
