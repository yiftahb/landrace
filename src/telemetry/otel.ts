import type { LogRecord } from "@opentelemetry/api-logs";
import type { LogRecordExporter } from "@opentelemetry/sdk-logs";
import type { LandraceEvent } from "#namespace.js";
import { messageOf } from "#runner/errors.js";

/**
 * Every setting telemetry reads, by the names Claude Code uses for the same
 * thing, plus our own switch. `loadConfig` picks exactly these out of the
 * merged `.env`-over-shell map, and `--otel` accepts exactly these.
 */
export const TELEMETRY_KEYS = [
  "LANDRACE_ENABLE_TELEMETRY",
  "OTEL_LOGS_EXPORTER",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_SERVICE_NAME",
  "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_LOGS_EXPORT_INTERVAL",
] as const;

export interface TelemetrySettings {
  exporter: "otlp" | "console";
  protocol: "http/protobuf" | "http/json";
  /** The collector's base URL; `/v1/logs` is appended to it. */
  endpoint: string;
  headers: Record<string, string>;
  /** `OTEL_RESOURCE_ATTRIBUTES`, with `service.name` always set. */
  resource: Record<string, string>;
  intervalMs: number;
}

export interface OtelSink {
  sink(e: LandraceEvent): void;
  /** Flushes what is queued. Never rejects: it runs in a `finally`. */
  shutdown(): Promise<void>;
}

const oneOf = <T extends string>(key: string, value: string, allowed: readonly T[]): T => {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${key} is "${value}"; it must be one of ${allowed.join(", ")}`);
};

/**
 * `k=v,k=v`, values percent-decoded as the OTel spec has them. A malformed
 * entry is named by position, never quoted: in the headers it is usually a
 * credential.
 */
function pairs(key: string, text: string): Record<string, string> {
  const out: Record<string, string> = {};
  text.split(",").map((entry) => entry.trim()).filter(Boolean).forEach((entry, i) => {
    const at = entry.indexOf("=");
    if (at < 1) throw new Error(`${key}: entry ${i + 1} is not key=value`);
    const value = entry.slice(at + 1).trim();
    try {
      out[entry.slice(0, at).trim()] = decodeURIComponent(value);
    } catch {
      out[entry.slice(0, at).trim()] = value;
    }
  });
  return out;
}

/**
 * What telemetry will do, or null when it is off.
 *
 * `env` is `.env` over the shell (`LoadedConfig.telemetry`); `overrides` are
 * `--otel KEY=VALUE` pairs, `--telemetry` among them as
 * `LANDRACE_ENABLE_TELEMETRY=1`, and win over both. An override naming a key
 * this does not read is refused whether telemetry is on or not — it is a typo
 * on the command line. Everything else is only checked when telemetry is on:
 * a shell exporting `grpc` for some other tool is not ours to refuse.
 */
export function telemetrySettings(env: ReadonlyMap<string, string>, overrides: readonly string[] = []): TelemetrySettings | null {
  const merged = new Map(env);
  for (const pair of overrides) {
    const at = pair.indexOf("=");
    if (at < 1) throw new Error(`--otel takes KEY=VALUE, got "${pair.split("=")[0]}"`);
    const key = pair.slice(0, at);
    if (!(TELEMETRY_KEYS as readonly string[]).includes(key)) {
      throw new Error(`--otel ${key} is not a setting landrace reads; it reads ${TELEMETRY_KEYS.join(", ")}`);
    }
    merged.set(key, pair.slice(at + 1));
  }
  const get = (key: (typeof TELEMETRY_KEYS)[number]): string | undefined => merged.get(key)?.trim() || undefined;

  const enabled = get("LANDRACE_ENABLE_TELEMETRY") ?? "0";
  if (enabled === "0") return null;
  if (enabled !== "1") {
    throw new Error(`LANDRACE_ENABLE_TELEMETRY is "${enabled}"; set it to 1 to turn telemetry on, or 0 to leave it off`);
  }

  const protocol = get("OTEL_EXPORTER_OTLP_PROTOCOL") ?? "http/protobuf";
  if (protocol === "grpc") {
    throw new Error("OTEL_EXPORTER_OTLP_PROTOCOL=grpc is not supported; use http/protobuf (port 4318) or http/json");
  }
  const endpoint = get("OTEL_EXPORTER_OTLP_ENDPOINT") ?? "http://localhost:4318";
  if (!/^https?:\/\//.test(endpoint) || !URL.canParse(endpoint)) {
    throw new Error(`OTEL_EXPORTER_OTLP_ENDPOINT is "${endpoint}"; it must be an http:// or https:// URL`);
  }
  const interval = get("OTEL_LOGS_EXPORT_INTERVAL") ?? "5000";
  if (!/^[1-9]\d*$/.test(interval)) {
    throw new Error(`OTEL_LOGS_EXPORT_INTERVAL is "${interval}"; it must be a whole number of milliseconds`);
  }

  return {
    exporter: oneOf("OTEL_LOGS_EXPORTER", get("OTEL_LOGS_EXPORTER") ?? "otlp", ["otlp", "console"]),
    protocol: oneOf("OTEL_EXPORTER_OTLP_PROTOCOL", protocol, ["http/protobuf", "http/json"]),
    endpoint,
    headers: pairs("OTEL_EXPORTER_OTLP_HEADERS", get("OTEL_EXPORTER_OTLP_HEADERS") ?? ""),
    resource: {
      ...pairs("OTEL_RESOURCE_ATTRIBUTES", get("OTEL_RESOURCE_ATTRIBUTES") ?? ""),
      "service.name": get("OTEL_SERVICE_NAME") ?? "landrace",
    },
    intervalMs: Number(interval),
  };
}

