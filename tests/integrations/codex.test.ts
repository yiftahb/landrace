import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Codex } from "landrace/integrations/codex";
import { loadConfig } from "#config/load.js";
import { hookKindOf } from "#hooks/contracts.js";
import type { Executor, ExecutorContext } from "#namespace.js";
import { loadWorkflow } from "#workflow/load.js";
import { gitRepo, removeRepos } from "#tests/support/repo.js";

afterAll(removeRepos);

const bin = join(__dirname, "..", "agent", "fake-codex.mjs");
const dirs: string[] = [];
const temp = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  delete process.env.LANDRACE_TEST_SECRET;
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** A working root scripted for the fake: what it answers, and what else it prints first. */
const withCfg = (cfg: Record<string, unknown>): string => {
  const dir = temp("fake-codex-");
  writeFileSync(join(dir, "fake.json"), JSON.stringify(cfg));
  return dir;
};

const NONE = { servers: {}, tools: {}, sandbox: { hosts: [], deny: [] } };
const codex = (settings: Record<string, unknown> = {}, home = temp("codex-home-")): Executor =>
  new Codex({ bin, home }).build({ ...NONE, ...settings });

const run = (executor: Executor, opts: Record<string, unknown> = {}) =>
  executor.run("p", { round: 1, signal: new AbortController().signal, ...opts });

/** The argv a run was started with. */
const argvOf = async (executor: Executor, opts: Record<string, unknown> = {}): Promise<string[]> => {
  const cwd = withCfg({ out: "{{ARGV_JSON}}" });
  return JSON.parse((await run(executor, { cwd, ...opts })).text) as string[];
};

/** Every `-c` override, as written. */
const overrides = (argv: string[]): string[] => argv.flatMap((a, i) => (argv[i - 1] === "-c" ? [a] : []));

const SERVER = {
  name: "landrace",
  command: "/usr/bin/node",
  args: ["cli.js", "mcp", "--child", "12"],
  tools: ["landrace_create_child"],
};

