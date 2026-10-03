# Security

Landrace runs coding agents on your machine, over text that strangers can write, with credentials that can push to your repository. This page says what it trusts, what it does not, and the safeguards between the two.

## Threat model

**What Landrace treats as untrusted:**

- **Text on the tracker and the forge.** An item's title and body, its comments, review threads, and anything a pull request carries. Anyone who can comment on an issue can write text that reaches an agent's prompt.
- **Pull requests from anyone.** A fork's pull request, or one whose text merely says it closes an item.
- **What an agent does.** An agent reads that text, so it may be steered. A step that may write runs shell commands.
- **The repository's own files.** A workflow file, a step prompt or a hook is a file a pull request can edit, and a write step can commit one.
- **Other websites in your browser.** Your browser can reach the board on `127.0.0.1`.

**What Landrace trusts:** you, the operator, and your own configuration — `landrace.yaml`, `.env`, `.mcp.json`, your user-level agent settings. A reply on an item is read as a person's decision, but no reply can clear a security check.

**What it protects:** the tracker's token, your git and cloud credentials, your default branch, and your money — every agent run is paid for.

## Safeguards

- **The agent never holds the tracker's token.** Landrace performs every tracker and forge write — pull requests, comments, labels. A write step pushes its own branch with your git credentials, from inside a sandbox.
- **Capabilities are enforced, not trusted.** A step declares what it may do, and the declaration is enforced by comparing its worktree before and after the run — not by the flags an executor hands its agent, which another executor never sees. A conversation turn is held to the same declaration as the step it continues. An unenforceable capability refuses the step.
- **The core is pure.** `src/core/` does no I/O, reads no clock and draws no random numbers, enforced by lint and by test.
- **Conditions are allowlisted.** Condition operators are checked against a closed list before a condition reaches the evaluator; `$where` and `$regex` are refused at load.
- **Hooks stay inside the workspace.** A hook module must resolve inside `.landrace/`, both ends compared after `realpath`, before it is imported. The engine ships no integration, and `src/` contains no vendor code — a test fails on the offending file and line.
- **Landrace knows its own account.** A comment carries control state only because Landrace's own account wrote it. The account is resolved from the token at startup and checked against any configured override; the process refuses to run rather than guess, because a login it could not resolve would make its own records read as a stranger's.
- **A merge no person makes is held by the kit** — see [The merge gate](#the-merge-gate).

## A write step's sandbox

A step declaring `repo:write` runs shell commands. In this repository that is `build`, `fix-review` and `retro`: each merges `origin/main`, installs, runs the tests, commits, and pushes its own branch. The Claude Code integration runs every command such a step runs inside Claude Code's sandbox (Seatbelt on macOS, bubblewrap on Linux), configured by `agent.sandbox`:

```yaml
agent:
  sandbox:
    hosts: [github.com, registry.npmjs.org]   # the only network a write step reaches
    deny:  [~/.config/gh, ~/.ssh, ~/.aws, ~/.npmrc]
```

- **Writes** land only in the step's worktree and in the repository's shared `.git` — never in your checkout, your home, `.git/hooks` or `.git/config`.
- **Network** is confined for commands, not for every tool. The allowlist confines what the shell and anything it runs can reach to `hosts`: a host name, or the sandbox's own `*.example.com` wildcard, with no scheme, port or path. With no `hosts`, a write step's commands have no network at all, and cannot fetch or push. In-process tools such as WebFetch and WebSearch do not go through the sandbox; they follow Claude Code's own permission rules, which deny them under `-p` unless your settings allow them.
- **Reads** are refused under each `deny` path — by the sandbox for commands, and by a `Read` rule for the Read tool, which the sandbox does not cover. A path starts with `~/`. With no `deny`, the four paths above apply; a list you write replaces them, so keep the ones you still want.
- **No way out.** If the sandbox cannot start, the step is refused rather than run unconfined, and no command may ask to run outside it.
- **Strict keys.** `sandbox` takes `hosts` and `deny` and nothing else; a misspelt key is refused at startup.
- **Read-only steps and the screener** have no shell to confine.

What it does not do:

- **It pushes with your git credentials.** `git push` goes through your own credential helper, and a command in the sandbox can ask that helper for the credential (`git credential fill`) as readily as `git push` can. The tracker's token never reaches the agent; your git credential for the listed hosts does. Use one scoped to what a step may push.
- **Nothing but the prompt keeps a step to its own branch.** With that credential and the host, `git push` can reach any branch on `origin`, and because the shared `.git` is writable, `git update-ref` can move any local branch. **Protect `main` on the forge before you run write steps** — on GitHub, a branch protection rule that refuses direct pushes.
- **Your own user settings still load.** A write step loads your user-level Claude settings (`--setting-sources user`), but never a worktree's `.claude/settings.json` or `.claude/settings.local.json`: a step could commit one to the item's branch, and its hooks would run outside the sandbox on the next write step that checks the branch out. A path in your own `sandbox.filesystem.allowRead` still wins over a `deny` here, a command in your `sandbox.excludedCommands` still runs outside the sandbox, and a host in your `sandbox.network.allowedDomains`, or any other sandbox key this does not set, still applies.

Codex's sandbox is different and keeps less — see [Integrations](integrations.md#codex).

## Untrusted text

**Markers.** Everything Landrace writes ends in a marker, and only the **last** marker in a body counts, and only when nothing follows it — a document about this system will quote the format, and reading the first match would find the example. Text Landrace did not write is escaped before posting, so neither an agent nor a commenter can emit Landrace's own control tokens. An effect's fields are filled only with the item's id, the stage and the round, never with snapshot text.

**Briefings.** Text fetched for a prompt — an item's body, review threads, a diff, CI logs — is escaped, bounded, and never merged into the snapshot, so it can inform a step but decide nothing. The shipped steps frame it as requirements or evidence, never as instructions.

### Screening prompts

Every agent that can act is screened first: every step declaring a capability, and every turn typed through the MCP — the place an operator pastes text someone sent them is not a place to start trusting it. The **screener** is a separate agent run, with no tools, servers or plugins, that reads the whole rendered prompt and says whether it carries an injection. `security.screen`, `security.adapter` and `security.model` configure it — see [Configuration](configuration.md#landraceyaml).

- An `ok` counts only when it carries the nonce that screening's prompt was marked with, so a verdict planted in the screened text, or the template restated, fails closed.
- A reply that fails closed is logged whole in `screen.blocked` (its last 2,000 characters, redacted like any log line) and never posted: the item shows the reason alone.
- A step the screener refuses is recorded as a refusal, not a broken contract, and lands at `screened` for a person to read.
- A step declaring no capability is not screened (`screen.skipped`): it runs with no tool and no repository. The one shipped, `triage`, answers from a closed set a comment could already argue for in plain words. Screening it only refused people's approvals over the judge template's own wording (#39, #41).

### Clearing a refused step

The screener is a model, and it can refuse a prompt that is fine — #39's spec was refused twice for its own template's wording. A person can overrule it, and only a person: the board's "Clear & retry", offered beside Retry on a screened item, or `landrace_clear`. Never a reply — a comment is text anyone can write, and an injection that could clear itself would make the screener decoration.

- Clearing writes a `cleared` record naming exactly the round the retry will run (`cleared:<stage>:<round>`), then the same goto Retry writes. That round runs without screening and logs `screen.cleared`; every later round is screened as ever.
- `landrace_clear` also takes a `stage`: the item goes there instead of back to the refused step — only where its stage lists that goto, within its cap — and the clearance covers that stage's next round.
- A comment on the item after the clearance, other than Landrace's own records, voids it. Nothing else does: an edit to the item's title or body, or a comment on its pull request, leaves the clearance in force, and that text reaches the unscreened round unread. Clear only an item whose text you trust not to change before the retry runs.
- It is refused on an item no security check stopped, and nothing is written where the goto itself would be refused.
- The agent's confinement does not change: the sandbox, the capability checks and the worktree comparison still hold for a cleared round.

## MCP servers a step may hold

Under either shipped executor, a step or turn gets exactly the MCP servers `agent.mcp` allows, strictly — nothing from a `.mcp.json` committed to the repository, from your user config, or from anywhere else — and the screener gets none.

- **An allowlisted server is not read-only because the step is.** A bare name allows every tool the server has, whatever it does. For the codebase graph that includes indexing any path (which writes its index there), deleting a project, rewriting ADRs, ingesting traces, and reading any project indexed on the machine — your own checkout, uncommitted work included. List the tools instead, as [Configuration](configuration.md#the-agent-block) shows. This repository's list still leaves two things open: `index_repository`, because a step's fresh worktree is not indexed yet, so a step can index a path of its choosing; and the reading tools take a project, so a step can read any project already indexed on the machine.
- **Landrace's own operator server is refused**, by name (`landrace`) and by command line — a server that runs `landrace mcp`, through the bin, `npx landrace@<version>`, `landrace#<ref>`, the `cli` entry with or without its extension, quoted, after `--`, or inside `sh -c`, in any case. Its tools create, update and reply on items, so a step holding them could move its own item. The command match is defence in depth over configuration you already trust, not a guarantee: a wrapper script under another name gets past it, so do not allow one. Keeping that server from a step is every executor's contract, not the kit's alone.
- **A definition's relative paths are not rebased.** A server is resolved from the repository root's `.mcp.json` but started in the step's worktree, so a relative `command` or argument resolves there, against committed files only. Use absolute paths or commands on `PATH`.
- **Credentials in a server's definition are visible.** An allowlisted server's `env` and `headers` travel in the agent's argv, where `ps` can read them for as long as the step runs. Keep credentials out of servers you allow. Their values, 8 characters or longer, are redacted from Landrace's own log.
- **A different executor may read none of it.** An `agent.adapter` naming a hook not built on the kit gets the `agent:` block unread, and owes these keys no meaning.

## The merge gate

A merge no person makes is held by the kit, not by a prompt, to three guards: green checks, the head the review read (`reviewedBy`), and no change to a protected path (`refuse`). How each works is in [Workflows](workflows.md#the-merges-three-guards), and fastlane's protected paths are listed in [Workflows](workflows.md#fastlane). The protected paths keep a change to the orchestrator itself — its hooks, configuration, workflows, step prompts, CI, dependencies and agent instructions — a person's to merge.

Only an item's own `landrace/{item}` pull request in its own repository is its work, so a stranger's pull request saying it closes the item reaches none of its prompts or counts — see [Which pull requests are an item's](workflows.md#which-pull-requests-are-an-items).

A step's front matter carries routes, effects and capabilities, and a retro writes lessons beside it — which is why `validate` refuses a `pull.merge` anywhere but a stage's `on_enter`, and why `.landrace/**` is protected.

## The board

The board binds loopback only and answers only its own host name. It has eleven writes:

- in the header, the tick button and Refresh;
- in a row's menu, Retry, Clear & retry and Go to step;
- in an item's panel, Reply, Ask the step and Resolve, and the Pairing section's Pair, Finish and Release.

Ask the step and Finish each run a paid agent turn on the spot, and Pair runs the screener. The tick button, Retry, Clear & retry, Go to step, Resolve and Release wake the loop, which can start a paid step at once. Reply posts a comment as you. Refresh, and the panel's conversation and Pairing reads, each spend a tracker read. So each is guarded beyond the host check:

- Each requires its own custom `x-landrace-action` header — `tick`, `refresh`, `retry`, `clear`, `goto`, `reply`, `ask`, `resolve`, `pair`, `finish`, `release`, and for the two reads `conversation` and `pairing` — which a cross-site `<form>` cannot set, and a cross-origin `fetch` that does set one triggers a CORS preflight the server never grants.
- Each refuses any `Origin` other than the page's own, and any request the browser marks `Sec-Fetch-Site` as not same-origin.

None of the guards is optional: together they stop another website you have open from starting paid work just because your browser can reach `127.0.0.1`.

## Who fastlane trusts

Fastlane builds and merges what the item's text and any person's reply ask for, with no person in between. Whoever can label an item `lr:auto` and `lr:fast`, edit its text, or comment on it while it waits sets requirements that reach the default branch. It fits a repository where everyone who can label, comment on or edit its issues is trusted. A pull request from anyone else — a fork's, or one only saying it closes the item — is never the item's, so it reaches none of its prompts. The protected paths keep a change to the orchestrator itself a person's to merge; a write step still runs with your git credentials, so the forge's own rules are the second layer.

**Before your first `lr:fast` item:**

- [ ] **Branch protection on the default branch**, with required status checks — the checks your CI runs — so the forge holds every merge to them, and `none` (nothing registered yet) can never merge past them.
- [ ] **The narrowest token that works**: a classic token with the `repo` scope (see [Token permissions](integrations.md#token-permissions)), belonging to an account with access to nothing it does not need. The merge needs Contents and Pull requests, read and write; Checks and Commit statuses, read; and Actions, read, for a failed job's log.
- [ ] **Code owners on `.landrace/**`** (and `src/**` here), with code-owner review required, so a change to the workflows and hooks needs a person on the forge too — beside the kit's own `refuse`, not instead of it.
