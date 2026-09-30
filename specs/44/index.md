## Problem
Every lane draws rows in `compareWork` order — priority, then id: work order, not reading order. Rows carry no last-update time. Case: Waiting — unprioritised ticket updated today sits under every prioritised one, however stale.

## Decisions
- Needs you: priority, P0 first, unprioritised last; then least recently updated on top.
- Other lanes: most recently updated on top; priority ignored.
- Children: lane's rule, every depth — branch reads like its lane.
- Comment, label, close — Landrace's own too — re-dates row at next tick's list.

Choices:
- Date: source's `updatedAt`, was `createdAt`. Per reply: moves when ticket moves, like `since`, yet on every listed row; GitHub's list already answers it, no new call.
- `updatedAt` optional, display only, like `createdAt`: integrations lacking it compile; no snapshot path.
- Undated last — within priority in Needs you: no place in time; mirrors `compareWork`'s unprioritised-last.
- Branch keys: root's own `priority`, `updatedAt` — row lane lists.
- Ties: `compareIds` ascending — ids' reading order everywhere.
- Location: `boardView`, page draws as given — reuses `compareIds`, `URGENCY`; pure test.

## Technical design
- `src/namespace.ts` — `updatedAt`: optional on `Node`, `TicketRecord`, `PullRecord`; `BoardRow`'s `number | null`; `BoardView.rows` doc: display order.
- `src/kit/tracker.ts` — `updatedAtOf` beside `createdAtOf`; `ticketNode` carries it.
- `src/kit/forge.ts` — `pullNode` carries `updatedAt`.
- `.landrace/hooks/github.ts` — `ISSUE_FIELDS`, `SUB_ISSUE_FIELDS`, `PULL_FIELDS` ask `updatedAt`; `nodeOfIssue`, `pullNodeOf` pass it.
- `src/ui/board.ts` — `rowOf` copies `updatedAt`; new `laneOrder(lane)` comparator: `needs-you` → `priority`, `updatedAt` asc; else `updatedAt` desc; nulls last; then `compareIds`. `boardView`: `compareWork` traversal kept; each branch sorted, every depth, by root lane's `laneOrder`; `rows` by `URGENCY`, then `laneOrder`.
- `README.md` — `Node` listing: `updatedAt`; kit table: `updatedAtOf`; board paragraph: lane order.

## Done when
- Needs you: P0 root above P1 above unprioritised, whatever `updatedAt`; same priority, earlier `updatedAt` above later, undated below both.
- Agent running, Held elsewhere, Waiting, Not admitted, Done: later `updatedAt` above earlier, priority ignored; undated last.
- Equal keys: `compareIds` order (`9` before `10`).
- Children: newest first under Waiting root; priority, then oldest, under Needs you root.
- Root lifted into Needs you by child: placed by own `priority`, `updatedAt`.
- `/board.json`: GitHub issue, pull request rows carry `updatedAt` epoch ms; else `null`.
- `git diff main -- src/conventions.ts src/runner/tick.ts` empty.
- `npm test`, `npm run typecheck`, `npm run lint` pass.