## Problem

Kit (#39) holds tracker, forge, docs helpers but nothing to extend: every integration hand-wires its hooks and briefs (`.landrace/hooks/github.ts`: 2,300 lines); Jira tracker with GitHub forge halts loader (two sources). `src/testing/external-state.ts` copies kit's `satisfied()` and node mapping.

## Decisions

1. Integration author extends `BaseTracker`, `BaseForge` or `BaseDocs`, writing vendor calls only.
2. Hook file exports `compose({ tracker, forge, docs })`'s six hooks; loader unchanged.
3. Prompts name `{brief.project.threads|diff|history}`; history one timeline.
4. Clash halts startup or read, naming both roles. Changing one piece: subclass, spread `super.effects()`.

- Forge, docs graphs built over tracker's ticket ids: `graphProblem` refuses dangling edges.
- `implements` from `landrace/{ticket}` head or `PullRecord.tickets` (`Closes #n`): `api/{ticket}` and memory's branchless pull requests are only named.
- `nodes.close`, only type two roles share: ids split by `kind` in `snapshot.graph`; kind no role closes halts.
- `post` takes tracker, forge types; docs' stay on `spec`: e2e adds own `artifact.publish` hook beside `state.post`, and two claims halt.
- `briefs()`: key → reader, like `effects()`, so `compose` sees clashes. `history`: both roles' `HistoryItem`s sorted by `at`, `historyBrief` bounds.
- Added vendor calls: pull requests naming ticket, forge login (thread turns), pull request close, posted review markers (one review per round), docs page text (brief).
- Memory overrides what tests pin: pre without `tracker.bot`/`git` (`tests/hooks/provides.test.ts`), `tracker.comment` check on own login, `branch.push` recorded, never satisfied, `pull.open` unchecked against heads, threads and reviews as counts.

## Technical design

- `src/namespace.ts` — `TicketRecord` (`ticketNode` fields, `parent`, optional `priority` field: Jira's, memory's), `PullRecord` (`pullNode` fields, `tickets` it names), `HistoryItem`, `EffectTable`; `ReviewThread.at?` (thread's time).
- `src/kit/tracker.ts` — abstract `BaseTracker`.
- `src/kit/forge.ts` — abstract `BaseForge`; per-item renderers out of `historyBrief`.
- `src/kit/docs.ts` — abstract `BaseDocs`; `artifacts.spec` stays `{ exists, hash, url }`.
- `src/kit/compose.ts` (new) — `compose()`; hook ids `project`, artifact `spec`.
- `src/kit/index.ts` — exports `compose`, new types.
- `src/testing/external-state.ts` — `MemoryTracker`, `MemoryForge`, `MemoryDocs`; `createExternalState` composes them.
- `src/testing/index.ts` — exports them.

## Done when

- `pnpm test` green; no test file using `createExternalState` changed.
- Duplicate effect type or brief key: `compose` throws; duplicate node id: `list`/`read` throw — each naming both roles.
- `nodes.close` over ticket and pull request closes each via own role.
- `MemoryTracker` subclass's added effect applies, then reconciles satisfied, via `compose`.
- Role check throwing: preflight error names role.
- `pnpm typecheck && pnpm lint && pnpm build` pass; `landrace validate .landrace` valid.