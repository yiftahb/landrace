export default {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1" },
  transform: { "^.+\\.ts$": ["ts-jest", { useESM: true }] },
  // tests/esm/** needs jest's ESM runtime, which is a process-wide node flag,
  // so it runs as a second pass under jest.esm.config.mjs. See that file.
  testPathIgnorePatterns: ["/node_modules/", "<rootDir>/tests/esm/"],
};
