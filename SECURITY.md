# Security policy

Landrace runs coding agents with write access to a repository, and holds the tokens of the trackers, forges, docs sites and notifiers it is configured with. A flaw in it can leak those tokens, let an agent act beyond what its step declared, or merge code nobody reviewed. Please report one privately, and give us the chance to fix it before it is public.

The threat model, and what each guard does and does not cover, is in [docs/security.md](docs/security.md).

## Supported versions

| Version | Supported |
|---|---|
| The latest release | ✅ |
| Anything older | ❌ |

Fixes land on `main` and ship in the next release. Before reporting, check that the issue reproduces on the latest release, or on `main`.

## Reporting a vulnerability

Report it through GitHub's private vulnerability reporting on this repository: **[Report a vulnerability](https://github.com/yiftahb/landrace/security/advisories/new)** (the Security tab, then "Report a vulnerability").

Do not open a public issue, pull request or comment about it.

### What to include

- The Landrace version or commit (`git rev-parse --short HEAD`), your Node version and operating system.
- The workflow, and the tracker, forge and coding agent integrations in use.
- What an attacker controls (an issue's text, a comment, a pull request from a fork, a file in the repository, a web page the operator has open) and what they gain.
- The steps to reproduce it, ideally the smallest workflow, item or test that shows it.
- Log excerpts (`landrace start --debug`) with every token and secret removed.

**Never include a live token, even one that leaked.** Revoke a leaked token first, then describe where it appeared.

## What to expect

- An acknowledgement within 5 working days.
- An assessment within 14 days of the report: whether we accept it, and how severe we judge it.
- For an accepted report, a fix and a release coordinated with you, then a published GitHub security advisory crediting you, unless you would rather not be named. We aim to fix within 90 days, and sooner for anything that leaks a token or merges unreviewed code.

## Scope

In scope is anything that breaks the guards Landrace promises, including:

- **Token exposure.** A token Landrace holds, the tracker, forge, docs and notifier secrets in `.landrace/.env`, reaching an agent's process or environment, a command line, a log line, an error message, a comment, or a URL other than the one it is scoped to.
- **Sandbox escape.** A step's agent writing outside its worktree and the repository's git directory, or into `.git/hooks` or `.git/config`, reaching a host it was not allowed, using a capability or an MCP server its step did not declare, or reaching Landrace's own operator server.
- **Forged control state from untrusted text.** An issue, a comment, a pull request, a document or an agent's output that makes Landrace read a marker, record, label, `goto`, step output or security verdict it did not write itself, including a screening verdict planted in the screened text, or a step that can act running unscreened.
- **The merge gate.** A `pull.merge` that goes through on pending or failing checks, on a head the review did not read, on a change to a protected path, or for a pull request that is not the item's own (one from a fork, or one that only says it closes the item).
- **The board.** Another website open in the operator's browser getting the local triage page to perform any write it offers: a tick, a Retry, a Clear, a `goto`, a refresh, or a reply, ask, resolve or pairing from an item's panel.

Out of scope:

- What the operator chose to trust: a hook file under `.landrace/`, an MCP server or plugin allowlisted for a step, and the people who can label, edit or comment on items in a workflow that merges with no person (see "Who fastlane trusts" in the README).
- The limits the README documents: a write step pushes with your own git credentials, which a command in its sandbox can read and use to push any branch origin accepts; in-process tools such as web fetches are outside the command sandbox; and a merge treats a head with no checks registered on it as green, so a repository that merges with no person must require status checks on its default branch.
- The screening model misjudging a prompt. Screening is one layer; a verdict it was tricked into is in scope only as above.
- A flaw in a coding agent, tracker or forge itself. Report it to that vendor; tell us too if Landrace makes it worse.
- An attack that needs control of the operator's machine or accounts already.
