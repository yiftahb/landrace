import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runValidate } from "#cli/validate.js";
import { redactionValues } from "#config/load.js";
import { loadLocalConfig } from "#people/resolve.js";
import { connectedStore } from "#tests/support/shipped.js";

/**
 * #217: this repository's own Landrace takes its GitHub token from the
 * board's Connect with GitHub, and a set GITHUB_TOKEN still wins. Asked of a
 * copy of the shipped `.landrace`, with a `.env` and a credentials store the
 * test controls, so neither this machine's token nor its store decides it.
 */
describe("this repository's GitHub token, from GITHUB_TOKEN or the github connection", () => {
  const TOKEN = "ghp_env0123456789abcdefghijklmnopqrstuv";
  const STORED = "gho_stored0123456789abcdefghijklmnopqr";
  const CLIENT_SECRET = "0123456789abcdef0123456789abcdef01234567";
  const NAMES = ["GITHUB_TOKEN", "GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET", "SLACK_WEBHOOK_URL", "SLACK_NOTIFY_USER"];
  const saved = new Map(NAMES.map((n) => [n, process.env[n]]));
  beforeEach(() => { for (const n of NAMES) Reflect.deleteProperty(process.env, n); });
  afterAll(() => { for (const [n, v] of saved) if (v === undefined) Reflect.deleteProperty(process.env, n); else process.env[n] = v; });

  async function shipped(env: Record<string, string>): Promise<string> {
    const dir = join(await mkdtemp(join(tmpdir(), "lr-217-")), ".landrace");
    await cp(".landrace", dir, { recursive: true });
    await writeFile(join(dir, ".env"), Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n"));
    return dir;
  }
  const OTHERS = {
    GITHUB_OAUTH_CLIENT_ID: "Ov23liAbCdEf01234567",
    GITHUB_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
    SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T0/B0/xyzxyzxyzxyz",
    SLACK_NOTIFY_USER: "U0123456789",
  };


  it("asks for GITHUB_TOKEN or the github connection when neither answers", async () => {
    const { problems } = await runValidate(await shipped(OTHERS), { credentials: await connectedStore(null) });
    const connection = problems.filter((p) => p.rule.startsWith("connection."));
    expect(connection).toEqual([{ rule: "connection.missing", message: expect.stringMatching(/GITHUB_TOKEN is unset.*"github"/) }]);
  });

  // Only a key something answered gets as far as the hooks: this is the case
  // that shows the shipped hooks define `github`, since `validate` reports
  // `connection.unknown` for a stored connection no hook defines.
  it("runs on a stored github connection with GITHUB_TOKEN unset, and redacts the token and the client secret", async () => {
    const dir = await shipped(OTHERS);
    const credentials = await connectedStore(STORED);
    const { problems } = await runValidate(dir, { credentials });
    expect(problems.filter((p) => p.rule.startsWith("connection.") || p.rule === "secret")).toEqual([]);
    const local = await loadLocalConfig(dir, credentials);
    expect(local.loaded.secretValues.get("githubToken")).toBe(STORED);
    expect(redactionValues(local.loaded)).toEqual(expect.arrayContaining([STORED, CLIENT_SECRET]));
  });

  it("lets a set GITHUB_TOKEN win over a stored connection", async () => {
    const dir = await shipped({ ...OTHERS, GITHUB_TOKEN: TOKEN });
    const credentials = await connectedStore(STORED);
    const local = await loadLocalConfig(dir, credentials);
    expect(local.loaded.secretValues.get("githubToken")).toBe(TOKEN);
    expect((await runValidate(dir, { credentials: await connectedStore(null) })).problems.filter((p) => p.rule.startsWith("connection."))).toEqual([]);
  });

  it("reports the OAuth app's secret set nowhere, though GITHUB_TOKEN is set, as .env.example says", async () => {
    const example = await readFile(".landrace/.env.example", "utf8");
    expect(example).toMatch(/^# GITHUB_TOKEN=/m);
    expect(example).toMatch(/http:\/\/127\.0\.0\.1:4546\/connect\/github\/callback/);
    const without: Record<string, string> = { ...OTHERS, GITHUB_TOKEN: TOKEN };
    Reflect.deleteProperty(without, "GITHUB_OAUTH_CLIENT_SECRET");
    const dir = await shipped(without);
    const { problems } = await runValidate(dir, { credentials: await connectedStore(null) });
    expect(problems).toContainEqual({ rule: "secret", message: 'secret "githubOauthClientSecret" does not resolve; set it in ' + join(dir, ".env") });
  });
});
