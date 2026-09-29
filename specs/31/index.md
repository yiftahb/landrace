## Problem
Person's line comment at `pr-human-review` → fix-review fixes, can't resolve; code-review counts it open → 4-round cap → right fix `blocked`. Pushback lost in fix-review's summary (#29, PR #30). `openThreads` can't tell "wants fix" from "answered".

## Decisions
1. Person comments on PR line.
2. fix-review fixes, replies there: "Fixed in `abc123`: …" or "Not changed, because …".
3. Person resolves, or replies → fix-review again. Answered threads never loop.
4. code-review re-checks own threads each round: resolves fixed, or replies "still wrong: …".

- Thread state = last comment: `fix` marker → awaiting person, else awaiting fix.
- Reply via GraphQL `addPullRequestReviewThreadReply`, taking brief's thread id; REST needs unread comment id.
- Reply marker `{kind}:{stage}:{round}:{thread}`, kind from route marker; thread ending in it skipped: re-run duplicates nothing.
- `fix` replies on any thread, resolves none; others reply, resolve only on `finding` threads.
- `THREADS_QUERY` adds `comments(last: 1)`, 200 nodes per page.
- **Round 2:** review cap 4 → 5, as asked. Other caps untouched: ticket's cap question was review's.
- Person loop: `fix-review < 20` caps "the fixer finished a round" and halt goto fix-review; `≥ 20` → `blocked`. `code-review` cap strands person's fix after five reviews.

## Technical design
- `.landrace/hooks/github.ts` — `FIX_KIND`; `countOpenThreads` → `countThreads`: `openThreads`, `awaitingFix`, 0 on closed PR; `REPLY_THREAD` in `GRAPHQL_QUERIES`, client `replyToThread`; `applyReview` posts `output.replies` first; brief: state, last reply, awaiting-fix first.
- `.landrace/steps/fix-review.md` — shape `addressed: { replies: [{ thread, body }] }`, route `pull.review`, marker `fix:{round}`; reply step added; summary-pushback wording gone.
- `.landrace/steps/code-review.md` — shape gains `replies`; fixed → `resolved`, else "still wrong" reply.
- `.landrace/workflow.yaml` — `sum.openThreads` → `sum.awaitingFix`; pr-human-review → fix-review uncapped; `code-review` caps `4` → `5`; person-loop caps; `blocked` gains "the fix budget is exhausted".
- `src/namespace.ts` — `ExternalPull.awaitingFix`, `openPull` option.
- `src/testing/external-state.ts` — `state.awaitingFix`; `pull.review`: finding +1, `fix` reply −1, other reply +1.
- `README.md` — threads as conversation; person resolves own; `code-review` cap five, `fix-review` twenty.

## Done when
- fix-review round: one `fix`-marked reply per handled thread; none resolved.
- `state.awaitingFix` = unresolved threads not ending in `fix` marker; closed PR 0.
- Person line comment → fix-review → code-review → `pr-human-review`, not `blocked`.
- Reply to fix, or "still wrong" → fix-review.
- Unsatisfied agent loop: 5 reviews, 4 fixes, then `blocked`, not pass cap.
- Re-applied `pull.review` duplicates no reply.
- `landrace validate` clean; `tests/hooks/github-query-cost.test.ts` passes.