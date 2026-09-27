import { claude, readClaudeSettings } from "#landrace/hooks/claude.js";
import type { ExecutorContext, ExecutorFactory } from "#namespace.js";
import { gitRepo, removeRepos } from "#tests/support/repo.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

afterAll(removeRepos);

/*
 * The hook's own settings, read out of the opaque `agent:` block the engine
 * no longer types. Strict for the same reason the engine's schemas are: a
 * key nobody reads is refused at startup rather than parsed and ignored —
 * `plugin:` for `plugins:` would otherwise run every step without its skills.
 */
describe("the claude hook's settings", () => {
  it("reads model, plugins and mcp beside the engine's own two keys", () => {
    expect(readClaudeSettings({ adapter: "claude", isolation: "worktree", model: "opus", plugins: ["p@m"], mcp: ["x", { name: "y", tools: ["t"] }] }))
      .toEqual({ model: "opus", plugins: ["p@m"], mcp: ["x", { name: "y", tools: ["t"] }] });
    expect(readClaudeSettings({ adapter: "claude" })).toEqual({ plugins: [], mcp: [] });
  });

  it("refuses a key it does not read, naming it", () => {
    expect(() => readClaudeSettings({ adapter: "claude", plugin: ["p@m"] })).toThrow(/agent\.plugin/);
  });

  it("refuses a setting of the wrong shape, naming every one", () => {
    expect(() => readClaudeSettings({ adapter: "claude", model: 3, plugins: "p@m", mcp: [{ name: "y", tool: ["t"] }] }))
      .toThrow(/agent\.model[\s\S]*agent\.plugins[\s\S]*agent\.mcp/);
  });

  // Named by index, the way the zod path this replaces did — a single "some
  // entry is wrong" line sends an operator counting server names by hand.
  it("refuses a single bad mcp entry, naming which index", () => {
    expect(() => readClaudeSettings({ adapter: "claude", mcp: ["good", { name: "y", tool: ["t"] }] }))
      .toThrow(/agent\.mcp\[1\]/);
  });

  // The shape checks the zod schema this replaced used to pin directly.
  it("refuses an empty plugin id", () => {
    expect(() => readClaudeSettings({ adapter: "claude", plugins: [""] }))
      .toThrow(/agent\.plugins must be a list of plugin ids/);
  });

  it("refuses an empty server name", () => {
    expect(() => readClaudeSettings({ adapter: "claude", mcp: [""] })).toThrow(/agent\.mcp\[0\]/);
  });

  it("refuses a { tools } entry with no name", () => {
    expect(() => readClaudeSettings({ adapter: "claude", mcp: [{ tools: ["search_graph"] }] }))
      .toThrow(/agent\.mcp\[0\]/);
  });

  it("refuses mcp that is not a list", () => {
    expect(() => readClaudeSettings({ adapter: "claude", mcp: "codebase-memory-mcp" }))
      .toThrow(/agent\.mcp must be a list/);
  });
});

describe("the claude executor, built from the runtime's context", () => {
  const ctxFor = (dir: string, agent: Record<string, unknown>, redacted: string[] = []): ExecutorContext => ({
    config: { agent } as unknown as ExecutorContext["config"],
    secrets: new Map(), signal: new AbortController().signal, log: () => {}, dir,
    redact: (values) => { redacted.push(...values); },
  });
  const factory = claude as ExecutorFactory;

  it("is registered as \"claude\"", () => {
    expect(factory.id).toBe("claude");
  });

  it("resolves its servers from the repository root's .mcp.json and keeps their secrets out of the log", async () => {
    const root = await gitRepo();
    const dir = join(root, ".landrace");
    await mkdir(dir, { recursive: true });
    await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { memory: { command: "m", env: { TOKEN: "a-server-token-1234" } } } }));
    const redacted: string[] = [];
    const executor = await factory.create(ctxFor(dir, { adapter: "claude", mcp: ["memory"] }, redacted));
    expect(typeof executor.run).toBe("function");
    expect(redacted).toEqual(["a-server-token-1234"]);
  });

  it("refuses to start on a server .mcp.json does not define, in the words validate uses", async () => {
    const root = await gitRepo();
    const dir = join(root, ".landrace");
    await mkdir(dir, { recursive: true });
    await expect(factory.create(ctxFor(dir, { adapter: "claude", mcp: ["memory"] })))
      .rejects.toThrow(/mcp: agent\.mcp names "memory", but .*\.mcp\.json does not exist; `agsync sync` generates it/);
  });

  it("refuses to start when the operator's own server is allowed", async () => {
    const root = await gitRepo();
    const dir = join(root, ".landrace");
    await mkdir(dir, { recursive: true });
    await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { tickets: { command: "node", args: ["dist/cli.js", "mcp"] } } }));
    await expect(factory.create(ctxFor(dir, { adapter: "claude", mcp: ["tickets"] })))
      .rejects.toThrow(/"tickets"[\s\S]*operator tools must never reach a step agent/);
  });
});
