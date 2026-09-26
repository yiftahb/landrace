import { chmod, copyFile, cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runtimeConfigSchema } from "#config/schema.js";
import { defineExecutor } from "#hooks/contracts.js";
import { renderMarker } from "#conventions.js";
import type { Board, LandraceEvent, Registry, Runtime, Schedule, Source, Workflow } from "#namespace.js";
import { createBoard } from "#ui/board.js";
import { createDispatcher } from "#runner/effects.js";
import { createFakeTracker } from "#tests/support/fake-tracker.js";
import {
  boardSink,
  buildRuntime,
  createInterrupt,
  executorFor,
  screenerFor,
  gotoFor,
  loop,
  parseInterval,
  parsePort,
  repoWorkspace,
  startUi,
  stepTimeoutMs,
} from "#cli/start.js";

const TOKEN = "ghp_a_token_long_enough_to_redact";
const exec = promisify(execFile);

/**
 * A workflow directory on disk, because that is the only thing `buildRuntime`
 * takes: every failure it exists to report is a file a person can go and edit,
 * and a fixture built out of objects would prove nothing about reading them.
 *
 * No `hooks:` list, so nothing is imported — the default jest pass cannot
 * import a module by file URL at all (see jest.esm.config.mjs), and the tests
 * that need a real hook module live in tests/esm/cli-start.test.ts.
 */
