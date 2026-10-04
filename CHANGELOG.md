# Changelog

All notable changes to Landrace are recorded in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **A `jql` scope for Jira.** `new Jira({ project, jql: 'created >= "2026-10-05"' })` ANDs a clause into every search the tracker runs and into `JiraField`'s listing, beside `jiraAssignee`, so a first start can leave a backlog alone. `start` runs it once and refuses a clause Jira cannot parse. See [Integrations](docs/integrations.md#jira).
- **A write step's worktree gets your untracked files and an install.** `agent.worktree.copy` copies untracked or ignored files, such as `.npmrc` and `.env`, from your checkout by glob; `agent.worktree.setup` runs commands such as `pnpm install` in the worktree before the agent, outside its sandbox, and stops the item with the command's output when one fails or outlasts `agent.worktree.setupTimeout` (15m). The worktree is kept between the item's write steps, so setup runs again only when its commands or its lockfiles change. See [Configuration](docs/configuration.md#a-write-steps-worktree) and [Security](docs/security.md#copied-files-and-setup).
- **Wait for an external reviewer.** Both forges take `reviewers: [{ status: "<name>" }]`, the status an AI reviewer such as CodeRabbit posts on the head: a commit status on GitLab, a check run or a commit status on GitHub. The pull request node gains `reviewPending`, `1` until every named reviewer has finished on the current head, summable as `rel.implements.in.sum.reviewPending`. A named status is left out of the checks.
- **The pull request's title and description.** Both forges take `pull: { title, description }`: a title formatted from `{item}` and `{title}`, and a template file under `.landrace/` filled with `{item}`, `{link}` and `{spec}`. Set when the pull request opens and never rewritten. Another placeholder is refused at start.

### Fixed

