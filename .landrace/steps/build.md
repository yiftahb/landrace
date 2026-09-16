---
capabilities: [repo:read, repo:write]
model: opus
output:
  discriminator: kind
  shapes:
    done: {}
  routes:
    - when: { kind: done }
      effect: { type: tracker.comment, marker: "done:{round}" }
---

Implement the spec for #{ticket.number}: {ticket.title}.

The approved spec is at {artifacts.spec.url}.

Use the `superpowers:executing-plans` skill. Work through the spec and commit
as you go. Run the test suite and the lint checks
before you finish — a reviewer's round spent on something you could have caught
yourself is a wasted round.

Commit locally only. You have no credentials and cannot push; the orchestrator
pushes your branch and opens the pull request.

Summarise what you did in your own words, then end with a fenced json block
whose only field is `kind`, set to `done`.
