# Landrace

A local-first SDLC orchestrator. It watches an issue tracker and advances each ticket through an explicit, versioned workflow — using coding agents for the work and code for the decisions.

> *A landrace is a variety shaped by adaptation to its local environment over generations. That is the thesis: a workflow that adapts to what your team actually ships.*

## Why

Most agent orchestrators hand the whole ticket to a model and hope. Landrace splits the two things apart: **the model does the work, the state machine decides what happens next.** A model never picks a transition — it produces a value, and a deterministic rule routes on it.

Four things follow from that, and they are the reason to use this rather than a prompt loop:

- **You can see why it did what it did.** Every transition is a rule in a file you can read, diff and review — not a paragraph in a prompt.
- **Every loop is bounded, and the bound is checked before anything runs.** `landrace validate` proves that each cycle in your workflow passes through a counter comparison. "The review loop terminates" is a property of the definition, not a hope.
- **A crash costs nothing.** A ticket's entire progress is re-derived from the tracker on every run. There is no database, no ledger, no recovery path to go stale — delete everything local and the next run rebuilds it.
- **It runs on your laptop, with your agent.** No server, no cloud sandbox, no vendor session protocol. The agent adapter is four arguments wide, so swapping the agent is a config line.

## Status

**Early.** The pure decision core, the workflow format, the validator and an MCP server are built and tested. The tick loop, the GitHub tracker hook and agent execution are not yet — so today Landrace can define and check a workflow and let you drive tickets from your editor, but it cannot yet run one end to end.

| | |
|---|---|
| Decision engine, workflow format, validator | ✅ built |
| CLI: `validate`, `next`, `mcp` | ✅ built |
| MCP server: read, create, update, comment on tickets | ✅ built |
| Tick loop, GitHub tracker hook, agent execution | ⏳ next |
| Artifact publishing, conversation with a step, containers | ⏳ planned |

## Install

```bash
pnpm install
pnpm build
node dist/cli.js --help
```

Requires Node 22 or newer. Landrace uses native type stripping and deliberately ships no TypeScript runtime.

## Quick start

```bash
cp .landrace/.env.example .landrace/.env   # add your GITHUB_TOKEN
node dist/cli.js validate .landrace
```

`validate` proves the workflow sound before anything runs it, and fails if a secret does not resolve or if your `.env` is not gitignored.

To drive tickets from your editor, generate the MCP config:

```bash
agsync sync
```

The server is defined in `.agsync/mcp/landrace.yaml` and `agsync` writes it out per agent — `.mcp.json` for Claude, `.codex/config.toml` for Codex. The generated files are gitignored, so run `agsync sync` after cloning.

Then ask your client things like *"what's waiting on me?"*, *"open a ticket for CSV export"*, or *"reply on #12 that the scope is too broad"*.

## How it works

Each run builds a **snapshot** of one ticket from external records, decides, and acts:

```
observe  →  snapshot  →  [ pure decision ]  →  effects  →  act
```

Nothing about progress is stored locally. Position comes from a label, rounds from counting records, findings from review threads. That is what makes recovery re-derivation rather than repair.

The decision itself is five pure steps: locate the ticket's stage, assess whether that stage's step has finished, decide, plan the effects of the state being entered, and drop the effects the world already satisfies. **Ambiguity always halts** — two stages that both match, or two triggers that both fire, stop the ticket rather than picking one.

## Configuration

### `.landrace/landrace.yaml` — the runtime

How agents run and where tickets live. Portable workflows keep none of this.

| Key | Default | Meaning |
|---|---|---|
| `agent.adapter` | — | Which coding agent to invoke (`claude`) |
| `agent.model` | — | Default model; a step may override it |
| `agent.isolation` | `worktree` | `none`, `worktree`, or `container` |
| `tracker.adapter` | `github` | Which tracker adapter to use |
| `tracker.repo` | — | `owner/name` |
| `tracker.candidates` | — | Search that decides which tickets are even looked at |
| `tick.interval` | `60s` | How often to run |
| `tick.concurrency` | `3` | Tickets acted on at once |
| `security.screen` | `true` | Screen each prompt for injection before invoking an agent |
| `security.model` | `haiku` | Model used for screening |
| `log.redact` | `[]` | Secret names whose values must never be logged |
| `secrets.*` | — | `$VAR` references resolved from `.landrace/.env` |

