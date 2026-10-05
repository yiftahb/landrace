---
capabilities: [repo:read, repo:write]
output:
  discriminator: kind
  shapes:
    done: {}
  routes:
    - when: { kind: done }
      effect: { type: tracker.comment, marker: "done:{stage}:{round}" }
---

Build #{node.id}, and commit it.
