I've revised the spec with your two changes. Everything else stands as you approved it. I didn't run the codebase-memory-mcp tools this round; I read `src/people/panel.ts`, `src/people/resolve.ts`, `src/ui/server.ts`, `src/ui/page.ts` and the types in `src/namespace.ts` directly. The spec runs past the 400-word limit; I chose not to cut approved content further to get under it.

## Problem
No built-in integration declares a connection. Steps bill the operator's `claude` login. Slack posts only by webhook. Jira and Slack identities are never looked up. A revoked Claude token leaves runs "unavailable" forever, with the row still "connected".

## Decisions
1. Person pastes `claude setup-token` output into the Claude row. Their steps run with `CLAUDE_CODE_OAUTH_TOKEN`.
2. Jira and Slack rows fill from the person's email on start or reload. Each row shows its looked-up `accountId` / `userId` to that person only, read-only. Failed lookup → "missing", detail = vendor's reason.
3. ≤30 days left → `connection.expiring`, at most once per connection per day.
4. Agent refuses the token → `connection.failed`, row "failed", runtime reloads, nothing runs until a re-paste. No round.
- Round 2, identity value shown: design §4 "shown to the person"; how a person spots a lookup that matched the wrong account.
- Round 2, `401` matched as a whole word only: an unrelated "7401" must not fail a token.
- Identity value lives only in `MeView.identities`, never in `ConnectionStatus`: statuses feed problems, which are logged. Looked-up values join `log.redact`.
- Auth detected in runner: kit may log only `agent.*`/`step.*` and cannot import the store. Converge already reads `result.reason`.
- `resolve` throws when it cannot look up (no `slackBotToken`, Jira refusal), null when nobody matches. Reason travels in the throw.
- Stored connection judged even when not required: a failed token must not fall back to operator login.
- No stored connection → no `personEnv`, today's login.

## Technical design
- `src/namespace.ts` — events `connection.expiring`, `connection.failed`; `ExecutorFactory.connection?`, `ExecutorContext.personEnv?`, `KitSettings.personEnv?`, `ConvergeDeps.connectionFailed?`, `BuildOptions.onConnectionFailed?`, `LocalGate.lookups`, `MeView.identities`.
- `src/kit/executor.ts` — `BaseExecutor.connection?`; `create` hands `ctx.personEnv` to both build paths; `childEnv(extra, git, personal)`.
- `src/runner/limits.ts` — `isAuthFailure`: `/invalid (api key|bearer token)|authentication_error|OAuth token (has )?expired|\b401\b/i`.
- `src/runner/converge.ts` — "unavailable" matching `isAuthFailure` with `deps.connectionFailed` set: log `connection.failed`, record failure, halt as today.
- `src/people/resolve.ts` — `lookupIdentities` stores each unstored identity with `resolve`, `source: "lookup"`, reasons to `lookups`; `personEnvOf`; `resolvePerson` judges stored connections, `lookups` for missing detail.
- `src/people/panel.ts` — `me` fills `identities` from caller's own connected identities; status detail from `lookups`.
- `src/ui/page.ts` — `integrationRow` shows an identity's fields as plain text, no input.
- `src/ui/server.ts` — `servePeople` comment: never a credential's value.
- `src/cli/start.ts` — `localGate` runs lookups, redacts values; `executorFor` sets `personEnv` from hook's own connection; `buildWorkspaceRuntime` sets `connectionFailed` (`store.put` `failedAt`, scrubbed `failure`, `onConnectionFailed`); `runStart` passes `slot.reload`, warns `connection.expiring` from day-keyed map.
- `integrations/claude/index.ts` — `claudeConnection`; `connection` maps `CLAUDE_CODE_OAUTH_TOKEN` → `token`.
- `integrations/jira/tracker.ts` — export `accountFor`; `integrations/jira/index.ts` — `jiraConnection`.
- `integrations/slack/index.ts` — bot mode; `slackConnection`, `users_not_found` → null.
- `integrations/gitlab/index.ts`, `integrations/github/index.ts` — user connections, `check` on `GET /user`.
- `docs/integrations.md` — each connection, hook export, Slack scopes, subscription note, Notion and Codex none.

## Done when
- Step env holds `CLAUDE_CODE_OAUTH_TOKEN`, no `ANTHROPIC_API_KEY` though parent has it; argv lacks `--bare`.
- No stored claude connection → env as today.
- "OAuth token has expired" → `connection.failed`, `store.put` with `failedAt`, "unavailable", no round record, reload not ready.
- Same error without `personEnv` → no `connection.failed`.
- Reason containing "7401", no auth text → `isAuthFailure` false; "status 401" → true.
- Bot mode posts `chat.postMessage`, `Bearer <slackBotToken>`, channel `slackNotifyUser`; `ok:false` throws `slack: <error>`; webhook tests untouched.
- Slack lookup → `{ userId }`; no `slackBotToken` → "missing", detail names it.
- Jira `resolve` → `{ accountId }` through `accountFor`.
- Identity with `resolve` and email → `source: "lookup"`, "connected"; no email → no call.
- `GET /people/me` holds caller's looked-up `accountId` and `userId`; another person's response lacks them; holds no credential token; identity row renders no input.
- Log lines and OTEL records from lookup, start and runs hold no looked-up value.
- `connectedAt` 340 days ago, many ticks over two days → two `connection.expiring`.
- Forge `check`: 200 → null, 401 → reason.
- `tests/boundaries.test.ts` unchanged, passing; `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` pass.

// Generated by AI (claude-opus-5-5:high)