### `.landrace/.env` — secrets

Referenced by name from `landrace.yaml`, resolved at load, and handed to hooks as values — a hook never reads `process.env` itself, which is what makes it testable and what lets redaction know every value to suppress. A `.env` here takes precedence over your shell, because a project's own file should be what runs.

`validate` fails if this file exists and git does not ignore it.

### `.landrace/workflow.yaml` — the process

The whole graph, in one readable file. Stages declare **what activates them**, so adding a stage never means editing its predecessor.

```yaml
stages:
  - id: spec
    step: steps/spec.md
    entry: true
    triggers:
      - name: reviewer asked for changes
        when:
          "run.stage": triage
          "outputs.triage.intent": revise
          "run.counters.spec": { $lt: 3 }
    on_enter:
      - { type: tracker.label, add: ["lr:working"], remove: ["lr:awaiting"] }
```

Conditions are MongoDB-style documents over snapshot paths, evaluated with a **closed operator allowlist** — `$eq $ne $in $nin $lt $lte $gt $gte $exists $all $size $and $or $not`. `$where` and `$regex` are rejected at load, because a workflow file is a repo file a pull request can edit.

### `.landrace/steps/*.md` — the work

Front matter is the contract, the body is the prompt. The step declares where each shape of its output goes, so the engine never learns what a spec is.

```markdown
---
skills: [superpowers:brainstorming]
capabilities: [repo:read]
output:
  discriminator: kind
  shapes: { questions: {...}, spec: {...} }
  routes:
    - when: { kind: questions }
      effect: { type: tracker.comment, marker: "questions:{round}" }
---
Write the spec for {ticket.title}…
```

## What `validate` proves

| Rule | Catches |
|---|---|
| schema, ids, entry | Malformed definitions, duplicate stages, no entry point |
| reachability, `unknown-stage` | A stage nothing leads to; a trigger naming a stage that does not exist |
| `dead-end`, `self-loop` | A non-terminal stage with no way out; a stage triggering on itself |
| `cycle-bound` | A loop with no counter bound — an agent that could run forever |
| `totality` | A declared output shape with nowhere to go |
| `identity` | Two stages that could both be "where the ticket is" |
| `operator` | A disallowed predicate operator, anywhere including nested |
| `path-coverage` | A predicate reading a field no hook provides |

Two of these abstain when the graph cannot be analysed, rather than guess. A validator that flags healthy workflows gets switched off.

## CLI

```bash
landrace validate [dir]                  # prove a workflow sound
landrace next -w <dir> -s <snapshot>     # the decision for a snapshot, no I/O
landrace mcp [-w <dir>]                  # MCP server over stdio
```

## Security

- The agent never holds tracker credentials. It writes files; Landrace performs every external write.
- Predicate operators are allowlisted structurally, before a condition reaches the evaluator.
- Everything a step writes is escaped before posting, so an agent cannot emit Landrace's own control tokens.
- `src/core/` is provably pure — no I/O, no clock, no randomness — enforced by lint and by test.
- Trackers sit behind an adapter reached by id. Nothing outside `src/adapters/` may import one, and a test enforces it — so a second tracker is a new adapter and nothing else.

## Development

```bash
pnpm test        # 130 tests
pnpm typecheck
pnpm lint
pnpm build
```

Agent instructions and MCP config are managed by [agsync](https://github.com/yiftahb/agsync). Edit `.agsync/instructions.md` or `.agsync/mcp/*.yaml` and run `agsync sync` — never edit `AGENTS.md`, `CLAUDE.md` or `.mcp.json` directly, they are generated.

## License

MIT