const WARN = /\.(failed|denied|blocked)$/;

/**
 * A logger sink that ships every event to a collector as an OTel log record.
 *
 * The SDK is imported here, and only here, so a process with telemetry off
 * never loads it. `exporter` replaces the one the settings name — for tests.
 */
export async function createOtelSink(settings: TelemetrySettings, exporter?: LogRecordExporter): Promise<OtelSink> {
  const { LoggerProvider, BatchLogRecordProcessor, ConsoleLogRecordExporter } = await import("@opentelemetry/sdk-logs");
  const { resourceFromAttributes } = await import("@opentelemetry/resources");
  const { SeverityNumber } = await import("@opentelemetry/api-logs");

  const out = exporter ?? (settings.exporter === "console" ? new ConsoleLogRecordExporter() : await otlp(settings));
  // The SDK hands a failed export to its diagnostic logger, which is silent
  // unless configured — so a collector that is down or a wrong endpoint would
  // look exactly like telemetry working. Said once per failing streak, not
  // once per batch, so a collector that stays down does not flood stderr.
  let failing = false;
  const reporting: LogRecordExporter = {
    export: (records, done) =>
      out.export(records, (result) => {
        if (result.code !== 0 && !failing) {
          console.error(`landrace: telemetry could not export ${records.length} record(s): ${messageOf(result.error)}`);
        }
        failing = result.code !== 0;
        done(result);
      }),
    shutdown: () => out.shutdown(),
    forceFlush: () => out.forceFlush(),
  };
  const provider = new LoggerProvider({
    resource: resourceFromAttributes(settings.resource),
    processors: [new BatchLogRecordProcessor({ exporter: reporting, scheduledDelayMillis: settings.intervalMs })],
  });
  const logger = provider.getLogger("landrace");

  const record = ({ name, ...fields }: LandraceEvent): LogRecord => {
    const warn = WARN.test(name) || name === "lock.stolen";
    const attributes: Record<string, string | number | boolean> = { "event.name": name };
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      attributes[`landrace.${key}`] =
        typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : JSON.stringify(value);
    }
    return {
      body: name,
      severityNumber: warn ? SeverityNumber.WARN : SeverityNumber.INFO,
      severityText: warn ? "WARN" : "INFO",
      attributes,
    };
  };

  return {
    sink: (e) => logger.emit(record(e)),
    shutdown: () =>
      provider.shutdown().catch((e: unknown) => {
        console.error(`landrace: telemetry could not flush its last records: ${messageOf(e)}`);
      }),
  };
}

async function otlp(settings: TelemetrySettings): Promise<LogRecordExporter> {
  const { OTLPLogExporter } = settings.protocol === "http/json"
    ? await import("@opentelemetry/exporter-logs-otlp-http")
    : await import("@opentelemetry/exporter-logs-otlp-proto");
  return new OTLPLogExporter({ url: `${settings.endpoint.replace(/\/+$/, "")}/v1/logs`, headers: settings.headers });
}
