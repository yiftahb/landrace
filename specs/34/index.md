## Problem
Every stop waits on person; only signal: Needs you lane. #29 sat `screened`, #27 `pr-human-review`, unseen. PR #36 now conflicts with `main`.

## Decisions
1. Ticket rests in Needs you.
2. Slack pings you: `<@U…> #29 needs you — <title> · <why>`, linked.
3. Board, 🔔 on: notification "#29 needs you", body "title — why"; click opens panel.
4. Stays: silence. Leaves, returns: notified again.

- Fires when, after applied transition, re-read snapshot's `laneOf` (board's rule) is `needs-you` and decision `wait`; triage never fires.
- Fire-and-forget: failure logged, never halts, nothing stored.
- No `kind`: `why` enough. No threading: webhook can't.
- Round 1 review: page skips `stale` needs-you (triage silent); `renotify: true` (return alerts).
- Round 2, "Resolve conflicts first": requirement unchanged. Build merges `origin/main` into `landrace/34` first, keeps both sides, redoes nothing.

## Technical design
- `src/namespace.ts` — `NotifyEvent`, `Notifier`, `Registry.notifiers`, `ConvergeDeps.notify`; events `notify.sent`, `notify.failed`, `lock.released`.
- `src/hooks/contracts.ts` — `"notifier"` kind; `defineNotifier`.
- `src/hooks/index.ts` — exports `NotifyEvent`, `Notifier`.
- `src/hooks/load.ts` — duplicate notifier id throws, naming both.
- `src/config/schema.ts` — strict `notify`; `on` only `needs-you`.
- `src/runner/status.ts` — gains `laneOf`.
- `src/ui/board.ts` — imports `laneOf`; rows carry `stale`.
- `src/runner/notify.ts` (new) — `createNotify`: rule, fan-out, failure log; `notifyProblems`: unregistered `via`, registered listed.
- `src/runner/converge.ts` — passes re-read snapshot to `deps.notify`.
- `src/runner/tick.ts` — logs `lock.released` when converge releases ticket.
- `src/cli/start.ts` — wires `deps.notify` (`board`: `ui.url` or null); throws `notifyProblems`.
- `src/cli/validate.ts` — reports `notifyProblems`.
- `src/ui/page.ts` — `#notify-toggle` (localStorage, try/catch); poll diffs non-`stale` `needs-you`, first seeds; `tag`, `renotify: true`; click → `openPanel`; denied shown.
- `.landrace/hooks/slack.ts` (new) — notifier `slack`: POST to `slackWebhookUrl`, mention `slackNotifyUser`, escape `&<>`, 5s timeout; non-2xx throws status, reply, not URL.
- `.landrace/workflow.yaml` — lists `hooks/slack.ts`; keeps main's `rework` trigger.
- `.landrace/landrace.yaml` — `notify`; secrets `slackWebhookUrl` (redacted), `slackNotifyUser`.
- `.landrace/.env.example` — `SLACK_WEBHOOK_URL`, `SLACK_NOTIFY_USER`.
- `README.md` — `notify:`, notifier hooks, Slack values, 🔔.

## Done when
- `landrace/34` contains `origin/main`; PR #36 conflict-free; typecheck, lint, tests pass.
- Enter spec-questions → one Slack post; later ticks none.
- spec-questions → triage → spec-questions → second post.
- Enter build → none.
- Spec approval through triage → bell silent.
- Throwing notifier → `notify.failed`; outcome unchanged.
- `on: [done]`, unregistered `via`, duplicate `slack` → `start`, `validate` refuse.
- Title `<@U999> <https://evil|x>` posts as `&lt;@U999&gt; &lt;https://evil|x&gt;`.
- Slack 404 → log has reply, not URL.
- First load silent; later arrival, 🔔 on, granted → one notification, click opens panel; off/denied → none.
- Return, earlier notification unclicked → alerts again.