# What `landrace validate` checks

`landrace validate` proves a workspace sound before anything runs: every workflow in it, the configuration they share, and the hooks they load. It reads and imports, and writes nothing.

```bash
landrace validate              # the workspace in .landrace/
landrace validate path/to/ws   # another workspace
```

It prints `<dir>: valid`, or one line per problem — `  <rule>: <message>` — and a count, and exits 1. With several workflows, a problem in one is prefixed with its id; a problem every workflow shares (the configuration, an executor, a notifier) is said once.

In a worktree with no secrets, such as CI, the `githubToken` secret not resolving and `.mcp.json` missing are expected reports.

## The order it checks in

1. **The configuration** (`landrace.yaml` and `.env`). It is optional, so a workflow can be checked where no credentials exist. A var that does not resolve stops here: loading the workflows without it would report every `{vars.x}` a second time as a name nothing declares.
2. **The workspace layout and each workflow's files.** A workflow that will not load is reported under its folder, and the others are still checked.
3. **Each workflow's graph and steps**, from the files alone.
4. **Each workflow's hooks.** Only a workflow whose graph is already sound gets this far: importing a hook module runs its code, and the engine has already decided not to run an unsound workflow.
5. **The executors and notifiers** the configuration names, built exactly as `landrace start` builds them.
6. **Claims between workflows.**
7. **`.env` exposure**, on every path out, including the ones that gave up early.

## The rules

### Loading

| Rule | Catches |
|---|---|
| `config` | A `landrace.yaml` that exists but cannot be read or does not match the schema |
| `secret` | A secret whose `$VAR` does not resolve; a `.env` that exists and git does not ignore |
| `vars` | A var that does not resolve or resolves to an empty value; a `{vars.x}` nothing defines; a declared var nothing references; a var holding a secret's value |
| `layout` | A workspace that is not one: the old single `workflow.yaml` at its root, no workflows, a workflow id that is not usable (lowercase letters, digits and `-`, starting with a letter or digit), a `workflows` folder or a workflow folder that is a symbolic link, a `workflows:` list in `landrace.yaml` that does not name exactly the folders |
| `schema` | A `workflow.yaml` or step front matter that does not match its strict schema — an unknown key included; an `extends` that is empty; a step file with one `## ` heading twice |
| `duplicate-id` | Two stages with one id |
| `missing-step`, `step-path` | A step file, or an `extends` target, that does not exist or resolves outside `.landrace/`; an `extends` loop |
| `branch` | A stage `branch` git would refuse as a name, one using anything but `{item}`, `{stage}` and `{round}`, or one on a stage that runs no step |
| `hooks` | A hook module that will not import. `path-coverage` then abstains, rather than report every path as uncovered |

### The graph

| Rule | Catches |
|---|---|
| `entry` | No entry stage, unless every open stage is placed by the item's own state; with several entry stages, one with no trigger anchored on `"run.stage": null`, or one with a trigger anchored on neither `null` nor a stage, which could fire mid-workflow |
| `stage-id` | A stage id that is a reserved object key (`__proto__`, `constructor`, …) |
| `reachability`, `unknown-stage` | A stage nothing leads to; a trigger naming a stage that does not exist |
| `dead-end`, `self-loop` | A non-terminal stage with no way out; a stage triggering on itself |
| `cycle-bound` | A loop with no counter bound — an agent that could run forever. An edge whose trigger waits for a person's own message (`run.lastEvent.actor: human`, exactly) bounds it too: every lap needs someone to write |
| `identity` | An item two stages' identities both place, shown to the engine's own compiler |
| `waits` | `waits: person` on a stage that runs a step, or on a terminal stage |
| `operator` | A condition operator outside the allowlist, anywhere — nested, or in a step's route |
| `trigger-name` | A trigger named `goto`, the name a goto transition is logged under |
| `goto` | A `goto` target that is not a stage, is named twice, or records no `enter` naming `{round}` — its entry record is what consumes a goto; a `retry` other than `only`; a step's route sending items somewhere its stage does not list |
| `note` | A stage `note` field that is neither `{node.id}` nor `{rel.<type>.<in|out>.<count or open>}`, or that reads a relationship type no hook provides |
| `item-fact` | A condition or note reading `relatedUnreadable` or `dependencyCycle` through `rel.*.(is|not)`. They are an item's own facts: read `node.state.<fact>` |

### Steps and their outputs

