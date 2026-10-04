# Workflows

A **workflow** is the process an item goes through, written as one graph in a YAML file. This page describes that file — its stages, triggers, effects and step files — and then the two workflows this repository ships, `full-cycle` and `fastlane`.

Terms used throughout: an **item** is what a workflow works on (an issue, a ticket); a **stage** is a place an item can be; a **step** is the work an agent does at a stage; a **round** is one run of a stage; an **effect** is a write to the outside world. How the engine uses them is in [Architecture](architecture.md).

## Where a workflow lives

A workspace, `.landrace/`, holds one workflow or several, each in its own folder:

```text
.landrace/
  landrace.yaml          runtime settings — see configuration.md
  workflows/<id>/
    workflow.yaml        the graph
    steps/*.md           one file per step: front matter is the contract, the body is the prompt
  hooks/*.ts             integrations, shared by every workflow
```

A workflow's **id** is its folder name: lowercase letters, digits and `-`, starting with a letter or digit. Every path in `workflow.yaml` — a hook or a step — is relative to the workflow's own folder and must resolve inside `.landrace/`, symbolic links included; `../../hooks/github.ts` reaches the shared hooks folder. A path that climbs out of `.landrace/` is refused, and so is a workflow folder that is itself a symbolic link, because `workflow.yaml` is a repository file a pull request can edit.