describe("the Codex integration", () => {
  it("is an executor hook registered as codex", () => {
    const hook = new Codex();
    expect(hook.id).toBe("codex");
    expect(hookKindOf(hook)).toBe("executor");
  });

  describe("its command line", () => {
    /*
     * `--ignore-user-config` and `--ignore-rules`: the operator's own
     * config.toml holds their servers — landrace's operator server among
     * them — and an execpolicy rule can let a command out of the sandbox, so a
     * run loads neither, and gets exactly the servers it is given. The prompt
     * goes on stdin (`-`), never argv, which `ps` shows anyone.
     */
    it("runs a read-only step in the read-only sandbox, asking nothing, loading nothing of the operator's", async () => {
      expect(await argvOf(codex(), { capabilities: ["repo:read"] })).toEqual([
        "exec", "--json", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules",
        "-c", 'approval_policy="never"', "-c", 'sandbox_mode="read-only"', "-",
      ]);
    });

    /*
     * workspace-write also opens $TMPDIR and /tmp unless told not to, and
     * $TMPDIR/landrace/<repo>/ holds every other ticket's worktree, the locks
     * and the pairing seeds, and the screener's own directory.
     */
    it("runs a writing step in the workspace-write sandbox, with no network and no temp directory", async () => {
      const argv = overrides(await argvOf(codex(), { capabilities: ["repo:read", "repo:write"] }));
      expect(argv).toContain('sandbox_mode="workspace-write"');
      expect(argv).toContain("sandbox_workspace_write.network_access=false");
      expect(argv).toContain("sandbox_workspace_write.exclude_tmpdir_env_var=true");
      expect(argv).toContain("sandbox_workspace_write.exclude_slash_tmp=true");
    });

    /*
     * The screener reads attacker-reachable text for a living: read-only,
     * every built-in tool off, no server whatever the steps are given — and
     * run outside the operator's checkout, whose own `.codex/config.toml`
     * (agsync writes one) would otherwise load beside it.
     */
    it("gives the screener no tool, no server, no effort, and no project of the operator's", async () => {
      // No cwd, as the screener is run: the fake, unscripted, answers with its argv.
      const executor = codex({ effort: "high", servers: { memory: { command: "m" } } });
      const argv = JSON.parse((await run(executor, { model: "gpt-5.1-codex-mini" })).text) as string[];
      const set = overrides(argv);
      expect(set).toContain('sandbox_mode="read-only"');
      expect(set).toEqual(expect.arrayContaining([
        "features.shell_tool=false", "features.unified_exec=false", "features.view_image=false",
        "features.apps=false", "features.plugins=false", "features.multi_agent=false", 'web_search="disabled"',
      ]));
      expect(set.some((s) => s.startsWith("mcp_servers."))).toBe(false);
      expect(set.some((s) => s.startsWith("model_reasoning_effort"))).toBe(false);
      expect(argv[argv.indexOf("-m") + 1]).toBe("gpt-5.1-codex-mini");
    });

    /*
     * Not the temp directory itself: on Linux that is /tmp, where any local
     * user can leave an AGENTS.md telling the screener to answer ok — with
     * the nonce its own prompt carries — or a .codex/config.toml that makes
     * every screening refuse. A directory of its own, that only this user
     * can write.
     */
    it("screens in a directory of its own that nobody else can write", async () => {
      const argv = JSON.parse((await run(codex())).text) as string[];
      const dir = argv[argv.indexOf("-C") + 1] ?? "";
      expect(dir.startsWith(join(tmpdir(), "landrace-screen-"))).toBe(true);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    });

    // Codex, finding no `.git`, loads a project's settings from where it
    // works alone: a /tmp/.codex/config.toml anyone left is not the
    // screener's, and must not refuse every screening.
    it("screens beside a codex config in the temp directory above its own", async () => {
      const shared = temp("shared-tmp-");
      mkdirSync(join(shared, ".codex"));
      writeFileSync(join(shared, ".codex", "config.toml"), "[mcp_servers.x]\ncommand = \"x\"\n");
      const at = jest.spyOn(os, "tmpdir").mockReturnValue(shared);
      try {
        const argv = JSON.parse((await run(codex())).text) as string[];
        expect(argv[argv.indexOf("-C") + 1]?.startsWith(join(shared, "landrace-screen-"))).toBe(true);
      } finally {
        at.mockRestore();
      }
    });

    it("puts the model and the effort on a step's command line, the step's own winning", async () => {
      const argv = await argvOf(codex({ model: "gpt-5.1-codex", effort: "high" }), { capabilities: ["repo:read"], effort: "low" });
      expect(argv[argv.indexOf("-m") + 1]).toBe("gpt-5.1-codex");
      expect(overrides(argv)).toContain('model_reasoning_effort="low"');
    });

    it("refuses an effort codex has no level for, naming the ones it has", async () => {
      await expect(run(codex(), { cwd: withCfg({}), capabilities: ["repo:read"], effort: "max" }))
        .rejects.toThrow(/refused effort "max"[\s\S]*none, low, medium, high, xhigh/);
    });

    it("resumes a session with `exec resume`, and forks one with `exec fork`", async () => {
      expect((await argvOf(codex(), { capabilities: ["repo:read"], resume: "sid-9" })).slice(0, 3)).toEqual(["exec", "resume", "sid-9"]);
      expect((await argvOf(codex(), { capabilities: ["repo:read"], resume: "sid-9", fork: true })).slice(0, 3)).toEqual(["exec", "fork", "sid-9"]);
    });

    /*
     * `.mcp.json`'s servers, per run, as `-c mcp_servers.<name>.*`: nothing
     * written anywhere for the worktree to shadow. A server whose entry lists
     * tools gets exactly those.
     */
    it("hands a step its servers and the engine's bound one, each tool list as listed", async () => {
      const executor = codex({
        servers: { memory: { command: "cbm", args: ["--x"], env: { MEMORY_HOME: "/var/m" } }, docs: { url: "https://d.example/mcp", headers: { Authorization: "Bearer t" } } },
        tools: { memory: ["search_graph"] },
      });
      const set = overrides(await argvOf(executor, {
        capabilities: ["tickets:create", "repo:read"], child: { parent: "12", stage: "s", round: 1, server: SERVER },
      }));
      expect(set).toEqual(expect.arrayContaining([
        'mcp_servers.memory.command="cbm"', 'mcp_servers.memory.args=["--x"]', 'mcp_servers.memory.env.MEMORY_HOME="/var/m"',
        'mcp_servers.memory.enabled_tools=["search_graph"]',
        'mcp_servers.docs.url="https://d.example/mcp"', 'mcp_servers.docs.http_headers.Authorization="Bearer t"',
        'mcp_servers.landrace.command="/usr/bin/node"', 'mcp_servers.landrace.args=["cli.js","mcp","--child","12"]',
        'mcp_servers.landrace.enabled_tools=["landrace_create_child"]',
      ]));
      expect(set.some((s) => s.startsWith("mcp_servers.docs.enabled_tools"))).toBe(false);
    });

    it("refuses a server whose name a -c key path cannot carry, before anything runs", async () => {
      const cwd = withCfg({ mark: true });
      await expect(run(codex({ servers: { "a.b": { command: "x" } } }), { cwd, capabilities: ["repo:read"] })).rejects.toThrow(/"a\.b"/);
      expect(existsSync(join(cwd, "spawned"))).toBe(false);
    });

    it.each([
      ["variable", { command: "x", env: { "a.b": "v" } }, /"a\.b"/],
      ["header", { url: "https://d.example/mcp", headers: { "X.Api.Key": "k" } }, /"X\.Api\.Key"/],
    ])("refuses a server with a %s name a -c key path cannot carry, before anything runs", async (_, server, named) => {
      const cwd = withCfg({ mark: true });
      await expect(run(codex({ servers: { docs: server } }), { cwd, capabilities: ["repo:read"] })).rejects.toThrow(named);
      expect(existsSync(join(cwd, "spawned"))).toBe(false);
    });

    it("passes CODEX_HOME on, and nothing else of the engine's environment", async () => {
      const saved = process.env.CODEX_HOME;
      process.env.CODEX_HOME = "/somewhere/codex";
      process.env.LANDRACE_TEST_SECRET = "super-secret-value";
      try {
        const cwd = withCfg({ out: "[{{ENV:CODEX_HOME}}|{{ENV:LANDRACE_TEST_SECRET}}]" });
        expect((await run(codex(), { cwd })).text).toBe("[/somewhere/codex|]");
      } finally {
        if (saved === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = saved;
      }
    });
  });

  describe("what it prints", () => {
    it("answers with its last message and the thread's id", async () => {
      const cwd = withCfg({ out: "the answer", thread: "0199a213-0000-7000-8000-000000000001" });
      expect(await run(codex(), { cwd })).toEqual({ text: "the answer", sessionId: "0199a213-0000-7000-8000-000000000001" });
    });

    it("reports each message, command, file change and tool call as it goes, and logs no command's output", async () => {
      const cwd = withCfg({
        out: "done",
        events: [
          { type: "item.completed", item: { id: "i1", type: "reasoning", text: "thinking" } },
          { type: "item.completed", item: { id: "i2", type: "agent_message", text: "Looking at the parser." } },
          { type: "item.completed", item: { id: "i3", type: "command_execution", command: "pnpm test", aggregated_output: "TOKEN=ghp_from_output", exit_code: 0, status: "completed" } },
          { type: "item.completed", item: { id: "i4", type: "file_change", changes: [{ path: "{{CWD}}/src/a.ts", kind: "update" }], status: "completed" } },
          { type: "item.completed", item: { id: "i5", type: "mcp_tool_call", server: "memory", tool: "search_graph", status: "completed" } },
        ],
      });
      const seen: Array<{ kind: string; text: string }> = [];
      const logged: unknown[] = [];
      const executor = codex({ log: (name: string, data?: unknown) => { if (name === "agent.event") logged.push(data); } });
      await run(executor, { cwd, onActivity: (e: { kind: string; text: string }) => seen.push({ kind: e.kind, text: e.text }) });
      expect(seen).toEqual([
        { kind: "message", text: "Looking at the parser." },
        { kind: "tool", text: "shell pnpm test" },
        { kind: "tool", text: "edit src/a.ts" },
        { kind: "tool", text: "mcp memory.search_graph" },
        { kind: "message", text: "done" },
      ]);
      expect(JSON.stringify(logged)).not.toContain("ghp_from_output");
    });

    it("refuses a run whose turn failed, with codex's own reason", async () => {
      await expect(run(codex(), { cwd: withCfg({ fail: "usage limit reached" }) })).rejects.toThrow(/usage limit reached/);
    });
  });

  /*
   * A project's own `.codex/config.toml` loads beside the run, and a step
   * could commit one to the branch: servers of its own, a looser sandbox. So a
   * run where one would load is refused, and never started.
   */
  describe("a project's own codex config", () => {
    it("refuses a run in a checkout carrying one, anywhere up to the repository root", async () => {
      const root = await gitRepo();
      mkdirSync(join(root, ".codex"));
      writeFileSync(join(root, ".codex", "config.toml"), "[mcp_servers.x]\ncommand = \"x\"\n");
      const cwd = join(root, "sub");
      mkdirSync(cwd);
      writeFileSync(join(cwd, "fake.json"), JSON.stringify({ mark: true }));
      await expect(run(codex(), { cwd, capabilities: ["repo:read"] })).rejects.toThrow(/\.codex\/config\.toml/);
      expect(existsSync(join(cwd, "spawned"))).toBe(false);
    });

    // The same threat as config.toml, and Claude met it: a committed hooks
    // file's SessionStart runs on the branch's next step.
    it("refuses a run in a checkout carrying a project hooks.json", async () => {
      const root = await gitRepo();
      mkdirSync(join(root, ".codex"));
      writeFileSync(join(root, ".codex", "hooks.json"), "{\"hooks\":{}}\n");
      writeFileSync(join(root, "fake.json"), JSON.stringify({ mark: true }));
      await expect(run(codex(), { cwd: root, capabilities: ["repo:read", "repo:write"] })).rejects.toThrow(/\.codex\/hooks\.json/);
      expect(existsSync(join(root, "spawned"))).toBe(false);
    });

    it("does not count the operator's own codex home as a project's", async () => {
      const home = temp("user-home-");
      const codexHome = join(home, ".codex");
      mkdirSync(codexHome);
      writeFileSync(join(codexHome, "config.toml"), "model = \"x\"\n");
      const cwd = join(home, "work");
      mkdirSync(cwd);
      writeFileSync(join(cwd, "fake.json"), JSON.stringify({ out: "ran" }));
      expect((await run(codex({}, codexHome), { cwd, capabilities: ["repo:read"] })).text).toBe("ran");
    });
  });

  /*
   * Codex cannot start a session under an id it is given, so a pairing
   * carries on the agent's own: its session file copied under the engine's
   * id, which is what the person resumes, and Finish later forks.
   */
  describe("handing a session to a person", () => {
    const ENGINE = "0b7f4c1e-9a2d-5e3f-8c4b-1d2e3f4a5b6c";
    const AGENT = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    const setup = () => {
      const home = temp("codex-home-");
      const cwd = temp("pair-");
      const promptFile = join(home, "seed.md");
      writeFileSync(promptFile, "You are pairing.");
      return { home, cwd, promptFile, executor: new Codex({ bin: "codex", home }).build(NONE) };
    };
    const rollout = (home: string, id: string): string => {
      const day = join(home, "sessions", "2026", "09", "29");
      mkdirSync(day, { recursive: true });
      const file = join(day, `rollout-2026-09-29T10-00-00-${id}.jsonl`);
      writeFileSync(file, `${JSON.stringify({ type: "session_meta", payload: { id, cwd: "/elsewhere" } })}\n{"type":"event_msg"}\n`);
      return file;
    };

    it("refuses a pairing from scratch, saying why and to release it", async () => {
      const { cwd, promptFile, executor } = setup();
      await expect(executor.handoff?.({ cwd, session: ENGINE, promptFile }))
        .rejects.toThrow(/codex executor can only carry on the agent's own session[\s\S]*Release the pairing/);
    });

    it("continues the agent's session under the engine's id, seeded, with the engine's server", async () => {
      const { home, cwd, promptFile, executor } = setup();
      rollout(home, AGENT);
      const hand = await executor.handoff?.({ cwd, session: ENGINE, promptFile, resume: AGENT, server: { ...SERVER, tools: [] } });
      expect(hand).toEqual({
        cwd,
        argv: ["codex", "resume", "-c", 'mcp_servers.landrace.command="/usr/bin/node"', "-c", 'mcp_servers.landrace.args=["cli.js","mcp","--child","12"]',
          ENGINE, { file: promptFile }],
      });
      const copy = join(home, "sessions", "2026", "09", "29", `rollout-2026-09-29T10-00-00-${ENGINE}.jsonl`);
      expect(readFileSync(copy, "utf8")).toBe(`${JSON.stringify({ type: "session_meta", payload: { id: ENGINE, cwd: "/elsewhere" } })}\n{"type":"event_msg"}\n`);
    });

    it("keeps the seed when asked again before the person ran it, and drops it once codex added to the copy", async () => {
      const { home, cwd, promptFile, executor } = setup();
      rollout(home, AGENT);
      const seeded = ["codex", "resume", ENGINE, { file: promptFile }];
      expect((await executor.handoff?.({ cwd, session: ENGINE, promptFile, resume: AGENT }))?.argv).toEqual(seeded);
      expect((await executor.handoff?.({ cwd, session: ENGINE, promptFile, resume: AGENT }))?.argv).toEqual(seeded);
      appendFileSync(join(home, "sessions", "2026", "09", "29", `rollout-2026-09-29T10-00-00-${ENGINE}.jsonl`), '{"type":"response_item"}\n');
      expect((await executor.handoff?.({ cwd, session: ENGINE, promptFile, resume: AGENT }))?.argv).toEqual(["codex", "resume", ENGINE]);
    });

    it("resumes the engine's session once it exists — the command run a second time", async () => {
      const { home, cwd, promptFile, executor } = setup();
      rollout(home, ENGINE);
      expect((await executor.handoff?.({ cwd, session: ENGINE, promptFile, resume: AGENT }))?.argv).toEqual(["codex", "resume", ENGINE]);
    });

    it("refuses when the agent's session is nowhere under CODEX_HOME, rather than starting a fresh one", async () => {
      const { cwd, promptFile, executor } = setup();
      await expect(executor.handoff?.({ cwd, session: ENGINE, promptFile, resume: AGENT }))
        .rejects.toThrow(new RegExp(`${AGENT}[\\s\\S]*Release the pairing`));
    });
  });

  describe("create(), at startup", () => {
    const ctxFor = (agent: Record<string, unknown>, steps?: ExecutorContext["steps"]): ExecutorContext => ({
      config: { agent } as unknown as ExecutorContext["config"],
      secrets: new Map(), signal: new AbortController().signal, log: () => {}, dir: temp("codex-dir-"), redact: () => {},
      ...(steps === undefined ? {} : { steps }),
    });

    // Codex's sandbox has the network on or off, and no list of hosts.
    it("refuses sandbox hosts it cannot hold a write step to", async () => {
      await expect(new Codex().create(ctxFor({ adapter: "codex", sandbox: { hosts: ["github.com"], deny: [] } })))
        .rejects.toThrow(/agent\.sandbox\.hosts[\s\S]*github\.com[\s\S]*on or off/);
    });

    // And no way to keep a command from reading a path: the default deny
    // list is refused too, until the operator writes `deny: []`.
    it("refuses a deny list it cannot keep, the default one included, and takes deny: []", async () => {
      await expect(new Codex().create(ctxFor({ adapter: "codex" })))
        .rejects.toThrow(/agent\.sandbox\.deny[\s\S]*~\/\.ssh[\s\S]*every step and conversation turn, read-only ones too[\s\S]*deny: \[\]/);
      await expect(new Codex().create(ctxFor({ adapter: "codex", sandbox: { deny: [] } }))).resolves.toBeDefined();
    });

    it("refuses a key only another integration reads", async () => {
      await expect(new Codex().create(ctxFor({ adapter: "codex", sandbox: { deny: [] }, plugins: ["p@m"] })))
        .rejects.toThrow(/agent\.plugins is not a setting the codex executor reads/);
    });

    it("names the shipped spec step's max, which codex has no level for", async () => {
      const loaded = await loadConfig(".landrace");
      const { steps } = await loadWorkflow(".landrace", loaded.vars);
      await expect(new Codex().create(ctxFor({ adapter: "codex", sandbox: { deny: [] } }, steps)))
        .rejects.toThrow(/steps\/spec\.md asks for effort "max", which the codex executor does not take: none, low, medium, high, xhigh/);
    });

    it("screens beside another agent without reading that agent's block", async () => {
      await expect(new Codex().create(ctxFor({ adapter: "claude", plugins: ["p@m"] }))).resolves.toBeDefined();
    });
  });
});
