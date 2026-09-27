# Wake the loop when a person acts

## Problem

A person's action through Landrace waits for the next scheduled tick. That can take up to `tick.interval`, which is `2m` in this repository.

- The board's Retry and "Go to step…" (`POST /tickets/<id>/retry|goto/<stage>` in `src/ui/server.ts`) write the tracker, then wait for the next tick. Recovering #19 with "Go to step… build" sat idle for up to two minutes.
- MCP writes behave the same way: `landrace_goto`, `landrace_reply`, `landrace_create_ticket`, `landrace_update_ticket`, `landrace_ask` and `landrace_resolve`. `landrace mcp` is a separate process from `landrace start`, so today it has no way to reach the loop.
- "Tick now" calls `schedule.trigger()` (`src/cli/start.ts:521`). When a manual tick is still in flight, it answers 409 "a tick is already running" and drops the request.

## Proposal

### 1. `Schedule.wake()` replaces `trigger()`

In `createSchedule` (`src/cli/start.ts`) and the `Schedule` interface (`src/namespace.ts`), the signature is `wake(): "started" | "queued" | "stopped"`.

- The schedule counts every run it starts, scheduled or woken, in `running`.
- **After `stop()`:** return `"stopped"` and run nothing, the same rule `trigger()` keeps today.
- **When `running === 0`:** run now, re-arm the countdown from now, and return `"started"`.
- **Otherwise:** set `pending = true` and return `"queued"`. Many wakes during one tick set the same flag, so they collapse into one follow-up.
- **When a run settles:** if `running === 0`, `pending` is set and the schedule is not stopped, clear `pending`, run once and re-arm.
- A wake never starts a tick alongside one in flight. Scheduled ticks keep their current overlap rule (`loop`'s comment: exclusion is per ticket), and `fire` is unchanged.
- `trigger()` and `manualInFlight` are removed. `POST /tick` was their only caller.

### 2. Board

In `src/ui/server.ts`, `UiOptions.tick` becomes `() => "started" | "queued" | "stopped"`, and `runStart` passes `schedule.wake`.

- **`POST /tick`:** answers 202 "tick started" or 202 "tick queued". A stopped schedule answers 503 "landrace is stopping". It no longer answers 409.
- **Retry and goto:** once `goto.send` resolves without `refused`, the route calls `opts.tick?.()` before answering 202. A refusal (409) or a throw (502) does not wake.
- **Page (`src/ui/page.ts`):** the tick button accepts either 202 and shows "queued" briefly when told so. Retry and goto already re-poll on success.

### 3. MCP → loop, through a wake file

This goes in a new `src/wake.ts`:

- `wakePath(dir) = join(sandboxRoot(dir), "wake")`. It is the same per-repository root that locks and worktrees use, so nothing is configured.
- `touchWake(path)` runs `mkdir -p` on the root, then writes an empty file to bump its mtime.
- `watchWake(path, wake, intervalMs = 1000): () => void` wraps `fs.watchFile`, which polls with `stat` and copes with a file that does not exist yet. It calls `wake()` whenever `mtimeMs` increases, and returns an unwatch function.

In `createTools` (`src/mcp/tools.ts`), `ToolOptions` gains `wake?: () => void`.

- Each of the six writing tools calls it after its write succeeds, and never after a throw.
- `waiting` and `status` never call it.
- If `wake` itself throws, the tool logs the failure and still returns its result, because the tracker write has already happened.

`buildMcpTools` (`src/cli/mcp.ts`) passes `wake: () => touchWake(wakePath(dir))`. The child server (`landrace_create_child`) gets nothing, so an agent cannot drive the loop. A write step's OS sandbox also cannot write the tmp root.

In `runStart`, unless `--once` is set, a `watchWake(wakePath(dir), schedule.wake)` starts before `loop` and is unwatched in its `finally`. `--once` has no loop, so it gets no watcher.

Every wake runs a full pass over all tickets. Hooks are unchanged, and the change stays vendor-neutral.

### Decisions on the issue's open points

- **Polling or `fs.watch`:** polling with `fs.watchFile` at 1 s. It is dull, works the same on every platform and copes with a missing file. One second of latency is enough.
- **Debounce:** none. Several writes inside the one-second poll window give one wake. Writes during a tick collapse into one follow-up.
- **`--once`:** no watcher.
- **What an MCP write says:** the answers are unchanged. The tool cannot know whether a `landrace start` is listening, and the ticket is picked up either way. The existing "on the next tick" wording is still true.

## Plan

1. **Schedule:** implement `wake()`, remove `trigger()` and update the `Schedule` type.
   - Tests go in `tests/cli/schedule.test.ts` and use fake timers and a deferred `run`.
   - An idle wake runs once at once, returns `"started"` and moves `nextAt` to now + interval.
   - Three wakes during a run return `"queued"` and give exactly one follow-up after the run settles, never overlapping it.
   - A wake during a scheduled tick queues and does not overlap.
   - A queued follow-up does not run if `stop()` comes before the run settles.
   - A wake after `stop()` returns `"stopped"`, runs nothing and arms no timer.
2. **Board:** update `/tick`, add the wake after a successful goto or Retry, and update the page button.
   - Tests go in `tests/ui/server.test.ts`.
   - `/tick` answers 202 "tick queued" when `tick` returns `"queued"`, and 503 when it returns `"stopped"`.
   - A successful Retry and a successful goto each call `tick` once. A refused send and a throwing send never call it.
3. **Wake file and MCP:** add `src/wake.ts` and the `ToolOptions.wake` wiring in `createTools` and `buildMcpTools`.
   - `touchWake` creates a missing root and file, and bumps the mtime on a second call.
   - Against the in-memory tracker, each of the six write tools calls `wake` once on success.
   - A write that throws (for example an `lr:` label in `update_ticket`) does not call `wake`, nor do `waiting` and `status`.
   - A throwing `wake` does not fail the tool.
4. **`start`'s watcher:** wire `watchWake` in `runStart` (not with `--once`) and unwatch it on shutdown.
   - Tests use a real temp file and a short interval.
   - Touching the file calls `wake`, and so does creating it after the watch started.
   - Nothing fires after unwatch.

## Done when

- Unit tests for the schedule, the server, the MCP tools, `wake.ts` and the watcher pass, and so does the rest of the suite (`npm test`).
- **Live check** with `landrace start` running and `tick.interval` at `2m`:
  - "Go to step…" on the board starts a tick within about a second.
  - `landrace_reply` from an MCP client starts a tick within about 1–2 seconds.
  - "Tick now" pressed during a running tick answers "queued", and a second tick starts right after the first ends.
  - In each case the board's countdown resets to the full interval.

## Out of scope

- Actions taken directly on the tracker, which would need webhooks.
- Changing `tick.interval`.
- Passes scoped to one ticket.