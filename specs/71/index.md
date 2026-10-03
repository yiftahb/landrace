## Problem
Fastlane: thread awaiting fix after review round 4 → `stuck`. #56, #65, #63: wording only (docs, code comments), CI green; person fixed by hand. Cap meant for behaviour loops.

## Decisions
1. Reviewer flags finding `wording: true` when only documentation or code comments change; prompts, unsure: no flag.
2. Round 4 or 5 leaves only wording awaiting fix → `fix-review`, review, CI, merge, `done`. No person.
3. Round 6 still wording → `stuck`, "the wording budget is exhausted".
4. Behaviour awaiting fix, round 4+ → `stuck`, "the review budget is exhausted", as today.

- Reviewer flag, not path: covers comments (#63); path globs cannot live in `src/`.
- Mislabel costs ≤ two fix rounds, never resolve or merge: fixes re-reviewed, guards unchanged.
- Default behaviour: no flag, person's thread, opening not bot's, count absent.
- Past cap: option (a), bound `run.counters.code-review` < 6; no new stage.
- Node counts behaviour, so "only wording" reads zero; conditions cannot compare two paths.
- Full-cycle routing unchanged: all cases fastlane; its `blocked` already offers "Go to step… fix-review".

## Technical design
- `src/namespace.ts` — `Finding` gains optional `wording: boolean`; `ThreadCounts` gains `awaitingBehaviourFix`; `ExternalPull`, `ExternalPullSeed` gain `awaitingWordingFix`, default 0.
- `src/kit/forge.ts` — `placeFindings` puts `wording: true` in flagged finding's marker; `threadCounts` reads `first`, counts `awaitingBehaviourFix`: awaiting threads not bot-opened with that marker. Closed pull: 0.
- `src/testing/external-state.ts` — `MemoryForge` counts flagged findings as `awaitingWordingFix` (≤ `awaitingFix`); node reports `awaitingBehaviourFix` as difference.
- `.landrace/workflows/full-cycle/steps/code-review.md` — finding items gain `wording: boolean`, defined in Steps 6, 7; fastlane's inherits.
- `.landrace/workflows/fastlane/workflow.yaml` — fix-review: `code-review` < 4, or < 6 with `sum.awaitingBehaviourFix: 0`. `stuck`: review-budget trigger adds behaviour `$ne: 0`; new wording-budget trigger: behaviour 0, `code-review` ≥ 6. Caps comment updated.
- `docs/workflows.md` — `awaitingBehaviourFix` row; flag in review-threads section; fastlane "Caps and `stuck`".

## Done when
- Round 4, only wording awaiting fix → `fix-review`, then `code-review` round 5.
- Round 6, only wording → `stuck`, "the wording budget is exhausted".
- Round 4, wording plus one behaviour thread → `stuck`, "the review budget is exhausted".
- `createExternalState`, #56 shape: round 4 only `docs/` wording findings → merged, `done`, no person.
- Pasted `wording` marker on person's thread, or `wording: "yes"`: behaviour.
- `tests/workflow/fastlane.test.ts` exit sweep over behaviour 0/1, `code-review` 3–6: every exit exclusive.
- `landrace validate` clean on both workflows; `cycle-bound` silent.