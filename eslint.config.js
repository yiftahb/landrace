import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain node scripts used as test doubles (e.g. tests/agent/fake-agent.mjs
    // stands in for the real `claude` binary) — not compiled, so they need
    // their node globals declared directly rather than inherited from ts-jest.
    files: ["tests/**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", setTimeout: "readonly", console: "readonly" },
    },
  },
  {
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["node:*"], message: "core is pure: no node builtins" },
          { group: ["**/workflow/*", "**/cli/*", "**/hooks/*", "**/runner/*", "**/agent/*"],
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
