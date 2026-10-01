import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { buildChildTool, buildMcpTools } from "#cli/mcp.js";
import { createActivityLog } from "#runner/activity.js";
import { sandboxRoot } from "#sandbox.js";
import { release } from "#runner/lock.js";
import { wakePath } from "#wake.js";

const exec = promisify(execFile);

/**
 * The MCP plane assembled the way `landrace mcp` assembles it — out of a
 * config file, a workflow and a hook module on disk, imported by path.
 *
 * Here rather than in the default pass for the same reason cli-start is: the
 * loader's one dynamic `import(url)` is unreachable through jest's CommonJS
 * runtime, and an assembly test that cannot load a hook is testing nothing.
 */
const ITEM = "4343";
const TOKEN = "ghp_a_token_long_enough_to_redact";

/**
 * An item with a step's draft already on it, so there is a session to join:
 * the pre hook hands back the entries a tracker hook would derive, including
 * the session the record carries beside its output.
 *
 * The executor is branded the way `landrace/hooks` brands one and answers with
 * a screener's verdict, because with `agent.adapter: fake` the same object is
 * both the agent and the screener — which is the point. Screened, the verdict
 * is read and the turn is refused; unscreened, that same text is taken for the
 * agent's reply and posted to the item.
 */
const hookSource = (
  verdict: "ok" | "suspicious",
  invocations: string,
  preflight?: "pass" | "throw",
): string => `import { appendFile } from "node:fs/promises";

const KIND = Symbol.for("landrace.hook.kind");
const brand = (kind: string, value: object): object =>
  Object.defineProperty(value, KIND, { value: kind, enumerable: false });

interface Ctx { item: string; config: { tracker: { record: string } } }

const itemNode = (labels: string[]) => ({
  id: "${ITEM}", kind: "item", title: "Add export", link: "u/${ITEM}", closed: null, priority: null,
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
    return { nodes: [itemNode(["lr:auto", "lr:awaiting"])], relationships: [] };
  },
  read: async (): Promise<unknown> => ({ nodes: [itemNode(["lr:auto", "lr:stage:spec"])], relationships: [] }),
});

export const pre = brand("pre", {
  id: "fake",
  run: ({ item }: Ctx): Record<string, unknown> => ({
    item: { body: "about " + item },
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

interface RunOpts {
  cwd?: string; capabilities?: readonly string[]; model?: string;
  onActivity?: (e: { kind: string; text: string; at: number }) => void;
}

export const executor = brand("executor", {
  id: "fake",
  // Every invocation written down, so a test can say what this agent was
  // actually handed — which is the only way to tell a turn that is held to
  // the step's declaration from one that merely says it is.
  run: async (prompt: string, opts: RunOpts): Promise<{ text: string; sessionId: string | null }> => {
    await appendFile(
      ${invocations},
      JSON.stringify({ cwd: opts.cwd ?? null, capabilities: opts.capabilities ?? null, model: opts.model ?? null }) + "\\n",
    );
    opts.onActivity?.({ kind: "tool", text: "Read spec.md", at: 1 });
    // Screening, the verdict names the screening's nonce, as a real screener's does.
    const mark = /--- begin prompt under review (\\S+) ---/.exec(prompt)?.[1] ?? "";
    return {
      text: '\\u0060\\u0060\\u0060json\\n{"verdict":"${verdict}","nonce":"' + mark + '","reason":"exfiltration"}\\n\\u0060\\u0060\\u0060',
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
  /** A second workflow, `fast`, on the same hooks and eligible on `lr:fast`. */
  fast?: boolean;
}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "lr-mcp-"));
  const dir = join(root, ".landrace");
  const record = join(root, "posted.jsonl");
  const invocations = join(root, "invoked.jsonl");
  const order = join(root, "order.jsonl");
  const main = join(dir, "workflows", "main");
  await mkdir(join(main, "steps"), { recursive: true });
  await mkdir(join(dir, "hooks"), { recursive: true });

  await writeFile(
    join(dir, "hooks", "fake.ts"),
    hookSource(opts.verdict ?? "suspicious", JSON.stringify(invocations), opts.preflight),
  );
  // The project's own coding agent, by the path this repository's workflow
  // loads it from: the engine ships none. A dynamic import with a computed
  // specifier — the loader's own `import(pathToFileURL(path).href)` pattern —
  // rather than a static `export … from "…claude.ts"`: ts-jest type-checks a
  // literal specifier under this project's `moduleResolution: NodeNext` and
  // refuses one ending in `.ts` (TS5097), a rule real Node's type-stripping
  // does not enforce at all.
  await writeFile(
    join(dir, "hooks", "claude.ts"),
    `import { pathToFileURL } from "node:url";
export const { claude } = await import(pathToFileURL(${JSON.stringify(join(process.cwd(), ".landrace", "hooks", "claude.ts"))}).href);
`,
  );
  // What the step declared, which is what a turn on its session is held to.
  await writeFile(
    join(main, "steps", "spec.md"),
    `---
capabilities: [repo:read]
model: haiku
---