- **`JiraField`'s preflight checks only the issue types an item can be.** It checks the types of the open issues in the tracker's scope, and the tracker's `issueType` and `childType`, so a project's Epics no longer refuse start. A type without the field is logged as `jira.field.missing`; publishing a spec to an issue of that type refuses that item, naming the type.
- **Jira's `childType` is checked only where children are made.** The preflight checks it only when a loaded workflow has a step declaring `items:create`, so a project that names its sub-task type `Sub-task`, or has none, starts. A preflight's context now carries `capabilities`, what the loaded steps declare.
- **Setup runs again when a nested lockfile changes.** `agent.worktree.lockfiles` takes globs, from the repository root, of the lockfiles that decide when `setup` runs again in a kept worktree, such as `backend/pnpm-lock.yaml` in a monorepo. The default stays the three root lockfiles. See [Configuration](docs/configuration.md#a-write-steps-worktree).
- **A skill's inert front-matter key no longer refuses its step.** A key Claude Code does not act on, such as the `scope` agsync writes, is dropped from the copy that loads and logged as `claude.skill.key.dropped`. `hooks`, `allowed-tools`, `model`, `context`, `agent` and `mcpServers` are still refused, by name.
- **GitLab checks combine every pipeline on the merge request's head.** The pipeline GitLab makes of tools' commit statuses — a scanner's, an AI reviewer's — no longer stands in for the head's other pipelines by being the newest: it counts beside them. Any failed pipeline is `failure`, any still running is `pending`, and a page of 100 the head's pipelines fill never reads `success`. The CI failures a prompt reads list the failed jobs and failed commit statuses of every pipeline on the head. Tools' commit statuses count as CI unless the new `reviewers` option names them.

## [1.1.0] - 2026-10-03

### Added

- **Install with `npm i -g landrace`.** A hook's `landrace`, `landrace/hooks`, `landrace/kit`, `landrace/testing` and `landrace/integrations/<vendor>` imports now resolve to the copy of Landrace that is running, so a project needs no `node_modules` for its hooks, and one process never loads a second landrace from the project's own. A hook that imports an export an installed copy lacks says to update Landrace rather than rebuild it.
- **Pairing in the README.** A key concept of its own: working a step together with the agent in your terminal, from the board or with `landrace_pair`.

### Changed

- **`landrace update` updates the copy that is running.** The project's dependency only when the project's own `node_modules/landrace` is the copy running; the global install otherwise, even when the project's `package.json` lists `landrace`.
- **The README's quick start installs Landrace globally** and drops `npx`.

## [1.0.0] - 2026-10-03

### Added

- **The decision engine.** A pure core that derives an item's whole state from its tracker on every run, with no database, and routes each step's output through explicit rules in a workflow file; ambiguity halts the item instead of being resolved by order. `landrace validate` proves a workflow sound before it runs: every loop bounded by a counter, no dead ends, no item two stages' identities both place, no field nothing provides.
- **The CLI.** `landrace start` polls the tracker and works items with per-item locks, `status` says where each item is and why, `validate` checks a workspace, `next` gives the decision for a snapshot with no I/O, and `mcp` serves operator tools over stdio: list, create, update and relate items, reply, ask, resolve, pair, and send an item back to a step.
- **The full-cycle workflow.** From an item to a merged pull request through a spec a person approves, a build, publishing the branch and its pull request, an agent's code review and fix rounds over the review threads, and a person's review and merge. One judge reads every reply, a person can send an item back to any step its stage lists, a retro learns from an item that had to be corrected, and a spec can be written together with Claude Code in a pairing.
- **Workspaces with several workflows.** A workspace holds `.landrace/workflows/<id>/`, each with a name, a description and the labels it admits, and one `landrace start` runs them all. Each open item is claimed by exactly one workflow; two claims, or one id from two sources, halt and name both, and `validate` reports, and `start` refuses, workflows whose claims certainly overlap. A step file can extend another, section by section.
- **The fastlane workflow.** For a change small enough to need no spec: an item labelled `lr:auto` and `lr:fast` goes from its own text to a merged pull request with no person, unless it halts, a cap is reached, or the change touches a protected path, which a person must merge.
- **Forge CI and a guarded merge.** A pull request's checks are read on its head, and a failed check's log is briefed to the build. `pull.merge` merges only on green checks, only at the head the review read (`reviewedBy`), and never a change to a protected path (`refuse`). Only an item's own `landrace/{item}` pull request counts as its work.
- **Item relationships and the waiting gate.** Items are related as `blocked-by`, read and written as issue dependencies on GitHub and as "Blocks" links on Jira, and through the MCP tools on create and update. Both shipped workflows wait for an item's blockers before building, and send it to a person when a blocker was dropped, cannot be read, or is on a cycle.
- **Splitting work into sub-items.** A step declaring `items:create` gets one bound tool to file children under its item, which can be ordered by `blocked-by`; a re-run closes the children it no longer files.
- **The board.** `landrace start` serves a triage page on loopback: a Needs You home across every workflow and a page per workflow, each item's tree of sub-items, pull requests and specs in lanes, and a panel per item with its activity, conversation, relationships and replies. Retry, "Go to step…", "Clear & retry", Refresh and every other write the page offers are guarded against other origins; a Chat menu opens the item in Claude Code, Cursor or Codex; browser notifications say when an item needs you.
- **The integration kit and its integrations.** `landrace/kit` holds what every integration shares: `BaseExecutor` for coding agents, and `BaseTracker`, `BaseForge`, `BaseDocs` and `compose()` for trackers, forges and docs sites. Landrace ships Claude Code and Codex as coding agents, GitHub as tracker, forge and docs (GitHub Pages), GitLab as a forge, Jira as a tracker, Notion as docs, and Slack as a notifier. `landrace/testing` drives a workflow over an in-memory tracker, forge and docs.
- **Security.** Every step that can act, and every typed conversation turn, is screened before it runs; a refusal stops the item in Screened for a person to read and clear. A step's declared capabilities are enforced on its worktree, a write step's commands run in the agent's OS sandbox, writing only to its worktree and the repository's git directory and reaching only the hosts `agent.sandbox` allows, the agent never holds the tracker's token, and text Landrace did not write is escaped so it cannot forge control state.
- **Versions and updates.** `landrace version` (and `--version`) prints the version and whether npm has a newer one; `landrace update` updates the project's own dependency with its package manager, or the global install; `landrace start` says when a newer version is out. The check asks npm's registry once, gives up after two seconds, and is off in CI or with `LANDRACE_NO_UPDATE_CHECK=1`.
- **Notifications and telemetry.** A `notify` block tells a person, through a notifier hook, when an item comes to rest needing them. `--telemetry` exports the engine's events as OpenTelemetry log records.

[Unreleased]: https://github.com/yiftahb/landrace/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/yiftahb/landrace/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/yiftahb/landrace/releases/tag/v1.0.0
