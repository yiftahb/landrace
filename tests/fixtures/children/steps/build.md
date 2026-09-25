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

Implement #{node.id}: {node.title}.

If this ticket went through specification, the approved spec is at
{artifacts.spec.url} — work from it. A ticket created by a breakdown of a larger
one has no page there: its own description below is the spec, written when the
parent was planned. Either way, the description is the ticket's own words:

{ticket.body}

Use the `superpowers:executing-plans` skill. Work through the spec and commit
as you go. Run the test suite and the lint checks
before you finish — a reviewer's round spent on something you could have caught
yourself is a wasted round.

Commit locally only. You have no credentials and cannot push; the orchestrator
pushes your branch and opens the pull request.

Summarise what you did in your own words, then end with a fenced json block
whose only field is `kind`, set to `done`.
