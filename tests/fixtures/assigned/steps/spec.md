---
capabilities: [repo:read]
output:
  discriminator: kind
  shapes:
    spec: { title: string }
  routes:
    - when: { kind: spec }
      effect: { type: tracker.comment, marker: "spec:{round}" }
---

Write the spec for {node.title}. You are working as {vars.assignee}.
