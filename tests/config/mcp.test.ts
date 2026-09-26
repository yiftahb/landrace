import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { loadConfig } from "#config/load.js";
import { resolveStepServers } from "#config/mcp.js";
import type { McpConfig } from "#namespace.js";
import { gitRepo, plainDir, removeRepos } from "#tests/support/repo.js";

afterAll(removeRepos);

const MEMORY = { command: "codebase-memory-mcp", args: [], env: { MEMORY_HOME: "/var/memory" } };
const OPERATOR = { command: "node", args: ["dist/cli.js", "mcp"], env: {} };

/**
 * A repository with its workflow folder where `landrace start` finds one, and
 * — when given — the `.mcp.json` agsync would have written at its root.
 */
async function repo(mcpJson?: unknown): Promise<{ root: string; dir: string }> {
  const root = await gitRepo();
  const dir = join(root, ".landrace");
  await mkdir(dir, { recursive: true });
  if (mcpJson !== undefined) {
    await writeFile(join(root, ".mcp.json"), typeof mcpJson === "string" ? mcpJson : JSON.stringify(mcpJson));
  }
  return { root, dir };
}

describe("the MCP servers a step may use", () => {
  it("resolves each allowlisted name to its definition in the repository root's .mcp.json, exactly as written", async () => {
    const { dir } = await repo({ mcpServers: { "codebase-memory-mcp": MEMORY, landrace: OPERATOR } });
    const r = await resolveStepServers(dir, ["codebase-memory-mcp"]);
    expect(r.problems).toEqual([]);
    // Only what was named: the operator server sits right beside it in the
    // same file, and naming one server is not naming the file.
    expect(r.servers).toEqual({ "codebase-memory-mcp": MEMORY });
  });

  /*
   * The root, not the folder the workflow sits in and not wherever a step
   * happens to run: agsync writes `.mcp.json` at the top of the checkout, and
   * a step's worktree — cut from HEAD — never has the gitignored file at all.
   */
  it("reads the file at the repository root from a workflow folder nested below it", async () => {
    const { root } = await repo({ mcpServers: { "codebase-memory-mcp": MEMORY } });
    const nested = join(root, "packages", "app", ".landrace");
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, "packages", "app", ".mcp.json"), JSON.stringify({ mcpServers: { "codebase-memory-mcp": { command: "decoy" } } }));
    expect((await resolveStepServers(nested, ["codebase-memory-mcp"])).servers).toEqual({ "codebase-memory-mcp": MEMORY });
  });

  it("asks nothing of the file system when no server is allowed", async () => {
    const r = await resolveStepServers(join(await plainDir(), ".landrace"), []);
    expect(r).toEqual({ servers: {}, problems: [] });
  });

  it("refuses when there is no .mcp.json, saying agsync sync generates it", async () => {
    const { root, dir } = await repo();
    const { problems } = await resolveStepServers(dir, ["codebase-memory-mcp"]);
    expect(problems).toEqual([{
      rule: "mcp",
      message: expect.stringMatching(/codebase-memory-mcp[\s\S]*\.mcp\.json does not exist[\s\S]*agsync sync/),
    }]);
    expect(problems[0]?.message).toContain(join(realpathSync(root), ".mcp.json"));
  });

  it("refuses a name the file does not define, naming it and what the file does define", async () => {
    const { dir } = await repo({ mcpServers: { "codebase-memory-mcp": MEMORY, landrace: OPERATOR } });
    const { problems, servers } = await resolveStepServers(dir, ["codebase-memory"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toMatch(/"codebase-memory"[\s\S]*codebase-memory-mcp, landrace/);
    expect(servers).toEqual({});
  });

  /*
   * The operator server creates, updates and replies on tickets. A step agent
   * holding it could move its own ticket — which is the one decision this
   * engine exists to keep away from a model.
   */
  it("refuses the operator server by name, before any file is read", async () => {
    const { problems } = await resolveStepServers(join(await plainDir(), ".landrace"), ["landrace"]);
    expect(problems).toEqual([{ rule: "mcp", message: expect.stringMatching(/"landrace"[\s\S]*operator[\s\S]*never reach a step agent/) }]);
  });

  it.each([
    ["node dist/cli.js mcp", { command: "node", args: ["dist/cli.js", "mcp"] }],
    ["landrace mcp", { command: "landrace", args: ["mcp"] }],
    ["an absolute landrace", { command: "/usr/local/bin/landrace", args: ["mcp", "--workflow", ".landrace"] }],
    ["npx landrace@latest mcp", { command: "npx", args: ["-y", "landrace@latest", "mcp"] }],
    ["an installed cli.js", { command: "node", args: ["/opt/node_modules/landrace/dist/cli.js", "mcp"] }],
    ["cli.js mcp", { command: "cli.js", args: ["mcp"] }],
    ["the source entry", { command: "node", args: ["--experimental-strip-types", "src/cli/index.ts", "mcp"] }],
    ["a shell wrapping it", { command: "sh", args: ["-c", "landrace mcp --workflow .landrace"] }],
  ])("refuses the operator server under another name: %s", async (_, definition) => {
    const { dir } = await repo({ mcpServers: { tickets: definition } });
    const { problems, servers } = await resolveStepServers(dir, ["tickets"]);
    expect(problems).toEqual([{ rule: "mcp", message: expect.stringMatching(/"tickets"[\s\S]*operator[\s\S]*never reach a step agent/) }]);
    expect(servers).toEqual({});
  });

  it.each([
    ["a server whose own name ends in mcp", { command: "codebase-memory-mcp" }],
    ["a different tool's mcp subcommand", { command: "node", args: ["tools/landrace-docs.js", "mcp"] }],
    ["a remote server", { type: "http", url: "https://mcp.example.invalid/landrace" }],
  ])("lets through what only looks like it: %s", async (_, definition) => {
    const { dir } = await repo({ mcpServers: { other: definition } });
    expect(await resolveStepServers(dir, ["other"])).toEqual({ servers: { other: definition }, problems: [] });
  });

  /*
   * A server's env can hold a credential, and node's JSON.parse quotes the
   * text around a syntax error back in its own message — so the file's own
   * words must never be what the problem is made of.
   */
  it("reports a file that is not JSON without quoting any of it", async () => {
    const secret = "hunter22";
    // Unquoted, the way a hand edit leaves it — the shape node echoes back.
    const { dir } = await repo(`{"mcpServers": {"codebase-memory-mcp": {"env": {"TOKEN": ${secret}}}}}`);
    const { problems } = await resolveStepServers(dir, ["codebase-memory-mcp"]);
    expect(problems).toEqual([{ rule: "mcp", message: expect.stringMatching(/\.mcp\.json is not valid JSON/) }]);
    expect(JSON.stringify(problems)).not.toContain(secret);
  });

  it("reports a file shaped like something else", async () => {
    const { dir } = await repo({ servers: {} });
    const { problems } = await resolveStepServers(dir, ["codebase-memory-mcp"]);
    expect(problems).toEqual([{ rule: "mcp", message: expect.stringMatching(/\.mcp\.json[\s\S]*mcpServers/) }]);
  });

  it("refuses when there is no repository to find the file in", async () => {
    const { problems } = await resolveStepServers(join(await plainDir(), ".landrace"), ["codebase-memory-mcp"]);
    expect(problems).toEqual([{ rule: "mcp", message: expect.stringMatching(/agent\.mcp[\s\S]*repository/) }]);
  });
});

