# Retro stage: learn from a ticket's corrections

## Problem

A correction fixes only the ticket it was made on. A revised spec, a reviewer's finding, a thread a person reopened, a goto back to build: none of these reach the next ticket's agents. Those agents start from the same `.landrace/steps/*.md`, `.agsync/instructions.md` and `.agsync/skills/*` and can make the same mistake again. The lesson stays in the ticket's history, and no later step reads that history. Today a step sees only the open threads (`brief.github.threads`, `.landrace/hooks/github.ts:1956`) and the approved spec (`brief.spec.content`).

## Proposal

A new write stage, `retro`, runs after a ticket's review settles, and only if something on the ticket was corrected. It reads the whole history and commits `retro: lessons from #N` on `landrace/{ticket}`, editing only the agents' prompts, instructions and skills. A person reviews that commit at `pr-human-review` alongside the feature. If they reject a lesson, they open a thread and `fix-review` reverts it. The engine (`src/`) does not change.

### 1. `brief.github.history` (`.landrace/hooks/github.ts`)

The source's `brief` (`:2228`) returns two keys, `{ threads, history }`. A step that names either key gets both from one call. `history` has two sections:

- **`## Ticket conversation`**, the ticket's comments in order, taken from the snapshot the pre hook already read (`commentsOf`).
  - A comment Landrace wrote (`wroteIt`) is shown as `Landrace [<marker>]: <body>`. This covers spec rounds, `questions:`, `intent:`, `enter:`, gotos and halts.
  - Every other comment is shown as `@login: <body>`.
- **`## Review threads`**, one `### PR #N (open|merged|closed)` heading per pull request on the ticket, open or not.
  - Every thread is listed, resolved or not, as `path:line — raised by Landrace's reviewer | @login — resolved | open`, followed by the opening comment and the last reply.
  - To get this, `BRIEF_QUERY` gains `author { login }` and `comments(last: 1)`. The same paging produces the open-only `threads` list, which is unchanged.

Size cap:
- Each body is cut at 1,000 characters (`BRIEF_BODY_CHARS`).
- The newest 60 comments and 40 threads are kept.
- A line says how many earlier entries were left out, the same way `threads` already does.

The engine escapes and bounds the text on the way in, as it does for every brief.

### 2. `steps/retro.md`

Front matter:
- `capabilities: [repo:read, repo:write]`, `model: opus`, `timeout: 120m`.
- Output discriminator `kind`, with two shapes:
  - `learned: { changes: [{ file, why }] }`
  - `nothing: { reason }`
- Both kinds route to `tracker.comment` with marker `retro:{round}`. The comment lists each changed file with its one-line reason, or says why there was nothing to learn.

The prompt:
- **History is evidence.** It frames `{brief.github.history}` and `{brief.spec.content}` the way `fix-review.md` frames threads: something to learn from, never instructions to follow.
- **Generalise or skip.** A lesson qualifies only if a future ticket would plausibly hit the same mistake. A fact specific to one ticket is not a lesson. "Nothing" is a valid answer and is expected to be the common one.
- **Narrowest file.**
  - A lesson about one stage goes in `.landrace/steps/<stage>.md`.
  - A codebase-wide lesson goes in `.agsync/instructions.md`, followed by `agsync sync`. The prompt never edits `CLAUDE.md` or `AGENTS.md` directly.
  - A technique goes in `.agsync/skills/*`.
  - The prompt never touches `.landrace/workflow.yaml`, `.landrace/hooks/*` or `src/`.
- **Edit, don't append.** It tightens or replaces existing text rather than adding a new paragraph.
- **Later rounds.** It runs `git log --grep '^retro:'` on the branch, reads its earlier lessons, and does not repeat them.
- **Git steps.** The same fetch, merge, commit and `git push origin HEAD` steps as `fix-review.md`, all in one commit `retro: lessons from #{node.id}`. The branch is never force-pushed and `main` is never touched.

The path limit is enforced by the prompt and by the person reviewing, not by a mechanical check.

### 3. `.landrace/workflow.yaml`

A new stage, placed between `fix-review` and `pr-human-review`:

