---
capabilities: [repo:read]
output:
  discriminator: kind
  shapes:
    approved: { note: string }
  routes:
    - when: { kind: approved }
      effect: { type: pull.merge, branch: "landrace/{item}" }
---

Review the pull request.
