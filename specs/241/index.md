I've written the spec for #241 below. It is a design only: nothing is built or tested yet. All three of the item's open points are settled in it, so there are no questions back.

- **Making a planted path's trace durable:** no new record is kept. On Linux the engine creates the git directories that were missing, so nothing can be planted in them. Everything else is judged again from the repository itself before each write run, so losing a record no longer hides anything.
- **The renamed `.git` on Linux:** I chose to refuse write steps under `isolation: none` on Linux, not the review's dev/inode comparison. The comparison only lives in one run's memory, so a lost record would again leave the remade `.git` trusted. The refusal comes from the configuration and can't be lost. It does remove `isolation: none` write steps for Linux users. It is tested by passing the platform in, so no Linux machine is needed.
- **Beyond the item:** inside a worktree, a Linux step can also rename and remake a worktree's admin folder (`.git/worktrees/<name>`), including the operator's own linked worktree. The spec adds a content check for these, since git fully decides what an admin folder holds.
- **Limit:** a path planted in `hooks/` or `info/` before this ships, whose record was lost, still can't be found. The spec says so in `docs/security.md`.

## Problem
A refusal record is the only trace of a planted git control path. If writing it fails, the next run lists the path as existing: it is denied, never judged again. This matters most for `<common>/config.worktree`, and for `hooks/` and `info/` that were missing at start. On Linux, a step may move a directory that contains denied paths and rebuild it: `.git` under `isolation: none`, or `<common>/worktrees` and its folders under a worktree. The bwrap binds move with it. Some engine git calls also run unpinned.

## Decisions
- Flow: a Linux write run plants a path and its record is lost. The next write run in that repository halts and names the path, with "a step that may write could have put it there. Remove it and the item carries on". The person removes it, and the item carries on.
- Flow: on Linux, `agent.isolation: none` with any step that may write is refused by `landrace start` before the first tick. Each such run or turn is refused too.
- `<common>/hooks` and `<common>/info` are made empty when missing, before each Linux listing. Once they exist they are denied, so nothing can be planted there. `git init` makes both, and empty changes nothing. The operator's own hooks are never judged.
- `<common>/config.worktree` holding anything is refused before each Linux write run. Linux already requires `extensions.worktreeConfig` off, so anything there is either planted or left over.
- A missing `<common>/config` is refused on Linux, because `git init` always makes one.
- `<common>/commondir` is already durable through `commonDirIntact`.
- Every admin folder is judged by content before and after each Linux write run, the way `worktreeIntact` judges one. Git decides what an admin folder holds, so a rebuilt one is caught however many records are lost.
- `isolation: none` is refused rather than compared by dev/inode. The inode comparison lives in one run's memory, so a lost record would trust the rebuilt `.git`. The refusal comes from configuration.
- Every listed unpinned call gets pinned. None of them runs only before steps: the forge's first git can come after a run, and `landrace mcp`, `validate` and `init` run at any time.
- Limit: a `hooks/` or `info/` path planted before this ships, with its record lost, is undetectable. `docs/security.md` says so.

## Technical design
- `src/namespace.ts`: required `ControlPaths.commons: string[]`, the common directories whose admin folders are judged after the run. Linux only, empty elsewhere.
- `src/agent/worktree.ts`: on Linux, `gitControlPaths` makes the empty folders, makes the `config` and `config.worktree` refusals, and runs `adminFolderProblems`. New `adminFolderProblems(common): Promise<string[]>`: for each folder under `<common>/worktrees`, `commondir` resolves to `common` where it exists, `config`, `hooks` and `info` are absent, and `config.worktree` holds nothing. `plantedControlPaths(controls: ControlPaths)` also judges `commons`. New `noneWriteRefusal(platform): string | null`, which `checkoutControlPaths` throws on Linux.
- `src/runner/step.ts`, `src/runner/pair.ts`, `src/mcp/conversation.ts`: pass `controls` whole.
- `src/cli/start.ts`: the startup refusal, through `noneWriteRefusal`.
- `src/kit/git.ts`: new `pinnedCommonDir(dir): { GIT_COMMON_DIR?: string }`. It pins `gitCommonDir`, returns `{}` outside a repository and throws `CommonDirRefused`. `repositoryOf` uses it.
- `src/kit/executor.ts`: `repositoryRoot` uses `pinnedCommonDir`.
- `src/cli/init.ts`, `src/cli/validate.ts`: `check-ignore` is pinned. A `CommonDirRefused` is reported, never read as "not ignored".
- `docs/security.md`: the rules above, and the limit.

## Done when
- On Linux, a planted `<common>/config.worktree` with no record halts the next write run, naming it.
- On Linux, missing `<common>/hooks` and `<common>/info` exist empty before the run and are in `deny`, never in `absent`.
- On Linux, a missing `<common>/config` refuses the write run.
- An admin folder rebuilt with `commondir` pointing elsewhere is refused after the run. With the record lost, it is refused again before the next run.
- Same for `config`, `hooks` or `info` made in an admin folder, and for `config.worktree` with content.
- A folder whose `git worktree add` is under way, with no `commondir` yet, passes.
- On Linux, `isolation: none` with a write step is refused by `start`, by converge and by a conversation turn. macOS runs.
- `repositoryOf`, executor `repositoryRoot`, `init` and `validate` refuse a planted `<common>/commondir` and pass `GIT_COMMON_DIR`.
- macOS listings are unchanged.

// Generated by AI (claude-opus-5-5:high)