## Problem

`.landrace/hooks/github.ts`: 2,339 lines — client, tracker, forge, docs — beside #41's bases, not on them.
Case: no `landrace/integrations/github`; project wanting GitHub copies file.
Prompts name `{brief.github.*}`; composed hooks brief `{brief.project.*}`.

## Decisions

1. Review: operator runs `pnpm build && pnpm parity` with `GITHUB_TOKEN` — sees `equal`, or each differing node and edge and exit 1.
2. Merge, restart engine: board, labels, comments, pull requests, pages unchanged.
3. Prompts: history one timeline, oldest first, comments and threads interleaved.

- One client per `ctx.config` (`clientFor`: `tracker.repo`, `githubToken`, `tracker.bot`): three roles, one `GET /user`. Tests hand all three one `client`.
- `GitHubForge` runs git in repository of file constructing it, `git` overriding: hook file stays `compose`; never cwd.
- `closingRefs` off: no `Closes #n` body, no closing references read — merge must not close unrelated issue.
- `threads` sets `at` from opening comment's `createdAt`, placing threads in timeline.
- Base's one `threads` serves counts and briefs: one `LandraceThreads` query, brief's fields; graph still carries counts only.
- Forge keeps `LandraceTicket` (head, closing references) — pinned names hold; tracker: `LandraceIssue` gains `parent`, new `LandraceSubIssues`.
- Inherited from bases, not undone: leaf `read` costs 3 GraphQL calls before thread counts, not ticket's 2; child's `read` carries parent's pull requests; `comments` reads every page.
- Expectation edits these force, beside ticket's three: events `forge.review.*`, `docs.skipped`; `GRAPHQL_QUERIES` names; brief-cost test (`LandraceBrief`); sibling imports in `tests/boundaries.test.ts`; `hookRepository` test. Rename covers hook ids, `specArtifact` → `spec`.

## Technical design

- `integrations/github/client.ts` (new) — `createClient`, moved; `clientFor(ctx)`.
- `integrations/github/issues.ts` (new) — `GitHubIssues({ client })`: issue queries, `closedOf`, sub-issue link, `repo`-scope check.
- `integrations/github/forge.ts` (new) — `GitHubForge({ closingRefs, client, git })`: pull and thread queries, `pusher`, pull-request probe.
- `integrations/github/pages.ts` (new) — `GitHubPages({ client })`: `specLinks`, contents probes.
- `integrations/github/index.ts` (new) — three classes, `createClient`, `GRAPHQL_QUERIES`.
- `tsup.config.ts` — entry `integrations/github`.
- `package.json` — `parity` script.
- `.landrace/hooks/github.ts` — `compose` call.
- `scripts/github-parity.mjs` (new) — `main`'s hook via `git show`, beside ported; one ctx; `list()`, `read()` per listed ticket; graphs sorted, diffed.
- `tests/support/fake-tracker.ts` — `compose` over three roles, one client; answers new queries.
- `tests/hooks/github*.test.ts`, `tests/hooks/pages.test.ts` → `tests/integrations/github/`.
- `tests/boundaries.test.ts` — admits `./<file>.js` inside one integration.
- `.landrace/steps/{spec,code-review,fix-review,retro}.md`, `tests/fixtures/children/steps/fix-review.md`, `tests/workflow/shipped.test.ts`, `tests/runner/loop.test.ts`, `tests/esm/hook-import.test.ts`, `tests/hooks/provides.test.ts` — `project`.
- `tests/e2e/scenarios.test.ts` — `gitIn` from `landrace/kit`.
- `README.md`, `.agsync/instructions.md`, `AGENTS.md` — GitHub on bases, `{brief.project.*}`, one timeline.

## Done when

- Gate (`typecheck`, `lint`, `test`, `build`) passes.
- Expectation edits only: rename, moved paths, merged timeline, Decisions' forced list.
- `git diff main -- src` empty: bases untouched.
- `landrace validate .landrace` reports valid.
- `.landrace/hooks/github.ts`: imports and one `compose` export.
- `grep -rn 'brief\.github' .landrace tests README.md` prints nothing.
- `pnpm parity`, operator-run at review: `equal`, exit 0.