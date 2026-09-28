# Landrace

A local-first SDLC orchestrator. It watches an issue tracker and advances each ticket through an explicit, versioned workflow — using coding agents for the work and code for the decisions.

> *A landrace is a variety shaped by adaptation to its local environment over generations. That is the thesis: a workflow that adapts to what your team actually ships.*

## Why

Most agent orchestrators hand the whole ticket to a model and hope. Landrace splits the two things apart: **the model does the work, the state machine decides what happens next.** A model never picks a transition — it produces a value, and a deterministic rule routes on it.

Four things follow from that, and they are the reason to use this rather than a prompt loop:

- **You can see why it did what it did.** Every transition is a rule in a file you can read, diff and review — not a paragraph in a prompt.
- **Every loop is bounded, and the bound is checked before anything runs.** `landrace validate` proves that each cycle in your workflow passes through a counter comparison. "The review loop terminates" is a property of the definition, not a hope.
- **A crash costs nothing.** A ticket's entire progress is re-derived from the tracker on every run. There is no database, no ledger, no recovery path to go stale — delete everything local and the next run rebuilds it.
- **It runs on your laptop, with your agent.** No server, no cloud sandbox, no vendor session protocol. The coding agent is a hook behind a narrow contract — a prompt in, text and a session id out — so swapping it is a hook file and a config line.

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
| MCP server: read, create, update, comment, ask, resolve, goto | ✅ built |
| Hook loader, GitHub and Claude hooks, agent execution | ✅ built |
| Tick loop: polling, concurrency, per-ticket locking | ✅ built |
| Artifact publishing to GitHub Pages, PR review threads | ✅ built |
| Worktree sandbox with enforced capabilities | ✅ built |
| Conversation with a running step, over MCP | ✅ built |
| Pushing the ticket's branch and opening its pull request | ✅ built |
| Containers, OpenTelemetry, a second tracker | ⏳ planned |

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
counters in your workflow — on its triggers, and on the `when` of each `goto`
entry — not something the engine imposes.

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
  createdAt?: number;        // epoch ms, for the board's "opened 3h ago" only — no workflow can route on it
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

The shipped GitHub hook reports two relationship types: `child-of` (a sub-issue to its parent, singular) and `implements` (a pull request to the ticket it closes or whose branch names it, singular). A pull request is a node like any other — `kind: "pull-request"`, `state.merged`, `state.openThreads`, and the branch it is from as `state.branch` — and "every pull request on the ticket is merged" is `rel.implements.in.total: { $gt: 0 }` **and** `rel.implements.in.not.merged: 0`, never one pull request's own flag, because a ticket can carry more than one. Only an *open* pull request's threads are counted: a merged or closed one reports `openThreads: 0`, never nothing, so the sum stays defined — and readable as "clear" — once every pull request on the ticket is done.

It also reports a ticket's published spec page as a `document` node, with a third relationship type, `documents`, pointing at its ticket (singular) — so the triage page shows the spec under its ticket. `list` finds every page in one listing of the `gh-pages` branch and reports none for that tick, with a logged reason, when that listing fails or GitHub truncates it — it is display only, so it never fails the tick; `read` checks the ticket's own page directly. The workflow still routes on `artifacts.spec`, not on this node.

Spec links — on that node, and in `artifacts.spec.url` — point at the Pages site when the repository publishes one from the root of `gh-pages`, and otherwise at the file on GitHub, which anyone who can see the repository can open.

Priority comes from this repository's own `P0`..`P9` label convention; two of them is a priority that cannot be told, and `read` halts the ticket rather than picking one, the same way two stage labels does. A closed ticket is never worked — it keeps whatever labels it had, `lr:auto` included, but only ever appears in a graph so a parent can count a finished child, never so a tick pays for a step on it. And a GitHub close reason this hook does not recognise — anything but `COMPLETED`, `NOT_PLANNED`, `DUPLICATE` or none — halts the ticket rather than guessing whether it is done or dropped.

