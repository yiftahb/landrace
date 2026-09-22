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

**v1, unproven against a live repository.** Every part of the loop is built and
tested — `landrace start` polls the tracker, locks a ticket, derives its state,
runs the step, publishes what it produced and advances the workflow. The whole
of the shipped workflow runs end to end in tests, including its failure paths.
What has not happened is a run against a real repository with a real token, so
treat the first one as a supervised experiment rather than a deployment.

| | |
|---|---|
| Decision engine, workflow format, validator | ✅ built |
| CLI: `validate`, `next`, `mcp`, `start`, `status` | ✅ built |
| MCP server: read, create, update, comment, ask, resolve | ✅ built |
| Hook loader, GitHub hook, agent execution | ✅ built |
| Tick loop: polling, concurrency, per-ticket locking | ✅ built |
| Artifact publishing to GitHub Pages, PR review threads | ✅ built |
| Worktree sandbox with enforced capabilities | ✅ built |
| Conversation with a running step, over MCP | ✅ built |
| Opening the pull request itself | ⏳ next |
| Containers, OpenTelemetry, a second tracker | ⏳ planned |

One gap worth knowing before you start it: **nothing pushes a branch or opens
the pull request yet.** A workflow reaching `build` parks there until someone
opens one, at which point the review cycle picks it up on its own.

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
landrace validate                          # prove the workflow sound
landrace status                            # what it would pick up — reads only
landrace start --once --debug              # one tick, every event printed
landrace start                             # watch, on the interval
```

`validate` fails if a secret does not resolve, if your `.env` is not gitignored,
or if a predicate reads a path no hook provides. `status` invokes no agent and
writes nothing, so it is the safe way to see what Landrace thinks of your
tickets — including the workflow's own reason for skipping one.

Escalate in that order the first time. `start --once` runs a single tick and
exits, and `--debug` prints the assembled snapshot, the planned effects and the
agent subprocess's own output, so you can watch a decision before it becomes a
write. **A step invocation spends real money**; the round caps are the `$lt`
counters in your workflow, not something the engine imposes.

Landrace only touches tickets your `eligible` rule admits — in the shipped
workflow, those labelled `lr:auto`. Everything else is listed and skipped.

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

## Structure

```
src/namespace.ts     every type in the system, and nothing else
src/core/            the decision engine — pure, and enforced: no I/O, no clock,
                     no randomness. Time arrives as `snapshot.now`
src/workflow/        load and validate workflow definitions
src/hooks/           the define* contracts, and the loader that imports yours
src/agent/           executors, prompt screening, the worktree sandbox
src/runner/          tick, converge, step, lock, effect dispatch, events
src/config/          landrace.yaml + .env
src/mcp/             operator tools over stdio
src/cli/             validate, next, mcp, start, status
src/testing/         the harness, for testing a workflow of your own
src/conventions.ts   label and marker vocabulary, shared by every hook
src/sandbox.ts       repository identity; the tmp root locks and worktrees share

