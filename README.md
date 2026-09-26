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
if a server `agent.mcp` allows cannot be handed to a step (see
[What a step's agent is handed](#what-a-steps-agent-is-handed)), or if a
predicate reads a path no hook provides. `status` invokes no agent and
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

**Ticket identifiers:** A ticket id is 1–64 letters, digits, `.`, `_` or `-`; numbers are still accepted from MCP clients.

## How it works

Each run builds a **snapshot** of one ticket from external records, decides, and acts:

```
observe  →  snapshot  →  [ pure decision ]  →  effects  →  act
```

Nothing about progress is stored locally. Position comes from a label, rounds from counting records, findings from review threads. That is what makes recovery re-derivation rather than repair.

The decision itself is five pure steps: locate the ticket's stage, assess whether that stage's step has finished, decide, plan the effects of the state being entered, and drop the effects the world already satisfies. **Ambiguity always halts** — two stages that both match, or two triggers that both fire, stop the ticket rather than picking one.

## The ticket graph

A source doesn't hand the engine one flat ticket — it hands back a **graph**: the ticket's own node, and every other node related to it.

```ts
interface Node {
  id: string;
  kind: string;              // "ticket", "pull-request", or whatever your source names
  title: string;
  link: string;
  closed: null | "done" | "dropped";
  priority: number | null;
  origin: Origin | null;
  state: { [key: string]: Json };   // whatever the source wants a predicate to read
}

interface Relationship { from: string; to: string; type: string }
interface Graph { nodes: Node[]; relationships: Relationship[] }
```

A `Source` has two methods, both returning a `Graph`. `list()` runs once per tick — every candidate node, which is what `eligible`, `status` and the triage page answer from, before any per-ticket work starts. `read(id)` runs once per converge pass, for one ticket's own neighbourhood — itself, its ancestors, its descendants, and everything related to it — and is what a trigger actually decides from.

The snapshot carries three views built from that graph: `node` is the ticket's own node, `graph` is the whole neighbourhood `read` returned, and `rel.<type>.in|out` is a set of counts over every relationship of `<type>` pointing in (`in`) or out (`out`) of the ticket:

| Field | Meaning |
|---|---|
| `rel.<type>.in.total` | How many related nodes |
| `rel.<type>.in.is.<field>` | How many where `state.<field>` is the boolean `true` — not merely truthy |
| `rel.<type>.in.not.<field>` | How many where it is the boolean `false`; a non-boolean value counts in neither |
| `rel.<type>.in.sum.<field>` | That field, summed across every related node |
| `rel.<type>.in.stage.<id>` | How many related tickets currently sit at stage `<id>` |

A source declares which relationship types it reports, and whether a node may have at most one outgoing edge of one (`relations: RelationDecl[]`); the engine refuses any other type, and `rel` counts zero — never nothing — for a declared type nothing relates, so "no threads are open" can still be read when every pull request is merged.

The shipped GitHub hook reports two relationship types: `child-of` (a sub-issue to its parent, singular) and `implements` (a pull request to the ticket it closes or whose branch names it, singular). A pull request is a node like any other — `kind: "pull-request"`, `state.merged`, `state.openThreads` — and "every pull request on the ticket is merged" is `rel.implements.in.total: { $gt: 0 }` **and** `rel.implements.in.not.merged: 0`, never one pull request's own flag, because a ticket can carry more than one. Only an *open* pull request's threads are counted: a merged or closed one reports `openThreads: 0`, never nothing, so the sum stays defined — and readable as "clear" — once every pull request on the ticket is done.

It also reports a ticket's published spec page as a `document` node, with a third relationship type, `documents`, pointing at its ticket (singular) — so the triage page shows the spec under its ticket. `list` finds every page in one listing of the `gh-pages` branch and reports none for that tick, with a logged reason, when that listing fails or GitHub truncates it — it is display only, so it never fails the tick; `read` checks the ticket's own page directly. The workflow still routes on `artifacts.spec`, not on this node.

Spec links — on that node, and in `artifacts.spec.url` — point at the Pages site when the repository publishes one from the root of `gh-pages`, and otherwise at the file on GitHub, which anyone who can see the repository can open.

Priority comes from this repository's own `P0`..`P9` label convention; two of them is a priority that cannot be told, and `read` halts the ticket rather than picking one, the same way two stage labels does. A closed ticket is never worked — it keeps whatever labels it had, `lr:auto` included, but only ever appears in a graph so a parent can count a finished child, never so a tick pays for a step on it. And a GitHub close reason this hook does not recognise — anything but `COMPLETED`, `NOT_PLANNED`, `DUPLICATE` or none — halts the ticket rather than guessing whether it is done or dropped.

A step's prompt can also ask a source for prose the graph itself does not carry — `{brief.<source id>.<key>}`, fetched only when that step is about to run, never routed on by any predicate. `fix-review.md` reads `{brief.github.threads}`: the open review threads across the ticket's pull requests, as a working list for the step to act on.

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
| `agent.plugins` | `[]` | Plugin ids (`name@marketplace`) enabled for every step and conversation turn, e.g. `superpowers@claude-plugins-official` |
| `agent.mcp` | `[]` | MCP server **names** a step may use, looked up in the repository root's `.mcp.json`. Never `landrace` — see below |
| `tracker.*` | — | Opaque to the engine, handed to your hooks unread. The shipped GitHub hook reads `tracker.repo` (`owner/name`) and optionally `tracker.bot` — which a GitHub App token needs (e.g. `myapp`), since it cannot look up its own login; logins compare ignoring case and a trailing `[bot]` |
| `tick.interval` | `60s` | How often to run |
| `tick.concurrency` | `3` | Tickets acted on at once |
| `security.screen` | `true` | Screen each prompt for injection before invoking an agent |
| `security.model` | `haiku` | Model used for screening |
| `log.redact` | `[]` | Secret names whose values must never be logged |
| `secrets.*` | — | `$VAR` references resolved from `.landrace/.env`, handed to hooks as values |
| `vars.*` | — | `$VAR` references resolved the same way and substituted into `workflow.yaml` and the step files wherever `{vars.<name>}` appears. **Not secrets:** nothing redacts them |

### What a step's agent is handed

A step's `capabilities` decide how the engine's `claude` executor starts the agent:

| Step declares | Permission mode | Also |
|---|---|---|
| no `repo:write` (read-only) | `manual` | `--restricted`, and `Bash`, `Edit`, `MultiEdit`, `NotebookEdit`, `Write` denied by name |
| `repo:write` | `acceptEdits` | — |

Read-only steps do not run in plan mode. Checked against the real CLI (2.1.282), plan mode refuses every MCP call — the codebase graph and `create_child` alike — and ignores `--model`, running a different model from the one the step asked for. Manual mode with the write and exec tools denied honours both, and refuses a write attempted under it. The worktree diff after the run stays the backstop either way.

`--restricted` ignores your own Claude settings, and with them every plugin you enabled there, so a read-only step has none unless `agent.plugins` names it. The list goes to the agent as one inline `--settings` document.

Every step and turn runs with `--strict-mcp-config`: it gets exactly the servers `agent.mcp` names, as `.mcp.json` defines them (`env` included), each allowed as `mcp__<name>` — and nothing from a `.mcp.json` committed to the repository, from your user-level config, or from anywhere else. With an empty `agent.mcp` it gets no server at all. A step holding `create_child` gets its bound child server beside them.

Servers are resolved once, at startup, from the **repository root's** `.mcp.json` — the file agsync generates, not anything in the step's worktree. `landrace start`, `landrace status` and `landrace mcp` refuse to start, and `landrace validate` reports the same sentence, when:

- `agent.mcp` names a server but there is no `.mcp.json` at the repository root — run `agsync sync`, which generates it;
- a name is not in `.mcp.json` — the refusal lists the names it does define;
- a name is landrace's own operator server: `landrace`, or any server whose command runs `landrace mcp`, `cli.js mcp` or `dist/cli.js mcp`, however it is spelled. Its tools create, update and reply on tickets, and a step agent holding them could move its own ticket — so operator tools never reach a step agent.

The screener never gets plugins or servers: it reads attacker-reachable text and needs no tool to judge it. An allowlisted server's `env` travels in the agent's argv, where `ps` can read it for as long as the step runs — keep credentials out of servers you allow.

### Token permissions

What `githubToken` needs, on a fine-grained token — a classic token needs the `repo` scope instead:

| Permission | Level | Used for |
|---|---|---|
| Contents | Read and write | reading the spec from gh-pages, and publishing it |
| Issues | Read and write | tickets, comments, labels |
| Pull requests | Read and write | review threads; closing a dropped child's pull request when a workflow that splits work re-runs its breakdown |
| Metadata | Read-only | granted automatically |

`landrace start` and `landrace mcp` both check these before doing anything else — including a one-time write of a single empty, unreferenced blob to prove Contents is writable, since a fine-grained token cannot report its own permissions the way a classic token's scopes can. A token missing something refuses to start, naming what is missing, rather than running until the first step that needs it fails midway through a paid agent run. `landrace status` never checks or writes anything — it only reads.

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

Substitution walks the **parsed document**, never its text, so a value carrying a colon, a newline or a quote lands in one string position and stays one string instead of reshaping the YAML around it. It fills in `{vars.…}` and nothing else: `{round}`, `{stage}` and `{node.title}` belong to the engine and to the step prompt, and survive untouched.

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
  - when: { "node.state.assignees": { $in: ["{vars.assignee}"] } }
    else: "assigned to somebody else"
```

One workflow directory, one graph, one set of step files. A ticket assigned to somebody else is skipped with that `else` as the reason `status` prints beside it, nothing is invoked and nothing is written to it — and a ticket assigned to nobody is skipped by everybody rather than worked by everybody, because `node.state.assignees` is an empty list rather than an absent path.

The skip costs one request for the whole repository, not one per ticket: a source's `list()` returns a `Graph`, and every ticket `Node` in it carries `assignees` beside `labels` in `state`, so the rule is answered from what `list` already returned, before any issue is fetched and before the per-ticket lock is taken. A source hook must fill it — empty when nobody is assigned — for the same reason a pre hook must: a rule the tick cannot answer abstains, and abstaining means eligible.

### `.landrace/workflow.yaml` — the process

The whole graph, in one readable file. Stages declare **what activates them**, so adding a stage never means editing its predecessor.

The shipped workflow is a single flow with one entry stage, `spec`: every ticket is specified, approved, built and reviewed as one piece of work. A workflow may have several `entry: true` stages — say `spec` for tickets a person made (`"node.origin": null`) and `build` for children a breakdown created, once their parent waits on them, as [`tests/fixtures/children`](tests/fixtures/children/workflow.yaml) does. A ticket with no position then enters the one whose `"run.stage": null` trigger matches it; none, or more than one, halts. With a single entry stage, it is entered unconditionally, as before.

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

### Splitting work into sub-tickets

Splitting is an engine feature a project enables in its own workflow; the shipped `.landrace/` workflow does not use it. [`tests/fixtures/children`](tests/fixtures/children/workflow.yaml) is the worked example — the shipped flow plus a `breakdown` stage between `triage` and `build`, a `children-running` stage the parent waits in, `build` as a second entry for the children, and `done` closing a finished ticket so its parent can count it — and it is what the tests drive to keep the feature working.

A step that declares `capabilities: [tickets:create]` — the fixture's `breakdown` stage — is handed exactly one landrace tool beside the servers `agent.mcp` allows, `landrace_create_child` (`title`, `body`, `priority` 0–9), served by a second server the executor starts beside the agent process: `landrace mcp --workflow <dir> --child <parent> --stage <stage> --round <round>`. That binding is fixed on the command line by the runner, not by anything the agent says, and `--strict-mcp-config` keeps a `.mcp.json` inside the worktree from adding a server of its own — or a `landrace` of its own, whose create_child the allowlist would approve. `breakdown` ends by saying `children` — it called the tool at least once — or `single` — it built the spec as one piece of work directly; the two outcomes route to `children-running` and `build`, and a round that says one but did the other halts at `blocked` rather than being guessed at.

Re-running `breakdown` — after a revision, or after a crash mid-round — first drops, as not planned, every sub-ticket an earlier round of this stage created and every pull request open on them; anything already finished is left closed as it was. A sub-ticket a person opened under the parent by hand is never touched, this round or any other. The parent itself only reaches `done` once every sub-ticket still counted is closed as completed — one still open, or one an earlier round made that a person is still working, keeps the parent at `children-running`.

The child MCP server reads `.landrace/.env` from the workflow directory itself, exactly as `landrace start` does — a token exported only in the shell that ran `landrace start` never reaches this subprocess, by design, so it has to be set in `.env` or no child can ever be created. On GitHub, closing a dropped child's pull request needs the token's `Pull requests` permission to be `Read and write`, not the read-only level threads alone would need — see [Token permissions](#token-permissions).

### `.landrace/hooks/*.ts` — the integrations

Landrace ships no integrations. Talking to a tracker, publishing a page, reading a pull request — all of it is a TypeScript module in your own workflow directory, written against the `define*` contracts and listed by path:

```yaml
hooks:
  - hooks/github.ts
```

A module imports the contracts from `landrace/hooks` and exports whatever kinds it implements — `definePreHook` to observe, `definePostHook` to act, `defineArtifactHook` for something that is both, `defineSource` to enumerate tickets, `defineOperator` for the create and update an operator asks for by hand, `defineExecutor` for an agent. The loader classifies each export by the brand its helper stamped, so one module can be a whole integration; the order of the list is the order pre hooks run in. A path must resolve inside the workflow directory, symlinks included, because `workflow.yaml` is a repo file a pull request can edit.

`.landrace/hooks/github.ts` in this repository is the reference implementation: one file with the REST client, both hooks, the source and the operator. A second tracker is a sibling of it, and nothing in the engine changes — a test enforces that `src/` never names one.

A pre hook declares the snapshot paths it fills, and a source declares which relationship types it reports; `validate`'s `path-coverage` rule is answered from both together with what the engine itself always provides — `run.*`, `node`, `graph`, and `rel.<type>.in|out.*` for every type the source declares — so a predicate can only read what something actually provides. The shipped GitHub hook's pre hook provides `ticket` (`.body`, `.comments`), `entries` and `tracker.bot`; the in-memory tracker in `landrace/testing` provides the portable subset of that (no `tracker.bot`). A ticket's identity, labels and assignees are not among either — they live on the `node` the *source* reads (see [The ticket graph](#the-ticket-graph)), not on something a pre hook fetches a second time. `node.state.assignees` is a **list of logins** — GitHub's issue has a list, and the singular `assignee` it also returns is that list's first element under a second name, which disagrees with it the moment an issue has two. It is empty, never absent, when nobody is assigned: a rule reading a path a ticket does not carry is one the tick cannot answer, and it abstains on those rather than guessing.

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
Write the spec for #{node.id}: {node.title}…
```

| Key | Meaning |
|---|---|
| `capabilities` | What the agent may do — `repo:read`, `repo:write`, `tickets:create`. The first two are enforced by diffing the worktree afterwards, the third by which MCP tool the executor hands the agent — not by the flags handed to the agent, because a hook-registered executor never sees those. An unenforceable capability refuses the step rather than pretending |
| `model` | Overrides `agent.model` for this step. A cheap step should say so |
| `output.discriminator` | The field whose value picks the shape |
| `output.shapes` | What each value of the discriminator must look like. Output that matches none is a hard fail, recorded, never retried |
| `output.routes` | Where each shape goes. One route, one effect — two routes matching one output is ambiguity, and ambiguity halts |

Both schemas are strict: an unknown key fails to load rather than being ignored. A field the engine silently ignores is a lie, and this codebase had four of them until the last review.

## What `validate` proves

| Rule | Catches |
|---|---|
| schema, ids, entry | Malformed definitions, duplicate stages, no entry point, an entry stage (of several) with no `"run.stage": null` trigger |
| reachability, `unknown-stage` | A stage nothing leads to; a trigger naming a stage that does not exist |
| `dead-end`, `self-loop` | A non-terminal stage with no way out; a stage triggering on itself |
| `cycle-bound` | A loop with no counter bound — an agent that could run forever |
| `totality` | A declared output shape with nowhere to go |
| `identity` | Two stages that could both be "where the ticket is" |
| `operator` | A disallowed predicate operator, anywhere including nested |
| `path-coverage` | A predicate — in a trigger, an `identity`, a `requires` or an `eligible` rule — reading a field no hook provides |
| `vars` | A variable that does not resolve, a `{vars.x}` nothing defines, a declared variable nothing references, a variable holding a secret's value |
| `mcp` | An `agent.mcp` server with no `.mcp.json` at the repository root, a name `.mcp.json` does not define, or landrace's own operator server |

Every rule runs on every workflow. An earlier version abstained where a trigger
could fire from anywhere, which turned out to mean *always* — the entry trigger
every real workflow needs switched three rules off graph-wide. The graph rules
now work from two derived views instead: a superset that treats an unanchored
trigger as an edge from every stage, for `dead-end` and `reachability`, and the
anchored edges alone for `cycle-bound`.

## CLI

```bash
landrace start [-w <dir>] [--once] [--ui-port <port>] [--no-ui]
                                         # watch the tracker; serves the triage page on 127.0.0.1:4545
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

`start` also serves a triage page at `http://127.0.0.1:4545/` — every
candidate ticket, with its sub-tickets and pull requests nested beneath it, in
lanes: needs you, agent running now, held by another process (your MCP
conversation, another instance), waiting, and collapsed not-admitted and done.
A branch sits in the lane of its most urgent ticket, so a sub-ticket that needs
you lifts its whole branch into "Needs you", opened down to it. A search box
filters by title or id, and Collapse all / Expand all set every branch at once.
Top right, a countdown to the next scheduled
tick and a "Run next tick now" button. It polls every two seconds and costs
no tracker calls: it shows what the tick already fetched and what the
process already knows is running. `--ui-port` moves it, `--no-ui` turns it
off, and `--once` never serves it. It binds loopback only and answers only
its own host name.

The button is this page's only write: it starts a tick — and a tick can
start paid agent runs — so it is guarded beyond the Host check. It requires
a custom `x-landrace-action: tick` header, which a cross-site `<form>`
cannot set and a cross-origin `fetch` that does set triggers a CORS
preflight this server never answers with permission; and it refuses any
`Origin` other than the page's own. Neither guard is optional: together
they are what stops another website the user has open from triggering a
tick just because their browser can still reach 127.0.0.1.

The page follows the OS light/dark preference (or whatever you last toggled,
top right) with no flash on load. Each row has a menu — "Chat ▾" on rows
that need you, "…" everywhere else — with Claude Code, Claude Code (CLI), Cursor and
Codex, and a "Copy prompt" item below a divider. All four links pre-fill a chat about
that ticket, over the landrace MCP, and never send anything on their own —
picking one just opens the editor with the prompt sitting in the box. Cursor
has no per-window deep-link target, so its link opens in whatever window is
already active rather than the ticket's own checkout. "Claude Code" opens a
new session in the desktop app's Code tab (`claude://`); "Claude Code (CLI)"
opens a terminal running `claude`. The CLI's link
handler (`claude-cli://`) only registers itself once you have run an
interactive `claude` session at least once, so the first click needs that
session to have happened already, not the deep link itself.

## Security

- The agent never holds tracker credentials. It writes files; Landrace performs every external write.
- Predicate operators are allowlisted structurally, before a condition reaches the evaluator.
- Everything a step writes is escaped before posting, so an agent cannot emit Landrace's own control tokens.
- `src/core/` is provably pure — no I/O, no clock, no randomness — enforced by lint and by test.
- A step declares what it may do, and the declaration is enforced by diffing its worktree before and after — not by the flags handed to the agent, which a hook-registered executor never sees. A conversation turn is held to the same declaration as the step it continues.
- A step or turn gets exactly the MCP servers `agent.mcp` allows, strictly, and never landrace's own operator server — refused at startup by name and by command, so an agent cannot hold the tools that move its own ticket.
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
