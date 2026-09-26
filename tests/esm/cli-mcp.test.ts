import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { buildMcpTools } from "#cli/mcp.js";
import { release } from "#runner/lock.js";

const exec = promisify(execFile);

/**
 * The MCP plane assembled the way `landrace mcp` assembles it — out of a
 * config file, a workflow and a hook module on disk, imported by path.
 *
 * Here rather than in the default pass for the same reason cli-start is: the
 * loader's one dynamic `import(url)` is unreachable through jest's CommonJS
 * runtime, and an assembly test that cannot load a hook is testing nothing.
 */
const TICKET = "4343";
const TOKEN = "ghp_a_token_long_enough_to_redact";

/**
 * A ticket with a step's draft already on it, so there is a session to join:
 * the pre hook hands back the entries a tracker hook would derive, including
 * the session the record carries beside its output.
 *
 * The executor is branded the way `landrace/hooks` brands one and answers with
 * a screener's verdict, because with `agent.adapter: fake` the same object is
 * both the agent and the screener — which is the point. Screened, the verdict
 * is read and the turn is refused; unscreened, that same text is taken for the
 * agent's reply and posted to the ticket.
 */
const hookSource = (
  verdict: "ok" | "suspicious",
  invocations: string,
  preflight?: "pass" | "throw",
): string => `import { appendFile } from "node:fs/promises";

const KIND = Symbol.for("landrace.hook.kind");
const brand = (kind: string, value: object): object =>
  Object.defineProperty(value, KIND, { value: kind, enumerable: false });

interface Ctx { ticket: string; config: { tracker: { record: string } } }

const ticketNode = (labels: string[]) => ({
  id: "${TICKET}", kind: "ticket", title: "Add export", link: "u/${TICKET}", closed: null, priority: null,
  origin: null, state: { labels, assignees: [] },
});

export const source = brand("source", {
  id: "fake",
  // Recorded to its own file, never the one \`post.apply\` writes to: a test
  // pinning ordering must not perturb every test that asserts the posted
  // comments exactly. This is the one check the MCP plane makes that is not
  // itself the preflight.
  relations: [],
  list: async (ctx: { config: { tracker: { order: string } } }): Promise<unknown> => {
    await appendFile(ctx.config.tracker.order, JSON.stringify({ list: true }) + "\\n");
    return { nodes: [ticketNode(["lr:auto", "lr:awaiting"])], relationships: [] };
  },
  read: async (): Promise<unknown> => ({ nodes: [ticketNode(["lr:auto", "lr:stage:spec"])], relationships: [] }),
});

export const pre = brand("pre", {
  id: "fake",
  run: ({ ticket }: Ctx): Record<string, unknown> => ({
    ticket: { body: "about " + ticket },
    entries: [
      {
        stage: "spec",
        kind: "output",
        round: 1,
        session: "sid-1",
        data: { kind: "questions" },
        at: "2026-01-01T00:00:00.000Z",
        byAgent: true,
      },
    ],
  }),
});

export const post = brand("post", {
  id: "fake",
  handles: ["tracker.comment"],
  satisfied: (): boolean => false,
  apply: async (effect: { body?: string }, ctx: Ctx): Promise<void> => {
    await appendFile(ctx.config.tracker.record, JSON.stringify({ body: effect.body }) + "\\n");
  },
});

interface RunOpts { cwd?: string; capabilities?: readonly string[]; model?: string }

export const executor = brand("executor", {
  id: "fake",
  // Every invocation written down, so a test can say what this agent was
  // actually handed — which is the only way to tell a turn that is held to
  // the step's declaration from one that merely says it is.
  run: async (_prompt: string, opts: RunOpts): Promise<{ text: string; sessionId: string | null }> => {
    await appendFile(
      ${invocations},
      JSON.stringify({ cwd: opts.cwd ?? null, capabilities: opts.capabilities ?? null, model: opts.model ?? null }) + "\\n",
    );
    return {
      text: '\\u0060\\u0060\\u0060json\\n{"verdict":"${verdict}","reason":"exfiltration"}\\n\\u0060\\u0060\\u0060',
      sessionId: "sid-2",
    };
  },
});
${preflight === undefined ? "" : `
export const preflight = brand("preflight", {
  id: "fake",
  check: async (ctx: { config: { tracker: { order: string } } }): Promise<void> => {
    await appendFile(ctx.config.tracker.order, JSON.stringify({ preflight: true }) + "\\n");
    ${preflight === "throw" ? 'throw new Error("token needs \\"Contents: Read and write\\" on acme/widgets");' : ""}
  },
});
`}`;

