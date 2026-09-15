import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/load.js";

const CONFIG = `version: 1
agent: { adapter: claude, model: opus }
tracker: { repo: acme/widgets }
tick: { interval: 60s, concurrency: 3 }
security: { screen: true, model: haiku }
log: { redact: [githubToken] }
secrets: { githubToken: $GITHUB_TOKEN }
`;

async function fixture(env: string | null): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), "landrace-cfg-")), ".landrace");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "landrace.yaml"), CONFIG);
  if (env !== null) await writeFile(join(dir, ".env"), env);
  return dir;
}

describe("loadConfig", () => {
  it("resolves a secret from the workflow folder's .env", async () => {
    const { config, secretValues, missing } = await loadConfig(await fixture("GITHUB_TOKEN=ghp_x"));
    expect(config.tracker.repo).toBe("acme/widgets");
    expect(secretValues.get("githubToken")).toBe("ghp_x");
    expect(missing).toEqual([]);
  });

  it("reports an unresolved reference instead of passing $GITHUB_TOKEN to a hook", async () => {
    const { missing } = await loadConfig(await fixture(""));
    expect(missing).toEqual(["githubToken"]);
  });

  it("works with no .env at all, falling back to the process environment", async () => {
    process.env.GITHUB_TOKEN = "from-shell";
    const { secretValues } = await loadConfig(await fixture(null));
    expect(secretValues.get("githubToken")).toBe("from-shell");
    delete process.env.GITHUB_TOKEN;
  });

  it("never puts a resolved secret back into the config object", async () => {
    const { config } = await loadConfig(await fixture("GITHUB_TOKEN=ghp_x"));
    expect(JSON.stringify(config)).not.toContain("ghp_x");
  });

  // The gitignore guard itself (runValidate's ".env exists but is not
  // gitignored" check) is exercised against real git repositories in
  // tests/cli/gitignore.test.ts — gitignore semantics (negation, nesting)
  // cannot be verified against a bare fixture directory.
});
