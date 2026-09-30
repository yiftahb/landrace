## Problem
Every lane draws rows in `boardView`'s `compareWork` order: priority, then id — work order, not reading order. Case: Waiting — ticket opened today, unprioritised, sits under every prioritised one, however old.

## Decisions
Seen on board:
- Needs you: P0 branches top, then P1…, unprioritised last; within one priority, earliest opened on top.
- Agent running, Held elsewhere, Waiting, Not admitted, Done: latest opened on top; priority ignored.
- Undated (no `createdAt`): last in its priority in Needs you, last in lane elsewhere.
- Children: lane's rule, every depth.

Choices:
- Date: `createdAt`, every lane. `since` set only while agent runs or pairing holds — null on every `needs-you`, `waiting`, `not-admitted`, `discharged` row; patchy in Agent running, Held elsewhere (lifted roots, foreign locks). No record of when ticket began needing you: opened earliest stands in for longest waiting.
- Undated last: no place in time; mirrors `compareWork`'s unprioritised-last.
- Children too: one rule per lane; branch reads like its lane.
- Branch keys: root row's own `priority`, `createdAt` — row lane lists; its P chip explains its place.
- Ties: `compareIds` ascending — ids' reading order everywhere.
- Location (ticket's open question): `boardView`; page draws as given. Server owns row order, lane cascade; `compareIds`, `URGENCY` reused, not copied into page script; typed pure test.

## Technical design
- `src/ui/board.ts` — new `laneOrder(lane: Lane)`, `BoardRow` comparator: `needs-you` → `priority` asc, `createdAt` asc; other lanes → `createdAt` desc; nulls last; then `compareIds`. `boardView`: traversal keeps `compareWork`; once root's `lane` set, sort branch `children` every depth by `laneOrder(lane)`; `rows` by `URGENCY` index, then `laneOrder`.
- `src/namespace.ts` — `BoardView.rows` doc: display order, lane by lane.
- `tests/ui/board.test.ts` — sibling-order test pins lane order, not `compareWork`.
- `README.md` — board paragraph: one sentence on lane order.

## Done when
- Needs you: P0 root above P1 above unprioritised, whatever `createdAt`.
- Needs you, same priority: earlier `createdAt` above later; undated below both.
- Agent running, Held elsewhere, Waiting, Not admitted, Done: later `createdAt` above earlier, priority ignored; undated last.
- Equal keys: `compareIds` order (`9` before `10`), identical across calls.
- Children: newest first under Waiting root; priority, then oldest, under Needs you root.
- Root lifted into Needs you by child sorts by its own `priority`, `createdAt`.
- `git diff main -- src/conventions.ts src/runner/tick.ts` empty.
- `npm test`, `npm run typecheck`, `npm run lint` pass.