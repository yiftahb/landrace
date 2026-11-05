# Security

Landrace runs coding agents on your machine, over text that strangers can write, with credentials that can push to your repository. This page says what it trusts, what it does not, and the safeguards between the two.

## Threat model

**What Landrace treats as untrusted:**

- **Text on the tracker and the forge.** An item's title and body, its comments, review threads, and anything a pull request carries. Anyone who can comment on an issue can write text that reaches an agent's prompt.
- **Pull requests from anyone.** A fork's pull request, or one whose text merely says it closes an item.
- **What an agent does.** An agent reads that text, so it may be steered. A step that may write runs shell commands.
- **The repository's own files.** A workflow file, a step prompt or a hook is a file a pull request can edit, and a write step can commit one.
- **Other websites in your browser.** Your browser can reach the board and its MCP endpoint on `127.0.0.1`.
- **Anyone else on the network.** The board asks no one who they are, so it binds loopback only.

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

A step declaring `repo:write` runs shell commands. In this repository that is `build`, `fix-review` and `retro`: each merges `origin/main`, installs, runs the tests, commits, and pushes its own branch — all but fastlane's `retro`, whose branch Landrace pushes. The Claude Code integration runs every command such a step runs inside Claude Code's sandbox (Seatbelt on macOS, bubblewrap on Linux), configured by `agent.sandbox`:

```yaml
agent:
  sandbox:
    hosts: [github.com, registry.npmjs.org]   # the only network a write step reaches
    deny:  [~/.config/gh, ~/.ssh, ~/.aws, ~/.npmrc]
```

