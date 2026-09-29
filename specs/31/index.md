## Problem
A person's line comment at `pr-human-review` goes to fix-review, which fixes it but may not resolve it. Code-review still counts the thread as open, so the ticket loops to the 4-round cap and lands in `blocked` even though the fix was right. fix-review can't answer in a thread, so its pushback is lost in its summary (#29, PR #30). `openThreads` can't tell "wants fix" from "answered".

## Decisions
1. Person comments on PR line.
2. fix-review fixes and replies there: "Fixed in `abc123`: …" or "Not changed, because …".
3. Person resolves the thread, or replies → fix-review again. Loop never waits on an answered thread.
4. code-review does the same on its own findings: resolves fixed ones, or replies "still wrong: …".

- Thread state = its last comment: `fix` marker → awaiting person, else awaiting fix.
- Reply via GraphQL `addPullRequestReviewThreadReply`: takes the brief's thread id. REST needs a comment id, which is never read.
- Reply marker `{kind}:{stage}:{round}:{thread}`, kind = prefix of the route's marker. A thread already ending in that marker is skipped, so a re-run duplicates nothing.
- `fix` review replies on any thread, resolves nothing. Other reviews reply and resolve only on threads a `finding` opened.
- `THREADS_QUERY` adds `comments(last: 1)`: 200 nodes per page. Body parsed then dropped; only counts reach the graph.
- code-review re-checks every open thread it raised, answered or not, each round.
- Brief shows each thread's state and last reply, awaiting-fix threads first.
- Person-loop bound: "the fixer finished a round" caps on `fix-review < 20`, not `code-review < 4`. The old cap strands a person's fix after four reviews, and `landrace validate` needs a counter on this loop. `fix-review ≥ 20` → `blocked`. Halt goto fix-review uses `fix-review < 20`. Agent loop keeps `code-review < 4`.

## Technical design
- `.landrace/hooks/github.ts` — `FIX_KIND`. `countOpenThreads` → `countThreads`, returns `openThreads` and `awaitingFix`; `pullNodeOf` sets both, 0 on a closed PR. `REPLY_THREAD` in `GRAPHQL_QUERIES`, client `replyToThread`. `applyReview` posts `output.replies` before the review body. Brief as above.
- `.landrace/steps/fix-review.md` — shape `addressed: { replies: [{ thread, body }] }`. Route `pull.review`, marker `fix:{round}`. New step: reply on each thread awaiting fix. Summary-pushback wording removed; still resolves nothing.
- `.landrace/steps/code-review.md` — shape gains `replies`. Step 5: fixed → `resolved`, else "still wrong" reply. Never touches a person's thread.
- `.landrace/workflow.yaml` — every `sum.openThreads` → `sum.awaitingFix`. pr-human-review → fix-review uncapped. Caps as above. `blocked` gains "the fix budget is exhausted".
- `src/namespace.ts` — `ExternalPull.awaitingFix`; `openPull` option.
- `src/testing/external-state.ts` — `state.awaitingFix`. `pull.review`: finding +1, `fix` reply −1, other reply +1.
- `README.md` — review loop as a conversation; person resolves own threads; caps.

## Done when
- fix-review round: one `fix`-marked reply per handled thread; none resolved.
- `state.awaitingFix` counts unresolved threads not ending in `fix` marker; closed PR 0.
- Person line comment → fix-review → code-review → `pr-human-review`, not `blocked`.
- Person's reply to a fix, or reviewer's "still wrong" → fix-review.
- Fourth review with `awaitingFix > 0` → `blocked`.
- Re-applied `pull.review` duplicates no reply.
- `landrace validate` clean; `tests/hooks/github-query-cost.test.ts` passes.