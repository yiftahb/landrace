---
capabilities: []
model: haiku
output:
  discriminator: intent
  shapes:
    approve: {}
    revise: {}
    question: {}
    unclear: {}
    goto-spec: {}
    goto-build: {}
  routes:
    - when: { intent: approve }
      effect: { type: tracker.comment, marker: "intent:{round}" }
    - when: { intent: revise }
      effect: { type: tracker.comment, marker: "intent:{round}" }
    - when: { intent: question }
      effect: { type: tracker.comment, marker: "intent:{round}" }
    - when: { intent: unclear }
      effect: { type: tracker.comment, marker: "intent:{round}" }
    - when: { intent: goto-spec }
      goto: spec
      effect: { type: tracker.comment, marker: "intent:{round}" }
    - when: { intent: goto-build }
      goto: build
      effect: { type: tracker.comment, marker: "intent:{round}" }
---

Classify one message a person wrote on a ticket while it was their turn.

The ticket was waiting at: {run.previousStage}

What each place means, and which answers make sense there:

- `spec-questions` — the spec's author asked blocking questions. An answer to them is `revise`.
- `spec-human-review` — a spec was published for review. `approve` sends it to be built; `revise` asks for changes to it.
- `pr-human-review` — a pull request is open for review. Nothing said here approves or merges it; that is done on the pull request.
- `blocked` — a step failed and stopped.
- `screened` — a security check stopped a step.

Anywhere, the person may ask to go back:

- `goto-spec` — they want the spec written again ("redo the spec", "the spec misunderstood X").
- `goto-build` — they want the implementation redone or retried ("retry the build", "build it again").

`question` — they asked something rather than deciding. `unclear` — you cannot tell.

Their message:
---
{run.lastHuman.data.body}
---

Reply with a fenced json block and nothing before it, with an `intent` field
and a `reason` field of up to 12 words.

`intent` is exactly one of `approve`, `revise`, `question`, `unclear`,
`goto-spec`, `goto-build`.

Choose `unclear` rather than guessing. A wrong `approve` ships an unreviewed
spec; a wrong `revise` or `goto-*` spends a paid round; `unclear` costs one
short question, which is the cheapest of the mistakes. Judge only the
message — do not evaluate the work yourself.
