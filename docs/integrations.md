# Integrations

The engine has no vendor in it. Each tracker, forge, docs site, notifier and coding agent is an **integration** that Landrace ships under `landrace/integrations/<vendor>`, which a project's hook file re-exports or composes. An integration plays one or more **roles**:

| Integration | Role |
|---|---|
| [GitHub](#github) | tracker (issues), forge (pull requests) and docs (Pages) |
| [GitLab](#gitlab) | forge (merge requests) |
| [Jira](#jira) | tracker (issues) |
| [Notion](#notion) | docs (spec pages) |
| [Slack](#slack) | notifier |
| [Claude Code](#claude-code) | executor (coding agent) |
| [Codex](#codex) | executor (coding agent) |

A tracker, a forge and a docs role are combined into one project's hooks by the kit's `compose`, and an executor is a hook on its own. How that works, and how to write a new integration, is in [Writing an integration](hooks.md). GitHub, GitLab, Jira, Notion and Claude Code each have a script that checks the integration against a live account; those scripts need `pnpm build` first.

## GitHub

`landrace/integrations/github` is GitHub's issues, pull requests and Pages, as three classes — `GitHubIssues` (tracker), `GitHubForge` (forge) and `GitHubPages` (docs). This repository's `.landrace/hooks/github.ts` composes all three:

```ts
import { compose } from "landrace/kit";
import { GitHubForge, GitHubIssues, GitHubPages } from "landrace/integrations/github";
export const { preflight, source, operator, pre, post, spec } = compose({
  tracker: new GitHubIssues(), forge: new GitHubForge({ closingRefs: true }), docs: new GitHubPages(),
});
```

```yaml
# .landrace/landrace.yaml
tracker:
  repo: owner/name
  # bot: myapp        # only with a GitHub App token
secrets:
  githubToken: $GITHUB_TOKEN
log:
  redact: [githubToken]
```

- `tracker.repo` is the repository, `owner/name`.
- `tracker.bot` is the login Landrace posts as. A GitHub App token needs it, since it cannot look up its own login; logins compare ignoring case and a trailing `[bot]`. With a user token, the login is resolved from the token at startup.
- Built with no client, each role builds one from `tracker.repo`, the `githubToken` secret and `tracker.bot` — one per configuration, shared by all three, so one `GET /user` resolves the login they post as.
- The forge runs git in the repository of the file that constructs it, never the directory the process was started from.
- `closingRefs` says the tracker beside the forge is GitHub's own issues. On, a pull request it opens says `Closes #n`, so the merge closes the issue. Off — beside another vendor's tracker, where `#7` would be somebody else's GitHub issue — it writes none. Either way it reads none: the `landrace/{item}` branch is the only tie between a pull request and an item.

### What it reads

- **Items** are the repository's issues. Labels and assignees are read from the issue; `node.state.assignees` is the list of logins (GitHub's singular `assignee` is only that list's first element).
- **Priority** comes from a `P0`..`P9` label. Two of them halt the item.
- **Closing.** A closed issue is never worked; it appears in a graph only so a parent can count a finished child. A close reason other than `COMPLETED`, `NOT_PLANNED`, `DUPLICATE` or none halts the item rather than guessing whether it is done or dropped.
- **Relationship types.** `child-of` (a sub-issue to its parent), `implements` (a pull request to its item), `documents` (the spec page to its item) and `blocked-by` (GitHub's issue dependencies). What each means to a workflow is in [Workflows](workflows.md#what-a-condition-can-read).
- **Pull requests** are read with their review threads and the checks on their head, from check runs and commit statuses. A pull request in the board's listing carries neither; the read an item is decided on carries both.
- **The spec page.** `GitHubPages` publishes each item's spec to the `gh-pages` branch, and reports it as a `document` node. `list` finds every page in one listing of `gh-pages`, and reports none for that tick, with a logged reason, when the listing fails or GitHub truncates it — it is display only. `read` checks the item's own page directly. Spec links point at the Pages site when the repository publishes one from the root of `gh-pages`, and otherwise at the file on GitHub.
- **Done.** The listing includes an item Landrace moved (it carries an `lr:stage:*` label) for 30 days after it closes, for the board's Done lane.

### Blocked-by

GitHub's own issue dependencies are read as `blocked-by`: an issue to each issue it is "blocked by".

- Each issue's blockers come in the same answer that reads the issue, with their title, link and state, so naming one costs no extra read. GitHub relates at most 50 to one issue, and every read asks for 50.
- A blocker closed as completed is done; one closed as not planned or as a duplicate is dropped.
- A blocker in this repository is its own number. One in another repository is a placeholder named `x.<owner>.<name>.<number>` — `x.acme.api.5` — or, where that would pass 64 characters, `x.<owner, cut to fit>.<12 hex of sha1(owner/name)>.<number>`. It is never read and never walked for a cycle: it holds the item back by the state GitHub reports for it.
- A blocker it cannot read all of makes the item `node.state.relatedUnreadable`, never "no blocker": one the token may not see (GitHub answers it null with a `FORBIDDEN` or `NOT_FOUND` error, logged once a tick as `github.blocker.unreadable`), one whose owner holds anything but letters, digits, `-` and `_`, a list holding fewer than GitHub counts, or one closed for a reason it does not map. Any other error beside the answer — a fault, a rate limit — fails the read for that tick.
- Whether an item is on a cycle is walked, in a read, over one light query of the open issues' blockers alone; `list` walks its own listing.
- **Writing.** `relate` and `unrelate` write through GitHub's issue-dependency endpoints, `POST` and `DELETE /repos/{owner}/{repo}/issues/{n}/dependencies/blocked_by`. These name the blocker by its REST id, so each write reads the blocker first, and refuses a pull request. A relationship asked for twice is written once, one GitHub already holds is done, and removing one already gone is done. Writes stay within the configured repository: a relationship to or from an issue elsewhere is read but never written, and asking for one is refused before anything is written. A 403 names the permission it needs.

**Check live:** if GitHub leaves a blocker the token may not see out of the answer *and* out of its count, nothing shows it, and it reads as no blocker. Check that with a token that cannot see a blocking repository before relying on cross-repository blockers.

### Token permissions

Use a **classic** token with the `repo` scope, and `workflow` if a build may change `.github/workflows/`. A fine-grained token cannot work: every read of an open pull request asks for its check runs, and GitHub grants "Checks" only to classic tokens and GitHub Apps. `landrace start` refuses a fine-grained token, saying so.

| Permission | Level | Used for |
|---|---|---|
| Contents | Read and write | Reading the spec from `gh-pages`, and publishing it; pushing an item's branch to an `https://github.com` origin; merging a pull request |
| Workflows | Read and write | Only when a build changes anything under `.github/workflows/` — GitHub refuses that push without it |
| Issues | Read and write | Items, comments, labels; sub-issues, and the "blocked by" dependencies Landrace writes |
| Pull requests | Read and write | Opening an item's pull request; review threads; merging it; closing a pull request a workflow drops (`pull.close`, and a dropped child's) |
| Checks | Read | A pull request's CI state on its head, and its failed check runs |
| Commit statuses | Read | The same, for services that report a status rather than a check run |
| Actions | Read | The log of a failed GitHub Actions job, for `{brief.project.ci}`; without it the check is still named, with `(log unavailable)` |
| Pages | Read | Whether a Pages site serves `gh-pages`, for spec links; without it, links point at the file on GitHub |
| Metadata | Read | Granted automatically |

`landrace start` and `landrace mcp` check these before anything else — including a one-time write of a single empty, unreferenced blob to prove Contents is writable, since a fine-grained token cannot report its own permissions. Both also read one commit's check runs and statuses, naming every permission missing in one sentence. Actions and Pages are not checked, because a log and a site link are optional. A token missing something refuses to start, rather than fail midway through a paid agent run. `landrace status` checks and writes nothing.

### Pushing

The forge pushes from the repository its own file is in:

- `origin` must have exactly one push URL (`git remote get-url --push --all origin`); any other count is refused, since `git push` would push to every one.
- The token goes to git only when that URL is exactly `https://github.com/<tracker.repo>`, with or without `.git` or a trailing `/` — matched as a string, not parsed. It travels in git's environment (`GIT_CONFIG_*`, as an `extraheader` scoped to that exact URL), never on a command line. `git@github.com:<owner>/<repo>.git` and `ssh://git@github.com/<owner>/<repo>.git` are pushed with your own ssh credentials and no token, as is any origin not on GitHub. A GitHub origin naming another repository is refused, and so is any other URL mentioning github.com — with credentials, a port, percent-encoding or a query.
- The push is the item's branch and nothing else: an explicit refspec, with tag-following and submodule pushing off.
- Every push runs with `core.hooksPath=/dev/null`, so none of the checkout's git hooks run — including your own pre-push hooks.
- A branch with nothing committed beyond `origin/HEAD` is not pushed. The push is refused, saying "Commit to the branch, then Retry", and the item halts at `blocked` until a person's Retry — a commit alone does not move it ([A way on the forge refused](workflows.md#a-way-on-the-forge-refused)). GitHub's "No commits between" on `pull.open` is refused the same way.
- A push is stopped after five minutes, or when the run is.
- Fetching an item's branch uses the same URL and token handling, one branch, no tags and no hooks; git's own words are scrubbed of the token before they reach an error.

### Checking it live

`pnpm parity` reads every listed item through `main`'s hook and the working tree's, and prints `equal`, or each node and edge that differs and exits 1:

```bash
pnpm build && GITHUB_TOKEN=… pnpm parity
```

## GitLab

`landrace/integrations/gitlab` is a forge: GitLab merge requests, beside whichever tracker the project uses. The hook file names the project by its full path:

```ts
import { compose } from "landrace/kit";
import { GitLab } from "landrace/integrations/gitlab";
export const { preflight, source, operator, pre, post } = compose({
  tracker: new MyTracker(), forge: new GitLab({ project: "group/app" }),
});
```

```yaml
secrets:
  gitlabToken: $GITLAB_TOKEN
  # gitlabBaseUrl: $GITLAB_BASE_URL   # only off gitlab.com
log:
  redact: [gitlabToken]
agent:
  sandbox:
    hosts: [gitlab.com, registry.npmjs.org]   # your instance's host, so a write step can fetch and push
```

`gitlabBaseUrl` is the instance as `https://host[:port]` and nothing more, so the token never travels in cleartext. A declared secret whose variable is unset refuses to start.

**Token.** Personal, project or group, with the `api` scope, and its user given Developer access to the project — direct, inherited or through a group the project is shared with. `landrace start` refuses one without either, naming which, and names a missing `gitlabToken` too. The same scope and role read a merge request's pipelines and failed jobs' traces; `start` also probes the pipeline read. Merging depends on the target branch: a default protected branch lets only Maintainers merge, so a Developer token merges only where that branch's "Allowed to merge" includes Developers, which is not the default — otherwise the item halts saying the token's user may not merge into its target branch.

**Checks.** A merge request's checks combine every pipeline on its head, read from one page of 100 of its pipelines, newest first. A branch or merge request pipeline runs at the head's sha. A [merged results pipeline](https://docs.gitlab.com/ci/pipelines/merged_results_pipelines/) runs at a merge commit, and counts when the head is one of that commit's parents. Any failed pipeline makes the checks `failure`. Otherwise any pipeline still running or pending makes them `pending`, and the rest is `success`. A head with no pipeline yet reads as pending, never as an older head's result. A merge request with no pipeline at all has no checks. A page that fills with the head's pipelines was not read to its end, so it never reads as `success`. The CI failures a prompt reads, `{brief.project.ci}`, list the failed jobs of every pipeline on the head.

GitLab puts every commit status that tools post on the head, such as a security scanner's or an AI reviewer's, into one `external` pipeline. Those statuses count as CI. To leave a reviewer's status out, name it:

```ts
new GitLab({ project: "group/app", reviewers: ["ai-review"] })
```

With `reviewers` set, the external pipeline is read status by status, and a named status never counts. A head whose only status is a reviewer's reads as pending. A failed status reaches `{brief.project.ci}` with its tool's description and link, unless it is a reviewer's or its tool allowed it to fail.

**Limits.** CI/CD must be enabled on the project. The forge needs GitLab 16.4 or later, for a finding on a file.

**What it writes.**

- An item's work is a merge request from `landrace/{item}` into the project's default branch, its node `pr-{iid}`. A fork's merge request is never an item's.
- A review's findings become diff discussions — on an added line by its new number, on a context line by both, and on the file when the line is outside every hunk — and its prose a plain note, which nobody can resolve and no count includes. Only a resolvable discussion somebody started is a thread.
- Everything it posts is made inert to GitLab's quick actions first: a line starting `/close` or `/merge` in a finding or a reply is an agent's text, and GitLab would run it as the token's user. A backslash before the slash renders as the slash alone.
- A round's note is recognised by both the token's login and its marker, so a marker pasted into somebody else's note cannot skip one.
- It pushes as GitHub's forge does, from the repository of the file that constructs it: the token goes as an `oauth2:` basic header only when origin's push URL is exactly `{gitlabBaseUrl}/{project}`, with or without `.git`. Any other origin is pushed with your own credentials.

**Checking it live.** On a throwaway branch `landrace/{n}`, the script appends a line to `README.md`, opens the merge request twice (the second is GitLab's 409, counted as done), puts findings on the added line and the context line above it, replies and resolves, and prints each check with the counts after it. It exits 1 on the first that fails, and closes the merge request and deletes the branch whatever happened.

```bash
pnpm build && GITLAB_TOKEN=… GITLAB_PROJECT=group/app node scripts/gitlab-check.mjs
```

Off gitlab.com, set `GITLAB_BASE_URL` too.

## Jira

`landrace/integrations/jira` is one Jira Cloud project's issues as the tracker, over REST v3. A hook file composes it beside whatever forge and docs the project has:

```ts
// .landrace/hooks/project.ts
import { compose } from "landrace/kit";
import { Jira } from "landrace/integrations/jira";
export const { preflight, source, operator, pre, post } = compose({
  tracker: new Jira({ project: "KEY" }),
});
```

```yaml
# .landrace/landrace.yaml
log:
  redact: [jiraEmail, jiraToken]
secrets:
  jiraBaseUrl: $JIRA_BASE_URL   # https://<site>.atlassian.net, and nothing else
  jiraEmail: $JIRA_EMAIL        # the account Landrace posts as
  jiraToken: $JIRA_TOKEN        # that account's API token
```

| Option | Default | What it is |
|---|---|---|
| `project` | — | The project's key. Only its `KEY-<n>` issues are items |
| `issueType` | `"Task"` | What an item with no parent is created as |
| `childType` | `"Subtask"` | What a child is created as, under its parent |
| `transitions.done` | `"Done"` | The transition that closes an item as done |
| `transitions.dropped` | `"Won't Do"` | The transition that closes one as dropped; a closed issue whose status or resolution has this name reads as dropped |
| `blockedByLinkType` | `"Blocks"` | The issue link type read and written as `blocked-by`, by its exact name. Its inward side must read "is blocked by", as Jira's "Blocks" does |

**Accounts and ids.** Basic auth carries the account's own token, so `jiraBaseUrl` must be an `https://<site>.atlassian.net` site, and nothing is asked of it before `GET /myself` says who the account is. Logins are `accountId`s. An item's author is its creator (the reporter can be edited), and its editor is whoever last changed the description, read from the changelog. An id is the project's `KEY-<n>` or it is refused before any request; an issue Jira answers under another key has moved, and is refused too.

**Reading.** A tick lists the project's open issues, and, for the board's Done lane, those carrying an `lr:stage:*` label that closed inside the window. Position is a stage label, as on any tracker. An issue is closed once its status is in Jira's done category: dropped if the status or the resolution is named `transitions.dropped`, done otherwise, so a closure nobody named still counts. Times are read as UTC.

**Writing.** Jira's status moves only to close an item, through the named transition, or to reopen one, through the first transition into a To Do status; a transition the issue does not offer fails, naming the ones it does. Comments and descriptions are ADF, never v2's wiki markup: a paragraph per blank-line block and a hard break per line, the text verbatim, so the `<!-- landrace … -->` marker reads back exactly. A body over Jira's 32,767 characters is refused before the request. A new issue's priority is the project's own, Landrace's 0–9 as an index into its list.

**Preflight.** It names each permission the account lacks on the project (`BROWSE_PROJECTS`, `CREATE_ISSUES`, `EDIT_ISSUES`, `TRANSITION_ISSUES`, `ADD_COMMENTS`, `LINK_ISSUES`), each issue type the project does not have and each without a labels field, a site with no link type named `blockedByLinkType` (naming the ones it has), a type that reads the same both ways (such as Relates, where which end blocks cannot be told), and a site with issue linking turned off. It logs the type's wording once, as `jira.blocked-by.link-type`, and writes nothing.

**Blocked-by.** `blocked-by` is Jira's own issue links of `blockedByLinkType`, visible and editable in Jira's UI; Landrace stores nothing of its own.

- It is read off each issue's `issuelinks`: the blocked issue lists its blocker under `inwardIssue`. A link of any other type is not read.
- The link carries the blocker's status but not its resolution: a status outside Jira's done category is open, a done one named `transitions.dropped` is dropped, and any other done one is judged by its resolution — from the listing when it holds the blocker, otherwise by `issue/bulkfetch`, a hundred issues a request.
- A blocker Jira does not return, or returns with no status, is unreadable, never done, and logged once a tick as `jira.blocker.unreadable`; so is a link entry with no type, no key, or no status for its other end. The item's relationships then read as not all read. Any other failure, `issueErrors` included, fails the read, and the next tick reads it again. A read's children are read without their links, which a read never draws.
- A blocker in another project on the same site is read and written by its own key. Jira leaves out of `issuelinks` a link to an issue the account may not browse, so such a blocker is unseen, not unreadable: give the account "Browse projects" on every project whose issues may block this one's.
- The cycle walk covers the configured project only, over one search of its open issues' links, so a cycle through another project goes undetected. Search lags a link just written by a moment: the walk sees it on the next tick.
- A relationship is written as Jira's own link — `POST /rest/api/3/issueLink`, the blocker as `inwardIssue` — after the blocked issue's links are read, so a link already there is not asked for again. `unrelate` finds the link by type and other end and deletes it by id. Both ends are read first. A write takes the "Link issues" permission, and Jira refuses an account without it with a 404; the refusal names the permission, and, for a blocker in another project, both projects. The blocked issue is always the project's own.

**Checking it live.** The script creates an item and a child in the project, comments, labels, drops the child and closes the item, printing each check. It exits 1 on any failed check, and when none passed.

```bash
pnpm build && JIRA_BASE_URL=https://your-site.atlassian.net JIRA_EMAIL=… JIRA_TOKEN=… JIRA_PROJECT=KEY \
  node scripts/jira-check.mjs
```

`JIRA_OPTIONS` takes the options above as JSON, such as `{"transitions":{"dropped":"Cancelled"}}`. `JIRA_CHECK_LINKS=1` adds a `blocked-by` round trip on two scratch issues it creates and drops afterwards; `JIRA_LINK_KEYS=KEY-12,OTHER-3` uses two issues you name instead, not already linked — the first, the project's own, to be blocked by the second — and leaves both open with the link removed. It relates them, reads back that the first is blocked by the second, confirms the change in the blocked issue's own history, then unrelates them and reads back none. A run that fails partway names the link it left behind.

## Notion

`landrace/integrations/notion` keeps each item's spec in Notion rather than on `gh-pages`: `Notion` is a docs role, beside any tracker and forge.

1. Create an internal integration at notion.so/profile/integrations with the **Read content**, **Update content** and **Insert content** capabilities, and copy its secret.
2. Share the parent page with it — open the page, ••• → Connections, add the integration — and take the page's id: the 32 hex digits its link ends in.
3. Declare the secret, and redact it:

   ```yaml
   log:
     redact: [githubToken, notionToken]
   secrets:
     githubToken: $GITHUB_TOKEN
     notionToken: $NOTION_TOKEN
   ```

4. Hand `compose` the role:

   ```ts
   import { compose } from "landrace/kit";
   import { GitHubForge, GitHubIssues } from "landrace/integrations/github";
   import { Notion } from "landrace/integrations/notion";
   export const { preflight, source, operator, pre, post, spec } = compose({
     tracker: new GitHubIssues(), forge: new GitHubForge({ closingRefs: true }),
     docs: new Notion({ parent: "0123456789abcdef0123456789abcdef" }),
   });
   ```

**Startup.** `landrace start` reads the parent page and creates a `Landrace specs` database in it when there is none, then rewrites its title unchanged — an integration's capabilities can only be tried, so that is how a token without **Update content** refuses to start rather than fail its first publish. **Insert content** is tried only on the start that creates the database: once it exists, a token that lost that capability still starts, and every publish then fails on Notion's 403. A parent not shared with the integration, a token Notion rejects, no `notionToken`, or two databases of that title in the parent each refuse to start, saying which.

**Rows.** Each spec is a row of that database. `Ticket`, its title column, is the item's id (the column keeps that name, so a database made before items were called items still works). The body is the spec as blocks, for a person to read; `Source`, a text property, is the markdown itself, and is what `{brief.spec.content}` hands a step, so a step works from exactly what was published. `Source` is written last, and a row whose `Source` is empty was never published. Publishing the same text again writes nothing. Changed text clears `Source`, replaces the body a block at a time, and writes `Source` again, so a publish cut off anywhere is redone on the same row by the next tick. Two rows for one item halt it. A spec link opens the item's row, or the parent page while there is none. Reading never creates the database, so `landrace status` writes nothing here either.

**Limits.**

- Give each project a parent page of its own: two projects in one parent share one database, where item 12 of one is item 12 of the other.
- Anyone who can edit the parent page can edit `Source`, which later steps are briefed with.
- The body shows `#` to `###` headings (deeper ones as `###`), paragraphs, bulleted and numbered lists one level deep, fenced code (in plain text when Notion does not know the language), quotes, inline code, and links to absolute http(s) addresses. A table, a rule or HTML on lines of its own is shown in a code block as written. Inside a paragraph or list item, anything else — bold, an indented table — stays the text it was, as does a line with more inline code and links than one block takes, and a link longer than 2,000 characters.
- `Source` holds at most a hundred pieces of 2,000 characters; a longer spec is refused before anything is written.
- Every request names `Notion-Version: 2025-09-03`; one that appends blocks carries at most 100; a 429 is waited out for as long as Notion's `Retry-After` says, five tries in all.

**Checking it live.** The script runs the check, a publish, the same text, changed text (over a hundred blocks, 60,000 characters with an emoji astride a piece boundary, a fence, a table, an item with 120 children) and the read back. It prints each step, exits 1 when one failed or nothing was checked, and leaves its `check-<time>` row in the database for you to look at.

```bash
pnpm build && NOTION_TOKEN=… NOTION_PARENT=0123456789abcdef0123456789abcdef node scripts/notion-check.mjs
```

## Slack

`landrace/integrations/slack` is a notifier: it tells a person when an item needs them. This repository's `.landrace/hooks/slack.ts` re-exports it:

```ts
export { slack } from "landrace/integrations/slack";
```

```yaml
notify:
  on: [needs-you]
  via: [slack]
secrets:
  slackWebhookUrl: $SLACK_WEBHOOK_URL
  slackNotifyUser: $SLACK_NOTIFY_USER
log:
  redact: [slackWebhookUrl]
```

- `SLACK_WEBHOOK_URL` is an incoming webhook (a Slack app → Incoming Webhooks). It is the credential, so redact it.
- `SLACK_NOTIFY_USER` is your member id (`U…`, from your profile's ⋮ → Copy member ID), so the post mentions you.

It posts `{ text }` to the webhook, mentioning that user and linking the item, with the title and the reason escaped (`&`, `<`, `>`) so a title cannot mention or link anyone. It gives up after five seconds, and a refusal reports Slack's status and reply — never the webhook's URL. A webhook cannot reply to its own post, so there is no threading. When and how often it is told is in [Configuration](configuration.md#notify).

## Claude Code

`landrace/integrations/claude` runs Claude Code's CLI. This repository's `.landrace/hooks/claude.ts` is two lines:

```ts
import { Claude } from "landrace/integrations/claude";
export const claude = new Claude();
```

```yaml
agent:
  adapter: claude
  model: opus
  effort: high
```

A step's `capabilities` decide how it starts the agent:

| Step declares | Permission mode | Also |
|---|---|---|
| no `repo:write` (read-only) | `manual` | `--restricted`, and `Bash`, `Edit`, `MultiEdit`, `NotebookEdit`, `Write` denied by name |
| `repo:write` | `acceptEdits` | Bash and every other tool, each command run inside Claude Code's sandbox — see [Security](security.md#a-write-steps-sandbox) |
| nothing (the screener) | `manual` | `--restricted`, `--tools ""` (no built-in tool at all), and an empty strict MCP config |

Neither read-only steps nor the screener run in plan mode. Checked against the CLI (2.1.282), plan mode refuses every MCP call and ignores `--model` — a screener configured as `security.model: haiku` was screening on sonnet. Manual mode with the write and exec tools denied honours both, and refuses a write attempted under it. The worktree diff after the run is the backstop either way.

- **Plugins.** `--restricted` ignores your own Claude settings, and every plugin you enabled there, so a read-only step has none unless `agent.plugins` names it. The list goes to the agent as one inline `--settings` document. A plugin's hooks still run under `--restricted`, so enable only plugins you would let run in read-only steps.
- **MCP servers.** Every step and turn runs with `--strict-mcp-config`: it gets exactly the servers `agent.mcp` names, as the repository root's `.mcp.json` defines them, and nothing from a `.mcp.json` committed to the repository or from your user config. A step holding `items:create` gets its bound child server beside them. See [Security](security.md#mcp-servers-a-step-may-hold).
- **Write steps** pass `--setting-sources user`, loading your own user-level Claude settings and never a worktree's `.claude/settings.json`.
- **Instructions and skills.** Neither tier's flags load the project's `CLAUDE.md` or skills, so every step and turn gets them another way, from the worktree it runs in. Landrace copies the worktree's root `CLAUDE.md`, and each file it imports with `@path` at the same place, into a directory outside the worktree, rebuilt on every run. `--add-dir` over that directory, with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` set in the `--settings` document, loads them. Claude Code rereads its instructions after compacting, and the copies hold what Landrace checked, whatever the step has made the worktree's files since. A write step is denied writing them, by its sandbox's `denyWrite` and an `Edit` rule. Nothing under `.claude/` is copied, so the worktree's settings, `.claude/CLAUDE.md` and `CLAUDE.local.md` never load, and an import from `.claude/` loads nothing. When the worktree has `.claude/skills`, `--plugin-dir` loads them as a plugin named `project`, so a skill is `project:<name>`. Landrace makes that plugin outside the worktree and rebuilds it on every run: a manifest, and for each skill the `SKILL.md` it read and checked, beside links to the rest of the skill's folder. The screener gets neither. Which files load is in [Workflows](workflows.md#the-retro).
- **What it refuses.** A step is refused before the agent starts, with the file named, when:
  - the worktree's `CLAUDE.md`, or a file it imports, leads outside it, links followed, or one imports `~/`, an absolute path or a path above the worktree. Landrace reads the files, and Claude Code what they import, outside the sandbox, so a link to a key, or an import of one, would put the key in the step's instructions. Landrace reads imports anywhere in a file, code included, where Claude Code skips code. A link to `AGENTS.md` beside it loads, and a link that leads nowhere loads nothing;
  - a skill's front matter holds a key other than `name`, `description`, `when_to_use`, `argument-hint`, `arguments`, `version`, `license`, `metadata`, `user-invocable`, `disable-model-invocation`, `disallowed-tools` and `paths`. Claude Code reads others that change what the step may do: `hooks` would run outside the sandbox, `allowed-tools` would let the agent use a tool its step did not declare, and `model`, `context`, `agent` or `mcpServers` would bill, run or start what the step did not ask for;
  - a skill's front matter has a line Landrace cannot read as a plain `key:`, such as a quoted or explicit key, or a line break other than a newline, so it cannot tell which keys the skill declares;
  - `.claude/skills`, a skill's folder or its `SKILL.md` leads outside the worktree, links followed. One that is a link leading nowhere loads nothing. Landrace reads each `SKILL.md` outside the sandbox, so a link to a key would hand the agent the key. agsync's `.claude/skills -> ../.agents/skills` stays inside;
  - a skill's `SKILL.md` is there but is not a regular file, such as a named pipe. Landrace reads it before the step's timeout starts, and reading a pipe could wait forever. A `CLAUDE.md` or an imported file that is not a regular file loads nothing, as in Claude Code.
- **Pairing.** A person can take a step over in their own terminal (`landrace_pair`): Claude can start a fresh session under the id Landrace gives the pairing, continue the agent's session, or fork it for `landrace_finish`.

**Checking it live.** The script makes a scratch git repository with a marker in the root `CLAUDE.md` (a link to `AGENTS.md`), in `docs/more.md`, which `AGENTS.md` imports, in `sub2/CLAUDE.md` (a link), in `sub1/AGENTS.md` with no `CLAUDE.md` beside it, and in a skill's `references/` under `.claude/skills` (a link to `.agents/skills`), and a SessionStart hook in `.claude/settings.json`. It runs a write step and a read-only step, two paid turns with your own login. Each must see the root and imported markers, the skill only as `project:probe-skill` (from the `init` event's skills) and its reference's marker. Each must see neither nested marker, and the hook must not have run. Then it checks that a skill declaring hooks, and a `CLAUDE.md` importing `~/.aws/credentials`, are refused before the agent starts. It prints each check, and exits 1 when one failed or none passed. `CLAUDE_CHECK_MODEL` picks the model, `haiku` when unset:

```bash
pnpm build && node scripts/claude-check.mjs
```

## Codex

`landrace/integrations/codex` runs OpenAI's `codex exec --json`, written against codex-cli 0.154:

```ts
// .landrace/hooks/codex.ts
import { Codex } from "landrace/integrations/codex";
export const codex = new Codex();
```

```yaml
agent:
  adapter: codex
  model: gpt-5.1-codex
  sandbox: { deny: [] }
```

| Run | Sandbox | Also |
|---|---|---|
| no `repo:write` (read-only) | `read-only` | |
| `repo:write` | `workspace-write`, with the network off | `$TMPDIR` and `/tmp` not writable: `$TMPDIR` holds every other item's worktree, Landrace's locks and the screener's folder |
| the screener | `read-only` | every built-in tool off — the shell, web search, the image viewer, connectors and plugins, the browser, sub-agents, hooks — no server, and run in a folder of its own that only you can write |

Every run passes `--ignore-user-config` and `--ignore-rules`, so your own `config.toml` — whose servers include Landrace's operator server — and your execpolicy rules do not load. It runs with `approval_policy="never"`, since nobody is there to ask; gets `agent.mcp`'s servers per run as `-c mcp_servers.<name>.*`, with a listed server's tools as its `enabled_tools`; takes the prompt on stdin; and has `CODEX_HOME` passed on beside the kit's few basic variables (see [BaseExecutor](hooks.md#baseexecutor)), nothing else of Landrace's environment. The session is `thread.started`'s id, the answer the last `agent_message`, and a `turn.failed` fails the run with Codex's own reason.

**What it refuses.** What Codex cannot do is refused rather than run without. At startup, and by `validate`:

- **`agent.sandbox.hosts`.** Its sandbox has the network on or off, with no list of hosts, so list none: a write step then has no network, and cannot install or push.
- **`agent.sandbox.deny`.** It cannot keep a command from reading a path under your home, and every step and turn — read-only ones too, whose answer is posted to the item — has a shell. The default list applies when `deny` is not written, so write `deny: []` to accept that every step and turn can read those paths.
- **An effort outside `none`, `low`, `medium`, `high`, `xhigh`.** No shipped step asks for one. A step of yours that asks for Claude's `max` is refused, and `validate` names it.
- **`agent.plugins`**, which is Claude's.

And before a run starts: a project `.codex/config.toml` or `.codex/hooks.json` anywhere from the run's folder up to the repository root — either would load beside the run, and a step could commit one — and a server, variable or header name a `-c` key path cannot carry (one with a `.`).

**Pairing.** Codex names every session it starts itself, so none can start under the id Landrace gives a pairing. It pairs only by carrying on the agent's own session: that session's file under `CODEX_HOME/sessions` is copied under the pairing's id, and the person runs `codex resume <that id>`. `landrace_finish` forks it with `codex exec fork`. A pairing on a stage the agent has not run yet is refused, saying why.
