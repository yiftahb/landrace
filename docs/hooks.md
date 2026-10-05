# Writing an integration

The engine talks to nothing outside itself. Reading a tracker, publishing a page, reading a pull request, running a coding agent — each is a **hook**: a TypeScript module in the workspace's `hooks/` folder, written against the `define*` contracts, or re-exporting an integration Landrace ships. This page is for someone writing one. The integrations Landrace ships, and how to set each up, are in [Integrations](integrations.md).

## Hook modules

A workflow lists its hook modules by path:

```yaml
hooks:
  - ../../hooks/github.ts
  - ../../hooks/claude.ts
```

- A path is relative to the workflow's folder and must resolve inside `.landrace/`, symbolic links included, compared after `realpath` — `workflow.yaml` is a repository file a pull request can edit.
- The order of the list is the order pre hooks run in.
- A module imports the contracts from `landrace/hooks` and exports whatever kinds it implements. The loader classifies each export by the **brand** its `define*` helper stamped, never by its shape, so one module can be a whole integration.
- Two of anything singular — two sources, two operators, two hooks of one kind under one id, two notifiers under one id — halt at load, naming both modules.

Hook modules are imported at runtime with no build step. Which Node that needs, and the build it needs inside this repository, is in [Command line](cli.md).

A hook's `landrace` imports — `landrace` itself, `landrace/hooks`, `landrace/kit`, `landrace/testing` and `landrace/integrations/<vendor>` — always resolve to the copy of Landrace that is running, through that copy's own `exports`: the global install, or the project's own copy when that is the one running. A `landrace` in the project's `node_modules` is never loaded beside it, so one process holds one version of the engine and the kit, and a project needs no `node_modules` for its hooks to run. Every other import, `landrace-foo` and `@scope/landrace` included, resolves as Node resolves it. For type checking in an editor, a project may also add `landrace` as a dev dependency; at run time the engine's copy wins. A hook that imports an export the running copy lacks fails to load, and the error says to update Landrace.

## The define* contracts

A hook that works on one item gets a `HookContext`: the item's id, its snapshot, the configuration, the resolved secrets, an abort signal and a logger. Every other call gets a `RuntimeContext`, the same without the item and the snapshot: a source's `list()`, `read()` and `remoteHead()`, every operator method, a notifier's `send()` and a preflight's `check()`. A preflight's context also carries `capabilities`, every capability a step of a loaded workflow declares, so a check can skip what no step asks for; it is absent when the caller cannot say, and a check then checks everything. It also carries `createFields`: for each project a loaded route's `tracker.create` files in, the field ids its `fieldsFrom` maps, so a tracker can find them on the issue type it files. A source's `read()` is what the snapshot is built from, so it never gets one. A hook never reads `process.env`: its secrets arrive as values, which keeps it testable and lets the log redact every one.

