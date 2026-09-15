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
  routes:
    - when: { intent: approve }
      effect: { type: tracker.comment, marker: "intent:{round}" }
    - when: { intent: revise }
      effect: { type: tracker.comment, marker: "intent:{round}" }
    - when: { intent: question }
      effect: { type: tracker.comment, marker: "intent:{round}" }
    - when: { intent: unclear }
      effect: { type: tracker.comment, marker: "intent:{round}" }
---

Classify one message from a human reviewer who was shown a spec and asked to
approve it or say what to change.

Their message:
---
{run.lastHuman.body}
---

Reply with a fenced json block and nothing before it, with an `intent` field
and a `reason` field of up to 12 words.

`intent` is exactly one of `approve`, `revise`, `question`, `unclear`.

Choose `unclear` rather than guessing. A wrong `approve` ships an unreviewed
spec; a wrong `revise` wastes a round; `unclear` costs one short question,
which is the cheapest of the three mistakes. Judge only the message — do not
evaluate the spec yourself.
