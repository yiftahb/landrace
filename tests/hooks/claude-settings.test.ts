import { claude, readClaudeSettings } from "#landrace/hooks/claude.js";
import type { Executor, ExecutorContext, ExecutorFactory } from "#namespace.js";
import { gitRepo, removeRepos } from "#tests/support/repo.js";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterAll(removeRepos);

/*
 * The hook's own settings, read out of the opaque `agent:` block the engine
 * no longer types. Strict for the same reason the engine's schemas are: a
 * key nobody reads is refused at startup rather than parsed and ignored —
 * `plugin:` for `plugins:` would otherwise run every step without its skills.
 */
describe("the claude hook's settings", () => {
  it("reads model, effort, plugins, mcp and sandbox beside the engine's own two keys", () => {
    expect(readClaudeSettings({
      adapter: "claude", isolation: "worktree", model: "opus", effort: "high", plugins: ["p@m"],
      mcp: ["x", { name: "y", tools: ["t"] }], sandbox: { hosts: ["github.com"], deny: ["~/.kube"] },
    })).toEqual({
      model: "opus", effort: "high", plugins: ["p@m"], mcp: ["x", { name: "y", tools: ["t"] }],
      sandbox: { hosts: ["github.com"], deny: ["~/.kube"] },
    });
    expect(readClaudeSettings({ adapter: "claude" })).toEqual({
      plugins: [], mcp: [], sandbox: { hosts: [], deny: ["~/.config/gh", "~/.ssh", "~/.aws", "~/.npmrc"] },
    });
  });

  it("refuses a key it does not read, naming it", () => {
    expect(() => readClaudeSettings({ adapter: "claude", plugin: ["p@m"] })).toThrow(/agent\.plugin/);
  });

  it("refuses a setting of the wrong shape, naming every one", () => {
    expect(() => readClaudeSettings({ adapter: "claude", model: 3, plugins: "p@m", mcp: [{ name: "y", tool: ["t"] }] }))
      .toThrow(/agent\.model[\s\S]*agent\.plugins[\s\S]*agent\.mcp/);
  });

  it("refuses an effort the CLI does not know, naming the setting and the levels", () => {
    expect(() => readClaudeSettings({ adapter: "claude", effort: "extreme" }))
      .toThrow(/agent\.effort[\s\S]*low, medium, high, xhigh, max/);
    expect(() => readClaudeSettings({ adapter: "claude", effort: 3 })).toThrow(/agent\.effort/);
    expect(() => readClaudeSettings({ adapter: "claude", effort: null })).toThrow(/agent\.effort/);
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

/*
 * `agent.sandbox`: what a write step's commands may reach. Strict like every
 * other key the hook reads, and shape-checked, because the two mistakes an
 * operator is likely to make both fail silently otherwise: a host written as a
 * URL is one the sandbox never matches, and a deny path written absolute is a
 * `Read(...)` rule relative to the settings file, which denies nothing.
 */
describe("the claude hook's sandbox settings", () => {
  const sandboxOf = (sandbox: unknown) => readClaudeSettings({ adapter: "claude", sandbox }).sandbox;

  it("gives a write step no network and the four credential paths when there is no sandbox block", () => {
    expect(readClaudeSettings({ adapter: "claude" }).sandbox)
      .toEqual({ hosts: [], deny: ["~/.config/gh", "~/.ssh", "~/.aws", "~/.npmrc"] });
  });

  it("reads hosts and deny as written, the sandbox's own wildcard and a path with a space included", () => {
    expect(sandboxOf({ hosts: ["github.com", "*.npmjs.org"], deny: ["~/.kube", "~/Library/Application Support/x"] }))
      .toEqual({ hosts: ["github.com", "*.npmjs.org"], deny: ["~/.kube", "~/Library/Application Support/x"] });
  });

  it("defaults each key on its own", () => {
    expect(sandboxOf({ hosts: ["github.com"] })).toEqual({ hosts: ["github.com"], deny: ["~/.config/gh", "~/.ssh", "~/.aws", "~/.npmrc"] });
    expect(sandboxOf({ deny: ["~/.kube"] })).toEqual({ hosts: [], deny: ["~/.kube"] });
  });

  // Replaces, never merges: the list is what the step is denied, as written.
  it("lets a written deny list replace the defaults, even an empty one", () => {
    expect(sandboxOf({ deny: [] })).toEqual({ hosts: [], deny: [] });
  });

  it("refuses a key it does not read, naming it", () => {
    expect(() => sandboxOf({ host: ["github.com"] })).toThrow(/agent\.sandbox\.host is not a setting the claude executor reads/);
  });

  it("refuses a sandbox that is not a block", () => {
    expect(() => sandboxOf(["github.com"])).toThrow(/agent\.sandbox must be \{ hosts, deny \}/);
  });

  it("refuses hosts or deny that is not a list", () => {
    expect(() => sandboxOf({ hosts: "github.com" })).toThrow(/agent\.sandbox\.hosts must be a list/);
    expect(() => sandboxOf({ deny: "~/.ssh" })).toThrow(/agent\.sandbox\.deny must be a list/);
  });

  // YAML's `hosts:` with no value parses as null, not "absent" — `?? []` would
  // have let it through as the empty-list default, silently accepting a key
  // that names nothing rather than reporting the typo it usually is.
  it("refuses hosts or deny given as null, rather than treating it as absent", () => {
    expect(() => sandboxOf({ hosts: null })).toThrow(/agent\.sandbox\.hosts must be a list/);
    expect(() => sandboxOf({ deny: null })).toThrow(/agent\.sandbox\.deny must be a list/);
  });

  it.each(["https://github.com", "github.com:443", "github.com/org", "git hub.com", "github.com\n", ""])(
    "refuses the host %j, which the sandbox would never match, naming its index",
    (host) => {
      expect(() => sandboxOf({ hosts: ["github.com", host] })).toThrow(/agent\.sandbox\.hosts\[1\]/);
    },
  );

  it.each(["/Users/me/.ssh", ".ssh", "~/.ssh/", "~/", "~/a)b", "~/.ssh ", "~/.ssh\n", "~/a\nb", ""])(
    "refuses the deny path %j, which no Read rule would read as meant, naming its index",
    (path) => {
      expect(() => sandboxOf({ deny: ["~/.ssh", path] })).toThrow(/agent\.sandbox\.deny\[1\]/);
    },
  );

  it("names every problem at once", () => {
    expect(() => sandboxOf({ hosts: ["https://x"], deny: ["/abs"], extra: 1 }))
      .toThrow(/agent\.sandbox\.extra[\s\S]*agent\.sandbox\.hosts\[0\][\s\S]*agent\.sandbox\.deny\[0\]/);
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

/*
 * `security.adapter: claude` beside another step agent: `agent:` is that
 * agent's block, in its vocabulary. Read as this hook's own, it refused the
 * other agent's keys at startup, or screened on the other agent's model name.
 */
describe("the claude hook as the screener beside another step agent", () => {
  const ctxFor = (dir: string, agent: Record<string, unknown>): ExecutorContext => ({
    config: { agent } as unknown as ExecutorContext["config"],
    secrets: new Map(), signal: new AbortController().signal, log: () => {}, dir,
    redact: () => {},
  });
  const factory = claude as ExecutorFactory;
  const temps: string[] = [];
  afterAll(() => Promise.all(temps.map((d) => rm(d, { recursive: true, force: true }))));

  /** The screener's argv, from a run through the fake agent installed as `claude` on PATH. */
  const screenArgv = async (executor: Pick<Executor, "run">, model?: string): Promise<string[]> => {
    const bin = await mkdtemp(join(tmpdir(), "fake-claude-bin-"));
    const cwd = await mkdtemp(join(tmpdir(), "fake-agent-"));
    temps.push(bin, cwd);
    await copyFile(join(__dirname, "..", "agent", "fake-agent.mjs"), join(bin, "claude"));
    await chmod(join(bin, "claude"), 0o755);
    await writeFile(join(cwd, "fake.json"), JSON.stringify({ out: "{{ARGV_JSON}}" }));
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ""}`;
    try {
      const r = await executor.run("p", { round: 0, cwd, signal: new AbortController().signal, ...(model === undefined ? {} : { model }) });
      return JSON.parse(r.text) as string[];
    } finally {
      process.env.PATH = path;
    }
  };

  it("starts on another agent's keys", async () => {
    const executor = await factory.create(ctxFor(await gitRepo(), { adapter: "other", effort: "high", model: "gpt-5" }));
    expect(typeof executor.run).toBe("function");
  });

  it("screens on the run's model, never on the other agent's", async () => {
    const executor = await factory.create(ctxFor(await gitRepo(), { adapter: "other", model: "gpt-5" }));
    expect(await screenArgv(executor)).not.toContain("--model");
    const argv = await screenArgv(executor, "haiku");
    expect(argv[argv.indexOf("--model") + 1]).toBe("haiku");
  });

  it("reads no .mcp.json, so a missing one is fine", async () => {
    const executor = await factory.create(ctxFor(await gitRepo(), { adapter: "other", mcp: ["memory"] }));
    expect(typeof executor.run).toBe("function");
  });

  it("does not read another agent's sandbox block either", async () => {
    const executor = await factory.create(ctxFor(await gitRepo(), { adapter: "other", sandbox: "their own vocabulary" }));
    expect(typeof executor.run).toBe("function");
  });
});
