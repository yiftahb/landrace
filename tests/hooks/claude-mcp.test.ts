import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { loadConfig } from "#config/load.js";
import { mcpRedactionValues, readClaudeSettings, resolveStepServers } from "#landrace/hooks/claude.js";
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

  /*
   * Allowlisting a server by bare name allows every tool on it — for the
   * codebase graph that includes indexing any path, deleting a project and
   * reading every other indexed checkout. Listing tools narrows it to those.
   */
  it("carries a server's tool list beside its definition, and none for a bare name", async () => {
    const { dir } = await repo({ mcpServers: { "codebase-memory-mcp": MEMORY, other: { command: "other" } } });
    const r = await resolveStepServers(dir, [{ name: "codebase-memory-mcp", tools: ["search_graph", "trace_path"] }, "other"]);
    expect(r.problems).toEqual([]);
    expect(r.servers).toEqual({ "codebase-memory-mcp": MEMORY, other: { command: "other" } });
    expect(r.tools).toEqual({ "codebase-memory-mcp": ["search_graph", "trace_path"] });
  });

  it("refuses an entry that lists no tools, which would allow nothing while reading as configured", async () => {
    const { problems } = await resolveStepServers(join(await plainDir(), ".landrace"), [{ name: "codebase-memory-mcp", tools: [] }]);
    expect(problems).toEqual([{ rule: "mcp", message: expect.stringMatching(/"codebase-memory-mcp"[\s\S]*no tools/) }]);
  });

  it.each(["search graph", "a,Bash", "-x"])("refuses a tool name its argv could not carry whole: %s", async (tool) => {
    const { problems } = await resolveStepServers(join(await plainDir(), ".landrace"), [{ name: "codebase-memory-mcp", tools: ["search_graph", tool] }]);
    expect(problems).toEqual([{ rule: "mcp", message: expect.stringContaining(JSON.stringify(tool)) }]);
  });

  // Two entries for one server could disagree about its tools, and picking
  // one of them is the "first match wins" this codebase does not do.
  it("refuses a server named twice, whatever the two entries say", async () => {
    const { problems } = await resolveStepServers(join(await plainDir(), ".landrace"), [
      "codebase-memory-mcp", { name: "codebase-memory-mcp", tools: ["search_graph"] },
    ]);
    expect(problems).toEqual([{ rule: "mcp", message: expect.stringMatching(/"codebase-memory-mcp" more than once/) }]);
  });

  it("asks nothing of the file system when no server is allowed", async () => {
    const r = await resolveStepServers(join(await plainDir(), ".landrace"), []);
    expect(r).toEqual({ servers: {}, tools: {}, problems: [] });
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
    // Each of these got past the first version of the match.
    ["an end-of-options marker", { command: "node", args: ["dist/cli.js", "--", "mcp"] }],
    ["an entry with no extension", { command: "node", args: ["dist/cli", "mcp"] }],
    ["a shell sequence after it", { command: "sh", args: ["-c", "node dist/cli.js mcp; echo done"] }],
    ["a shell && with no space", { command: "sh", args: ["-c", "landrace mcp&&true"] }],
    ["a pipe with no space", { command: "sh", args: ["-c", "landrace mcp|tee log"] }],
    ["a quoted entry", { command: "sh", args: ["-c", 'node "dist/cli.js" mcp'] }],
    ["a quoted subcommand", { command: "sh", args: ["-c", "landrace 'mcp'"] }],
    ["an upper-case entry", { command: "node", args: ["dist/CLI.js", "mcp"] }],
    ["an upper-case subcommand", { command: "landrace", args: ["MCP"] }],
    ["an npx git ref", { command: "npx", args: ["landrace#main", "mcp"] }],
    ["a module entry", { command: "node", args: ["./dist/cli.mjs", "mcp"] }],
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
    ["an entry whose name only starts with cli", { command: "node", args: ["client.js", "mcp"] }],
    ["a subcommand that only starts with mcp", { command: "landrace", args: ["mcp-docs"] }],
    ["a python server", { command: "uvx", args: ["mcp-server-git", "--repository", "."] }],
    ["an npx package", { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] }],
    ["a container", { command: "docker", args: ["run", "-i", "--rm", "mcp/github"] }],
  ])("lets through what only looks like it: %s", async (_, definition) => {
    const { dir } = await repo({ mcpServers: { other: definition } });
    expect(await resolveStepServers(dir, ["other"])).toEqual({ servers: { other: definition }, tools: {}, problems: [] });
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

  /*
   * `mcpConfigProblem`'s own field checks, hand-written because a copied hook
   * has no zod: each one named by field, the way the zod path it replaces
   * named a schema issue.
   */
  it("reports a server entry that is not an object", async () => {
    const { dir } = await repo({ mcpServers: { "codebase-memory-mcp": "not-an-object" } });
    const { problems } = await resolveStepServers(dir, ["codebase-memory-mcp"]);
    expect(problems).toEqual([{ rule: "mcp", message: expect.stringMatching(/mcpServers\.codebase-memory-mcp: expected an object/) }]);
  });

  it("reports a server whose command is not a string", async () => {
    const { dir } = await repo({ mcpServers: { "codebase-memory-mcp": { command: 5 } } });
    const { problems } = await resolveStepServers(dir, ["codebase-memory-mcp"]);
    expect(problems).toEqual([{ rule: "mcp", message: expect.stringMatching(/mcpServers\.codebase-memory-mcp\.command: expected a string/) }]);
  });

  it("reports a server whose args is not a list of strings", async () => {
    const { dir } = await repo({ mcpServers: { "codebase-memory-mcp": { command: "x", args: ["ok", 5] } } });
    const { problems } = await resolveStepServers(dir, ["codebase-memory-mcp"]);
    expect(problems).toEqual([{ rule: "mcp", message: expect.stringMatching(/mcpServers\.codebase-memory-mcp\.args: expected a list of strings/) }]);
  });

  it("reports a server whose env is not an object of strings", async () => {
    const { dir } = await repo({ mcpServers: { "codebase-memory-mcp": { command: "x", env: { A: 1 } } } });
    const { problems } = await resolveStepServers(dir, ["codebase-memory-mcp"]);
    expect(problems).toEqual([{ rule: "mcp", message: expect.stringMatching(/mcpServers\.codebase-memory-mcp\.env: expected an object of strings/) }]);
  });

  // The shape check only ever names command/args/env — a remote server has
  // none of them, and passes straight through, exactly as `.passthrough()`
  // let it through the zod schema this replaces.
  it("accepts a remote HTTP server carrying only url and headers, with no command", async () => {
    const remote = { type: "http", url: "https://mcp.example.invalid", headers: { Authorization: "Bearer x" } };
    const { dir } = await repo({ mcpServers: { remote } });
    const { problems, servers } = await resolveStepServers(dir, ["remote"]);
    expect(problems).toEqual([]);
    expect(servers).toEqual({ remote });
  });

  /*
   * A name reaches the agent's argv as `mcp__<name>` in `--allowedTools`,
   * which the CLI splits on spaces and commas: a server called "x Bash" would
   * allow Bash. Refused here, on the name alone and before any file is read,
   * so `validate` reports what `start` refuses.
   */
  it.each(["my server", "x,Bash", "-x", "a(b)"])("refuses a server name its argv could not carry whole: %s", async (name) => {
    const { problems, servers } = await resolveStepServers(join(await plainDir(), ".landrace"), [name]);
    expect(problems).toEqual([{ rule: "mcp", message: expect.stringContaining(JSON.stringify(name)) }]);
    expect(problems[0]?.message).toMatch(/letters, digits/);
    expect(servers).toEqual({});
  });

  it("refuses when there is no repository to find the file in, carrying git's own reason", async () => {
    // The directory has to actually exist: a `cwd` that does not is its own
    // failure (Node reports it as the same "spawn git ENOENT" a missing git
    // binary would give), and conflating the two is exactly the bug this
    // test's stronger assertion below exists to catch.
    const dir = join(await plainDir(), ".landrace");
    await mkdir(dir, { recursive: true });
    const { problems } = await resolveStepServers(dir, ["codebase-memory-mcp"]);
    expect(problems).toEqual([{ rule: "mcp", message: expect.stringMatching(/agent\.mcp[\s\S]*repository/) }]);
    // Not a generic guess: git's own stderr rides along, so "dubious
    // ownership" or a missing git binary is never misreported as this.
    expect(problems[0]?.message).toMatch(/not a git repository/);
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
  const generated = async (): Promise<{ mcpServers: Record<string, unknown> }> => {
    const sources = (await readdir(".agsync/mcp")).filter((f) => f.endsWith(".yaml"));
    const mcpServers: Record<string, unknown> = {};
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
    const { mcp } = readClaudeSettings(config.agent as Record<string, unknown>);
    expect(mcp.length).toBeGreaterThan(0);
    const { dir } = await repo(await generated());
    const r = await resolveStepServers(dir, mcp);
    expect(r.problems).toEqual([]);
    expect(Object.keys(r.servers)).toEqual(mcp.map((e) => (typeof e === "string" ? e : e.name)));
  });

  // This repository's own steps get the codebase graph's reading tools and
  // its indexer, never the whole server — not delete_project, not
  // manage_adr, not ingest_traces.
  it("names the tools of every server it allows, rather than allowing the whole server", async () => {
    const { config } = await loadConfig(".landrace");
    const { mcp } = readClaudeSettings(config.agent as Record<string, unknown>);
    for (const entry of mcp) expect(typeof entry).toBe("object");
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

/*
 * An allowlisted server's `env` and `headers` travel in the agent's argv, and
 * whatever the agent's CLI prints about a server that failed to start can land
 * in an `agent exited …` message — so their values join the redaction set.
 */
describe("the values an allowlisted server's definition carries", () => {
  it("are redacted: every env and header value long enough to redact by", () => {
    expect(mcpRedactionValues({
      memory: { command: "cbm", env: { TOKEN: "env-secret-value", DEBUG: "1" } },
      remote: { type: "http", url: "https://mcp.example.invalid", headers: { Authorization: "Bearer header-secret" } },
    }).sort()).toEqual(["Bearer header-secret", "env-secret-value"]);
  });

  // A value that short would redact every occurrence of "1" in every log line.
  it("skip what is too short to redact by, and anything that is not a string", () => {
    expect(mcpRedactionValues({ s: { command: "x", env: { A: "short" }, headers: { B: 12345678901 } } })).toEqual([]);
  });
});
