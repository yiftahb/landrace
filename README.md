# Landrace

A local-first SDLC orchestrator. It watches an issue tracker and advances each item through an explicit, versioned workflow — using coding agents for the work and code for the decisions. An *item* is what a workflow works on — an issue, a Jira ticket, a merge request awaiting review.

> *A landrace is a variety shaped by adaptation to its local environment over generations. That is the thesis: a workflow that adapts to what your team actually ships.*

## Why

Most agent orchestrators hand the whole item to a model and hope. Landrace splits the two things apart: **the model does the work, the state machine decides what happens next.** A model never picks a transition — it produces a value, and a deterministic rule routes on it.

Four things follow from that, and they are the reason to use this rather than a prompt loop:

- **You can see why it did what it did.** Every transition is a rule in a file you can read, diff and review — not a paragraph in a prompt.
- **Every loop is bounded, and the bound is checked before anything runs.** `landrace validate` proves that each cycle in your workflow passes through a counter comparison. "The review loop terminates" is a property of the definition, not a hope.
- **A crash costs nothing.** An item's entire progress is re-derived from the tracker on every run. There is no database, no ledger, no recovery path to go stale — delete everything local and the next run rebuilds it.
- **It runs on your laptop, with your agent.** No server, no cloud sandbox, no vendor session protocol. The coding agent is a hook behind a narrow contract — a prompt in, text and a session id out — so swapping it is a hook file and a config line.

## Status

**v1, unproven against a live repository.** Every part of the loop is built and
tested — `landrace start` polls the tracker, locks an item, derives its state,
runs the step, publishes what it produced and advances the workflow. The whole
of the shipped workflow runs end to end in tests, including its failure paths.
What has not happened is a run against a real repository with a real token, so
treat the first one as a supervised experiment rather than a deployment.

| | |
|---|---|
| Decision engine, workflow format, validator | ✅ built |
| CLI: `validate`, `next`, `mcp`, `start`, `status` | ✅ built |
| MCP server: read, create, update, comment, ask, resolve, goto | ✅ built |
| Hook loader, GitHub hooks, agent execution | ✅ built |
| Integration kit (`BaseExecutor`), with Claude and Codex as native integrations | ✅ built |
| Integration kit: the shared tracker, forge and docs code, out of the GitHub hook | ✅ built |
| Integration kit: tracker, forge and docs bases, `compose()`, and the in-memory adapter on them | ✅ built |
| GitHub on the bases (`landrace/integrations/github`), the hook one `compose()` call | ✅ built |
| Tick loop: polling, concurrency, per-item locking | ✅ built |
| Artifact publishing to GitHub Pages, PR review threads | ✅ built |
| Worktree sandbox with enforced capabilities | ✅ built |
| Conversation with a running step, over MCP | ✅ built |
| Pushing the item's branch and opening its pull request | ✅ built |
| Containers, OpenTelemetry, a second tracker | ⏳ planned |

## Install

```bash
pnpm install
pnpm build
node dist/cli.js --help
```

Requires Node 22 or newer. Landrace uses native type stripping and deliberately ships no TypeScript runtime.

### Upgrading from "ticket" to "item"

Every "ticket" in code, prompts, MCP and the board is now an "item". Data on trackers is unchanged: labels, markers, branches and relationship names are as they were, so items in flight keep working.

