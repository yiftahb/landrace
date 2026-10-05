# Changelog

All notable changes to Landrace are recorded in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **A configurable item branch.** `branch` in `landrace.yaml` sets the branch each item's work is on, such as `lr-{item}` for CI that cannot take a `/` in a branch name. The default stays `landrace/{item}`. `{item}` is the tracker's id, unchanged. The GitHub, GitLab and in-memory forges tie a pull request to its item only by this branch. `validate` holds every workflow's stage `branch` and `branch.push` and `pull.*` effect to it, naming both. `validate` and `start` refuse a template that names `{item}` other than once, has no fixed text before it, names another placeholder, or that git would refuse. Change it only when no item has a pull request open: one on the old branch is no longer the item's. See [Configuration](docs/configuration.md#landraceyaml) and [Workflows](docs/workflows.md#the-items-branch).

## [1.2.1] - 2026-10-05

### Fixed

- **Jira's enhanced search.** `JiraField`'s preflight and `published()`, and the tracker's `jql` check, now work against Jira's enhanced search. It returns no `key` for `fields: ["id"]`, so the preflight found no open issue of any type and refused start, and the board lost its spec documents. It refuses `maxResults: 0`, so every `jql` refused start. Each search now asks for `key`, and the `jql` check for one issue.

## [1.2.0] - 2026-10-05

### Added

- **Steps load the project's instructions and skills.** Under Claude Code, every step and turn now loads its worktree's root `CLAUDE.md`, with the files it imports, and the skills under `.claude/skills`. Before, neither the read-only nor the write step's flags loaded them, so no step saw them and a retro's lessons reached no later step. Landrace checks the files and copies them outside the worktree, and Claude Code loads the copies. A file that leads outside the worktree is refused, naming it. So is a skill front-matter key that would change what the step may do (`hooks`, `allowed-tools`, `model`, `context`, `agent`, `mcpServers`). Any other key, such as the `scope` agsync writes, is dropped from the copy and logged as `claude.skill.key.dropped`. Nested `CLAUDE.md` files do not load. See [Integrations](docs/integrations.md#claude-code) and [Security](docs/security.md#a-steps-instructions-and-skills).
- **A step's own `skills`, `mcp` and `plugins`.** A step file can narrow what its step loads. `skills` lists the project skills it may load. `mcp` narrows `agent.mcp`, never widening it. `plugins` replaces `agent.plugins`. `validate` and `start` refuse a skill that no `.claude/skills/*/SKILL.md` defines, and a server or tool outside `agent.mcp`. Codex refuses a step that lists `skills` or `plugins`. See [Workflows](docs/workflows.md#step-files).
- **A write step's worktree gets your untracked files and an install.** `agent.worktree.copy` copies untracked or ignored files, such as `.npmrc` and `.env`, from your checkout by glob. `agent.worktree.setup` runs commands such as `pnpm install` in the worktree before the agent starts, outside its sandbox. It stops the item, with the command's output, when a command fails or outlasts `agent.worktree.setupTimeout` (15m). The worktree is kept between the item's write steps, so setup runs again only when its commands or its lockfiles change. The lockfiles are the three at the repository root, or the globs `agent.worktree.lockfiles` names, such as `backend/pnpm-lock.yaml` in a monorepo. See [Configuration](docs/configuration.md#a-write-steps-worktree) and [Security](docs/security.md#copied-files-and-setup).
- **One developer's Jira issues.** An optional `jiraAssignee` secret, an account id or an email, scopes every search the tracker runs to that account. Every issue Landrace creates is assigned to it. A project with more than 1,000 open issues can then be worked one developer at a time. An email is resolved once, at start, and one that matches no user, or several, refuses start. An issue reassigned to somebody else drops out of the list, which is the hand-off. See [Integrations](docs/integrations.md#jira).
- **A `jql` scope for Jira.** `new Jira({ project, jql: 'created >= "2026-10-05"' })` ANDs a clause into every search the tracker runs, beside `jiraAssignee`, and into `JiraField`'s listing, so a first start can leave a backlog alone. `start` runs the clause once and refuses one Jira cannot parse. See [Integrations](docs/integrations.md#jira).
- **The spec on the Jira ticket.** `JiraField` makes one multi-line issue field the docs role, so the spec lives where the team already reads and writes it. It shares the tracker's site, secrets and scope. Its preflight checks only the issue types an item can be, so a project's Epics do not refuse start. A type without the field is logged as `jira.field.missing`, and publishing a spec to an issue of that type refuses that item, naming the type. See [Integrations](docs/integrations.md#jira).
- **Jira's status follows the stage.** `statuses` maps a stage's `tracker.status` value to a Jira status, such as `{ build: "In Progress" }`. The issue moves through the transition into that status after the `lr:stage:*` label moves. The label stays the item's position. A transition the issue does not offer is logged as `jira.status.unoffered` and is not a halt.
- **Jira Service Management.** On a service desk project, every comment Landrace posts is internal. A `tracker.comment` route with `visibility: public` answers the requester. In a comment, `@[<account id>]` and `@[<email>]` mention a user. See [Integrations](docs/integrations.md#jira).
- **Worklogs, labels and titles from a step's answer.** Route fields name a field of the step's answer, and the engine reads it:
  - `tracker.worklog` logs the time the answer's `spentFrom` names, capped by `max`. With `skipIfLogged`, it logs nothing on an item that already has time logged.
  - `tracker.label` takes `addFrom`, with a required `allowed` list.
  - `tracker.create` takes `titleFrom` and `fieldsFrom`.

  An answer that is missing such a field fails the round as a broken contract. See [Workflows](docs/workflows.md#fields-from-the-answer).
- **A route with several effects.** A route takes `effects: [...]` in place of `effect`. They are applied in order, and each is satisfied on its own marker. A `from` names the answer field an effect's text comes from, so one round can post a public reply and an internal note. See [Workflows](docs/workflows.md#a-route-with-several-effects).
- **Filing an issue in another project.** `tracker.create` files a linked, unlabelled issue in another project of the tracker, such as an engineering bug raised from a support ticket. On Jira this is `createIn`, `createType` and `createLinkType`. `titleFrom` and `fieldsFrom` fill the issue's title and fields from the answer, and text and textarea fields are written in the shape each takes. Tested against a fake Jira only. See [Workflows](docs/workflows.md#effects) and [Integrations](docs/integrations.md#jira).
- **A stage that runs after close.** A stage marked `closed: run` may run its step once on a closed item the Done lane lists, such as a retro after a ticket is resolved. A closed item is claimed only by workflows that have such a stage, judged by the same `eligible`. `validate` refuses one that names a branch, pushes or opens a pull request. See [Workflows](docs/workflows.md#a-stage-that-runs-after-close).
- **Wait for an external reviewer.** Both forges take `reviewers: [{ status: "<name>" }]`, naming the status an AI reviewer such as CodeRabbit posts on the head: a commit status on GitLab, a check run or a commit status on GitHub. The pull request node gains `reviewPending`, which is `1` until every named reviewer has finished on the current head and is summable as `rel.implements.in.sum.reviewPending`. A named status is left out of the checks.
- **The pull request's title and description.** Both forges take `pull: { title, description }`. The title is formatted from `{item}` and `{title}`. The description is a template file under `.landrace/`, filled with `{item}`, `{link}` and `{spec}`. Both are set when the pull request opens and never rewritten. Any other placeholder is refused at start.

### Changed

- **Shipped step efforts.** `code-review` and `spec` run at `high`, and every other shipped step at `medium`, as does `agent.effort`. They were `xhigh`, `max` and `high`, and runs spent most of their time thinking. No shipped step asks for `max` now, so Codex runs every one.
- **Write steps load none of your own Claude settings.** They pass `--setting-sources ""` in place of `user`. So the plugins you enabled for yourself no longer run in `build`, `fix-review` or `retro`. A step gets `agent.plugins`, or its own `plugins`, instead. Your own `sandbox.*` settings no longer reach a write step either. See [Integrations](docs/integrations.md#claude-code).
- **Write steps follow the repository's commit rules.** The shipped `build`, `fix-review` and `retro` prompts tell the agent to find and follow the repository's commit conventions: a commitlint configuration, `commit-msg` hooks, a contributing guide. `retro: lessons from #N` is the retro's subject only when nothing says otherwise.
- **Markdown on Jira is rich text.** Comments and descriptions are written as ADF headings, lists, fenced code blocks with their language, inline code, bold, italic and links, not as one paragraph of raw Markdown. Reading turns the same set back into Markdown.

### Fixed

- **Worktrees start from `origin`'s default branch.** A new item branch, and a stage with no branch, start from `origin`'s default branch, fetched just before, not from your checkout's `HEAD`. A checkout you have not pulled, or one with another branch out, no longer gives steps stale or unrelated code. A fetch that fails fails the round. A repository with no `origin` remote keeps `HEAD`. See [Workflows](docs/workflows.md#the-items-branch).
- **GitLab checks settle on merged results pipelines.** A merged results pipeline runs at a merge commit. It now counts when the head is one of that commit's parents, so `ciPending` no longer stays `1` for ever on a project that uses them.
- **GitLab checks combine every pipeline on the merge request's head.** The pipeline GitLab makes of tools' commit statuses, a scanner's or an AI reviewer's, no longer stands in for the head's other pipelines by being the newest: it counts beside them. Any failed pipeline means `failure`, any still running means `pending`, and a page of 100 that the head's pipelines fill never reads `success`. The CI failures a prompt reads list the failed jobs and failed commit statuses of every pipeline on the head. Tools' commit statuses count as CI unless the new `reviewers` option names them.
- **Jira's `childType` is checked only where children are made.** The preflight checks it only when a loaded workflow has a step declaring `items:create`. A project that names its sub-task type `Sub-task`, or has none, now starts. A preflight's context carries `capabilities`, what the loaded steps declare.

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

[Unreleased]: https://github.com/yiftahb/landrace/compare/v1.2.1...HEAD
[1.2.1]: https://github.com/yiftahb/landrace/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/yiftahb/landrace/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/yiftahb/landrace/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/yiftahb/landrace/releases/tag/v1.0.0