| Helper | Kind | What it does |
|---|---|---|
| `defineSource` | source | Enumerates items: `relations` (the relationship types it reports), `list()` once per tick, `read(id)` once per pass, and optionally `brief()` for prompt text and `remoteHead()` for a branch's head on origin. See [Architecture](architecture.md#sources-list-and-read) |
| `defineOperator` | operator | The writes a person asks for by hand: `createItem`, `updateItem`, `relates()`, `relate`, `unrelate`, `checkRelate` |
| `definePreHook` | pre | Observes: `run(ctx)` returns fields merged into the snapshot, and `provides` lists the paths it fills |
| `definePostHook` | post | Acts: `handles` lists the effect types it claims, and each has `satisfied(snapshot, effect)` — pure, called often — beside `apply(effect, ctx)` |
| `defineArtifactHook` | artifact | Something outside the tracker that a workflow both writes and reads back, such as the spec page: a post hook plus `read(ctx)`, whose answer lands at `artifacts.<id>`, and optionally `brief()` |
| `definePreflight` | preflight | `check(ctx)`, run once by `start` and `mcp` before anything else; a throw refuses to start |
| `defineExecutor` | executor | A coding agent — see [Executors](#executors) |
| `defineNotifier` | notifier | Somewhere to tell a person an item needs them — see [Notifiers](#notifiers) |

**Effects.** Every effect type needs a `satisfied()` beside its `apply()`, in the same hook: the engine re-plans a stage's effects on every pass and drops the satisfied ones, so an effect without a real `satisfied()` would be applied on every tick. `apply()` throws `EffectRefused` (from `landrace/kit`) for what asking again cannot change — a merge the vendor will not make, a permission the token lacks, a body past the vendor's size limit — and anything else for a failure on the way. The engine records only the first as the stage's rejected round. It treats anything else as an outage: when a step's answer is what failed, the step runs again, and is paid for again, on every tick; see [A way on the forge refused](workflows.md#a-way-on-the-forge-refused) for an effect entering a stage and [An answer refused](workflows.md#an-answer-refused) for a step's answer.

**Briefings.** A source's or an artifact hook's `brief(ctx, keys)` answers the `{brief.<id>.<key>}` a prompt names, reading only the `keys` asked for. Its text is escaped and cut at 32 KB per hook. It is never merged into the snapshot, so nothing routes on it. The keys `compose` provides are listed in [Workflows](workflows.md#briefings).

## Pre hooks and path coverage

A pre hook declares the snapshot paths it fills (`provides`), and a source declares its relationship types. `validate`'s `path-coverage` rule is answered from both, together with what the engine always provides — `now`, `hash`, `run.*`, `node`, `graph`, and `rel.<type>.in|out.*` for every declared type (only `out` for an outward-only one) — so a condition can only read what something provides. The rule needs every declaration: if any pre hook leaves `provides` out, or the hooks load no pre hook and no source, `path-coverage` checks nothing in that workflow.

Every pre hook runs for every item on every pass, and one that throws fails that item's read. So a pre hook reads only what every project using it has. A read for a feature that a vendor can turn off, such as Jira's worklogs when time tracking is off, goes in the `apply()` of the one effect that needs it.

The composed GitHub pre hook provides `item` (`item.body`, `item.comments`), `entries` and `tracker.bot` from the tracker, and `git` (`git.local`, `git.remote`, the branch heads) from the forge; the in-memory tracker in `landrace/testing` provides the portable subset (no `tracker.bot`). An item's identity, labels and assignees are not among them: they live on the `node` the source reads, not on something a pre hook fetches a second time.

A source fills every field an `eligible` rule may read — `labels`, and `assignees` as a list, empty rather than absent — because a rule reading a path an item does not carry abstains, and abstaining means eligible.

## Trackers, forges and docs: the kit's bases

`landrace/kit` holds what every integration of a role shares. A new tracker, forge or docs integration extends one of three bases and writes only its vendor's calls, answered in plain neutral shapes — `ItemRecord`, `PullRecord`, `ReviewThread`, `ChangedFile` — that it maps its API's answers into:

- **`BaseTracker`** — list and read items and their children, read and post comments (`comment` is handed the effect's `visibility`, `internal` or `public`, when it names one; a tracker that cannot tell the two apart ignores it), add and remove labels, close, create and update an item, and add and remove a relationship of a type it lists in `writableRelations()`. To take [`tracker.create`](workflows.md#effects), a tracker also opts in. `createsIn()` names the other projects it files in; the default is none, and `validate` refuses a workflow that files anywhere else. `createIn(request)` files the issue: linked to `request.item`, carrying `request.marker`, unlabelled, with `request.fields` — field id to text, from a route's `fieldsFrom`, absent when there is none — in the same request. It answers the new key. `createdBy(request)` answers the key of the issue already filed with that marker, or null. The base checks the project, escapes the title, body and each field, asks `createdBy` before `createIn`, and records the key on the item.
- **`BaseForge`** — list pull requests and those naming an item, read threads, changed files and posted reviews, open and close a pull request, post a review, reply and resolve, read a pull request's checks and the ones that failed, merge it at a head, read branch heads and push. It declares `commentChars`, its vendor's bound on one comment (GitHub's 65,536, GitLab's 1,000,000), which the base cuts every review, finding and reply under. Its constructor takes the [forge options](integrations.md#forge-options) `reviewers` and `pull`. For those, it writes two optional methods: `finishedReviewers`, which named reviewers have finished on a head, and `root`, the project's root that `pull.description` is a path from. A forge without one has the option that needs it refused at start.
- **`BaseDocs`** — read, publish and link an item's page, and list which items have one.

The base holds everything else: the graph and its bounds, the pre hook's fragment, an `effects()` table with each effect's `satisfied()` beside its `apply()`, a `briefs()` table, the history's entries, and the operator's writes. To change one piece, subclass and override it — an effect by spreading `super.effects()` and replacing or adding an entry.

### compose

`compose` makes a project's roles into its hooks:

```ts
import { compose } from "landrace/kit";
export const { preflight, source, operator, pre, post, spec } = compose({
  tracker: new MyTracker(), forge: new MyForge(), docs: new MyDocs(), // your classes on the three bases
});
```

That is one preflight, one source, one operator, one pre and one post hook under the id `project`, and the docs role's artifact `spec`. The post hook's `creates` is the tracker's `createsIn()`. A prompt then names `{brief.project.body}`, `{brief.project.threads}`, `{brief.project.diff}`, `{brief.project.ci}`, `{brief.project.history}` and `{brief.spec.content}`, and `history` is one timeline of the tracker's comments and the forge's review threads. The forge and docs roles are optional.

- **Clashes halt.** An effect type, a briefing key or a snapshot path two roles claim stops `compose`, naming both; a node id two roles report stops `list` or `read`.
- **`nodes.close`** is the one effect two roles share: its ids are split by their kind in the snapshot's graph — items to the tracker, pull requests to the forge — and a kind no role closes halts.
- **Preflight.** Each role's own `check` runs in the preflight, and its failure names the role. The forge's base options are checked first, by `checkOptions`.
- **Pull requests.** A forge's pull request implements an item by its `landrace/{item}` branch in the same repository, and by nothing its own text says. `PullRecord.items` is for an integration that ties a pull request to an item some other way; the shipped forges leave it empty, and one tied to two items halts a read.

`createExternalState` in `landrace/testing` is `compose` over `MemoryTracker`, `MemoryForge` and `MemoryDocs`, built exactly this way — see [Development](development.md#testing-a-workflow-of-your-own).

### Relationships

A tracker reports an item's relationships on `ItemRecord.related`, each a `RelatedRecord` — `{ type, to, title, link, closed }`, the related item as the same answer gave it.

- **Unreadable.** `unreadable: true` marks one where the tracker said which item it is but not what state it is in: its `closed` is `null`, never a guess. `relatedComplete: false` says the tracker's list stopped short or held one it could not read. Either makes the item's relationships read as not all read.
- **Ids.** An id the integration chooses for an item elsewhere must be a usable item id, never all digits and never another role's node-id form (`pr-<n>`, `spec-<id>`), which would halt the listing as two roles reporting one id.
- **Declared types.** `BaseTracker` declares `child-of`, and beside it each type its `readRelations()` names — none by default, so a tracker that reads no relationship declares none, and a workflow gated on one fails `validate` rather than reading "no blocker". Each is not singular and outward-only: a read draws the item's own relationships, never another's toward it.
- **Placeholders.** A related item the graph does not otherwise hold — closed long ago, in another repository, or outside a read's neighbourhood — is a placeholder node built from the relationship: kind `item`, its title, link and state, no labels, and `placeholder: true`. A placeholder is never an item: no workflow claims it, no row shows it, two sources reporting one are no clash, and `compose` never asks the forge or the docs about one. It still counts in `rel` and is named on the board's panel.
- **Facts.** On the item's own node the base reports two facts, only when true: `node.state.relatedUnreadable` and `node.state.dependencyCycle`. They are read from `node.state`, never through `rel`.
- **Cycles.** One function judges a cycle for `list` and `read` alike, walking the item's open blockers over one answer of the tracker's open items and their open relationships — `OpenRelations`, which `list` derives from its own listing and `read` asks `openRelations()` for only when the item has an open blocker of the tracker's own. `openRelations()` is `items()` unless the integration has a cheaper way; GitHub's asks for the open issues' blockers alone. The walk goes through the tracker's own items only, those `ownsId()` claims (every id, by default), and is refused past the nodes one read may carry. An answer that cannot be had refuses the read, never reads as no cycle; an open item the answer marks `partial` makes every item whose walk passes it `relatedUnreadable`.
- **Writing.** The operator's `relate` and `unrelate` write through `addRelation` and `removeRelation`, for the types `writableRelations()` lists — none unless it says. `relationProblem()` answers, for every entry before any write, why one would be refused: by default a relationship runs only between the tracker's own items, the other end one it can read, and an integration adds what its tracker refuses (GitHub's refuses a pull request). `checkRelate` exposes it. `createItem` with `relate` asks it of every target before anything is written, and makes the relationships once the item exists and before it is labelled; one that still fails closes the new item as dropped, and is reported naming it.

### The kit's functions

The functions the bases are made of stay exported, over the same plain shapes, for an integration not built on one:

| From `landrace/kit` | What it is |
|---|---|
| Tracker | `commentsOf`, `wroteIt` and `botLoginOf` — our comments told from a stranger's; `labelSatisfied`, `statusSatisfied`, `commentSatisfied`, `closeSatisfied`, `nodesCloseSatisfied`, one per tracker effect, `closeHow`, the `done` or `dropped` a `tracker.close` asks for, and `visibilityOf`, the `internal` or `public` a `tracker.comment` asks for; `itemNode`, `priorityFromLabels`, `createdAtOf`, `updatedAtOf`, `stillOpen`; `bodyBrief`, the item's own text for a prompt; the paging bounds |
| Forge | `answered` and `threadCounts` — whose turn a `ReviewThread` is, and, by its opening comment, whether it is the reviewer's wording finding; `checkCounts`, a `CheckState` as the `ciPending` and `ciFailed` a workflow counts; `placeFindings`, a review's findings on a diff of `ChangedFile`s, cut under the forge's bound; `pullNode`, `prBranch`, `itemsNamedBy`; `globMatches`, the matcher `pull.merge`'s `refuse` is judged with; the `threadsBrief`, `diffBrief` and `ciBrief` briefings, `fenced` for a log or patch no fence inside can close, and `historyBrief` over `commentLine` and `threadLine` entries; `pushSatisfied` |
| Docs | `SPEC`, `PUBLISH`, `hashOf`, `contentOf`, `mine`, `briefPage`, `publishSatisfied`, `specNode` |
| Git | `gitIn`, `repositoryOf`, `ownGit`, `branchHeads`, `headsOf`, `headIn`; `originPushUrl` and `pushBranch`, fast-forward only with hooks off, the credential the hook's own; `fetchBranch`, one branch from that same URL into its remote-tracking ref; `nothingCommitted`, the refusal for a branch nothing was committed to |
| Refusals | `EffectRefused` and `isEffectRefused` — what an integration throws for an effect it refuses on purpose, and how the engine reads the mark |

**What stays the integration's.** The client, the queries and their paging, the vendor's shapes and the mapping from them, which push URLs it trusts with a token and the scrubbing of it from what git says, and every event and word in its own name (GitHub's `github.issue.skipped`, `github.pages.unknown`). The kit's functions never log; a base logs only in its role's name (`forge.review.*`, `docs.skipped`). An integration under `integrations/` imports only `landrace/kit`, `landrace/hooks`, `node:*` and its own files — exactly what a third party could write.

## Executors

The engine runs no coding agent of its own: `agent.adapter` names an **executor** hook. `defineExecutor` registers one, either as `{ id, run }` directly or as `{ id, create(ctx) }` — a factory the runtime calls once at startup. Its `ctx` is the `RuntimeContext` every hook gets, plus:

- `dir` — the workspace, for finding the repository;
- `redact` — to register secrets a run's own setup discovers, such as an MCP server's `env`, that the configuration never named;
- `steps` — the workflow's steps, by path, so a factory can refuse what a step asks of it before the step runs.

A factory that cannot start — a bad `agent.*` key, a server `.mcp.json` does not define, a step's effort it has no level for — throws, and `landrace validate` reports it under the `executor` rule, one problem per line.

**The engine hands every run** the rendered prompt; the folder to run in; the step's capabilities; its model and effort; a time limit; the session to resume; and, for an `items:create` step, the engine's own item server, ready to start. At the limit the engine aborts the run's signal but keeps waiting for the run, so an executor that honours neither holds its item until the process dies. It gets back the agent's text and a session id.

Beyond `agent.adapter` and `agent.isolation`, the `agent:` block is passed to the executor unread. A hook reads it only when `agent.adapter` names it: an executor that only `security.adapter` names is there to screen, and gets the screener's model from `security.model` on each run.

### The executor's contract

An executor must, or else refuse the run:

- enforce every declared capability;
- give a run that declares none no tools at all — that is the screener's run;
- never hand a step or a turn the operator's own `landrace` MCP server;
- run in the folder it is given, because the engine's read-only check inspects that folder;
- never pass the engine's own process environment to the agent, because a secret can come from the shell and the agent must not hold tracker credentials;
- honour a named model and effort;
- stop at the limit and on abort.

The engine checks a read-only step's worktree afterwards whatever the executor claims — a backstop, not a licence to skip the rest.

### BaseExecutor

Every rule above but the vendor's words is the same for every agent, so it is written once: `BaseExecutor`, from `landrace/kit`. It is a factory that brands itself, so an integration built on it is an executor hook as it stands:

```ts
// .landrace/hooks/claude.ts
import { Claude } from "landrace/integrations/claude";
export const claude = new Claude();
```

The kit starts the agent with no shell, and with only a few basic variables of Landrace's environment — `PATH`, `HOME`, the locale, the temporary folders, `USER`, `LOGNAME`, `SHELL` — plus the integration's own `envKeys`; checks every value before it reaches argv, and the folder it runs in; refuses a capability it cannot enforce; resolves `agent.mcp` from `.mcp.json`; reads and shape-checks `agent.sandbox`; kills the whole process group at the limit or on abort; re-checks the abort after the integration's own preparation and before it spawns; narrows `agent.mcp` to a step's own `mcp`, refusing a server or tool outside it; and refuses at startup an `agent.*` key nobody reads, a step's effort the agent has no level for, and a step's `skills` or `plugins` the integration does not declare in `stepKeys`. An integration says only what is its agent's:

| Method | What it says |
|---|---|
| `argv(plan)` | The command line for a run the kit has decided and checked: its tier (`screen`, `read` or `write`), model, effort, session, servers and the tools allowed on each, and the step's own `skills` and `plugins` when it lists them |
| `readEvent(event, cwd)` | What one line of the agent's JSON output means: a message or a tool call for the board's panel, the session id, the answer, the end, or a failure |
| `handoffArgv(plan)` | The command a person runs to pair |
| `prepare(plan)` | Optional. Whatever must be in place before the agent starts — Claude brings a resumed session into the folder it runs in. `plan.log`, when set, is where it says what it changed on the way |
| `readExtras(agent)` | Optional. The integration's own `agent:` keys — Claude's `plugins` |
| `sandboxProblems(sandbox)` | Optional. The `agent.sandbox` settings its agent cannot keep, refused at startup |
| `skillProblems(root, listed)` | Optional. The skills a step lists that the repository does not define, refused at startup — Claude's are the folders of `.claude/skills` holding a `SKILL.md` |
| `mcpFile(root)` | Where `agent.mcp`'s servers are defined; `.mcp.json` unless overridden |

It also declares `efforts` (the levels it takes), `pairings` (`take` a fresh session, `continue` the agent's, `fork` for a pairing's finish), `envKeys` (variables the agent needs, never a credential) and `stepKeys` (which of a step's `skills` and `plugins` it enforces; none unless it says so). To change one piece, subclass and override that method.

## Notifiers

A notifier is `{ id, send(event, ctx) }`, registered with `defineNotifier` and named in `notify.via`. `event` is:

```ts
interface NotifyEvent {
  event: "needs-you";
  item: string;
  workflow: string;       // the item's workflow, by its folder under workflows/
  workflowName: string;   // and by its name
  title: string;
  link: string;
  stage: string | null;
  why: string;            // the board's note for the item
  board: string | null;   // the board's URL when one is running
}
```

Sending is fire and forget: a send that throws is logged as `notify.failed` and nothing else, so a notifier can never stop an item. When a notifier is called is in [Configuration](configuration.md#notify).