| Rule | Catches |
|---|---|
| `capability` | A step declaring a capability nothing enforces; the engine enforces `repo:read`, `repo:write` and `items:create` |
| `step-output-required` | A stage that runs a step with no declared output, or whose every route sends the output away from this stage's own record — either way it could never be left |
| `entry-record` | A stage that runs a step but records no `enter` naming `{round}` in its `on_enter`, so a second round would read as already complete and be skipped |
| `totality` | A declared output shape with no route |
| `shape-field` | A shape declaring a field that is a reserved object key, which can never be carried |
| `shape-edge` | An output shape no trigger leads away from, so an item that produces one stops there for good |
| `placeholder` | A placeholder retired when "ticket" became "item" — `{ticket…}` — in a prompt or an effect field |
| `children` | A step declaring `items:create` whose stage has no `nodes.close` or records no entry, so a re-run's children would not supersede the last round's; a `nodes.close` on a stage whose step cannot create items; a `nodes.close` with no `follow` list, or following a type no source declares |

### Effects

| Rule | Catches |
|---|---|
| `reserved-field` | A `goto`, `from` or `head` field in an `on_enter` effect or a route's effect — fields only the engine writes |
| `branch` | A stage `branch`, or the `branch` of a `branch.push` or `pull.*` effect, other than `landrace/{item}`; a stage `branch` with `agent.isolation` other than `worktree` |
| `merge-guard` | A `pull.merge` whose `refuse` is not a non-empty list of non-empty globs, or has a glob that could never match a changed file (a leading `/` or `./`, a trailing `/`, an empty, `.` or `..` segment); a `reviewedBy` naming no stage, or one with no step or no `branch` |
| `merge-placement` | A `pull.merge` anywhere but a stage's `on_enter`: a step's route effect, or a route's `goto` into a stage that merges as it is entered |
| `entry-first` | In a stage whose `on_enter` records its `enter`, an effect other than `tracker.status` or `tracker.label` planned before that record. A refusal is recorded as the stage's rejected round only when the record came first |
| `halt-labels` | A stage entered on a failed round (a trigger reading `run.lastOutputValid: false`) whose `on_enter` does not add `lr:blocked`, or one entered on a refusal (`run.lastRefused: true`) that does not add `lr:screened` beside it |

### Against the hooks and the runtime

| Rule | Catches |
|---|---|
| `path-coverage` | A condition — in a trigger, an `identity`, a `requires`, a `goto` entry or an `eligible` rule — reading a path no hook provides. What counts as provided is the engine's own (`run.*`, `node`, `graph`, and `rel.<type>.in|out.*` for every type a source declares) plus each pre hook's declared paths. Reading `rel.<type>.in` of an outward-only type is refused here too |
| `executor` | An executor that cannot start: an `agent.*` key it does not read, a step's `effort` it has no level for, an `agent.sandbox` it cannot keep, an `agent.mcp` server it cannot resolve. One problem per line |
| `mcp` | An `agent.mcp` server with no `.mcp.json` at the repository root, a name `.mcp.json` does not define, or Landrace's own operator server |
| `notify` | A `notify.via` id no loaded notifier answers to |
| `admit` | A label a workflow admits items with that one of its own `eligible` rules (labels only) turns away, so the item would be started and never worked; an admitted label the engine writes itself (`lr:working`, `lr:stage:…`) |
| `claims` | Two workflows over one source — the same loaded hook object — where the labels one admits satisfy the other's `eligible` rules, all label-only, so an item started in one would be claimed by both and halt |

## Where it abstains

A validator that flags healthy workflows gets switched off, and one that silently stops checking is worse than none. So where a rule cannot tell, it says nothing rather than guess:

- **`identity`** reports two stages only for an item it can construct that both place, confirmed by the engine's own compiler. Where it cannot construct one, it abstains — except beside a stage placed by its label alone, which an identity reading no `run.stage` overlaps unless it can never hold, so that pair is reported either way.
- **`claims`** abstains where an `eligible` rule reads anything but labels, where a workflow admits nothing, or where the two sources are not the same loaded object. It does report a workflow that claims every item — one with no `eligible` rule, or one reading what no listed item carries, such as `run.counters`.
- **`path-coverage`** abstains when a hook will not import, and for a workflow whose graph already failed.
- **`shape-edge`** counts a trigger it cannot read — an operator document such as `$in`, or a condition under `$or` — as claiming the shape, rather than report a healthy workflow.
- **`note`** and **`children`** abstain on relationship types when the hooks' declarations are unknown.

The graph rules work from two derived views. An earlier version abstained wherever a trigger could fire from anywhere, which turned out to mean always — the entry trigger every real workflow needs switched three rules off graph-wide. Now `dead-end` and `reachability` use a superset that treats an unanchored trigger as an edge from every stage, and `cycle-bound` uses the anchored edges alone.

`landrace start` runs the same checks before its first tick, through the same functions, and refuses an unsound workspace: the command and the loop cannot disagree about what is fatal.
