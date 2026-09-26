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

Build the UI for #{node.id}, and commit it.
