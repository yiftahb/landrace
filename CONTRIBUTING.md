# Contributing to Landrace

Thank you for helping. This page is what a change needs to be merged. For how the code is laid out and why, read [docs/architecture.md](docs/architecture.md); for running and debugging it locally, [docs/development.md](docs/development.md).

Found a vulnerability? Do not open an issue or a pull request: report it privately, as [SECURITY.md](SECURITY.md) describes.

For anything larger than a small fix, open an issue first, so the design is agreed before the code is written.

## Setting up

You need Node 22 or newer and pnpm (the version is pinned in `package.json`'s `packageManager`; `corepack enable` gives you it).

```bash
pnpm install
pnpm build
node dist/cli.js --help
```

Landrace runs TypeScript through Node's native type stripping. Never add `tsx`, `jiti` or `ts-node`.

## The gate

Every change must pass, before every commit:

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

CI runs the same four on every pull request, and a red build is not merged.

## Test first

Write the failing test, run it, and watch it fail before you write the code that makes it pass. A test that has never failed has proved nothing.

- Test behaviour, not implementation. A test asserting values it just wrote itself cannot fail; the typechecker already covers that claim.
- The decision engine is pure functions, so its tests are fixtures in and values out, with nothing to mock.
- A test that touches a tracker, forge or docs site uses the in-memory adapter, `createExternalState` from `#testing/index.js`, which implements the same interfaces a real integration does. (`landrace/testing` is the name a project's own workflow tests import it by; in this repository it would load the compiled `dist/`.)
- Attack a guard with the case it is meant to catch, on every path it takes, and watch it fail before you trust it.

## The boundaries you will meet

Lint and tests enforce these. Do not weaken a rule or a test to make something compile: if a rule is in your way, the code you are writing probably belongs on the other side of it.

- **The core is pure.** `src/core/**` imports no node builtin and no sibling layer, and never calls `Date.now()`, `Math.random()`, `new Date()`, `process`, `crypto`, `performance` or `fetch`. Time arrives as `snapshot.now`, and hashing takes an injected `digest`. If the core seems to need I/O, what you are writing belongs in a hook.
- **No vendor names under `src/`.** The engine knows no vendor. `tests/boundaries.test.ts` fails on the name of any integration (every folder under `integrations/`, whatever its case, inside an identifier too, in code or a comment) anywhere under `src/`, naming the file and line. The exceptions are display-only: `src/ui/systems.ts`, the table that names the system a link points into; "claude" and "codex" in `src/ui/chat.ts` and `src/ui/page.ts`, the board's links that open a chat in an editor; and mentions of `CLAUDE.md`. A second tracker or a second coding agent is a new integration, never a change to `src/`.
- **Imports are absolute.** Every import under `src/` and `tests/` goes through the `imports` map in `package.json`: `#core/index.js`, `#namespace.js`, `#tests/...`. A lint rule refuses `./` and `../`.
- **Every type lives in `src/namespace.ts`.** Modules import their types from it and export only values, and `namespace.ts` exports no runtime value. A type inferred from a Zod schema is declared there too, as `export type X = z.infer<typeof schema>`. An integration keeps its own vendor's wire types beside the code that reads them.
- **Integrations import only `landrace/kit`, `landrace/hooks`, `node:*` and their own files** (`./<file>.js` inside one integration), so each is exactly what a third party could write.

## Adding an integration

A new tracker, forge, docs site, coding agent or notifier goes in `integrations/<vendor>/`, published as `landrace/integrations/<vendor>`, and is built on the kit's bases (`landrace/kit`):

- A **coding agent** extends `BaseExecutor` and says only what is its agent's: `argv`, `readEvent` and `handoffArgv`, optionally `prepare`, `readExtras`, `sandboxProblems` and `mcpFile`, and declares `efforts`, `pairings` and `envKeys`.
- A **tracker, forge or docs site** extends `BaseTracker`, `BaseForge` or `BaseDocs`, writes only its vendor's calls, and maps the answers into the neutral shapes in `src/namespace.ts` (`ItemRecord`, `PullRecord`, `ReviewThread`, `ChangedFile`). Every effect it adds has a `satisfied()` beside its `apply()`.
- A **notifier** is a `defineNotifier` from `landrace/hooks`, as `integrations/slack/` is.

A project wires it in with a hook file under `.landrace/hooks/`, as `.landrace/hooks/github.ts` does with `compose({ tracker, forge, docs })`. Test it against an in-memory stand-in for the vendor's API, as `tests/integrations/gitlab/fake-gitlab.ts` is, and document it in the README. If an integration seems to need a change to `src/`, open an issue first.

## Commits

- [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`, where the type is `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci` or `chore`, and the scope is the layer or integration (`core`, `runner`, `kit`, `board`, `mcp`, `github`, `jira`, ...). For example, `fix(kit): refuse a merge whose head moved since the review`.
- The summary says what changes for someone using Landrace. The body, where there is one, says why.
- One logical change per commit, and every commit passes the gate.

## Pull requests

- Branch from `main` and open the pull request against `main`. Keep it to one change, and say in its description what changed and why, with `Closes #<issue>` where there is one.
- Fill in the checklist the template gives you: the gate passes, a failing test came first, and the README and docs are updated where behaviour changed.
- CI must be green before review.

## Keep the docs true

`README.md` and `docs/` describe what Landrace does today. A change in behaviour updates them in the same pull request, so that neither describes code that no longer exists.

The agent instructions (`AGENTS.md`, `CLAUDE.md`) and `.mcp.json` are generated by [agsync](https://github.com/yiftahb/agsync). Edit `.agsync/instructions.md` or `.agsync/mcp/*.yaml` and run `agsync sync`; never edit the generated files directly.

## Licence

By contributing, you agree that your contributions are licensed under the [MIT licence](LICENSE).