async function fixture(
  config: Partial<Record<"log" | "agent" | "agentKeys" | "extra", string>> & { git?: boolean } = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lr-start-"));
  if (config.git) await exec("git", ["init", "-q", "-b", "main"], { cwd: root });
  const dir = join(root, ".landrace");
  await mkdir(join(dir, "steps"), { recursive: true });
  await cp("tests/fixtures/minimal/workflow.yaml", join(dir, "workflow.yaml"));
  await cp("tests/fixtures/minimal/steps/spec.md", join(dir, "steps", "spec.md"));
  await writeFile(
    join(dir, "landrace.yaml"),
    `version: 1
agent: { adapter: ${config.agent ?? "claude"}, model: opus${config.agentKeys ? `, ${config.agentKeys}` : ""} }
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
    await expect(buildRuntime(dir, {})).rejects.toThrow(/secret "githubToken" does not resolve/);
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

  /*
   * A var is substituted into the workflow before anything validates it, so an
   * unresolved one is not a value that is merely absent — it is a graph filled
   * in with nothing, and a predicate filled in with nothing matches no ticket.
   * The daemon finds that out as a repository where nothing ever happens.
   */
  it("refuses to start when a var does not resolve", async () => {
    const dir = await fixture({ extra: "vars: { assignee: $LR_TEST_NOBODY }\n" });
    await expect(buildRuntime(dir, {})).rejects.toThrow(/assignee[\s\S]*does not resolve/);
  });

  /**
   * And refuses a var holding a secret. The log redacts by value and knows
   * only the values `secrets` declares; a var reaches a comment body, an
   * agent's prompt and the events that record both, with nothing suppressing
   * it — so the same string under two names is one of them printed in the
   * clear.
   */
  it("refuses to start when a var resolves to a value a secret also holds", async () => {
    const dir = await fixture({ extra: "vars: { leaked: $LR_TEST_TOKEN }\n" });
    await expect(buildRuntime(dir, {})).rejects.toThrow(/leaked[\s\S]*secret/);
  });

  /*
   * `agent.mcp` is resolved against the repository root's `.mcp.json` before
   * anything else is loaded — and before any hook module is imported — so a
   * server that cannot be handed to a step is a refusal to start, in a
   * sentence, rather than a step that finds its tools missing hours in.
   */
  describe("agent.mcp", () => {
    const withServers = async (mcpJson: unknown | null, names: string): Promise<string> => {
      const dir = await fixture({ git: true, agentKeys: `mcp: [${names}]` });
      if (mcpJson !== null) await writeFile(join(dir, "..", ".mcp.json"), JSON.stringify(mcpJson));
      return dir;
    };

    it("refuses to start when there is no .mcp.json at the repository root, naming the command that writes one", async () => {
      await expect(buildRuntime(await withServers(null, "codebase-memory-mcp"), {}))
        .rejects.toThrow(/mcp: agent\.mcp names "codebase-memory-mcp", but .*\.mcp\.json does not exist; `agsync sync` generates it/);
    });

    it("refuses to start on a name .mcp.json does not define, listing the ones it does", async () => {
      await expect(buildRuntime(await withServers({ mcpServers: { "codebase-memory-mcp": { command: "cbm" } } }, "memory"), {}))
        .rejects.toThrow(/"memory"[\s\S]*defines codebase-memory-mcp/);
    });

    it("refuses to start when the operator server is allowed by name", async () => {
      await expect(buildRuntime(await withServers({ mcpServers: { landrace: { command: "node", args: ["dist/cli.js", "mcp"] } } }, "landrace"), {}))
        .rejects.toThrow(/operator tools must never reach a step agent/);
    });

    it("refuses to start when the operator server is allowed under another name", async () => {
      await expect(buildRuntime(await withServers({ mcpServers: { tickets: { command: "node", args: ["dist/cli.js", "mcp"] } } }, "tickets"), {}))
        .rejects.toThrow(/"tickets"[\s\S]*operator tools must never reach a step agent/);
    });

    // And the refusal comes first: this fixture has no source hook either,
    // and it is the server that is reported, not the hook.
    it("gets past the check when every name resolves", async () => {
      await expect(buildRuntime(await withServers({ mcpServers: { "codebase-memory-mcp": { command: "cbm" } } }, "codebase-memory-mcp"), {}))
        .rejects.toThrow(/no source hook/);
    });
  });
});

describe("the step timeout", () => {
  const workflow = (budget?: Record<string, unknown>): Workflow => ({
    version: 1,
    name: "t",
    stages: [{ id: "a", entry: true }],
    ...(budget === undefined ? {} : { budget }),
  });

  it("reads the workflow's own budget", () => {
    expect(stepTimeoutMs(workflow({ stepTimeout: "10m" }))).toBe(600_000);
    expect(stepTimeoutMs(workflow({ stepTimeout: "90s" }))).toBe(90_000);
  });

  it("falls back to one number when the workflow names none", () => {
    // Not zero and not infinity: a workflow with no budget still has to bound
    // a step, or a hung agent holds its ticket's lock until the process dies.
    expect(stepTimeoutMs(workflow())).toBeGreaterThan(0);
    expect(stepTimeoutMs(workflow({}))).toBe(stepTimeoutMs(workflow()));
  });

  /**
   * A typo must not read as "no budget" and silently fall back. `stepTimeout:
   * 600` looks like it says something and does not — and the operator only
   * finds out when a step they thought was capped at ten minutes is not.
   */
  it("refuses a budget it cannot read, naming the field", () => {
    for (const bad of ["600", "ten minutes", "", "2 m", 600, null, ["10m"]]) {
      expect(() => stepTimeoutMs(workflow({ stepTimeout: bad }))).toThrow(/stepTimeout/);
    }
  });

  /**
   * The wiring itself, asked of a real subprocess rather than of a field.
   * `budget.stepTimeout` was 10m in the shipped workflow and the executor's
   * own default was 10m, so the two agreed by coincidence and nothing would
   * have noticed either one moving.
   */
  it("is what the agent is actually given, not a default that happens to match", async () => {
    const bin = await mkdtemp(join(tmpdir(), "lr-bin-"));
    const cwd = await mkdtemp(join(tmpdir(), "lr-hang-"));
    // The same double the executor's own tests use, under the name the engine
    // spawns, reached the way a real `claude` is reached: through PATH.
    await copyFile(join(__dirname, "..", "agent", "fake-agent.mjs"), join(bin, "claude"));
    await chmod(join(bin, "claude"), 0o755);
    await writeFile(join(cwd, "fake.json"), JSON.stringify({ hang: true }));

    const config = runtimeConfigSchema.parse({ version: 1, agent: { adapter: "claude" } });
    const registry: Registry = { preflights: [], pre: [], post: [], artifacts: [], source: null, operator: null, executors: new Map() };
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ""}`;
    try {
      const executor = executorFor(config, workflow({ stepTimeout: "1s" }), registry, () => {});
      await expect(
        executor.run("x", { round: 1, cwd, signal: new AbortController().signal }),
      ).rejects.toThrow(/exceeded 1000ms/);
    } finally {
      process.env.PATH = path;
    }
  }, 8_000);
});