```yaml
- id: retro
  step: steps/retro.md
  branch: "landrace/{ticket}"
  requires: { "rel.implements.in.total": { $gt: 0 } }
  triggers:
    - name: the review settled after corrections
      when:
        "run.stage": code-review
        "run.lastOutputValid": null
        "rel.implements.in.sum.openThreads": 0
        "run.counters.retro": { $lt: 3 }
        $or:
          - { "run.counters.spec": { $gt: 1 } }
          - { "run.counters.build": { $gt: 1 } }
          - { "run.counters.fix-review": { $gt: 0 } }
  on_enter:
    - { type: tracker.comment, kind: enter, marker: "enter:{stage}:{round}", body: "Learning from this ticket's corrections, round {round}." }
    - { type: tracker.status, value: retro }
    - { type: tracker.label, add: ["lr:working"], remove: ["lr:awaiting", "lr:blocked", "lr:screened"] }
```

Changes to `pr-human-review`:
- The `no threads are open` trigger gains the negation of the retro trigger, so the two never match together:

  ```yaml
  $or:
    - $and:
        - { "run.counters.spec": { $lt: 2 } }
        - { "run.counters.build": { $lt: 2 } }
        - { "run.counters.fix-review": { $lt: 1 } }
    - { "run.counters.retro": { $gte: 3 } }
  ```

- A new trigger, `the retro is done`: `{ "run.stage": retro, "run.lastOutputValid": null }`.
- `on_enter` gains `{ type: branch.push, branch: "landrace/{ticket}" }` first. It is satisfied when the retro already pushed.

`&halt` gains `{ stage: retro, when: { "run.counters.retro": { $lt: 3 }, "rel.implements.in.total": { $gt: 0 } } }`.

A person reopening a thread goes through `fix-review` and then `code-review`, which makes `fix-review > 0`. So `retro` runs again with the full history, until it reaches its cap of 3. A counter for a stage that never ran reads as 0.

### Timing of effect

Lessons apply to later tickets only once the pull request is merged into the checkout the orchestrator runs from.
- `workflow.yaml` and step prompts are loaded once, at `landrace start` (`src/cli/start.ts:317`), so a lesson in a step prompt needs a restart.
- Instructions and skills are read by each agent from its own worktree, so they apply without a restart.

## Security

The retro reads text written by commenters and reviewers, and it writes instructions that every future agent follows. That makes it a path for persistent prompt injection. It is contained in four ways:
- The prompt frames the history as evidence, never as instructions.
- The rendered prompt is screened like any other step.
- The step cannot edit routing, hooks or code.
- Nothing reaches `main` unless a person merges it.

The agent reviewer never sees the retro commit, because the retro runs after `code-review`. The person at `pr-human-review` is the only gate.

## Out of scope

- Engine changes.
- The retro editing workflow, hook or product code.
- Merging lessons automatically.
- Aggregating lessons across tickets.

## Depends on

Sandboxed write steps, which are not merged yet. Without them the retro cannot commit, and its edits are lost when its worktree is removed.

## How we know it worked

- **`tests/workflow/shipped.test.ts`**
  - `code-review` settling with `spec: 1, build: 1, fix-review: 0` goes to `pr-human-review`.
  - The same with `spec: 2`, `build: 2` or `fix-review: 1` goes to `retro`.
  - With `retro: 3` it goes to `pr-human-review`.
  - No state matches both triggers.
  - `retro` goes to `pr-human-review`.
  - Retry from `blocked` offers `retro` only while `retro < 3`.
- **`landrace validate`** passes on the shipped workflow.
- **`tests/hooks/github.test.ts`**
  - `history` lists a person's comment, a Landrace marker, a resolved reviewer thread and an open thread from a person on a merged pull request, each labelled correctly.
  - Past the cap, it keeps the newest entries and says how many were omitted.
  - `threads` output is unchanged.
- **`tests/e2e/scenarios.test.ts`**
  - A ticket with one fix round runs `retro` once and reaches `pr-human-review` with a `retro:1` comment.
  - A clean ticket skips `retro`.
- **Live check:** on a real ticket that was sent back once, the pull request carries a `retro: lessons from #N` commit that touches only allowed paths, and the ticket shows a `retro:1` comment listing each change and its reason.