I've revised the spec for #241 for your second rework request on PR #242. One rule changes and everything else stays as built.

I couldn't open the PR branch's code: this worktree is on `main`, and no checkout of `landrace/241` is indexed. So the revision builds on `main`'s `src/agent/worktree.ts` and on the built design as the conversation describes it.

- **The change:** on Linux, `<common>/config.worktree` is now handled like `<common>/hooks` and `<common>/info`. When it is missing before a write run, the engine makes it empty, and from then on the sandbox denies it. Content already there is not judged. This is what halted every GitHub Actions checkout in CI.
- **What is still checked:** admin folders keep their `config.worktree` content check. The Linux refusal of `extensions.worktreeConfig` on, and the refusal of a missing `<common>/config`, both stay.
- **The trade-off:** a `config.worktree` planted before this ships, with its record lost, can't be found. It does nothing while `extensions.worktreeConfig` is off. It would take effect if someone turns that extension on later. `docs/security.md` and the CHANGELOG list it under the known limit.

## Problem
A refusal record is the only trace of a planted git control path. Lose it, and the next run denies the path but never judges it again. On Linux a step may also move a folder holding denied paths and rebuild it (`.git` under `isolation: none`, `<common>/worktrees/<name>` in a worktree). Some engine git calls run unpinned. Round 1 refused a non-empty `<common>/config.worktree`, but git makes one itself: `git sparse-checkout disable`, which actions/checkout@v4 runs, writes one. So every GitHub Actions checkout halted (CI run 42580129994).

## Decisions
- Flow: a Linux write run plants a path and its record is lost. The next write run halts, names the path and says "a step that may write could have put it there. Remove it and the item carries on". The person removes it, and the item carries on.
- Flow: on Linux, `agent.isolation: none` with a step that may write is refused by `landrace start` and by `landrace mcp` at startup. Converge and conversation turns also refuse a configured `none`. The harness has no such configuration and still runs.
- Changed this round: when `<common>/config.worktree` is missing on Linux, it is made empty, the same as `<common>/hooks` and `<common>/info`. Once it exists it is denied. Content already there belongs to the operator or a tool and is not judged. Reason: git writes it itself, and "remove it" is the wrong fix to give people. An empty one sets nothing whether the extension is on or off (verified in #232).
- If making a missing path fails, the run is refused and the reason names the path.
- Unchanged: a missing `<common>/config` is refused on Linux, and so is `extensions.worktreeConfig` on.
- `<common>/commondir` is already durable through `commonDirIntact`.
- Every admin folder is judged by content before and after each Linux write run, the way `worktreeIntact` judges one. Its `config.worktree` keeps the content check. A folder that is gone when read is not judged.
- `isolation: none` is refused rather than compared by dev/inode. The inode record lives in one run's memory and can be lost.
- Every listed unpinned call is pinned. None of them runs only before steps.
- Limit: a path in `hooks/`, `info/` or `config.worktree` planted before this ships, with its record lost, can't be detected. `docs/security.md` and `CHANGELOG.md` say so.

## Technical design
- `src/namespace.ts`: required `ControlPaths.commons: string[]`, the common directories whose admin folders are judged after the run. Linux only, empty elsewhere.
- `src/agent/worktree.ts`: on Linux, `gitControlPaths` makes `hooks`, `info` and `config.worktree` empty when missing, without overwriting. It drops the `<common>/config.worktree` content refusal and keeps the missing-`config` refusal. `adminFolderProblems(common): Promise<string[]>`: `commondir` resolves to `common`, there is no `config`, `hooks` or `info`, and `config.worktree` is empty. `plantedControlPaths(controls: ControlPaths)` also judges `commons`. `noneWriteRefusal(platform): string | null`.
- `src/runner/step.ts`, `src/runner/pair.ts`, `src/runner/converge.ts`, `src/mcp/conversation.ts`: pass `controls` whole and the configured `agent.isolation`.
- `src/cli/start.ts`, `src/cli/mcp.ts`: the startup refusal, through `noneWriteRefusal`.
- `src/kit/git.ts`: `pinnedCommonDir(dir): { GIT_COMMON_DIR?: string }`. It returns `{}` outside a repository and throws `CommonDirRefused`. `repositoryOf` uses it.
- `src/kit/executor.ts`: `repositoryRoot` uses `pinnedCommonDir`.
- `src/cli/init.ts`, `src/cli/validate.ts`: `check-ignore` is pinned. A `CommonDirRefused` is reported, never read as "not ignored".
- `docs/security.md`, `CHANGELOG.md`: the rules above and the wider limit.

## Done when
- Linux, through the callers: a repository left the way actions/checkout leaves it (`git sparse-checkout disable`, then `git config --unset-all extensions.worktreeConfig`) passes a write run.
- Linux: missing `<common>/hooks`, `<common>/info` and `<common>/config.worktree` exist empty before the run, in `deny` and not in `absent`.
- Linux: an existing non-empty `<common>/config.worktree` passes and is not rewritten.
- Linux: if a missing control path can't be made, the run is refused and the path is named.
- Linux: a missing `<common>/config`, or `extensions.worktreeConfig` on, refuses the write run.
- An admin folder rebuilt with `commondir` pointing elsewhere is refused after the run, and refused again before the next run if its record was lost.
- The same holds for `config`, `hooks` or `info` made in an admin folder, and for an admin `config.worktree` with content.
- A folder whose `git worktree add` is still under way passes. A folder removed partway through the check passes.
- Linux: `isolation: none` with a write step is refused by `start`, `mcp`, converge and a conversation turn. The harness runs. macOS runs.
- `repositoryOf`, executor `repositoryRoot`, `init` and `validate` refuse a planted `<common>/commondir` and pass `GIT_COMMON_DIR`.
- The previously failing suites pass with the platform forced to linux, in a clone prepared the way actions/checkout leaves it. CI on Linux passes.
- macOS listings are unchanged.

// Generated by AI (claude-opus-5-5:high)