A step's prompt can also ask a source for prose the graph itself does not carry — `{brief.<source id>.<key>}`, fetched only when that step is about to run, never routed on by any predicate. `fix-review.md` and `code-review.md` read `{brief.github.threads}`: the open review threads across the ticket's pull requests, each named by its thread id and, when Landrace's reviewer raised it, marked so, as a working list for the step to act on. `code-review.md` also reads `{brief.github.diff}`: what the ticket's open pull requests change, file by file, since a read-only step has no shell to run `git diff` with — 24,000 characters of patches at most, with every file past that named, to read in the worktree. A prompt is briefed only the keys it names, so one key never spends another's budget. `retro.md` reads `{brief.github.history}` from the same call: every comment on the ticket in order — Landrace's own shown by marker, everyone else's by login — then every review thread on every pull request tied to it, resolved or not, merged or not, with who raised it and its last reply. It keeps the newest 60 comments and 40 threads — fewer when their text would pass 14,000 characters a half, so the engine's 32 KB cut never drops the newest — each body cut at 1,000 characters, and says how many earlier ones it left out.

An artifact can brief a step the same way. The spec artifact briefs `{brief.spec.content}` — the approved spec's own text, read off `gh-pages` — and `build.md`, `code-review.md` and `fix-review.md` embed it between two rules as the approved spec, framed as requirements rather than instructions. With no page published the text says so ("No spec has been published for this ticket.") instead of leaving a hole in the prompt; a page that cannot be read halts the step instead. The spec is handed over as text, never as a link to go and read: a prompt telling the agent to fetch a URL is exactly what the prompt screener refuses, and in a private repository the agent could not open the link anyway. `artifacts.spec.url` stays in those prompts only as a reference line for a person. Every briefing is escaped before it reaches a prompt and cut at 32 KB per hook — a cut says it was cut — so a long spec cannot crowd the review threads out of a fix round's prompt.

## Structure

```
src/namespace.ts     every type in the system, and nothing else
src/core/            the decision engine — pure, and enforced: no I/O, no clock,
                     no randomness. Time arrives as `snapshot.now`
src/workflow/        load and validate workflow definitions
src/hooks/           the define* contracts, and the loader that imports yours
src/agent/           prompt screening, the worktree sandbox
src/runner/          tick, converge, step, lock, effect dispatch, events
src/config/          landrace.yaml + .env
src/telemetry/       OpenTelemetry export of events, loaded only when it is on
src/mcp/             operator tools over stdio
src/cli/             validate, next, mcp, start, status
src/testing/         the harness, for testing a workflow of your own
src/conventions.ts   label and marker vocabulary, shared by every hook
src/sandbox.ts       repository identity; the tmp root locks and worktrees share

.landrace/
  landrace.yaml      runtime — how agents run, where tickets live
  workflow.yaml      the process — one graph, stages declaring what activates them
  steps/*.md         the work — front matter is the contract, the body is the prompt
  hooks/*.ts         the integrations — GitHub and the Claude agent included. Not part of the engine
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
| `agent.adapter` | — | Which executor runs steps and conversation turns: an id a hook registers with `defineExecutor`. This repository's is `claude`, from `.landrace/hooks/claude.ts` |
| `agent.isolation` | `worktree` | `none`, `worktree`, or `container` — how the engine prepares the directory a step runs in |
| `agent.*` (anything else) | — | Passed unread to the executor `agent.adapter` names. The Claude hook reads `model`, `plugins`, `mcp` and `sandbox`, and refuses any other key |
| `tracker.*` | — | Opaque to the engine, handed to your hooks unread. The shipped GitHub hook reads `tracker.repo` (`owner/name`) and optionally `tracker.bot` — which a GitHub App token needs (e.g. `myapp`), since it cannot look up its own login; logins compare ignoring case and a trailing `[bot]` |
| `tick.interval` | `60s` | How often to run |
| `tick.concurrency` | `3` | Tickets acted on at once |
| `security.screen` | `true` | Screen each prompt for injection before invoking an agent |
| `security.adapter` | `agent.adapter` | Which executor screens: an id a hook registers with `defineExecutor`, `claude` in this repository. It gets no tools, which it must enforce or refuse the run |
| `security.model` | — | The model the screening run asks for. No default: absent, the screening executor's own default decides |
| `log.redact` | `[]` | Secret names whose values must never be logged |
| `secrets.*` | — | `$VAR` references resolved from `.landrace/.env`, handed to hooks as values |
| `vars.*` | — | `$VAR` references resolved the same way and substituted into `workflow.yaml` and the step files wherever `{vars.<name>}` appears. **Not secrets:** nothing redacts them |

### What a step's agent is handed

A step's `capabilities` decide how the Claude hook starts the agent:

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
- a name is landrace's own operator server: `landrace`, or a server whose command line runs `landrace mcp` — the bin, `npx landrace@<version>` or `landrace#<ref>`, the `cli` entry with or without its extension, quoted, after `--`, or inside `sh -c`, in any case. Its tools create, update and reply on tickets, and a step agent holding them could move its own ticket. The command match is defence in depth over configuration you already trust, not a guarantee: a wrapper script under another name gets past it, so do not allow one.