/*
 * The shipped configuration against the `.mcp.json` agsync generates from the
 * sources checked in beside it — asked on every machine, because the real
 * file is gitignored and CI never has one. It is what proves this repository's
 * own allowlist resolves, and that the operator server it ships is the one the
 * check recognises, whatever it is renamed to.
 */
describe("the shipped allowlist, against what agsync generates", () => {
  const generated = async (): Promise<McpConfig> => {
    const sources = (await readdir(".agsync/mcp")).filter((f) => f.endsWith(".yaml"));
    const mcpServers: McpConfig["mcpServers"] = {};
    for (const file of sources) {
      const { name, command, args } = parse(await readFile(join(".agsync/mcp", file), "utf8")) as {
        name: string; command: string; args?: string[];
      };
      mcpServers[name] = { command, args: args ?? [], env: {} };
    }
    return { mcpServers };
  };

  it("resolves every server .landrace/landrace.yaml allows", async () => {
    const { config } = await loadConfig(".landrace");
    expect(config.agent.mcp.length).toBeGreaterThan(0);
    const { dir } = await repo(await generated());
    const r = await resolveStepServers(dir, config.agent.mcp);
    expect(r.problems).toEqual([]);
    expect(Object.keys(r.servers)).toEqual(config.agent.mcp);
  });

  it("recognises the operator server agsync defines, under any name", async () => {
    const { mcpServers } = await generated();
    const operator = mcpServers["landrace"];
    expect(operator).toBeDefined();
    const { dir } = await repo({ mcpServers: { renamed: operator } });
    expect((await resolveStepServers(dir, ["renamed"])).problems).toEqual([
      { rule: "mcp", message: expect.stringMatching(/operator tools must never reach a step agent/) },
    ]);
  });
});