One `landrace start` runs every workflow in the workspace — see [Several workflows in one workspace](#several-workflows-in-one-workspace).

## The file's header

Beside `stages`, the file says what the workflow is and what it admits:

| Key | Meaning |
|---|---|
| `version` | Required. Always `1` |
| `name` | Required. The display title |
| `description` | Required. What the workflow is for, in a sentence. An agent reads it when it chooses where to start an item |
| `admit` | The labels an item gets when it is started into this workflow — by `landrace_create_item`, or as a child an `items:create` step files. The engine names none of its own |
| `eligible` | Which items the workflow may work at all: a list of `{ when, else }` rules, each `else` the reason `landrace status` prints for an item the rule turned away. See [Eligibility and admission](#eligibility-and-admission) |
| `budget.stepTimeout` | How long one agent run may take, unless its step names its own `timeout`. Default `10m` |
| `hooks` | The integration modules, by path, in the order their pre hooks run |
| `stages` | Required. The graph |

The schema is strict: an unknown key fails to load rather than being ignored. Round caps are not a key: they are the `$lt` comparisons in triggers and in `goto` entries, where the validator can see them.

## Stages

A stage declares **what activates it**, so adding a stage never means editing the one before it.

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

| Key | Meaning |
|---|---|
| `id` | The stage's name, unique in the workflow |
| `step` | The step file an agent runs at this stage |
| `entry` | `true` for a stage a new item may start at |
| `terminal` | `true` for a stage where the item's work is done |
| `waits` | `person` for a stage where it is a person's turn: the item shows under Needs you |
| `triggers` | The ways into this stage: each a `when` condition and an optional `name`, the reason shown when it fires |
| `identity` | A condition on the item that *places* it at this stage — see [The located stage](#the-located-stage) |
| `requires` | A condition that must hold while the item is at this stage. An item at a stage whose `requires` fails halts, saying the precondition is not satisfied, and no goto is taken from it |
| `on_enter` | The effects of being at this stage — see [Effects](#effects) |
| `goto` | The stages a person may send an item back to from here — see [Sending an item back](#sending-an-item-back-goto-and-retry) |
| `branch` | The branch the step works on — see [The item's branch](#the-items-branch) |
| `note` | What the board says about an item resting here — see below |

**Entry stages.** A workflow may have one `entry: true` stage or several. With one, a new item enters it unconditionally. With several, a new item enters the one whose `"run.stage": null` trigger matches it; none, or more than one, halts. A workflow may have none when every open stage is placed by state — see [Read-only workflows](#read-only-workflows).

**Waiting on a person.** `waits: person` is what puts an item in Needs you: the board, the notifications, `landrace status`, and the MCP's `landrace_waiting` and `landrace_status` all read the `waits` of the stage the item is at. `validate` refuses it on a stage that runs a step — a person's turn runs no agent — and on a terminal stage.

**Notes.** A stage may say what an item resting there waits for. `note: "waiting on {rel.blocked-by.out.open}"` reads `waiting on #10, #11` on the board, in `landrace status` and in `landrace_status`, in place of `queued`. A note may use `{node.id}` and `{rel.<type>.<in|out>.<field>}`, where the field is `open` — rendered as `#10, #11` in id order, and as nothing when none is open — or a count (`total`, `dropped`, `not.closed`, …), which reads `0` over nothing related. `validate` refuses any other field, and a relationship type no hook declares. A note is display only. Any other note — working, waiting on you, a halt, an agent running — is shown over it, and the board's lane is decided from the note the engine would have shown, never from the text a workflow wrote.

## Conditions

Triggers, identities, `requires`, `eligible` rules, `goto` entries and step routes are all **conditions**: MongoDB-style documents over snapshot paths, all of whose keys must hold.

```yaml
when:
  "run.stage": code-review
  "rel.implements.in.sum.awaitingFix": { $gt: 0 }
  "run.counters.code-review": { $lt: 5 }
```

Conditions use a closed list of operators: `$eq $ne $in $nin $lt $lte $gt $gte $exists $all $size $and $or $not`. Anything else, `$where` and `$regex` included, is refused at load, because a workflow file is a repository file a pull request can edit.

A path the snapshot does not carry fails a plain value, `$in`, `$gt`, `$gte` and `$exists: true`, and passes `$lt`, `$lte`, `$ne`, `$nin` and `$not`. That is why "none open" is written `{ $not: { $gt: 0 } }` rather than `0` for a count that may be absent — and why `{ $lt: 1 }` on a count also matches an item that has nothing of that type related.

## What a condition can read

A condition reads the item's **snapshot**: the document the engine builds for it on every pass.

**`node`** — the item itself. `node.id`, `node.title`, `node.closed`, `node.priority`, `node.origin`, and `node.state`, which the source fills. An item read through the kit's tracker base carries:

- `node.state.labels` — its labels;
- `node.state.assignees` — a list of logins, empty (never absent) when nobody is assigned;
- `node.state.relatedUnreadable` — `true` when its relationships could not all be read; absent otherwise;
- `node.state.dependencyCycle` — `true` when it is on a cycle of `blocked-by`; absent otherwise.

An item's priority comes from a `P0`..`P9` label (`P0` most urgent), unless its tracker reports one. Two of them is a priority that cannot be told, and the item halts.

**`run`** — what the engine derived from the records on the item:

| Path | Meaning |
|---|---|
| `run.stage` | The stage the item is at, or `null` for an item nothing has been written to |
| `run.counters.<stage>` | How many rounds of that stage reached a verdict — an output or a rejection. Absent for a stage that never settled a round, which `$lt` reads as below any cap |
| `run.outputs.<stage>` | The latest valid output of that stage's step, e.g. `run.outputs.triage.intent` |
| `run.lastOutputValid` | `false` when the current stage's latest round failed; `null` otherwise. Never `true` |
| `run.lastRefused` | `true` when that failure was a security refusal, `false` when it was a broken output, `null` when nothing failed |
| `run.lastOutputBy` | Who produced the latest output: `agent`, or `pair` for one a person handed in from a pairing |
| `run.lastEvent.actor` | `human` or `agent` — who wrote last on the item |
| `run.lastHuman` | A person's latest message, or `null` |
| `run.previousStage` | The stage the item left to enter the current one, read off the current stage's entry record |
| `run.failedStage` | The step whose failure put the item where it is, or `null` |
| `run.heads.<stage>` | The commit that stage's latest valid round started at — see [The merge's three guards](#the-merges-three-guards) |
| `run.cleared` | The round a person cleared of the security check, if any |

**`rel`** — counts over the item's relationships, by type and direction: `rel.<type>.in.total`, `.dropped`, `.is.<field>`, `.not.<field>`, `.sum.<field>`, `.stage.<id>` and `.open`. They are defined in [Architecture](architecture.md#the-snapshots-views). The relationship types the kit's bases report:

| Type | From → to | Meaning |
|---|---|---|
| `child-of` | sub-item → parent | A sub-issue of its parent. Singular |
| `implements` | pull request → item | The item's pull request: one from the item's own `landrace/{item}` branch — see [Which pull requests are an item's](#which-pull-requests-are-an-items). Singular |
| `documents` | page → item | The item's published spec page. Singular |
| `blocked-by` | item → blocker | The item waits on the blocker. Many per item, outward-only: `rel.blocked-by.in` is refused. Reported by trackers that read it — GitHub, Jira and the in-memory tracker |

A pull request is a node like any other, `kind: "pull-request"`, and its `state` carries:

| Field | Meaning |
|---|---|
| `merged` | `true` once merged |
| `branch` | The branch it is from |
| `headSha` | Its head commit |
| `openThreads` | Unresolved review threads |
| `awaitingFix` | Unresolved threads whose last comment is not the fixer's answer — see [Review threads are a conversation](#review-threads-are-a-conversation) |
| `awaitingBehaviourFix` | Of those, every one but the reviewer's own findings flagged `wording`. A forge that does not report it leaves the path absent, and fastlane reads that as behaviour |
| `checks` | The checks on its head: `pending`, `success`, `failure`, or `none` when nothing is configured or nothing has started yet |
| `ciPending`, `ciFailed` | `1` or `0` each, so a workflow can count: `rel.implements.in.sum.ciPending` is how many of the item's pull requests still wait on CI, `sum.ciFailed` how many are red. `none` counts as neither |
| `reviewPending` | `1` while an external reviewer the forge names in `reviewers` has not finished on its head, `0` otherwise and always `0` with none named — see [Forge options](integrations.md#reviewers) |

Only an open pull request's threads and checks are read. A merged or closed one reports `openThreads: 0`, `awaitingFix: 0`, `awaitingBehaviourFix: 0`, `checks: "none"` with both counts `0`, and `reviewPending: 0`, so a sum stays defined once every pull request is done. A workflow waits for CI with `rel.implements.in.sum.ciPending: 0` and reads a red build as `rel.implements.in.sum.ciFailed: { $gt: 0 }`. It waits for an external reviewer with `rel.implements.in.sum.reviewPending: 0`.

Anything else a condition reads must be provided by a hook: `validate`'s `path-coverage` rule refuses a path nothing provides. What the GitHub pre hook adds is in [Writing an integration](hooks.md#pre-hooks-and-path-coverage).

## The located stage

An item's stage is found from the listed item alone: the stage its `lr:stage:<id>` label names, and every stage whose `identity` the item's own fields satisfy.

- A stage with no `identity` of its own is placed by its label (`"run.stage": <id>`).
- A label and an identity naming different stages is a contradiction: the item halts, and a goto or a pairing is refused for it.
- A stage placed only by its identity, with no label, still gets its run history — a pending goto, failed rounds, the last refusal — as that stage's, and goto, Clear & retry and pairing work from it. The exception is a stage whose identity requires `"run.stage": null`, an item nothing has been written to: moving an item from there would write, so those are refused there.

## Read-only workflows

A stage is **placed by state** when its `identity` reads only the item's own fields — `node.*`, optionally with `"run.stage": null` — and not a counter or an output a step wrote. Relationships (`rel.*`) do not count: Needs you, the notifications and the MCP place an item from the listed item alone, which carries none, so a stage placed by `rel.*` needs an entry stage beside it.

A stage placed by state needs no trigger to be reachable: an item is there because its fields say so, and leaves when they stop saying so. A workflow whose every open (non-terminal) stage is placed this way needs no entry stage.

If, besides, none of its stages runs a step, has a trigger, has an `on_enter` or is an entry stage, the workflow **writes nothing** — no transitions, no entry records, no step outputs — so it can run over a tracker it may only read. In such a workflow, an item no identity places halts, saying so, under Needs you, and nothing is written. Its items' panels on the board offer no writes.

[`tests/fixtures/review`](../tests/fixtures/review/workflow.yaml) is the shape of a "merge requests waiting for my review" workflow: `eligible` admits items labelled `review-requested`, `reviewing` (`waits: person`) places those not yet `approved`, and the terminal `approved` places the rest. An item comes into Needs you and leaves it by its own labels alone.

## When a round fails

A step whose round fails is never retried on its own: the item halts. A round fails in one of two ways, and the shipped workflows give each its own halt stage:

- **A broken contract.** The output has no JSON block, matches no declared shape, or is too long to record, or the tracker or forge refused to record it ([An answer refused](#an-answer-refused)). The round is recorded as `malformed`, and the item goes to `blocked` (label `lr:blocked`).
- **A security refusal.** The prompt screener said no or could not run, or the agent changed its worktree or created an item without declaring it could. The round is recorded as `refused`, headed "Step refused by a security check" with the reason, and the item goes to `screened`, which wears `lr:screened` beside `lr:blocked`. See [Security](security.md#screening-prompts).

`run.lastRefused` tells the two apart: `false` for a broken contract, `true` for a refusal, `null` when the current stage has not failed. So exactly one of the two halts' triggers takes any failure. Every other trigger leaving a stage that runs a step reads `"run.lastOutputValid": null`, so a failed round is only ever the halts' to route. `validate`'s `halt-labels` rule holds a stage entered on a failure to add `lr:blocked`, and one entered on a refusal to add `lr:screened` too: the board's Retry and Clear, Needs you's note and the MCP know a halt only by them.

### A way on the forge refused

An effect can fail as an item enters a stage, and how it failed decides what happens.

An integration marks what it refuses on purpose with `EffectRefused`: a merge the forge will not make (conflicts, branch protection), the kit's merge guards (checks failed or unread, no open pull request), a pull request from a branch nothing was committed to, a permission the token lacks. Asking again changes none of these until a person acts. When the stage records its `enter` record before the refused effect — `validate`'s `entry-first` rule holds every stage that records one to that order — the engine records that stage's round as rejected: `malformed`, headed "Could not enter <stage>", with the refusal's sentence. It reads it where the item still stands, so `run.lastOutputValid` is `false` there and the item goes to `blocked`, under Needs you. Nothing asks the forge again on its own; the halt's Retry enters the stage once more, at a new round.

What the forge is still settling is not a refusal, since asking again is what clears it: checks still running; GitHub's 405 while it works out whether a pull request can merge, or "Base branch was modified"; GitLab's merge status while it is `checking`, `unchecked`, `ci_still_running`, `preparing` or `approvals_syncing`.

Anything else that fails — a network error, a 5xx, a rate limit, a token the forge no longer accepts — leaves the item as it was: it halts for this tick only, and the next tick tries again. So does a refusal on an item with no position yet, or from a stage with no `enter` record before the refused effect.

Every visit to a stage is a round of its own, with its own `enter` record. A stage with no step settles a round only when it is refused, so its rounds are not its counter; a refused round counts toward its stage's rounds like any other. Every trigger leaving a stage with no step therefore reads `"run.lastOutputValid": null` too, unless it waits on a person's own message.

### An answer refused

A step's answer is written by effects too: a comment, a review, a description. When an integration refuses one with `EffectRefused` — a review the forge will not let the reviewer post, a body past the vendor's size limit — the engine records the round as `malformed`, headed "Could not record <stage>'s answer", with the refusal's sentence. So `run.lastOutputValid` is `false`, `run.lastRefused` stays `false`, and the item goes to `blocked`, as for any broken contract. The paid step is never run again on its own; the halt's Retry runs it once more, at a new round.

Anything else that fails while writing the answer is an outage: nothing is recorded, the round reads as owed, and the step runs again, and is paid for again, on the next tick. An integration that throws a plain error for what asking again cannot change makes that loop, which is why [hooks](hooks.md) throw `EffectRefused` for it.

## Sending an item back: goto and Retry

A stage lists, under `goto`, the stages a person may send an item back to from there, each with an optional `when` cap:

```yaml
  - id: spec-questions
    goto:
      - { stage: spec, when: { "run.counters.spec": { $lt: 3 } } }
      - { stage: build, when: { "run.counters.build": { $lt: 3 } } }
```

A person sends an item back with the board's "Go to step…", with `landrace_goto`, or — in the shipped workflows — with a reply the judge reads as `goto-spec` or `goto-build`. A step's route may also name a `goto`, a stage its stage lists. Whichever way it is asked, Landrace writes a **goto record**, and the engine takes it before any trigger. A goto is consumed by the entry record its target writes on arrival, so a target must record its entry; `validate` checks that.

- A target the stage does not list halts the item.
- One whose `when` does not hold is declined, and the item comes home.
- The command refuses up front, with the reason, reading the item afresh: not found or closed, skipped by `eligible` (with the rule's `else`), unplaceable or ambiguous, a `requires` that fails, a step still owed, an unlisted target, or one past its cap.
- It reads and writes under the item's lock, so no tick moves the item meanwhile. While a tick holds the lock for more than a moment, the command refuses, saying the item is busy.
- A stepped stage whose round is already settled still accepts a goto. That is also how a person recovers an item a crash stranded between a target's entry comment and its status label.

**Retry** — the board's button on a halted item — names no target: it is a goto to the step whose failure put the item where it is, read off `run.failedStage`, and it refuses if there is none. That is the stage the item last entered before this one, and only while it is still failed: a spec that failed before a person sent the item on to build is not what halted it after the reviews ran out.

`retry: only` on a goto entry declares a target Retry's alone: it is taken only while it is what failed, and the board never offers it under "Go to step…". `only` is its one value.

```yaml
      - { stage: publish, retry: only, when: { "run.counters.publish": { $lt: 3 } } }
```

## The item's branch

A stage that runs a step may name the branch its step works on. That branch is always the item's own, `landrace/{item}`: a forge ties a pull request to an item only by that head, so a pull request from any other branch would be nobody's. `validate` refuses any other, here and on every `branch.push` and `pull.*` effect.

```yaml
  - id: build
    step: steps/build.md
    branch: "landrace/{item}"
```

The step's worktree is checked out on that branch: the branch itself for a step that may write (`repo:write`), so what it commits outlives the worktree; and the branch's commit, detached, for a read-only step, so a reviewer reads the item's code and cannot commit onto it.

- The branch is created, the first time, at whatever your own checkout's `HEAD` is right then — not at `origin`'s default branch. Local commits you have not pushed, and whichever branch you have checked out, end up in the item's pull request.
- Before a step on a branch runs, the forge fetches origin's copy of that one branch. Where it has moved on — a person's push, the forge's "Update branch" — and holds everything the local branch has, the local branch is moved forward to it. Never backwards, never across a fork, and never a branch another checkout has out. A fetch that fails is an outage: logged, nothing recorded, and the step waits for the next tick.
- A stage with no `branch` gets a detached `HEAD`, and nothing its step commits is kept.
- A branch needs `agent.isolation: worktree`.
- A template git would refuse is refused at load. An item id that makes an invalid name (`a..b`) halts that item before its step runs. A branch already checked out elsewhere — your own checkout, say — halts the item, saying where, and is never taken.
- A write step's worktree is kept for the item's next write step on the same branch, and removed when the item reaches a terminal stage. Between runs it is detached, so the branch is free for your own checkout while the item waits. On reuse it is reset to the branch's commit, so of what a step did only its commits and what git ignores, such as `node_modules`, carry over. Every other worktree is rebuilt whenever the next step needs it on something else. See [Configuration](configuration.md#a-write-steps-worktree).

## Effects

A stage's `on_enter` lists the effects of being in it, and a step's routes name the effect each output goes to. Each effect has a `type`, and a hook claims each type. On every pass the engine plans the effects of the current stage and drops each one already satisfied — see [Architecture](architecture.md#effects-and-satisfied).

Effect fields may use `{item}`, `{stage}` and `{round}`, and nothing from the snapshot: an effect is structure, and a field assembled from an item's text would let whoever wrote it forge a marker.

| Effect | Fields | Applies | Satisfied when |
|---|---|---|---|
| `tracker.comment` | `kind`, `marker` (required), `body`, `visibility` | Posts a record on the item. `kind: enter` with `marker: "enter:{stage}:{round}"` is a stage's **entry record**, from which rounds are counted. `visibility` is `internal` (the default) or `public`, and only a tracker that tells the two apart reads it: on a Jira service desk, `public` answers the requester ([Jira](integrations.md#jira)) | a comment Landrace wrote already carries exactly that marker |
| `tracker.status` | `value` | Sets the item's position — on a tracker with no status field, the label `lr:stage:<value>`. `value` is the stage's own id | the item already carries `lr:stage:<value>` |
| `tracker.label` | `add`, `remove`; on a route, `addFrom` and `allowed` | Adds and removes labels. `addFrom` takes the labels from the answer — see [Fields from the answer](#fields-from-the-answer) | the labels already match |
| `tracker.worklog` | `spentFrom`, `max`, `marker` (all required), `skipIfLogged` | Route only, Jira only. Logs the time the answer's `spentFrom` field names against the item. With `skipIfLogged: true`, logs nothing on an item that has any worklog, a person's included | a worklog Landrace wrote carries that marker; with `skipIfLogged`, any worklog is on the item |
| `tracker.close` | `how`: `done` (default) or `dropped` | Closes the item | the item is closed, either way — a person who closed it as not planned decided that |
| `nodes.close` | `follow`: relationship types | Closes the nodes a superseded round of this stage created, following those types — see [Splitting work into sub-items](#splitting-work-into-sub-items) | none of them is open |
| `artifact.publish` | `artifact` | Publishes a step's output as an artifact, such as the spec page | the published copy already matches |
| `branch.push` | `branch` | Pushes the branch to `origin`, fast-forward only — never forced | the checkout's branch head equals `origin`'s as last fetched or pushed, or the checkout has no such branch |
| `pull.open` | `branch` | Opens a pull request from the branch into the default branch. It opens a fresh one beside one a person closed unmerged: whether that close is their stop is the workflow's to say, routed on `rel.implements.in.dropped` | the item already has an open or merged pull request from that branch |
| `pull.review` | `branch`, `marker` | Posts a review step's answer on the open pull request: its replies on the threads they name, its prose as one review, a thread per finding, and the reviewer's own threads it lists as resolved — never a person's | checked against the review's own marker on the forge, and each reply against the last comment on its thread |
| `pull.merge` | `branch`, `reviewedBy`, `refuse` | Merges the one open pull request from the branch, by the forge's own method, at the head the item was read at, held to [three guards](#the-merges-three-guards) | no pull request from the branch is open, and one is merged |
| `pull.close` | `branch` | Closes every open pull request from the branch without merging it — what a workflow that drops an item does to the work it proposed. It asks the forge again first, so one merged since the read is never touched | no pull request from the branch is open |

An effect no hook handles fails when it is applied, and two hooks claiming one type is an ambiguity that halts. An `on_enter` effect is applied as its stage is entered, and a route effect once, right after its step; neither is planned again while the item stays where it is. No effect may carry a `goto`, `from` or `head` field — those are the engine's to write.

### Fields from the answer

Two route fields name a field of the step's answer, and the engine reads it, so no hook parses what an agent wrote:

```yaml
    - when: { kind: diagnosed }
      effect:
        type: tracker.label
        addFrom: [class, areas]
        allowed: [bug, question, feature, billing, login]
        remove: [bug, question, feature]
    - when: { kind: logged }
      effect: { type: tracker.worklog, spentFrom: spent, max: 4h, marker: "work:{stage}:{round}", skipIfLogged: true }
```

- `addFrom` names one answer field, or a list of them. Each holds a label or a list of labels, and they are added beside any `add`. Each must be in `allowed`, and none may start with `lr:`. The labels added are taken out of `remove`, so removing a whole set and adding one of it back leaves exactly that one, and the next pass writes nothing.
- `spentFrom` names the answer field holding the time spent, as hours and minutes: `45m`, `2h`, `1h30m`. It becomes the worklog's seconds.
- An answer field that is missing, a label outside `allowed`, or a time that is not a duration, is zero, or is over `max` fails the round as a broken contract. Nothing is trimmed to fit, nothing is written, and the round is not run again.
- `addFrom` and `spentFrom` are route fields: `on_enter` has no answer to read them from.

### The merge's three guards

A workflow that merges with no person gives `pull.merge` two guards beyond green checks. The kit enforces all three, not a prompt:

```yaml
      - type: pull.merge
        branch: "landrace/{item}"
        reviewedBy: code-review
        refuse: [.landrace/**, .github/**, package.json]
```

1. **Checks green.** The checks on the head to merge are `success` or `none`, judged on the pass's read and again on the forge just before the merge.
2. **The reviewed head.** `reviewedBy` names a stage with a step and a `branch`. When a step on a branch runs, the runner records the commit its worktree started at on the record that settles its round — beside the step's answer, never in it, so nothing an agent writes can name it. `run.heads.<stage>` is the head of that stage's latest valid round. Just before the merge, a head that round did not start at — pushed after the review, while CI ran, or while the item was halted — or no recorded head at all is treated as a moved head (below), logged as `forge.merge.unreviewed`.
3. **Protected paths.** `refuse` lists path globs: `**` for any number of whole directories (including none, so `**/CLAUDE.md` matches the root's too), `*` within one name, everything else literal. Matching ignores case, after both glob and path are normalised (NFKC) and case-folded, the way a case-insensitive checkout reads them. Last, once everything else would let the merge through, the kit reads the pull request's changed files — a rename's old path too — and refuses one that matches any glob, naming the paths: a person must merge it. It also refuses a change to any file whose name normalisation alters, protected or not, and a list of changed files the forge could not give whole (GitHub lists at most 3,000; GitLab cuts a large diff and says so) or could not give at all, since what was not read was not checked. A list the forge is still working out — GitLab's count of changes not computed yet — leaves the merge to the next tick.

**A moved head.** A push that lands between the read and the merge is a commit no check has passed. Nothing merges and nothing halts. Since the merge is not applied again while the item stays at the merging stage, the workflow must route out of that stage on `rel.implements.in.not.merged: { $gt: 0 }` — back to review, say — or the item waits there for ever. A merge that already went through, with a crash before the next read, is done rather than failed.

Any other refusal from the forge — not mergeable, conflicts, a missing permission — is the merging stage's rejected round, and the item halts for a person. On GitHub the merge is always a merge commit, so a repository with merge commits disabled refuses every merge; GitLab merges with the project's own method.

`validate` refuses a `refuse` that is not a non-empty list of non-empty strings, a glob no changed path could ever match (a leading `/` or `./`, a trailing `/`, or an empty, `.` or `..` segment), a `reviewedBy` naming a stage with no step or no branch, and a `pull.merge` anywhere but a stage's `on_enter` — a step's route that merges, or one whose `goto` enters a stage that does, would merge on what an agent answered, past every trigger and guard.

### Which pull requests are an item's

A pull request is an item's only when it comes from the item's own `landrace/{item}` branch, in the item's own repository — never a fork's, whatever its branch is called, and never one that only says it closes the item. Anybody can open a pull request whose text says `Closes #7`, from a fork too; tied to #7 by that, its diff, its failed checks' logs and its review threads would reach the agents of a workflow that merges with no person.

Forks are left out before counting. Neither forge can be asked for one repository's branches alone, so an item's read pages through every pull request on a branch of its name; past 500 of them on GitHub, or 1,000 on GitLab, the list is not read to its end and the item halts, saying so. Two open pull requests from the one branch refuse a merge.

## Step files

A step file is Markdown. Its front matter is the contract, and its body is the prompt the agent reads. The step declares where each shape of its output goes, so the engine never learns what a spec is.

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
| `capabilities` | What the agent may do: `repo:read`, `repo:write`, `items:create`. The first two are enforced by comparing the worktree before and after the run; the third by which MCP tool the agent is handed. An unknown capability refuses the step |
| `model` | Overrides `agent.model` for this step. A cheap step should say so |
| `effort` | Overrides `agent.effort` for this step and its conversation turns. The level is the agent's own word; an executor refuses one it has no level for |
| `timeout` | Overrides `budget.stepTimeout` for this step, as a duration such as `120m` |
| `skills` | The only project skills this step and its conversation turns may load, by name; absent, every one. A name no `.claude/skills/<name>/SKILL.md` defines is refused at startup and by `validate`. An unlisted skill is never read or loaded |
| `mcp` | The `agent.mcp` servers this step and its turns get, in `agent.mcp`'s own form: a server name, or `{ name, tools }`. It narrows `agent.mcp` and never widens it: a server or tool outside it is refused at startup and by `validate`. Absent, every `agent.mcp` server; `[]`, none |
| `plugins` | The agent's plugins for this step and its turns, in place of `agent.plugins`; `[]`, none |
| `output.discriminator` | The field of the answer whose value picks the shape |
| `output.shapes` | The values the discriminator may take, each with the fields that shape may carry. An answer whose discriminator names no shape fails the round, and is never retried. Only the discriminator is checked, and the fields a route's `addFrom` or `spentFrom` reads ([Fields from the answer](#fields-from-the-answer)): any other declared field the answer omits is absent, and one it mistypes is kept as written. Neither fails the round; each shows up as a trigger that never matches. A field the shape does not declare is dropped |
| `output.routes` | Where each shape goes: a `when` over the answer, one `effect`, and an optional `goto`. Two routes matching one answer is ambiguity, and halts |

The agent ends its answer with a fenced JSON block, which the engine reads as its output. The schema is strict: an unknown key fails to load.

`skills` and `plugins` are enforced by Claude Code alone; Codex refuses a step that lists either, at startup. A step without any of the three gets what the workspace gives every step, as the table says. This step narrows all three: two project skills, two of one server's tools, and no plugins:

```yaml
skills: [developer, backend-unit-testing]
mcp:
  - name: codebase-memory-mcp
    tools: [search_graph, get_code_snippet]
plugins: []
```

### Placeholders

A prompt may name any snapshot path in braces — `{node.id}`, `{node.title}`, `{run.previousStage}`, `{run.lastHuman.data.body}`, `{artifacts.spec.url}` — and it is filled in when the step runs. A path that is present and `null` reads `none`; a list is joined with commas; a path that is absent is left visible as written, so a typo shows in the prompt instead of vanishing. `{vars.<name>}` is filled in at load — see [Configuration](configuration.md#vars).

### Briefings

A prompt may also ask a hook for prose the snapshot does not carry: `{brief.<source id>.<key>}`, fetched only when that step is about to run and never routed on. A prompt is briefed only the keys it names, and the hook reads only those, so one key never spends another's budget, and a key that cannot be read fails only a step that asked for it. Every briefing is escaped before it reaches a prompt and cut at 32 KB per hook, saying it was cut.

A project whose hooks are made by the kit's `compose` has the source id `project`, and these keys:

| Key | What it holds |
|---|---|
| `{brief.project.body}` | The item's own text, without the marker Landrace stamps on an item it created; 16,000 characters at most, cut saying so, and "This item has no description beyond its title." when there is none |
| `{brief.project.threads}` | The open review threads across the item's pull requests, each named by its thread id, marked when Landrace's reviewer raised it, and said to be awaiting a fix or answered by the fixer, with its last reply — the ones awaiting a fix first |
| `{brief.project.diff}` | What the item's open pull requests change, file by file — a read-only step has no shell to run `git diff` — 24,000 characters of patches at most, with every file past that named |
| `{brief.project.ci}` | The open pull requests' checks: a `### pr-N: checks <state>` line for each, and under a failing one each failed check as `#### <name>` followed by the last 4,000 characters of its log, or `(log unavailable)`. 16,000 characters at most; it says when no pull request is open |
| `{brief.project.history}` | One timeline, oldest first, of every comment on the item — Landrace's own shown by marker, everyone else's by login — and every review thread on every pull request tied to it, resolved or not, with the pull request it is on, who raised it and its last reply. The newest 100 entries, fewer when their text would pass 28,000 characters, each cut at 1,000 characters, saying how many earlier ones it left out |
| `{brief.spec.content}` | The approved spec's own text, from the docs role's `spec` artifact. "No spec has been published for this item." when there is none; a page that cannot be read halts the step |

A log or a patch sits in a code fence longer than any run of backticks inside it, so a fence in the text cannot close it early. The spec is handed over as text, never as a link to fetch: a prompt telling the agent to fetch a URL is what the screener refuses, and in a private repository the agent could not open it anyway.

### extends: a step built on another

A step file may name another in its front matter, `extends: ./base.md` — a path relative to the file, inside `.landrace/` — and give only what differs. The child is merged over the parent:

- Each front-matter key the child gives replaces the parent's whole; a key it leaves out is the parent's. Nothing inside a key is merged.
- The body is a lead (the text before the first `## ` heading) and sections. A non-empty lead replaces the parent's lead.
- A `## ` section whose heading matches one of the parent's replaces it, in the parent's place; a heading the parent lacks is appended.
- A chain is allowed (a child of a child); a loop is an error naming the files.
- A heading twice in one file is refused, so a replacement can only mean one section. A `## ` inside a fenced code block is text, not a heading.

## Eligibility and admission

`eligible` decides which items a workflow touches at all. Each rule has a `when` and an `else`; an item that fails a rule is skipped, with that `else` as the reason `landrace status` and the board give. Nothing is run or written for a skipped item. The rules are answered from what `list()` returned, before any item is read and before any lock is taken.

```yaml
eligible:
  - when: { "node.state.labels": { $in: ["lr:auto"] } }
    else: "no lr:auto label"
  - when: { "node.state.labels": { $nin: ["lr:fast"] } }
    else: "a fastlane item (lr:fast)"
```

A rule the tick cannot answer — one reading a path the listed item does not carry — abstains, and abstaining means eligible. That is why a source fills every field a rule may read, empty rather than absent.

`admit` is the other side: the labels an item gets when it is started into this workflow. `validate` checks them against `eligible` when that rule reads labels alone, so a workflow cannot admit an item it would then skip, and refuses an admitted label the engine writes itself (`lr:working`, `lr:stage:…`).

## Several workflows in one workspace

One `landrace start` runs every workflow: each workflow's source is listed, each open item is **claimed** by one workflow, and that workflow works it.

- **Claims.** A workflow claims an item its `eligible` rules accept. Exactly one claim is the rule: an item two workflows accept is a **conflict**, and an id two different sources report is a **clash**. Either halts, naming both workflows. An item no workflow accepts is unclaimed, and shows as Not admitted with each workflow's reason.
- **Keeping claims apart.** Give each workflow `admit` labels and `eligible` rules the other turns away — here `full-cycle` admits `lr:auto` and refuses `lr:fast`, and fastlane needs both. `validate` reports, and `start` refuses, two workflows over one source where what one admits the other certainly accepts (the `claims` rule).
- **One pool.** `tick.concurrency` bounds the agents running at once across the whole workspace, overlapping ticks and every workflow included, not each workflow or each tick: items of every workflow share its slots, most urgent first. [Configuration](configuration.md#landraceyaml) says when a tick leaves an item for a later one.
- **A failing source.** With several sources, one that cannot list leaves every clash unjudged, so that tick no other source's items are worked, and the board refuses writes while any source is failing. Runs already in flight are not stopped. With one source, its own items are simply absent.

How the board and the MCP show several workflows is in [the CLI](cli.md#the-board).

## Relationships

The engine gives no relationship type a meaning. A workflow does, by routing on the type's `rel` counts.

### Relating items

Items are related through the operator's writes: `landrace_create_item` takes `relate`, and `landrace_update_item` takes `relate` and `unrelate`, each a list of `{ type, item }`:

```json
{ "relate": [{ "type": "blocked-by", "item": "10" }] }
```

Every entry of both lists is checked — its shape, a type the tracker writes, and whether the tracker may relate the other end at all — before the first write, labels included, so one refused entry changes nothing and the refusal names every entry refused. A write that still fails partway — an outage, say — stops the rest and says what was written, what failed and what was not tried. An item is never related to itself.

A breakdown step may relate the sub-items it files in the same way — see [Splitting work into sub-items](#splitting-work-into-sub-items).

### Waiting on blockers

`full-cycle` builds an approved spec only once nothing the item is blocked by is still open. The gate reads the item's blockers (`rel.blocked-by.out`) and two facts its tracker reports on it. It has three conditions, each the others' negation, so exactly one holds of any item:

- **Free** — no blocker open, none dropped, and neither `node.state.dependencyCycle` nor `node.state.relatedUnreadable` true: on to `build`.
- **Wait** — one blocker open or more, none dropped, neither fact: `waiting`, a stage that runs no step and is nobody's turn. The board files the item under Waiting with its note, `waiting on #10, #11`, and it goes on to `build` by itself once the last blocker is done.
- **A person's** — a blocker dropped (closed as not planned), the item on a cycle of blockers, or its blockers not all read: `blocked`, under Needs you, on a trigger named for the reason — `a blocker was dropped`, `it is on a cycle of blockers`, `its blockers cannot all be read`. The board's panel says the same in words. Nothing failed, so Retry has nothing to retry: a person settles it and sends the item on with "Go to step… build".

```yaml
  - id: waiting
    note: "waiting on {rel.blocked-by.out.open}"
    triggers:
      - name: you approved the spec, and a blocker is open
        when:
          "run.stage": triage
          "run.lastOutputValid": null
          "run.previousStage": spec-human-review
          "run.outputs.triage.intent": approve
          "rel.blocked-by.out.not.closed": { $gt: 0 }
          "rel.blocked-by.out.dropped": { $not: { $gt: 0 } }
          "node.state.dependencyCycle": { $ne: true }
          "node.state.relatedUnreadable": { $ne: true }
```

The counts and facts are written as negations, `{ $not: { $gt: 0 } }` and `{ $ne: true }`: an item with no blockers has no `not.closed` count at all, and the tracker writes a fact only when it holds, so `0` or `false` would match nothing there and hold every such item for good.

The gate is read on each way to `build` from a spec not yet built — an approval, and a spec written together in a pairing — and again at `waiting`. A person's Retry or "Go to step… build" reads no gate: sending an item to build is theirs to decide. The gate is passed once: a blocker that reopens later holds nothing back, and a change asked for on the pull request goes back to `build` ungated. Fastlane reads the same gate where it starts.

How each tracker reads and writes `blocked-by` — and what it cannot see — is in [Integrations](integrations.md).

## Splitting work into sub-items

Splitting is an engine feature a project enables in its own workflow; the shipped workflows do not use it. [`tests/fixtures/children`](../tests/fixtures/children/workflow.yaml) is the worked example: a `breakdown` stage, a `children-running` stage the parent waits in, `build` as a second entry stage for the children, and `done` closing a finished item so its parent can count it. Its stages name no branch and it publishes nothing; a project copying it wants the shipped workflow's `branch` fields and `publish` stage too.

A step that declares `capabilities: [items:create]` is handed exactly one Landrace tool beside the servers `agent.mcp` allows: `landrace_create_child` (`title`, `body`, `priority` 0–9, `relate`). A second MCP server, started beside the agent, serves it, bound on its command line to the parent, stage and round — not by anything the agent says. The fixture's `breakdown` ends by answering `children` (it called the tool at least once) or `single` (it built the spec as one piece of work); the two route to `children-running` and `build`, and a round that says one but did the other halts at `blocked`.

A breakdown may order what it files: `relate: [{ type: "blocked-by", item: "<sibling id>" }]` blocks a later sub-item on an earlier sibling, and a workflow that gates children on their blockers, as [`tests/fixtures/ordered-children`](../tests/fixtures/ordered-children/workflow.yaml) does, builds them in that order. An entry is checked for its shape and for a type the tracker writes before anything is filed; what it is related to is otherwise the agent's choice. That is a known trade-off: text steering a breakdown could tie its children to an unrelated open item and stall them, and a child related to its own parent deadlocks — the child waits on the parent, which waits at `children-running` on the child, and nothing flags it beyond the child's note. Restricting a child's relationships to its siblings is the recorded follow-up.

Re-running `breakdown` — after a revision, or after a crash mid-round — first drops, as not planned, every sub-item an earlier round of the stage created, and every pull request open on them (the stage's `nodes.close`); anything already finished stays closed as it was, and is no longer counted. A sub-item a person opened under the parent by hand is never touched. The parent reaches `done` only once every sub-item still counted is closed as done.

The child server reads `.landrace/.env` itself, as `landrace start` does: a token exported only in the shell that ran `start` never reaches it, so it must be set in `.env` or no child can be created.

## The shipped workflows

This repository ships two workflows in `.landrace/workflows/`. Both are ordinary workflow files over the GitHub integration, and both are examples to copy.

### The labels

`lr:auto` means Landrace manages the item. `lr:fast` sends it to fastlane instead of full-cycle. Full-cycle's `eligible` accepts `lr:auto` and turns `lr:fast` away; fastlane's needs both. So an item carrying both is fastlane's alone, and `lr:fast` alone is nobody's ("no lr:auto label").

- Taking `lr:auto` off stops an item in either workflow.
- Adding `lr:fast` to an item full-cycle is working moves it to fastlane at the same stage, where fastlane has that stage — `build`, a review, a halt. An item at one of full-cycle's spec stages, which fastlane lacks, halts there for a person.
- A finished item keeps its admit labels. `done`, and fastlane's `closed`, remove only the engine's own (`lr:working`, `lr:awaiting`, and fastlane's halt labels), so the board files a closed item under the workflow that worked it.

The engine's own labels are `lr:working` (an agent's turn), `lr:awaiting` (a person's, for whoever reads the tracker), `lr:blocked` and `lr:screened` (halts), and `lr:stage:<id>` (the position). `landrace_update_item` and `landrace_create_item` refuse to set any of them.

### full-cycle

Every item is specified, approved, built and reviewed as one piece of work, and a person merges it.

```text
spec (→ spec-questions → spec) → spec-human-review → (waiting →) build → publish
     → code-review ⇄ fix-review → (retro →) pr-human-review → done
```

The halts are `blocked` and `screened`; `triage` is the judge every reply goes through.

- **`spec`** writes the spec and publishes it — or asks blocking questions, and the item waits at `spec-questions`.
- **`spec-human-review`** waits for a person to approve the spec. A spec written together in a pairing skips it.
- **`build`** implements the approved spec on `landrace/{item}`, updates the `docs/` page of anything a user sees change, runs the tests and pushes. Gotos and Retry run it up to three rounds. A change a person asks for on the pull request adds a round past that, each one waiting for them to write.
- **`publish`** runs no step: it records its entry, pushes the branch and opens the pull request, then moves the item. A push or pull request the forge refuses — nothing was committed — halts at `blocked`; Retry pushes again, and "Go to step… build" runs another round instead.
- **`code-review`** reviews the pull request and answers with findings, replies and resolved threads, which `pull.review` posts. A user-visible change whose `docs/` page was not updated, or reference material added to the README, is a finding. A review with findings sends the item to `fix-review`.
- **`fix-review`** fixes each open thread or pushes back, and answers on the thread.
- **`retro`** runs when the review settles on an item that was corrected on the way — a second spec or build round, or any fix round — unless its pull request has already merged.
- **`pr-human-review`** waits for a person to merge. A merged pull request moves the item to `done`.

If a person closed the pull request unmerged and nothing is open or merged beside it, a finished build goes to `blocked` instead of `publish`, which would open another over their close. A replacement they opened from `landrace/{item}` is them carrying on, and the build publishes.

#### The judge

Wherever it is a person's turn — `spec-questions`, `spec-human-review`, `pr-human-review`, `blocked`, `screened` — a reply goes to `triage`. It reads the reply into a closed set of answers: `approve`, `revise`, `rework`, `question`, `unclear`, `goto-spec`, `goto-build`. An answer that changes nothing where the reply was made sends the item back there (`run.previousStage`).

- At `pr-human-review`, `revise` — a change asked for on the pull request — sends the item to `spec` first. That round sees the approved spec and the message, amends the spec with just that change, and goes straight to `build`, so `build`, `code-review` and `fix-review` all read the change from the one authority they check against.
- Work asked for there that changes no requirement — resolve the conflicts, get a failing check green — is `rework`, and goes straight to `fix-review`, which merges main and runs the checks. It is shown the message only when a reply sent the round.
- A spec redone from scratch after a pull request exists (`goto-spec`) is reviewed at `spec-human-review` as ever.
- At a halt, `triage` is told which step failed (`run.failedStage`), and "try again" means that step when it was `spec` or `build`. Any other failure is the board's Retry to retry.

`triage` has no round cap: each round waits for a person's own message, so a conversation is bounded by the person having it.

#### Review threads are a conversation

A person comments on a line of the pull request, or the reviewer raises a finding. `fix-review` fixes it or pushes back, and answers on the thread itself — "Fixed in `abc123`: …" or "Not changed, because …". It cannot resolve a thread.

Whose turn a thread is comes from its last comment. A reply the fixer wrote, ending in its `fix` marker, means the thread waits for the person. Anything else means it **awaits a fix**: no reply yet, a person's reply after the fix, or the reviewer's "still wrong: …". `rel.implements.in.sum.awaitingFix` counts these, and every review trigger reads it, so an answered thread never loops.

- A person resolves their own thread once the answer satisfies them, or replies on it, which sends it back to `fix-review`.
- Each round, `code-review` re-checks its own threads: it resolves the ones fixed, or whose pushback holds, and answers the rest "still wrong". It never replies on a person's thread.
- Each reply ends in a `{kind}:{stage}:{round}:{thread}` marker, and a thread whose last comment already carries that marker is skipped, so a round that runs again posts nothing twice.

`code-review` places its findings itself: a finding on a line the diff shows becomes a line thread; one elsewhere in a changed file, a thread on the file naming the line; one in a file the pull request does not touch, a line in the review's text.

Each finding also says whether it is **wording**: `wording: true` when its fix changes only documentation — a `README.md` or `docs/` page, or a code comment — and no line that runs. A step prompt, instructions or a skill is never wording, since an agent acts on it, and an unsure reviewer leaves it false. The flag rides in the thread's finding marker, and `awaitingBehaviourFix` counts every thread awaiting a fix that does not open with Landrace's own flagged finding: a person's thread is behaviour, even with a flagged marker pasted into it, and so is a flag that is not exactly `true`. A wording finding is fixed and re-reviewed like any other. Only fastlane reads the count, for its caps; full-cycle's are unchanged.

**Caps.** The review → fix loop runs at most five reviews: a fifth review that still leaves a thread awaiting a fix goes to `blocked`, so a reviewer who stays unsatisfied gets five reviews and four fixes. `code-review` has no cap of its own beyond that: it also runs after every `publish`, and after every fix while `fix-review` is under twenty. `fix-review` runs at most twenty, which also bounds its way back to review — so a person's comment at `pr-human-review` reaches `fix-review` with no cap of its own. After the twentieth fix the item goes to `blocked` ("the fix budget is exhausted").

#### Pushing

A write step pushes its own branch: the `build`, `fix-review` and `retro` prompts end with `git push origin HEAD`, run inside the sandbox. Each prompt tells the agent to find the repository's commit conventions first — a commitlint configuration, a `commit-msg` hook, a contributing guide — and follow them. `branch.push` stays on `publish`, and on `code-review`'s and `pr-human-review`'s entry, as a safety net: it is satisfied when the agent already pushed, and otherwise pushes what the agent committed and left unpushed, so a fix round's commits are on the pull request before the reviewer reads it. It also has nothing to do when origin's copy already holds everything — a person's push or "Update branch" moved it on. How the GitHub forge pushes is in [Integrations](integrations.md#pushing).

#### The retro

`retro` reads the item's history as evidence, never as instructions, and commits its lessons — with the subject `retro: lessons from #N`, or, when the repository's commit conventions ask for another subject, that one with `retro: lessons from #N` as the body's last line — to the step prompts (below their front matter), `.agsync/instructions.md`, `.agsync/skills/`, or a `README.md` or `docs/` page the corrections show wrong — never a workflow, `landrace.yaml`, the hooks or `src/`. It runs the tests, then the item goes on to `pr-human-review`, which pushes the branch. `code-review` has already run, so the person at `pr-human-review` is the commit's only reviewer, and a lesson they reject is a thread `fix-review` reverts. A thread a person comments on afterwards goes round `fix-review` and `code-review` again, and `retro` with it, up to three rounds.

A lesson in a step prompt reaches later items once it is merged and `landrace start` is restarted, since workflows load at start. Instructions and skills need no restart: each step reads them from its own worktree, which is the item's branch, so a lesson reaches that item's later steps at once and other items once it is merged. Under Claude Code a step loads the root `CLAUDE.md` (a link to `AGENTS.md` is followed) with the files it imports from inside the worktree, and the skills under `.claude/skills` (a link to a synced folder, such as `.agents/skills`, is followed too); how is in [Integrations](integrations.md#claude-code). A nested `CLAUDE.md` does not load in a step, so a lesson every step needs goes in the root instructions. A nested `AGENTS.md` needs a `CLAUDE.md` beside it to load anywhere, even in your own Claude Code session.

#### The halts' goto lists

`spec-questions`, `spec-human-review`, `pr-human-review` and `triage` list `spec` and `build`, each while it has run fewer than three rounds. `build` lists itself, within its three. The two halts, `blocked` and `screened`, list every step, because a halt's Retry is a goto to whichever step failed:

- `spec` and `build`, under three rounds each;
- `publish`, as Retry only, three times in all;
- `code-review` while the item has a pull request, under eight rounds — past the loop's own five, since each later build round adds a review through `publish`;
- `fix-review` while it has a pull request, under twenty;
- `retro` under three, while a pull request is unmerged;
- `triage` while a person has written on the item, under twenty.

### fastlane

Fastlane is for a change small enough to need no spec. An item labelled `lr:auto` and `lr:fast` — the labels `landrace_create_item` adds when it starts one there — goes from its own text to a merged pull request, and is closed. A person is needed only at a halt — a change to a protected path is one, and so is every lesson a retro commits outside `README.md` and `docs/` — or when the item is `stuck`.

```text
(waiting →) build → publish → code-review ⇄ fix-review → ci → (retro → code-review → ci) → merge → done
```

- **`waiting`** holds a fresh item while something it is blocked by is open, by full-cycle's gate. Fastlane has three entry stages: a fresh item enters `build` when it is free, `waiting` while a blocker is open, and `stuck` when a blocker was dropped or cannot be read, or the item is on a cycle — each on a trigger named for the reason. From `waiting` it goes to `build` once the last blocker is done, or to `stuck` once its blockers need a person.
- **`build`** works from the item's title and `{brief.project.body}`, and, once the pull request's checks have failed, from `{brief.project.ci}` too. A person's message is its work only when a reply sent the round. Its step extends full-cycle's `build.md` and replaces only `## What to build`; `code-review`, `fix-review` and `retro` extend full-cycle's too, each with the item's text where full-cycle's has the spec.
- **`ci`** waits for the checks on the pull request's head once a review left every thread resolved. A thread opened meanwhile — a person's objection — goes back to `code-review` first, whatever the checks say. Only a review thread or a line comment holds the merge: a review's summary alone, or a comment on the conversation, is not counted — to object that way, take `lr:auto` off too. Failed checks go back to `build`; passed checks go to `merge`, or first to `retro`, once, when the item was corrected on the way (a second build, any fix round, or a reply a person had to write).
- **`merge`** applies `pull.merge` as it is entered, held to [the merge's three guards](#the-merges-three-guards): checks green on the head it merges, that head the one `code-review`'s latest valid answer read (`reviewedBy: code-review`), and no change to a protected path. Its `refuse` list is `.landrace/**`, `.github/**`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, `.pnpmfile.cjs`, `.agsync/**`, `.agents/**`, `.claude/**`, `.codex/**`, `.cursor/**`, `.mcp.json`, and `CLAUDE.md`, `CLAUDE.local.md` and `AGENTS.md` in any directory.
- **`done`** closes the item and removes its working labels, keeping `lr:auto` and `lr:fast` — for a pull request Landrace merged, and for one a person merged by hand during review, CI or the merge, or while the item was stuck or blocked.
- **`closed`** closes the pull request unmerged (`pull.close`), then the item as dropped.

Because `none` reads as green — it means only that nothing has registered on that head yet — a repository that uses fastlane must require status checks on its default branch, which the forge then holds the merge to. A head no review read sends the item back to `code-review`; a fixer's and the retro's commits each go through a review round of their own. Every file a retro writes a lesson in is a protected path but `README.md` and `docs/`, so an item whose retro committed a lesson anywhere else is refused at the merge and waits at `blocked` for a person to merge it; only a retro that learned nothing, or fixed only `README.md` or `docs/`, merges with no person.

A change to a protected path, or one whose changed files the forge could not list whole, goes from `ci` to `blocked`, under Needs you with the paths named, for a person to review and merge by hand. Any refusal from the forge — conflicts, branch protection, checks gone red since the read — is `merge`'s rejected round, and nothing asks again until a person's Retry. A merge that failed on the way, an outage, leaves the item at `ci`, and the next tick tries again. A refused `pull.open` at `publish`, or `pull.close` at `closed`, halts the same way.

**Caps and `stuck`.** Once code review has run four times, a review that still asks for a behaviour fix ("the review budget is exhausted"), a thread opened while the checks ran, or a head that moved under the merge leaves the item `stuck` instead of going round again — so the loop runs at most three fix rounds for behaviour; eight is the fixer's cap only through a halt's Retry. A review whose every thread awaiting a fix is a [wording finding](#review-threads-are-a-conversation) goes round twice more, so at most five fix rounds in all: at its fourth and fifth rounds it goes to `fix-review`, and only a sixth that still finds wording leaves the item `stuck` ("the wording budget is exhausted"). A clean sixth review goes on to CI. A finding wrongly flagged wording costs at most those two fix rounds, each reviewed, and the merge's guards are the same. Gotos, Retry and CI fixes run `build` at most three times in all; a reply asking for work adds a round past that, each one waiting for a person to write. `stuck` waits on a person, under Needs you. An item also goes there when a review leaves a thread open with no fix owed on it (one the fixer answered, waiting on a person, since the merge needs every thread resolved), and when a person closed the pull request unmerged during CI or the merge — or during a build, with nothing open or merged beside it, rather than publishing another over the close.

**Replies.** At `stuck`, `blocked` or `screened`, a reply goes to `triage`, which reads it as `rework` (back to `build`, which is shown the message), `close` (`pull.close` closes its pull request unmerged, then the item is closed as dropped — "not planned" on GitHub), `question` (answered on the item) or `unclear`; the last two leave the item where it was. "Go to step…" offers `build` and `code-review` from `stuck`, each within its cap, and every step from a halt. `publish`, `merge` and `closed` are the halts' too, but only as the Retry of one the forge refused, three times each. A Retry of a refused merge is declined while a thread is open; a head pushed while the item was halted — the conflict a person resolved — is not one the last review read, so it goes back to `code-review`.

**To stop an item, take `lr:auto` off** — taking `lr:fast` off sends it to full-cycle instead. Closing its pull request unmerged stops it too: the item goes to `stuck`. Reopening the pull request does not move it; reopen it, then use "Go to step… code-review" to go on.

Who fastlane trusts, and what to set up before the first `lr:fast` item, is in [Security](security.md#who-fastlane-trusts).
