## Overview

Landrace is a local-first SDLC orchestrator: it watches an issue tracker and advances each ticket through an explicit workflow, using coding agents for the work and code for the decisions.

The whole design rests on one idea — **the model does the work, the state machine decides what happens next.** A model never picks a transition. It produces a value, and a deterministic rule routes on it. Most of the rules below exist to keep that true under pressure.

## Architecture

```
src/namespace.ts   every type in the system, and nothing else
src/core/         pure decision engine — no I/O, no clock, no randomness
src/workflow/     load and validate workflow definitions
src/hooks/        the define* contracts and the loader that imports .landrace/hooks/*.ts
src/agent/        prompt screening, worktrees, an agent's json output — never an agent itself
src/runner/       tick, converge, step, lock, effect dispatch, events
src/config/       landrace.yaml + .env
src/mcp/          operator tools over stdio
src/cli/          validate, next, mcp, start, status
src/conventions.ts  label and marker vocabulary shared by all of the above
src/sandbox.ts     repository identity, and the tmp root locks and worktrees share

.landrace/hooks/  the integrations — GitHub, and the coding agent (claude.ts). Not part of the engine.
```

## Rules

### The core is pure, and it is enforced

`src/core/**` must not import node builtins, must not import a sibling layer, and must not call `Date.now()`, `Math.random()`, `new Date()`, `process`, `crypto`, `performance` or `fetch`. Time arrives as `snapshot.now`; hashing takes an injected `digest`. An eslint rule and a test enforce this — do not weaken either to make something compile. If core seems to need I/O, the thing you are writing belongs in a hook.

### Ambiguity halts. Never resolve it by ordering

Two stages whose identity predicates both match, two triggers that both fire, two post hooks claiming one effect type — all stop the ticket and say so. An engine that quietly picks the first one is worse than one that admits it cannot tell. There is no "first match wins" anywhere in this codebase.

### State is derived, never stored

A ticket's entire progress is re-derived from the tracker on every run: position from a label, rounds by counting records, findings from review threads. There is no database, no ledger, no cache to repair. Recovery is re-derivation. If you find yourself adding a field to remember something, find the external record that already implies it.

Counters are derived by counting, never incremented. An `increment` effect cannot be reconciled, because its target depends on its current value.

### Effects belong to a state, never to a transition

There is no `on_exit`, and there must not be. Effects are a function of the state you are in, so re-entering replans them and `reconcile` drops the ones already satisfied. That is the whole reason a crash mid-run converges instead of corrupting.

Every effect needs a `satisfied()` beside its `apply()`, in the same hook. An effect without one gets re-applied on every tick.

### The engine is vendor-agnostic; hooks are the vendor-aware layer, per project

This is the project's most important boundary. Two layers, and nothing crosses between them except the contracts:

- **The engine (`src/`) knows no vendor.** It owns the workflow, the decisions, agent invocation, locks, effect dispatch, the MCP plane and the UI. It defines the *shape* of what it consumes — `Node`, `Relationship`, `Graph`, `Source`, `Operator`, the `define*` hooks — and the shared vocabulary in `src/conventions.ts` (labels, markers, kinds, relationship names), because a Jira hook must use the same names a GitHub one does.
- **Hooks (`.landrace/hooks/*.ts`) are the integration layer, and they are vendor-aware.** They are defined *per project*, in that project's own `.landrace/`, and loaded by path from its `workflow.yaml`. Everything that talks to a tracker, a forge, a docs site or a coding agent — which issues exist, how a sub-issue or a pull request is read, how a ticket is created, linked or closed, what a close reason or a priority label means, which command line runs the agent — lives there and nowhere else. The coding agent is a hook like any other: `.landrace/hooks/claude.ts` is a `defineExecutor` factory, and the engine ships none.

The engine asks *what* (give me the graph, create this child under that parent, close these ids, run this prompt under these capabilities); the hook decides *how* for its vendor. A second tracker, or a second coding agent, is a new hook file, never a change to `src/`.

Enforced: `tests/boundaries.test.ts` fails on "github" or "claude" anywhere under `src/`, naming the file and line. The deliberate exceptions are display-only. For "github", `src/ui/systems.ts`, a table that names the system a link points into; it imports nothing and a test pins that. For "claude", `src/ui/chat.ts` and `src/ui/page.ts`, the board's links that open a chat in an editor, and any mention of `CLAUDE.md`, the instructions file comments cite.

If you are about to import a vendor SDK, call a vendor API, or write a vendor's field name into `src/`, you are writing a hook. If a hook seems to need a decision — which stage comes next, whether a step may run — that decision belongs in the engine, expressed as a value the workflow routes on.

Worked example — an agent creating sub-tickets crosses the boundary three times, and each side keeps to its half:

1. **Engine, then the executor hook:** a step declaring `tickets:create` is handed the engine's own ticket server with exactly one tool, `landrace_create_child`, bound by the runner to (parent, stage, round) on the server's argv. The engine validates the input, escapes the body and stamps an origin marker (`src/runner/children.ts`, `src/mcp/server.ts`). The project's executor loads that server for the step and allows exactly that tool; for Claude, through `--mcp-config` and `--allowedTools` (`.landrace/hooks/claude.ts`).
2. **Hook:** the project's `Operator.createTicket` does the vendor work — on GitHub, create the issue, link it as a sub-issue, then label it (`.landrace/hooks/github.ts`); the in-memory tracker does the same against a map.
3. **Engine:** the next tick reads the graph back through `Source.list/read`; the child is a `Node` with an `origin` and a `child-of` edge, and the workflow routes on `rel.*` counts. Re-running the breakdown plans `nodes.close` from the graph in pure core (`src/core/children.ts`); the hook closes the ids its own way and answers `satisfied()`.

A hook is classified by the brand its `define*` helper stamps, never by its shape. Two of anything singular — two sources, two operators, two hooks of a phase under one id — halts at load with both names, like every other ambiguity here.

### Imports are absolute

Every import under `src/` and `tests/` goes through the `imports` map in
`package.json` — `#core/index.js`, `#namespace.js`, `#tests/...`. Not tsconfig
`paths`: this code runs three ways that have to agree, and raw Node executes
`src` directly in the ESM test pass and the hook loader, where `paths` would not
rewrite anything. A lint rule refuses a `../` import. Hooks in `.landrace/` are
the exception and import `landrace/hooks`, which is what an external hook author
writes.

### Every type lives in `src/namespace.ts`

One file declares every interface and type alias in the system; modules import their
types from it and export only values. A type inferred from a runtime value — a Zod
schema, for instance — is still declared there, in a `export type X = z.infer<typeof
schema>` line that imports the schema in type position. `namespace.ts` itself exports
no runtime value, which is what lets the pure core import from it freely.

### Ask the graph before you grep

Every question about this codebase — where a symbol is defined, what calls it, how a
value flows, what the layers are — goes to `codebase-memory-mcp` first: `search_graph`,
`trace_path`, `get_code_snippet`, `query_graph`, `get_architecture`, `search_code`. If
the repository is not indexed yet, run `index_repository` first. Grep, glob and Read
remain right for prose, config and anything that is not code, and you always Read a
file before editing it.

### A broken step output is a hard fail, never a retry

Malformed output halts the ticket with the reason. It is never retried and never treated as "hasn't run yet" — a step whose output was rejected has produced nothing, so without care it looks identical to one that never started, and the engine re-runs it forever. Read validity *before* completeness.

### Abstain rather than guess

Where a validation rule cannot analyse a graph — a trigger that could fire from anywhere — it abstains for the whole graph instead of reporting a possibly-wrong result. A validator that flags healthy workflows gets switched off, and one that silently stops checking is worse than none.

### Untrusted text cannot forge control state

Everything we write carries a trailing marker. Only the **last** marker in a body counts, and only when nothing follows it — a document about this system will quote the format, and reading the first match finds the example. Text we did not author is escaped before posting, so an agent or a commenter cannot emit our own control tokens.

## Testing

- **TDD.** Write the failing test, run it, watch it fail, then implement. A test that has never failed has proved nothing.
- **Verify by running, not by reading.** The defects that survive review are the ones that look right. Attack a guard with the case it is meant to catch and watch it fail before you believe it works.
- **Tests pin behaviour, not implementation.** A test asserting values the test itself just wrote cannot fail; delete it — the typechecker already covers that claim.
- Unit tests are pure functions with fixtures; there is nothing below the core to mock. Tests touching a tracker use the in-memory adapter, which implements the real interface so a leak across the boundary is caught rather than hidden.

## Toolchain

- Node `>=22`, pnpm. Native type stripping — never add `tsx`, `jiti` or `ts-node`.
- `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are on. Prefer a guarded local over a non-null assertion; an optional property fed from Zod needs `| undefined` in its type.
- `pnpm typecheck && pnpm lint && pnpm test && pnpm build` must pass before any commit.

## Style

- Comments explain **why**, not what. A comment restating the code is noise; one recording the failure that produced a rule is worth keeping.
- Prefer deleting to abstracting. No interface with one implementation, no config for a value that never changes.
- Errors report, they do not crash. A CLI that exits through a stack trace has given the user nothing to act on.

<!-- agsync:begin -->
## Available Skills

- **agsync**: Expert in agsync, the Git-native CLI that syncs skills, commands, and MCP tools across AI coding agents. You MUST use this skill when working on agent skills, commands, MCP configurations or agsync (agsync.yaml) directly.

Skills are managed by agsync. Full definitions are in `.agents/skills/`.
<!-- agsync:end -->
<!-- DO NOT EDIT THIS FILE. Edit: .agsync/instructions.md -->
