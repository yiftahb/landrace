## Problem
Support desk, one round: public reply and internal note, ENG bug, retro after close. A route has one `effect`, whose body is the step's prose. `items:create` makes children in the same project only. `claimItems` judges open items only, and `whyStop` aborts a run on a closed item.

## Decisions
1. Diagnosis answers `reply` and `engineering`. Two comments post, then the output record.
2. Bug answer: `tracker.create` files a linked ENG issue, assigned per `jiraAssignee`. Item gets a `created` record naming the key.
3. Ticket resolved: a trigger on `node.closed` enters `retro`. Step runs once. Item rests there.
- A route takes `effect` xor `effects`. Existing workflows untouched.
- `effects` apply in order, output record last. Each is marked `part:{stage}:{round}:{index}`. Core counts no `part`, so the round settles once.
- Step effects are reconciled before apply. A re-run after a mid-list crash skips the parts that landed.
- Runner resolves `from`, then strips it, because `from` is a reserved marker field. Field missing or not a string: malformed, never retried. Escaped at apply.
- `BaseTracker.createsIn()` is empty by default. Validate refuses `tracker.create` for a tracker that does not opt in.
- `satisfied()` reads the `created` record. `apply()` first reuses an issue already carrying `landrace.created-by`, so a crash never files two.
- Closed item: triggers match as today, and two matches halt. One match into a `closed: run` stage moves the item; any other match skips. A step runs only at a `closed: run` stage, and nothing leaves that stage while the item is closed. So the stage runs once per closure.
- A close aborts a run, unless the run started on a closed item.

## Technical design
- `src/namespace.ts` — `Stage.closed`, `CreateRequest`, `PostHook.creates`, `ClaimInput.closedRun`, `Claims.closed`, `RunningItem.closed`.
- `src/conventions.ts` — `TRACKER_CREATE_EFFECT`, `PART_KIND`, `CREATED_KIND`.
- `src/workflow/schema.ts` — route `effects`, xor refine; stage `closed: run`.
- `src/runner/step.ts` — `routeEffects()`, `from`, part markers.
- `src/runner/converge.ts` — reconcile step effects.
- `src/kit/tracker.ts`, `src/kit/compose.ts` — `createsIn()`, `createIn()`, `createdBy()`, `tracker.create` handler; `post.creates`.
- `src/testing/external-state.ts` — `MemoryTracker` `createIn` option.
- `integrations/jira/tracker.ts` — `createIn` option. One request carries the link, the property and the assignee. `check()` checks permissions per project.
- `src/core/claims.ts`, `src/core/decide.ts`, `src/runner/tick.ts` — claims for closed items, closed rule, work `claims.closed`, `whyStop`.
- `src/workflow/validate.ts` — `routeEffects()` in every route rule. New rules: `route-from`; `tracker-create`; `closed-run` (no `branch`, no forge effect, triggers read `node.closed`). `createProblems()` is called from `src/cli/validate.ts` and `src/cli/start.ts`.
- `docs/workflows.md`, `docs/validate.md`, `docs/integrations.md` — new keys, rules, `createIn`.

## Done when
- `effects` route: two comments, one record, one round.
- Crash after part 0: re-run posts part 1 only.
- Route with both or neither of `effect`/`effects`: refused. Shipped workflow validates.
- `from: nosuch`: `route-from`. Field absent: malformed record.
- `tracker.create` without `createIn`: refused. With it: one unlabelled linked issue and a `created` record. Replan creates none.
- Jira preflight names each missing permission on a `createIn` project.
- Sweep, `retro` on `node.closed: done`:
  - open item: no move.
  - closed as done at `done`: enters retro once, then rests.
  - closed as dropped: skip.
  - closed at `build`, pending: no invoke.
  - only a match into `triage`: skip.
  - second match: halt.
  - reopened: normal rules.
- Two eligible `closed: run` workflows: halt. None eligible: not admitted.
- Closed mid-`build`: aborted. Closed mid-`retro`: runs on.
- `closed: run` with `branch` or `pull.open`, or a trigger not reading `node.closed`: refused.