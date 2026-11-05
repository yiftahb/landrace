I've written the spec for #206. I settled all three of the item's open points from the code, so the spec carries no questions. The one exception is Codex, which needs a live run.

- **Push URL rewriting:** no push change is needed. The forge hands its token only to the URL `originPushUrl` reads after git applies its URL rewrites, and the token header is scoped to that exact URL. A test pins this.
- **Hooks planted before the upgrade:** no `validate` check. A check that flags the operator's own legitimate hooks gets switched off. `docs/security.md` gives the commands to inspect once instead.
- **Filters:** I chose this myself. The engine doesn't override filter settings; denying writes to `config` is what closes that route. Overriding them would break `git lfs install --local`. So the test for that vector checks the deny list, not the engine's git.

Two things you should know:
- **Codex's write steps may stop running.** If a live run shows Codex's sandbox can write any of the git control paths, it can't keep the deny list and refuses every write run. The item decided that; I couldn't check it without a shell.
- **`docs/security.md:41` is already wrong.** It says writes never land in `.git/hooks` or `.git/config`. The spec corrects it.

## Problem
A write step can write the shared `.git` and its worktree's `.git` file. The engine then runs git outside the sandbox, with its whole environment. A planted hook, `core.hooksPath`, `core.fsmonitor`, filter, rewritten `.git` file or rewritten `commondir` runs step code on the engine's `checkout`/`status`/`worktree add`, and on the operator's own `git pull`. Reproduced on git 2.50.1.

## Decisions
- On success, a person sees nothing new. An agent that can't keep the write-deny list gets its run refused, naming the paths, the way `deniedNow` refuses.
- The engine computes the list, not the agent. Only the engine knows the main repo, and the worktree's `.git` file is untrusted.
- The list is merged whatever `agent.sandbox.deny` says, because a written `deny` replaces the defaults.
- `keepsDenyWrite` defaults to false, which means refuse. Fail closed for an integration unaware of the list.
- Codex declares it only if a live run shows `workspace-write` leaves every listed path unwritable.
- A worktree's admin folder is the one `<common>/worktrees/*/gitdir` naming `<worktree>/.git`. None or two halts, naming them. No first match.
- Filters are closed by the deny list alone. Overriding repository-scope `filter.*` would break `git lfs install --local`.
- Push rewriting: no change. The token is scoped to the URL `originPushUrl` reads after rewrites. A test pins it.
- Planted before upgrade: no `validate` check, since it would flag the operator's own hooks and get switched off. `docs/security.md` gives the inspection commands.

## Technical design
- `src/conventions.ts` — `GIT_GUARD_ARGS`: `-c core.hooksPath=/dev/null -c core.fsmonitor=false`.
- `src/agent/worktree.ts` — every git spawn prepends `GIT_GUARD_ARGS`.
  - `gitDirsOf(path, repoRoot): Promise<{ GIT_DIR, GIT_COMMON_DIR, GIT_WORK_TREE }>`, re-derived each call, set on every call run in a worktree.
  - `worktreeHead(path, repoRoot)` and `worktreeState(path, repoRoot)` now take `repoRoot`.
  - `gitControlPaths(path, repoRoot): Promise<string[]>` returns `<common>/config`, `<common>/hooks`, `<common>/info`, each `<common>/worktrees/*/{config.worktree,commondir,gitdir}`, and `<path>/.git`. Absent paths are listed too.
- `src/kit/git.ts` — `gitIn` prepends `GIT_GUARD_ARGS`. Its error names the subcommand.
- `src/namespace.ts`:
  - `Executor.run` opts gain `denyWrite?: readonly string[]`.
  - `RunPlan` gains `denyWrite: readonly string[]`, empty unless tier `write`.
- `src/kit/executor.ts` — `protected readonly keepsDenyWrite = false`.
  - A write run with a non-empty list on an integration that leaves it false is refused.
  - A path with `(`, `)` or a control character is refused, as `deniedNow` does.
- `src/runner/step.ts`, `src/runner/pair.ts`, `src/mcp/conversation.ts` — pass `gitControlPaths(cwd, root)` on every worktree run, and `root` to `worktreeHead` and `worktreeState`.
- `integrations/claude/index.ts` — `keepsDenyWrite = true`. Each path goes into `sandbox.filesystem.denyWrite` and into `Edit(//<path>)` and `Edit(//<path>/**)` rules.
- `integrations/codex/index.ts` — `keepsDenyWrite` set from the live check.
- `scripts/claude-check.mjs` — a write step tries each path, then commits.
- `docs/security.md` — what a step may write in git, line 41 corrected, the inspection commands.
- `docs/hooks.md` — `keepsDenyWrite`.
- `docs/integrations.md` — the Codex result.

## Done when
- Real git, with a hook, `core.hooksPath`, `core.fsmonitor`, a rewritten `.git` file and a rewritten `commondir` each planted: `ensureWorktree` (reuse, rebuild, kept slot), `releaseWorktree`, `removeWorktree`, `worktreeHead`, `worktreeState`, `prepareWorktree`, `branchHeads`, `fetchBranch` and `pushBranch` leave no marker file.
- Every write run's `denyWrite` holds each listed path, including `.git/info/attributes` and `.git/config`, under `agent.sandbox.deny` unset, `[]` and written.
- Two admin folders naming one worktree: engine git halts naming both. None: halts naming the worktree.
- An integration without `keepsDenyWrite` has its write run refused, naming the paths. A read run is unaffected.
- The Claude write-run argv carries each path in `denyWrite` and as `Edit` rules.
- Live `scripts/claude-check.mjs`: each write is refused, and the commit still succeeds.
- With `url.<other>.insteadOf` planted, the GitHub forge hands no token to the other host.
- `docs/security.md` says what a step may and may not write in git.

// Generated by AI (claude-opus-5-5:high)