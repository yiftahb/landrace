import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { loadConfig } from "#config/load.js";
import { createOtelSink, telemetrySettings } from "#telemetry/otel.js";

const on = (entries: Record<string, string> = {}): Map<string, string> =>
  new Map(Object.entries({ LANDRACE_ENABLE_TELEMETRY: "1", ...entries }));

describe("telemetrySettings", () => {
  it("is off unless LANDRACE_ENABLE_TELEMETRY is 1", () => {
    expect(telemetrySettings(new Map())).toBeNull();
    expect(telemetrySettings(new Map([["LANDRACE_ENABLE_TELEMETRY", "0"]]))).toBeNull();
    // Off means off: a shell's grpc setting for some other tool is not ours to refuse.
    expect(telemetrySettings(new Map([["OTEL_EXPORTER_OTLP_PROTOCOL", "grpc"]]))).toBeNull();
  });

  it("refuses an on switch it cannot read rather than staying quietly off", () => {
    expect(() => telemetrySettings(new Map([["LANDRACE_ENABLE_TELEMETRY", "true"]]))).toThrow(/set it to 1/);
  });

  it("fills in the defaults", () => {
    expect(telemetrySettings(on())).toEqual({
      exporter: "otlp",
      protocol: "http/protobuf",
      endpoint: "http://localhost:4318",
      headers: {},
      resource: { "service.name": "landrace" },
      intervalMs: 5000,
    });
  });

  it("reads every key it documents", () => {
    expect(telemetrySettings(on({
      OTEL_LOGS_EXPORTER: "console",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.com/",
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer%20abc, x-team = infra",
      OTEL_SERVICE_NAME: "landrace-ci",
      OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=dev,service.name=ignored",
      OTEL_LOGS_EXPORT_INTERVAL: "250",
    }))).toEqual({
      exporter: "console",
      protocol: "http/json",
      endpoint: "https://otel.example.com/",
      headers: { Authorization: "Bearer abc", "x-team": "infra" },
      resource: { "deployment.environment": "dev", "service.name": "landrace-ci" },
      intervalMs: 250,
    });
  });

  it("refuses grpc by name rather than downgrading it", () => {
    expect(() => telemetrySettings(on({ OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" }))).toThrow(/grpc is not supported/);
  });

  it("refuses the values it does not know", () => {
    expect(() => telemetrySettings(on({ OTEL_LOGS_EXPORTER: "zipkin" }))).toThrow(/OTEL_LOGS_EXPORTER/);
    expect(() => telemetrySettings(on({ OTEL_EXPORTER_OTLP_PROTOCOL: "http" }))).toThrow(/OTEL_EXPORTER_OTLP_PROTOCOL/);
    expect(() => telemetrySettings(on({ OTEL_LOGS_EXPORT_INTERVAL: "5s" }))).toThrow(/OTEL_LOGS_EXPORT_INTERVAL/);
    expect(() => telemetrySettings(on({ OTEL_EXPORTER_OTLP_ENDPOINT: "localhost:4318" }))).toThrow(/OTEL_EXPORTER_OTLP_ENDPOINT/);
  });

  // A header is usually a credential: the refusal says where, never what.
  it("refuses a header that is not key=value without printing it", () => {
    expect(() => telemetrySettings(on({ OTEL_EXPORTER_OTLP_HEADERS: "Bearer sekrit-token" })))
      .toThrow(/OTEL_EXPORTER_OTLP_HEADERS/);
    expect(() => telemetrySettings(on({ OTEL_EXPORTER_OTLP_HEADERS: "Bearer sekrit-token" })))
      .not.toThrow(/sekrit/);
  });

  describe("--telemetry and --otel", () => {
    it("override the environment", () => {
      expect(telemetrySettings(new Map([["OTEL_SERVICE_NAME", "env"]]), ["LANDRACE_ENABLE_TELEMETRY=1", "OTEL_SERVICE_NAME=cli"]))
        .toMatchObject({ resource: { "service.name": "cli" } });
    });

    it("refuse a key the table does not name, whether or not telemetry is on", () => {
      expect(() => telemetrySettings(new Map(), ["OTEL_TRACES_EXPORTER=otlp"])).toThrow(/--otel OTEL_TRACES_EXPORTER/);
      expect(() => telemetrySettings(new Map(), ["OTEL_SERVICE_NAME"])).toThrow(/KEY=VALUE/);
    });
  });

  // The whole chain, from files: CLI over .env over the shell.
  it("takes the command line over .env, and .env over the shell", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "lr-otel-")), ".landrace");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "landrace.yaml"), "version: 1\nagent: { adapter: claude }\n");
    await writeFile(join(dir, ".env"), "LANDRACE_ENABLE_TELEMETRY=1\nOTEL_SERVICE_NAME=from-file\nOTEL_LOGS_EXPORT_INTERVAL=100\n");
    process.env.OTEL_SERVICE_NAME = "from-shell";
    process.env.OTEL_LOGS_EXPORT_INTERVAL = "200";
    process.env.OTEL_LOGS_EXPORTER = "console";
    try {
      const { telemetry } = await loadConfig(dir);
      expect(telemetrySettings(telemetry)).toMatchObject({
        exporter: "console", intervalMs: 100, resource: { "service.name": "from-file" },
      });
      expect(telemetrySettings(telemetry, ["OTEL_SERVICE_NAME=from-cli"])).toMatchObject({
        exporter: "console", intervalMs: 100, resource: { "service.name": "from-cli" },
      });
    } finally {
      delete process.env.OTEL_SERVICE_NAME;
      delete process.env.OTEL_LOGS_EXPORT_INTERVAL;
      delete process.env.OTEL_LOGS_EXPORTER;
    }
  });
});

