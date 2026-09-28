---
capabilities: [repo:read]
model: opus
timeout: 120m
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

Write spec for #{node.id}: {node.title}.

{ticket.body}

Style: caveman. Drop articles, filler, hedging. Fragments fine. Every path,
name and technical term exact. Aim under 400 words. No pre-text, post-text or
slop.

Sections, in this order:

## Problem
What is broken or missing, and the case that shows it. Two or three lines.

## Decisions
Product flow first: what a person does and sees, step by step. Then each
choice made, one line each, with its reason.

## Technical design
File changes, one line per file: `path` — what changes. New types, functions
and settings by name. No code.

## Done when
Observable checks, one per line.

No implementation plan, no step list, no test list: build plans its own steps.

Use `superpowers:brainstorming` to settle the design (it comes through
`agent.plugins`; missing → say so, do not work around it). Use
codebase-memory-mcp (`agent.mcp`) to find the real files before naming them.
Keep it simple; do not over-engineer.

A decision that changes the shape of the work and cannot be settled from the
issue or the code → **output only questions**: at most three, one per item,
each the question, why it matters in one line, and options where they exist.
Same style. No partial spec beside them.

End with a fenced json block: `kind` `questions` with a `questions` array, or
`kind` `spec` with a `title`.