/**
 * Screening is a security control (§15), and it was always run by the engine's
 * own claude executor: a workflow whose hook registers an executor screened
 * with something the operator never configured — silently, since nothing said
 * so — or, with no claude on the machine, not at all.
 *
 * Then it followed `agent.adapter` and nothing else, so screening on anything
 * but the executor that runs the steps meant moving the steps too; and a hook
 * executor never heard `security.model`, which was fixed into the engine's
 * own executor when it was built.
 */
describe("which executor screens", () => {
  const workflow: Workflow = { version: 1, name: "t", stages: [{ id: "a", entry: true }] };
  const noop = () => {};
  const empty: Registry = { preflights: [], pre: [], post: [], artifacts: [], source: null, operator: null, executors: new Map() };

  const withExecutor = (id: string): Registry => {
    const executor = defineExecutor({ id, run: async () => ({ text: "", sessionId: null }) });
    return { ...empty, executors: new Map([[id, executor]]) };
  };

  it("screens with the hook's executor when agent.adapter names one, asking it for security.model", () => {
    const registry = withExecutor("fake");
    const config = runtimeConfigSchema.parse({ version: 1, agent: { adapter: "fake" }, security: { model: "small" } });
    expect(screenerFor(config, workflow, registry, noop)).toEqual({ executor: registry.executors.get("fake"), model: "small" });
  });

  it("screens with security.adapter's executor while the steps stay on agent.adapter", () => {
    const registry = withExecutor("local");
    const config = runtimeConfigSchema.parse({
      version: 1, agent: { adapter: "claude" }, security: { adapter: "local", model: "llama" },
    });
    expect(screenerFor(config, workflow, registry, noop)).toEqual({ executor: registry.executors.get("local"), model: "llama" });
    expect(executorFor(config, workflow, registry, noop).id).toBe("claude");
  });

  it("refuses a security.adapter no executor answers to, naming the key", () => {
    const config = runtimeConfigSchema.parse({ version: 1, agent: { adapter: "claude" }, security: { adapter: "gpt-9" } });
    expect(() => screenerFor(config, workflow, empty, noop)).toThrow(/security\.adapter "gpt-9"/);
  });

  it("still refuses an agent.adapter no executor answers to, naming the key", () => {
    const config = runtimeConfigSchema.parse({ version: 1, agent: { adapter: "gpt-9" } });
    expect(() => executorFor(config, workflow, empty, noop)).toThrow(/agent\.adapter "gpt-9"/);
    expect(() => screenerFor(config, workflow, empty, noop)).toThrow(/agent\.adapter "gpt-9"/);
  });

  it("asks the engine's own claude for haiku when security.model names none", () => {
    const config = runtimeConfigSchema.parse({ version: 1, agent: { adapter: "claude", model: "opus" } });
    expect(screenerFor(config, workflow, empty, noop)?.model).toBe("haiku");
  });

  it("refuses to screen with a hook's executor when security.model names no model for it", () => {
    const config = runtimeConfigSchema.parse({ version: 1, agent: { adapter: "claude" }, security: { adapter: "local" } });
    expect(() => screenerFor(config, workflow, withExecutor("local"), noop)).toThrow(/security\.model[\s\S]*"local"/);
  });

  // Told apart by where it came from, never by its id: a hook may register
  // "claude" too, and it is still not the engine's, so haiku is still a guess.
  it("refuses a hook's executor registered as \"claude\" when security.model names no model", () => {
    const config = runtimeConfigSchema.parse({ version: 1, agent: { adapter: "claude" } });
    expect(() => screenerFor(config, workflow, withExecutor("claude"), noop)).toThrow(/security\.model[\s\S]*"claude"/);
  });

  it("builds no screener when screening is off", () => {
    const config = runtimeConfigSchema.parse({ version: 1, agent: { adapter: "gpt-9" }, security: { screen: false } });
    expect(screenerFor(config, workflow, empty, noop)).toBeUndefined();
  });
});

/**
 * The loop's executor is the only one that may hand a step create_child, and
 * it starts the server as this very process, pointed at an absolute workflow
 * directory — the agent runs in a worktree, so a relative one would resolve
 * somewhere else entirely.
 */
