# Development

This page is for working on Landrace itself: the toolchain, the checks every change passes, how the tests are run, and the rules the code holds itself to. How the code is laid out is in [Architecture](architecture.md#the-layers).

## Toolchain

- **Node 22 or newer**, and **pnpm**. Landrace runs TypeScript through Node's native type stripping and ships no TypeScript runtime: never add `tsx`, `jiti` or `ts-node`.
- **TypeScript** with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` on. Prefer a guarded local over a non-null assertion; an optional property fed from Zod needs `| undefined` in its type.

```bash
pnpm install
pnpm build
node dist/cli.js --help
```

The project's own hooks (`.landrace/hooks/*.ts`) import from the built `dist/` when this checkout's CLI runs them (`node dist/cli.js`), so a command run after pulling needs a fresh build first. A global `landrace` run here loads its own copy, not `dist/` — see [Command line](cli.md).

## The gate

Every commit passes all four:

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

| Command | What it runs |
|---|---|
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | `eslint` over `src`, `tests`, `.landrace` and `integrations` |
| `pnpm test` | The suite, in two passes (below) |
| `pnpm build` | `tsup`, into `dist/` |

## Tests

`pnpm test` runs jest twice. The first pass runs the whole suite through jest's CommonJS runtime. The second, `jest.esm.config.mjs`, runs only `tests/esm/**`: the hook loader imports a `file:` URL, which only jest's ESM runtime can resolve.

Where the process may not bind `127.0.0.1` — inside a write step's sandbox, for one — the tests that start a local server are skipped, and jest says so once, first.

How tests are written here:

- **Test first.** Write the failing test, run it, watch it fail, then implement. A test that has never failed has proved nothing.
- **Verify by running, not by reading.** Attack a guard with the case it is meant to catch, on every path it takes, and watch it fail before you believe it works. An input placed on an edge — a boundary, a limit — asserts it landed there.
- **Pin behaviour, not implementation.** A test asserting values it just wrote cannot fail; the typechecker already covers that claim.
- **No mocks below the core.** Unit tests are pure functions with fixtures. Tests that touch a tracker use the in-memory adapter, which implements the real interface, so a leak across the boundary is caught rather than hidden.

## Imports

Every import under `src/` and `tests/` goes through the `imports` map in `package.json` — `#core/index.js`, `#namespace.js`, `#tests/...` — never a relative path; a lint rule refuses `./` and `../` imports. Not tsconfig `paths`: the code runs three ways that must agree — tsc, tsup, and raw Node in the ESM test pass and the hook loader — and `paths` would rewrite nothing for Node.

Hooks in `.landrace/` and integrations in `integrations/` are the exception. They import `landrace/hooks` and `landrace/kit` (and a hook, `landrace/integrations/<vendor>`), which is what an outside author writes. At run time the engine resolves those to the copy of Landrace that is running: this checkout's `dist/` under `node dist/cli.js`, a global install's own copy under `landrace` ([Command line](cli.md)). The typechecker and jest resolve them to the source, through tsconfig `paths` and the jest mapping derived from them, so tests never depend on a build.

## Types live in src/namespace.ts

One file declares every interface and type alias in the engine. Modules import their types from it and export only values. A type inferred from a runtime value — a Zod schema, say — is still declared there, as `export type X = z.infer<typeof schema>` with the schema imported in type position. `namespace.ts` exports no runtime value, which is what lets the pure core import from it freely.

An integration under `integrations/` keeps its vendor's own shapes — the wire types its API answers in, and its options — beside the code that reads them. What it maps them into, `ItemRecord`, `PullRecord` and the rest, is the namespace's.

## Boundaries the tests enforce

- **The core is pure.** `src/core/**` may not import a Node built-in or a sibling layer, and may not call `Date.now()`, `Math.random()`, `new Date()`, `process`, `crypto`, `performance` or `fetch`. Time arrives as `snapshot.now`; hashing takes an injected `digest`. An eslint rule enforces it, and `tests/purity.test.ts` checks that the rule still has files to apply to. If the core seems to need I/O, what you are writing belongs in a hook.
- **The engine names no vendor.** `tests/boundaries.test.ts` fails on the name of any integration — every folder under `integrations/`, in any case, inside an identifier such as `githubToken` too, in code or a comment — anywhere under `src/`, naming the file and line. The display-only exceptions are `src/ui/systems.ts`, the table naming the system a link points into, and the board's chat links in `src/ui/chat.ts` and `src/ui/page.ts`.
- **Integrations import only the kit.** The same test fails on an import under `integrations/` other than `landrace/kit`, `landrace/hooks`, `node:*` or a `./<file>.js` beside it, and holds `src/kit/` to `#conventions.js`, `#namespace.js`, `#hooks/contracts.js`, `node:*` and its own files — and its logging to its role's name.
- **The docs hold together.** `tests/docs.test.ts` fails on a page under `docs/` with a code block that has no language tag, or a relative link to a file or heading that does not exist.

## Testing a workflow of your own

`landrace/testing` exports what this repository's own tests use:

- `createExternalState` — `compose` over `MemoryTracker`, `MemoryForge` and `MemoryDocs`, an in-memory tracker, forge and docs built on the kit's bases. With `readOnly: true`, every tracker write throws `this tracker is read-only: <operation> was asked of <what>`, where `<what>` is `#<id>`, or `a new item` (`a new item under #<n>`) for a create, or `an issue in <project> for #<id>` for a `tracker.create`; the state's `writes()` lists every tracker write attempted, refused ones included. Only the tracker is read-only: the forge and docs still take pushes, pull requests and publishes, and `writes()` does not list them — the forge's show in `pushes()` and `pull(<id>)`. With `createIn: ["ENG"]`, the tracker takes `tracker.create` in those projects, and `filed()` lists every issue it filed there, keyed `ENG-<n>`, with the `fields` it was filed with. Those issues are never among its items. With `config: { branch: "lr-{item}" }`, a pull request `openPull` seeds without naming a branch is opened from `lr-<id>`; without it, from `landrace/<id>`.
- `createHarness` — drives an item through a workflow and records what happened: the stages it passed through, and each step it called. It brings no tracker of its own; you hand it the hooks. Its `config` is the context's configuration, as `landrace.yaml` gives it. A workflow on a configured item branch passes `branch` to it, or the pull request its `pull.open` opens never ties to the item. A test that seeds pull requests passes the same `config` to `createExternalState` too.

  In the example, `workflow` and `steps` are your loaded workflow: its `Workflow` and a `Map` of its steps by stage. This repository's tests load them with `loadWorkflow` from `#workflow/load.js`, which `landrace/testing` does not export. `answers` gives each stage that runs a step the output it answers with, here a `build` stage:

  ```ts
  const config = { branch: "lr-{item}" };
  const answers = { build: '```json\n{"kind":"done"}\n```' };
  const state = createExternalState({ items: [{ id: "1", labels: ["lr:auto"] }], config });
  const run = createHarness({ workflow, steps, source: state.source, pre: [state.pre], post: [state.post], answers, config });
  const { result } = await run.converge();
  ```

- `scriptedExecutor` — an executor that answers with canned output per stage instead of running an agent, so every branch of a workflow can be reached on demand.

The workflow fixtures under `tests/fixtures/` are worked examples. Each integration's live check is in [Integrations](integrations.md).

## Agent instructions and MCP config

Agent instructions and MCP config are managed by [agsync](https://github.com/yiftahb/agsync). Edit `.agsync/instructions.md` or `.agsync/mcp/*.yaml`, then run:

```bash
agsync sync
```

Never edit `AGENTS.md`, `CLAUDE.md` or `.mcp.json` directly: they are generated. `tests/agents-sync.test.ts` fails when `AGENTS.md` is missing a line of `.agsync/instructions.md`.

## Style

- Comments explain **why**, not what. A comment recording the failure that produced a rule is worth keeping.
- Prefer deleting to abstracting: no interface with one implementation, no setting for a value that never changes.
- Errors report; they do not crash. A command that exits through a stack trace gives the user nothing to act on.