- **Writes** land only in the step's worktree and in the repository's shared `.git` — never in your checkout, your home, `.git/hooks` or `.git/config`.
- **Network** is confined for commands, not for every tool. The allowlist confines what the shell and anything it runs can reach to `hosts`: a host name, or the sandbox's own `*.example.com` wildcard, with no scheme, port or path. With no `hosts`, a write step's commands have no network at all, and cannot fetch or push. In-process tools such as WebFetch and WebSearch do not go through the sandbox; they follow Claude Code's own permission rules, which deny them under `-p`. Your own settings reach no step, so they cannot allow them; only managed settings, which `--setting-sources` does not govern, could.
- **Reads** are refused under each `deny` path — by the sandbox for commands, and by a `Read` rule for the Read tool, which the sandbox does not cover. A path starts with `~/`. With no `deny`, the four paths above and `~/.landrace/credentials` apply; a list you write replaces them, so keep the ones you still want. `~/.landrace/credentials` is denied whatever the list says — see [Stored credentials](#stored-credentials).
- **No way out.** If the sandbox cannot start, the step is refused rather than run unconfined, and no command may ask to run outside it.
- **Strict keys.** `sandbox` takes `hosts` and `deny` and nothing else; a misspelt key is refused at startup.
- **Read-only steps** have no shell to confine. They get a `Read` rule for each denied path, `~/.landrace/credentials` included. **The screener** has no tool at all.

What it does not do:

- **It pushes with your git credentials.** `git push` goes through your own credential helper, and a command in the sandbox can ask that helper for the credential (`git credential fill`) as readily as `git push` can. The tracker's token never reaches the agent; your git credential for the listed hosts does. Use one scoped to what a step may push.
- **Nothing but the prompt keeps a step to its own branch.** With that credential and the host, `git push` can reach any branch on `origin`, and because the shared `.git` is writable, `git update-ref` can move any local branch. **Protect `main` on the forge before you run write steps** — on GitHub, a branch protection rule that refuses direct pushes.
- **No settings file loads.** A write step passes `--setting-sources ""`, so it loads neither a worktree's `.claude/settings.json` or `.claude/settings.local.json` — a step could commit one to the item's branch, and its hooks would run outside the sandbox on the next write step that checks the branch out — nor your user-level Claude settings, whose plugins would otherwise run in every write step whoever's they are. Your own `sandbox.filesystem.allowRead`, `sandbox.excludedCommands` and `sandbox.network.allowedDomains` no longer reach a write step either. Managed settings, which `--setting-sources` does not govern, still apply.

Codex's sandbox is different and keeps less — see [Integrations](integrations.md#codex).

## Stored credentials

`~/.landrace/credentials/<person id>.json` holds what each person has connected — see [Per-person keys](configuration.md#per-person-keys). Four things in Landrace write it: the board's Integrations tab, when you paste, connect with a forge or disconnect a credential; `start`, when it looks an identity up by your email; `start`, when a step's agent refuses your stored login and it marks that connection failed; and `start`, when it renews an OAuth token, or marks one failed that the provider refused to renew ([Connect with GitLab or GitHub](integrations.md#connect-with-gitlab-or-github)). Each file is mode 0600, in a directory of mode 0700, written whole to a temporary file and renamed over the old one. The store refuses to write over a file it cannot read rather than drop the connections in it. Every value of 8 characters or more read from it is cut from the log, and a pasted one, or a token a forge's OAuth gave, is cut before its connection's `check` runs, so a hook's log line cannot carry it. The reason the tab shows has every pasted value cut out, whatever its length. The tab never sends a credential's value back to the page; it shows you only your own looked-up identities, which are who you are on a system, not a secret.

**A Claude token you paste reaches every step.** A stored `claude` connection is handed to every step and turn as `CLAUDE_CODE_OAUTH_TOKEN`, since that is how the agent runs on your login. A step's commands can read it from their environment, so connect only a token you would hand a step. No run is handed `ANTHROPIC_API_KEY`, whatever your shell holds: beside the token, a run gets only the few variables [BaseExecutor](hooks.md#baseexecutor) lists.

The Claude Code integration denies `~/.landrace/credentials` to every step and turn, whatever `agent.sandbox.deny` says: a list you write replaces the defaults, and this repository's own `landrace.yaml` writes one. A write step gets it in the sandbox's `denyRead` and as `Read` rules; a read-only step gets the `Read` rules.

**Codex does not keep it.** Codex cannot keep a command from reading a path, so it runs only with `deny: []` (see [Integrations](integrations.md#codex)). Under Codex, every step and turn can read `~/.landrace/credentials`. Do not store a connection you would not hand a step while running Codex.

### Copied files and setup

`agent.worktree` ([Configuration](configuration.md#a-write-steps-worktree)) prepares a write step's worktree before the agent starts. Both of its halves widen what a step can reach:

- **Copied files can hold credentials, and the agent can read them.** A `.npmrc` with a registry token or a `.env` copied into the worktree is a file inside it, and `agent.sandbox.deny` covers only paths under your home, never files inside the worktree. Copy only what a step may read.
- **A copied file git does not ignore can be committed.** It shows in the worktree as untracked, and a step that commits everything commits it, and pushes it. Ignore what you copy.
- **Setup runs outside the sandbox.** It is your own configuration, so it runs with the network and the files your user has. It gets the same minimal environment the agent gets, never Landrace's own secrets: an install script never sees the forge token. It runs on the item's branch, which earlier steps wrote: a step can commit a package script that the next setup runs outside the sandbox. The worktree is also kept between an item's write steps, and keeping it resets tracked files and removes untracked ones but leaves ignored ones, such as `node_modules`, which the sandboxed agent can write: a setup command that runs anything from them, such as `npx`, a package's bin or `pnpm run`, runs what an earlier step left there, outside the sandbox, and `--ignore-scripts` does not prevent that. Prefer an install that runs no scripts, such as `pnpm install --frozen-lockfile --ignore-scripts`, where your project allows it.

## People on one instance

`start` runs a step for each person its roster holds. Each person's worktrees are in a folder of their own, `$TMPDIR/landrace/<repo>/worktrees/<person id>/`, with the id URL-encoded. Locally the roster is only you, so this section changes nothing there.

When a person's step starts, Landrace lists what it may not read: `~/.landrace/credentials`, each other person's worktree folder, and the folders where Claude Code keeps the sessions of runs in those worktrees, under `~/.claude/projects/`. The list joins `agent.sandbox.deny` for that run. A write step gets it in the sandbox's `denyRead` and as `Read` rules; a read-only step gets the `Read` rules. The person's own folders are never on it.

- **Asked fresh for every run.** Someone who joins on a sync, and a session another person's run started after yours was built, are on your next step's list. A session started while your step is running is not on that step's list.
- **A session folder is matched by its name.** Claude Code names it after the run's folder, with every character but a letter or digit turned into `-`. A folder counts as another person's when its name is theirs, or starts with theirs followed by `-`, so `bob` never covers `bobby`. Two paths can encode alike; the match then denies more, never less.
- **A path no rule can hold refuses the run.** A path holding `(`, `)` or a control character would end a rule early, or name something that is not there. Rather than leave that person readable, the run is refused, naming the path. URL encoding keeps `(` and `)`, so a person id holding either refuses every other person's steps.
- **An agent that cannot keep the list refuses the run.** Codex cannot keep a command from a path, so while anyone else is on the roster each of its runs is refused. Alone, it runs as before.

What it does not do:

- **The repository's `.git` is shared.** Every worktree is cut from it, and a write step's commands can read it. Another person's commits and branches are one `git log --all` away.
- **The rest of `$TMPDIR/landrace/<repo>/` is not listed.** The locks, and the activity log the board's item panel reads, sit beside the worktrees, and a write step's commands can read them.
- **Every step runs as the same operating-system user.** A command can list other processes and their command lines with `ps`. No list of paths changes that.
- **Your own worktrees, as the local person, are not in a folder of their own.** They sit in `worktrees/` itself, so a list of other people's folders cannot name them. While `start` runs only the local person, nobody else's step runs beside them.

## A step's instructions and skills

Every step and turn loads the instructions and skills of the branch it runs on: under Claude Code, its worktree's root `CLAUDE.md` and `.claude/skills` (see [Integrations](integrations.md#claude-code)). The screener loads neither.

- **A read-only step reads the branch's own instructions.** A review step reads the instructions and skills of the branch it reviews, so a branch that changes them can steer its own review. Fastlane's merge refuses such a branch, since `CLAUDE.md` and `AGENTS.md` in any directory, `.claude/**`, `.agents/**` and `.agsync/**` are protected paths, and a person merges it.
- **Instructions stay inside the worktree.** Landrace copies a step's root `CLAUDE.md`, and each file it imports, outside the worktree before the agent starts, and Claude Code loads the copies: it rereads its instructions after compacting, and a copy holds what was checked, whatever the step has made the worktree's file since. A write step may not write the copies: its sandbox denies them, and so do its Edit rules. Landrace reads the files, and Claude Code what they import, outside the sandbox, so a `CLAUDE.md` or an imported file that leads outside the worktree, links followed, or an import of `~/`, an absolute path or a path above the worktree, is refused before the agent starts, naming it: a link to `~/.aws/credentials`, or `@~/.aws/credentials`, would otherwise put the file in the step's instructions, past the sandbox's `deny` list and the Read rules. A link to `AGENTS.md` beside it loads, and a link that leads nowhere loads nothing.
- **A skill brings its text and nothing more.** A skill's front matter may hold only keys that leave its step as declared. One declaring `hooks`, which Claude Code runs outside the sandbox, `allowed-tools`, which approves tools its step did not declare, or `model`, `context`, `agent` or `mcpServers` is refused, and so is front matter Landrace cannot read. Any other unknown key is dropped from the copy that loads, so it cannot act. Skills load from a plugin Landrace makes outside the worktree, holding the `SKILL.md` files it checked, so a step cannot change a skill's front matter after the check. The rest of each skill's folder is linked, and a step can change those files. Landrace reads each `SKILL.md` outside the sandbox, so the skills folder, a skill's folder or a `SKILL.md` that leads outside the worktree is refused before anything is read: a link to a key would otherwise hand the agent the key.
- **No project settings.** Nothing under the worktree's `.claude/` is copied, so the `--add-dir` that loads `CLAUDE.md` loads none of its settings, whose plugins' hooks would run outside the sandbox, and an import from `.claude/` loads nothing.

## Untrusted text

**Markers.** Everything Landrace writes ends in a marker, and only the **last** marker in a body counts, and only when nothing follows it — a document about this system will quote the format, and reading the first match would find the example. Text Landrace did not write is escaped before posting, so neither an agent nor a commenter can emit Landrace's own control tokens. An effect's fields are filled only with the item's id, the stage and the round, never with snapshot text.

**Briefings.** Text fetched for a prompt — an item's body, review threads, a diff, CI logs — is escaped, bounded, and never merged into the snapshot, so it can inform a step but decide nothing. The shipped steps frame it as requirements or evidence, never as instructions.

### Screening prompts

Every agent that can act is screened first: every step declaring a capability, and every turn typed through the MCP — the place an operator pastes text someone sent them is not a place to start trusting it. The **screener** is a separate agent run, with no tools, servers or plugins, that reads the whole rendered prompt and says whether it carries an injection. `security.screen`, `security.adapter` and `security.model` configure it — see [Configuration](configuration.md#landraceyaml).

- An `ok` counts only when it carries the nonce that screening's prompt was marked with, so a verdict planted in the screened text, or the template restated, fails closed.
- A reply that fails closed is logged whole in `screen.blocked` (its last 2,000 characters, redacted like any log line) and never posted: the item shows the reason alone.
- A step the screener refuses is recorded as a refusal, not a broken contract, and lands at `screened` for a person to read.
- A step declaring no capability is not screened (`screen.skipped`). It still holds something: `capabilities: []` counts as a declaration, so the step runs at the read-only tier. It runs in a worktree of the repository, it gets every `agent.mcp` server, and under Claude it keeps Read, Grep and Glob. Only the screener's own run gets no tool at all. The one shipped, `triage`, answers from a closed set a comment could already argue for in plain words, and that answer is posted on the item. Screening it only refused people's approvals over the judge template's own wording (#39, #41).

### Clearing a refused step

The screener is a model, and it can refuse a prompt that is fine — #39's spec was refused twice for its own template's wording. A person can overrule it, and only a person: the board's "Clear & retry", offered beside Retry on a screened item, or `landrace_clear`. Never a reply — a comment is text anyone can write, and an injection that could clear itself would make the screener decoration.

- Clearing writes a `cleared` record naming exactly the round the retry will run (`cleared:<stage>:<round>`), then the same goto Retry writes. That round runs without screening and logs `screen.cleared`; every later round is screened as ever.
- On a stage that waits for a pairing (`waits: pairing`), no agent runs that round alone: the pairing is the round. Pair on it, and the seeded prompt and the hand-in skip screening for it, as long as nothing voids the clearance first.
- `landrace_clear` also takes a `stage`: the item goes there instead of back to the refused step — only where its stage lists that goto, within its cap — and the clearance covers that stage's next round.
- A comment on the item after the clearance, other than Landrace's own records, voids it. Nothing else does: an edit to the item's title or body, or a comment on its pull request, leaves the clearance in force, and that text reaches the unscreened round unread. Clear only an item whose text you trust not to change before the retry runs.
- It is refused on an item no security check stopped, and nothing is written where the goto itself would be refused.
- The agent's confinement does not change: the sandbox, the capability checks and the worktree comparison still hold for a cleared round.

## MCP servers a step may hold

Under either shipped executor, a step or turn gets exactly the MCP servers `agent.mcp` allows — or the narrower set its step's own `mcp` names — strictly — nothing from a `.mcp.json` committed to the repository, from your user config, or from anywhere else — and the screener gets none.

- **An allowlisted server is not read-only because the step is.** A bare name allows every tool the server has, whatever it does. For the codebase graph that includes indexing any path (which writes its index there), deleting a project, rewriting ADRs, ingesting traces, and reading any project indexed on the machine — your own checkout, uncommitted work included. List the tools instead, as [Configuration](configuration.md#the-agent-block) shows. This repository's list still leaves two things open: `index_repository`, because a step's fresh worktree is not indexed yet, so a step can index a path of its choosing; and the reading tools take a project, so a step can read any project already indexed on the machine.
- **Landrace's own operator server is refused**, by name (`landrace`), by a URL at the [front door](#the-front-door), and by command line — a server that runs `landrace mcp`, through the bin, `npx landrace@<version>`, `landrace#<ref>`, the `cli` entry with or without its extension, quoted, after `--`, or inside `sh -c`, in any case. Its tools create, update and reply on items, so a step holding them could move its own item. The command match is defence in depth over configuration you already trust, not a guarantee: a wrapper script under another name gets past it, so do not allow one. Keeping that server from a step is every executor's contract, not the kit's alone.
- **A definition's relative paths are not rebased.** A server is resolved from the repository root's `.mcp.json` but started in the step's worktree, so a relative `command` or argument resolves there, against committed files only. Use absolute paths or commands on `PATH`.
- **Credentials in a server's definition are visible.** An allowlisted server's `env` and `headers` travel in the agent's argv, where `ps` can read them for as long as the step runs. Keep credentials out of servers you allow. Their values, 8 characters or longer, are redacted from Landrace's own log.
- **A different executor may read none of it.** An `agent.adapter` naming a hook not built on the kit gets the `agent:` block unread, and owes these keys no meaning.

## The merge gate

A merge no person makes is held by the kit, not by a prompt, to three guards: green checks, the head the review read (`reviewedBy`), and no change to a protected path (`refuse`). How each works is in [Workflows](workflows.md#the-merges-three-guards), and fastlane's protected paths are listed in [Workflows](workflows.md#fastlane). The protected paths keep a change to the orchestrator itself — its hooks, configuration, workflows, step prompts, CI, dependencies and agent instructions — a person's to merge.

Only a pull request from an item's own branch (`landrace/{item}` unless `branch` sets another) in its own repository is its work, so a stranger's pull request saying it closes the item reaches none of its prompts or counts — see [Which pull requests are an item's](workflows.md#which-pull-requests-are-an-items).

A step's front matter carries routes, effects and capabilities, and a retro writes lessons beside it — which is why `validate` refuses a `pull.merge` anywhere but a stage's `on_enter`, and why `.landrace/**` is protected.

## The front door

The board and the operator server share one port: the board at `/`, the operator tools at `/mcp`. Without [`people.oidc`](remote.md) nothing asks who a caller is, so the guards are where it listens and what it answers. With it, see [Remote mode](#remote-mode) below; every guard here still holds.

- **Loopback only, unless people sign in.** It binds `serve.host`, which must be loopback without `people.oidc`; `validate` reports any other as `serve.unauthenticated`, and `start` refuses it. To reach it from elsewhere, put a proxy of your own that checks who you are in front of it, and name it in `serve.publicUrl`.
- **Its own host names only, before routing.** Every request, `/mcp` included, is answered `421` unless its `Host` is `127.0.0.1` or `localhost` on its port, the host it bound, or `serve.publicUrl`'s host. That stops DNS rebinding: a page on another site pointing its own name at `127.0.0.1`.
- **No other site's pages.** `/mcp` answers `403` to a request whose `Origin` names any other site, so a page you have open cannot call the operator tools through your browser.
- **No step reaches it.** A step's agent is kept from the door three ways. An `agent.mcp` server whose URL is the door's — any of its origins, or any loopback address on its port — is refused, whatever it is named. An `agent.sandbox.hosts` entry that matches the door's host names, `127.0.0.1`, `localhost` and `serve.publicUrl`'s host, wildcards included, is refused, so a write step's commands cannot reach it. And the Claude executor denies every run `WebFetch` of each of those host names. The Codex executor adds no such deny of its own. The port these use is the one `start` serves on, `--ui-port` included.

## Remote mode

With [`people.oidc`](remote.md) set, the door may listen beyond loopback, because every request is someone's:

- **Sign-in.** A person signs in with your provider using PKCE. The `state` is bound to a `landrace_login` cookie in the browser that began the sign-in, so a link carrying someone else's code cannot sign you in as them. An email the provider does not mark verified is refused. Where a person is sent afterwards is a path on this instance, never another site.
- **Sessions.** The `landrace_session` cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` when `serve.publicUrl` is `https`. It holds a random id only this process knows, so it cannot be forged. `validate` and `start` refuse a `serve.publicUrl` that is not `https` off loopback, which would send the cookie and every token in the clear.
- **Each person's own.** A request with no session gets a redirect to sign in or `401`. A signed-in person reaches only their own board, items and MCP sessions, as on a local instance with several people.
- **MCP tokens.** `/mcp` takes only a bearer token Landrace issued, and serves only the tools of the person it was issued to. Access tokens live in memory for an hour. Refresh tokens are stored hashed in a `0600` file under the credentials directory every step is denied reading, and each works once.
- **Consent.** Anyone can register an MCP client, so a token is issued only after a signed-in person approves that client on Landrace's consent page. The page is sent with `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`, so another site cannot overlay it to take your click. Approve is refused with a foreign `Origin`, and without the page's one-time token, which is bound to your session and to that one authorization request and expires in ten minutes. A form on another site therefore cannot approve for you, whatever the browser does with `SameSite`.
- **One identity, one person.** An identity value — a tracker account, say — that another person already holds is marked failed on the newcomer, whether a lookup or an admin's override gave it.

Landrace checks who signed in, not what they may do: everyone who can sign in at your provider gets an instance of their own on this machine. Limit who can sign in at the provider.

## The board

The board has fourteen writes:

- in the header, the tick button and Refresh;
- in a row's menu, Start work, Retry, Clear & retry and Go to step;
- in an item's panel, Reply, Ask the step and Resolve, and the Pairing section's Pair, Finish and Release;
- in the Integrations tab, Connect and Disconnect.

Ask the step and Finish each run a paid agent turn on the spot, and Pair runs the screener. The tick button, Start work, Retry, Clear & retry, Go to step, Resolve and Release wake the loop, which can start a paid step at once. Start work adds a workflow's admit labels to an item, which starts work on it. Reply posts a comment as you. Connect stores a credential that every later run uses, and Disconnect removes one, which stops the loop when a run needs it; both rebuild the runtime and wake the loop. A connect's body is capped at 16 KiB. The tab's read, `/people/me`, is open like `/board.json` and carries states, hints and field names, never a value. Refresh, and the panel's conversation and Pairing reads, each spend a tracker read. So each is guarded beyond the host check:

- Each requires its own custom `x-landrace-action` header — `tick`, `refresh`, `admit`, `retry`, `clear`, `goto`, `reply`, `ask`, `resolve`, `pair`, `finish`, `release`, `connect`, `disconnect`, and for the two reads `conversation` and `pairing` — which a cross-site `<form>` cannot set, and a cross-origin `fetch` that does set one triggers a CORS preflight the server never grants.
- Each refuses any `Origin` other than the page's own, and any request the browser marks `Sec-Fetch-Site` as not same-origin.

None of the guards is optional: together they stop another website you have open from starting paid work just because your browser can reach `127.0.0.1`.

Connect with GitLab or GitHub is two `GET`s, since a link and a provider's redirect are both a browser's navigation, which cannot carry the header. `/connect/<id>/start` is refused when the browser marks `Sec-Fetch-Site` as another site; it stores nothing, and only sends you to the provider. `/connect/<id>/callback` comes from the provider, another site, so it cannot be held to that. What it carries instead is the `state` `start` issued: single-use, 10 minutes, and bound to you, the connection, the PKCE verifier and the callback. A callback with any other state stores nothing ([Connect with GitLab or GitHub](integrations.md#connect-with-gitlab-or-github)).

## Who fastlane trusts

Fastlane builds and merges what the item's text and any person's reply ask for, with no person in between. Whoever can label an item `lr:auto` and `lr:fast`, edit its text, or comment on it while it waits sets requirements that reach the default branch. It fits a repository where everyone who can label, comment on or edit its issues is trusted. A pull request from anyone else — a fork's, or one only saying it closes the item — is never the item's, so it reaches none of its prompts. The protected paths keep a change to the orchestrator itself a person's to merge; a write step still runs with your git credentials, so the forge's own rules are the second layer.

**Before your first `lr:fast` item:**

- [ ] **Branch protection on the default branch**, with required status checks — the checks your CI runs — so the forge holds every merge to them, and `none` (nothing registered yet) can never merge past them.
- [ ] **The narrowest token that works**: a classic token with the `repo` scope (see [Token permissions](integrations.md#token-permissions)), belonging to an account with access to nothing it does not need. The merge needs Contents and Pull requests, read and write; Checks and Commit statuses, read; and Actions, read, for a failed job's log.
- [ ] **Code owners on `.landrace/**`** (and `src/**` here), with code-owner review required, so a change to the workflows and hooks needs a person on the forge too — beside the kit's own `refuse`, not instead of it.