describe("the create_child server the loop's executor starts", () => {
  const workflow: Workflow = { version: 1, name: "t", stages: [{ id: "a", entry: true }] };
  const config = runtimeConfigSchema.parse({ version: 1, agent: { adapter: "claude" } });
  const registry: Registry = { preflights: [], pre: [], post: [], artifacts: [], source: null, operator: null, executors: new Map() };
  const binding = { parent: "12", stage: "breakdown", round: 2 };

  const withFakeClaude = async <T>(body: (cwd: string) => Promise<T>): Promise<T> => {
    const bin = await mkdtemp(join(tmpdir(), "lr-bin-"));
    const cwd = await mkdtemp(join(tmpdir(), "lr-argv-"));
    await copyFile(join(__dirname, "..", "agent", "fake-agent.mjs"), join(bin, "claude"));
    await chmod(join(bin, "claude"), 0o755);
    await writeFile(join(cwd, "fake.json"), JSON.stringify({ out: "{{ARGV_JSON}}" }));
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ""}`;
    try {
      return await body(cwd);
    } finally {
      process.env.PATH = path;
    }
  };

  it("is this process started again as `landrace mcp` on the absolute workflow directory", async () => {
    const argv = await withFakeClaude(async (cwd) => {
      const executor = executorFor(config, workflow, registry, () => {}, { dir: "relative/.landrace" });
      const r = await executor.run("x", {
        round: 1, cwd, capabilities: ["tickets:create"], child: binding, signal: new AbortController().signal,
      });
      return JSON.parse(r.text) as string[];
    });
    const server = JSON.parse(argv[argv.indexOf("--mcp-config") + 1] as string).mcpServers.landrace;
    expect(server.command).toBe(process.execPath);
    expect(server.args).toEqual([
      ...process.execArgv, process.argv[1],
      "mcp", "--workflow", resolve("relative/.landrace"), "--child", "12", "--stage", "breakdown", "--round", "2",
    ]);
  });

  it("is not offered by an executor built without the directory, which refuses the step instead", async () => {
    await withFakeClaude(async (cwd) => {
      const executor = executorFor(config, workflow, registry, () => {});
      await expect(executor.run("x", {
        round: 1, cwd, capabilities: ["tickets:create"], child: binding, signal: new AbortController().signal,
      })).rejects.toThrow(/cannot give this step create_child/);
    });
  });

  /*
   * The same wiring for what `agent.plugins` and `agent.mcp` resolved to: an
   * option the assembler accepts and never hands on is a control that reads as
   * configured and never runs.
   */
  it("hands the step the plugins and servers it was given, beside its child server", async () => {
    const tools = { plugins: ["superpowers@claude-plugins-official"], mcpServers: { "codebase-memory-mcp": { command: "cbm" } }, mcpTools: {} };
    const argv = await withFakeClaude(async (cwd) => {
      const executor = executorFor(config, workflow, registry, () => {}, { dir: "relative/.landrace", tools });
      const r = await executor.run("x", {
        round: 1, cwd, capabilities: ["tickets:create"], child: binding, signal: new AbortController().signal,
      });
      return JSON.parse(r.text) as string[];
    });
    const servers = JSON.parse(argv[argv.indexOf("--mcp-config") + 1] as string).mcpServers;
    expect(Object.keys(servers).sort()).toEqual(["codebase-memory-mcp", "landrace"]);
    expect(JSON.parse(argv[argv.indexOf("--settings") + 1] as string)).toEqual({
      enabledPlugins: { "superpowers@claude-plugins-official": true },
    });
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

describe("boardSink", () => {
  /**
   * A display must never be able to stop the work it displays: the sink is
   * called from inside runStep outside any try (see the comment on it in
   * runStart), so a throwing observe would otherwise abort an agent step
   * mid-run. Deleting the sink's own try/catch made all 361 other cli/ui/
   * runner tests still pass, which is exactly the gap this closes.
   */
  it("lets print still receive the event when the board's observe throws, and reports via console.error", () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation();
    try {
      const printed: LandraceEvent[] = [];
      const board: { current?: Board } = {
        current: {
          observe: () => { throw new Error("display broke"); },
          list: () => {},
          view: async () => ({ generatedAt: 0, rows: [], nextTickAt: null, folder: "f", workspace: "/w" }),
        },
      };
      const sink = boardSink((e) => printed.push(e), board);
      const event: LandraceEvent = { name: "step.started", ticket: "1" };

      expect(() => sink(event)).not.toThrow();
      expect(printed).toEqual([event]);
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(String(consoleErrorSpy.mock.calls[0]?.[0])).toMatch(/display broke/);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("still hands the event to both print and a board whose observe behaves", () => {
    const printed: LandraceEvent[] = [];
    const observed: LandraceEvent[] = [];
    const board: { current?: Board } = {
      current: {
        observe: (e) => { observed.push(e); },
        list: () => {},
        view: async () => ({ generatedAt: 0, rows: [], nextTickAt: null, folder: "f", workspace: "/w" }),
      },
    };
    const event: LandraceEvent = { name: "step.finished", ticket: "1" };

    boardSink((e) => printed.push(e), board)(event);

    expect(printed).toEqual([event]);
    expect(observed).toEqual([event]);
  });
});

describe("parsePort", () => {
  it.each(["1", "4545", "65535"])("accepts %s", (p) => expect(parsePort(p)).toBe(Number(p)));
  it.each(["0", "65536", "-1", "80.5", "abc", ""])("refuses %s, naming the flag", (p) => {
    expect(() => parsePort(p)).toThrow(/--ui-port/);
  });
});

describe("repoWorkspace", () => {
  it("reports the repository's own top-level directory and its name, from a subdirectory", async () => {
    // Reuses this checkout rather than a fixture repo: repositoryRoot's own
    // behaviour is already pinned by tests/agent/worktree.test.ts, so this
    // only needs to prove repoWorkspace calls it and derives `folder`
    // from what it returns.
    const { folder, workspace } = await repoWorkspace(process.cwd());
    expect(workspace.endsWith(folder)).toBe(true);
    expect(workspace).not.toContain("\n");
  });

  it("falls back to process.cwd() outside a repository, rather than refusing", async () => {
    const plain = await mkdtemp(join(tmpdir(), "lr-plain-workspace-"));
    const { folder, workspace } = await repoWorkspace(plain);
    expect(workspace).toBe(process.cwd());
    expect(folder).toBe(process.cwd().split("/").pop());
  });
});

describe("startUi", () => {
  const board = () =>
    createBoard({ workflow: { version: 1, name: "t", stages: [] }, held: async () => null, folder: "f", workspace: "/w", nest: [] });

  it("serves nothing with --no-ui", async () => {
    expect(await startUi({ board: board(), ui: false, once: false, port: 0 })).toBeNull();
  });

  it("serves nothing for --once, which has nobody to watch it", async () => {
    expect(await startUi({ board: board(), ui: true, once: true, port: 0 })).toBeNull();
  });

  it("serves the board otherwise", async () => {
    const ui = await startUi({ board: board(), ui: true, once: false, port: 0 });
    expect(ui?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    await ui?.close();
  });

  it("refuses a taken port, naming both ways out", async () => {
    const squatter = createServer();
    await new Promise<void>((r) => squatter.listen(0, "127.0.0.1", r));
    const port = (squatter.address() as { port: number }).port;
    try {
      await expect(startUi({ board: board(), ui: true, once: false, port })).rejects.toThrow(/--ui-port.*--no-ui|--no-ui.*--ui-port/);
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()));
    }
  });

  /**
   * The wiring itself: startUi is the one place a caller's `tick` reaches
   * serveBoard, so this is what stands between the schedule's own trigger and
   * a working POST /tick — proven with a real request rather than a spy on
   * serveBoard, since a mocked call site is exactly the kind of "looks right"
   * this codebase's testing rule warns against.
   */
  it("passes tick through to serveBoard, so POST /tick reaches it", async () => {
    const tick = jest.fn(() => true);
    const ui = await startUi({ board: board(), ui: true, once: false, port: 0, tick });
    try {
      const res = await fetch(`http://127.0.0.1:${ui?.port}/tick`, {
        method: "POST",
        headers: { "x-landrace-action": "tick", origin: `http://127.0.0.1:${ui?.port}` },
      });
      expect(res.status).toBe(202);
      expect(tick).toHaveBeenCalledTimes(1);
    } finally {
      await ui?.close();
    }
  });

  it("without tick, POST /tick is 404 even though the page is served", async () => {
    const ui = await startUi({ board: board(), ui: true, once: false, port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${ui?.port}/tick`, {
        method: "POST",
        headers: { "x-landrace-action": "tick" },
      });
      expect(res.status).toBe(404);
    } finally {
      await ui?.close();
    }
  });
});

const WF: Workflow = { version: 1, name: "t", stages: [
  { id: "spec", entry: true, step: "steps/spec.md",
    on_enter: [{ type: "tracker.comment", kind: "enter", marker: "enter:{stage}:{round}" }],
    triggers: [{ when: { "run.stage": null } }] },
  { id: "blocked", goto: ["spec"], triggers: [{ when: { "run.lastOutputValid": false } }] },
] };

describe("the page's Retry and Go to step", () => {
  it("is absent when no hook can write a record", () => {
    const tracker = createFakeTracker([]);
    expect(gotoFor({ source: tracker.registry.source as Source, pre: [], dispatcher: createDispatcher([]), ctx: tracker.ctx, workflow: WF })).toBeUndefined();
  });

  it("sends a stopped ticket back to the stage that failed", async () => {
    const tracker = createFakeTracker([{ number: 19, labels: ["lr:auto", "lr:stage:blocked", "lr:blocked"] }]);
    tracker.say(19, `broken${renderMarker({ stage: "spec", kind: "malformed", round: 1 })}`);
    const path = gotoFor({
      source: tracker.registry.source as Source, pre: tracker.registry.pre,
      dispatcher: createDispatcher(tracker.registry.post), ctx: tracker.ctx, workflow: WF,
    });
    expect(await path?.send("19", null)).toEqual({ to: "spec" });
  });
});

/**
 * `loop`'s own orchestration, against a stub Schedule and a bare
 * AbortController rather than a real Runtime — everything else `loop` reads
 * off `rt` is `rt.stop.signal`, so a full Runtime would only pad these tests
 * with fields they never touch.
 *
 * The types already stop `nextAt`/`trigger` being swapped at the call site in
 * `runStart`, but nothing short of running `loop` itself catches it forgetting
 * to start the schedule, a schedule left running past stop, or an in-flight
 * tick being abandoned rather than waited out — and that last one is the lock
 * a stray Ctrl-C would otherwise leave held.
 */
describe("loop", () => {
  const fakeRuntime = (stop: AbortController): Runtime => ({ stop }) as unknown as Runtime;

  it("starts the schedule, stops it once asked to stop, and calls nothing further", async () => {
    const schedule: Schedule = {
      start: jest.fn(),
      stop: jest.fn(),
      nextAt: () => null,
      trigger: jest.fn(() => true),
    };
    const stop = new AbortController();
    stop.abort(); // already stopping before loop even starts waiting

    await loop(fakeRuntime(stop), schedule, new Set());

    expect(schedule.start).toHaveBeenCalledTimes(1);
    expect(schedule.stop).toHaveBeenCalledTimes(1);
    expect(schedule.trigger).not.toHaveBeenCalled();
  });

  it("does not resolve until a tick already in flight finishes, even after the schedule is stopped", async () => {
    const order: string[] = [];
    const schedule: Schedule = {
      start: () => order.push("start"),
      stop: () => order.push("stop"),
      nextAt: () => null,
      trigger: () => true,
    };
    const stop = new AbortController();
    const inFlight = new Set<Promise<void>>();
    let resolveManual: () => void = () => {};
    inFlight.add(new Promise<void>((resolve) => { resolveManual = resolve; }));

    stop.abort();
    let resolved = false;
    const p = loop(fakeRuntime(stop), schedule, inFlight).then(() => { resolved = true; });

    // Let the abort-signal microtasks settle: schedule.stop() has already
    // run, but the ticket still holding its lock has not, so loop must not
    // have resolved — resolving here is exactly the "released the lock
    // before the work was done" bug this guards.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(order).toEqual(["start", "stop"]);
    expect(resolved).toBe(false);

    resolveManual();
    await p;
    expect(resolved).toBe(true);
  });
});
