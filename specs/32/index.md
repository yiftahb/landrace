## Problem
`.landrace/hooks/claude.ts`: 1,051 lines, mostly not Claude — process handling, env scrub, argument/cwd/capability checks, MCP, sandbox. Copied per project, rewritten per agent; forget #33's post-await abort check → lock, worktree held to timeout.

## Decisions
1. Hook: `export const claude = new Claude();`. Codex: `new Codex()`, `agent.adapter: codex`.
2. `landrace validate`/`start` refuse, naming: unknown `agent.*` key, step effort outside set, unenforceable sandbox setting.
3. Codex pairing: person runs `codex resume <engine id>`; Finish forks it; fresh pairing refused with reason, then Release.

- `BaseExecutor` = `ExecutorFactory` branded by `defineExecutor(this)`: loader, `Executor` unchanged.
- Optional `ExecutorContext.steps`: `create()` refuses step efforts at load.
- Both read root `.mcp.json`, no TOML parser; Codex servers per run, `-c mcp_servers.<name>.*`: nothing to shadow.
- Codex continue copies agent's session under engine's id, like `bringSession`: Codex cannot name forks.
- Codex screener: `-s read-only`, built-in tools off via `-c`, no server, or refused.
- Enforce or refuse: Codex refuses `deny` entries unless binary denies reads (`deny: []` opts out), and runs loading project `.codex/config.toml`.

## Technical design
- `src/kit/executor.ts` (new) — `BaseExecutor`: templates, `build(settings)`; hooks `argv`, `prepare`, `readEvent`, `handoffArgv`, `readExtras`, `sandboxProblems`, `mcpFile`; declares `efforts`, `pairings`, `envKeys`.
- `src/namespace.ts` — `KitSettings`, `Tier`, `RunPlan`, `HandoffPlan`, `PairingKind`, `EventReading`; `ExecutorContext.steps`.
- `src/cli/start.ts`, `src/cli/validate.ts`, `src/cli/mcp.ts` — pass `steps`.
- `integrations/claude/index.ts` (new) — `Claude`: today's argv, stream-json, `bringSession` as `prepare`; keeps `createClaudeExecutor`, `readClaudeSettings` for moved tests.
- `integrations/codex/index.ts` (new) — `Codex`: ticket's flags, `CODEX_HOME` env; `thread.started` → id, `agent_message` → message (last = text), command/file/MCP items → tool lines, `turn.failed` → reject.
- `.landrace/hooks/claude.ts` — `new Claude()` only.
- `package.json` — `./kit`, `./integrations/*` exports; lint `integrations`.
- `tsup.config.ts` — kit, integration entries; `landrace/*` external.
- `tsconfig.json` — `integrations` included; `landrace/*` paths.
- `jest.config.mjs` — same mappings.
- `tests/boundaries.test.ts` — `codex` in `src/` fails, board links aside; `integrations/` imports only `landrace/kit`, `landrace/hooks`, `node:*`.
- `README.md`, `.agsync/instructions.md` — kit, integrations, Codex.

## Done when
- `pnpm typecheck`, `lint`, `test`, `build` pass.
- Moved Claude tests pass under `tests/integrations/`, imports only changed.
- Live haiku run via `new Claude()`: argv byte-identical to today's.
- Fake agent: abort during `prepare()` never spawns.
- Codex handoff without agent session: refused, reason given.
- `landrace validate`, `new Codex()`, shipped steps: names spec's `max`.
- Live Codex run, smallest model: text, session id.
- Live Codex screening passes nonce check.
- Live Codex Finish forks handed-off session.