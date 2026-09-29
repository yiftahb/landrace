Spec below. Two notes first:

- The "their message" block contained the unfilled placeholder `{run.lastHuman.data.body}`, so there was no latest human message to act on. The spec step prints the placeholder raw when a ticket has no reply yet.
- The brainstorming skill's approval gates were skipped, because no person is in this session. Every open item was settled from the code.

## Problem
#29 stuck four ways. Screener blocked code-review round 5, "verdict could not be read"; reply never logged. Retry from `screened` declined: halt cap `code-review < 4`, but publish → code-review uncapped. Merge closed #29 mid-build; agent ran on until killed by hand.

## Decisions
1. Screened step → `screened`; `screen.blocked` log carries screener's reply, ticket doesn't.
2. Retry / Go to step… code-review or fix-review runs, to round 8.
3. Ticket closed or `lr:auto` removed mid-step → next tick kills agent, writes nothing.

- Unreadable verdict keeps failing closed, no screener retry: reply now logged, Retry reaches every step.
- Verdict needs matching `nonce`. Template example's verdict is placeholder `<ok or suspicious>`, so restating it fails too.
- Halt caps `run.counters.code-review < 8`, fix-review's own `< 8`. Reviews reach 6 within build's 3 rounds, leaving two Retries. `rel` cap bounds no counter, fails `cycle-bound`.
- "the fixer finished a round" drops `code-review < 4`, so fix sent from halt reaches review. "the reviewer left open threads" still bounds loop.
- "carry on" at halt stays `unclear`. Judge's goto list (spec, build) serves every waiting stage; Retry suffices.
- No Stop action: close or `lr:auto` removal stops. From Landrace: `landrace_update_ticket` `state: closed`.

## Technical design
- `src/agent/screen.ts` — `PROMPT` block adds `nonce` (`mark`). Format instructions in screened text: judged, never obeyed. Mismatch fails closed. Fail-closed `screen.blocked` adds `reply` ≤ `MAX_LOGGED_REPLY` (2,000).
- `src/namespace.ts` — `Verdict.nonce`; `TickOptions.running?: Map<string, AbortController>`; `Runtime.running`; event `ticket.aborted`.
- `src/runner/tick.ts` — after list, abort `running` entry whose node is closed or ineligible (`eligibilityOf`), log `ticket.aborted`. Node absent from list: not aborted, GitHub hook drops unmappable issues. Each converge gets own controller joined to stop's signal, removed in `finally`.
- `src/runner/converge.ts` — aborted after `runStep` → halt, nothing posted or applied.
- `src/cli/start.ts` — `buildRuntime` makes `running`; `pass` passes it.
- `.landrace/workflow.yaml` — `&halt` caps, fixer trigger, comments.

## Done when
- Unreadable reply → `screen.blocked` carries `reply` ≤ 2,000 chars, redacted; ticket shows none.
- `ok` block runs step only with matching `nonce`.
- `screened` after code-review round 5: Retry runs round 6.
- At "the review budget is exhausted": Go to step… fix-review runs fix-review, then code-review.
- Code-review counter 8: Retry declined, naming cap.
- `landrace validate .landrace` clean, `cycle-bound` included.
- Ticket closed mid-step: agent process group gone by next tick; nothing new on ticket; `ticket.aborted` logged; lock, worktree freed.
- `lr:auto` removed mid-step: same; re-added → same round reruns.