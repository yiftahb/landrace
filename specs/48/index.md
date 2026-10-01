## Problem

No GitLab forge. Project on GitLab has nothing for `compose({ forge })`: merge requests never open, findings never thread, review never gates on counts.

## Decisions

1. Hook file: `forge: new GitLab({ project: "group/app" })`; `landrace.yaml`: `gitlabToken` in `secrets:`, `log.redact`; optional `gitlabBaseUrl`; host in `agent.sandbox.hosts`.
2. `landrace start` refuses token lacking `api` scope or project access, naming which.
3. Publish pushes `landrace/{ticket}`, opens merge request `pr-{iid}`; findings land as diff discussions.

- `reply`/`resolve` get discussion id, URLs need iid → `threads(pull)` records id→iid, base reads threads first; unknown id errors.
- Review prose: plain note, never counted. `reviews`: our login's notes only — pasted marker cannot skip round.
- Thread: resolvable discussion only; system, individual notes never resolve.
- Context line needs `old_line` beside `new_line` — GitLab refuses otherwise; off-hunk finding: `position_type: file`.
- Fork merge request: `branch` undefined, excluded from `pullsNaming` — name not ours.
- Past kit paging bounds: refuse, never short count.
- `openPull` 409 "already exists" = done: crash retry.
- `gitlabBaseUrl`: `https://host[:port]` only; token never cleartext.
- Push as GitHub's: basic `oauth2:<token>` extraheader only for push URL string-equal `{gitlabBaseUrl}/{project}`(`.git`).
- git in constructing file's repository, as `GitHubForge`.

## Technical design

- `integrations/gitlab/client.ts` (new) — `createClient`: REST over `fetch`, paging, cached `login`; `clientFor`: one per config.
- `integrations/gitlab/forge.ts` (new) — `GitLabOptions` (`project`, `git`, `fetchImpl`); `GitLab extends BaseForge`: abstract methods, `check`.
- `integrations/gitlab/index.ts` (new) — exports both.
- `tests/integrations/gitlab/fake-gitlab.ts` (new) — in-memory GitLab `fetchImpl` (sandbox cannot bind loopback): 409 duplicate, 400 bad position.
- `tests/integrations/gitlab/gitlab.test.ts` (new) — every method, `check`, push, `compose` end to end.
- `scripts/gitlab-check.mjs` (new) — `GITLAB_TOKEN`, `GITLAB_PROJECT`, `GITLAB_BASE_URL`; throwaway branch `landrace/{n}` appends `README.md` line — findings on added and context line; deleted in `finally`.
- `README.md` — `#### GitLab` in "`.landrace/hooks/*.ts` — the integrations": hook file, secrets, token (`api`, Developer), sandbox host, check script.

## Done when

- Test via `compose`: merge request opened; findings on commentable lines, off-hunk on file; reply; resolve; `openThreads`/`awaitingFix` 1/1 → 1/0 → 0/0; closed with open thread 0/0.
- `check` refusals name scope, project, missing secret.
- Push: header only for exact URL; errors never hold token or base64.
- Diff touches only `integrations/gitlab/`, `tests/integrations/gitlab/`, `scripts/gitlab-check.mjs`, `README.md`.
- `pnpm typecheck && pnpm lint && pnpm test && pnpm build` pass; `landrace validate .landrace` valid.
- `gitlab-check.mjs` without `GITLAB_TOKEN` exits non-zero; live run prints each check, exits 0.