describe("createOtelSink", () => {
  // InMemoryLogRecordExporter forgets everything on its own shutdown, which
  // the provider's shutdown calls last — so it is kept from doing that here.
  const memory = (): InMemoryLogRecordExporter => {
    const exporter = new InMemoryLogRecordExporter();
    jest.spyOn(exporter, "shutdown").mockResolvedValue();
    return exporter;
  };

  it("turns an event into a log record: name, landrace.* attributes, severity and service.name", async () => {
    const exporter = memory();
    const otel = await createOtelSink(telemetrySettings(on({ OTEL_SERVICE_NAME: "lr-test" }))!, exporter);
    otel.sink({ name: "agent.event", ticket: "19", raw: "hello", n: 3, ok: true, usage: { in: 1 } });
    otel.sink({ name: "effect.failed", ticket: "19" });
    otel.sink({ name: "lock.stolen", ticket: "19" });
    await otel.shutdown();

    const records = exporter.getFinishedLogRecords();
    expect(records.map((r) => r.body)).toEqual(["agent.event", "effect.failed", "lock.stolen"]);
    expect(records[0]?.attributes).toEqual({
      "event.name": "agent.event",
      "landrace.ticket": "19",
      "landrace.raw": "hello",
      "landrace.n": 3,
      "landrace.ok": true,
      "landrace.usage": "{\"in\":1}",
    });
    expect(records.map((r) => [r.severityNumber, r.severityText])).toEqual([
      [SeverityNumber.INFO, "INFO"], [SeverityNumber.WARN, "WARN"], [SeverityNumber.WARN, "WARN"],
    ]);
    expect(records[0]?.resource.attributes["service.name"]).toBe("lr-test");
  });

  it("holds records in the batch until shutdown flushes them", async () => {
    const exporter = memory();
    const otel = await createOtelSink(telemetrySettings(on())!, exporter);
    otel.sink({ name: "tick.started" });
    expect(exporter.getFinishedLogRecords()).toHaveLength(0);
    await otel.shutdown();
    expect(exporter.getFinishedLogRecords()).toHaveLength(1);
  });

  it("reports a flush that failed rather than throwing it into the caller's finally", async () => {
    const exporter = memory();
    jest.spyOn(exporter, "export").mockImplementation((_logs, done) => done({ code: 1, error: new Error("collector down") }));
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const otel = await createOtelSink(telemetrySettings(on())!, exporter);
      otel.sink({ name: "tick.started" });
      await expect(otel.shutdown()).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledWith(expect.stringContaining("collector down"));
    } finally {
      error.mockRestore();
    }
  });
});
