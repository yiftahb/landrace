import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, varsHoldingSecrets } from "#config/load.js";
import { runtimeConfigSchema } from "#config/schema.js";

const CONFIG = `version: 1
agent: { adapter: claude, model: opus }
tracker: { repo: acme/widgets }
tick: { interval: 60s, concurrency: 3 }
security: { screen: true, model: haiku }
log: { redact: [githubToken] }
secrets: { githubToken: $GITHUB_TOKEN }
`;

async function fixture(env: string | null, extra = ""): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), "landrace-cfg-")), ".landrace");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "landrace.yaml"), CONFIG + extra);
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

/**
 * `vars`, which is the same `$VAR` expansion as `secrets` pointed at a
 * different destination: a secret is handed to a hook, a var is substituted
 * into the workflow before it is validated.
 *
 * What it must never do is resolve to *something* when there was nothing. A
 * var that fell back to the literal "$LANDRACE_ASSIGNEE", or to "", would
 * substitute an eligibility rule that matches no ticket at all — and the
 * operator's evidence would be a repository where nothing ever happens, which
 * is the hardest failure this system has.
 */
describe("loadConfig resolves the vars block", () => {
  const withVars = (block: string, env: string | null) =>
    fixture(env, `vars:\n${block}`);

  it("resolves a reference from .env and passes a literal through unchanged", async () => {
    const { vars, missingVars } = await loadConfig(
      await withVars("  assignee: $LANDRACE_ASSIGNEE\n  team: platform\n", "GITHUB_TOKEN=t\nLANDRACE_ASSIGNEE=ann"),
    );
    expect(vars.get("assignee")).toBe("ann");
    expect(vars.get("team")).toBe("platform");
    expect(missingVars).toEqual([]);
  });

  it("reports an unresolved reference rather than substituting the literal $LANDRACE_ASSIGNEE", async () => {
    const { vars, missingVars } = await loadConfig(await withVars("  assignee: $LANDRACE_ASSIGNEE\n", "GITHUB_TOKEN=t"));
    expect(missingVars).toEqual(["assignee"]);
    expect(vars.has("assignee")).toBe(false);
  });

  /*
   * The case the "never an empty string" rule is actually about: the variable
   * *is* set, to nothing. Resolution succeeds, the reference is gone, and the
   * workflow gets `$in: [""]` — a filter that silently claims no ticket.
   */
  it("reports a variable that resolves to an empty value, which resolution alone would accept", async () => {
    const { vars, missingVars } = await loadConfig(
      await withVars("  assignee: $LANDRACE_ASSIGNEE\n", "GITHUB_TOKEN=t\nLANDRACE_ASSIGNEE="),
    );
    expect(missingVars).toEqual(["assignee"]);
    expect(vars.has("assignee")).toBe(false);
  });

  it("reports a whitespace-only value too, which trims to the same nothing", async () => {
    const { missingVars } = await loadConfig(
      await withVars("  assignee: $LANDRACE_ASSIGNEE\n", 'GITHUB_TOKEN=t\nLANDRACE_ASSIGNEE="   "'),
    );
    expect(missingVars).toEqual(["assignee"]);
  });

  it("keeps the resolved value out of the config object, exactly as a secret's is", async () => {
    const { config } = await loadConfig(
      await withVars("  assignee: $LANDRACE_ASSIGNEE\n", "GITHUB_TOKEN=t\nLANDRACE_ASSIGNEE=ann"),
    );
    // The reference as written, not what it resolved to: `config` is what a
    // hook is handed and what a debug dump prints.
    expect(config.vars).toEqual({ assignee: "$LANDRACE_ASSIGNEE" });
  });
});

/**
 * A var is not a second way to hold a secret, and the difference is not a
 * matter of taste: secrets are redacted from every log line and event by
 * value, vars are not, and a var reaches a comment body and an agent's prompt.
 *
 * Compared by value rather than by reference text, because the interesting
 * mistake is `vars: { token: $GITHUB_TOKEN }` beside `secrets: { githubToken:
 * $GITHUB_TOKEN }` — two names, one value, one of them redacted.
 */
describe("a var that is really a secret", () => {
  it("is named, when it resolves to the same value a secret does", async () => {
    const loaded = await loadConfig(await fixture("GITHUB_TOKEN=ghp_x", "vars:\n  token: $GITHUB_TOKEN\n"));
    expect(varsHoldingSecrets(loaded)).toEqual(["token"]);
  });

  it("is named when the value was typed out rather than referenced", async () => {
    const loaded = await loadConfig(await fixture("GITHUB_TOKEN=ghp_x", "vars:\n  token: ghp_x\n"));
    expect(varsHoldingSecrets(loaded)).toEqual(["token"]);
  });

  it("says nothing about an ordinary var", async () => {
    const loaded = await loadConfig(await fixture("GITHUB_TOKEN=ghp_x", "vars:\n  team: platform\n"));
    expect(varsHoldingSecrets(loaded)).toEqual([]);
  });
});

/*
 * What every declared step is handed beyond its own tools. Both default to
 * nothing: a plugin or a server a step never asked for is one more thing
 * reading the repository, and the operator names each of them on purpose.
 */
describe("agent.plugins and agent.mcp", () => {
  const parse = (agent: Record<string, unknown>) =>
    runtimeConfigSchema.safeParse({ version: 1, agent: { adapter: "claude", ...agent } });

  it("default to empty lists", () => {
    const r = parse({});
    expect(r.success && r.data.agent.plugins).toEqual([]);
    expect(r.success && r.data.agent.mcp).toEqual([]);
  });

  it("read as written in landrace.yaml", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "landrace-cfg-")), ".landrace");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "landrace.yaml"), `version: 1
agent:
  adapter: claude
  plugins: [superpowers@claude-plugins-official]
  mcp: [codebase-memory-mcp]
`);
    const { config } = await loadConfig(dir);
    expect(config.agent.plugins).toEqual(["superpowers@claude-plugins-official"]);
    expect(config.agent.mcp).toEqual(["codebase-memory-mcp"]);
  });

  it("refuse anything but a list of names", () => {
    expect(parse({ mcp: "codebase-memory-mcp" }).success).toBe(false);
    expect(parse({ plugins: "superpowers@claude-plugins-official" }).success).toBe(false);
    expect(parse({ mcp: [""] }).success).toBe(false);
    expect(parse({ plugins: [""] }).success).toBe(false);
    expect(parse({ mcp: [3] }).success).toBe(false);
  });
});
