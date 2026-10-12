---
capabilities: [repo:read, repo:write]
output:
  discriminator: kind
  shapes:
    done: {}
  routes:
    - when: { kind: done }
      effects:
        - { type: tracker.comment, marker: "done:{stage}:{round}" }
        - { type: pull.open, branch: "landrace/{item}", title: "{item}: retro lessons", description: "Lessons from {item}, at {link}." }
---

Write the retro for #{node.id}, and commit it.
