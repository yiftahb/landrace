I wrote the spec for #105: T1 (comment visibility, mentions, the marker kept out of the visible text), T5 (a worklog effect) and T6 (labels from a step's answer). It is below. While writing it I made three choices the item didn't spell out:

- **`spentFrom`, not `from`:** the item proposed `from` for the worklog's duration, but `from` is a field only the engine may write (`src/workflow/validate.ts:302`).
- **`addFrom` takes a list of fields:** the support-desk answer has two label fields (class and areas), and a route carries only one effect until #107.
- **A duration over `max` fails the round:** it is not shortened to `max`.

## Problem
JSM project: comments post public. Every Landrace record reaches requester, marker text shows. No internal note, no mentions, no worklog effect, no label from an answer without one route per combination.

## Decisions
1. Jira tracker on JSM project: preflight logs service desk (`projectTypeKey: service_desk`).
2. Engine records post internal, no marker text.
3. Route `tracker.comment` `visibility: public` answers requester; `@[accountId]` or `@[email]` mentions that person.
4. Diagnose answers `class`, `areas`; one `tracker.label` route, `addFrom: [class, areas]`, `allowed`, `remove` → labels replaced.
5. Answer `spent: 1h30m`; route `tracker.worklog` `spentFrom`, `max`, `marker`, `skipIfLogged` → time logged unless already logged.

- `visibility` default internal on service desk, ignored elsewhere. Project type unreadable → comment refused: never public by guess.
- Marker in comment property `landrace.marker`; body marker read only without one: older comments.
- Email resolved like `jiraAssignee`: exactly one user, else text.
- `spentFrom`, not `from`: `from` reserved (`src/workflow/validate.ts:302`).
- `addFrom` takes field or list: two fields, one route, until #107.
- Engine resolves `addFrom` → `add`, `spentFrom` → `seconds`; hooks never parse agent text. Resolved labels leave `remove`: replace converges.
- Missing field, label outside `allowed`, bad, zero or over-`max` duration → `contract` failure, never trimmed.
- Worklog 403 → `EffectRefused`: step not re-paid.
- No trigger or route added; routing unchanged.

## Technical design
- `src/namespace.ts` — `CommentVisibility`, `WorklogRecord`.
- `src/conventions.ts` — `WORKLOG_EFFECT`, `workDurationMs` (`45m`, `1h30m`).
- `src/kit/tracker.ts` — `comment` takes optional `{ visibility }`; `tracker.comment` apply passes it, unknown value throws.
- `src/runner/step.ts` — `resolveOutputFields`: contract checks, `addFrom`/`spentFrom` resolved onto destination.
- `src/workflow/validate.ts` — rule `effect-fields`: `visibility`; `allowed` non-empty, no `lr:`; `tracker.worklog` needs `spentFrom`, `marker`, valid `max`; `addFrom`, `spentFrom` route-only.
- `integrations/jira/adf.ts` — `splitMarker`; `toAdf` takes resolved mentions, emits `mention` nodes.
- `integrations/jira/tracker.ts` — cached project read; `comment` posts `landrace.marker`, `sd.public.comment` properties; `comments` expands properties; `observe` adds `tracker.worklogs`, every page; `tracker.worklog` effect.
- `docs/workflows.md`, `docs/integrations.md`, `docs/validate.md` — fields, service desk, rule.

## Done when
- Service desk: record POST carries `sd.public.comment` `{internal: true}`, public route none; software project: none.
- No `projectTypeKey`: no POST, comment refused.
- Posted ADF lacks `<!-- landrace`; next tick reads property, round counted; body-marker comment still read.
- `@[id]`, one-user email → `mention`; zero or two users, code span → text.
- Label outside `allowed`, `0m`, `soon`, `5h` over `max: 4h` → `contract` failure, nothing written.
- Old class, `remove` all three, answer new class → only new class; next tick no write.
- `1h30m` → one 5400 s worklog; next tick none more; person's worklog plus `skipIfLogged` → none.
- Worklog 403 → round recorded refused.
- `lr:` in `allowed`, `addFrom` in `on_enter`, `visibility: loud` → `landrace validate` fails.
- `pnpm typecheck && pnpm lint && pnpm test && pnpm build` pass.