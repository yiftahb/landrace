## Overview

Landrace is a local-first SDLC orchestrator: it watches an issue tracker and advances each ticket through an explicit workflow, using coding agents for the work and code for the decisions.

The whole design rests on one idea — **the model does the work, the state machine decides what happens next.** A model never picks a transition. It produces a value, and a deterministic rule routes on it. Most of the rules below exist to keep that true under pressure.

## Architecture

```
src/namespace.ts   every type in the system, and nothing else
src/core/         pure decision engine — no I/O, no clock, no randomness
src/workflow/     load and validate workflow definitions
src/hooks/        the define* contracts and the loader that imports .landrace/hooks/*.ts
src/agent/        executors and prompt screening
src/runner/       tick, converge, step, lock, effect dispatch, events
src/config/       landrace.yaml + .env
src/mcp/          operator tools over stdio
src/cli/          validate, next, mcp, start, status
src/conventions.ts  label and marker vocabulary shared by all of the above

.landrace/hooks/  the integrations — GitHub included. Not part of the engine.
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

### The engine ships no integrations

There is no GitHub code in `src/`, and `tests/boundaries.test.ts` fails on the offending file and line. Talking to a tracker, publishing a page, reading a pull request — all of it lives in `.landrace/hooks/*.ts`, written against the `define*` contracts and loaded by path from `workflow.yaml`. The engine's half of the bargain is that it never needs to know which tracker it is driving; that is what makes a workflow portable and a second tracker a file rather than a fork. Shared vocabulary — label names, the marker format, how a record reads back as an entry — lives in `src/conventions.ts`, because a Jira hook would use the same names.

If you are about to import a vendor SDK into `src/`, you are writing a hook.

A hook is classified by the brand its `define*` helper stamps, never by its shape. Two of anything singular — two sources, two operators, two hooks of a phase under one id — halts at load with both names, like every other ambiguity here.

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
