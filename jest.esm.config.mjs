import base from "./jest.config.mjs";

/**
 * A second pass, for the handful of tests that need jest's ESM runtime.
 *
 * The default pass runs the suite through jest's CommonJS runtime, where the
 * transform rewrites `await import(url)` into a call on jest's own resolver —
 * which cannot resolve a `file:` URL, whatever the file's extension. The hook
 * loader's only dynamic moment is exactly that call, so it is unreachable
 * there.
 *
 * Only these tests move, rather than the whole suite: ESM mode takes
 * `__dirname` and the `jest` global away from `tests/hooks/claude.test.ts`,
 * and breaking a working test to reach this one is the wrong trade. Run by
 * `pnpm test`, after the default pass.
 */
// The default config is a function (it probes loopback first), so this one is too.
export default async () => ({
  ...(await base()),
  testMatch: ["<rootDir>/tests/esm/**/*.test.ts"],
  // The default pass's ignore list is what sends these here; keeping it would
  // send them nowhere.
  testPathIgnorePatterns: ["/node_modules/"],
});
