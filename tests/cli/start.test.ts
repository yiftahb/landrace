import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntime, createInterrupt, parseInterval } from "../../src/cli/start.js";

const TOKEN = "ghp_a_token_long_enough_to_redact";

/**
 * A workflow directory on disk, because that is the only thing `buildRuntime`
 * takes: every failure it exists to report is a file a person can go and edit,
 * and a fixture built out of objects would prove nothing about reading them.
 *
 * No `hooks:` list, so nothing is imported — the default jest pass cannot
 * import a module by file URL at all (see jest.esm.config.mjs), and the tests
 * that need a real hook module live in tests/esm/cli-start.test.ts.
 */
async function fixture(config: Partial<Record<"log" | "agent" | "extra", string>> = {}): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), "lr-start-")), ".landrace");
  await mkdir(join(dir, "steps"), { recursive: true });
  await cp("tests/fixtures/minimal/workflow.yaml", join(dir, "workflow.yaml"));
  await cp("tests/fixtures/minimal/steps/spec.md", join(dir, "steps", "spec.md"));
  await writeFile(
    join(dir, "landrace.yaml"),
    `version: 1
agent: { adapter: ${config.agent ?? "claude"}, model: opus }
tracker: { repo: acme/widgets }
tick: { interval: 30s, concurrency: 2 }
security: { screen: false }
log: { redact: [${config.log ?? "githubToken"}] }
secrets: { githubToken: $LR_TEST_TOKEN }
${config.extra ?? ""}`,
  );
  await writeFile(join(dir, ".env"), `LR_TEST_TOKEN=${TOKEN}\n`);
  return dir;
}

describe("parseInterval", () => {
  it("reads seconds, minutes and hours", () => {
    expect(parseInterval("30s")).toBe(30_000);
    expect(parseInterval("2m")).toBe(120_000);
    expect(parseInterval("1h")).toBe(3_600_000);
  });

  /**
   * A bare number is the likeliest typo, and the two ways of guessing are both
   * bad: read as milliseconds it polls a tracker sixty times a second, read as
   * seconds it silently means something the operator did not write.
   */
  it("refuses anything else rather than guessing a unit", () => {
    for (const bad of ["60", "", "2 m", "0.5m", "2d", "-1s", "s"]) {
      expect(() => parseInterval(bad)).toThrow(/interval/);
    }
  });
});

describe("buildRuntime", () => {
  it("refuses to start when the workflow does not validate", async () => {
    const dir = await fixture();
    // Schema-valid and unsound: no entry stage, so nothing can ever begin.
    await writeFile(
      join(dir, "workflow.yaml"),
      "version: 1\nname: broken\nstages:\n  - id: only\n    triggers: [{ when: { \"run.stage\": null } }]\n",
    );
    await expect(buildRuntime(dir, {})).rejects.toThrow(/does not validate[\s\S]*entry/);
  });

  // Matched on the missing-secret wording, not just the name: an unresolved
  // secret is also absent from the redaction map, so `log.redact` would refuse
  // it a line later — and a test that accepted either message would pass with
  // this check deleted.
  it("refuses to start when a secret does not resolve", async () => {
    const dir = await fixture();
    await writeFile(join(dir, ".env"), "\n");
    await expect(buildRuntime(dir, {})).rejects.toThrow(/do not resolve: githubToken/);
  });

  /**
   * The redaction rule the operator believes they have. A `log.redact` entry
   * naming no secret matches nothing, and a logger that quietly redacts
   * nothing is worse than none: the operator reads the config, sees the name,
   * and trusts the log. Startup is the only place this can still be caught.
   */
  it("refuses to start when log.redact names a secret nothing declares", async () => {
    await expect(buildRuntime(await fixture({ log: "slackToken" }), {})).rejects.toThrow(/slackToken/);
  });

  it("refuses to start when a redacted secret is too short to redact by", async () => {
    const dir = await fixture();
    await writeFile(join(dir, ".env"), "LR_TEST_TOKEN=x\n");
    await expect(buildRuntime(dir, {})).rejects.toThrow(/githubToken/);
  });

  it("refuses to start when no hook module provides a source to enumerate", async () => {
    await expect(buildRuntime(await fixture(), {})).rejects.toThrow(/source/);
  });
});

describe("createInterrupt", () => {
  it("asks the work in flight to stop, and says so", () => {
    const said: string[] = [];
    const stop = new AbortController();
    createInterrupt({ stop, say: (l) => said.push(l), exit: () => {} })();

    expect(stop.signal.aborted).toBe(true);
    // What the line has to carry, whatever the wording: the locks are being
    // let go, and there is a way to stop waiting for that.
    expect(said.join(" ")).toMatch(/lock/i);
    expect(said.join(" ")).toMatch(/again/i);
  });

  /**
   * The case the guard exists for: an operator who pressed Ctrl-C once,
   * watched a ten-minute agent keep running and pressed it again. A second
   * abort of an already-aborted controller does nothing at all, so without
   * this the terminal is wedged until the step's own timeout.
   */
  it("exits on the second interrupt rather than aborting an aborted controller again", () => {
    const said: string[] = [];
    const codes: number[] = [];
    const interrupt = createInterrupt({
      stop: new AbortController(),
      say: (l) => said.push(l),
      exit: (c) => codes.push(c),
    });

    interrupt();
    expect(codes).toEqual([]);
    interrupt();

    expect(codes).toEqual([130]);
    expect(said).toHaveLength(2);
    expect(said[1]).toMatch(/now/i);
  });
});