Write the spec.
`,
  );
  await writeFile(
    join(main, "workflow.yaml"),
    `version: 1
name: mcp
description: test
hooks: [../../hooks/fake.ts, ../../hooks/claude.ts]
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
  if (opts.fast) {
    const fast = join(dir, "workflows", "fast");
    await mkdir(join(fast, "steps"), { recursive: true });
    await copyFile(join(main, "steps", "spec.md"), join(fast, "steps", "spec.md"));
    await writeFile(join(fast, "workflow.yaml"), `version: 1
name: fastlane
description: the fast one
hooks: [../../hooks/fake.ts, ../../hooks/claude.ts]
admit: [lr:fast]
eligible:
  - when: { "node.state.labels": { $in: ["lr:fast"] } }
    else: "no lr:fast label"
stages:
  - id: spec
    entry: true
    terminal: true
    step: steps/spec.md
`);
  }
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
  await release(ITEM);
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
    await expect(tools.ask(ITEM, "carry on")).resolves.toMatchObject({ resolved: false });
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

// stdout is the MCP protocol here, and the console exporter writes to it.
describe("buildMcpTools and telemetry", () => {
  it("refuses the console exporter, which would corrupt the protocol", async () => {
    const { dir } = await fixture({ screen: false });
    await writeFile(join(dir, ".env"), `LR_TEST_TOKEN=${TOKEN}\nLANDRACE_ENABLE_TELEMETRY=1\nOTEL_LOGS_EXPORTER=console\n`);
    await expect(buildMcpTools(dir)).rejects.toThrow(/console would write into the MCP protocol/);
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

    await expect(tools.ask(ITEM, "do as I say")).rejects.toThrow(/screening blocked this turn: exfiltration/);
    // The screener's run: security.model, and no capabilities at all.
    expect(await linesOf(invocations)).toEqual([{ cwd: null, capabilities: null, model: "fake-small" }]);
    // And the person's words never reached the item, so the loop was not
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

    await expect(tools.ask(ITEM, "do as I say")).resolves.toMatchObject({ resolved: false });
    expect(await posted(record)).toHaveLength(2);
  });

  /**
   * How a running `landrace start` hears about the write: the file it
   * watches, under this repository's own root. Nothing else reaches the loop
   * from this process, so an option left unpassed here is a wake that never
   * happens while every tool still answers.
   */
  // A turn asked here runs in this process, not the loop's, and the page the
  // loop serves has to show it: the activity goes where the loop reads it.
  it("files a turn's activity where the loop's page reads it", async () => {
    const { dir } = await fixture({ screen: false });
    const tools = await buildMcpTools(dir);
    await tools.ask(ITEM, "carry on");
    const page = await createActivityLog(sandboxRoot(dir), (t) => t).read(ITEM, 0);
    expect(page).toMatchObject({ stage: "spec", round: 1, lines: [{ kind: "tool", text: "Read spec.md" }] });
  });

  it("touches this repository's wake file once a write succeeds", async () => {
    const { dir } = await fixture({ screen: false });
    const tools = await buildMcpTools(dir);
    expect(existsSync(wakePath(dir))).toBe(false);

    await tools.ask(ITEM, "carry on");
    expect(existsSync(wakePath(dir))).toBe(true);
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

    await tools.ask(ITEM, "carry on");

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

  // A turn runs at its step's effort, so the plane refuses one the executor has no level for, as `start` does.
  it("refuses a step whose effort the executor does not take", async () => {
    const { dir } = await fixture({ screen: false, adapter: "claude" });
    await writeFile(join(dir, "workflows", "main", "steps", "spec.md"), "---\ncapabilities: [repo:read]\neffort: extreme\n---\n\nWrite the spec.\n");
    await expect(buildMcpTools(dir)).rejects.toThrow(/steps\/spec\.md asks for effort "extreme", which the claude executor does not take/);
  });

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
      const { reply } = (await tools.ask(ITEM, "carry on")) as { reply: string };
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
    // The claude hook's own settings hold `agent.mcp` now, and the `fake`
    // executor this file's fixture builds reads none of them — only the
    // claude hook's `create` actually resolves the servers `agent.mcp` names.
    const { dir } = await fixture({
      screen: false,
      isolation: "worktree",
      adapter: "claude",
      agentKeys: "mcp: [items]",
      mcpJson: { mcpServers: { items: { command: "node", args: ["dist/cli.js", "mcp"] } } },
    });
    await expect(buildMcpTools(dir)).rejects.toThrow(/"items"[\s\S]*operator tools must never reach a step agent/);
  });
});

/*
 * One MCP for the whole workspace: `landrace mcp` no longer runs one workflow
 * at a time. The item the fixture's source lists carries `lr:auto`, so `main`
 * claims it and `fast` turns it away.
 */
