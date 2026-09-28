Brainstorming (bounded path, no one to approve here — settling it myself). Writing the spec now.

## Problem
Step front matter sets `model`, never effort. Every `claude -p` run takes the CLI's default effort. `spec.md` on `model: opus` can't ask for `high`. `agent:` in `.landrace/landrace.yaml` has no effort default either.

## Decisions
- Operator sets `agent.effort: high` in `.landrace/landrace.yaml`. Every step and turn runs `claude … --effort high`.
- Step author adds `effort: low` beside `model: haiku` in the step's front matter. That step runs `--effort low` and every other step keeps `high`.
- Bad value (`effort: extreme`) → hook refuses. `agent.effort` fails at startup. Step `effort` fails when the run starts, with a message naming the allowed levels.
- `step.invoked` log shows `effort`, or `null` when the step named none.
- Effort mirrors `model` exactly: step wins over `agent.effort`, absent = executor default. One pattern, nothing new to learn.
- Engine treats effort as opaque string, same as `model`. Level names are the provider's words. Claude hook checks them.
- Claude hook allows `low`, `medium`, `high`, `xhigh`, `max`. Unknown value fails closed, same as capabilities.
- Conversation turns carry the step's effort, same as its model. A turn must not run cheaper than its step.
- Screener gets no effort. `security` block unchanged. Out of scope.
- Board UI unchanged. Log only.

## Technical design
- `src/workflow/schema.ts` — `stepFrontMatterSchema` gains optional `effort: z.string().min(1)`.
- `src/namespace.ts` — `Executor.run` opts gain optional `effort?: string`. Doc matches `model`: step's value wins, absent = operator decides, executor that can't honour it refuses.
- `src/runner/step.ts` — `runStep` passes `step.effort` when set. `step.invoked` payload gains `effort: step.effort ?? null`.
- `src/mcp/conversation.ts` — turn's `executor.run` passes `step.effort` when set.
- `.landrace/hooks/claude.ts` — `ClaudeSettings` and `createClaudeExecutor` opts gain `effort`. New `EFFORTS` list. `SETTING_KEYS` gains `effort`. `readClaudeSettings` checks `agent.effort` against `EFFORTS`. `run` picks `chosenEffort = stepEffort ?? effort`, refuses a value outside `EFFORTS` and pushes `--effort`. `step.completed` log gains `effort`. `claude` factory passes `settings.effort`.
- `.landrace/landrace.yaml` — `agent.effort: high`.
- `README.md` — `agent.*` row lists `effort`. Step front-matter table gains `effort` row: overrides `agent.effort`.

## Done when
- `landrace.yaml` with `agent.effort: high` → each step's `claude` argv holds `--effort high`.
- Step front matter `effort: low` → that step's argv holds `--effort low`, not `high`.
- Step with no `effort` and no `agent.effort` → argv has no `--effort`.
- `agent.effort: extreme` → startup error naming `agent.effort`.
- Step `effort: extreme` → run refused and the error lists the allowed levels.
- Conversation turn on an `effort: low` step → argv holds `--effort low`.
- `step.invoked` log line carries `effort`: the value, or `null`.
- Screener argv never holds `--effort`.
- `pnpm test` and `landrace validate` on `.landrace` pass.