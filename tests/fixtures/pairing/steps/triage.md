---
capabilities: [repo:read]
output:
  discriminator: kind
  shapes:
    triaged: {}
  routes:
    - when: { kind: triaged }
      effect: { type: tracker.comment, marker: "triaged:{round}" }
---

Triage {node.title}.
