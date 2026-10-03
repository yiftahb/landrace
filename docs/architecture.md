# Architecture

This page explains how Landrace is put together, for someone who has never read its code. It covers the idea the design rests on, the layers of the code, the loop that moves an item, and the item graph every decision reads.

## The idea

Landrace watches an issue tracker and moves each **item** — an issue, a Jira ticket, a merge request awaiting review — through a **workflow**: a graph of **stages**, written in a file. At some stages a coding agent does a piece of work, called a **step**.

The design rests on one rule: **the model does the work, the state machine decides what happens next.** A model never picks a transition. It produces a value, and a deterministic rule in the workflow routes on that value. Every transition is therefore a rule you can read, diff and review, and every loop has a bound that [`landrace validate`](validate.md) checks before anything runs.

## The layers

Two layers, and nothing crosses between them except a set of contracts:

- **The engine** (`src/`) knows no vendor. It owns the workflow, the decisions, running agents, locks, applying effects, the MCP server and the board. It defines the *shape* of what it consumes — `Node`, `Relationship`, `Graph`, `Source`, `Operator` and the `define*` hooks — and the shared vocabulary of labels and markers in `src/conventions.ts`.
- **Hooks** are the integration layer, and they are vendor-aware. A **hook** is a TypeScript module in the project's own `.landrace/hooks/` folder. Everything that talks to a tracker, a forge (where pull requests live), a docs site or a coding agent lives in a hook. Landrace ships ready-made integrations under `integrations/`, and a project's hook file re-exports or composes them. See [Writing an integration](hooks.md) and [Integrations](integrations.md).

The engine asks *what* — give me the graph, create this child under that parent, run this prompt under these capabilities. The hook decides *how* for its vendor. A second tracker or a second coding agent is a new hook file, never a change to `src/`.

The code is laid out like this:

```text
src/namespace.ts     every type in the system, and nothing else
src/core/            the decision engine — pure: no I/O, no clock, no randomness;
                     time arrives as `snapshot.now`
src/workflow/        load and validate workflow definitions
src/hooks/           the define* contracts, and the loader that imports a project's hooks
src/kit/             `landrace/kit` — BaseExecutor for coding agents; BaseTracker, BaseForge,
                     BaseDocs and compose() for the other integrations, and the tracker,
                     forge, docs and git code they are made of
src/agent/           prompt screening, the worktree sandbox, reading an agent's JSON output
src/runner/          tick, converge, step, lock, effect dispatch, events
src/config/          landrace.yaml and .env
src/telemetry/       OpenTelemetry export of events, loaded only when it is on
src/mcp/             operator tools over stdio
src/cli/             validate, next, mcp, start, status
src/ui/              the board: the triage page, its server, and the display-only table
                     of the systems a link points into
src/testing/         `landrace/testing` — the in-memory tracker, forge and docs on the kit's
                     bases, and a harness for testing a workflow
src/conventions.ts   label and marker vocabulary, shared by every hook
src/sandbox.ts       repository identity; the temporary folder locks and worktrees share

integrations/        the integrations Landrace ships, each `landrace/integrations/<vendor>`:
                     claude/ and codex/ on the kit; github/ on its tracker, forge and docs
                     bases; gitlab/ on the forge base; jira/ on the tracker base; notion/ on
                     the docs base; slack/, the notifier. Not part of the engine

.landrace/           a project's workspace
  landrace.yaml      runtime settings — how agents run, where items live
  workflows/<id>/    one folder per workflow
    workflow.yaml    the process: one graph, stages declaring what activates them
    steps/*.md       the work: front matter is the contract, the body is the prompt
  hooks/*.ts         the project's integrations, shared by every workflow
  .env               secrets, gitignored
```

