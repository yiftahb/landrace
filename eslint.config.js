import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Everything under src and tests is imported by subpath — `#core/index.js`,
 * `#tests/support/fake-tracker.js` — resolved from package.json's `imports`
 * map, which is the one table node, tsc, tsup and jest all read.
 *
 * A relative import is not the same specifier written differently: node, which
 * runs `src` directly under type stripping, does not resolve `./reexec.js` to
 * `reexec.ts` at all, so one relative line is a file the runtime cannot load
 * while the bundler and the typechecker both say it is fine. Stated once and
 * reused below, because the core block redeclares this rule and a rule
 * redeclared is a rule replaced.
 */
const noRelativeImports = {
  group: ["./*", "./**", "../*", "../**"],
  message: "imports under src/ and tests/ are absolute: use a #subpath from package.json's imports map",
};

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain node scripts used as test doubles (e.g. tests/agent/fake-agent.mjs
    // stands in for the real `claude` binary) — not compiled, so they need
    // their node globals declared directly rather than inherited from ts-jest.
    files: ["tests/**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
      },
    },
  },
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    rules: { "no-restricted-imports": ["error", { patterns: [noRelativeImports] }] },
  },
  {
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          noRelativeImports,
          { group: ["node:*"], message: "core is pure: no node builtins" },
          // Named as a sibling layer is now written — `#workflow/load.js`, not
          // `../workflow/load.js`. `regex`, not `group`: a group is matched
          // with gitignore semantics, where a leading `#` starts a comment, so
          // `group: ["#workflow/*"]` matches nothing and reports a pure core
          // forever.
          { regex: "^#(workflow|cli|hooks|runner|agent)/",
            message: "core must not depend on a sibling layer" },
        ],
      }],
      // core re-derives a ticket's whole progress from external records on
      // every run, so a crash recovers by re-deriving rather than repairing
      // stored state — that guarantee only holds if core is pure: no clock,
      // no randomness, no ambient I/O. These catch the actual globals and
      // syntax forms that would smuggle impurity in, not just node imports.
      "no-restricted-globals": ["error",
        { name: "process", message: "core is pure: no process access" },
        { name: "crypto", message: "core is pure: no randomness or ambient crypto access" },
        { name: "performance", message: "core is pure: no clock access" },
        { name: "fetch", message: "core is pure: no ambient I/O" },
      ],
      "no-restricted-syntax": ["error",
        { selector: "NewExpression[callee.name='Date']",
          message: "core is pure: no clock access (new Date())" },
        { selector: "MemberExpression[object.name='Date'][property.name='now']",
          message: "core is pure: no clock access (Date.now())" },
        { selector: "MemberExpression[object.name='Math'][property.name='random']",
          message: "core is pure: no randomness (Math.random())" },
      ],
    },
  },
);
