I've settled the design. The ticket's open questions are resolved inside the spec, and nothing it decided is reopened.

## Problem
The only way to steer a step is Ask → Resolve → triage → a whole new round, re-derived from the ticket. The step's session and draft are thrown away every round. #27's change at `pr-human-review` needed three round trips to be heard.

## Decisions
Flow:
1. Panel header ⋯ → Pairing → "Pair on spec" or "Continue build together".
2. Landrace enters the round, cuts a worktree, shows Copy command: `cd <worktree> && claude --session-id <id> --mcp-config <repo>/.mcp.json "$(cat <prompt file>)"`.
3. Board: Held elsewhere, "Pairing — spec, round 2", held time. Engine never runs the step alone.
4. Person works with agent in own terminal.
5. Finish… (optional note) → closing turn on forked session → step's normal output path → ticket moves on. Paired spec skips `spec-human-review`, goes to build.
6. Or Release → agent runs the round alone.

Choices:
- Offer: pending step → pair on it; stepless home stage → continue the goto target with the latest output session (`spec-questions`/`spec-human-review` → spec, `pr-human-review` → build); halt → pair on `run.failedStage`. Goto list and cap must allow. Reason: goto rules already say where a person may send a ticket.
- Start not screened: nothing runs unattended, person reads the prompt. Finish's closing turn screened like a step prompt.
- Uncommitted leftovers in read-only worktree: discarded with worktree. Sandbox before-state read at Finish, so only closing turn judged.
- Malformed Finish: round rejected, ticket to `blocked`, hold stays. Finish again enters next round, same session; goto cap applies.
- Ask refused while paired: two writers on one session.
- `lr:paired` label: board lane comes from listing, no per-ticket read.
- Seeded prompt in file outside worktree: ticket text never inside shell command.
- Panel-turn pairing: follow-up.

## Technical design
- `src/namespace.ts` — `Executor.handoff?` → `Handoff { command }`; run option `fork`; `ExecutorFactory.create` returns `handoff` too; `by?: "pair"` on `Entry`/`Marker`; `Run.paired`, `Run.lastOutputBy`; `LockKind` `"pair"`; pair/finish/release on `PanelPaths`, `TicketPanel`, `Tools`.
- `src/conventions.ts` — `PAIR_KIND`, `RELEASE_KIND`, `LABELS.paired`.
- `src/sandbox.ts` — export `repoDigest`, used by `sandboxRoot`.
- `src/core/derive.ts` — `run.paired`: latest pair record whose round has no output or release; `run.lastOutputBy`.
- `src/core/decide.ts` — pending round that is paired → `wait`, why "paired".
- `src/core/pair.ts` (new) — `pairOffer`, `pairSessionId` (UUID v5).
- `src/runner/step.ts` — `handInOutput` split from `runStep`, used by both.
- `src/runner/pair.ts` (new) — `startPair`, `finishPair`, `releasePair` under ticket lock; pair record before `planEffects` entry; prompt file under `sandboxRoot`.
- `src/agent/worktree.ts` — worktree name parameter; pairing uses `<ticket>-pair`.
- `src/runner/snapshot.ts` — `ENGINE_PROVIDES` adds `run.lastOutputBy`.
- `src/runner/status.ts` — `lr:paired` → note "pairing".
- `src/mcp/conversation.ts` — `ask` refuses while `run.paired`.
- `src/mcp/tools.ts`, `src/mcp/server.ts` — `landrace_pair`, `landrace_finish`, `landrace_release`.
- `src/ui/server.ts` — POST `/tickets/<id>/pair|finish|release`.
- `src/ui/board.ts` — paired → `elsewhere` lane, pairing note.
- `src/ui/page.ts` — header ⋯ Pairing section; row ⋯ "Pairing…".
- `src/cli/start.ts` — wires pairing into `panelFor`.
- `.landrace/hooks/claude.ts` — `handoff`; `--fork-session` on `fork`.
- `.landrace/workflow.yaml` — `spec-human-review` requires `run.lastOutputBy: agent`; build gains "you wrote the spec together".

## Done when
- Pair on fresh ticket: pair record carries session; tick never invokes spec; board shows "Pairing — spec, round 1".
- Copied command opens `claude` in the worktree with the landrace tools.
- Held after landrace restart.
- Finish on spec: output record `by: pair`; ticket enters build; worktree gone.
- Finish answer without json block: ticket `blocked`; second Finish records the next round's output.
- Release: agent runs the round.
- Continue build at `pr-human-review`: command resumes the build round's session.
- Executor without `handoff`: no Pairing section; `landrace_pair` refuses.
- Ask on paired ticket refused.
- Existing tests pass.