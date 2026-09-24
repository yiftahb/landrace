# Spec #19: OpenTelemetry export of landrace events

## Problem

Landrace's events (`tick.*`, `step.*`, `effect.*`, `lock.*`, `screen.*`, `agent.event`, …) only go to stdout as JSON lines (`createLogger` in `src/runner/events.ts`, sink in `src/cli/start.ts:489`). The only consumer is the triage page. Nothing can send them to a collector, so you can't see them in Grafana, Honeycomb, Datadog, etc.

Agent output is the most useful event and the hardest to reach. `agent.event` is in `DEBUG_ONLY`, so the logger drops it before any sink sees it unless `--debug` is on. `--debug` also floods the terminal.

`src/namespace.ts:516` already expects this feature: "an OpenTelemetry exporter should later subscribe to this rather than require a rewrite."

## Proposal

Export every landrace event as an OTel **log record**. This is the same model Claude Code uses: events become logs, not traces. The exporter is a second sink on the existing logger. Event names and call sites stay as they are.

### Configuration

Use the variable names Claude Code uses, with our own on/off switch:

| Variable | Meaning | Default |
|---|---|---|
| `LANDRACE_ENABLE_TELEMETRY` | `1` turns export on | off |
| `OTEL_LOGS_EXPORTER` | `otlp` or `console` | `otlp` |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` or `http/json` | `http/protobuf` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | collector base URL | `http://localhost:4318` |
| `OTEL_EXPORTER_OTLP_HEADERS` | `k=v,k=v` (auth) | none |
| `OTEL_SERVICE_NAME` | `service.name` | `landrace` |
| `OTEL_RESOURCE_ATTRIBUTES` | extra resource attributes | none |
| `OTEL_LOGS_EXPORT_INTERVAL` | batch delay in ms | `5000` |

Sources, highest precedence first:
1. **Command line:** `--telemetry` sets `LANDRACE_ENABLE_TELEMETRY=1`. `--otel KEY=VALUE` is repeatable and accepts only the keys in the table. An unknown key is a startup error.
2. **`.landrace/.env`**
3. **Shell environment**

Sources 2 and 3 already merge in `loadConfig` (`src/config/load.ts:100-108`). Expose the resolved `LANDRACE_ENABLE_TELEMETRY` and `OTEL_*` entries from that merged map on `LoadedConfig`, then layer the CLI values on top.

`grpc` is refused at startup with a clear message rather than silently downgraded. Document all of this in `.landrace/.env.example` and the README.

### Wiring

- **New file `src/telemetry/otel.ts`:** `createOtelSink(settings)` returns `{ sink(e: LandraceEvent), shutdown(): Promise<void> }`.
  - It uses `@opentelemetry/sdk-logs` with a `BatchLogRecordProcessor` and the OTLP HTTP log exporter.
  - The SDK is loaded with a dynamic `import()` only when telemetry is on. With telemetry off, nothing is loaded and nothing goes over the network.
- **`createLogger` (`src/runner/events.ts`):** add an optional `exporter` sink.
  - It receives every event, including `agent.event` and `snapshot.built`, whether or not `--debug` is on.
  - It gets the same redacted payload the stdout sink gets.
  - The `DEBUG_ONLY` gate keeps applying to stdout only.
  - An exporter throw is caught and reported via `console.error`. Telemetry must never abort a step (same rule as `boardSink`).
- **Record mapping:**
  - Body is the event name, and attribute `event.name` is the event name too.
  - Every other field becomes an attribute prefixed `landrace.`, e.g. `landrace.ticket` and `landrace.raw` for agent output. Non-primitive values are JSON-stringified.
  - Severity is `WARN` for `*.failed`, `*.denied`, `*.blocked` and `lock.stolen`. Everything else is `INFO`.
- **Entry points:**
  - `buildRuntime` (`src/cli/start.ts`) and `src/cli/mcp.ts` build the sink when telemetry is enabled and pass it to `createLogger`.
  - `runStart` calls `shutdown()` in its `finally`, which covers `--once`, normal stop and the first Ctrl-C. That way queued records are flushed before exit.

### Out of scope

- Traces and metrics.
- Passing `OTEL_*` / `CLAUDE_CODE_ENABLE_TELEMETRY` through to the Claude subprocess. `childEnv` (`src/agent/claude.ts:64-89`) deliberately keeps credentials out of the agent. `OTEL_EXPORTER_OTLP_HEADERS` is usually a credential, so this needs its own decision.
- The `grpc` protocol.

## How we'll know it worked

- **Unit (`tests/runner/events.test.ts`):**
  - With an `exporter` sink and `debug: false`, `agent.event` reaches the exporter but not stdout.
  - Secret values come out `[redacted]` in exported payloads.
  - An exporter that throws does not stop the stdout sink or the caller.
- **Unit (`tests/telemetry/otel.test.ts`):** use the SDK's `InMemoryLogRecordExporter`.
  - Records carry `event.name`, `landrace.*` attributes, the right severity, and `service.name` taken from `OTEL_SERVICE_NAME`.
  - `shutdown()` flushes.
- **Config:**
  - CLI `--otel` beats `.env`, which beats the shell.
  - An unknown `--otel` key and `OTEL_EXPORTER_OTLP_PROTOCOL=grpc` are startup errors.
  - Telemetry off means the SDK is never imported.
- **Manual:**
  - Run an OTel collector with the `debug` exporter on `:4318`.
  - Run `landrace start --once --telemetry` against a ticket that runs a step.
  - The collector prints `tick.started`, `step.invoked`, `agent.event` (with the agent's output in `landrace.raw`) and `step.finished` records under `service.name=landrace`.
- `pnpm typecheck && pnpm lint && pnpm test` pass.

## Notes

- `superpowers:brainstorming` and `superpowers:writing-plans` are not installed in this session, so they were not used.
- `codebase-memory-mcp` exposed no tools here. The codebase was read directly instead.