.landrace/
  landrace.yaml      runtime — how agents run, where tickets live
  workflow.yaml      the process — one graph, stages declaring what activates them
  steps/*.md         the work — front matter is the contract, the body is the prompt
  hooks/*.ts         the integrations — GitHub included. Not part of the engine
  .env               secrets, gitignored, and `validate` fails if it is not
```

Imports inside `src/` and `tests/` go through the `imports` map in `package.json`
— `#core/index.js`, `#namespace.js` — so nothing walks up the tree. Hooks import
`landrace/hooks`, which is what an external hook author writes too.

## Configuration

### `.landrace/landrace.yaml` — the runtime

How agents run and where tickets live. Portable workflows keep none of this.

| Key | Default | Meaning |
|---|---|---|
| `agent.adapter` | — | Which coding agent to invoke (`claude`) |
| `agent.model` | — | Default model; a step may override it |
| `agent.isolation` | `worktree` | `none`, `worktree`, or `container` |
| `tracker.*` | — | Opaque to the engine, handed to your hooks unread. The shipped GitHub hook reads `tracker.repo` (`owner/name`) and optionally `tracker.bot` |
| `tick.interval` | `60s` | How often to run |
| `tick.concurrency` | `3` | Tickets acted on at once |
| `security.screen` | `true` | Screen each prompt for injection before invoking an agent |
| `security.model` | `haiku` | Model used for screening |
| `log.redact` | `[]` | Secret names whose values must never be logged |
| `secrets.*` | — | `$VAR` references resolved from `.landrace/.env`, handed to hooks as values |
| `vars.*` | — | `$VAR` references resolved the same way and substituted into `workflow.yaml` and the step files wherever `{vars.<name>}` appears. **Not secrets:** nothing redacts them |

### `.landrace/.env` — secrets

Referenced by name from `landrace.yaml`, resolved at load, and handed to hooks as values — a hook never reads `process.env` itself, which is what makes it testable and what lets redaction know every value to suppress. A `.env` here takes precedence over your shell, because a project's own file should be what runs.

`validate` fails if this file exists and git does not ignore it.

### `vars` — one workflow, several instances

```yaml
vars:
  assignee: $LANDRACE_ASSIGNEE
  team: platform
```

Wherever `{vars.<name>}` appears in `workflow.yaml` or a step file — a predicate operand, an effect field, a prompt — it is replaced at load with the resolved value. Everything downstream then sees a literal exactly as if it had been typed: the schema, the operator allowlist, `path-coverage`, and the predicate itself.

Substitution walks the **parsed document**, never its text, so a value carrying a colon, a newline or a quote lands in one string position and stays one string instead of reshaping the YAML around it. It fills in `{vars.…}` and nothing else: `{round}`, `{stage}` and `{ticket.title}` belong to the engine and to the step prompt, and survive untouched.

Variables are configuration, not state. They do not vary per ticket, so they are deliberately **not** in the snapshot — comparing one snapshot path against another would need `$expr`, which is outside the operator allowlist on purpose.

Every mistake is a load error, never a default:

- a variable whose reference does not resolve, **or resolves to an empty value**, is refused by name. Never `""` and never the literal `$LANDRACE_ASSIGNEE`: a predicate filled in with nothing matches no ticket, and "the repository where nothing ever happens" is the hardest failure there is to read.
- a `{vars.x}` nothing defines is refused, naming the variable, the file and the field it was written in.
- a `vars` entry nothing references is refused too — harmless in itself, and usually the same typo seen from the other end.

**Variables are not secrets.** A secret is handed to a hook and stripped from every log line and event by value; a var is substituted into the workflow, so it reaches a tracker comment, an agent's prompt and the events recording both, with nothing suppressing it. `validate` reports, and `start` refuses, a `vars` value that resolves to the same string as a declared secret. A credential belongs in `secrets:`, read by a hook.

**Several developers, one repository.** Each instance exports its own assignee and the workflow filters on it:

```yaml
# landrace.yaml — differs per developer, through the environment
vars:
  assignee: $LANDRACE_ASSIGNEE
```
```yaml
# workflow.yaml — the same file for everyone
eligible:
  - when: { "ticket.assignees": { $in: ["{vars.assignee}"] } }
    else: "assigned to somebody else"
```

One workflow directory, one graph, one set of step files. A ticket assigned to somebody else is skipped with that `else` as the reason `status` prints beside it, nothing is invoked and nothing is written to it — and a ticket assigned to nobody is skipped by everybody rather than worked by everybody, because `ticket.assignees` is an empty list rather than an absent path.

The skip costs one request for the whole repository, not one per ticket: a `Candidate` carries `assignees` beside its labels, so the rule is answered from what `list` already returned, before any issue is fetched and before the per-ticket lock is taken. A source hook must fill it — empty when nobody is assigned — for the same reason a pre hook must: a rule the tick cannot answer abstains, and abstaining means eligible.

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
          "run.outputs.triage.intent": revise
          "run.counters.spec": { $lt: 3 }
    on_enter:
      - { type: tracker.label, add: ["lr:working"], remove: ["lr:awaiting"] }
```

Workflow-level keys beyond `stages`:

| Key | Meaning |
|---|---|
| `eligible` | Which tickets Landrace touches at all, each rule carrying the `else` reason `status` prints for a ticket it skipped |
| `budget.stepTimeout` | How long one agent invocation may take. The round caps are the `$lt` counters in the triggers themselves, where the validator can see and bound them |
| `hooks` | The integration modules, by path, in the order pre hooks run |

### `.landrace/hooks/*.ts` — the integrations

Landrace ships no integrations. Talking to a tracker, publishing a page, reading a pull request — all of it is a TypeScript module in your own workflow directory, written against the `define*` contracts and listed by path:

```yaml
hooks:
  - hooks/github.ts
```

A module imports the contracts from `landrace/hooks` and exports whatever kinds it implements — `definePreHook` to observe, `definePostHook` to act, `defineArtifactHook` for something that is both, `defineSource` to enumerate tickets, `defineOperator` for the create and update an operator asks for by hand, `defineExecutor` for an agent. The loader classifies each export by the brand its helper stamped, so one module can be a whole integration; the order of the list is the order pre hooks run in. A path must resolve inside the workflow directory, symlinks included, because `workflow.yaml` is a repo file a pull request can edit.

`.landrace/hooks/github.ts` in this repository is the reference implementation: one file with the REST client, both hooks, the source and the operator. A second tracker is a sibling of it, and nothing in the engine changes — a test enforces that `src/` never names one.

A pre hook declares the snapshot paths it fills, and `validate`'s `path-coverage` rule is answered from those declarations alone, so a predicate can only read what some hook says it provides. The shipped GitHub hook provides `ticket` (`.number`, `.title`, `.body`, `.state`, `.url`, `.labels`, `.assignees`, `.comments`), `entries` and `tracker.bot`; the in-memory tracker in `landrace/testing` provides the portable subset of that. `ticket.assignees` is a **list of logins** — GitHub's issue has a list, and the singular `assignee` it also returns is that list's first element under a second name, which disagrees with it the moment an issue has two. It is empty, never absent, when nobody is assigned: a rule reading a path a ticket does not carry is one the tick cannot answer, and it abstains on those rather than guessing.

Hook modules are imported at runtime with no build step, so they need a Node that strips types: 22.18 or newer does it unflagged, and an older 22.x needs `--experimental-strip-types`.

Conditions are MongoDB-style documents over snapshot paths, evaluated with a **closed operator allowlist** — `$eq $ne $in $nin $lt $lte $gt $gte $exists $all $size $and $or $not`. `$where` and `$regex` are rejected at load, because a workflow file is a repo file a pull request can edit.

### `.landrace/steps/*.md` — the work

Front matter is the contract, the body is the prompt. The step declares where each shape of its output goes, so the engine never learns what a spec is.

```markdown
---
capabilities: [repo:read]
model: opus
output:
  discriminator: kind
  shapes: { questions: {...}, spec: {...} }
  routes:
    - when: { kind: questions }
      effect: { type: tracker.comment, marker: "questions:{round}" }
    - when: { kind: spec }
      effect: { type: artifact.publish, artifact: spec }
---
Write the spec for {ticket.title}…
```

| Key | Meaning |
|---|---|
| `capabilities` | What the agent may do — `repo:read`, `repo:write`. Enforced by diffing the worktree afterwards, not by the flags handed to the agent, because a hook-registered executor never sees those. An unenforceable capability refuses the step rather than pretending |
| `model` | Overrides `agent.model` for this step. A cheap step should say so |
| `output.discriminator` | The field whose value picks the shape |
| `output.shapes` | What each value of the discriminator must look like. Output that matches none is a hard fail, recorded, never retried |
| `output.routes` | Where each shape goes. One route, one effect — two routes matching one output is ambiguity, and ambiguity halts |

Both schemas are strict: an unknown key fails to load rather than being ignored. A field the engine silently ignores is a lie, and this codebase had four of them until the last review.

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
| `path-coverage` | A predicate — in a trigger, an `identity`, a `requires` or an `eligible` rule — reading a field no hook provides |
| `vars` | A variable that does not resolve, a `{vars.x}` nothing defines, a declared variable nothing references, a variable holding a secret's value |

Every rule runs on every workflow. An earlier version abstained where a trigger
could fire from anywhere, which turned out to mean *always* — the entry trigger
every real workflow needs switched three rules off graph-wide. The graph rules
now work from two derived views instead: a superset that treats an unanchored
trigger as an edge from every stage, for `dead-end` and `reachability`, and the
anchored edges alone for `cycle-bound`.

## CLI

```bash
landrace start [-w <dir>] [--once]       # watch the tracker and advance every eligible ticket
landrace status [-w <dir>]               # one line per ticket: where it is, and why one was skipped
landrace validate [dir]                  # prove a workflow sound
landrace next -w <dir> -s <snapshot>     # the decision for a snapshot, no I/O
landrace mcp [-w <dir>]                  # MCP server over stdio
```

`start` runs ticks on an interval and they overlap: the lock is per ticket, so a
ticket busy with a ten-minute agent delays only itself. `--debug` prints every
event, including the agent subprocess's own. Ctrl-C releases the locks and
exits; press it twice and it says which lock it left behind for the next run to
reclaim.

## Security

- The agent never holds tracker credentials. It writes files; Landrace performs every external write.
- Predicate operators are allowlisted structurally, before a condition reaches the evaluator.
- Everything a step writes is escaped before posting, so an agent cannot emit Landrace's own control tokens.
- `src/core/` is provably pure — no I/O, no clock, no randomness — enforced by lint and by test.
- A step declares what it may do, and the declaration is enforced by diffing its worktree before and after — not by the flags handed to the agent, which a hook-registered executor never sees. A conversation turn is held to the same declaration as the step it continues.
- Every agent invocation is screened first, including a turn typed through the MCP: the place an operator pastes text someone sent them is not a place to start trusting it.
- The engine ships no integrations, and `src/` contains no vendor code at all — a test fails on the offending file and line. A hook module must resolve inside the workflow directory before it is imported, both ends compared after `realpath`.
- A comment carries control state only because Landrace's own account wrote it. The account is resolved from the token at startup and verified against any configured override; the process refuses to run rather than guess, because a login it cannot resolve would make its own records read as a stranger's.

## Development

```bash
pnpm test        # the full suite, over two passes
pnpm typecheck
pnpm lint
pnpm build
```

Agent instructions and MCP config are managed by [agsync](https://github.com/yiftahb/agsync). Edit `.agsync/instructions.md` or `.agsync/mcp/*.yaml` and run `agsync sync` — never edit `AGENTS.md`, `CLAUDE.md` or `.mcp.json` directly, they are generated.

## License

MIT
