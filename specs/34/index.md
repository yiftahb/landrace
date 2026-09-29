## Problem
Every stop waits on a person; only signal: Needs you lane. #29 sat at `screened`, #27 at `pr-human-review`, unseen.

## Decisions
1. Ticket comes to rest in Needs you.
2. Slack pings you: `<@U…> #29 needs you — <title> · <why>`, linked.
3. Board, 🔔 on: system notification "#29 needs you", body "title — why"; click opens panel.
4. Stays: silence. Leaves, returns: notified again.

- One rule with board: `laneOf` over `statusRows`.
- Checked pass after applied transition: re-read snapshot reads `needs-you`, decision `wait`. Triage (runs next) never fires.
- Fire-and-forget: failure logged, never halts; nothing stored.
- No `kind`: `stage`, `why` say enough. No threading: webhook can't.
- Bad `notify` config refused by `start`, `validate` alike.

## Technical design
- `src/namespace.ts` — `NotifyEvent` `{ event, ticket, title, link, stage, why, board }`, `Notifier`, `Registry.notifiers`, `ConvergeDeps.notify`, `notify.sent`/`notify.failed`.
- `src/hooks/contracts.ts` — `"notifier"` kind; `defineNotifier`.
- `src/hooks/index.ts` — exports both types.
- `src/hooks/load.ts` — duplicate notifier id throws, naming both.
- `src/config/schema.ts` — strict `notify: { on, via }`; `on` only `needs-you`.
- `src/runner/status.ts` — gains `laneOf`.
- `src/ui/board.ts` — imports it.
- `src/runner/notify.ts` (new) — `createNotify`: rule, fan-out, failure log; `notifyProblems`: unregistered `via` ids, registered listed.
- `src/runner/converge.ts` — passes that snapshot to `deps.notify`; no import cycle.
- `src/cli/start.ts` — wires `deps.notify`, throws `notifyProblems`; `board` = `ui.url`, else null.
- `src/cli/validate.ts` — reports `notifyProblems`.
- `src/ui/page.ts` — `#notify-toggle`, localStorage (try/catch); poll diffs tickets badged `needs-you`, first seeds; `tag` per ticket; click → `openPanel`; denied → says so.
- `.landrace/hooks/slack.ts` (new) — notifier `slack`: POST `{ text }` to `slackWebhookUrl`, mention `slackNotifyUser`, escape `&<>`, 5s timeout, non-2xx throws status, reply, never URL.
- `.landrace/workflow.yaml` — lists `hooks/slack.ts`.
- `.landrace/landrace.yaml` — `notify` block; secrets `slackWebhookUrl`, `slackNotifyUser`; first redacted.
- `.landrace/.env.example` — `SLACK_WEBHOOK_URL`, `SLACK_NOTIFY_USER`.
- `README.md` — `notify:`, notifier hooks, Slack values, 🔔.

## Done when
- Enter spec-questions → one Slack post; later ticks none.
- spec-questions → triage → spec-questions → second post.
- Enter build → none.
- Throwing notifier → `notify.failed`; outcome unchanged.
- `on: [done]`, unregistered `via`, two `slack` notifiers → refused by `start`, `validate`.
- Title `<@U999> <https://evil|x>` posts as `&lt;@U999&gt; &lt;https://evil|x&gt;`.
- Slack 404 → log has reply, not URL.
- First board load → nothing.
- Newly Needs you, 🔔 on, granted → one notification; off or denied → none.
- Click → panel open.