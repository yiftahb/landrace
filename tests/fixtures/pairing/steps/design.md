---
capabilities: [repo:read]
output:
  discriminator: kind
  shapes:
    designed: {}
  routes:
    - when: { kind: designed }
      effect: { type: tracker.comment, marker: "designed:{round}" }
---

Design {node.title} with the person, one question at a time.
