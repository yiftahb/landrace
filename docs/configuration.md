# Configuration

A project's Landrace settings live in its **workspace**, the `.landrace/` folder: `landrace.yaml` for how Landrace runs, and `.env` for secrets. The workflows themselves are described in [Workflows](workflows.md).

## landrace.yaml

`.landrace/landrace.yaml` holds the runtime: how agents run and where items live. A workflow keeps none of this, so one workflow carries from project to project.

Every key, with its default:

| Key | Default | Meaning |
|---|---|---|
| `version` | — (required) | Always `1` |
| `agent.adapter` | — (required) | The executor that runs steps and conversation turns: an id a hook registers with `defineExecutor`. The shipped ones are `claude` and `codex` — see [Integrations](integrations.md#claude-code) |
| `agent.isolation` | `worktree` | How the engine prepares the folder a step runs in: `worktree`, or `none` to run the agent in this checkout. A stage that names a `branch` needs `worktree`. The schema also accepts `container`, but it is not implemented: `landrace start` and `landrace mcp` refuse it |
| `agent.worktree.copy` | `[]` | Untracked or ignored files copied from your checkout into a write step's worktree, as globs from the repository root — see [A write step's worktree](#a-write-steps-worktree) |
| `agent.worktree.setup` | `[]` | Commands run in a write step's worktree before its agent, when the lockfiles have changed — see [A write step's worktree](#a-write-steps-worktree) |
| `agent.worktree.lockfiles` | the three root lockfiles | Globs, from the repository root, of the lockfiles whose change runs `setup` again — see [A write step's worktree](#a-write-steps-worktree) |
| `agent.worktree.setupTimeout` | `15m` | How long each setup command may run, as a [duration](#durations) |
| `agent.*` (any other key) | — | Passed unread to the executor `agent.adapter` names. The shipped executors' keys are below |
| `tracker.*` | `{}` | Passed unread to the hooks. The GitHub integration reads `tracker.repo` and `tracker.bot` — see [Integrations](integrations.md#github) |
| `branch` | `landrace/{item}` | The branch each item's work is on. `{item}` is the item's id as the tracker gives it, unchanged, so a Jira key stays uppercase. The forges tie a pull request to an item only by this branch, and every workflow's `branch` lines must name it. `validate` and `start` refuse a template that names `{item}` other than exactly once, has no fixed text before `{item}`, names any other `{placeholder}`, or that git would refuse as a branch once `{item}` is filled with an id — see [The item's branch](workflows.md#the-items-branch) |
| `tick.interval` | `60s` | How often a tick runs, as a [duration](#durations) |
| `tick.concurrency` | `3` | How many agents run at once across the whole workspace, overlapping ticks and every workflow included. A tick keeps starting its remaining items as its own runs finish. It leaves an item for a later tick once no slot is free and no run of its own is left to free one, or once a later tick has listed. A pairing or an MCP conversation turn takes no slot |
| `security.screen` | `true` | Screen each prompt for injection before running an agent that can act — see [Security](security.md#screening-prompts) |
| `security.adapter` | `agent.adapter` | The executor that screens: an id a hook registers with `defineExecutor`. It must run the screener with no tools, or refuse |
| `security.model` | none | The model the screening run asks for. Absent, the screening executor's own default decides |
| `log.redact` | `[]` | Names of secrets whose values are cut from every log line and event. Each must name a declared secret whose value is 8 characters or longer, or `landrace start` refuses. A secret not named here is not redacted from the log |
| `secrets.*` | `{}` | Values handed to hooks, usually `$VAR` references resolved from [`.env`](#env) |
| `workflows` | by each workflow's `name`, then folder id | The order the MCP lists workflows in. The board's sidebar is always sorted by name. Display only. When given, it must name exactly the folders under `workflows/`: a name with no folder, a folder not named, or a name twice is refused |
| `vars.*` | `{}` | Values substituted into the workflow files — see [vars](#vars) |
| `notify.on` | none | The events to tell a person about. There is one: `needs-you` |
| `notify.via` | none | Notifier ids, each registered by a hook with `defineNotifier`. The shipped one is `slack` |

### The agent block

Both shipped executors, Claude Code and Codex, read these `agent.*` keys and refuse any other at startup:

| Key | Default | Meaning |
|---|---|---|
| `agent.model` | the agent's own default | The model every step and turn asks for. A step's own `model` wins |
| `agent.effort` | the agent's own default | How hard the agent thinks, for every step and turn (never the screener). A step's own `effort` wins. Claude takes `low`, `medium`, `high`, `xhigh` or `max`; Codex takes `none`, `low`, `medium`, `high` or `xhigh` |
| `agent.mcp` | `[]` | The MCP servers a step or turn may use. Each entry is a server name, or `{ name, tools }` to allow only some of its tools. A step's own `mcp` narrows it — see [Workflows](workflows.md#step-files) |
| `agent.sandbox.hosts` | `[]` | The only hosts a write step's commands may reach |
| `agent.sandbox.deny` | `[~/.config/gh, ~/.ssh, ~/.aws, ~/.npmrc]` | Paths under your home that a write step may not read. A list you write replaces the default |
| `agent.plugins` | `[]` | Claude Code only: the plugins a step runs with, unless it lists its own `plugins`. No step loads the plugins you enabled for yourself. Codex refuses it |

What these keys do to a run — which servers a step gets, what the sandbox allows and refuses — is in [Security](security.md#mcp-servers-a-step-may-hold) and [Security](security.md#a-write-steps-sandbox); how each executor applies them is in [Integrations](integrations.md#claude-code).

An `agent.mcp` entry names a server defined in the repository root's `.mcp.json`. A tool name follows the same rule as a server name — letters, digits, `.`, `_` and `-`. An entry with an empty `tools` list, or a server named twice, is refused. This repository's own configuration allows the code graph's reading tools and nothing else:

```yaml
agent:
  mcp:
    - name: codebase-memory-mcp
      tools: [search_graph, trace_path, get_code_snippet, query_graph, get_architecture,
              search_code, get_graph_schema, index_status, list_projects, index_repository]
```

`landrace start` and `landrace mcp` refuse to start — and `landrace validate` reports the same — when `agent.mcp` names a server but the repository root has no `.mcp.json`, when a name is not in it (the refusal lists the names it does define), or when a name is Landrace's own operator server. `landrace status` runs no step and needs no `.mcp.json`.

### A write step's worktree

A step runs in a fresh checkout under the temporary folder, which holds tracked files only. `agent.worktree` gives a write step's worktree what your project needs to build and test that git does not track:

```yaml
agent:
  worktree:
    copy: ["**/.npmrc", "**/.env"]
    setup: ["pnpm install --frozen-lockfile --prefer-offline"]
    lockfiles: ["pnpm-lock.yaml", "*/pnpm-lock.yaml"]
    setupTimeout: 15m
```

- **`copy`** copies the files each glob matches from your checkout into the worktree, at the same paths, before every write step. Only untracked or ignored files are copied. A glob that matches a tracked file, an absolute path or one with `..` is refused at start, naming the file. A file the item's branch tracks is refused before the step, too, so the branch's own version is never replaced. A link that leads outside the repository is not followed.
- **`setup`** runs each command, in order, in the worktree, after `copy` and before the agent. It runs through your shell, outside the agent and its sandbox, with the same minimal environment the agent gets. A private registry's token reaches it through a copied file such as `.npmrc`.
- **`lockfiles`** decides when `setup` runs again in a kept worktree: globs, from the repository root, of the lockfiles hashed together with the commands. The default is the three root lockfiles, `pnpm-lock.yaml`, `package-lock.json` and `yarn.lock`. A monorepo whose workspaces lock their own dependencies, such as `backend/pnpm-lock.yaml`, lists those too, or `**/pnpm-lock.yaml`. A glob matches the worktree's files that git tracks or does not ignore, so a lockfile a step adds or removes counts as a change. An absolute glob, or one with `..`, is refused at start.
- **A failure or a timeout** stops the item before the agent runs, with the end of the command's output as the reason. Nothing is recorded, so the next tick tries again.
- **Events:** `worktree.setup.started`, `worktree.setup.finished` and `worktree.setup.failed`, each naming the item and the command.
- `copy`, `setup` and `lockfiles` need `agent.isolation: worktree`; `landrace start` refuses them otherwise.

A write step's worktree is kept between the item's write steps on the same branch, and removed when the item reaches a terminal stage. The next tick also removes it once the item is closed, for example by its merged pull request. A write step on a stage that names no `branch` gets `copy` and `setup` too, in a worktree removed when the run ends. Between runs the kept worktree is detached from the branch, so you can check the item's branch out in your own checkout while the item waits; switch back off it before the item's next write step, which halts while the branch is checked out elsewhere. On reuse it is put back on the branch and reset to the branch's commit: what a step left uncommitted is removed, and what git ignores, such as `node_modules`, stays. `setup` runs again only when its commands, or the files `lockfiles` matches, have changed since it last passed. A worktree that is missing, or on another branch, is rebuilt, and setup runs again.

What this exposes to a step is in [Security](security.md#copied-files-and-setup).

### notify

With a `notify:` block, an item that comes to rest in Needs you is announced once through each notifier `via` names:

```yaml
notify:
  on: [needs-you]
  via: [slack]
```

The message reads `#29 needs you in <workflow> — <title> · <why>`, where `<workflow>` is the name of the workflow that owns the item and `<why>` is the board's note for it (`waiting on you`, `blocked by a security check`, …). Needs you is the board's own rule, so the two never disagree.

- An item that stays in Needs you is not announced again; one that leaves and comes back is.
- An item that arrives at a `waits: person` stage placed by its own state is announced by the tick, after its pass, when it settled there on its first pass or its lock was held elsewhere. A stage placed by a label is announced on the transition into it.
- A tick whose pass halts, fails or moves the item on announces nothing, and the next tick that finds it waiting announces it.
- Nothing is kept about what was sent. After a restart — and on every `start --once`, which is a process of its own — each item already waiting at a stage placed by state is announced once more.
- An item passing through `triage` on its way back is never announced: `triage` runs its step at once.
- Sending is fire and forget. A notifier that fails is a `notify.failed` line in the log, and it never stops an item.

`start` refuses, and `validate` reports, a `via` id no loaded notifier answers to. Writing a notifier is in [Writing an integration](hooks.md#notifiers); Slack's setup is in [Integrations](integrations.md#slack).

### vars

`vars` lets one workflow serve several instances — say, one per developer, each working the items assigned to them:

```yaml
vars:
  assignee: $LANDRACE_ASSIGNEE
  team: platform
```

Wherever `{vars.<name>}` appears in `workflow.yaml` or a step file — a condition, an effect field, a prompt — it is replaced at load with the resolved value. Everything downstream then sees a literal, exactly as if it had been typed: the schema, the operator allowlist, `validate`'s path coverage and the condition itself.

Substitution walks the parsed YAML, never its text, so a value with a colon, a newline or a quote lands in one string and stays one string. It fills in `{vars.…}` and nothing else: `{round}`, `{stage}` and `{node.title}` belong to the engine and survive untouched. Values are strings.

Vars are configuration, not state. They do not vary per item, so they are not in the snapshot.

Every mistake is a load error, never a default:

- a var that does not resolve, or resolves to an empty value, is refused by name — a condition filled in with nothing matches no item, which is the hardest failure there is to read;
- a `{vars.x}` nothing defines is refused, naming the variable, the file and the field;
- a `vars` entry nothing references is refused too — usually the same typo seen from the other end.

**Vars are not secrets.** A secret is handed to a hook, cut by value from the text Landrace composes itself, and — when `log.redact` names it — cut from the log; what is and is not scrubbed is under [.env](#env). A var is substituted into the workflow, so it reaches tracker comments, agents' prompts and the events recording both, with nothing redacting it. `validate` reports, and `start` refuses, a var whose value equals a declared secret's.

**Several developers, one repository.** Each instance exports its own assignee, and the workflow filters on it:

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

An item assigned to somebody else is skipped, with that `else` as the reason `landrace status` prints, and nothing is written to it. An item assigned to nobody is skipped by everybody rather than worked by everybody, because `node.state.assignees` is an empty list, never absent. The skip costs nothing per item: `list()` already carries every item's assignees, so the rule is answered before any item is read and before any lock is taken. It is still answered after the list, though, so it cannot keep a list under its bound. On a Jira project too large to list whole, scope the tracker itself with the `jiraAssignee` secret; see [One developer's issues](integrations.md#jira).

### Durations

`tick.interval`, a workflow's `budget.stepTimeout` and a step's `timeout` are durations: a whole number followed by `s`, `m` or `h` — `60s`, `2m`, `1h`. A bare number is refused, and so is anything above 596 hours.

## .env

`.landrace/.env` holds secrets as `KEY=value` lines. Blank lines and lines starting with `#` are ignored, and a value may be quoted.

```dotenv
GITHUB_TOKEN=ghp_your_token_here
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T…/B…/…
SLACK_NOTIFY_USER=U0123456789
```

`landrace.yaml` names each secret it wants under `secrets:`, as a `$VAR` or `${VAR}` reference:

```yaml
secrets:
  githubToken: $GITHUB_TOKEN
log:
  redact: [githubToken]
```

The reference is resolved at load, from `.env` first and then your shell — a project's own file wins over whatever is exported in the terminal. The value is handed to hooks; a hook never reads `process.env` itself, which keeps it testable and lets redaction know every value to suppress. Every declared secret of 8 characters or more is cut from the text Landrace composes itself: the failure records it writes on an item (a refused or rejected round's reason), the errors the board's item panel shows, and the agent activity the panel lists. What an agent writes is posted as the agent wrote it, unscrubbed: a step's prose and output through its route (`tracker.comment`, `pull.review`, a published spec), and a conversation's answers. Name a secret in `log.redact` to cut it from the log too. A secret whose variable is set nowhere is reported by `validate`, and `landrace start` and `landrace mcp` refuse to start over it.

`validate` fails if `.env` exists and git does not ignore it. `.landrace/.env.example` lists the variables this repository uses.

## Telemetry

Telemetry is off by default. When it is on, every event — `tick.*`, `step.*`, `effect.*`, `lock.*`, `screen.*`, `notify.*`, `worktree.setup.*`, and `agent.event` and `snapshot.built` whether or not `--debug` is on — is sent to an OpenTelemetry collector as a **log record**, the way Claude Code exports its own events.

- The record's body and its `event.name` attribute are the event's name.
- Every other field becomes an attribute prefixed `landrace.` (`landrace.item`; an agent's parsed output in `landrace.event`, and a line of it that was not JSON in `landrace.raw`), JSON-encoded unless it is a string, number or boolean.
- `*.failed`, `*.denied`, `*.blocked` and `lock.stolen` are `WARN`; everything else is `INFO`.
- Records carry the same redaction as the console. Traces and metrics are not exported.

| Variable | Meaning | Default |
|---|---|---|
| `LANDRACE_ENABLE_TELEMETRY` | `1` turns export on | off |
| `OTEL_LOGS_EXPORTER` | `otlp` or `console` | `otlp` |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` or `http/json`; `grpc` is refused | `http/protobuf` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | The collector's base URL; `/v1/logs` is appended | `http://localhost:4318` |
| `OTEL_EXPORTER_OTLP_HEADERS` | `k=v,k=v`, for example auth; values are percent-decoded | none |
| `OTEL_SERVICE_NAME` | `service.name` | `landrace` |
| `OTEL_RESOURCE_ATTRIBUTES` | `k=v,k=v`, extra resource attributes | none |
| `OTEL_LOGS_EXPORT_INTERVAL` | Batch delay, in milliseconds | `5000` |

Set them in `.landrace/.env` or your shell (`.env` wins), or on the command line, which wins over both: `landrace start --telemetry` sets `LANDRACE_ENABLE_TELEMETRY=1`, and `--otel KEY=VALUE`, repeatable, sets any key in the table — any other key is a startup error. `landrace mcp` reads `.env` and the shell only, and refuses `OTEL_LOGS_EXPORTER=console`, which would write into its protocol on stdout. `landrace status` never exports.

`landrace start` flushes the batch on `--once`, on a normal stop and on the first Ctrl-C; a second Ctrl-C exits without waiting. An export that fails says so once on stderr, and again only after one has succeeded. None of these variables reach the agent's process: `OTEL_EXPORTER_OTLP_HEADERS` is usually a credential.

To see it work, run a collector with the `debug` exporter on port 4318, then:

```bash
landrace start --once --telemetry
```
