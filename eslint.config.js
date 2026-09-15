import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["node:*"], message: "core is pure: no node builtins" },
          { group: ["../workflow/*", "../cli/*", "../hooks/*", "../runner/*", "../agent/*"],
            message: "core must not depend on a sibling layer" },
        ],
      }],
    },
  },
);