Three things this does not do:

- **A different executor gets none of it.** `agent.plugins` and `agent.mcp` are settings the Claude hook reads; an `agent.adapter` naming a different hook gets the same `agent:` block passed on unread, these two keys included, and owes them no meaning of its own.
- **A definition's relative paths are not rebased.** A server is resolved from the root's `.mcp.json` but started by the agent's CLI in the step's working directory — its worktree — so a relative `command` or argument in that definition resolves there, against committed files only. Use absolute paths or commands on `PATH`.
- **A plugin's hooks still run.** `--restricted` ignores your settings files but not the hooks an enabled plugin ships, so every plugin in `agent.plugins` runs its hooks under read-only steps too. Enable only plugins you would let run there.

`landrace status` runs no step, so it resolves none of this and works without a `.mcp.json`. The screener never gets plugins, servers or tools: it reads attacker-reachable text and needs nothing to judge it. An allowlisted server's `env` and `headers` travel in the agent's argv, where `ps` can read them for as long as the step runs — keep credentials out of servers you allow. Their values, 8 characters or longer, are redacted from landrace's own log like a declared secret's, since an agent that fails to start a server can echo them into the error the loop logs.

### A write step's sandbox

A step declaring `repo:write` runs Bash. In this repository that is `build`, `fix-review` and `retro`: each merges `origin/main`, installs, runs the tests, commits, and pushes its own branch. The Claude hook starts every command such a step runs inside Claude Code's sandbox (Seatbelt on macOS, bubblewrap on Linux):

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
- **Your own user settings still load — but only those.** A write step does not run `--restricted`, so it loads your own user-level Claude settings beside these. The worktree's own `.claude/settings.json` and `.claude/settings.local.json` do not: a step could commit one to the ticket branch, and its hooks run outside the sandbox entirely, on the very next write step that checks that branch out — so a write run passes `--setting-sources user` to keep to your user settings alone. A path in your own `sandbox.filesystem.allowRead` still takes precedence over a `denyRead` this hook set, a command in your `sandbox.excludedCommands` still runs outside the sandbox entirely, and a host in your `sandbox.network.allowedDomains`, or any other sandbox key this hook does not set, still applies to the step too.

### Token permissions

What `githubToken` needs, on a fine-grained token — a classic token needs the `repo` scope instead:

| Permission | Level | Used for |
|---|---|---|
| Contents | Read and write | reading the spec from gh-pages, and publishing it; pushing a ticket's branch to an `https://github.com` origin |
| Workflows | Read and write | only when a build changes anything under `.github/workflows/` — GitHub refuses a push that does without it |
| Issues | Read and write | tickets, comments, labels |
| Pull requests | Read and write | opening a ticket's pull request; review threads; closing a dropped child's pull request when a workflow that splits work re-runs its breakdown |
| Metadata | Read-only | granted automatically |

`landrace start` and `landrace mcp` both check these before doing anything else — including a one-time write of a single empty, unreferenced blob to prove Contents is writable, since a fine-grained token cannot report its own permissions the way a classic token's scopes can. A token missing something refuses to start, naming what is missing, rather than running until the first step that needs it fails midway through a paid agent run. `landrace status` never checks or writes anything — it only reads.

### `.landrace/.env` — secrets

Referenced by name from `landrace.yaml`, resolved at load, and handed to hooks as values — a hook never reads `process.env` itself, which is what makes it testable and what lets redaction know every value to suppress. A `.env` here takes precedence over your shell, because a project's own file should be what runs.

`validate` fails if this file exists and git does not ignore it.

### Telemetry — OpenTelemetry