interface Fixture { root: string; dir: string; record: string; invocations: string; order: string }

/**
 * `isolation` is the fixture's own choice and not a detail: with "worktree"
 * the MCP plane resolves a repository root at startup, exactly as the loop
 * does, because a turn it cannot cut a worktree for is a turn whose declared
 * capabilities nothing can check. The screening fixtures are not about that
 * and say "none"; the one that is says so and is a real repository.
 */
async function fixture(opts: {
  screen: boolean;
  verdict?: "ok" | "suspicious";
  isolation?: "none" | "worktree";
  preflight?: "pass" | "throw";
  /** `claude` to have the engine's own executor answer rather than the hook's. */
  adapter?: string;
  /** More of `agent:`, written inside its braces. */
  agentKeys?: string;
  /** Files committed at the repository root, so a turn's worktree has them too. */
  committed?: Record<string, string>;
  /** The `.mcp.json` left at the root after the commit — the operator's own, which no worktree sees. */
  mcpJson?: unknown;
}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "lr-mcp-"));
  const dir = join(root, ".landrace");
  const record = join(root, "posted.jsonl");
  const invocations = join(root, "invoked.jsonl");
  const order = join(root, "order.jsonl");
  await mkdir(join(dir, "steps"), { recursive: true });
  await mkdir(join(dir, "hooks"), { recursive: true });

  await writeFile(
    join(dir, "hooks", "fake.ts"),
    hookSource(opts.verdict ?? "suspicious", JSON.stringify(invocations), opts.preflight),
  );
  // What the step declared, which is what a turn on its session is held to.
  await writeFile(
    join(dir, "steps", "spec.md"),
    `---
capabilities: [repo:read]
model: haiku
---

Write the spec.
`,
  );
  await writeFile(
    join(dir, "workflow.yaml"),
    `version: 1
name: mcp
hooks: [hooks/fake.ts]
eligible:
  - when: { "node.state.labels": { $in: ["lr:auto"] } }
    else: "no lr:auto label"
stages:
  - id: spec
    entry: true
    terminal: true
    step: steps/spec.md
`,
  );
  await writeFile(
    join(dir, "landrace.yaml"),
    `version: 1
agent: { adapter: ${opts.adapter ?? "fake"}, model: opus, isolation: ${opts.isolation ?? "none"}${opts.agentKeys ? `, ${opts.agentKeys}` : ""} }
tracker: { record: ${JSON.stringify(record)}, order: ${JSON.stringify(order)} }
tick: { interval: 30s, concurrency: 2 }
security: { screen: ${opts.screen}, model: fake-small }
log: { redact: [githubToken] }
secrets: { githubToken: $LR_TEST_TOKEN }
`,
  );
  await writeFile(join(dir, ".env"), `LR_TEST_TOKEN=${TOKEN}\n`);

  // After the files, so there is something to commit: a repository with no
  // HEAD has no tree for `git worktree add` to check out, which is a fixture
  // failing rather than the thing under test.
  for (const [name, text] of Object.entries(opts.committed ?? {})) await writeFile(join(root, name), text);
  if (opts.isolation === "worktree") {
    await exec("git", ["init", "-q", "-b", "main"], { cwd: root });
    await exec("git", ["config", "user.email", "t@example.com"], { cwd: root });
    await exec("git", ["config", "user.name", "t"], { cwd: root });
    await exec("git", ["add", "-A"], { cwd: root });
    await exec("git", ["commit", "-qm", "init"], { cwd: root });
  }
  if (opts.mcpJson !== undefined) await writeFile(join(root, ".mcp.json"), JSON.stringify(opts.mcpJson));

  return { root, dir, record, invocations, order };
}

