## Problem
`.landrace/hooks/github.ts`: 2,958 lines; ~650 code lines not GitHub — records, `satisfied()` rules, thread turns, briefs, local-git push, spec hash. Jira, GitLab, Notion hooks would copy them.

## Decisions
1. Operator sees no change, bar diff brief's no-patch line: "too large for the forge to show".
2. Hook author imports tracker, forge, docs, git helpers from `landrace/kit`.

- Mixed functions split, not rewritten: neutral half → kit over plain neutral shapes; GitHub half maps its API answers, calls it, so no forge fakes GitHub's shapes.
- `hookRepository` moves as `repositoryOf(file)`; V8 frame lookup stays in hook. Moved whole, frame names kit's file: linked landrace reads wrong repository.
- Push splits, auth stays GitHub's: kit `originPushUrl`, `pushBranch` run git; hook checks URL, adds token header, redaction. Refusal order unchanged.
- Kit never logs; `github.*` events, GitHub-worded text stay in hook: tests pin them, `tests/boundaries.test.ts` bans `github` in `src/`.
- Per-effect `satisfied` functions; hook's switch dispatches. Classes wait for 1b.
- New kit files import only `#conventions.js`, `#namespace.js`, `node:*` and each other (forge reads git's heads).

## Technical design
- `src/namespace.ts` — kit types `Git`, `BranchHeads`, `SnapshotComment`, `ThreadComment`, `ReviewThread`, `ThreadCounts`, `Finding`, `Reply`, `ChangedFile`.
- `src/kit/tracker.ts` (new) — `commentsOf`, `wroteIt`, `botLoginOf`, `labelSatisfied`, `statusSatisfied`, `commentSatisfied`, `closeSatisfied`, `nodesCloseSatisfied`, `priorityFromLabels`, `createdAtOf`, `ticketNode`, `ISSUE_PAGE`, `MAX_ISSUE_PAGES`, `THREAD_PAGE`, `MAX_THREAD_PAGES`, `TICKET_PAGE`, `DONE_WINDOW_MS`, `MAX_COMMENT_CHARS`.
- `src/kit/forge.ts` (new) — `answered`, `threadCounts`, `FINDING_KIND`, `FIX_KIND`, `isFinding`, `isReply`, `commentableLines`, `placeFindings`, `prBranch`, `ticketOfBranch`, `pullNode`, `BRIEF_*`, `cut`, `where`, `newest`, `threadsBrief`, `diffBrief`, `historyBrief`, `pushSatisfied`.
- `src/kit/git.ts` (new) — `gitIn`, `repositoryOf`, `ownGit`, `branchHeads`, `headsOf`, `headIn`, `nothingCommitted`, `PUSH_TIMEOUT_MS`, `originPushUrl`, `pushBranch`.
- `src/kit/docs.ts` (new) — `SPEC`, `PUBLISH`, `hashOf`, `contentOf`, `mine`, `NO_SPEC`, `briefPage`, `publishSatisfied`, `specNode`.
- `src/kit/index.ts` (new) — re-exports `src/kit/executor.ts`, four files, their types.
- `tsup.config.ts` — `kit` entry → `src/kit/index.ts`.
- `tsconfig.json` — `landrace/kit` path → `./src/kit/index.ts`.
- `.landrace/hooks/github.ts` — keeps client, queries, shapes, mappers, URL checks, paging, logging, zero-arg `hookRepository()`; re-exports `gitIn`, type `Git`.
- `tests/kit/{tracker,forge,docs,git}.test.ts` (new) — direct tests.
- `.agsync/instructions.md`, `README.md` — kit also holds shared tracker, forge, docs code.
- `AGENTS.md` — `agsync sync`.

## Done when
- `pnpm typecheck && pnpm lint && pnpm test && pnpm build` pass.
- `git diff origin/main -- tests ':!tests/kit'` empty.
- `landrace validate .landrace` valid.
- `.landrace/hooks/github.ts` ~650 code lines shorter than on `origin/main`.
- Each moved function no existing test calls directly: one direct test in `tests/kit/`.
- `agsync sync` leaves `AGENTS.md` unchanged.