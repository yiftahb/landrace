## Problem
Board shows one line per ticket. Watching running agent, answering spec questions → leave page (GitHub, editor, MCP chat). #21 questions, #19 stuck publish, #20/#21 nesting all handled off-board. Engine already has `reply`/`ask`/`resolve`/goto/Retry; page has no place for them.

## Decisions
Flow:
1. Click ticket row → right panel opens, board pushed left; `#ticket=<id>` in URL. Back, ✕ or Escape closes; expand button → full width. Board keeps polling.
2. Top: title, `#id ↗`, stage, round, model, badge; opened (`createdAt`), stage since (`since`), last activity; artifact rows with kind/state icons.
3. Bottom, by badge:
   - `running`: live tool lines (Read `x`, Bash `y`) + agent messages, read-only.
   - `needs-you`: composer with Reply, Ask the step (confirms first, spinner, answer inline), Resolve; existing Chat deep links.
   - otherwise: conversation history, read-only.

Choices:
- Plain text v1, no markdown. No vendored files, CSP unchanged.
- Event `{at, kind: "tool"|"message", text}`, text ≤ 300 chars, ≤ 500 events per round. Bounded file, and nothing large gets stored.
- Ask shows spinner, not progress. Turn is short; progress needs a second stream.
- Below `sm`: panel full width. Too narrow to split.
- Tickets only open a panel. PR rows keep their `↗`, which is enough.
- Polling every 1.5s. Same model as board, no SSE.
- Activity is display-only, last round per stage kept. Never read by a decision, so state is still derived.

## Technical design
- `src/namespace.ts` — `ActivityEvent`; `Executor.run` opts `onActivity?`; `ActivityLog { record, read }`; `HistoryItem {at, author, byAgent, text, pull?}`; `Source.history?(ctx)`; `ConvergeDeps.activity?`, `ConversationDeps.activity?`; `UiOptions.talk?: Pick<Tools, "reply"|"ask"|"resolve">`, `UiOptions.activity?`, `UiOptions.history?`.
- `src/runner/activity.ts` — new `createActivityLog(root, scrub)`: redacted JSONL at `<sandboxRoot>/activity/<ticket>.jsonl`, new round of a stage drops the older round, caps enforced.
- `src/runner/step.ts` — passes `onActivity` bound to ticket/stage/round.
- `src/mcp/conversation.ts` — same for `ask` turns.
- `.landrace/hooks/claude.ts` — `--output-format stream-json --verbose`, maps `tool_use`/`assistant` text to `onActivity`, final `result` → `{ text, sessionId }`.
- `.landrace/hooks/github.ts` — `historyItems` one reading; `historyOf` renders from it; `Source.history` returns it.
- `src/ui/server.ts` — GET `/tickets/<id>/activity?after=<n>`, `/tickets/<id>/history`; POST `/tickets/<id>/reply|ask|resolve` with JSON body ≤ 16 KB, `foreignWrite` per action, wake tick after.
- `src/cli/start.ts` — builds activity log, `createTools` talk, passes to `serveBoard` and converge deps.
- `src/ui/page.ts` — panel, hash routing, composer, polling.

## Done when
- Row click opens panel; `#ticket=25` reload reopens it; Back/Escape closes.
- Running Claude step shows tool lines within 2s.
- After step ends, its last round stays visible; restart loses only that view.
- Reply posts comment; triage runs on next tick.
- Ask confirms, answers inline; Resolve hands ticket back.
- Write without `x-landrace-action` or foreign Origin → 403.
- Executor without `onActivity` → "no live activity for this agent".
- `brief.github.history` output unchanged.
- No secret value in activity JSONL.