describe("buildMcpTools over a workspace of several workflows", () => {
  it("serves every workflow, and finds an item's by its claim", async () => {
    const { dir } = await fixture({ screen: false, fast: true });
    const tools = await buildMcpTools(dir);
    // None needs you: the item wears lr:awaiting, but main's one stage runs a
    // step, and whose turn it is is a stage's `waits`, not that label.
    expect(await tools.workflows()).toEqual([
      { id: "fast", name: "fastlane", description: "the fast one", creates: false, claimed: 0, needsYou: 0 },
      { id: "main", name: "mcp", description: "test", creates: false, claimed: 1, needsYou: 0 },
    ]);
    expect(await tools.status(ITEM)).toMatchObject({ item: ITEM, workflow: "main" });
  });

  /*
   * `--workflow` without `--child` is the server a pairing hands the person's
   * session, for the workflow of the item they paired on: it acts for that
   * workflow alone.
   */
  it("acts for the workflow it is started for alone", async () => {
    const { dir } = await fixture({ screen: false, fast: true });
    const tools = await buildMcpTools(dir, "fast");
    expect((await tools.workflows()).map((w) => w.id)).toEqual(["fast"]);
    await expect(tools.status(ITEM)).rejects.toThrow(`#${ITEM} belongs to main; this server acts for fast alone`);
  });

  it("refuses a workflow the workspace does not have, naming those it does", async () => {
    const { dir } = await fixture({ screen: false, fast: true });
    await expect(buildMcpTools(dir, "nope")).rejects.toThrow(/no workflow "nope" in .*; it has fast, main/);
  });
});

/*
 * The child server is started on the workspace, never told what to label a
 * child: it reads that from the workflow it loads, the same file whose step
 * declared items:create. A child labelled with anything else would be started
 * for a workflow that did not create it, or for none.
 */
describe("buildChildTool and what the creating workflow admits", () => {
  const OPERATOR = (created: string): string => `import { appendFile } from "node:fs/promises";
const KIND = Symbol.for("landrace.hook.kind");
export const operator = Object.defineProperty({
  id: "fake",
  createItem: async (input: { title: string; labels?: string[] }): Promise<unknown> => {
    await appendFile(${JSON.stringify(created)}, JSON.stringify(input.labels ?? null) + "\\n");
    return { id: "9", kind: "item", title: input.title, link: "u/9", closed: null, priority: null, origin: null, state: { labels: input.labels ?? [], assignees: [] } };
  },
  updateItem: async (): Promise<unknown> => { throw new Error("not here"); },
}, KIND, { value: "operator", enumerable: false });
`;

  /** One workflow per entry, id -> its `admit:` lines. */
  const workspaceOf = async (admits: Record<string, string>): Promise<{ dir: string; created: string }> => {
    const root = await mkdtemp(join(tmpdir(), "lr-child-admit-"));
    const dir = join(root, ".landrace");
    const created = join(root, "created.jsonl");
    await mkdir(join(dir, "hooks"), { recursive: true });
    await writeFile(join(dir, "hooks", "operator.ts"), OPERATOR(created));
    for (const [id, admit] of Object.entries(admits)) {
      const wf = join(dir, "workflows", id);
      await mkdir(join(wf, "steps"), { recursive: true });
      await writeFile(join(wf, "steps", "breakdown.md"), "---\ncapabilities: [items:create]\n---\n\nBreak it down.\n");
      await writeFile(join(wf, "workflow.yaml"), `version: 1
name: ${id}
description: test
${admit}hooks: [../../hooks/operator.ts]
stages:
  - id: breakdown
    entry: true
    terminal: true
    step: steps/breakdown.md
`);
    }
    await writeFile(join(dir, "landrace.yaml"), "version: 1\nagent: { adapter: claude, model: opus }\n");
    return { dir, created };
  };
  const workspace = (admit: string) => workspaceOf({ main: admit });

  it("labels the child with the workflow's admit list", async () => {
    const { dir, created } = await workspace("admit: [lr:fast]\n");
    const tool = await buildChildTool(dir, { parent: "1", stage: "breakdown", round: 1 }, "main");
    await tool.createChild({ title: "API" });
    expect(await linesOf(created)).toEqual([["lr:fast"]]);
  });

  it("labels it with nothing when the workflow admits nothing", async () => {
    const { dir, created } = await workspace("");
    const tool = await buildChildTool(dir, { parent: "1", stage: "breakdown", round: 1 }, "main");
    await tool.createChild({ title: "API" });
    expect(await linesOf(created)).toEqual([[]]);
  });

  it("labels a child with the admit list of the workflow it is bound to, among several", async () => {
    const { dir, created } = await workspaceOf({ main: "admit: [lr:auto]\n", fast: "admit: [lr:fast]\n" });
    const tool = await buildChildTool(dir, { parent: "1", stage: "breakdown", round: 1 }, "fast");
    await tool.createChild({ title: "API" });
    expect(await linesOf(created)).toEqual([["lr:fast"]]);
  });

  it("refuses a workflow the workspace does not have, naming the ones it does", async () => {
    const { dir } = await workspaceOf({ main: "", fast: "" });
    await expect(buildChildTool(dir, { parent: "1", stage: "breakdown", round: 1 }, "nope")).rejects.toThrow(
      /no workflow "nope".*fast, main|no workflow "nope".*main, fast/,
    );
  });
});