After upgrading, rebuild, restart `landrace start`, reconnect the MCP client (`/mcp` in Claude Code), and reload any open board tab (an old tab's script draws items as plain links until reloaded). Then, where it applies:

- **MCP tools:** `landrace_create_ticket` is `landrace_create_item` and `landrace_update_ticket` is `landrace_update_item`; every `ticket` parameter is `item`. Board routes `/tickets/<id>/…` are `/items/<id>/…`.
- **Workflow files:** placeholders `{ticket…}` are `{item…}` and the capability `tickets:create` is `items:create`. `landrace validate` reports each with its new name.
- **Telemetry (when enabled):** events `ticket.evaluated`, `ticket.skipped` and `ticket.aborted` are `item.*`; attributes `landrace.ticket` and `landrace.tickets` are `landrace.item` and `landrace.items`. No old names are kept, so re-key dashboards and alerts.
- **Hook authors:** `ctx.ticket` is `ctx.item`, `NotifyEvent.ticket` is `NotifyEvent.item`, `Operator.createTicket` and `updateTicket` are `createItem` and `updateItem`, `BaseTracker`'s `tickets()` and `ticket()` are `items()` and `item()`, `TicketRecord` is `ItemRecord`, `TicketPatch` is `ItemPatch`, and `ticketNode` is `itemNode`.
- **Notion:** the database column stays named `Ticket`, so existing databases keep working.

### Upgrading to workspaces

`.landrace/` is now a workspace of `workflows/<id>/` folders, each with its own `workflow.yaml` and `steps/`. To move an existing project:

- Move `.landrace/workflow.yaml` and `.landrace/steps/` to `.landrace/workflows/main/`.
- Hook paths in `hooks:` gain `../../`, since they are relative to the workflow's folder: `../../hooks/github.ts`.
- Add `description:`, which is required.
- Add `admit: [lr:auto]` (or the label your project uses). Without it `landrace_create_item` with `start` is refused, and child items created by an `items:create` step get no admission labels and are never worked.
- `--workflow <dir>` became `--workspace <dir>`, and `next --workflow` now takes a workflow id.

Then rebuild, restart `landrace start`, and reconnect the MCP client (`/mcp` in Claude Code).

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
items — including the workflow's own reason for skipping one.

Escalate in that order the first time. `start --once` runs a single tick and
exits, and `--debug` prints the assembled snapshot, the planned effects and the
agent subprocess's own output, so you can watch a decision before it becomes a
write. **A step invocation spends real money**; the round caps are the `$lt`
counters in your workflow — on its triggers, and on the `when` of each `goto`
entry — not something the engine imposes.

Landrace only touches items your `eligible` rule admits — in the shipped
workflow, those labelled `lr:auto`. Everything else is listed and skipped.

To stop a step while it runs, close its item or take `lr:auto` off it (from
Landrace, `landrace_update_item` with `state: closed`). The next tick that
lists it kills the agent's process group and logs `item.aborted`; the
stopped round writes nothing to the item, so putting `lr:auto` back runs
that same round again. An item the tracker stops listing is left running.

To drive items from your editor, generate the MCP config:

```bash
agsync sync
```

The server is defined in `.agsync/mcp/landrace.yaml` and `agsync` writes it out per agent — `.mcp.json` for Claude, `.codex/config.toml` for Codex. The generated files are gitignored, so run `agsync sync` after cloning.

Then ask your client things like *"what's waiting on me?"*, *"open an item for CSV export"*, or *"reply on #12 that the scope is too broad"*.

**Item identifiers:** An item id is 1–64 letters, digits, `.`, `_` or `-`; numbers are still accepted from MCP clients.

## How it works

Each run builds a **snapshot** of one item from external records, decides, and acts:

```
observe  →  snapshot  →  [ pure decision ]  →  effects  →  act
```

Nothing about progress is stored locally. Position comes from a label, rounds from counting records, findings from review threads. That is what makes recovery re-derivation rather than repair.

The decision itself is five pure steps: locate the item's stage, assess whether that stage's step has finished, decide, plan the effects of the state being entered, and drop the effects the world already satisfies. **Ambiguity always halts** — two stages that both match, or two triggers that both fire, stop the item rather than picking one.

## The item graph

A source doesn't hand the engine one flat item — it hands back a **graph**: the item's own node, and every other node related to it.

```ts
interface Node {
  id: string;
  kind: string;              // "item", "pull-request", or whatever your source names
  title: string;
  link: string;
  closed: null | "done" | "dropped";
  priority: number | null;
  origin: Origin | null;
  state: { [key: string]: Json };   // whatever the source wants a predicate to read
  createdAt?: number;        // epoch ms, for the board's "opened 3h ago" only — no workflow can route on it
  updatedAt?: number;        // epoch ms, when it last changed — the board's lane order only, likewise
}

interface Relationship { from: string; to: string; type: string }
interface Graph { nodes: Node[]; relationships: Relationship[] }
```

A `Source` has two methods, both returning a `Graph`. `list()` runs once per tick — every candidate node, which is what `eligible`, `status` and the triage page answer from, before any per-item work starts. `read(id)` runs once per converge pass, for one item's own neighbourhood — itself, its ancestors, its descendants, and everything related to it — and is what a trigger actually decides from.

The snapshot carries three views built from that graph: `node` is the item's own node, `graph` is the whole neighbourhood `read` returned, and `rel.<type>.in|out` is a set of counts over every relationship of `<type>` pointing in (`in`) or out (`out`) of the item:

| Field | Meaning |
|---|---|
| `rel.<type>.in.total` | How many related nodes |
| `rel.<type>.in.is.<field>` | How many where `state.<field>` is the boolean `true` — not merely truthy |
| `rel.<type>.in.not.<field>` | How many where it is the boolean `false`; a non-boolean value counts in neither |
| `rel.<type>.in.sum.<field>` | That field, summed across every related node |
| `rel.<type>.in.stage.<id>` | How many related items currently sit at stage `<id>` |

A source declares which relationship types it reports, and whether a node may have at most one outgoing edge of one (`relations: RelationDecl[]`); the engine refuses any other type, and `rel` counts zero — never nothing — for a declared type nothing relates, so "no thread awaits a fix" can still be read when every pull request is merged.

The shipped GitHub hook reports two relationship types: `child-of` (a sub-issue to its parent, singular) and `implements` (a pull request to the item it closes or whose branch names it, singular). A pull request is a node like any other — `kind: "pull-request"`, `state.merged`, `state.openThreads`, `state.awaitingFix`, and the branch it is from as `state.branch` — and "every pull request on the item is merged" is `rel.implements.in.total: { $gt: 0 }` **and** `rel.implements.in.not.merged: 0`, never one pull request's own flag, because an item can carry more than one. `awaitingFix` counts the unresolved threads whose last comment is not `fix-review`'s answer — one Landrace wrote, ending in a `fix` marker — and the shipped workflow routes on it rather than on `openThreads`: see [Review threads are a conversation](#review-threads-are-a-conversation). Only an *open* pull request's threads are counted: a merged or closed one reports `openThreads: 0` and `awaitingFix: 0`, never nothing, so the sum stays defined — and readable as "clear" — once every pull request on the item is done.

A pull request's checks on its head commit are `state.checks`: `pending`, `success`, `failure`, or `none` when nothing is configured to check it, or nothing has started yet. A string is never counted, so two numbers sit beside it, `state.ciPending` and `state.ciFailed`, each 1 or 0: `rel.implements.in.sum.ciPending` is how many of the item's pull requests still wait on CI, and `rel.implements.in.sum.ciFailed` how many are red. `none` counts as neither, and does not hold a merge back. Checks are read like threads: only an open pull request's are asked for, and a merged or closed one reports `checks: "none"` with both counts 0, at no cost. A pull request in the board's listing carries neither its thread counts nor its checks; the read an item is decided on carries both.

It also reports an item's published spec page as a `document` node, with a third relationship type, `documents`, pointing at its item (singular) — so the triage page shows the spec under its item. `list` finds every page in one listing of the `gh-pages` branch and reports none for that tick, with a logged reason, when that listing fails or GitHub truncates it — it is display only, so it never fails the tick; `read` checks the item's own page directly. The workflow still routes on `artifacts.spec`, not on this node.

Spec links — on that node, and in `artifacts.spec.url` — point at the Pages site when the repository publishes one from the root of `gh-pages`, and otherwise at the file on GitHub, which anyone who can see the repository can open.

Priority comes from this repository's own `P0`..`P9` label convention; two of them is a priority that cannot be told, and `read` halts the item rather than picking one, the same way two stage labels does. A closed item is never worked — it keeps whatever labels it had, `lr:auto` included, but only ever appears in a graph so a parent can count a finished child, never so a tick pays for a step on it. And a GitHub close reason this hook does not recognise — anything but `COMPLETED`, `NOT_PLANNED`, `DUPLICATE` or none — halts the item rather than guessing whether it is done or dropped.

A step's prompt can also ask a source for prose the graph itself does not carry — `{brief.<source id>.<key>}`, fetched only when that step is about to run, never routed on by any predicate. This repository's GitHub hooks are made by `compose`, so its source's id is `project`. `fix-review.md` and `code-review.md` read `{brief.project.threads}`: the open review threads across the item's pull requests, each named by its thread id, marked when Landrace's reviewer raised it, and said to be awaiting a fix or answered by the fixer, with its last reply — the ones awaiting a fix first, as a working list for the step to act on. `code-review.md` also reads `{brief.project.diff}`: what the item's open pull requests change, file by file, since a read-only step has no shell to run `git diff` with — 24,000 characters of patches at most, with every file past that named, to read in the worktree. `{brief.project.body}` is the item's own text, as the tracker holds it — the whole brief of fastlane's `build.md`, which has no spec to work from — without the marker Landrace stamps on an item it created, 16,000 characters at most, cut saying so, and "This item has no description beyond its title." when there is none. `{brief.project.ci}` is the open pull requests' checks: a `### pr-N: checks <state>` line for each, and under a failing one each failed check as `#### <name>` followed by the last 4,000 characters of its log, or `(log unavailable)` when the forge would not give it. A log, like each patch in `diff`, sits in a code fence longer than any run of backticks inside it, so a fence in the text cannot close it early. It is 16,000 characters at most, and says when no pull request is open. A prompt is briefed only the keys it names, and the source reads only those — so one key never spends another's budget, a review that names `threads` and `diff` never pays for a red build's checks and logs, and a key that cannot be read fails only a step that asked for it. `spec.md` and `retro.md` read `{brief.project.history}` — spec so a later round sees the questions it asked and every answer, since each round is a fresh session: one timeline, oldest first, of every comment on the item — Landrace's own shown by marker, everyone else's by login — and every review thread on every pull request tied to it, resolved or not, merged or not, placed by when it was opened, with the pull request it is on, who raised it and its last reply. It keeps the newest 100 entries — fewer when their text would pass 28,000 characters, so the engine's 32 KB cut never drops the newest — each body cut at 1,000 characters, and says how many earlier ones it left out.

An artifact can brief a step the same way. The spec artifact briefs `{brief.spec.content}` — the approved spec's own text, read off `gh-pages` — and `build.md`, `code-review.md` and `fix-review.md` embed it between two rules as the approved spec, framed as requirements rather than instructions. With no page published the text says so ("No spec has been published for this item.") instead of leaving a hole in the prompt; a page that cannot be read halts the step instead. The spec is handed over as text, never as a link to go and read: a prompt telling the agent to fetch a URL is exactly what the prompt screener refuses, and in a private repository the agent could not open the link anyway. `artifacts.spec.url` stays in those prompts only as a reference line for a person. Every briefing is escaped before it reaches a prompt and cut at 32 KB per hook — a cut says it was cut — so a long spec cannot crowd the review threads out of a fix round's prompt.

## Structure

```
src/namespace.ts     every type in the system, and nothing else
src/core/            the decision engine — pure, and enforced: no I/O, no clock,
                     no randomness. Time arrives as `snapshot.now`
src/workflow/        load and validate workflow definitions
src/hooks/           the define* contracts, and the loader that imports yours
src/kit/             `landrace/kit` — BaseExecutor, what every coding agent integration shares;
                     BaseTracker, BaseForge, BaseDocs and compose() for the other integrations,
                     and the tracker, forge, docs and git code they are made of
src/agent/           prompt screening, the worktree sandbox
src/runner/          tick, converge, step, lock, effect dispatch, events
src/config/          landrace.yaml + .env
src/telemetry/       OpenTelemetry export of events, loaded only when it is on
src/mcp/             operator tools over stdio
src/cli/             validate, next, mcp, start, status
src/testing/         the harness, for testing a workflow of your own
src/conventions.ts   label and marker vocabulary, shared by every hook
src/sandbox.ts       repository identity; the tmp root locks and worktrees share

integrations/        the integrations landrace ships: claude/ and codex/ on the kit, github/ on its
                     tracker, forge and docs bases, and slack/ (`landrace/integrations/<vendor>`).
                     Not part of the engine

.landrace/
  landrace.yaml      runtime — how agents run, where items live
  workflows/<id>/    one folder per workflow; a workspace holds one or several
    workflow.yaml    the process — one graph, stages declaring what activates them
    steps/*.md       the work — front matter is the contract, the body is the prompt
  hooks/*.ts         this project's integrations, shared by every workflow — GitHub's three roles `compose`d, `new Claude()` and the Slack re-export. Not part of the engine
  .env               secrets, gitignored, and `validate` fails if it is not
```

Imports inside `src/` and `tests/` go through the `imports` map in `package.json`
— `#core/index.js`, `#namespace.js` — so nothing walks up the tree. Hooks import
`landrace/hooks`, and hooks and integrations `landrace/kit` too, which is what an external
author writes; `integrations/` may import nothing else but `node:*`, and a test
holds it to that.

## Configuration

### `.landrace/landrace.yaml` — the runtime

How agents run and where items live. Portable workflows keep none of this.

| Key | Default | Meaning |
|---|---|---|
| `agent.adapter` | — | Which executor runs steps and conversation turns: an id a hook registers with `defineExecutor`. This repository's is `claude`, from `.landrace/hooks/claude.ts`; `codex` is the other integration landrace ships |
| `agent.isolation` | `worktree` | `none`, `worktree`, or `container` — how the engine prepares the directory a step runs in |
| `agent.*` (anything else) | — | Passed unread to the executor `agent.adapter` names. Both shipped integrations read `model`, `effort`, `mcp` and `sandbox`, and refuse any other key; Claude also reads `plugins`. `effort` is `low`, `medium`, `high`, `xhigh` or `max` for Claude, `none`, `low`, `medium`, `high` or `xhigh` for Codex — see [Codex](#codex) for what else it refuses |
| `tracker.*` | — | Opaque to the engine, handed to your hooks unread. The shipped GitHub hook reads `tracker.repo` (`owner/name`) and optionally `tracker.bot` — which a GitHub App token needs (e.g. `myapp`), since it cannot look up its own login; logins compare ignoring case and a trailing `[bot]` |
| `tick.interval` | `60s` | How often to run |
| `tick.concurrency` | `3` | Items acted on at once |
| `security.screen` | `true` | Screen each prompt for injection before invoking an agent that can act (a step declaring any capability, or an MCP turn) |
| `security.adapter` | `agent.adapter` | Which executor screens: an id a hook registers with `defineExecutor`, `claude` in this repository. It gets no tools, which it must enforce or refuse the run |
| `security.model` | — | The model the screening run asks for. No default: absent, the screening executor's own default decides |
| `log.redact` | `[]` | Secret names whose values must never be logged |
| `secrets.*` | — | `$VAR` references resolved from `.landrace/.env`, handed to hooks as values |
| `workflows` | by workflow `name` (character-code order), then folder id | The order the workflows are listed in; display only. It must name exactly the folders under `workflows/`: a name with no folder, a folder not named, or a name twice is refused |
| `vars.*` | — | `$VAR` references resolved the same way and substituted into `workflow.yaml` and the step files wherever `{vars.<name>}` appears. **Not secrets:** nothing redacts them |
| `notify.on` | — | The events to tell a person about. One exists: `needs-you` |
| `notify.via` | — | Notifier ids, each registered by a hook with `defineNotifier`. This repository's is `slack`, shipped as `landrace/integrations/slack` and re-exported by `.landrace/hooks/slack.ts`. An id no loaded notifier answers to is refused by `start` and reported by `validate` |

#### `notify:` — being told an item needs you

Every stop waits on a person, and until something tells them, the only sign is the Needs you lane. With a `notify:` block, an item that comes to rest in Needs you — the board's own rule, so the two never disagree — is announced once through each notifier `via` names: `#29 needs you in <workflow> — <title> · <why>`, where workflow is the `name` of the workflow that owns the item and why is the board's note (`waiting on you`, `blocked by a security check`, …). An item that stays there is not announced again; one that leaves and comes back is. An item that arrives at a `waits: person` stage placed by state is announced once too, by the tick, after its converge, and only when it settled waiting on its first pass of the converge (nothing moved it on first) or its lock was held elsewhere — a stage placed by a label is announced on its transition, as before. A tick whose converge halts, fails or moves the item on announces nothing and does not count it as seen, so the next tick that finds it waiting there announces it. The engine keeps nothing, so after a restart — and on every `start --once`, a process of its own each time — each item already waiting at a stage placed by state is announced once more. An item passing through `triage` on its way back is never announced: `triage` runs its step at once. Sending is fire-and-forget — a notifier that fails is a `notify.failed` line in the log and nothing more, it never stops an item, and nothing is kept about what was sent.

```yaml
notify:
  on: [needs-you]
  via: [slack]
```

### What a step's agent is handed

A step's `capabilities` decide how the Claude integration starts the agent (for Codex, see [Codex](#codex)):

| Step declares | Permission mode | Also |
|---|---|---|
| no `repo:write` (read-only) | `manual` | `--restricted`, and `Bash`, `Edit`, `MultiEdit`, `NotebookEdit`, `Write` denied by name |
| `repo:write` | `acceptEdits` | Bash and every other tool, with each command it runs inside Claude Code's sandbox — see [A write step's sandbox](#a-write-steps-sandbox) |
| — (the screener, which declares nothing) | `manual` | `--restricted`, `--tools ""` (no built-in tool at all), and an empty strict MCP config |

Neither read-only steps nor the screener run in plan mode. Checked against the real CLI (2.1.282), plan mode refuses every MCP call — the codebase graph and `create_child` alike — and ignores `--model`, running a different model from the one the step asked for — the screener configured as `security.model: haiku` was screening on sonnet. Manual mode with the write and exec tools denied honours both, and refuses a write attempted under it. The worktree diff after the run stays the backstop either way.

`--restricted` ignores your own Claude settings, and with them every plugin you enabled there, so a read-only step has none unless `agent.plugins` names it. The list goes to the agent as one inline `--settings` document.

Every step and turn runs with `--strict-mcp-config`: it gets exactly the servers `agent.mcp` names, as `.mcp.json` defines them (`env` included) — and nothing from a `.mcp.json` committed to the repository, from your user-level config, or from anywhere else. With an empty `agent.mcp` it gets no server at all. A step holding `create_child` gets its bound child server beside them.

**An allowlisted server is not read-only because the step is.** A bare name is allowed as `mcp__<name>` — every tool the server has, whatever it does. For the codebase graph that includes indexing any path it is handed (which writes its index there), deleting a project, rewriting ADRs, ingesting traces, and reading any project indexed on this machine — your own checkout, uncommitted work included. List the tools instead:

```yaml
agent:
  mcp:
    - name: codebase-memory-mcp
      tools: [search_graph, trace_path, get_code_snippet, query_graph, get_architecture,
              search_code, get_graph_schema, index_status, list_projects, index_repository]
```

Then only `mcp__codebase-memory-mcp__<tool>` for each listed tool is allowed. That is this repository's own configuration, and it still leaves two things open: `index_repository` is there because a step's fresh worktree is not indexed yet, so a step can still index a path of its choosing; and the reading tools take a project, so a step can still read any project already indexed on the machine. A tool name follows the same rule as a server name — letters, digits, `.`, `_`, `-` — and an entry with an empty list, or a server named twice, is refused.

Servers are resolved once, at startup, from the **repository root's** `.mcp.json` — the file agsync generates, not anything in the step's worktree. `landrace start` and `landrace mcp` refuse to start, and `landrace validate` reports the same sentence, when:

- `agent.mcp` names a server but there is no `.mcp.json` at the repository root — run `agsync sync`, which generates it;
- a name is not in `.mcp.json` — the refusal lists the names it does define;
- a name is landrace's own operator server: `landrace`, or a server whose command line runs `landrace mcp` — the bin, `npx landrace@<version>` or `landrace#<ref>`, the `cli` entry with or without its extension, quoted, after `--`, or inside `sh -c`, in any case. Its tools create, update and reply on items, and a step agent holding them could move its own item. The command match is defence in depth over configuration you already trust, not a guarantee: a wrapper script under another name gets past it, so do not allow one.

Three things this does not do:

- **A different executor may read none of it.** `agent.mcp` is read by the kit, so both shipped integrations resolve it exactly this way; `agent.plugins` is Claude's alone, and Codex refuses it. An `agent.adapter` naming a hook not built on the kit gets the same `agent:` block passed on unread, and owes these keys no meaning of its own.
- **A definition's relative paths are not rebased.** A server is resolved from the root's `.mcp.json` but started by the agent's CLI in the step's working directory — its worktree — so a relative `command` or argument in that definition resolves there, against committed files only. Use absolute paths or commands on `PATH`.
- **A plugin's hooks still run.** `--restricted` ignores your settings files but not the hooks an enabled plugin ships, so every plugin in `agent.plugins` runs its hooks under read-only steps too. Enable only plugins you would let run there.

`landrace status` runs no step, so it resolves none of this and works without a `.mcp.json`. The screener never gets plugins, servers or tools: it reads attacker-reachable text and needs nothing to judge it. An allowlisted server's `env` and `headers` travel in the agent's argv, where `ps` can read them for as long as the step runs — keep credentials out of servers you allow. Their values, 8 characters or longer, are redacted from landrace's own log like a declared secret's, since an agent that fails to start a server can echo them into the error the loop logs.

### A write step's sandbox

A step declaring `repo:write` runs Bash. In this repository that is `build`, `fix-review` and `retro`: each merges `origin/main`, installs, runs the tests, commits, and pushes its own branch. The Claude integration starts every command such a step runs inside Claude Code's sandbox (Seatbelt on macOS, bubblewrap on Linux):

```yaml
agent:
  sandbox:
    hosts: [github.com, registry.npmjs.org]   # the only network a write step reaches
    deny:  [~/.config/gh, ~/.ssh, ~/.aws, ~/.npmrc]
```

- **Writes** land only in the step's worktree and in the repository's shared `.git`. They never land in your checkout, your home, `.git/hooks` or `.git/config`.
- **Network** governs commands, not every tool. The sandbox's allowlist confines what Bash (and anything else it runs) can reach, to `hosts` as written: a host name, or the sandbox's own `*.example.com` wildcard, with no scheme, port or path. With no `hosts`, a write step's commands have no network at all, and cannot fetch or push. In-process tools such as WebFetch and WebSearch do not go through the sandbox at all — they follow Claude Code's own permission rules instead, which deny them outright under `-p` unless your settings allow them.
- **Reads** are refused under each `deny` path. The sandbox refuses them for commands, and a `Read` rule refuses them for the Read tool, which the sandbox does not cover. A path starts with `~/`.
  - With no `deny`, the four paths above apply.
  - A list you write replaces them, so keep the ones you still want.
- **No way out.** If the sandbox cannot start, the step is refused rather than run unconfined, and no command may ask to run outside it.
- **Strict keys.** `sandbox` takes `hosts` and `deny` and nothing else. A misspelt key is refused at startup, like every other key the hook reads.
- **Read-only steps and the screener get none of it.** They have no Bash to confine.

What it does not do:

- **It pushes with your git credentials.** `git push` goes through your own credential helper, and a command in the sandbox can ask that helper for the credential (`git credential fill`) as readily as `git push` can. The tracker's token never reaches the agent; your git credential for the listed hosts does. Use one scoped to what a step may push.
- **Nothing but the prompt keeps a step to its own branch.** With that credential and the host, `git push` can reach any branch on `origin`. Because the shared `.git` is writable, `git update-ref` can move any local branch. So protect `main` on the forge before you run write steps. On GitHub, that is a branch protection rule on `main` that refuses direct pushes.
- **Your own user settings still load — but only those.** A write step does not run `--restricted`, so it loads your own user-level Claude settings beside these. The worktree's own `.claude/settings.json` and `.claude/settings.local.json` do not: a step could commit one to the item branch, and its hooks run outside the sandbox entirely, on the very next write step that checks that branch out — so a write run passes `--setting-sources user` to keep to your user settings alone. A path in your own `sandbox.filesystem.allowRead` still takes precedence over a `denyRead` this hook set, a command in your `sandbox.excludedCommands` still runs outside the sandbox entirely, and a host in your `sandbox.network.allowedDomains`, or any other sandbox key this hook does not set, still applies to the step too.

### Token permissions

What `githubToken` needs, on a fine-grained token — a classic token needs the `repo` scope instead:

| Permission | Level | Used for |
|---|---|---|
| Contents | Read and write | reading the spec from gh-pages, and publishing it; pushing an item's branch to an `https://github.com` origin; merging a pull request |
| Workflows | Read and write | only when a build changes anything under `.github/workflows/` — GitHub refuses a push that does without it |
| Issues | Read and write | items, comments, labels |
| Pull requests | Read and write | opening an item's pull request; review threads; merging it; closing a dropped child's pull request when a workflow that splits work re-runs its breakdown |
| Checks | Read-only | a pull request's CI state on its head commit, and its failed check runs — read on every open pull request |
| Commit statuses | Read-only | the same, for services that report as a status and not a check run |
| Actions | Read-only | the log of a failed GitHub Actions job, for the `{brief.project.ci}` briefing; without it the check is still named, with `(log unavailable)` |
| Metadata | Read-only | granted automatically |

`landrace start` and `landrace mcp` both check these before doing anything else — including a one-time write of a single empty, unreferenced blob to prove Contents is writable, since a fine-grained token cannot report its own permissions the way a classic token's scopes can. Both also read one commit's check runs and statuses, since every read of an open pull request asks for its checks and a token without Checks or Commit statuses would fail them all — naming every one of the two it lacks in one sentence, so a token missing both is told so at one start rather than two; Actions is the one thing not checked, because a log is optional. A token missing something refuses to start, naming what is missing, rather than running until the first step that needs it fails midway through a paid agent run. `landrace status` never checks or writes anything — it only reads.

### `.landrace/.env` — secrets

Referenced by name from `landrace.yaml`, resolved at load, and handed to hooks as values — a hook never reads `process.env` itself, which is what makes it testable and what lets redaction know every value to suppress. A `.env` here takes precedence over your shell, because a project's own file should be what runs.

This repository's `landrace.yaml` declares three: `GITHUB_TOKEN`, and two for Slack — `SLACK_WEBHOOK_URL`, an incoming webhook (a Slack app → Incoming Webhooks), which is the credential and is redacted from the log; and `SLACK_NOTIFY_USER`, your member id (`U…`, from your profile's ⋮ → Copy member ID), so the post mentions you. `.env.example` lists them all.

`validate` fails if this file exists and git does not ignore it.

### Telemetry — OpenTelemetry

Off by default. When on, every event — `tick.*`, `step.*`, `effect.*`, `lock.*`, `screen.*`, `notify.*`, and `agent.event` and `snapshot.built` whether or not `--debug` is on — is sent to a collector as an OTel **log record**, the way Claude Code exports its own events. The body and the `event.name` attribute are the event's name; every other field becomes an attribute prefixed `landrace.` (`landrace.item`, and the agent's output in `landrace.raw`), JSON-encoded if it is not a string, number or boolean. `*.failed`, `*.denied`, `*.blocked` and `lock.stolen` are `WARN`, everything else `INFO`. Records carry the same redaction stdout does. Traces and metrics are not exported.

| Variable | Meaning | Default |
|---|---|---|
| `LANDRACE_ENABLE_TELEMETRY` | `1` turns export on | off |
| `OTEL_LOGS_EXPORTER` | `otlp` or `console` | `otlp` |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` or `http/json`; `grpc` is refused | `http/protobuf` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | collector base URL; `/v1/logs` is appended | `http://localhost:4318` |
| `OTEL_EXPORTER_OTLP_HEADERS` | `k=v,k=v`, e.g. auth, values percent-decoded | none |
| `OTEL_SERVICE_NAME` | `service.name` | `landrace` |
| `OTEL_RESOURCE_ATTRIBUTES` | `k=v,k=v`, extra resource attributes | none |
| `OTEL_LOGS_EXPORT_INTERVAL` | batch delay, in milliseconds | `5000` |

Set them in `.landrace/.env` or your shell (`.env` wins, as for secrets), or on the command line, which wins over both: `landrace start --telemetry` sets `LANDRACE_ENABLE_TELEMETRY=1`, and `--otel KEY=VALUE`, repeatable, sets any key in the table — any other key is a startup error. `landrace mcp` reads `.env` and the shell only, and refuses `OTEL_LOGS_EXPORTER=console`, which would write into its protocol on stdout. `landrace status` never exports.

`landrace start` flushes the batch on `--once`, a normal stop and the first Ctrl-C; the second Ctrl-C exits without waiting. An export that fails says so once on stderr, and again only after one has succeeded. None of these settings reach the agent subprocess: `OTEL_EXPORTER_OTLP_HEADERS` is usually a credential.

To see it work, run a collector with the `debug` exporter on `:4318`, then `landrace start --once --telemetry`.

### `vars` — one workflow, several instances

```yaml
vars:
  assignee: $LANDRACE_ASSIGNEE
  team: platform
```

Wherever `{vars.<name>}` appears in `workflow.yaml` or a step file — a predicate operand, an effect field, a prompt — it is replaced at load with the resolved value. Everything downstream then sees a literal exactly as if it had been typed: the schema, the operator allowlist, `path-coverage`, and the predicate itself.

Substitution walks the **parsed document**, never its text, so a value carrying a colon, a newline or a quote lands in one string position and stays one string instead of reshaping the YAML around it. It fills in `{vars.…}` and nothing else: `{round}`, `{stage}` and `{node.title}` belong to the engine and to the step prompt, and survive untouched.

Variables are configuration, not state. They do not vary per item, so they are deliberately **not** in the snapshot — comparing one snapshot path against another would need `$expr`, which is outside the operator allowlist on purpose.

Every mistake is a load error, never a default:

- a variable whose reference does not resolve, **or resolves to an empty value**, is refused by name. Never `""` and never the literal `$LANDRACE_ASSIGNEE`: a predicate filled in with nothing matches no item, and "the repository where nothing ever happens" is the hardest failure there is to read.
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

One workflow directory, one graph, one set of step files. An item assigned to somebody else is skipped with that `else` as the reason `status` prints beside it, nothing is invoked and nothing is written to it — and an item assigned to nobody is skipped by everybody rather than worked by everybody, because `node.state.assignees` is an empty list rather than an absent path.

The skip costs one request for the whole repository, not one per item: a source's `list()` returns a `Graph`, and every item `Node` in it carries `assignees` beside `labels` in `state`, so the rule is answered from what `list` already returned, before any issue is fetched and before the per-item lock is taken. A source hook must fill it — empty when nobody is assigned — for the same reason a pre hook must: a rule the tick cannot answer abstains, and abstaining means eligible.

### `.landrace/workflows/<id>/workflow.yaml` — the process

The whole graph, in one readable file. Stages declare **what activates them**, so adding a stage never means editing its predecessor.

The shipped `main` workflow is a single flow with one entry stage, `spec`: every item is specified, approved, built and reviewed as one piece of work. A workflow may have several `entry: true` stages — say `spec` for items a person made (`"node.origin": null`) and `build` for children a breakdown created, once their parent waits on them, as [`tests/fixtures/children`](tests/fixtures/children/workflow.yaml) does. An item with no position then enters the one whose `"run.stage": null` trigger matches it; none, or more than one, halts. With a single entry stage, it is entered unconditionally, as before.

A stage may say `waits: person` — it is a person's turn, and `validate` refuses it on a stage that runs a `step`, since a person's turn runs no agent, and on a `terminal` stage, where an item's work is done. That, and not the `lr:awaiting` label the shipped workflow's `on_enter` still writes for whoever reads the tracker, is what puts an item in Needs you: the board, the notifications, `landrace status` and the MCP's `landrace_waiting` and `landrace_status` all read the `waits` of the stage the item is located at. Main's `spec-questions`, `spec-human-review` and `pr-human-review` carry it, and [fastlane](#fastlane)'s `stuck`.

**The located stage.** An item's stage is found from the listed item alone: the `lr:stage:` label's stage, and every stage whose `identity` the item's own fields satisfy. A stage with no `identity` of its own is placed by that label (`"run.stage": <id>`); a label and an identity naming different stages is a contradiction, which halts the item, and a goto or pairing is refused for it. A stage placed only by an identity, with no label, gets its run history — a pending goto, failed rounds, the last refusal — read as that stage's, `run.stage` reads it, and goto, Clear & retry and pairing work from it — except at a stage whose identity requires `"run.stage": null`, an item nothing has been written to: moving it from there would write, so those are refused there, saying so.

### Read-only workflows

A stage is *placed by state* when its `identity` reads only the item's own fields — `node.*`, optionally with `"run.stage": null` — and not a counter or an output a step wrote. Its relations (`rel.*`) do not count, though the tracker holds them too: Needs you, the notifications and the MCP place an item from the listed item alone, which carries none, so a stage placed by `rel.*` needs an entry stage beside it. A stage placed by state needs no trigger to be reachable: an item is at it because its fields say so, and leaves it when they stop saying so. A workflow whose every open (non-terminal) stage is placed this way needs no entry stage; one stage placed any other way brings back the need for one. If, besides, none of its stages runs a step, has a trigger, has an `on_enter` or is an entry stage, it writes nothing — no transitions, no entry records, no step outputs — so it runs over a tracker it may only read. A step's output, a transition a trigger takes, an `on_enter` and entering an unplaced item are each a write. In such a workflow, with no entry stage, an item no identity places halts, saying that no stage places it — a halt the board, `landrace status` and the MCP's `landrace_waiting` file under Needs you — and nothing is written; with an entry stage, an unplaced item is entered, which is a write, so such a workflow is not read-only. `validate`'s `identity` rule reports two such identities only for an item it can construct that both place and the engine's own compiler confirms; where it cannot tell, it abstains — except beside a stage placed by its label alone, which an identity reading no `run.stage` overlaps unless it can never hold, so that pair is reported even where no item can be built.

[`tests/fixtures/review`](tests/fixtures/review/workflow.yaml) is the shape of a "merge requests waiting for my review" workflow: `eligible` admits the items labelled `review-requested`, `reviewing` (`waits: person`) places those not yet `approved`, and the terminal `approved` places the rest, so an item comes into Needs you and leaves it by its own labels alone. A company's definition would read the same way over its own source.

Beside `stages`, the file's header says what the workflow is and what it admits:

| Key | Meaning |
|---|---|
| `name` | The display title |
| `description` | Required. What the workflow is for, in a sentence; it is what an agent sees when it chooses where to start an item |
| `admit` | The labels an item gets when it is started into this workflow, by `landrace_create_item` or as the child an `items:create` step files. The engine names none of its own. `validate` checks them against `eligible` when that rule is label-only, so a workflow cannot admit an item it would then skip |
| `hooks` | Paths of the hook modules, in the order pre hooks run |

Every path in the file, hook or step, is relative to the workflow's own folder and must resolve inside `.landrace/`, symlinks included. `../../hooks/github.ts` reaches the folder every workflow shares; a path that climbs out of `.landrace/` is refused, and so is a workflow folder that is itself a symlink.

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

A step whose round fails is never retried; the item halts, and there are two halts, one each for the two ways a round fails. A round whose output broke its contract — no json block, an undeclared shape, too long to record — is recorded as `malformed` and goes to `blocked` (`lr:blocked`). A round a security check stopped — the prompt screener said no or could not run, or the agent changed a worktree or created an item it had not declared it could — is recorded as `refused`, headed "Step refused by a security check" with the reason, and goes to `screened`, which wears `lr:screened` beside `lr:blocked`: it is still blocked for everything that asks, and says why. The split is `run.lastRefused`, derived beside `run.lastOutputValid` and scoped the same way — `false` for a broken contract, `true` for a refusal, `null` when the current stage has not failed — so exactly one of the two triggers takes any failure. Every other trigger leaving a stage that runs a step reads `"run.lastOutputValid": null`: a failed round is only ever the halts' to route.

**Clearing a refused step.** The screener is a model reading the whole rendered prompt, template included, and it can refuse a prompt that is fine — #39's spec was refused twice for its own template's wording. A person can overrule it, and only a person: the board's "Clear & retry" (offered beside Retry on a screened item) or `landrace_clear`, never a reply — a comment is text anyone can write, and an injection that could clear itself would make the screener decoration. It writes a `cleared` record naming exactly the round the retry will run (`cleared:<stage>:<round>`), then the same goto Retry writes; that round runs without prompt screening and logs `screen.cleared`, and every later round is screened as ever. `run.cleared` derives it from the records, and anything written on the item after the clearance voids it, so new text never reaches a prompt unread. It is refused on an item no security check stopped (`lr:screened`), and nothing is written where the goto itself would be refused. The agent's confinement does not change: the sandbox, the capability checks and the worktree diff still hold for a cleared round.

Wherever it is a person's turn — `spec-questions`, `spec-human-review`, `pr-human-review`, `blocked`, `screened` — a reply goes to `triage`, one judge for all five. It reads the reply into a closed set of answers: `approve`, `revise`, `rework`, `question`, `unclear`, `goto-spec`, `goto-build`. An answer that changes nothing where the reply was made sends the item back there; `run.previousStage` says where, read off `triage`'s own entry record. At `pr-human-review`, `revise` — a change asked for on the pull request — sends the item to `spec` first, as often as a person asks: that round is shown the approved spec and the message, amends the spec with just that change, and goes straight to `build`, since the person asked for exactly it. So `build`, `code-review` and `fix-review` all read the change from the one authority they already check against — on #27 a request that reached `build` alone was flagged against the unchanged spec and reverted. Work asked for there that changes no requirement — resolve the conflicts, get a failing check green — is `rework` instead, and goes straight to `fix-review`, which already merges main and runs the checks; it is shown the message only when a reply sent the round (`run.previousStage` is `triage`), never on a round the reviewer's threads sent. On #34 "Resolve conflicts first." was read as `revise` and spent a spec round amending nothing. A spec redone from scratch after a pull request exists (`goto-spec`, "Go to step… spec") is reviewed at `spec-human-review` as ever. At a halt, `triage` is also told which step failed — `run.failedStage`, the failure that put the item there, never an older one it has since been sent around, and `none` when there is none — and "try again" there means that step when it was `spec` or `build` — for any other failure, that is the board's Retry to retry, not a reply's to say. `triage` has no round cap: each round waits for a person's own message, so a conversation is bounded by the person having it.

A person can also send an item back to an earlier step. `spec-questions`, `spec-human-review`, `pr-human-review` and `triage` itself list, under `goto`, the same two steps a `goto-spec` or `goto-build` answer may reach — `spec` and `build`, each while it has run fewer than three rounds:

```yaml
  - id: spec-questions
    goto:
      - { stage: spec, when: { "run.counters.spec": { $lt: 3 } } }
      - { stage: build, when: { "run.counters.build": { $lt: 3 } } }
```

The two halts, `blocked` and `screened`, list more: `code-review`, `fix-review` and `retro` while the item has a pull request — `code-review` capped at eight rounds — past the loop's own five, and past the review each later build round adds through `publish`, uncapped, so a round screened after the fifth review can still be retried — `fix-review` capped on its own counter at twenty, `retro` at three and only while a pull request is unmerged — and `triage` while a person has written on the item, capped at twenty. That is because a halt's Retry is a goto to the step whose failure put the item there, and any stepped stage can fail, not only `spec` or `build`.

`build` lists one target: itself, while it has run fewer than three rounds. `publish` pushes before it moves the item, so a push that fails — nothing was committed — leaves the item at `build` with its round settled, and publish retries the push on every tick. "Go to step… build" runs another round instead.

When `code-review` settles with no thread awaiting a fix, an item that was corrected on the way — a second `spec` or `build` round, or any `fix-review` round — goes to `retro` first, unless its pull request has already merged, and one that was not goes straight to `pr-human-review`; the two triggers are each other's negation, so exactly one matches. `retro` reads the item's history as evidence, never instructions, and commits `retro: lessons from #N` to the step prompts (below their front matter), `.agsync/instructions.md` or `.agsync/skills/` alone — never the workflow, the hooks or `src/` — runs the tests, then goes on to `pr-human-review`, which pushes the branch as it enters. That push, like every `branch.push`, has nothing to do when origin's copy of the branch already holds everything the checkout's does — a person's push or "Update branch" moved it on. That commit is not reviewed by `code-review`, which has already run: the person at `pr-human-review` is its only gate, and a lesson they reject is a thread `fix-review` reverts. A thread a person comments on goes round `fix-review` and `code-review` again, and `retro` with it, up to three rounds. A lesson in a step prompt reaches later items once it is merged and `landrace start` is run again, since the workflow is loaded at start; instructions and skills are read from each step's worktree and need no restart.

A `goto-spec` or `goto-build` answer, "Go to step…", or `landrace_goto` names its target outright; the page's Retry names none — it is a goto to the step whose failure put the item where it is, read off `run.failedStage`, and refuses, saying so, if there is none. That is the stage the item last entered before this one — walking past a settled round trip from the current visit, such as a question at a halt the judge sent home — and only while it is still failed: a spec that failed before a person sent the item on to build is not what halted it after the reviews ran out, and Retry does not reach back to it. Whichever way it is asked, it writes a goto record as Landrace. The engine takes it before any trigger. A target the stage does not list halts the item. One whose `when` does not hold is declined — the reply comes home — and the command refuses it up front with the reason, reading the item afresh: not found or closed, one the workflow's `eligible` rules skip (with the rule's own `else`), unplaceable or ambiguous, a precondition that fails, a step still owed, an unlisted target, or one past its cap. It reads and writes under the item's lock, the one a tick converges under, so no tick moves the item in between; while a tick holds that lock for more than a moment, the command refuses, saying the item is busy. A stepped stage whose round is already settled — `triage` once it has answered, say — still accepts a goto: that is also how a person recovers an item a crash stranded between a target's entry comment and its status label. A goto is consumed by the entry record its target writes on arrival, so a target must record its entry; `landrace validate` checks that, and that a judge's route only sends where its stage lists.

A stage that runs a step may name the **branch** that step works on — a template over `{item}`, `{stage}` and `{round}`, and nothing else:

```yaml
  - id: build
    step: steps/build.md
    branch: "landrace/{item}"
```

The step's worktree is then checked out on it: the branch itself for a step declaring `repo:write` — so what it commits outlives the worktree — and that branch's commit, detached, for a read-only step, so a reviewer reads the item's code rather than `main`'s and cannot commit onto it. The branch is created, the first time, at whatever your own checkout's `HEAD` is right then — not at `origin`'s default branch — so local commits you have not pushed yet, and whatever branch you happen to have checked out, end up in the item's pull request. A stage with no `branch` gets a detached `HEAD`, and nothing its step commits is kept. The engine names no branch of its own: a workflow wanting two per item names two. A branch needs `agent.isolation: worktree` — with no worktree there is nowhere to check it out, so `validate` reports and `start` refuses a stage naming one without it. A template git would refuse is refused at load; an item id that makes an invalid name (`a..b`) halts that item before its step runs; a branch already checked out elsewhere — your own checkout, say — halts it with where, and is never taken. The worktree is rebuilt whenever the next step needs it on something else, so only what was committed carries over.

Publishing is two effects, each naming its branch, which the shipped workflow puts on a `publish` stage between `build` and `code-review`. Reviewing and merging name their branch the same way:

| Effect | Applies | Satisfied when |
|---|---|---|
| `branch.push` | pushes the branch to `origin`, fast-forward only — never forced | the checkout's branch head equals `origin`'s as last fetched or pushed, or the checkout has no such branch |
| `pull.open` | opens a pull request from the branch into the default branch, `Closes #<item>` | the item already has an open or merged pull request from that branch |
| `pull.review` | posts a review step's answer on the open pull request from the branch: its replies on the threads they name, its prose as one review, a thread per finding, and the reviewer's own threads it lists as resolved — never a person's | checked by `apply` against the review's own marker on GitHub, since the snapshot carries no reviews, and each reply against the last comment on its thread; a route effect is applied once, right after its step |
| `pull.merge` | merges the one open pull request from the branch with a merge commit, at the head the item was read at, and only while its checks there are `success` or `none` — judged on that read and again on the forge just before the merge, since a route effect is applied with the read from before its step ran. Pending or failing checks, no open pull request from the branch, two open from it, or one closed since the read halt the item, saying which | no pull request from that branch is open, and one is merged. An old merged one from a branch used again does not count while a new one from it is open |

The head is `pull.merge`'s guard. A push that lands between the read and the merge is a commit no check has passed, so the merge is moved — seen when the pull request is read again just before the merge, or by the forge itself in the moment after, whichever refusal the forge answers first: nothing merges and nothing halts. Nothing applies the merge again, either: an `on_enter` effect is applied as its stage is entered and a route effect once, after its step, and neither is planned again while the item stays where it is. So after a moved merge the item stays in the stage that merged, with its pull request still open, and the workflow must route out of that stage on `rel.implements.in.not.merged: { $gt: 0 }` — back to review, say — or the item waits there for ever with no trigger matching. A merge that already went through, with a crash before the next read, is done rather than failing. Any other refusal from the forge (not mergeable, conflicts, a missing permission) halts the item with the forge's reason, naming the pull request and the item. On GitHub the merge is always a merge commit, so a repository with merge commits disabled refuses every merge, and the item halts with GitHub's own sentence ("Merge commits are not allowed on this repository"); GitLab merges with the project's own merge method. A workflow waits for CI with `rel.implements.in.sum.ciPending: 0`, and reads a red build as `rel.implements.in.sum.ciFailed: { $gt: 0 }`.

`code-review` answers with a list rather than posting anything itself — it has no tool and no shell to do either: `reviewed` carries `findings`, each a `file`, a `line` and a `body`, `replies`, each a `thread` id and a `body`, and `resolved`, a list of thread ids. The route's effect is `pull.review`, which is handed the step's output as well as its prose. A finding on a line the diff shows becomes a line thread; one elsewhere in a changed file, a thread on the file naming the line; one in a file the pull request does not touch, a line in the review's text, since GitHub cannot thread it. Each thread ends in a `finding` marker, which is how a later round tells the reviewer's threads from a person's. A new thread awaits a fix, so a review with findings sends the item to `fix-review`.

#### Review threads are a conversation

A person comments on a line of the pull request, or the reviewer raises a finding. `fix-review` fixes it or pushes back, and answers on the thread itself: "Fixed in `abc123`: …" or "Not changed, because …". It cannot resolve a thread. Its answer is `addressed` with `replies`, each a `thread` id and a `body`, routed to `pull.review` with the marker `fix:{round}`. The hook posts each reply through GraphQL's `addPullRequestReviewThreadReply`, by the thread id the briefing named, ending in a `{kind}:{stage}:{round}:{thread}` marker. The kind is the route marker's own, `fix` or `review`. A thread whose last comment already carries that marker is skipped, so a round that runs again posts nothing twice. A `fix` round replies on any thread and resolves none. A review replies on any thread too, but resolves only its own findings.

Whose turn a thread is comes from its last comment. A `fix`-marked reply that Landrace wrote means the thread is waiting for the person. Anything else means it awaits a fix: no reply yet, a person's reply after the fix, or the reviewer's "still wrong: …". `rel.implements.in.sum.awaitingFix` counts the threads awaiting a fix, and every review trigger in the shipped workflow reads it, so an answered thread never loops. A person resolves their own thread once the answer satisfies them, or replies on it, and a reply sends it back to `fix-review`. Each round, `code-review` re-checks its own threads: it resolves the ones fixed, or whose pushback holds, and answers the rest "still wrong". It never replies on a person's thread.

Two caps bound the loop. `code-review` runs at most five rounds: a fifth review that still leaves a thread awaiting a fix goes to `blocked`, so a reviewer who stays unsatisfied gets five reviews and four fixes. `fix-review` runs at most twenty rounds, and that cap is also what bounds its way back to review. So a person's comment at `pr-human-review` reaches `fix-review` with no cap of its own. After the twentieth fix, the item goes to `blocked` ("the fix budget is exhausted"). If the way back to review were capped by `code-review`'s five instead, a person's thread fixed after the fifth review would never be reviewed.

A write step pushes its own branch: the shipped `build`, `fix-review` and `retro` prompts end with `git push origin HEAD`, run inside the sandbox (see [A write step's sandbox](#a-write-steps-sandbox)). `branch.push` stays on `publish`, and on `code-review`'s and `pr-human-review`'s entry, as the safety net. It is satisfied when the agent already pushed, and otherwise pushes what the agent committed and left unpushed, so a fix round's commits are on the pull request before the reviewer reads it. The GitHub hook pushes from the repository its own file is in:

- `origin` must have exactly one push URL (`git remote get-url --push --all origin`); `git push` would otherwise push to every one of them, so any other count is refused.
- The token goes to git only when that URL is exactly `https://github.com/<tracker.repo>`, with or without `.git` or a trailing `/` — matched as a string, not parsed, so no URL git and landrace could read differently gets it — and then through git's environment (`GIT_CONFIG_*`, as an `extraheader` scoped to that exact URL, not to github.com), never on a command line, where any process could read it. `git@github.com:<owner>/<repo>.git` and `ssh://git@github.com/<owner>/<repo>.git` are pushed with your own ssh credentials and no token, as is any origin not on GitHub. A GitHub origin naming another repository is refused, and so is any other URL mentioning github.com — one with credentials, a port, percent-encoding, a query — since it might not be the repository it looks like.
- The push is the item's branch and nothing else: an explicit refspec (so `remote.origin.push` does not widen it, and a mirror remote refuses it), with tag-following and submodule pushing off.
- Every push runs with `core.hooksPath=/dev/null`, so none of the checkout's hooks run — a step that may write shares the repository's config and could otherwise install one that runs inside the push's environment. Your own pre-push hooks do not run on landrace's pushes either.
- A branch with nothing committed beyond `origin/HEAD` (as this checkout knows it — no fetch) is not pushed; the item halts saying so, and carries on once something is committed. GitHub's "No commits between" on `pull.open` says the same.
- A push is stopped after five minutes, or when the run is.

Workflow-level keys beyond `stages`:

| Key | Meaning |
|---|---|
| `eligible` | Which items Landrace touches at all, each rule carrying the `else` reason `status` prints for an item it skipped |
| `budget.stepTimeout` | How long one agent invocation may take, unless its step names its own `timeout`. The round caps are the `$lt` counters in the triggers themselves and in each `goto` entry's `when`, where the validator can see and bound them |
| `hooks` | The integration modules, by path, in the order pre hooks run |

### Splitting work into sub-items

Splitting is an engine feature a project enables in its own workflow; the shipped `.landrace/` workflow does not use it. [`tests/fixtures/children`](tests/fixtures/children/workflow.yaml) is the worked example — the shipped flow as it stood before `publish`, plus a `breakdown` stage between `triage` and `build`, a `children-running` stage the parent waits in, `build` as a second entry for the children, and `done` closing a finished item so its parent can count it — and it is what the tests drive to keep the feature working. Its stages name no branch and it publishes nothing, so its review starts once a pull request for the item exists, however that was opened; a project copying it wants the shipped workflow's `branch` fields and `publish` stage too.

A step that declares `capabilities: [items:create]` — the fixture's `breakdown` stage — is handed exactly one landrace tool beside the servers `agent.mcp` allows, `landrace_create_child` (`title`, `body`, `priority` 0–9), served by a second server the executor starts beside the agent process: `landrace mcp --workspace <dir> --child <parent> --stage <stage> --round <round>`. That binding is fixed on the command line by the runner, not by anything the agent says, and `--strict-mcp-config` keeps a `.mcp.json` inside the worktree from adding a server of its own — or a `landrace` of its own, whose create_child the allowlist would approve. `breakdown` ends by saying `children` — it called the tool at least once — or `single` — it built the spec as one piece of work directly; the two outcomes route to `children-running` and `build`, and a round that says one but did the other halts at `blocked` rather than being guessed at.

Re-running `breakdown` — after a revision, or after a crash mid-round — first drops, as not planned, every sub-item an earlier round of this stage created and every pull request open on them; anything already finished is left closed as it was. A sub-item a person opened under the parent by hand is never touched, this round or any other. The parent itself only reaches `done` once every sub-item still counted is closed as completed — one still open, or one an earlier round made that a person is still working, keeps the parent at `children-running`.

The child MCP server reads `.landrace/.env` from the workspace itself, exactly as `landrace start` does — a token exported only in the shell that ran `landrace start` never reaches this subprocess, by design, so it has to be set in `.env` or no child can ever be created. On GitHub, closing a dropped child's pull request needs the token's `Pull requests` permission to be `Read and write`, not the read-only level threads alone would need — see [Token permissions](#token-permissions).

### `.landrace/hooks/*.ts` — the integrations

The engine has no integration in it. Talking to a tracker, publishing a page, reading a pull request — all of it is a TypeScript module in your own workspace's `hooks/` folder, written against the `define*` contracts or re-exporting one `landrace/integrations/*` ships, and listed by path:

```yaml
hooks:
  - ../../hooks/github.ts
```

A module imports the contracts from `landrace/hooks` and exports whatever kinds it implements — `definePreHook` to observe, `definePostHook` to act, `defineArtifactHook` for something that is both, `defineSource` to enumerate items, `defineOperator` for the create and update an operator asks for by hand, `defineExecutor` for an agent, `defineNotifier` for somewhere to tell a person an item needs them. The loader classifies each export by the brand its helper stamped, so one module can be a whole integration; the order of the list is the order pre hooks run in. A path is relative to the workflow's folder and must resolve inside `.landrace/`, symlinks included, because `workflow.yaml` is a repo file a pull request can edit.

`.landrace/hooks/github.ts` in this repository is the reference: GitHub's issues, pull requests and Pages as `landrace/integrations/github` ships them — `GitHubIssues`, `GitHubForge` and `GitHubPages` — made into its hooks by one `compose` call. A second tracker is a sibling of those classes, and nothing in the engine changes — a test enforces that `src/` never names one.

A sibling is built on `landrace/kit`'s bases, as GitHub's are, and writes only its vendor's calls. A tracker extends `BaseTracker` (list and read items and their children, read and post comments, add and remove labels, close, create and update an item), a forge `BaseForge` (list pull requests and those naming an item, read threads, changed files and posted reviews, open and close a pull request, post a review, reply and resolve, read a pull request's checks and the ones that failed, merge it at a head, read branch heads and push), a docs integration `BaseDocs` (read, publish and link an item's page, and list which items have one) — each answered in plain shapes: `ItemRecord`, `PullRecord`, `ReviewThread`, `ChangedFile`. The base holds everything else: the graph and its bounds, the pre hook's fragment, an `effects()` table with each effect's `satisfied()` beside its `apply()`, a `briefs()` table, the history's entries and the operator's writes. A hook file then exports what `compose` makes of them:

```ts
import { compose } from "landrace/kit";
export const { preflight, source, operator, pre, post, spec } = compose({
  tracker: new MyTracker(), forge: new MyForge(), docs: new MyDocs(), // your classes on the three bases
});
```

That is one source, one operator, one pre and one post hook under the id `project`, and the docs role's artifact `spec` — so a prompt names `{brief.project.body}`, `{brief.project.threads}`, `{brief.project.diff}`, `{brief.project.ci}`, `{brief.project.history}` and `{brief.spec.content}`, and `history` is one timeline of the tracker's comments and the forge's review threads, oldest first. A forge's pull request implements an item by a `landrace/{item}` head or by naming it (`PullRecord.items`, a forge's `Closes #n`); one naming two items halts a read. Every clash between roles halts, naming both: an effect type, a briefing key or a snapshot path two roles claim stops `compose`, and a node id two report stops `list` or `read`. `nodes.close` is the one effect two roles share: its ids are split by their kind in the snapshot's graph, items to the tracker and pull requests to the forge, and a kind no role closes halts. A role's own `check` runs in the preflight, and its failure names the role. To change one piece, subclass and override it — an effect by spreading `super.effects()` and replacing or adding an entry. `createExternalState` in `landrace/testing` is `compose` over `MemoryTracker`, `MemoryForge` and `MemoryDocs`, built exactly this way.

This repository's hook file is exactly that, over GitHub's three:

```ts
import { compose } from "landrace/kit";
import { GitHubForge, GitHubIssues, GitHubPages } from "landrace/integrations/github";
export const { preflight, source, operator, pre, post, spec } = compose({
  tracker: new GitHubIssues(), forge: new GitHubForge({ closingRefs: true }), docs: new GitHubPages(),
});
```

Built with no client, each role builds one from `tracker.repo`, the `githubToken` secret and `tracker.bot` — one per configuration, shared by all three, so one `GET /user` resolves the login they post as. The forge runs git in the repository of the file that constructs it, never the directory the process was started from; `git` hands it another. `closingRefs` says the tracker beside it is GitHub's own issues: on, a pull request it opens says `Closes #n`, and one closing an item's issue is tied to that item; off — beside another vendor's tracker, where `#7` is somebody else's GitHub issue that a merge would close — it writes and reads none, and the `landrace/{item}` head is the only tie. To check a change to it against the live repository, `pnpm build && pnpm parity` with `GITHUB_TOKEN` set reads every listed item through `main`'s hook and this one, and prints `equal`, or each node and edge that differs and exits 1.

#### GitLab

`landrace/integrations/gitlab` is a forge: GitLab merge requests, beside whichever tracker the project uses. The hook file names the project by its full path:

```ts
import { compose } from "landrace/kit";
import { GitLab } from "landrace/integrations/gitlab";
export const { preflight, source, operator, pre, post } = compose({
  tracker: new MyTracker(), forge: new GitLab({ project: "group/app" }),
});
```

And `landrace.yaml` gives it its token, redacted, and — off gitlab.com — the instance, as `https://host[:port]` and nothing more, so the token never travels in cleartext:

```yaml
secrets:
  gitlabToken: $GITLAB_TOKEN
  # gitlabBaseUrl: $GITLAB_BASE_URL   # only off gitlab.com — a declared secret whose variable is unset refuses to start
log:
  redact: [gitlabToken]
agent:
  sandbox:
    hosts: [gitlab.com, registry.npmjs.org]   # your instance's host, so a write step can fetch and push
```

The token — personal, project or group — needs the `api` scope, and its user Developer access to the project, direct, inherited or through a group the project is shared with. `landrace start` refuses one without either, naming which, and names a missing `gitlabToken` too. The same scope and role cover reading a merge request's pipelines and failed jobs' traces. Merging it is a matter of the target branch: a default protected branch lets only Maintainers merge, so a Developer token merges only where that branch's "Allowed to merge" includes Developers, which is not the default — otherwise GitLab refuses the merge and the item halts saying the token's user may not merge into its target branch. `landrace start` also probes the pipeline read, since every read of an open merge request asks for its pipeline. For now landrace requires CI/CD to be enabled on a GitLab project. The forge needs GitLab 16.4 or later, for a finding on a file.

Everything it posts is made inert to GitLab's quick actions first — a line starting `/close` or `/merge` in a finding or a reply is an agent's text, which can quote the code under review, and GitLab would run it as the token's user — by a backslash before the slash, which renders as the slash alone.

An item's work is a merge request from `landrace/{item}` into the project's default branch, its node `pr-{iid}`; a fork's merge request is never an item's, whatever its branch is called. A review's findings become diff discussions — on an added line by its new number, on a context line by both, and on the file when the line is outside every hunk — and its prose a plain note, which nobody can resolve and no count includes. Only a resolvable discussion somebody started is a thread: GitLab's own system notes and plain notes never are. A round's note is told posted by our login and its marker both, so a marker pasted into somebody else's note cannot skip one. The forge pushes as GitHub's does, in the repository of the file that constructs it: the token goes as an `oauth2:` basic header only when origin's push URL is exactly `{gitlabBaseUrl}/{project}`, with or without `.git`; any other origin is pushed with your own credentials, and git's own words are scrubbed of the token before they reach an error.

To check it against a live project, `pnpm build && node scripts/gitlab-check.mjs` with `GITLAB_TOKEN`, `GITLAB_PROJECT` and, off gitlab.com, `GITLAB_BASE_URL` set. On a throwaway branch `landrace/{n}` it appends a line to `README.md`, opens the merge request (twice — the second is GitLab's 409, counted as done), puts findings on the added line and the context line above it, replies and resolves, and prints each check with the counts after it; it exits 1 on the first that fails, and closes the merge request and deletes the branch whatever happened.

The functions the bases are made of stay exported, over the same plain shapes, for an integration not built on one:

| From `landrace/kit` | What it is |
|---|---|
| Tracker | `commentsOf`, `wroteIt` and `botLoginOf` — our comments told from a stranger's; `labelSatisfied`, `statusSatisfied`, `commentSatisfied`, `closeSatisfied`, `nodesCloseSatisfied`, one per tracker effect; `itemNode`, `priorityFromLabels`, `createdAtOf`, `updatedAtOf`, `stillOpen`; the paging bounds and `MAX_COMMENT_CHARS` |
| Forge | `answered` and `threadCounts` — whose turn a `ReviewThread` is; `placeFindings` for a review's findings on a diff of `ChangedFile`s; `pullNode`, `prBranch`, `itemOfBranch`, `itemsNamedBy`; the `threadsBrief` and `diffBrief` briefings, and `historyBrief` over `commentLine` and `threadLine` entries; `pushSatisfied` |
| Docs | `SPEC`, `PUBLISH`, `hashOf`, `contentOf`, `mine`, `briefPage`, `publishSatisfied`, `specNode` |
| Git | `gitIn`, `repositoryOf`, `ownGit`, `branchHeads`, `headsOf`, `headIn`; `originPushUrl` and `pushBranch`, fast-forward only with hooks off, the credential the hook's own |

An integration keeps what is its vendor's: the client, the queries and their paging, its shapes and the mapping from them, which push URLs it trusts with a token and the scrubbing of it from what git says, and every event and word in its own name (GitHub's `github.issue.skipped`, `github.pages.unknown`). The kit's functions never log; a base logs only in its role's name (`forge.review.*`, `docs.skipped`).

A notifier is `{ id, send(event, ctx) }`, and `event` is `{ event: "needs-you", item, title, link, stage, why, board }` — `board` the triage page's URL when one is running, else null. Two notifiers under one id halt at load, naming both modules. `landrace/integrations/slack` is the one landrace ships, and this repository's `.landrace/hooks/slack.ts` re-exports it: it posts `{ text }` to the webhook, mentioning `slackNotifyUser` and linking the item, with the title and why escaped (`&`, `<`, `>`) so a title cannot mention or link anyone. It gives up after five seconds, and a refusal throws Slack's status and reply — never the webhook's URL. A webhook cannot reply to its own post, so there is no threading.

A pre hook declares the snapshot paths it fills, and a source declares which relationship types it reports; `validate`'s `path-coverage` rule is answered from both together with what the engine itself always provides — `run.*`, `node`, `graph`, and `rel.<type>.in|out.*` for every type the source declares — so a predicate can only read what something actually provides. The shipped GitHub hook's pre hook provides `item` (`.body`, `.comments`), `entries` and `tracker.bot`; the in-memory tracker in `landrace/testing` provides the portable subset of that (no `tracker.bot`). An item's identity, labels and assignees are not among either — they live on the `node` the *source* reads (see [The item graph](#the-item-graph)), not on something a pre hook fetches a second time. `node.state.assignees` is a **list of logins** — GitHub's issue has a list, and the singular `assignee` it also returns is that list's first element under a second name, which disagrees with it the moment an issue has two. It is empty, never absent, when nobody is assigned: a rule reading a path an item does not carry is one the tick cannot answer, and it abstains on those rather than guessing.

For an installed landrace, hook modules are imported at runtime with no build step, so they need a Node that strips types: 22.18 or newer does it unflagged, and an older 22.x needs `--experimental-strip-types`. Inside this repository the build is the dependency: `landrace/hooks`, `landrace/kit` and `landrace/integrations/<vendor>` resolve, by package self-reference, to the built `dist/`. After pulling, run `pnpm build` before `landrace start`, `landrace mcp` or `landrace validate`. A hook newer than the build fails to import, and the error says to rebuild.

Conditions are MongoDB-style documents over snapshot paths, evaluated with a **closed operator allowlist** — `$eq $ne $in $nin $lt $lte $gt $gte $exists $all $size $and $or $not`. `$where` and `$regex` are rejected at load, because a workflow file is a repo file a pull request can edit.

#### Jira

`landrace/integrations/jira` is one Jira Cloud project's issues as the tracker, on `BaseTracker`, over REST v3. A hook file composes it beside whatever forge and docs the project has:

```ts
// .landrace/hooks/project.ts
import { compose } from "landrace/kit";
import { Jira } from "landrace/integrations/jira";
export const { preflight, source, operator, pre, post } = compose({
  tracker: new Jira({ project: "KEY" }),
});
```

```yaml
# .landrace/landrace.yaml
log:
  redact: [jiraEmail, jiraToken]
secrets:
  jiraBaseUrl: $JIRA_BASE_URL   # https://<site>.atlassian.net, and nothing else
  jiraEmail: $JIRA_EMAIL        # the account landrace posts as
  jiraToken: $JIRA_TOKEN        # that account's API token
```

| Option | Default | What it is |
|---|---|---|
| `project` | — | The project's key. Only its `KEY-<n>` issues are items (Jira's own word for one is an issue) |
| `issueType` | `"Task"` | What an item with no parent is created as |
| `childType` | `"Subtask"` | What a child is created as, under its parent |
| `transitions.done` | `"Done"` | The transition that closes an item as done |
| `transitions.dropped` | `"Won't Do"` | The transition that closes one as dropped; a closed issue whose status or resolution has this name reads as dropped |

Basic auth carries the account's own token, so `jiraBaseUrl` must be an `https://<site>.atlassian.net` site, and nothing is asked of it before `GET /myself` says who the account is. Logins are `accountId`s, unique and stable: an item's author is its creator, since the reporter can be edited, and its editor whoever last changed the description, read from the changelog, so a child's origin a person edited reads as nobody's. An id is the project's `KEY-<n>` or it is refused before any request is built, and an issue Jira answers under another key has moved and is refused too. A tick lists the project's open issues, and, for the board's Done lane, those carrying an `lr:stage:*` label that closed inside the window. Position is a stage label, as on any tracker; Jira's status moves only to close an item, through the named transition, or reopen one, through the first transition into a To Do status — a transition the issue does not offer fails, naming the ones it does. An issue is closed once its status is in Jira's done category: dropped if the status or the resolution is named `transitions.dropped`, done otherwise, so a closure nobody named still counts. Comments and descriptions are ADF, never v2's wiki markup, which reads the `\\` and `{x}` in a marker's JSON as its own syntax: a paragraph per blank-line block and a hard break per line, the text verbatim, so the `<!-- landrace … -->` marker shows as the comment's last paragraph and reads back exactly. A body over Jira's 32,767 characters is refused before the request. A new issue's priority is the project's own, landrace's 0–9 as an index into its list, past its last the lowest; times are read as UTC. The preflight names each permission the account lacks on the project (`BROWSE_PROJECTS`, `CREATE_ISSUES`, `EDIT_ISSUES`, `TRANSITION_ISSUES`, `ADD_COMMENTS`), each issue type the project does not have and each without a labels field, and writes nothing, since Jira shows every write.

To check it against a live project — it creates an item and a child there, comments, labels, drops the child and closes the item, printing each check:

```sh
pnpm build && JIRA_BASE_URL=https://<site>.atlassian.net JIRA_EMAIL=… JIRA_TOKEN=… JIRA_PROJECT=KEY \
  node scripts/jira-check.mjs
```

`JIRA_OPTIONS` takes the options above as JSON, `{"transitions":{"dropped":"Cancelled"}}`. It exits 1 on any failed check, and when none passed.

#### Notion

`landrace/integrations/notion` keeps each item's spec in Notion rather than on gh-pages: `Notion` is a docs role, beside any tracker and forge.

1. Create an internal integration at notion.so/profile/integrations with the **Read content**, **Update content** and **Insert content** capabilities, and copy its secret.
2. Share the parent page with it — open the page, ••• → Connections, add the integration — and take the page's id: the 32 hex digits its link ends in.
3. Declare the secret, and redact it:

   ```yaml
   log:
     redact: [githubToken, notionToken]
   secrets:
     githubToken: $GITHUB_TOKEN
     notionToken: $NOTION_TOKEN
   ```

4. Hand `compose` the role:

   ```ts
   import { compose } from "landrace/kit";
   import { GitHubForge, GitHubIssues } from "landrace/integrations/github";
   import { Notion } from "landrace/integrations/notion";
   export const { preflight, source, operator, pre, post, spec } = compose({
     tracker: new GitHubIssues(), forge: new GitHubForge({ closingRefs: true }),
     docs: new Notion({ parent: "0123456789abcdef0123456789abcdef" }),
   });
   ```

`landrace start` reads the parent page and creates a `Landrace specs` database in it when there is none, then rewrites its title unchanged — since an integration's capabilities can only be tried, that is how a token without **Update content** refuses to start rather than fail its first publish. **Insert content** is tried only on the start that creates the database: once it exists, a token that lost that capability, or a narrower integration shared on the parent later, still starts, and every publish then fails on Notion's 403. A parent not shared with the integration, a token Notion rejects, or no `notionToken` refuses to start, saying which. So do two databases of that title in the parent: which one holds the specs is not a guess.

Each spec is a row of that database. `Ticket`, its title (the column keeps that name, so a database made before items were called items still works), is the item's id; the body is the spec as blocks, for a person to read; and `Source`, a text property, is the markdown itself. `Source` is what `{brief.spec.content}` hands a step, read whole, so a step works from exactly what was published, whatever the body made of it. It is written last, and a row whose `Source` is empty was never published. Publishing the same text again writes nothing. Changed text clears `Source`, replaces the body a block at a time, and writes `Source` again, so a publish cut off anywhere is redone on the same row by the next tick. Two rows for one item halt it. A spec link opens the item's row, or the parent page while there is none. Reading never creates the database, so `landrace status` writes nothing here either. Give each project a parent page of its own: two projects in one parent share one database, where item 12 of one is item 12 of the other. And anyone who can edit the parent page can edit `Source`, which the steps after the spec are briefed with.

The body shows `#` to `###` headings (deeper ones as `###`), paragraphs, bulleted and numbered lists one level deep, fenced code (in plain text when Notion does not know the language), quotes, inline code, and links to absolute http(s) addresses. A table, a rule or HTML on lines of its own is shown as written, in a markdown code block; inside a paragraph or a list item, anything else — bold, an indented table — stays the text it was, as does a line with more inline code and links than one block takes, and a link longer than 2,000 characters. `Source` holds at most a hundred pieces of 2,000 characters; a longer spec is refused before anything is written to the database. Every request names `Notion-Version: 2025-09-03`; one that appends blocks carries at most 100, nested ones counted; and a 429 is waited out for as long as Notion's `Retry-After` says, five tries in all.

To check it against a real workspace, `pnpm build && NOTION_TOKEN=… NOTION_PARENT=<the page's id> node scripts/notion-check.mjs` runs the check, a publish, the same text, changed text (over a hundred blocks, 60,000 characters with an emoji astride a piece boundary, a fence, a table, an item with 120 children) and the read back. It prints each step, and exits 1 when one failed or nothing was checked. It leaves its `check-<time>` row in the database for you to look at.

### Executors: the coding agent is a hook

The engine runs no coding agent of its own: `agent.adapter` names a hook. `defineExecutor` registers one, either as `{ id, run }` directly or as `{ id, create(ctx) }` — a factory the runtime calls once at startup, with `ctx` the same `RuntimeContext` every hook gets plus `dir` (the workspace, for finding the repository), `redact` (secrets a run's own setup discovers, such as an MCP server's `env`, that the configuration never named) and `steps` (the workflow's steps, by path, so a factory can refuse what a step asks of it before the step runs). A factory that cannot start — a bad `agent.*` key, a server `.mcp.json` does not define, a step's effort it has no level for — throws, and `landrace validate` reports it under the `executor` rule, one problem per line.

**The engine hands every run:**
- the rendered prompt;
- the directory to run in;
- the step's capabilities;
- its model and effort;
- a time limit. At the limit the engine aborts the run's signal but keeps waiting for the run, so an executor that honours neither holds its item until the process dies;
- the session to resume;
- for an `items:create` step, the engine's own item server, ready to start.

It gets back the agent's text and a session id. Beyond `agent.adapter` and `agent.isolation`, the rest of the `agent:` block is opaque to the engine and passed on to the executor unread — a second agent is a hook file, never a change to `src/`.

A hook reads `agent:` only when `agent.adapter` names it, because `agent:` belongs to the step agent. An executor that `security.adapter` alone names is there to screen: the block is in another agent's vocabulary, and the screener's model arrives on each run from `security.model`.

**An executor must, or else refuse the run:**
- enforce every declared capability;
- give a run that declares none no tools at all (that is the screener's run);
- never hand a step or a turn the operator's own `landrace` MCP server;
- run in the directory it is given, because the engine's read-only check inspects that directory, and a run anywhere else defeats it;
- never pass the engine's own process environment to the agent, because a secret can come from the shell and the agent must not hold tracker credentials;
- honour a named model and effort;
- stop at the limit and on abort.

The engine checks a read-only step's worktree afterwards whatever the executor claims — a backstop, not a licence to skip the rest.

#### The kit, and the agents landrace ships

Every rule above but the vendor's words is the same for every agent, so it is written once: `BaseExecutor`, from `landrace/kit`. It is a factory that brands itself, so an integration is an executor hook as it stands, and this repository's is two lines:

```ts
// .landrace/hooks/claude.ts
import { Claude } from "landrace/integrations/claude";
export const claude = new Claude();
```

The kit starts the agent with no shell and none of landrace's environment, checks every value before it reaches argv and the directory it runs in, refuses a capability it cannot enforce, resolves `agent.mcp` from `.mcp.json`, reads and shape-checks `agent.sandbox`, kills the whole process group at the limit or on abort, re-checks the abort after the integration's own preparation and before it spawns, and refuses at startup an `agent.*` key nobody reads and a step's effort the agent has no level for. An integration says only what is its agent's:

| Hook | What it says |
|---|---|
| `argv(plan)` | The command line for a run the kit has decided and checked: its tier (`screen`, `read` or `write`), model, effort, session, servers and the tools allowed on each |
| `readEvent(event, cwd)` | What one line of the agent's JSON output means: a message or a tool call for the item panel, the session id, the answer, the end, or a failure |
| `handoffArgv(plan)` | The command a person runs to pair |
| `prepare(plan)` | Optional. Whatever must be in place before the agent starts — Claude brings a resumed session into the directory it runs in |
| `readExtras(agent)` | Optional. The integration's own `agent:` keys — Claude's `plugins` |
| `sandboxProblems(sandbox)` | Optional. The `agent.sandbox` settings its agent cannot keep, refused at startup |
| `mcpFile(root)` | Where `agent.mcp`'s servers are defined; `.mcp.json` unless overridden |

and declares `efforts` (the levels it takes), `pairings` (`take` a fresh session, `continue` the agent's, `fork` for Finish) and `envKeys` (variables the agent needs, never a credential). To change one piece, subclass and override that method. `integrations/` imports nothing but `landrace/kit`, `landrace/hooks` and `node:*`, so a third integration is written exactly as these two are.

#### Codex

`landrace/integrations/codex` runs OpenAI's `codex exec --json`, written against codex-cli 0.154:

```ts
// .landrace/hooks/codex.ts
import { Codex } from "landrace/integrations/codex";
export const codex = new Codex();
```

```yaml
agent:
  adapter: codex
  model: gpt-5.1-codex
  sandbox: { deny: [] }
```

| Run | Sandbox | Also |
|---|---|---|
| no `repo:write` (read-only) | `read-only` | |
| `repo:write` | `workspace-write`, with the network off | `$TMPDIR` and `/tmp` not writable: `$TMPDIR` holds every other item's worktree, landrace's locks and the screener's directory |
| the screener | `read-only` | every built-in tool off — the shell, web search, the image viewer, connectors and plugins, the browser, sub-agents, hooks — no server, and run in a directory of its own that only you can write, rather than your checkout |

Every run passes `--ignore-user-config` and `--ignore-rules`, so your own `config.toml` — whose servers include landrace's operator server — and your execpolicy rules do not load; runs with `approval_policy="never"`, since nobody is there to ask; gets `agent.mcp`'s servers per run as `-c mcp_servers.<name>.*`, a listed server's tools as its `enabled_tools`, so nothing is written for a worktree to shadow; takes the prompt on stdin; and has `CODEX_HOME` passed on, nothing else of landrace's environment. The session is `thread.started`'s id, the answer the last `agent_message`, and a `turn.failed` fails the run with codex's own reason.

What codex cannot do is refused rather than run without. At startup, and by `validate`:

- **`agent.sandbox.hosts`.** Its sandbox has the network on or off, with no list of hosts, so list none: a write step then has no network, and cannot install or push.
- **`agent.sandbox.deny`.** It cannot keep a command from reading a path under your home, and every step and conversation turn — read-only ones too, whose answer is posted to the item — has a shell to run one. The default list applies when `deny` is not written, so write `deny: []` to accept that every step and turn can read those paths.
- **An effort outside `none`, `low`, `medium`, `high`, `xhigh`.** The shipped `spec` step asks for `max`, and `validate` names it.
- **`agent.plugins`**, which is Claude's.

And before a run starts: a project `.codex/config.toml` or `.codex/hooks.json` anywhere from the run's directory up to the repository root — either would load beside the run, and a step could commit one — and a server, variable or header name a `-c` key path cannot carry (one with a `.`).

**Pairing.** Codex names every session it starts itself, so none can start under the id landrace gives a pairing. It pairs only by carrying on the agent's own session on the stage: that session's file under `CODEX_HOME/sessions` is copied under the pairing's id, and the person runs `codex resume <that id>`, seeded with the step. Finish forks it with `codex exec fork`. A pairing on a stage the agent has not run yet is refused, saying why — release it, and pair once the agent has run the step.

### `.landrace/workflows/<id>/steps/*.md` — the work

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
| `capabilities` | What the agent may do — `repo:read`, `repo:write`, `items:create`. The first two are enforced by diffing the worktree afterwards, the third by which MCP tool the executor hands the agent — not by the flags an integration hands its agent, which another executor never sees. An unenforceable capability refuses the step rather than pretending |
| `model` | Overrides `agent.model` for this step. A cheap step should say so |
| `effort` | Overrides `agent.effort` for this step, and its conversation turns. The level is the agent's own word: an integration built on the kit refuses one it has no level for at startup, and `validate` names the step |
| `timeout` | Overrides `budget.stepTimeout` for this step, e.g. `120m`. A step that writes code can need hours where a classifier needs minutes |
| `output.discriminator` | The field whose value picks the shape |
| `output.shapes` | What each value of the discriminator must look like. Output that matches none is a hard fail, recorded, never retried |
| `output.routes` | Where each shape goes. One route, one effect — two routes matching one output is ambiguity, and ambiguity halts. A route may also name a `goto`, a stage its stage lists, which the engine takes before any trigger |

#### `extends:` — a step built on another

A step file may name another in front matter, `extends: ./base.md` (a path relative to the file, inside `.landrace/`), and give only what differs. The child is merged over the parent:

- Each front-matter key the child gives replaces the parent's whole; a key it leaves out is the parent's. Nothing inside a key is merged.
- The body is a lead (the text before the first `## ` heading) and sections. A non-empty lead replaces the parent's lead.
- A `## ` section whose heading matches one of the parent's replaces it, in the parent's place; a heading the parent lacks is appended.
- A chain is allowed (a child of a child); a loop is an error naming the files.
- A heading twice in one file is refused, so a replacement can only mean one section. A `## ` inside a fenced code block is text, not a heading.

Both schemas are strict: an unknown key fails to load rather than being ignored. A field the engine silently ignores is a lie, and this codebase had four of them until the last review.

## Workspaces

A workspace holds one workflow or several, and one `landrace start` runs all of them: every workflow's source is listed, each open item is claimed by one workflow, and that workflow works it.

- **Claims.** A workflow claims an item its `eligible` rules accept. Exactly one claim is the rule: an item two workflows accept is a conflict, an id two different sources both report is a clash, and either halts, naming both workflows, rather than going to whichever came first. An item no workflow accepts is unclaimed, and shows as Not admitted with each workflow's reason. Give each workflow its own `admit` label and `eligible` rule (`lr:auto` for one, `lr:fast` for another) and a start can never be claimed twice; `landrace validate` reports, and `landrace start` refuses, two workflows over one source where what one admits the other certainly accepts (`claims`): its `eligible` rules are labels alone and pass the admit labels, or it claims every item — it states no `eligible` rule, or one reads what no listed item carries, such as `run.counters`. The check abstains where an `eligible` rule reads something an item may or may not carry, or where the sources are not the same loaded object.
- **One pool.** `tick.concurrency` bounds the workspace, not each workflow: items of every workflow share its slots, most urgent first.
- **A failing source.** With several sources, one that cannot list leaves every clash unjudged, so that tick no other source's items are worked, and the board refuses writes while any source is failing. Runs already in flight are not stopped for it. With one source, its own items are simply absent.
- **The board** has a page per workflow and a Needs You home across them all, and tags each row on Needs You with its workflow's name when there is more than one (see the triage page, below).
- **MCP.** `landrace_workflows` lists each workflow (`id`, `name`, `description`, `claimed`, `needsYou`, and `creates`, whether `landrace_create_item` can start an item in it). `landrace_items` and `landrace_waiting` list across the workspace, each row naming its workflow, and the halts that no workflow may work; with `workflow` they narrow to that workflow's items and the halts it is party to. `landrace_create_item` takes `workflow`, required when more than one can create items. Every tool that takes an item id resolves the workflow by the item's claim. A tool that writes the workflow's own state (`landrace_reply`, `landrace_goto`, `landrace_ask`, `landrace_pair` with a stage, ...) refuses an item no workflow claims or two do, and refuses while any tracker cannot list. `landrace_waiting` lists the board's Needs you — an item at a stage that `waits` on a person, and the halts (blocked, screened, a conflict, a clash) — and `landrace_status`'s `waitingOnYou` is the same rule; a closed item is never waiting. A read (`landrace_status`, `landrace_pair` without a stage) is refused only for an id two trackers report: any other item one tracker lists is read there, with `workflow: null` and why when no one workflow claims it. `landrace_update_item` is an edit, as on the tracker: an item no one workflow claims goes through the one operator every workflow that could claim it shares, and is refused, naming them, when they edit through different ones. With one tracker, a tool about one item reads that item rather than listing the tracker. `landrace mcp --workflow <id>` scopes a server to one workflow: it lists, creates and acts for that workflow alone, and says so in each tool's description.

## Fastlane

`.landrace/workflows/fastlane/` is this repository's second workflow, beside `main`, for a change small enough to need no spec. An item labelled `lr:fast` — the label `landrace_create_item` adds when it starts one there — goes from its own text to a merged pull request, and is closed. A person is needed only at a halt, or when the item is `stuck`.

```
build → publish → code-review ⇄ fix-review → ci → (retro → code-review → ci) → merge → done
```

- **`build`** works from the item's title and `{brief.project.body}`, and, once the pull request's checks have failed, from `{brief.project.ci}` too: each failed check and the tail of its log. Its step extends main's `build.md` and replaces only `## What to build`. `code-review`, `fix-review` and `retro` run main's own step files, unchanged.
- **`ci`** is where a review that left every thread resolved waits for the checks on the pull request's head. Failed goes back to `build`. Passed goes to `merge` — or first to `retro`, once, when the item was corrected on the way: a second build, any fix round, or a reply a person had to write. The retro's commit then goes through review and CI like any other before the merge.
- **`merge`** applies `pull.merge`, guarded by the head the checks ran on, before it moves the item there. A head that moved sends the item back to `code-review`, since it is code nobody reviewed; any other refusal from the forge halts the item at `ci` with the forge's reason, and the next tick plans the merge again. A merged pull request goes to `done`, which closes the item and takes `lr:fast` off — as does one a person merged by hand on the way.

The caps are three builds, CI fixes among them, and eight fix rounds; and once code review has run four times, a review that still asks for fixes, or a head that moved again under the merge, does not go round again — every build is still reviewed. At a cap the item goes to `stuck`, which waits on a person and so is under Needs you — and so does a review that leaves a thread open with no fix owed on it: one the fixer answered, waiting on a person, since the merge needs every thread resolved. At `stuck`, `blocked` or `screened` a reply goes to `triage`, which reads it as `rework` (back to `build`, which is shown the message), `close` (the item is closed; its pull request is left open), `question` (answered on the item) or `unclear`; the last two leave the item where it was. "Go to step…" offers `build` and `code-review` from `stuck`, each within its cap, and every step from a halt, as main's halts do.

An item labelled both `lr:auto` and `lr:fast` is claimed by both workflows and halts, naming them. The merge needs the [token permissions](#token-permissions) for it: Contents and Pull requests, read and write, to merge; Checks and Commit statuses, read, to see the checks; and Actions, read, for a failed job's log in `{brief.project.ci}`.

## What `validate` proves

| Rule | Catches |
|---|---|
| schema, ids, entry | Malformed definitions, duplicate stages, no entry point (unless every open stage is placed by the item's own state), an entry stage (of several) with no `"run.stage": null` trigger |
| reachability, `unknown-stage` | A stage nothing leads to; a trigger naming a stage that does not exist |
| `dead-end`, `self-loop` | A non-terminal stage with no way out; a stage triggering on itself |
| `cycle-bound` | A loop with no counter bound — an agent that could run forever. An edge whose trigger waits for a person's own message (`run.lastEvent.actor: human`, exactly) bounds it too: every lap needs someone to write |
| `totality` | A declared output shape with nowhere to go |
| `identity` | An item two stages' identities both place, shown to the engine's own compiler; abstains where it cannot construct one, except beside a stage placed by its label alone, where an identity reading no `run.stage` is reported either way |
| `waits` | `waits: person` on a stage that runs a `step`, or on a `terminal` stage |
| `operator` | A disallowed predicate operator, anywhere including nested |
| `path-coverage` | A predicate — in a trigger, an `identity`, a `requires` or an `eligible` rule — reading a field no hook provides |
| `vars` | A variable that does not resolve, a `{vars.x}` nothing defines, a declared variable nothing references, a variable holding a secret's value |
| `branch` | A stage `branch` git would refuse as a name, one using anything but `{item}`, `{stage}` and `{round}`, one on a stage that runs no step, or one with `agent.isolation` other than `worktree` |
| `mcp` | An `agent.mcp` server with no `.mcp.json` at the repository root, a name `.mcp.json` does not define, or landrace's own operator server |
| `goto` | A `goto` target that is not a stage, is named twice, or records no `enter` naming `{round}` — its entry record is what consumes a goto; a route sending items somewhere its stage does not list |
| `trigger-name` | A trigger named `goto`, the name a goto transition is logged under |
| `reserved-field` | A `goto` or `from` field in an `on_enter` effect or a route's effect — fields only the engine writes |
| `admit` | A label a workflow admits items with that one of its own `eligible` rules (a check of labels alone) turns away, so the item would be started and never worked; an admitted label the engine writes itself (`lr:working`, `lr:stage:…`) |
| `claims` | Two workflows over one source (the same loaded hook object) where the labels one admits satisfy the other's `eligible` rules, all label-only, so an item started in one would be claimed by both and halt. Abstains where a rule reads anything else, a workflow admits nothing, or the sources differ |
| `layout` | A workspace that is not one: the pre-workspace `workflow.yaml` at its root, no workflows, a workflow id that is not usable, a `workflows` folder or a workflow folder that is a symbolic link, a `workflows:` order in `landrace.yaml` that does not name exactly the folders |

Every rule runs on every workflow. An earlier version abstained where a trigger
could fire from anywhere, which turned out to mean *always* — the entry trigger
every real workflow needs switched three rules off graph-wide. The graph rules
now work from two derived views instead: a superset that treats an unanchored
trigger as an edge from every stage, for `dead-end` and `reachability`, and the
anchored edges alone for `cycle-bound`.

## CLI

```bash
landrace start [-w, --workspace <dir>] [--once] [--debug] [--ui-port <port>] [--no-ui] [--telemetry] [--otel KEY=VALUE]...
                                         # watch the tracker; serves the triage page on 127.0.0.1:4545
landrace status [-w, --workspace <dir>]               # one line per item: where it is, and why one was skipped or stopped
landrace validate [dir]                  # prove every workflow in a workspace sound
landrace next --workspace <dir> [--workflow <id>] -s <snapshot>
                                         # the decision for a snapshot, no I/O; --workflow when there are several
landrace mcp [-w, --workspace <dir>]                # MCP server over stdio
```

`start` runs ticks on an interval and they overlap: the lock is per item, so an
item busy with a ten-minute agent delays only itself. `--debug` prints every
event, including the agent subprocess's own. Ctrl-C releases the locks and
exits; press it twice and it says which lock it left behind for the next run to
reclaim.

`start` also serves a triage page at `http://127.0.0.1:4545/` — every
candidate item, with its sub-items and pull requests nested beneath it, in
lanes: needs you, agent running now, held by another process (your MCP
conversation, another instance), waiting, and collapsed not-admitted and done.
There is one such page per workflow, plus a Needs You home (below).
Done holds what the source lists as closed; the shipped GitHub hook lists an
item Landrace moved (it carries an `lr:stage:*` label) for 30 days after it
closes. Each pull request and document shows what it is, its state (a pull
request's glyph is green while open, purple once merged, red once closed) and
how long ago it was opened, when the source says.
A branch sits in the lane of its most urgent item, so a sub-item that needs
you lifts its whole branch into "Needs you", opened down to it. "Needs you" is
a queue: by priority, P0 first and unprioritised last, then whoever has waited
longest. Every other lane is newest first, priority ignored. Both go by when
the source says the item or pull request last changed — a comment, a label,
a close, Landrace's own included, moves it at the next tick's list — and a row
the source gave no time goes last. A branch's rows, at every depth, follow its
lane's order, and a branch is placed by its root's own priority and time. A search box
filters by title or id, and Collapse all / Expand all set every branch at once.
Top right, a countdown to the next scheduled
tick and a "Run next tick now" button. It polls every two seconds and costs
no tracker calls: it shows what the tick already fetched and what the
process already knows is running. `--ui-port` moves it, `--no-ui` turns it
off, and `--once` never serves it. It binds loopback only and answers only
its own host name.

**Pages.** A sidebar lists *Needs You* and then each workflow by name (case-folded, then id); under 640 px it is a row of chips above the page. The page is chosen by the address: `#/` is Needs You, `#/w/<id>` a workflow, and either takes `?item=<id>` to open that item's panel. Old `#item=<id>` links (bookmarks, notification clicks) still open the panel on Needs You. A workflow the board no longer has (`#/w/gone`) shows Needs You. Moving between pages closes the panel.

- **Needs You** is the home page and shows one lane, across every workflow: an item at a `waits: person` stage, every halt (blocked, screened, a claim conflict, an id clash). When the workspace has more than one workflow, each row is tagged with its workflow's name, except a conflict or a clash, whose note names the workflows involved. It is ordered by priority, then whoever has waited longest. The sidebar counts its branches, and so does the browser tab: `(3) Landrace`, plain `Landrace` at zero. When nothing is there, and no search is typed, it shows a person in a beach chair under a palm tree and "You're all set!". A search that matches nothing says "Nothing matches." instead. Until the first listing has landed, home says "Listing…" instead of either, since no rows then is no data, not good news.
- **A workflow page** draws all of the lanes above for that workflow's own items, without the tag. A branch is drawn on every workflow page any of its rows belongs to, in its most urgent row's lane, so an unclaimed epic with one workflow's sub-issue under it appears on each page its source lists. The sidebar's count and dot count only that workflow's own rows: a workflow shows a rose dot only when one of its own rows needs you, whatever else shares the branch. An item belongs to the page of the workflow that claims it. A conflict is on the page of each workflow that claims it, and a clash on the page of each workflow whose source reports the id. Not admitted lists what the workflow's source sees and nobody claims, so an unclaimed item shows on every page whose source lists it. Claims judge open items only, so a closed item shows on the pages whose `eligible` rule admits it (or, when none does, on every page whose source lists it).
- **A clash has no panel**, since a read of an id two trackers report cannot tell which to ask; the same holds for any id two sources list and no workflow owns, open or closed. Opened from a notification or a link, it is titled with its own number and title and shows its note, and offers no reads or writes. A conflict keeps a read-only panel.
- **A read-only workflow's items offer no writes** (the condition under which a workflow "writes nothing", above): their panels are read-only, with no reply, no Retry, no Clear and no Go to, because the tracker would refuse each.

An item a security check stopped sits in "Needs you" with a shield beside
its badge and the note "blocked by a security check"; the refusal's own reason
is in the item's comments, which the page does not read. `landrace status`
says "blocked: security check refused a step" for the same item.

The 🔔 beside the theme toggle turns on browser notifications, remembered per
browser; the first click asks the browser's permission. With it on, each
item that has come into "Needs you" since the last poll raises one system
notification — "#29 needs you", with the title and why — and a click on it
opens that item's panel. Opening the page announces nothing that was already
waiting. If the browser has blocked notifications for the page, the bell
turns to 🔕 and says so.

The page has four writes, and three of them can start paid agent runs, so all
are guarded beyond the Host check. The tick button starts a tick, or, while
one is running, says "queued" and runs one once every tick in flight has
ended — which, with an agent step in flight, can be long after the next
scheduled tick. A Retry or "Go to step…" that went through, and every
`landrace mcp` write — reply, goto, clear, ask, resolve, create or update an item —
wake the loop the same way, so a person does not wait out the interval. The
MCP server is a separate process: it touches a `wake` file beside the locks
in `$TMPDIR/landrace/<repo>/`, and `start` checks that file every second. The "Retry"
entry, first in a blocked or screened item's menu, sends the item back to
the step whose failure put it there. The "Go to step…" entries, offered on any
open item whose agent is not running and whose stage lists a goto, send it
back to a step its stage names. "Clear & retry", beside Retry on a screened
item only, is a Retry that also clears the refused step's next round of the
security check (see above). Each asks first, and each writes the same
goto record `landrace_goto` does, after reading the item afresh: an item
that has moved on, a step its stage does not list, or one past its cap is
refused in a sentence the menu shows. The icon-only Refresh button, right of
Collapse all / Expand all, starts no agent at all — it re-reads the tracker and
reloads the board from it, one list and nothing more — but it still spends
that read, so it is guarded the same way as the other three rather than left
as a plain GET. Each write requires its own custom `x-landrace-action` header
(`tick`, `retry`, `clear`, `goto`, `refresh`), which a cross-site `<form>` cannot set,
and a cross-origin `fetch` that does set one triggers a CORS preflight this
server never answers with permission. Each also refuses any `Origin` other
than the page's own, and any request the browser marks `Sec-Fetch-Site` as
not same-origin. None of the guards is optional: together they are what stops
another website the user has open from starting paid work just because their
browser can still reach 127.0.0.1.

The page follows the OS light/dark preference (or whatever you last toggled,
top right) with no flash on load. Every row has one menu, opened by its "⋯"
(aria-label "Actions"): its writes first, where the server offered any —
"Retry" on a blocked or screened row, then "Go to step…" and the steps its
stage lists — then a divider, then "Chat": Claude Code, Claude Code (CLI),
Cursor and Codex, and a "Copy prompt" entry below its own divider. All four
links pre-fill a chat about that item, over the landrace MCP, and never
send anything on their own — picking one just opens the editor with the
prompt sitting in the box. Cursor
has no per-window deep-link target, so its link opens in whatever window is
already active rather than the item's own checkout. "Claude Code" opens a
new session in the desktop app's Code tab (`claude://`); "Claude Code (CLI)"
opens a terminal running `claude`. The CLI's link
handler (`claude-cli://`) only registers itself once you have run an
interactive `claude` session at least once, so the first click needs that
session to have happened already, not the deep link itself.

## Security

- The agent never holds the tracker's token. A write step pushes its own branch with your git credentials, from inside the sandbox, and Landrace performs every other external write — pull requests, comments, labels. Protect `main` on the forge before you run write steps: nothing but the prompt keeps an agent to its own branch.
- Predicate operators are allowlisted structurally, before a condition reaches the evaluator.
- Everything a step writes is escaped before posting, so an agent cannot emit Landrace's own control tokens.
- `src/core/` is provably pure — no I/O, no clock, no randomness — enforced by lint and by test.
- A step declares what it may do, and the declaration is enforced by diffing its worktree before and after — not by the flags an integration hands its agent, which another executor never sees. A conversation turn is held to the same declaration as the step it continues.
- Under either shipped integration, a step or turn gets exactly the MCP servers `agent.mcp` allows, strictly. The kit refuses Landrace's own operator server at startup by name, and by its command line in the common spellings — a best-effort check on operator-trusted config, so do not allowlist a wrapper that runs it. Keeping that server from a step is part of every executor's contract, not the kit's alone.
- Every agent that can act is screened first — every step declaring a capability, and every turn typed through the MCP: the place an operator pastes text someone sent them is not a place to start trusting it. A step declaring none is not screened (`screen.skipped`): it runs with no tool and no repository, and the one such step shipped, `triage`, answers from a closed set a comment could already argue for in plain words. Screening it only refused people's approvals for the judge template's own wording, on #39 and #41, and a clearance then re-judged the approval at the halt, where it changes nothing. A step the screener refuses is recorded as a refusal, not a broken contract, and lands in `screened` for a person to read. An `ok` counts only when it carries the nonce that screening's prompt was marked with, so a verdict planted in the screened text, or the template restated, fails closed. A reply that fails closed is logged whole in `screen.blocked` (its last 2,000 characters, redacted like any log line) and never posted: the item shows the reason alone.
- The engine ships no integrations, and `src/` contains no vendor code at all — a test fails on the offending file and line. A hook module must resolve inside the workspace (`.landrace/`) before it is imported, both ends compared after `realpath`.
- A comment carries control state only because Landrace's own account wrote it. The account is resolved from the token at startup and verified against any configured override; the process refuses to run rather than guess, because a login it cannot resolve would make its own records read as a stranger's.

## Development

```bash
pnpm test        # the full suite, over two passes
pnpm typecheck
pnpm lint
pnpm build
```

A workflow of your own is tested against `createExternalState` from `landrace/testing`. With `readOnly: true` every write throws `this tracker is read-only: <operation> was asked of <what>`, where <what> is `#<id>`, or `a new item` (`a new item under #<n>`) for a create, and the state's `writes()` lists every write attempted, refused ones included — which is how a read-only workflow is shown to write nothing.

Agent instructions and MCP config are managed by [agsync](https://github.com/yiftahb/agsync). Edit `.agsync/instructions.md` or `.agsync/mcp/*.yaml` and run `agsync sync` — never edit `AGENTS.md`, `CLAUDE.md` or `.mcp.json` directly, they are generated.

## License

MIT
