## Problem
A record counts only when its author is the tracker's current login (`entriesFromComments`, `src/conventions.ts`). After a login change, old records read as `kind: "human"`: finished stages re-run, reply triggers fire, and nothing is logged. If a former login were trusted forever, its person could forge records after the switch.

## Decisions
Flow:
1. Before the first `start` under the new login, the operator sets `tracker.formerLogins: [{ login, until }]`, with `until` = the moment of the switch.
2. `validate` refuses a blank `login`, and an `until` that is missing or has no offset.
3. A former login's mark counts only when it was created and last edited at or before its `until`. Items resume.
4. Every other mark is foreign: neither a record nor a reply. Each process logs one `records.foreign` per item: `item`, `count`, `authors: [{ login, why }]`.

Choices:
- Changed this round: on Jira, a former login's comment marker counts within its cutoff. Jira's `updated` maps to `updated_at`. Reason: strict distrust re-runs finished stages on every Jira migration.
- A rewrite of Jira's `landrace.marker` property carries no time. It is an accepted, documented limit, not `no-time`.
- Times come from the tracker, never from the body. A missing created time, or a missing edit time on a comment, gives `no-time`: abstain.
- `why` is `unlisted`, `after-until` or `no-time`, so the operator knows what to fix.
- `until` needs an offset: a bare date has no timezone.
- The current login gets no time check.
- An item's origin judges its author at `createdAt` and its editor at `editedAt`. An item never edited needs no edit time.
- GitHub REST reviews carry no edit time, so a former login's review is foreign. Worst case: one duplicate review.
- Kept: one required `Logins` value for tracker and forge. Key absent → `[]`. Snapshot without `tracker.former` → halt. A plain comment is a reply.

## Technical design
- `src/namespace.ts` — `FormerLogin { login: string; until: string }`, `Logins { current: string; former: readonly FormerLogin[] }`, `MarkTrust = "ours" | "unlisted" | "after-until" | "no-time"`. Adds `TrackerComment.updated_at?`, `ThreadComment.created_at: string` and `updated_at?`, `ItemRecord.editedAt?`. `EventName` gains `"records.foreign"`.
- `src/config/schema.ts` — `tracker.formerLogins`: strict `{ login, until }`; `login` non-blank; `until` is `datetime({ offset: true })`; default `[]`.
- `src/conventions.ts` — `markTrust(author, { created, edited }, logins): MarkTrust`, `formerLoginsOf(config)`, `foreignRecords(comments, logins)`, `parseOrigin(body, author, created, logins)`. `entriesFromComments(comments, logins)` drops every mark that is not `ours`.
- `src/kit/tracker.ts` — `loginsOf(snapshot)` replaces `botLoginOf`. `wroteIt` and `itemNode` take `Logins`. Protected `logins(ctx)`. `observe` writes `tracker: { bot, former }` and logs the event. `provides()` adds `tracker.former`.
- `src/kit/forge.ts` — `answered`, `threadCounts`, `threadsBrief`, `commentLine`, `threadLine` and reply dedupe take `Logins`. `reviews(pull, ctx): Promise<ThreadComment[]>`; the base keeps `ours`.
- `integrations/github/client.ts` — `Comment.updated_at`. `listReviews` reads `user` and `submitted_at`.
- `integrations/github/issues.ts` — `editedAt` from `lastEditedAt`. Comment `updated_at`.
- `integrations/github/forge.ts` — the thread query adds `createdAt lastEditedAt`. `reviews` answers authors.
- `integrations/gitlab/forge.ts` — notes map both times. `reviews` answers authors. Finding dedupe uses `markTrust`.
- `integrations/jira/tracker.ts` — `comments()` reads `updated` → `updated_at`. A missing `created` stays `""`, which gives `no-time`. `editors()` adds the change time → `editedAt`. `worklogLogged` takes `Logins`.
- `src/testing/external-state.ts` — comments, threads and reviews carry settable times. `observe` records `former`.
- `docs/configuration.md` — config row.
- `docs/remote.md` — "From a local instance": set `until`. Jira limit: remove "Edit Own Comments" from former accounts, or deactivate a former bot, before the switch. Event row.
- `docs/security.md` — why trust ends at `until`, and the Jira property limit.
- `docs/hooks.md` — `loginsOf`, `markTrust`.

## Done when
- With `old` until T and login `new`, an `old` marker created and edited before T counts: the finished stage is not re-entered and nothing is posted.
- Created after T: `after-until`. Edited after T: `after-until`. No `updated_at`: `no-time`.
- The same three hold for a thread comment, a review and a fix reply, on GitHub and on GitLab.
- A Jira marker by `old`, created and with `updated` before T, counts. The same comment with `updated` after T is `after-until`. With no `created`, it is `no-time`.
- Without the list, `old` marks are absent from `entries` and from `run.lastHuman`, and a `run.lastHuman.at` trigger stays silent. Over two ticks, there is one `records.foreign`: the item, the count, `old` with `unlisted`.
- An author in neither list completes, blocks and counts nothing, whether by comment, origin, thread or review.
- A plain comment from any author is `run.lastHuman`.
- Records by `old`, then `new`, form one run, and counters continue.
- `validate` refuses `login: " "`, a missing `until`, and `until: "2026-11-01"`.
- A config without the key does not halt, and old marks are foreign. A snapshot without `tracker.former` makes `satisfied()` halt.
- The child server and `landrace mcp` apply the cutoff.
- An origin by `old` before T, never edited, is kept. Edited by `old` after T, or with the edit time missing, it is lost.

// Generated by AI (claude-opus-5-5:high)