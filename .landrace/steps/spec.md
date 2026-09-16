---
skills: [superpowers:brainstorming, superpowers:writing-plans]
capabilities: [repo:read]
model: opus
output:
  discriminator: kind
  shapes:
    questions: { questions: { type: array, items: string, maxItems: 3 } }
    spec: { title: string }
  routes:
    - when: { kind: questions }
      effect: { type: tracker.comment, marker: "questions:{round}" }
    - when: { kind: spec }
      effect: { type: artifact.publish, artifact: spec }
---

Write the spec for #{ticket.number}: {ticket.title}.

{ticket.body}

Cover the problem and the proposed solution: what is broken or missing, what
you propose to do about it, and how someone will know it worked.

Rules:
* Use codebase-memory-mcp to discover the codebase and understand the architecture.
* Keep it simple and short, do not over engineer or over complicate.
* No pre-text, post-text or slop.

If a decision would change the shape of the work and you cannot resolve it from
the issue or the codebase, **output only the questions** — at most three, one
per item, each with why it matters and a shortlist of options where one exists.
Do not write a partial spec alongside them.


End with a fenced json block: `{"kind": "questions", "questions": [...]}` or
`{"kind": "spec", "title": "..."}`.
