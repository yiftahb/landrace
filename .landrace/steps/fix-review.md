---
capabilities: [repo:read, repo:write]
model: opus
---

Address the open review threads on the pull request for #{ticket.number}.

Each open thread is a finding to fix or to push back on with a reason. Fix the
code, or reply saying why the finding is wrong — those are the only two
outcomes.

**Do not resolve any thread.** The reviewer who raised it closes it on their
next pass, and you resolving your own critic is how a review becomes theatre.

Commit locally. The orchestrator pushes.
