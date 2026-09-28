## Problem
Today the only way to steer a step is Ask, then Resolve, then triage, then a whole new round that re-derives everything from the ticket. The step's session is thrown away each round. #27's change at `pr-human-review` took three round trips to be heard.

## Decisions
Flow:
1. Panel ⋯ (ticket-id row), or board row ⋯ **Pairing…**. The Pairing section lists what applies: **Pair on <step>** or **Continue <step> together**.
2. Click. Landrace writes the pair record, enters the stage and cuts the worktree. Panel shows **Copy command**.
3. Person runs the command in their own terminal and works with the agent.
4. **Finish…** (optional note): closing fork turn, step output, ticket moves on. **Release**: agent runs the step alone.
5. Meanwhile the board shows it in Held elsewhere: "Pairing — <stage>, round N", with time held.

Choices:
- Offers: the stage's own step when pending. Otherwise each `goto` target with a step that `gotoNotListed`/`gotoDeclined` accept. This covers home stages and `blocked`/`screened`, reuses caps and needs no new config.
- Continue: `--resume <agent session> --fork-session --session-id <derived>`. The agent's session stays untouched, and the recorded id stays derived.
- Pair record is written before the stage's on_enter. A crash then leaves the ticket held, never running alone. A retried start re-applies, and reconcile drops what landed. Starting an open pairing returns its command.
- Marker `pair:<stage>:<round>:<n>`, so a second pairing after Release is not reconciled away.
- A pairing is open until an output record for its stage at round ≥ its round, or a release record. While it is open, its stage never runs alone.
- A malformed or refused Finish halts the ticket and leaves the pairing open. Finish again re-enters the stage at the next round (same goto checks), then closes.
- Start screens the seeded prompt; if blocked, nothing is written. The Finish prompt is screened like a step's.
- Finish reads the sandbox before-state at its own start, so the person's edits are not trespass. After output, uncommitted paths are listed in the result and discarded.
- A record without `by` reads `agent`, so old records route unchanged.
- Board learns of a pairing from ticket evaluations it already observes (re-derived each tick). No new label or lock.
- Panel-turn hand-in: follow-up.

## Technical design
- `src/namespace.ts`: `Executor.handoff?({ cwd, session, prompt, resume, server })` returns `Handoff` (`argv`, `cwd`); `run` opts `fork?`; `Entry`/`Marker` `by?`; `Run.pairing`, `Run.lastOutputBy`; `Decision.paired`; `LockKind` `"pair"`; `Tools`/`TicketPanel`/`PanelPaths` gain pairing, pair, finish, release; `PairOffer`, `PairingView`.
- `src/conventions.ts`: `PAIR_KIND`, `RELEASE_KIND`; `recordMarker`/`entriesFromComments` carry `by`; `pairSessionId` (UUID v5); `shellLine` (POSIX-quoted argv).
- `src/sandbox.ts`: export `repoDigest`.
- `src/core/derive.ts`: derive `pairing` and `lastOutputBy`.
- `src/core/decide.ts`: pending stage with open pairing → `wait`, `paired` set.
- `src/runner/step.ts`: output half extracted as `settleOutput({ text, sessionId, by })`; `runStep` calls it.
- `src/runner/goto.ts`: preamble checks extracted as `gotoOrigin`.
- `src/runner/pair.ts` (new): `pairOffers`, `startPair`, `finishPair`, `releasePair`, under ticket lock.
- `src/agent/worktree.ts`: optional slot; pairing uses `<ticket>.pair`.
- `src/runner/converge.ts`: `ticket.evaluated` carries `paired`.
- `src/mcp/tools.ts`, `src/mcp/server.ts`: `landrace_pair`, `landrace_finish`, `landrace_release`.
- `src/cli/start.ts`: panel pairing wiring.
- `src/ui/server.ts`: pairing read, three write routes.
- `src/ui/board.ts`: `paired` map → `elsewhere` lane, note, `since`.
- `src/ui/page.ts`: header ⋯ menu; row ⋯ **Pairing…**.
- `.landrace/hooks/claude.ts`: `handoff`; `--fork-session` when `fork`.
- `.landrace/workflow.yaml`: `spec-human-review` requires `run.lastOutputBy: agent`; build trigger "you wrote the spec together".

## Done when
- Pair on pending `spec`: no spec invocation across ticks and restart; board shows "Pairing — spec, round N".
- Copied command opens Claude Code in the pairing worktree with landrace tools, under the recorded session id.
- Finish on spec: spec published, output record `by: pair`, ticket at `build`, never at `spec-human-review`.
- Paired build Finish: publish, then code-review.
- Malformed Finish: `blocked`; Finish again moves the ticket on.
- Release: step runs alone next tick; pairing worktree gone.
- Start retried after a crash: one pair record, same session id.
- Executor without `handoff`: no offers; `landrace_pair` refuses.
- `landrace validate` passes.