How the code enforces these boundaries — the purity rule, the vendor rule, the import rules — is in [Development](development.md#boundaries-the-tests-enforce).

## The loop: observe, decide, act

`landrace start` runs a **tick** on an interval. Each tick lists the tracker's items, and for each item it may work, it runs one pass:

```text
observe  →  snapshot  →  [ pure decision ]  →  effects  →  act
```

1. **Observe.** Hooks read the item and everything related to it from the tracker and the forge.
2. **Snapshot.** The engine builds a **snapshot**: one JSON document holding the item, its relationships, and its run history, derived from the records it read.
3. **Decide.** The pure core decides, in five steps: *locate* the item's stage, *assess* whether that stage's step has finished, *decide* what happens next, *plan* the effects of the stage being entered, and *reconcile* — drop the effects the world already satisfies.
4. **Act.** Hooks apply what is left, and the step's agent runs if a step is owed.

The core is pure: it does no I/O, reads no clock and draws no random numbers. Time arrives as `snapshot.now`. A lint rule and a test hold it to that. Because the decision is a pure function of the snapshot, `landrace next` can run it on a saved snapshot with no I/O at all — see [the CLI](cli.md#landrace-next).

## Derived state

Landrace stores nothing about an item's progress locally. There is no database, no ledger and no cache. On every pass, it derives the item's whole state from the tracker:

- its **position** (the stage it is at) from a label such as `lr:stage:build`;
- its **rounds** (how many times a stage has run) by counting the records Landrace wrote on the item;
- its **findings** from review threads on its pull requests.

A **record** is a comment Landrace writes, ending in a hidden **marker** such as `<!-- landrace … -->` that says what the comment records. Only the last marker in a comment counts, and only when nothing follows it.

So recovery is re-derivation, not repair. A crash costs nothing: delete everything local, and the next pass rebuilds the same state from the same records. Counters are counted, never incremented, because an increment cannot be reconciled — its target depends on its current value.

## Ambiguity halts

When the engine cannot tell what to do, it stops the item and says why. Two stages that both match an item, two triggers that both fire, two hooks claiming one effect type, two workflows claiming one item — each **halts** the item rather than picking one. There is no "first match wins" anywhere. An engine that quietly picks one is worse than one that admits it cannot tell.

A halted item shows under Needs you on [the board](cli.md#the-board), with the reason.

## Effects and satisfied()

An **effect** is a write to the outside world: add a label, post a comment, push a branch, open or merge a pull request. Effects belong to a *stage*, never to a transition. A stage lists, under `on_enter`, the effects of being in it, and there is no `on_exit`.

That is what makes a crash safe. Every pass re-plans the effects of the stage the item is in, and `reconcile` drops each one the world already satisfies. So an effect applied before a crash is dropped on the next pass, and one that was not applied is applied.

For this to work, every effect has a `satisfied()` beside its `apply()`, in the same hook: `satisfied()` answers, from what was read, whether the effect has already happened. An effect without one would be re-applied on every tick. The effect types and what satisfies each are listed in [Workflows](workflows.md#effects).

## The item graph

A tracker does not hand the engine one flat item. It hands back a **graph**: the item's own node, and every node related to it.

### Nodes and relationships

```ts
interface Node {
  id: string;
  kind: string;              // "item", "pull-request", or whatever the source names
  title: string;
  link: string;
  closed: null | "done" | "dropped";
  priority: number | null;
  origin: Origin | null;
  state: { [key: string]: Json };   // whatever the source wants a condition to read
  createdAt?: number;        // epoch ms, for the board's "opened 3h ago" only — no workflow can route on it
  updatedAt?: number;        // epoch ms, when it last changed — the board's lane order only, likewise
}

interface Relationship { from: string; to: string; type: string }
interface Graph { nodes: Node[]; relationships: Relationship[] }
```

A node is **closed** as `done` (finished — an issue completed, a pull request merged) or `dropped` (closed without being done — not planned, closed unmerged), or not closed (`null`). Its **origin** says which stage and round created it, when a step did.

An **item id** is 1–64 letters, digits, `.`, `_` or `-`. MCP clients may still pass a number.

### Sources: list and read

A **source** is the hook that reads the tracker. It has two methods, and both return a `Graph`:

- `list()` runs once per tick and returns every candidate node. It answers which items a workflow may work (`eligible`), `landrace status` and the board — before any per-item work starts.
- `read(id)` runs once per pass for one item and returns its neighbourhood: the item, its ancestors, its descendants, and everything related to it. Triggers decide from this.

### The snapshot's views

The snapshot carries three views of the graph:

- `node` — the item's own node;
- `graph` — the whole neighbourhood `read` returned;
- `rel.<type>.in` and `rel.<type>.out` — counts over every relationship of `<type>` pointing into the item (`in`) or out of it (`out`).

| Field | Meaning |
|---|---|
| `rel.<type>.in.total` | How many related nodes, leaving out any closed without being done |
| `rel.<type>.in.dropped` | How many were closed without being done — a pull request closed unmerged, a child dropped. Every other count leaves these out |
| `rel.<type>.in.is.<field>` | How many have `state.<field>` equal to the boolean `true` — not merely truthy |
| `rel.<type>.in.not.<field>` | How many have it equal to the boolean `false`; a non-boolean value counts in neither |
| `rel.<type>.in.sum.<field>` | That field, summed across every related node |
| `rel.<type>.in.stage.<id>` | How many related items sit at stage `<id>` right now |
| `rel.<type>.in.open` | The ids of the open nodes `total` counts, in id order — which nodes a count is of |

A field keeps one type across every related node of one type and direction. If it is a boolean on one node and anything else — `null`, a number, a string — on another, or a number on one and not on another, the item halts: `a field has one type or it cannot be counted`. Only values that are neither booleans nor numbers may mix, and they are counted nowhere. A node that lacks the field is simply not counted for it, so a source leaves a field out rather than set it to `null`.

The same fields exist under `out`. Besides its own `state`, every counted node has one more field, `closed`, which is `true` when it is done: so `is.closed` counts the done nodes and `not.closed` the open ones. Like any `is` or `not` count, `not.closed` is absent — not `0` — when nothing of that type is related, which is why the shipped workflows write "none open" as `{ $not: { $gt: 0 } }`.

Because a workflow reads counts, "every pull request on the item is merged" is `rel.implements.in.total: { $gt: 0 }` together with `rel.implements.in.not.merged: 0` — never one pull request's own flag, since an item can have more than one.

### Relationship types

A source declares which relationship types it reports, and for each whether a node may have at most one outgoing edge of it (singular). The engine refuses any type not declared. For a declared type nothing relates, `total` and `dropped` read `0` and `open` is empty — never absent — while the `is`, `not`, `sum` and `stage` fields are absent, since there is no node to have them.

A type whose reads draw only from the item outward — its own relationships, never another item's toward it — is declared **outward-only**, and `validate` refuses a workflow that reads its `rel.<type>.in`, which would always count nothing.

The engine gives no relationship type a meaning. An item waits on another only where its workflow routes on that type's `rel` counts. The types the shipped integrations report, and what each means, are in [Workflows](workflows.md#what-a-condition-can-read).
