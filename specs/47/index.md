## Problem

Jira Cloud projects cannot compose `new Jira({ project: "KEY" })`: no `landrace/integrations/jira` exists.

## Decisions

1. Project composes `Jira`, declares secrets `jiraBaseUrl`, `jiraEmail`, `jiraToken`; redacts last two.
2. Preflight names each missing permission, issue type, or type lacking `labels`; writes nothing: Jira shows every write.
3. Tick lists `project`'s open issues, plus `lr:stage:*` ones resolved within `DONE_WINDOW_MS`. Status moves only on close/reopen; missing transition errors, listing offered.
4. Comments: plain paragraphs, `<!-- landrace … -->` visible last.

- REST v3 ADF: v2's wiki markup reads marker JSON's `\\`, `{x}` as syntax.
- ADF: paragraph per `\n\n` block, `hardBreak` per `\n`, text verbatim; read inverts: marker back verbatim, last.
- Logins `accountId`: unique, stable. `author` = `creator`: reporter editable. `editor` = last `description` changer: edited origin reads nobody's.
- `closed`: null until status category `done`; `dropped` if status or resolution named `transitions.dropped`, else `done`: unknown closures still count.
- Timestamps `toISOString()`: engine sorts `at` as strings; Jira answers local offsets.
- Ids: only `project`'s `KEY-<n>`; key and ids checked before URL/JQL; moved (rekeyed) issue refused.
- `create` priority past project's last → lowest: landrace has ten levels.
- `update` `state`: `closed` → `done` transition; `open` → first To Do-category one.
- Bodies over 32,767 ADF characters refused pre-request: Jira's bound.
- `jiraBaseUrl` only `https://<site>.atlassian.net`: basic auth carries account token.

## Technical design

New but `README.md`; nothing else touched.

- `integrations/jira/index.ts` — exports `Jira`, `JiraOptions`.
- `integrations/jira/client.ts` — `createClient`, `clientFor` (per `ctx.config`; missing secret named), basic auth, `/myself` first.
- `integrations/jira/adf.ts` — `toAdf`, `fromAdf`.
- `integrations/jira/tracker.ts` — `Jira extends BaseTracker` plus `check`; `JiraOptions` adds `fetchImpl`; `/rest/api/3/search/jql`, `/rest/api/3/changelog/bulkfetch`.
- `tests/integrations/jira/fake-jira.ts` — fake v3 behind `fetchImpl`, Jira's documented responses.
- `tests/integrations/jira/jira.test.ts` — tests.
- `scripts/jira-check.mjs` — env `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_TOKEN`, `JIRA_PROJECT`, optional `JIRA_OPTIONS` JSON.
- `README.md` — `#### Jira` under integrations: hook file, secrets, options, check command.

## Done when

- Fake-Jira tests: each abstract method; `compose` with `MemoryForge`, `MemoryDocs` — create, marked comment, entry read back, label, close done, dropped.
- Marker reads back verbatim, last; forged `<!--` stays escaped.
- Missing transition lists offered; missing secret named; foreign id refused before requesting.
- `scripts/jira-check.mjs`, live: same flow; prints each check; exits non-zero on failure or nothing checked.
- `pnpm typecheck && pnpm lint && pnpm test && pnpm build` passes.
- `landrace validate .landrace`: valid.