## Problem
Fastlane: thread awaiting fix after review round 4 → `stuck`. #56, #65, #63: wording only, CI green, fixed by hand. Cap meant for behaviour loops.

## Decisions
1. Reviewer flags finding `wording: true` when only docs or code comments change; prompts, unsure: no flag.
2. Round 4 or 5, only wording awaiting fix → `fix-review` (option (a)), review, CI, merge, `done`; no person.
3. Round 6 still wording → `stuck`, "the wording budget is exhausted".
4. Behaviour awaiting fix, round 4+ → `stuck`, as today.

- Flag, not path: covers comments (#63); no path globs in `src/`.
- Mislabel: ≤ two extra fix rounds, re-reviewed; merge guards unchanged.
- Default behaviour: no flag, opening not bot's, count absent.
- Node counts behaviour: conditions cannot compare two sums.
- Full-cycle unchanged: cases all fastlane; `blocked` offers fix-review.
- Changed: wording-budget needs `sum.awaitingFix` > 0; clean round 6 matched it and `ci`.
- Changed: sweep adds `awaitingFix`, `openThreads` axes, exposing that.
- Changed: mixed partial fixes pinned on `threadCounts`; `MemoryForge` counts cannot model them.

## Technical design
- `src/namespace.ts` — `Finding.wording?: boolean`, `ThreadCounts.awaitingBehaviourFix`, `ExternalPull.awaitingWordingFix` (in `ExternalPullSeed`, default 0).
- `src/kit/forge.ts` — `placeFindings` puts `wording: true` in flagged finding's marker; `threadCounts` reads `first`, counts `awaitingBehaviourFix` (awaiting, no bot wording marker); closed pull 0.
- `src/testing/external-state.ts` — `MemoryForge` adds flagged findings to `awaitingWordingFix` (≤ `awaitingFix`), reports difference as `awaitingBehaviourFix`; comment: mixed partial fixes unmodelled.
- `.landrace/workflows/full-cycle/steps/code-review.md` — findings gain `wording: boolean`, taught in Steps 6, 7; fastlane's inherits.
- `.landrace/workflows/fastlane/workflow.yaml` — fix-review: `code-review` < 4, or < 6 with `sum.awaitingBehaviourFix: 0`. `stuck`: review-budget adds behaviour `$ne: 0`; new wording-budget: `sum.awaitingFix` > 0, behaviour 0, `code-review` ≥ 6. Caps comment.
- `docs/workflows.md` — `awaitingBehaviourFix` row, flag under review threads, fastlane caps.

## Done when
- Only wording awaiting fix: round 4 → `fix-review`, then round 5; round 6 → `stuck`, "the wording budget is exhausted".
- Round 6, clean review → `ci`.
- Round 4, wording plus behaviour → `stuck`, "the review budget is exhausted".
- `createExternalState`, #56 shape: round 4 only `docs/` wording → merged, `done`, no person.
- Pasted `wording` marker on person's thread, or `wording: "yes"`: behaviour.
- `tests/kit/forge.test.ts`, `threadCounts`: wording and behaviour thread awaiting; only wording answered → `awaitingBehaviourFix` 1; only behaviour → 0.
- `tests/workflow/fastlane.test.ts` sweep, behaviour ≤ `awaitingFix` ≤ `openThreads` each 0/1, `code-review` 3–6: every exit exclusive.
- `landrace validate` clean; `cycle-bound` silent.