Off by default. When on, every event — `tick.*`, `step.*`, `effect.*`, `lock.*`, `screen.*`, and `agent.event` and `snapshot.built` whether or not `--debug` is on — is sent to a collector as an OTel **log record**, the way Claude Code exports its own events. The body and the `event.name` attribute are the event's name; every other field becomes an attribute prefixed `landrace.` (`landrace.ticket`, and the agent's output in `landrace.raw`), JSON-encoded if it is not a string, number or boolean. `*.failed`, `*.denied`, `*.blocked` and `lock.stolen` are `WARN`, everything else `INFO`. Records carry the same redaction stdout does. Traces and metrics are not exported.

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

A step whose round fails is never retried; the ticket halts, and there are two halts, one each for the two ways a round fails. A round whose output broke its contract — no json block, an undeclared shape, too long to record — is recorded as `malformed` and goes to `blocked` (`lr:blocked`). A round a security check stopped — the prompt screener said no or could not run, or the agent changed a worktree or created a ticket it had not declared it could — is recorded as `refused`, headed "Step refused by a security check" with the reason, and goes to `screened`, which wears `lr:screened` beside `lr:blocked`: it is still blocked for everything that asks, and says why. The split is `run.lastRefused`, derived beside `run.lastOutputValid` and scoped the same way — `false` for a broken contract, `true` for a refusal, `null` when the current stage has not failed — so exactly one of the two triggers takes any failure. Every other trigger leaving a stage that runs a step reads `"run.lastOutputValid": null`: a failed round is only ever the halts' to route.

Wherever it is a person's turn — `spec-questions`, `spec-human-review`, `pr-human-review`, `blocked`, `screened` — a reply goes to `triage`, one judge for all five. It reads the reply into a closed set of answers: `approve`, `revise`, `question`, `unclear`, `goto-spec`, `goto-build`. An answer that changes nothing where the reply was made sends the ticket back there; `run.previousStage` says where, read off `triage`'s own entry record. At `pr-human-review`, `revise` — a change asked for on the pull request — sends the ticket to `build`, as often as a person asks, and `build` is shown that message beside the spec. At a halt, `triage` is also told which step failed — `run.failedStage`, the failure that put the ticket there, never an older one it has since been sent around, and `none` when there is none — and "try again" there means that step when it was `spec` or `build` — for any other failure, that is the board's Retry to retry, not a reply's to say. `triage` has no round cap: each round waits for a person's own message, so a conversation is bounded by the person having it.

A person can also send a ticket back to an earlier step. `spec-questions`, `spec-human-review`, `pr-human-review` and `triage` itself list, under `goto`, the same two steps a `goto-spec` or `goto-build` answer may reach — `spec` and `build`, each while it has run fewer than three rounds:

```yaml
  - id: spec-questions
    goto:
      - { stage: spec, when: { "run.counters.spec": { $lt: 3 } } }
      - { stage: build, when: { "run.counters.build": { $lt: 3 } } }
```

The two halts, `blocked` and `screened`, list more: `code-review`, `fix-review` and `retro` while the ticket has a pull request — `code-review` capped at four rounds, `fix-review` capped on its own counter at four as well, `retro` at three and only while a pull request is unmerged — and `triage` while a person has written on the ticket, capped at twenty. That is because a halt's Retry is a goto to the step whose failure put the ticket there, and any stepped stage can fail, not only `spec` or `build`.

`build` lists one target: itself, while it has run fewer than three rounds. `publish` pushes before it moves the ticket, so a push that fails — nothing was committed — leaves the ticket at `build` with its round settled, and publish retries the push on every tick. "Go to step… build" runs another round instead.

When `code-review` settles with no thread open, a ticket that was corrected on the way — a second `spec` or `build` round, or any `fix-review` round — goes to `retro` first, unless its pull request has already merged, and one that was not goes straight to `pr-human-review`; the two triggers are each other's negation, so exactly one matches. `retro` reads the ticket's history as evidence, never instructions, and commits `retro: lessons from #N` to the step prompts (below their front matter), `.agsync/instructions.md` or `.agsync/skills/` alone — never the workflow, the hooks or `src/` — runs the tests, then goes on to `pr-human-review`, which pushes the branch as it enters. That push, like every `branch.push`, has nothing to do when origin's copy of the branch already holds everything the checkout's does — a person's push or "Update branch" moved it on. That commit is not reviewed by `code-review`, which has already run: the person at `pr-human-review` is its only gate, and a lesson they reject is a thread `fix-review` reverts. A reopened thread goes round `fix-review` and `code-review` again, and `retro` with it, up to three rounds. A lesson in a step prompt reaches later tickets once it is merged and `landrace start` is run again, since the workflow is loaded at start; instructions and skills are read from each step's worktree and need no restart.

