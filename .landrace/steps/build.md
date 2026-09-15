---
skills: [superpowers:executing-plans]
capabilities: [repo:read, repo:write]
model: opus
---

Implement the spec for #{ticket.number}: {ticket.title}.

The approved spec is at {artifacts.spec.url}.

Work through it and commit as you go. Run the test suite and the lint checks
before you finish — a reviewer's round spent on something you could have caught
yourself is a wasted round.

Commit locally only. You have no credentials and cannot push; the orchestrator
pushes your branch and opens the pull request.
