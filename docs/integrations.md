# Integrations

The engine has no vendor in it. Each tracker, forge, docs site, notifier and coding agent is an **integration** that Landrace ships under `landrace/integrations/<vendor>`, which a project's hook file re-exports or composes. An integration plays one or more **roles**:

| Integration | Role |
|---|---|
| [GitHub](#github) | tracker (issues), forge (pull requests) and docs (Pages) |
| [GitLab](#gitlab) | forge (merge requests) |
| [Jira](#jira) | tracker (issues) and docs (an issue field) |
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
- `closingRefs` says the tracker beside the forge is GitHub's own issues. On, a pull request it opens says `Closes #n`, so the merge closes the issue. Off — beside another vendor's tracker, where `#7` would be somebody else's GitHub issue — it writes none. Either way it reads none: the item's branch, `landrace/{item}` unless [`branch`](configuration.md#landraceyaml) sets another, is the only tie between a pull request and an item.
- `reviewers` and `pull` are the [forge options](#forge-options) both forges take. With `reviewers` named, the checks are read from the head's check runs (one page of 100) and commit statuses instead of GitHub's rollup, which would count a reviewer's. A list GitHub did not give whole never reads as `success`, and a reviewer missing from one is refused, never read as not posted.

### What it reads

- **Items** are the repository's issues. Labels and assignees are read from the issue; `node.state.assignees` is the list of logins (GitHub's singular `assignee` is only that list's first element).
- **Priority** comes from a `P0`..`P9` label. Two of them halt the item.
- **Closing.** A closed issue is worked only at a workflow's [`closed: run`](workflows.md#a-stage-that-runs-after-close) stage; otherwise it appears in a graph only so a parent can count a finished child. A close reason other than `COMPLETED`, `NOT_PLANNED`, `DUPLICATE` or none halts the item rather than guessing whether it is done or dropped.
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

**Checks.** A merge request's checks combine every pipeline on its head, read from one page of 100 of its pipelines, newest first. A branch or merge request pipeline runs at the head's sha. A [merged results pipeline](https://docs.gitlab.com/ci/pipelines/merged_results_pipelines/) runs at a merge commit, and counts when the head is one of that commit's parents. Any failed pipeline makes the checks `failure`. Otherwise any pipeline still running or pending makes them `pending`, and the rest is `success`. A head with no pipeline yet reads as pending, never as an older head's result. A merge request with no pipeline at all has no checks. A page that fills with the head's pipelines was not read to its end, so it never reads as `success`. The CI failures a prompt reads, `{brief.project.ci}`, list the failed jobs of every pipeline on the head, and the failed commit statuses of its `external` one.

**Conflicts.** A merge request's [`conflicts`](workflows.md#what-a-condition-can-read) is GitLab's `has_conflicts`, and unknown while its `detailed_merge_status` is `checking` or `unchecked`. A merge request with conflicts may get no merged results pipeline at all, so a workflow that routes only on its checks can wait on it for ever. Each time Landrace reads an item's merge requests it asks GitLab to work their mergeability out again (`with_merge_status_recheck`), for one left `unchecked` since its target branch moved. GitLab does that in the background and does not promise it, so the answer arrives on a later tick.

GitLab puts every commit status that tools post on the head, such as a security scanner's or an AI reviewer's, into one `external` pipeline. Those statuses count as CI. To leave a reviewer's status out, and wait for it instead, name it in `reviewers` — see [Forge options](#forge-options):

```ts
new GitLab({ project: "group/app", reviewers: [{ status: "CodeRabbit" }] })
```

On GitLab a reviewer is a commit status by its name. With `reviewers` set, the external pipeline is read status by status, and a named status never counts. A head whose only status is a reviewer's reads as pending. A failed status reaches `{brief.project.ci}` with its tool's description and link, unless it is a reviewer's or its tool allowed it to fail. `reviewPending` asks for each reviewer's latest status on the head's commit by its name. More than 100 of one name is refused, never read as not posted.

**Limits.** CI/CD must be enabled on the project. The forge needs GitLab 16.4 or later, for a finding on a file.

**What it writes.**

- An item's work is a merge request from the item's branch (`landrace/{item}` unless [`branch`](configuration.md#landraceyaml) sets another) into the project's default branch, its node `pr-{iid}`. A fork's merge request is never an item's.
- A review's findings become diff discussions — on an added line by its new number, on a context line by both, and on the file when the line is outside every hunk — and its prose a plain note, which nobody can resolve and no count includes. Only a resolvable discussion somebody started is a thread.
- Everything it posts is made inert to GitLab's quick actions first: a line starting `/close` or `/merge` in a finding, a reply or a merge request's description is an agent's or an item's text, and GitLab would run it as the token's user. A backslash before the slash renders as the slash alone.
- A round's note is recognised by both the token's login and its marker, so a marker pasted into somebody else's note cannot skip one.
- It pushes as GitHub's forge does, from the repository of the file that constructs it: the token goes as an `oauth2:` basic header only when origin's push URL is exactly `{gitlabBaseUrl}/{project}`, with or without `.git`. Any other origin is pushed with your own credentials.

**Checking it live.** On a throwaway branch `landrace/{n}`, the script appends a line to `README.md`, opens the merge request twice (the second is GitLab's 409, counted as done), puts findings on the added line and the context line above it, replies and resolves, and prints each check with the counts after it. It exits 1 on the first that fails, and closes the merge request and deletes the branch whatever happened.

```bash
pnpm build && GITLAB_TOKEN=… GITLAB_PROJECT=group/app node scripts/gitlab-check.mjs
```

Off gitlab.com, set `GITLAB_BASE_URL` too.

## Forge options

Both forges, GitHub's and GitLab's, take two options from the kit's `BaseForge`: `reviewers` and `pull`.

### reviewers

`reviewers` names the external reviewers a workflow waits on, such as an AI reviewer that runs on every push, by the status each posts on the pull request's head. On GitLab that is a commit status's name. On GitHub it is a check run's name or a commit status's context.

```ts
new GitLab({ project: "group/app", reviewers: [{ status: "CodeRabbit" }] })
```

- The pull request node gains `reviewPending`: `1` while any named reviewer's status on the current head is missing or still running, and `0` once every one has finished, whatever it concluded. With no reviewers named it is always `0`. A merged or closed pull request reads `0`.
- A named status is left out of the checks and out of the CI failures a prompt reads, so it neither passes nor blocks CI.
- `landrace start` refuses a reviewer with no status, and `reviewers` on a forge that cannot read one.

`reviewPending` sums like `ciPending`. A fastlane without a review step of its own can wait for the reviewer and then route on its threads. Below, `reviewing` is a stage with no step that every push lands in, and each trigger is limited to the stages it leaves. No two fire together: the review routes differ on `awaitingFix`, and both need `ciFailed` and [`conflicts`](workflows.md#what-a-condition-can-read) not above `0`, where `build` needs one of them above it. Both review routes need a pull request, since a sum over none is `0`:

```yaml
- id: reviewing
  triggers:
    - name: a push landed
      when:
        "run.stage": { $in: [publish, fix-review, build] }
        "run.lastOutputValid": null
- id: fix-review
  triggers:
    - name: the reviewer finished and left threads to fix
      when:
        "run.stage": { $in: [reviewing, human-review] }
        "rel.implements.in.total": { $gt: 0 }
        "rel.implements.in.sum.reviewPending": 0
        "rel.implements.in.sum.ciFailed": { $not: { $gt: 0 } }
        "rel.implements.in.sum.conflicts": { $not: { $gt: 0 } }
        "rel.implements.in.sum.awaitingFix": { $gt: 0 }
- id: human-review
  triggers:
    - name: the reviewer finished and nothing awaits a fix
      when:
        "run.stage": reviewing
        "rel.implements.in.total": { $gt: 0 }
        "rel.implements.in.sum.reviewPending": 0
        "rel.implements.in.sum.ciFailed": { $not: { $gt: 0 } }
        "rel.implements.in.sum.conflicts": { $not: { $gt: 0 } }
        "rel.implements.in.sum.awaitingFix": 0
- id: build
  triggers:
    - name: the checks failed, or the pull request conflicts
      when:
        "run.stage": { $in: [reviewing, human-review] }
        $or:
          - { "rel.implements.in.sum.ciFailed": { $gt: 0 } }
          - { "rel.implements.in.sum.conflicts": { $gt: 0 } }
```

A reviewer's answers can land after its status already says it finished. A workflow that moves on at `reviewPending: 0` keeps a route back to its fix stage for a thread that starts awaiting a fix later, as it would for a person's late comment.

### pull

`pull` sets the text a pull request opens with. Unset, it opens with the item's title and no description.

```ts
new GitLab({ project: "group/app", pull: { title: "{item}: {title}", description: ".landrace/templates/pull.md" } })
```

- `title` formats `{item}`, the item's id, and `{title}`, its title.
- `description` is a template file under `.landrace/`, as a path from the project's root. It is filled with `{item}`, `{link}`, the item's link, and `{spec}`, the link of the item's spec page, empty when it has none. On GitHub with `closingRefs` on, `Closes #n` follows it.
- Text from the item is escaped as everywhere else, so it cannot carry Landrace's markers.
- The title and description are set when the pull request opens, and never rewritten: a person's later edits stay.
- Another placeholder in either is refused: in `title` when the hook file loads, in the template by `landrace start`, which also refuses a template it cannot read or one a link takes outside `.landrace/`.

## Jira

`landrace/integrations/jira` is one Jira Cloud project's issues as the tracker, over REST v3, and, optionally, one of their fields as the docs role (see "The spec on the ticket", below). A hook file composes it beside whatever forge and docs the project has:

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
  jiraAssignee: $JIRA_ASSIGNEE  # optional: an account id or an email; see "One developer's issues"
```

| Option | Default | What it is |
|---|---|---|
| `project` | — | The project's key. Only its `KEY-<n>` issues are items |
| `issueType` | `"Task"` | What an item with no parent is created as |
| `childType` | `"Subtask"` | What a child is created as, under its parent. Checked at start only when a step declares `items:create` |
| `transitions.done` | `"Done"` | The transition that closes an item as done |
| `transitions.dropped` | `"Won't Do"` | The transition that closes one as dropped; a closed issue whose status or resolution has this name reads as dropped |
| `blockedByLinkType` | `"Blocks"` | The issue link type read and written as `blocked-by`, by its exact name. Its inward side must read "is blocked by", as Jira's "Blocks" does |
| `jql` | none | A JQL clause ANDed into every search the tracker runs, such as `'created >= "2026-10-05"'`. See "A narrower scope", below |
| `statuses` | none | A Jira status for each stage that has one, keyed by the stage's `tracker.status` value, such as `{ build: "In Progress", "mr-human-review": "In Review" }`. See "Status follows the stage", below |
| `createIn` | none | Other projects' keys a [`tracker.create`](workflows.md#effects) may file an issue in, such as `["ENG"]`. See "Filing issues in another project", below |
| `createType` | `"Task"` | What an issue filed in a `createIn` project is created as |
| `createLinkType` | `"Relates"` | The issue link type between an item and an issue filed for it. It may not be `blockedByLinkType` |
| `relations` | none | Other issue link types read as relationships, by a name to the type's exact name, such as `{ relates: "Relates", duplicates: "Duplicate" }`. See "Related issues", below |

**Accounts and ids.** Basic auth carries the account's own token, so `jiraBaseUrl` must be an `https://<site>.atlassian.net` site, and nothing is asked of it before `GET /myself` says who the account is. Logins are `accountId`s. An item's author is its creator (the reporter can be edited), and its editor is whoever last changed the description, read from the changelog. An id is the project's `KEY-<n>` or it is refused before any request; an issue Jira answers under another key has moved, and is refused too.

**Reading.** A tick lists the project's open issues, and, for the board's Done lane, those carrying an `lr:stage:*` label that closed inside the window. Position is a stage label, as on any tracker. An issue is closed once its status is in Jira's done category: dropped if the status or the resolution is named `transitions.dropped`, done otherwise, so a closure nobody named still counts. Times are read as UTC. Each item carries its status in `node.state.status`, by name, and the status's category in `node.state.statusCategory`: `new`, `indeterminate` or `done`. Both come from the same list request, so a condition such as `"node.state.status": { $ne: "Pending R&D Fix" }` costs nothing more. The value is the name exactly as Jira spells it, and a condition compares it exactly.

**One developer's issues.** A list stops at 10 pages of 100 issues, so a project with more than 1,000 open issues cannot be listed whole. An `eligible` rule on the assignee does not help, because it is answered after the list. Set `jiraAssignee` instead, and each developer's instance lists that developer's issues alone:

- Each developer sets `JIRA_ASSIGNEE` in their own `.env`, to their Atlassian account id or their email. The hook file and `landrace.yaml` stay the same for everyone.
- Every search the tracker runs gains `AND assignee = "<accountId>"`: the open list, the Done lane and the cycle walk. A breakdown's children are read whole, whoever they are assigned to.
- Every issue Landrace creates, a child too, is assigned to that account.
- An email is resolved to an account once, at startup. Start is refused when it matches no user, or several, and the refusal names them. An account id Jira has no user for is refused too. Looking a user up takes the global "Browse users and groups" permission: Jira answers an account without it with nobody, so the refusal names the permission instead.
- An issue reassigned to somebody else drops out of the list, and this instance starts no more steps on it. That is the hand-off: the new assignee's instance picks it up.
- Reassigning does not stop a step already running. An item its tracker no longer lists is left running, so the old instance's step finishes and writes its result to the issue, while the new assignee's instance may start the same step on another machine. Locks are per machine and do not prevent this. Reassign an issue while no step runs on it.
- A cycle through an issue assigned to somebody else goes undetected, as one through another project does.

Declared but empty (`JIRA_ASSIGNEE=`), the tracker lists everyone's issues, as it does without the secret. Declared and not set at all, `start` refuses, as for any secret.

**A narrower scope.** Some workflows should see fewer issues than the assignee's, for example only tickets created after the workflow was turned on, so the first start does not work a backlog that people already handled. `eligible` cannot do this, because it is answered after the list. Set the `jql` option instead:

```ts
new Jira({ project: "SD", jql: 'created >= "2026-10-05"' })
```

- The clause is ANDed, in parentheses, into every search the tracker runs: the open list, the Done lane and the cycle walk, beside `jiraAssignee`. `JiraField`'s listing and its preflight's list of issue types are scoped the same way. A breakdown's children are read whole, whatever the clause says.
- It comes from the hook file only, never from an item's text.
- `start` runs it once, asking for one issue, and refuses a clause Jira cannot parse with Jira's own error.
- A cycle through an issue outside the clause goes undetected.

**Writing.** Without `statuses`, Jira's status moves only to close an item, through the named transition, or to reopen one, through the first transition into a To Do status; a transition the issue does not offer fails, naming the ones it does. Comments and descriptions are ADF, never v2's wiki markup. A body's Markdown is written as rich text: headings, bullet and ordered lists, fenced code blocks with their language, inline code, bold, italic, http, https and mailto links, and paragraphs, a hard break per line. Anything else is written as its text. Reading turns the same set back into Markdown, a person's edits in Jira's editor included; any other node reads as its text. A comment's `<!-- landrace … -->` marker is kept out of the text people read: it is stored in the comment's `landrace.marker` property and read back from there. When a comment has that property, a marker in its text is read as text. A comment written before the property existed still has its marker in the text, and that marker is read. A new issue's origin marker is written as its own plain-text paragraph in the description, never read as Markdown, so it reads back exactly. A body whose rich ADF is over Jira's 32,767 characters is written as plain paragraphs instead, its Markdown shown as written and read back exactly; one over the bound even as plain paragraphs is refused before the request, and the round is recorded as a failed round — `malformed`, headed "Could not record <stage>'s answer" — rather than run again ([An answer refused](workflows.md#an-answer-refused)). A new issue's priority is the project's own, Landrace's 0–9 as an index into its list.

**Filing issues in another project.** With `createIn`, a workflow can file a linked issue in another project of the site, such as an engineering bug raised from a support ticket. It does this with a `tracker.create` effect, usually one of a route's [`effects`](workflows.md#a-route-with-several-effects):

```ts
new Jira({ project: "SUP", createIn: ["ENG"], createType: "Bug" })
```

- One `POST /rest/api/3/issue` files the issue in the effect's `project`: `createType`, the effect's title and body, the fields its [`fieldsFrom`](workflows.md#fields-from-the-answer) fills, a `createLinkType` link to the item, and the entity property `landrace.created-by`, which holds the item's key and the effect's marker. With `jiraAssignee` set, the issue is assigned to that account. The issue, its fields, its link and its property go in the same request.
- A title over Jira's 255-character summary bound is cut to fit.
- Each field is written in the shape it takes, read from `GET /rest/api/3/field`: a textarea as a document, as `JiraField` writes a spec (see "The spec on the ticket", below), and a text field as a string of at most 255 characters. A textarea with the plain-text renderer refuses the document by name, and the request is sent once more with that field as a string; the refused request filed nothing. A field the site lacks, one that is not a text or textarea field, and a text field's value over 255 characters are refused before the request.
- The issue gets no labels, and it is in another project, so no workflow lists or works it.
- The item then gets a comment, `Filed ENG-12: <title>`, whose marker is what `satisfied()` reads.
- Before filing, the tracker reads the item's `createLinkType` links into that project. If one of them carries `landrace.created-by` with this item and marker, it is reused. So a crash between filing and recording files no second issue. When the item's links cannot be read, the effect fails rather than file a second issue.
- A request Jira refuses, such as an issue type the project lacks or a field not on its screen, is a refusal ([`EffectRefused`](workflows.md#an-answer-refused)), not an outage.
- `createIn` must name project keys other than `project`. `validate` and `start` refuse a `tracker.create` naming a project `createIn` does not list.

Filing and its preflight are tested against a fake Jira only; neither has been run against a real site, and `scripts/jira-check.mjs` does not exercise them.

**Preflight.** It names each permission the account lacks on the project (`BROWSE_PROJECTS`, `CREATE_ISSUES`, `EDIT_ISSUES`, `TRANSITION_ISSUES`, `ADD_COMMENTS`, `LINK_ISSUES`), each issue type the project does not have and each without a labels field — `childType` only when a loaded workflow has a step declaring `items:create`, since nothing else creates a child — a site with no link type named `blockedByLinkType` (naming the ones it has), a type that reads the same both ways (such as Relates, where which end blocks cannot be told), and a site with issue linking turned off. With `jiraAssignee` set, it also names an assignee that matches no user or several, an account that cannot look it up for want of the global `USER_PICKER` permission, an account the project cannot assign issues to (no access to it, or deactivated), a missing `ASSIGN_ISSUES` permission, and each issue type without an assignee field. With `statuses` set, it names every mapped status the project's workflow does not have. With `jql` set, it names a clause Jira cannot run, in Jira's words. For each `createIn` project, it names each permission the account lacks there (`BROWSE_PROJECTS`, `CREATE_ISSUES`, `LINK_ISSUES`, and `ASSIGN_ISSUES` with `jiraAssignee` set), a `createType` the project does not have, an assignee the project cannot assign issues to, and, with `jiraAssignee` set, a `createType` without an assignee field. For each field a loaded route's `tracker.create` in that project fills (`fieldsFrom`), it names one that is not on `createType`'s create screen, and one that is not a text or textarea field. It also names a site with no link type named `createLinkType`. For each value a `tracker.field` sets in a workflow that loads this tracker, it names a field the site lacks or cannot set, a value of the wrong shape, a user that is not exactly one account, and an option the field does not offer (see "Fields a transition needs", below). It names each `relations` link type the site does not have, naming the ones it has. It names a project whose type Jira does not give. It logs the type's wording once, as `jira.blocked-by.link-type`, logs `jira.service-desk` for a Jira Service Management project, and writes nothing.

**Jira Service Management.** On a service desk project (`projectTypeKey: service_desk`), a comment reaches the requester unless it is marked internal. So every comment Landrace posts carries `sd.public.comment: { internal: true }`: entry records, step answers, refusals and operator replies alike. The one exception is a `tracker.comment` route with `visibility: public`, which answers the requester. On any other project type, `visibility` is ignored. The project's type is read once. If Jira's answer does not include a type, the comment is refused before anything is posted, and the next tick tries again: Landrace never guesses that a comment is safe to make public.

- **Mentions.** In a comment, `@[<account id>]` mentions that account, and `@[<email>]` mentions the one user the email belongs to. The email is looked up the way `jiraAssignee` is. If it matches no user, or several, it stays text. Inside code it is always text. Descriptions mention nobody.
- **Worklogs.** `tracker.worklog` logs time on the issue with `POST /issue/{key}/worklog`, its marker kept in the worklog's `landrace.marker` property ([Fields from the answer](workflows.md#fields-from-the-answer)). Before it logs, it reads every worklog on the item, every page, and logs nothing when one of Landrace's carries the same marker, or, with `skipIfLogged`, when the item has any worklog. A tick reads no worklogs otherwise. Logging time takes the "Work on issues" permission and time tracking turned on. The preflight does not check either, so a project that never logs time does not need them. If Jira refuses the read with a 403 or a 404, or the write with a 403, the round is recorded as a failed round — `malformed`, headed "Could not record <stage>'s answer", so `run.lastRefused` stays `false` — and the step is not paid for again ([An answer refused](workflows.md#an-answer-refused)).

**Status follows the stage.** Team boards run on status, so `statuses` can move an issue's status as Landrace moves it. When a stage's `on_enter` runs `tracker.status`, the tracker first moves the `lr:stage:*` label, then moves the issue through the transition whose target status has the mapped name, in any case. The label stays the item's position; the status is for people.

- An issue already in the mapped status is left as it is.
- A stage with no mapping moves no status.
- A transition the issue does not offer is skipped, not a halt. It is logged as `jira.status.unoffered` once per item and status for as long as Landrace runs. So is a transition Jira refuses when it is taken — a validator, or a screen with a required field — logged as `jira.status.refused`; the stage label has moved by then, and stays.
- Two transitions into the mapped status halt the item, naming both: which one to take is not a guess.
- Closing stays opt-in. A workflow that should not close an issue on merge (QA, a release train) can leave `tracker.close` out of its last stage and map `done` to whatever status the team uses.

```ts
new Jira({ project: "KEY", statuses: { build: "In Progress", "mr-human-review": "In Review" } })
```

**Fields a transition needs.** A Jira workflow often gates a transition on a field: a validator that wants a Reviewer, or a condition that hides "In Review" until a Category is set. Then `statuses` logs `jira.status.unoffered` or `jira.status.refused`, and the status does not follow the stage. A [`tracker.field`](workflows.md#effects) effect sets those fields from the workflow file. Put it in the stage's `on_enter` before the `tracker.status` whose transition needs it: effects are applied in the order listed, so the transition sees the field.

```yaml
on_enter:
  - { type: tracker.comment, kind: enter, marker: "enter:{stage}:{round}" }
  - { type: tracker.field, fields: { customfield_10123: ["R&D"] }, onlyIfEmpty: true }
  - { type: tracker.status, value: build }        # the transition the field unlocks
```

- Each field is written in its own shape, read from the issue's edit screen (`GET /issue/{key}/editmeta`): a select as `{ value }`, a multi-select as a list of those, a user as `{ accountId }`, a multi-user field as a list of those, a number as a number, a text field as a string of at most 255 characters, and a textarea as a document, as `JiraField` writes a spec. A select or a user takes one value, written as a string or a list of one. A user is an account id or an email. An email is looked up the way `jiraAssignee` is, and refused when it matches no user, or several.
- Every field that does not already hold its value is written in one `PUT /issue/{key}`. With `onlyIfEmpty: true`, only the fields that are empty on the issue are written, so a value a person chose, such as a Reviewer the filer set, stays. Without it, entering the stage writes over whatever the field holds.
- Each list and read asks for the fields that the loaded `tracker.field` effects set, in the same request, and reads them into `node.state.fields`: an option as its value, a multi-select as a list of values, a user as an account id, text as text, a number as a number, an empty field as `null`. The effect is satisfied when every field holds its value, a list compared as a set, or, with `onlyIfEmpty`, any value. A field the read does not hold is not satisfied: not read is not empty.
- A field not on the issue's edit screen (or one the account may not edit), a field of any other type, a value the field does not take, and a write Jira refuses are refusals ([`EffectRefused`](workflows.md#an-answer-refused)), not outages. Every field is checked before anything is written.
- At start, the preflight checks each value a `tracker.field` sets in a workflow that loads this tracker; a workflow on another project is checked by that project's tracker. It checks that the field exists and is one of these types, that the value has the field's shape, that each user is exactly one account, and that each option is among the field's allowed values. It reads the options off the edit screen of an open issue of each issue type an item can be, as `JiraField`'s preflight does. A type with no open issue is logged as `jira.tracker-field.unchecked` and left unchecked, and a type whose screen lacks the field is logged as `jira.tracker-field.missing`. Start is refused when no screen can be read at all, when no screen read has an option field, and when a screen lists no allowed values for one: nothing was compared. A refusal names the field and the options it has.

`tracker.field` is tested against a fake Jira only; it has not been run against a real site, and `scripts/jira-check.mjs` does not exercise it.

**The spec on the ticket.** Many teams keep the technical design on the ticket, in a multi-line custom field. `JiraField` makes that field the docs role, so the spec is where the team already reads and writes it. It shares the tracker's site, secrets and scope, `jiraAssignee` and `jql`:

```ts
// .landrace/hooks/project.ts
import { compose } from "landrace/kit";
import { Jira, JiraField } from "landrace/integrations/jira";
import { GitLab } from "landrace/integrations/gitlab";
const tracker = new Jira({ project: "KEY" });
export const { preflight, source, operator, pre, post, spec } = compose({
  tracker,
  forge: new GitLab({ project: "group/app" }),
  docs: new JiraField({ tracker, field: "customfield_10050" }),
});
```

`tracker` is the `Jira` tracker beside it. `JiraField` takes its project from it, so the two cannot name different projects. `field` is the custom field's id. Find it in Jira's field settings (Settings → Work items → Fields: the id is the number in the field's URL), or in the answer to `GET /rest/api/3/field`.

- The spec is the field's text, and an empty field is no spec. A field a person filled counts as a spec, so `artifacts.spec.exists` can send an item that already has a design straight to `build`, and an empty one to a `spec` step. `{brief.spec.content}` hands the field's text to a step.
- A textarea field answers in ADF or as a plain string, depending on its renderer. Both are read: ADF as Markdown, in the set the tracker reads, and a string as it is.
- `artifact.publish` writes the field with `PUT /rest/api/3/issue/{key}`, in the shape the field takes. A single-line text field takes a string of at most 255 characters. A textarea takes ADF, with the tracker's bound and plain fallback for a long body, or a string when it has the plain-text renderer. The renderer is in the field configuration, which only an account with "Administer Jira" can read. So the textarea is written as ADF first, and when Jira refuses that for the field, as a string. A spec over the bound is refused before the request. Markdown outside the common set does not read back exactly, so such a spec is written again the next time it is published. When Jira refuses the field because it is not on the issue's edit screen, as on an Epic that lacks it, that item is refused, naming its issue type: the round is recorded as a failed round rather than run again ([An answer refused](workflows.md#an-answer-refused)), and the other items carry on.
- The link is the issue's own page, `https://<site>.atlassian.net/browse/KEY-<n>`.
- The board's document nodes come from one JQL query, `cf[<n>] is not EMPTY`, inside the project and the tracker's scope, `jiraAssignee` and `jql`.
- The preflight names a field the site does not have, and a field that is neither a text nor a textarea field. It then checks the edit screen of each issue type an item can be: the types of the open issues in the tracker's scope, read in one search under `jiraAssignee` and `jql`, and the tracker's `issueType` and `childType`. Other types, such as a project's Epics, are not checked. A type whose edit screen lacks the field is logged as `jira.field.missing`, naming the type, and does not refuse start. Jira says what an edit screen holds only for an issue, so each type is checked on one of its open issues: a closed status can make issues non-editable, which answers an empty edit screen. A type with no open issue is logged as `jira.field.unchecked`, and a check where no type has an open issue fails.

**Blocked-by.** `blocked-by` is Jira's own issue links of `blockedByLinkType`, visible and editable in Jira's UI; Landrace stores nothing of its own.

- It is read off each issue's `issuelinks`: the blocked issue lists its blocker under `inwardIssue`. A link of any other type is not read as `blocked-by`; `relations` can read it as a relationship of its own (see "Related issues", below).
- The link carries the blocker's status but not its resolution: a status outside Jira's done category is open, a done one named `transitions.dropped` is dropped, and any other done one is judged by its resolution — from the listing when it holds the blocker, otherwise by `issue/bulkfetch`, a hundred issues a request.
- A blocker Jira does not return, or returns with no status, is unreadable, never done, and logged once a tick as `jira.blocker.unreadable`; so is a link entry with no type, no key, or no status for its other end. The item's relationships then read as not all read. Any other failure, `issueErrors` included, fails the read, and the next tick reads it again. A read's children are read without their links, which a read never draws.
- A blocker in another project on the same site is read and written by its own key. Jira leaves out of `issuelinks` a link to an issue the account may not browse, so such a blocker is unseen, not unreadable: give the account "Browse projects" on every project whose issues may block this one's.
- The cycle walk covers the configured project only, over one search of its open issues' links, so a cycle through another project goes undetected. With `jiraAssignee` or `jql` set, it covers the open issues in that scope only. Search lags a link just written by a moment: the walk sees it on the next tick.
- A relationship is written as Jira's own link — `POST /rest/api/3/issueLink`, the blocker as `inwardIssue` — after the blocked issue's links are read, so a link already there is not asked for again. `unrelate` finds the link by type and other end and deletes it by id. Both ends are read first. A write takes the "Link issues" permission, and Jira refuses an account without it with a 404; the refusal names the permission, and, for a blocker in another project, both projects. The blocked issue is always the project's own.

**Related issues.** `relations` reads other issue link types as relationships, so a workflow can route on them, the board's panel lists them, and `{brief.project.related}` tells a prompt. A support ticket linked "Relates" to the engineering bug that fixes it is then `rel.relates.out.total: 1`.

```ts
new Jira({ project: "SD", relations: { relates: "Relates", duplicates: "Duplicate" } })
```

- Each key is the relationship's name in the snapshot, `rel.<name>.*`, and each value is a link type's exact name.
- A link whose outward words describe the item ("SD-4 duplicates SD-2") is `rel.<name>.out` on it. A link whose inward words do ("SD-2 is duplicated by SD-4") is `rel.<name>.in`.
- A type whose inward and outward words are the same, such as Relates ("relates to"), counts as `out` from both ends, whichever end made the link. `rel.relates.out` holds every Relates link, and `rel.relates.in` is always 0.
- The links come from the `issuelinks` the list already asks for, with no extra request. An issue the list does not hold, such as one in another project, becomes a placeholder node. It carries the key, title, link, `node.state.status` and `node.state.statusCategory`. It is closed when its status is in Jira's done category. A link carries no resolution, so a closed one is dropped only when its status is named `transitions.dropped`, and done otherwise.
- An issue that `tracker.create` filed shows up here when `createLinkType` is one of the mapped types.
- A link entry of a mapped type that cannot be read is logged as `jira.blocker.unreadable`, and the item's relationships read as not all read. That includes a missing end, a missing key, and a type without its inward and outward words. So does a related issue whose link names no status: it is drawn open and marked unreadable.
- These relationships are read only. `relate` and `unrelate` still write `blocked-by` alone.
- A name is lowercase: a letter, then letters, digits or `-`. It may not be `child-of`, `implements`, `documents` or `blocked-by`, the engine's own relationship types, nor `constructor` or `prototype`, which the engine refuses as a relationship type. A name may not map `blockedByLinkType`, and two names may not map one link type. Loading the hook file refuses each of these. `start` refuses a link type the site does not have.
- `validate` accepts `rel.<name>.in.*` and `rel.<name>.out.*` for each mapped name. It refuses those paths for a name that is not mapped.

`relations` is tested against a fake Jira only. It has not been run against a real site, and `scripts/jira-check.mjs` does not exercise it.

**Checking it live.** The script creates an item and a child in the project, comments, logs a minute of work on the item, labels, drops the child and closes the item, printing each check. The worklog needs "Work on issues" and time tracking on. It exits 1 on any failed check, and when none passed.

```bash
pnpm build && JIRA_BASE_URL=https://your-site.atlassian.net JIRA_EMAIL=… JIRA_TOKEN=… JIRA_PROJECT=KEY \
  node scripts/jira-check.mjs
```

`JIRA_OPTIONS` takes the options above as JSON, such as `{"transitions":{"dropped":"Cancelled"}}`. With `statuses` in it, the script moves the item to the first mapped stage and reads its Jira status back. `JIRA_FIELD=customfield_10050` makes `JiraField` over that field the docs role: the preflight checks the field, and the script publishes the item's spec to it, reads it back, and finds it in the field's listing. `JIRA_ASSIGNEE` is the `jiraAssignee` secret. Set, the item and child it creates are assigned to that account, and two more checks find them in the scoped open listing and the closed item in the scoped Done lane, each assigned to that account: an email the script looks up itself, an account id it compares as given. `JIRA_CHECK_LINKS=1` adds a `blocked-by` round trip on two scratch issues it creates and drops afterwards; `JIRA_LINK_KEYS=KEY-12,OTHER-3` uses two issues you name instead, not already linked — the first, the project's own, to be blocked by the second — and leaves both open with the link removed. It relates them, reads back that the first is blocked by the second, confirms the change in the blocked issue's own history, then unrelates them and reads back none. A run that fails partway names the link it left behind.

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

**The model that signs its text.** The line that [signs what an agent writes](workflows.md#what-an-agent-signs) names the exact model from the `system` `init` event, such as `claude-haiku-4-5-20251001` for a step that asked for `haiku` (seen on Claude Code 2.1.289). A run whose events name none falls back to the step's `model`, else `agent.model`, else `unknown`.

- **Plugins.** No step loads your own Claude settings, so none gets a plugin you enabled there for yourself: a read-only step runs `--restricted`, and a write step `--setting-sources ""`. A step gets the plugins its own `plugins` lists, or else those `agent.plugins` names, as one inline `--settings` document. A plugin's hooks still run, so enable only plugins you would let run in every step.
- **MCP servers.** Every step and turn runs with `--strict-mcp-config`: it gets exactly the servers `agent.mcp` names — or, when its step lists its own `mcp`, those of them it names — as the repository root's `.mcp.json` defines them, and nothing from a `.mcp.json` committed to the repository or from your user config. A step holding `items:create` gets its bound child server beside them. See [Security](security.md#mcp-servers-a-step-may-hold).
- **Write steps** pass `--setting-sources ""`, loading no settings file: neither a worktree's `.claude/settings.json` nor your own user-level settings. Checked on Claude Code 2.1.289, `user` loaded every plugin you enabled into the step, and `""` leaves only Claude Code's built-in plugins, with the run still working.
- **Instructions and skills.** Neither tier's flags load the project's `CLAUDE.md` or skills, so every step and turn gets them another way, from the worktree it runs in. Landrace copies the worktree's root `CLAUDE.md`, and each file it imports with `@path` at the same place, into a directory outside the worktree, rebuilt on every run. `--add-dir` over that directory, with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` set in the `--settings` document, loads them. Claude Code rereads its instructions after compacting, and the copies hold what Landrace checked, whatever the step has made the worktree's files since. A write step is denied writing them, by its sandbox's `denyWrite` and an `Edit` rule. Nothing under `.claude/` is copied, so the worktree's settings, `.claude/CLAUDE.md` and `CLAUDE.local.md` never load, and an import from `.claude/` loads nothing. When the worktree has `.claude/skills`, `--plugin-dir` loads them as a plugin named `project`, so a skill is `project:<name>`. Landrace makes that plugin outside the worktree and rebuilds it on every run: a manifest, and for each skill the `SKILL.md` it read and checked, beside links to the rest of the skill's folder. A step that lists its own `skills` gets only those in the plugin, and one that lists none gets no plugin; a skill it leaves out is never read. The screener gets neither. Which files load is in [Workflows](workflows.md#the-retro).
- **What it refuses.** A step is refused before the agent starts, with the file named, when:
  - the worktree's `CLAUDE.md`, or a file it imports, leads outside it, links followed, or one imports `~/`, an absolute path or a path above the worktree. Landrace reads the files, and Claude Code what they import, outside the sandbox, so a link to a key, or an import of one, would put the key in the step's instructions. Landrace reads imports anywhere in a file, code included, where Claude Code skips code. A link to `AGENTS.md` beside it loads, and a link that leads nowhere loads nothing;
  - a skill's front matter holds `hooks`, `allowed-tools`, `model`, `context`, `agent` or `mcpServers`. Claude Code acts on each of them: `hooks` would run outside the sandbox, `allowed-tools` would let the agent use a tool its step did not declare, and `model`, `context`, `agent` or `mcpServers` would bill, run or start what the step did not ask for. Any other key outside `name`, `description`, `when_to_use`, `argument-hint`, `arguments`, `version`, `license`, `metadata`, `user-invocable`, `disable-model-invocation`, `disallowed-tools` and `paths`, such as the `scope` agsync writes, is not refused: it is dropped, with its value, from the `SKILL.md` copied into the plugin, which is the one that loads, and logged as `claude.skill.key.dropped` once per skill and key;
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

Every run passes `--ignore-user-config` and `--ignore-rules`, so your own `config.toml` — whose servers include Landrace's operator server — and your execpolicy rules do not load. It runs with `approval_policy="never"`, since nobody is there to ask; gets `agent.mcp`'s servers per run as `-c mcp_servers.<name>.*`, with a listed server's tools as its `enabled_tools`; takes the prompt on stdin; and has `CODEX_HOME` passed on beside the kit's few basic variables (see [BaseExecutor](hooks.md#baseexecutor)), nothing else of Landrace's environment. The session is `thread.started`'s id, the answer the last `agent_message`, and a `turn.failed` fails the run with Codex's own reason. Its events name no model, so the line that [signs what an agent writes](workflows.md#what-an-agent-signs) names the step's `model`, else `agent.model`, else `unknown`.

**What it refuses.** What Codex cannot do is refused rather than run without. At startup, and by `validate`:

- **`agent.sandbox.hosts`.** Its sandbox has the network on or off, with no list of hosts, so list none: a write step then has no network, and cannot install or push.
- **`agent.sandbox.deny`.** It cannot keep a command from reading a path under your home, and every step and turn — read-only ones too, whose answer is posted to the item — has a shell. The default list applies when `deny` is not written, so write `deny: []` to accept that every step and turn can read those paths.
- **An effort outside `none`, `low`, `medium`, `high`, `xhigh`.** No shipped step asks for one. A step of yours that asks for Claude's `max` is refused, and `validate` names it.
- **`agent.plugins`**, which is Claude's.
- **A step's own `skills` or `plugins`.** Codex loads neither project skills nor plugins, so it cannot keep a step to a list of them. A step's `mcp` is kept, as `agent.mcp` is.

And before a run starts: a project `.codex/config.toml` or `.codex/hooks.json` anywhere from the run's folder up to the repository root — either would load beside the run, and a step could commit one — and a server, variable or header name a `-c` key path cannot carry (one with a `.`).

**Pairing.** Codex names every session it starts itself, so none can start under the id Landrace gives a pairing. It pairs only by carrying on the agent's own session: that session's file under `CODEX_HOME/sessions` is copied under the pairing's id, and the person runs `codex resume <that id>`. `landrace_finish` forks it with `codex exec fork`. A pairing on a stage the agent has not run yet is refused, saying why.