A `goto-spec` or `goto-build` answer, "Go to step…", or `landrace_goto` names its target outright; the page's Retry names none — it is a goto to the step whose failure put the ticket where it is, read off `run.failedStage`, and refuses, saying so, if there is none. That is the stage the ticket last entered before this one — walking past a settled round trip from the current visit, such as a question at a halt the judge sent home — and only while it is still failed: a spec that failed before a person sent the ticket on to build is not what halted it after the reviews ran out, and Retry does not reach back to it. Whichever way it is asked, it writes a goto record as Landrace. The engine takes it before any trigger. A target the stage does not list halts the ticket. One whose `when` does not hold is declined — the reply comes home — and the command refuses it up front with the reason, reading the ticket afresh: not found or closed, one the workflow's `eligible` rules skip (with the rule's own `else`), unplaceable or ambiguous, a precondition that fails, a step still owed, an unlisted target, or one past its cap. It reads and writes under the ticket's lock, the one a tick converges under, so no tick moves the ticket in between; while a tick holds that lock for more than a moment, the command refuses, saying the ticket is busy. A stepped stage whose round is already settled — `triage` once it has answered, say — still accepts a goto: that is also how a person recovers a ticket a crash stranded between a target's entry comment and its status label. A goto is consumed by the entry record its target writes on arrival, so a target must record its entry; `landrace validate` checks that, and that a judge's route only sends where its stage lists.

A stage that runs a step may name the **branch** that step works on — a template over `{ticket}`, `{stage}` and `{round}`, and nothing else:

```yaml
  - id: build
    step: steps/build.md
    branch: "landrace/{ticket}"
```

The step's worktree is then checked out on it: the branch itself for a step declaring `repo:write` — so what it commits outlives the worktree — and that branch's commit, detached, for a read-only step, so a reviewer reads the ticket's code rather than `main`'s and cannot commit onto it. The branch is created, the first time, at whatever your own checkout's `HEAD` is right then — not at `origin`'s default branch — so local commits you have not pushed yet, and whatever branch you happen to have checked out, end up in the ticket's pull request. A stage with no `branch` gets a detached `HEAD`, and nothing its step commits is kept. The engine names no branch of its own: a workflow wanting two per ticket names two. A branch needs `agent.isolation: worktree` — with no worktree there is nowhere to check it out, so `validate` reports and `start` refuses a stage naming one without it. A template git would refuse is refused at load; a ticket id that makes an invalid name (`a..b`) halts that ticket before its step runs; a branch already checked out elsewhere — your own checkout, say — halts it with where, and is never taken. The worktree is rebuilt whenever the next step needs it on something else, so only what was committed carries over.

Publishing is two effects, each naming its branch, which the shipped workflow puts on a `publish` stage between `build` and `code-review`:

| Effect | Applies | Satisfied when |
|---|---|---|
| `branch.push` | pushes the branch to `origin`, fast-forward only — never forced | the checkout's branch head equals `origin`'s as last fetched or pushed, or the checkout has no such branch |
| `pull.open` | opens a pull request from the branch into the default branch, `Closes #<ticket>` | the ticket already has an open or merged pull request from that branch |
| `pull.review` | posts a review step's answer on the open pull request from the branch: its prose as one review, a thread per finding, and the reviewer's own threads it lists as resolved — never a person's | checked by `apply` against the review's own marker on GitHub, since the snapshot carries no reviews; a route effect is applied once, right after its step |

`code-review` answers with a list rather than posting anything itself — it has no tool and no shell to do either: `reviewed` carries `findings`, each a `file`, a `line` and a `body`, and `resolved`, a list of thread ids. The route's effect is `pull.review`, which is handed the step's output as well as its prose. A finding on a line the diff shows becomes a line thread; one elsewhere in a changed file, a thread on the file naming the line; one in a file the pull request does not touch, a line in the review's text, since GitHub cannot thread it. Each thread ends in a `finding` marker, which is how a later round tells the reviewer's threads from a person's. Those threads are what the open-thread count reads, so a review with findings sends the ticket to `fix-review`.

A write step pushes its own branch: the shipped `build`, `fix-review` and `retro` prompts end with `git push origin HEAD`, run inside the sandbox (see [A write step's sandbox](#a-write-steps-sandbox)). `branch.push` stays on `publish`, and on `code-review`'s and `pr-human-review`'s entry, as the safety net. It is satisfied when the agent already pushed, and otherwise pushes what the agent committed and left unpushed, so a fix round's commits are on the pull request before the reviewer reads it. The GitHub hook pushes from the repository its own file is in:

- `origin` must have exactly one push URL (`git remote get-url --push --all origin`); `git push` would otherwise push to every one of them, so any other count is refused.
- The token goes to git only when that URL is exactly `https://github.com/<tracker.repo>`, with or without `.git` or a trailing `/` — matched as a string, not parsed, so no URL git and landrace could read differently gets it — and then through git's environment (`GIT_CONFIG_*`, as an `extraheader` scoped to that exact URL, not to github.com), never on a command line, where any process could read it. `git@github.com:<owner>/<repo>.git` and `ssh://git@github.com/<owner>/<repo>.git` are pushed with your own ssh credentials and no token, as is any origin not on GitHub. A GitHub origin naming another repository is refused, and so is any other URL mentioning github.com — one with credentials, a port, percent-encoding, a query — since it might not be the repository it looks like.
- The push is the ticket's branch and nothing else: an explicit refspec (so `remote.origin.push` does not widen it, and a mirror remote refuses it), with tag-following and submodule pushing off.
- Every push runs with `core.hooksPath=/dev/null`, so none of the checkout's hooks run — a step that may write shares the repository's config and could otherwise install one that runs inside the push's environment. Your own pre-push hooks do not run on landrace's pushes either.
- A branch with nothing committed beyond `origin/HEAD` (as this checkout knows it — no fetch) is not pushed; the ticket halts saying so, and carries on once something is committed. GitHub's "No commits between" on `pull.open` says the same.
- A push is stopped after five minutes, or when the run is.

Workflow-level keys beyond `stages`:

| Key | Meaning |
|---|---|
| `eligible` | Which tickets Landrace touches at all, each rule carrying the `else` reason `status` prints for a ticket it skipped |
| `budget.stepTimeout` | How long one agent invocation may take, unless its step names its own `timeout`. The round caps are the `$lt` counters in the triggers themselves and in each `goto` entry's `when`, where the validator can see and bound them |
| `hooks` | The integration modules, by path, in the order pre hooks run |

### Splitting work into sub-tickets

Splitting is an engine feature a project enables in its own workflow; the shipped `.landrace/` workflow does not use it. [`tests/fixtures/children`](tests/fixtures/children/workflow.yaml) is the worked example — the shipped flow as it stood before `publish`, plus a `breakdown` stage between `triage` and `build`, a `children-running` stage the parent waits in, `build` as a second entry for the children, and `done` closing a finished ticket so its parent can count it — and it is what the tests drive to keep the feature working. Its stages name no branch and it publishes nothing, so its review starts once a pull request for the ticket exists, however that was opened; a project copying it wants the shipped workflow's `branch` fields and `publish` stage too.

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

For an installed landrace, hook modules are imported at runtime with no build step, so they need a Node that strips types: 22.18 or newer does it unflagged, and an older 22.x needs `--experimental-strip-types`. Inside this repository the build is the dependency: `landrace/hooks` resolves, by package self-reference, to the built `dist/hooks.js`. After pulling, run `pnpm build` before `landrace start`, `landrace mcp` or `landrace validate`. A hook newer than the build fails to import, and the error says to rebuild.

Conditions are MongoDB-style documents over snapshot paths, evaluated with a **closed operator allowlist** — `$eq $ne $in $nin $lt $lte $gt $gte $exists $all $size $and $or $not`. `$where` and `$regex` are rejected at load, because a workflow file is a repo file a pull request can edit.

### Executors: the coding agent is a hook

Landrace ships no coding agent. `defineExecutor` registers one, either as `{ id, run }` directly or as `{ id, create(ctx) }` — a factory the runtime calls once at startup, with `ctx` the same `RuntimeContext` every hook gets plus `dir` (the workflow directory, for finding the repository) and `redact` (secrets a run's own setup discovers, such as an MCP server's `env`, that the configuration never named). A factory that cannot start — a bad `agent.*` key, a server `.mcp.json` does not define — throws, and `landrace validate` reports it under the `executor` rule, one problem per line.

**The engine hands every run:**
- the rendered prompt;
- the directory to run in;
- the step's capabilities;
- its model;
- a time limit. At the limit the engine aborts the run's signal but keeps waiting for the run, so an executor that honours neither holds its ticket until the process dies;
- the session to resume;
- for a `tickets:create` step, the engine's own ticket server, ready to start.

It gets back the agent's text and a session id. Beyond `agent.adapter` and `agent.isolation`, the rest of the `agent:` block is opaque to the engine and passed on to the executor unread — a second agent is a hook file, never a change to `src/`.

A hook reads `agent:` only when `agent.adapter` names it, because `agent:` belongs to the step agent. An executor that `security.adapter` alone names is there to screen: the block is in another agent's vocabulary, and the screener's model arrives on each run from `security.model`.

**An executor must, or else refuse the run:**
- enforce every declared capability;
- give a run that declares none no tools at all (that is the screener's run);
- never hand a step or a turn the operator's own `landrace` MCP server;
- run in the directory it is given, because the engine's read-only check inspects that directory, and a run anywhere else defeats it;
- never pass the engine's own process environment to the agent, because a secret can come from the shell and the agent must not hold tracker credentials;
- honour a named model;
- stop at the limit and on abort.

The engine checks a read-only step's worktree afterwards whatever the executor claims — a backstop, not a licence to skip the rest.

`.landrace/hooks/claude.ts` is the worked example, built with `defineExecutor({ id, create(ctx) })` so it can read its own settings out of `agent:` and register its secrets for redaction before the first step runs. A project on another agent copies the shape, not the file.

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
| `capabilities` | What the agent may do — `repo:read`, `repo:write`, `tickets:create`. The first two are enforced by diffing the worktree afterwards, the third by which MCP tool the executor hands the agent — not by the flags the Claude hook hands its agent, which another executor never sees. An unenforceable capability refuses the step rather than pretending |
| `model` | Overrides `agent.model` for this step. A cheap step should say so |
| `timeout` | Overrides `budget.stepTimeout` for this step, e.g. `120m`. A step that writes code can need hours where a classifier needs minutes |
| `output.discriminator` | The field whose value picks the shape |
| `output.shapes` | What each value of the discriminator must look like. Output that matches none is a hard fail, recorded, never retried |
| `output.routes` | Where each shape goes. One route, one effect — two routes matching one output is ambiguity, and ambiguity halts. A route may also name a `goto`, a stage its stage lists, which the engine takes before any trigger |

Both schemas are strict: an unknown key fails to load rather than being ignored. A field the engine silently ignores is a lie, and this codebase had four of them until the last review.

## What `validate` proves

| Rule | Catches |
|---|---|
| schema, ids, entry | Malformed definitions, duplicate stages, no entry point, an entry stage (of several) with no `"run.stage": null` trigger |
| reachability, `unknown-stage` | A stage nothing leads to; a trigger naming a stage that does not exist |
| `dead-end`, `self-loop` | A non-terminal stage with no way out; a stage triggering on itself |
| `cycle-bound` | A loop with no counter bound — an agent that could run forever. An edge whose trigger waits for a person's own message (`run.lastEvent.actor: human`, exactly) bounds it too: every lap needs someone to write |
| `totality` | A declared output shape with nowhere to go |
| `identity` | Two stages that could both be "where the ticket is" |
| `operator` | A disallowed predicate operator, anywhere including nested |
| `path-coverage` | A predicate — in a trigger, an `identity`, a `requires` or an `eligible` rule — reading a field no hook provides |
| `vars` | A variable that does not resolve, a `{vars.x}` nothing defines, a declared variable nothing references, a variable holding a secret's value |
| `branch` | A stage `branch` git would refuse as a name, one using anything but `{ticket}`, `{stage}` and `{round}`, one on a stage that runs no step, or one with `agent.isolation` other than `worktree` |
| `mcp` | An `agent.mcp` server with no `.mcp.json` at the repository root, a name `.mcp.json` does not define, or landrace's own operator server |
| `goto` | A `goto` target that is not a stage, is named twice, or records no `enter` naming `{round}` — its entry record is what consumes a goto; a route sending tickets somewhere its stage does not list |
| `trigger-name` | A trigger named `goto`, the name a goto transition is logged under |
| `reserved-field` | A `goto` or `from` field in an `on_enter` effect or a route's effect — fields only the engine writes |

Every rule runs on every workflow. An earlier version abstained where a trigger
could fire from anywhere, which turned out to mean *always* — the entry trigger
every real workflow needs switched three rules off graph-wide. The graph rules
now work from two derived views instead: a superset that treats an unanchored
trigger as an edge from every stage, for `dead-end` and `reachability`, and the
anchored edges alone for `cycle-bound`.

## CLI

```bash
landrace start [-w <dir>] [--once] [--debug] [--ui-port <port>] [--no-ui] [--telemetry] [--otel KEY=VALUE]...
                                         # watch the tracker; serves the triage page on 127.0.0.1:4545
landrace status [-w <dir>]               # one line per ticket: where it is, and why one was skipped or stopped
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
Done holds what the source lists as closed; the shipped GitHub hook lists a
ticket Landrace moved (it carries an `lr:stage:*` label) for 30 days after it
closes. Each pull request and document shows what it is, its state (a pull
request's glyph is green while open, purple once merged, red once closed) and
how long ago it was opened, when the source says.
A branch sits in the lane of its most urgent ticket, so a sub-ticket that needs
you lifts its whole branch into "Needs you", opened down to it. A search box
filters by title or id, and Collapse all / Expand all set every branch at once.
Top right, a countdown to the next scheduled
tick and a "Run next tick now" button. It polls every two seconds and costs
no tracker calls: it shows what the tick already fetched and what the
process already knows is running. `--ui-port` moves it, `--no-ui` turns it
off, and `--once` never serves it. It binds loopback only and answers only
its own host name.

A ticket a security check stopped sits in "Needs you" with a shield beside
its badge and the note "blocked by a security check"; the refusal's own reason
is in the ticket's comments, which the page does not read. `landrace status`
says "blocked: security check refused a step" for the same ticket.

The page has four writes, and three of them can start paid agent runs, so all
are guarded beyond the Host check. The tick button starts a tick, or, while
one is running, says "queued" and runs one once every tick in flight has
ended — which, with an agent step in flight, can be long after the next
scheduled tick. A Retry or "Go to step…" that went through, and every
`landrace mcp` write — reply, goto, ask, resolve, create or update a ticket —
wake the loop the same way, so a person does not wait out the interval. The
MCP server is a separate process: it touches a `wake` file beside the locks
in `$TMPDIR/landrace/<repo>/`, and `start` checks that file every second. The "Retry"
item, first in a blocked or screened ticket's menu, sends the ticket back to
the step whose failure put it there. The "Go to step…" items, offered on any
open ticket whose agent is not running and whose stage lists a goto, send it
back to a step its stage names. Each asks first, and each writes the same
goto record `landrace_goto` does, after reading the ticket afresh: a ticket
that has moved on, a step its stage does not list, or one past its cap is
refused in a sentence the menu shows. The icon-only Refresh button, right of
Collapse all / Expand all, starts no agent at all — it re-reads the tracker and
reloads the board from it, one list and nothing more — but it still spends
that read, so it is guarded the same way as the other three rather than left
as a plain GET. Each write requires its own custom `x-landrace-action` header
(`tick`, `retry`, `goto`, `refresh`), which a cross-site `<form>` cannot set,
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
Cursor and Codex, and a "Copy prompt" item below its own divider. All four
links pre-fill a chat about that ticket, over the landrace MCP, and never
send anything on their own — picking one just opens the editor with the
prompt sitting in the box. Cursor
has no per-window deep-link target, so its link opens in whatever window is
already active rather than the ticket's own checkout. "Claude Code" opens a
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
- A step declares what it may do, and the declaration is enforced by diffing its worktree before and after — not by the flags the Claude hook hands its agent, which another executor never sees. A conversation turn is held to the same declaration as the step it continues.
- Under the Claude hook, a step or turn gets exactly the MCP servers `agent.mcp` allows, strictly. The hook refuses Landrace's own operator server at startup by name, and by its command line in the common spellings — a best-effort check on operator-trusted config, so do not allowlist a wrapper that runs it. Keeping that server from a step is part of every executor's contract, not this hook's alone.
- Every agent invocation is screened first, including a turn typed through the MCP: the place an operator pastes text someone sent them is not a place to start trusting it. A step the screener refuses is recorded as a refusal, not a broken contract, and lands in `screened` for a person to read.
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
