## Problem
Board shows one line per ticket. To see what a running agent does, or to answer a step, you leave the page for GitHub, an editor, or MCP in another chat. #21's spec questions, #19's stuck publish and the #20/#21 nesting were all read and acted on off-board. The engine already has `landrace_reply`, `landrace_ask`, `landrace_resolve`, goto and Retry, but no place on the page uses them.

## Decisions
Flow:
1. Click ticket row → right panel opens, board pushed left, URL `#ticket=<id>`. Back, ✕ or Escape closes it. ⤢ makes it full width.
2. Top of panel: title, `#id ↗`, badge, stage, round, model, opened (`createdAt`), stage since, last activity, artifacts with the board's kind and state icons.
3. Bottom of panel, by state:
   - **Running:** live read-only lines (`Read x`, `Bash y`, agent message).
   - **Needs you:** composer with Reply, Ask the step (confirm first, paid turn), Resolve. Chat deep links stay.
   - **Otherwise:** conversation so far, read-only.
4. Board keeps polling behind the panel.

Choices:
- Top data comes from the `BoardRow` already in `/board.json`. No second status read.
- Activity is stored in a JSONL file, not in memory. `landrace mcp` asks run in another process and must show too.
- Only the last round per stage is kept, and a new round truncates it. Display only, so "state is derived, never stored" holds.
- Ask shows progress. The turn emits activity like a step does, so the progress comes free.
- Conversation comes from `Snapshot.entries`. Tracker-agnostic, one read. #20's `brief.github.history` already shipped, so there is nothing to share.
- Plain text in v1, no markdown and no vendored libs.
- Below `sm`, the panel takes full width.
- Only tickets open a panel. Pull request rows don't.
- Transport is polling every 1.5s. No SSE, no websockets.

## Technical design
- `src/namespace.ts` — `AgentActivity { kind: "tool" | "message"; text; at }`. `Executor.run` opts gain optional `onActivity(e)`. `UiOptions` gains optional `panel: TicketPanel` (`activity`, `conversation`, `reply`, `ask`, `resolve`). `BoardRow` gains `panel` paths, or null on artifacts. `Entry` gains optional display-only `text`.
- `src/runner/activity.ts` — new. `createActivityLog(root, redact)`: `record(ticket, stage, round, e)` and `read(ticket, after)`. Writes `<sandboxRoot>/activity/<ticket>/<stage>.jsonl`, `text` cut to 240 chars, 500 lines per round, redacted via `redactValue`.
- `src/runner/step.ts` — `runStep` passes `onActivity` into `executor.run`.
- `src/mcp/conversation.ts` — `ask` passes `onActivity` too.
- `src/conventions.ts` — `entriesFromComments` fills `Entry.text` (marker-stripped body).
- `src/ui/board.ts` — `boardView` builds `panel` paths from the checked id.
- `src/ui/server.ts` — `GET /tickets/<id>/activity?after=<n>` and `GET /tickets/<id>/conversation`. `POST /tickets/<id>/reply|ask|resolve` go through `foreignWrite` with actions `reply`, `ask`, `resolve`; ask and resolve wake `tick`.
- `src/cli/start.ts` — `startUi` wires `panel` from `postReply`, `createConversation` (deps as `src/cli/mcp.ts` builds them) and `createActivityLog`.
- `src/ui/page.ts` — panel DOM, hash routing, polling, composer, confirm on Ask.
- `.landrace/hooks/claude.ts` — `--output-format stream-json --verbose`; maps `tool_use` and assistant text to `onActivity`; returns `{ text, sessionId }` from the `result` event.

## Done when
- Row click opens the panel; `#ticket=<id>` reload reopens it; Back and Escape close it.
- Running step shows tool lines within 2s.
- Finished step's lines survive until that stage's next round.
- Needs-you ticket: Reply posts a comment, Resolve hands back, Ask confirms then answers inline with progress.
- Write without `x-landrace-action`, or with foreign Origin → 403.
- Executor without `onActivity` → "no live activity for this agent".
- Secret value never appears in an activity file.

Screenshots
<img width="420" height="603" alt="Screenshot 2026-09-28 at 14 00 57" src="https://github.com/user-attachments/assets/9a2e892d-3ee1-484e-a3ca-b1c7629ec4e3" />
<img width="420" height="605" alt="Screenshot 2026-09-28 at 14 00 41" src="https://github.com/user-attachments/assets/b918ecc9-2082-4db6-84ae-8ef8661209b6" />