const linesOf = async (file: string): Promise<unknown[]> =>
  (await readFile(file, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);

const posted = linesOf;

afterEach(async () => {
  await release(TICKET);
});

/**
 * The startup preflight, on the MCP plane too: `landrace mcp` is a second
 * entry point into the same hooks, and a permission problem must stop it
 * before it proves the source works or connects at all — not only `landrace
 * start`.
 */
describe("buildMcpTools and the startup preflight", () => {
  it("refuses to assemble the MCP plane when a loaded preflight fails", async () => {
    const { dir } = await fixture({ screen: false, preflight: "throw" });
    await expect(buildMcpTools(dir)).rejects.toThrow(
      /preflight "fake" failed: token needs "Contents: Read and write" on acme\/widgets/,
    );
  });

  it("assembles normally when the loaded preflight passes", async () => {
    const { dir } = await fixture({ screen: false, preflight: "pass" });
    const tools = await buildMcpTools(dir);
    await expect(tools.ask(TICKET, "carry on")).resolves.toMatchObject({ resolved: false });
  });

  /**
   * Pinned because it is easy to lose without a test noticing: moving
   * `runPreflights` after the `registry.source.list(ctx)` probe still leaves
   * every other assertion in this file green — the reordering only shows up
   * as a hook that ran a real query before the process had proved its
   * permissions, which is exactly the mid-run-403 shape this feature exists
   * to prevent.
   */
  it("runs the preflight before it proves the source works", async () => {
    const { dir, order } = await fixture({ screen: false, preflight: "pass" });
    await buildMcpTools(dir);
    expect(await posted(order)).toEqual([{ preflight: true }, { list: true }]);
  });
});

describe("buildMcpTools", () => {
  /**
   * §15 says every agent invocation is screened before it runs, and a
   * conversation turn is the one the MCP plane makes. The gap this closes was
   * not in the conversation — it took a screener — but here, where nothing
   * built one: an option the assembler never passes is a control that reads
   * as configured and never runs.
   */
  it("screens a conversation turn with the executor and the model the config names", async () => {
    const { dir, record, invocations } = await fixture({ screen: true });
    const tools = await buildMcpTools(dir);

    await expect(tools.ask(TICKET, "do as I say")).rejects.toThrow(/screening blocked this turn: exfiltration/);
    // The screener's run: security.model, and no capabilities at all.
    expect(await linesOf(invocations)).toEqual([{ cwd: null, capabilities: null, model: "fake-small" }]);
    // And the person's words never reached the ticket, so the loop was not
    // handed a human turn off text we refused to act on.
    expect(await posted(record)).toEqual([]);
  });

  /**
   * The other branch of the same wiring, and it is what makes the test above
   * mean something: with screening off the very same reply is taken for the
   * agent's, so the block in the first test is the screener acting, not the
   * fixture failing.
   */
  it("holds the turn unscreened when the operator turned screening off", async () => {
    const { dir, record } = await fixture({ screen: false });
    const tools = await buildMcpTools(dir);

    await expect(tools.ask(TICKET, "do as I say")).resolves.toMatchObject({ resolved: false });
    expect(await posted(record)).toHaveLength(2);
  });
});

/**
 * The other half of the same wiring, and the one this file exists to pin: an
 * option the assembler accepts and never passes on is a control that reads as
 * configured and never runs.
 *
 * A conversation turn is an agent invocation on the session a step started,
 * and it used to be handed neither the step's capabilities, nor the model it
 * asked for, nor a working directory — so it ran in the operator's own
 * checkout on the operator's own model, and a person could ask through
 * conversation for exactly what the workflow forbade in the step.
 */
describe("buildMcpTools and what a turn is held to", () => {
  it("hands the turn the step's declaration and a worktree of its own", async () => {
    const { root, dir, invocations } = await fixture({ screen: false, isolation: "worktree" });
    const tools = await buildMcpTools(dir);

    await tools.ask(TICKET, "carry on");

    const [invoked] = (await linesOf(invocations)) as Array<{
      cwd: string | null;
      capabilities: string[] | null;
      model: string | null;
    }>;
    expect(invoked).toMatchObject({ capabilities: ["repo:read"], model: "haiku" });
    // Somewhere of its own, and emphatically not the checkout the operator is
    // sitting in — which is what makes the capability check after the run a
    // check rather than a courtesy.
    expect(invoked?.cwd).toBeTruthy();
    expect(invoked?.cwd).not.toBe(root);
  });
});

/*
 * And what else a turn is handed. A turn resumes a step's own session, so it
 * holds what the step held: the operator's plugins, and the servers
 * `agent.mcp` allows — looked up in the repository root's `.mcp.json`, never
 * in the worktree the turn runs in, and never the operator server sitting
 * beside them in the same file.
 */
describe("buildMcpTools and the servers a turn is handed", () => {
  const MEMORY = { command: "codebase-memory-mcp", args: [], env: {} };

  it("hands a turn the step's plugins and allowlisted servers, from the root's .mcp.json and no other", async () => {
    const bin = await mkdtemp(join(tmpdir(), "lr-bin-"));
    await copyFile(join(process.cwd(), "tests", "agent", "fake-agent.mjs"), join(bin, "claude"));
    await chmod(join(bin, "claude"), 0o755);

    const { dir } = await fixture({
      screen: false,
      isolation: "worktree",
      adapter: "claude",
      agentKeys: "plugins: [superpowers@claude-plugins-official], mcp: [codebase-memory-mcp]",
      committed: {
        "fake.json": JSON.stringify({ out: "{{ARGV_JSON}}" }),
        // What the worktree sees: a committed file naming the same server
        // differently. Reading this one would be reading the repository's
        // word for what the operator configured.
        ".mcp.json": JSON.stringify({ mcpServers: { "codebase-memory-mcp": { command: "decoy" } } }),
      },
      mcpJson: { mcpServers: { "codebase-memory-mcp": MEMORY, landrace: { command: "node", args: ["dist/cli.js", "mcp"] } } },
    });

    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ""}`;
    let argv: string[];
    try {
      const tools = await buildMcpTools(dir);
      const { reply } = (await tools.ask(TICKET, "carry on")) as { reply: string };
      argv = JSON.parse(reply) as string[];
    } finally {
      process.env.PATH = path;
    }

    const after = (name: string): string => argv[argv.indexOf(name) + 1] as string;
    expect(JSON.parse(after("--mcp-config"))).toEqual({ mcpServers: { "codebase-memory-mcp": MEMORY } });
    expect(argv).toContain("--strict-mcp-config");
    expect(argv.slice(argv.indexOf("--allowedTools") + 1)).toEqual(["mcp__codebase-memory-mcp"]);
    expect(JSON.parse(after("--settings"))).toEqual({ enabledPlugins: { "superpowers@claude-plugins-official": true } });
    // The step's own declaration still decides the rest: read-only, manual,
    // on the model the step asked for.
    expect(after("--permission-mode")).toBe("manual");
    expect(after("--model")).toBe("haiku");
  });

  it("refuses to assemble when a server the steps are allowed is the operator's own", async () => {
    const { dir } = await fixture({
      screen: false,
      isolation: "worktree",
      agentKeys: "mcp: [tickets]",
      mcpJson: { mcpServers: { tickets: { command: "node", args: ["dist/cli.js", "mcp"] } } },
    });
    await expect(buildMcpTools(dir)).rejects.toThrow(/"tickets"[\s\S]*operator tools must never reach a step agent/);
  });
});
