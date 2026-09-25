---
capabilities: [tickets:create, repo:read]
model: opus
output:
  discriminator: kind
  shapes:
    children: {}
    single: {}
  routes:
    - when: { kind: children }
      effect: { type: tracker.comment, kind: output, marker: "output:{stage}:{round}", body: "Split into sub-tickets, round {round}." }
    - when: { kind: single }
      effect: { type: tracker.comment, kind: output, marker: "output:{stage}:{round}", body: "One piece of work; building it directly, round {round}." }
---

Decide whether #{node.id}: {node.title} should be built as one piece of work
or split into sub-tickets that can each be implemented and reviewed on their
own. The approved spec is at {artifacts.spec.url}.

Split only when the pieces are genuinely independent — each one small enough
for one pull request, and none of them needing another to be merged first.
When in doubt, do not split: one pull request is cheaper to review than three
that have to be read together.

To split, call `landrace_create_child` once for each sub-ticket, with a title
and a body that says exactly what that piece must do and how to tell it is
finished. Do not create a sub-ticket for work this ticket's own spec does not
ask for.

Sub-tickets from an earlier attempt no longer count toward this ticket. The
open ones have been closed; the finished ones stay closed as done, but their
work does not count as done here. Whatever work this spec still needs —
including work an earlier sub-ticket may already have covered — create again
now, and do not refer to the earlier ones.

Then end with a fenced json block, and nothing after it, whose only field is
`kind`: set to `children` if you created at least one sub-ticket, or to
`single` if you created none and this ticket should be built as is.
