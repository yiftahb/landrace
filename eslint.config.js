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
  {
    // Not source: a Tailwind CLI dump, regenerated wholesale by `pnpm css`.
    // Linting a minified stylesheet-as-a-string reports nothing useful, and
    // the freshness test (tests/ui/styles.test.ts) is the actual guard on
    // its content; it still typechecks, which is the check that matters.
    ignores: ["src/ui/styles.generated.ts"],
  },
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
          // An allow-list, not a deny-list, and that is the whole point. The
          // deny-list this replaces named five directories — workflow, cli,
          // hooks, runner, agent — and the absolute-imports refactor renamed
          // the specifiers without it following: `#sandbox.js`, which shells
          // out to git, and `#config/`, which reads files, both passed clean
          // inside src/core. A list of the layers core may not see has to be
          // edited every time a layer is added or renamed; a list of the three
          // modules it may see does not.
          //
          // `regex`, not `group`: a group is matched with gitignore semantics,
          // where a leading `#` starts a comment, so `group: ["#workflow/*"]`
          // matches nothing and reports a pure core forever. The lookahead
          // also excludes `node:` and `.`, which the two patterns above
          // already report in their own words — matching them here as well
          // would print two errors for one line.
          { regex: "^(?!#core/|#namespace\\.js$|#conventions\\.js$|@ucast/|node:|\\.)",
            message:
              "core is pure and depends on no sibling layer: it may import only " +
              "#core/*, #namespace.js, #conventions.js and @ucast/*" },
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
