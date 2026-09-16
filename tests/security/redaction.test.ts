import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, redactionValues } from "#config/load.js";
import { createLogger } from "#runner/events.js";
import type { LandraceEvent } from "#namespace.js";

const TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";

async function fixture(redact: string): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), "landrace-redact-")), ".landrace");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "landrace.yaml"), `version: 1
agent: { adapter: claude }
tracker: { repo: acme/widgets }
log: { redact: ${redact} }
secrets: { githubToken: $GITHUB_TOKEN }
`);
  await writeFile(join(dir, ".env"), `GITHUB_TOKEN=${TOKEN}`);
  return dir;
}

/**
 * `log.redact` lists secret *names*. Splitting a log line on the literal
 * string "githubToken" redacts nothing at all, so the resolution has to
 * happen at wiring time and the logger has to be given values.
 */
describe("redaction works on the secret, not on its name", () => {
  it("resolves the configured names to the values they stand for", async () => {
    const loaded = await loadConfig(await fixture("[githubToken]"));
    expect(redactionValues(loaded)).toEqual([TOKEN]);
  });

  it("refuses to start when a redact name matches no secret", async () => {
    const loaded = await loadConfig(await fixture("[githubToken, slackToken]"));
    expect(() => redactionValues(loaded)).toThrow(/slackToken/);
  });

  it("keeps the token out of a nested object and out of an error message", async () => {
    const seen: LandraceEvent[] = [];
    const log = createLogger({ sink: (e) => seen.push(e), redactValues: redactionValues(await loadConfig(await fixture("[githubToken]"))) });
    log("step.rejected", {
      request: { headers: { Authorization: `Bearer ${TOKEN}` } },
      error: `GET /issues → 401 bad credentials for ${TOKEN}`,
    });
    expect(JSON.stringify(seen)).not.toContain(TOKEN);
    expect(JSON.stringify(seen)).toContain("[redacted]");
  });

  it("does not redact when handed the name instead of the value", async () => {
    // The shape of the original bug, pinned so it cannot come back through a
    // caller that passes config.log.redact straight through.
    const seen: LandraceEvent[] = [];
    createLogger({ sink: (e) => seen.push(e), redactValues: ["githubToken"] })(
      "step.rejected", { error: `Bearer ${TOKEN}` });
    expect(JSON.stringify(seen)).toContain(TOKEN);
  });
});

describe("a redaction value too short to be a secret is refused, not applied", () => {
  it("would shred every log line, so a whitespace value is a build-time error", () => {
    // `.env` values get quoted and exported by hand; " " and "\n" both arrived
    // here, and splitting a log line on them redacted between every character.
    for (const value of [" ", "\n", "", "tok"]) {
      expect(() => createLogger({ sink: () => {}, redactValues: [value] })).toThrow(/8 characters/);
    }
  });

  it("names the secret whose configured value is too short", async () => {
    const dir = await mkdtemp(join(tmpdir(), "landrace-redact-"));
    await writeFile(join(dir, "landrace.yaml"), `version: 1
agent: { adapter: claude }
tracker: { repo: acme/widgets }
log: { redact: [githubToken] }
secrets: { githubToken: $GITHUB_TOKEN }
`);
    await writeFile(join(dir, ".env"), "GITHUB_TOKEN= \n");
    const loaded = await loadConfig(dir);
    expect(() => redactionValues(loaded)).toThrow(/githubToken/);
  });

  it("serialises an Error instead of logging an empty object", () => {
    // Object.entries skips message and stack, so an error logged as a value
    // became {} — and a token inside it never reached the redactor either.
    const seen: LandraceEvent[] = [];
    createLogger({ sink: (e) => seen.push(e), redactValues: [TOKEN] })(
      "step.rejected", { cause: new Error(`401 for ${TOKEN}`) });
    const logged = JSON.stringify(seen);
    expect(logged).toContain("401 for [redacted]");
    expect(logged).not.toContain(TOKEN);
    expect(seen[0]?.cause).toMatchObject({ name: "Error" });
  });
});
