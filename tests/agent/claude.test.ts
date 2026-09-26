import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeExecutor } from "#agent/claude.js";

// File-relative, not cwd-relative: `jest --rootDir .. agent/claude.test.ts`
// run from tests/ previously broke a process.cwd()-based path with ENOENT.
// `import.meta.url` is the idiomatic ESM form of this, but it does not
// compile here — ts-jest's non-isolated-modules diagnostics pass mis-detects
// this "hybrid" (NodeNext) module kind as CommonJS and rejects import.meta
// with TS1343, a known ts-jest limitation (its own TS151002 warning, printed
// for every file in this suite, names the same "hybrid module kind" gap).
// `__dirname` works because jest's runtime, despite the ESM preset, still
// executes each test file inside jest-runtime's CommonJS module wrapper
// (confirmed: `(module,exports,require,__dirname,__filename,jest)`), which
// supplies a real, correct, file-relative `__dirname` — verified directly
// rather than assumed, after the same import.meta.url form was re-tried and
// re-failed four separate ways (single-file, full-suite, and with
// isolatedModules forced on via both the ts-jest transform option and
// tsconfig's own compilerOptions — both of which broke ESM output for every
// file in the suite, confirmed and reverted).
const bin = join(__dirname, "fake-agent.mjs");

// The fake agent reads its script from `fake.json` in its cwd, not from
// inherited env vars — the executor under test does not forward the parent's
// environment to the child, so env vars set here would never arrive.
const dirs: string[] = [];
const withCfg = (cfg: Record<string, unknown>): string => {
  const dir = mkdtempSync(join(tmpdir(), "fake-agent-"));
  writeFileSync(join(dir, "fake.json"), JSON.stringify(cfg));
  dirs.push(dir);
  return dir;
};

const run = (
  prompt: string,
  over: Record<string, unknown> = {},
  runOver: Record<string, unknown> = {},
) =>
  createClaudeExecutor({ bin, ...over }).run(prompt, {
    round: 1,
    signal: new AbortController().signal,
    ...runOver,
  });

/** The argv a run was started with, element by element — an inline JSON config is one element. */
const argvOf = async (
  executor: ReturnType<typeof createClaudeExecutor>,
  opts: {
    capabilities?: readonly string[];
    model?: string;
    child?: { parent: string; stage: string; round: number };
  },
): Promise<string[]> => {
  const cwd = withCfg({ out: "{{ARGV_JSON}}" });
  const r = await executor.run("p", { round: 1, signal: new AbortController().signal, cwd, ...opts });
  return JSON.parse(r.text) as string[];
};

/** The value a flag was given — the single element after it. */
const flag = (argv: string[], name: string): string | undefined =>
  argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;

/**
 * Everything a variadic flag was given: the CLI reads values until the next
 * flag, so this does too — which is exactly what a test of where a list ends
 * has to read.
 */
const list = (argv: string[], name: string): string[] => {
  if (!argv.includes(name)) return [];
  const rest = argv.slice(argv.indexOf(name) + 1);
  const end = rest.findIndex((a) => a.startsWith("-"));
  return end === -1 ? rest : rest.slice(0, end);
};

const WRITE_TOOLS = ["Bash", "Edit", "MultiEdit", "NotebookEdit", "Write"] as const;
const PLUGIN = "superpowers@claude-plugins-official";
const MEMORY = { command: "codebase-memory-mcp", args: [], env: { MEMORY_HOME: "/var/memory" } };
const CHILD_SERVER = { command: "/usr/bin/node", args: ["/opt/landrace/cli.js", "mcp", "--workflow", "/repo/.landrace"] };
const BINDING = { parent: "12", stage: "breakdown", round: 2 };

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until there is an answer, rather than sleeping for a fixed budget.
 *
 * A fixed sleep here is a bet on how fast a loaded machine can start a node
 * process, and that bet is what flaked: 6 failures out of 6 with 14 busy
 * cores alongside, 0 out of 6 idle. The cap is generous because it is not the
 * thing being measured — it exists so a genuine regression fails with a
 * sentence rather than hanging until jest gives up.
 */
const until = async <T>(answer: () => T | null, what: string, tries = 1_000): Promise<T> => {
  for (let i = 0; i < tries; i++) {
    const got = answer();
    if (got !== null) return got;
    await wait(10);
  }
  throw new Error(`timed out waiting for ${what}`);
};

afterEach(() => {
  delete process.env.LANDRACE_TEST_SECRET;
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("claude executor", () => {
  it("passes the prompt on stdin and returns text with the session id", async () => {
    const dir = withCfg({ out: "got {{LEN}} chars" });
    const r = await run("hello world", {}, { cwd: dir });
    expect(r.text).toBe("got 11 chars");
    expect(r.sessionId).toBe("sid-1");
  });

  it("asks for json output, because that is what carries the session id", async () => {
    const dir = withCfg({ out: "{{ARGV}}" });
    expect((await run("x", {}, { cwd: dir })).text).toContain("--output-format json");
  });

  it("passes --resume so a conversation continues", async () => {
    const dir = withCfg({ out: "{{ARGV}}" });
    const r = await createClaudeExecutor({ bin }).run("x", {
      round: 2,
      resume: "sid-9",
      cwd: dir,
      signal: new AbortController().signal,
    });
    expect(r.text).toContain("--resume sid-9");
  });

  /*
   * A run that declares nothing is the screener's: it is handed no step's
   * capabilities, and it reads attacker-reachable text for a living. So it
   * gets nothing at all — no built-in tool (`--tools ""`), no MCP server (an
   * empty, strict config), and none of the plugins or servers an operator
   * gives the steps: a plugin that injects its own instructions at session
   * start would be talking to the one agent whose only job is to judge a
   * prompt.
   *
   * And manual mode, not plan mode, which is what it ran in until a live check
   * against the real CLI (2.1.282) showed plan mode ignores `--model`: the
   * screener configured as haiku was screening on sonnet, while the events
   * said haiku.
   */
  it("gives a run that declares nothing — the screener's — no tool and no server, whatever the steps are given", async () => {
    const argv = await argvOf(
      createClaudeExecutor({ bin, plugins: [PLUGIN], mcpServers: { "codebase-memory-mcp": MEMORY } }),
      {},
    );
    expect(argv).toEqual([
      "-p", "--output-format", "json", "--permission-mode", "manual", "--restricted", "--tools", "",
      "--mcp-config", JSON.stringify({ mcpServers: {} }), "--strict-mcp-config",
    ]);
  });

  it("hands the screener the model it was configured with, which plan mode ignored", async () => {
    const argv = await argvOf(createClaudeExecutor({ bin, model: "haiku" }), {});
    expect(flag(argv, "--permission-mode")).toBe("manual");
    expect(flag(argv, "--model")).toBe("haiku");
    // `--tools` is variadic: the empty list has to end at a flag, not swallow
    // the model's name as a tool.
    expect(list(argv, "--tools")).toEqual([""]);
  });

  it("spawns in the caller's own working directory when no cwd is given", async () => {
    // No fixture cwd here on purpose: this is the one path the fixture swap
    // (every other test passes an explicit cwd so fake.json is reachable)
    // stopped exercising. Absent fake.json, the double's documented default
    // is a valid, empty-templated response.
    const r = await run("x");
    expect(r.sessionId).toBe("sid-1");
    expect(r.text).toBe("");
  });

  it("treats a non-zero exit as a failure, not as empty output", async () => {
    const dir = withCfg({ exit: 3, stderr: "not logged in" });
    await expect(run("x", {}, { cwd: dir })).rejects.toThrow(/exited 3.*not logged in/);
  });

  it("treats unparseable output as a failure", async () => {
    const dir = withCfg({ raw: "this is not json" });
    await expect(run("x", {}, { cwd: dir })).rejects.toThrow(/did not return json/);
  });

  it("treats the agent's own error flag as a failure", async () => {
    const dir = withCfg({ isError: true, out: "context limit" });
    await expect(run("x", {}, { cwd: dir })).rejects.toThrow(/reported an error.*context limit/);
  });

  it("rejects a session id that is not a string, instead of resolving a type lie", async () => {
    // A number resolves fine against a declared `string | null` and would
    // pass the argv guard whole on the next round's --resume — read validity
    // before completeness, as everywhere else in this codebase.
    const dir = withCfg({ sid: 12345 });
    await expect(run("x", {}, { cwd: dir })).rejects.toThrow(/session_id/);
  });

  it("kills a hung agent at the timeout instead of waiting forever", async () => {
    const dir = withCfg({ hang: true });
    await expect(run("x", { timeoutMs: 100 }, { cwd: dir })).rejects.toThrow(/exceeded 100ms/);
  });

  it("kills the agent when the caller aborts, leaving the promise settled rather than hanging", async () => {
    const dir = withCfg({ hang: true });
    const controller = new AbortController();
    const p = createClaudeExecutor({ bin }).run("x", { round: 1, cwd: dir, signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await expect(p).rejects.toThrow(/agent aborted/);
  });

  it("rejects immediately on an already-aborted signal, instead of running the agent anyway", async () => {
    const dir = withCfg({ out: "should never run" });
    const controller = new AbortController();
    controller.abort();
    await expect(run("x", {}, { cwd: dir, signal: controller.signal } as never)).rejects.toThrow(/agent aborted/);
  });

  // C1 — a prompt larger than the ~64KB pipe buffer is the *normal* case (an
  // issue body plus a diff), not an edge case: the existing timeout/abort
  // tests above use the prompt "x", which is exactly why they never noticed
  // that the pending stdin write raises EPIPE when the kill lands mid-write,
  // and an unhandled 'error' on a stream throws — taking the whole host
  // process down with it, not just this one promise.
  describe("a prompt larger than the stdin pipe buffer", () => {
    const bigPrompt = "x".repeat(5 * 1024 * 1024);

    it("still rejects cleanly (does not crash the process) when killed at the timeout", async () => {
      const dir = withCfg({ hang: true });
      await expect(run(bigPrompt, { timeoutMs: 100 }, { cwd: dir })).rejects.toThrow();
    });

    it("still rejects cleanly (does not crash the process) when the caller aborts", async () => {
      const dir = withCfg({ hang: true });
      const controller = new AbortController();
      const p = createClaudeExecutor({ bin }).run(bigPrompt, { round: 1, cwd: dir, signal: controller.signal });
      setTimeout(() => controller.abort(), 30);
      await expect(p).rejects.toThrow();
    });
  });

  // C2 — a child that floods stdout must be capped and killed, not accumulate
  // without bound until the string itself becomes unrepresentable and the
  // process crashes from inside the stream's own 'data' handler.
  it("caps stdout instead of buffering an unbounded flood, and rejects instead of hanging or crashing", async () => {
    const dir = withCfg({ flood: 1_000_000, floodMax: 64 }); // up to 64MB, well past any sane cap
    await expect(run("x", {}, { cwd: dir })).rejects.toThrow(/agent produced more than/);
  }, 8000);

  /*
   * I3 — a kill must not orphan the grandchildren (bash, MCP servers) a real
   * `claude` spawns: signalling only the direct child leaves them ticking.
   *
   * Synchronised on the grandchild's own pid file, not on a stopwatch. This
   * used to give the run a 300ms timeout and then sleep a flat 300ms before
   * reading that file: on a loaded machine the fake agent's node startup does
   * not fit inside 300ms, so the kill landed before the grandchild existed
   * and the read failed with ENOENT — 6 times out of 6 with other work on the
   * box, 0 out of 6 idle. It then read as "grandchildren outlive the kill",
   * which is a security claim, and a security claim is the worst thing to
   * have flake: a test that fails on a busy machine gets deleted, and then
   * nothing is watching at all.
   *
   * The trigger is the abort rather than the timeout because it is the one a
   * test can pull at the right moment. Both reach the same `killGroup`, and
   * the timeout's own budget and message are pinned by the test above.
   */
  it("kills the whole process group, not just the direct child, so grandchildren do not outlive it", async () => {
    const dir = withCfg({ grandchild: true });
    const controller = new AbortController();
    const started = createClaudeExecutor({ bin }).run("x", { round: 1, cwd: dir, signal: controller.signal });

    const pid = await until(() => {
      try {
        return Number(readFileSync(join(dir, "grandchild.pid"), "utf8"));
      } catch {
        return null;
      }
    }, "the fake agent to spawn its grandchild");
    expect(isAlive(pid)).toBe(true);

    controller.abort();
    await expect(started).rejects.toThrow(/agent aborted/);

    // A shorter budget: SIGKILL to a process group is immediate, so this is
    // the leg where waiting longer only delays a real regression's report.
    await until(() => (isAlive(pid) ? null : true), "the grandchild to die with its group", 400);
    expect(isAlive(pid)).toBe(false);
  }, 20_000);

  it("reports a missing binary as a startup failure", async () => {
    await expect(
      createClaudeExecutor({ bin: "/nonexistent/agent" }).run("x", {
        round: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/could not start/);
  });

  it("reports a binary that exists but cannot be executed as a startup failure too", async () => {
    // On macOS, spawn() throws *synchronously* for some non-executable
    // files instead of emitting the usual async 'error' event, bypassing the
    // handler that wraps ENOENT — an operator would otherwise see a bare,
    // unnamed "spawn Unknown system error -8".
    const dir = mkdtempSync(join(tmpdir(), "fake-agent-"));
    dirs.push(dir);
    const notExecutable = join(dir, "not-executable");
    writeFileSync(notExecutable, "not a script", { mode: 0o644 });
    await expect(
      createClaudeExecutor({ bin: notExecutable }).run("x", { round: 1, signal: new AbortController().signal }),
    ).rejects.toThrow(/could not start/);
  });

  // --- argv-injection hardening: a value that begins with "-" lands in a
  // flag slot even inside a validated argv array, so each value that reaches
  // argv is checked against the shape it is actually allowed to have.

  /*
   * A step's own front matter wins over the operator's default, the same way
   * its capabilities do. Without it, `triage.md`'s `model: haiku` was billed
   * at the operator's `agent.model` on every single human reply.
   */
  it("lets the run's own model override the executor's default", async () => {
    const dir = withCfg({ out: "{{ARGV}}" });
    const r = await run("x", { model: "opus" }, { cwd: dir, model: "haiku" });
    expect(r.text).toContain("--model haiku");
    expect(r.text).not.toContain("opus");
  });

  /*
   * The other half of the only thing that can be done about `model:`.
   *
   * The engine records what a step asked for; nothing it can ask afterwards
   * tells it what actually ran. This layer is where the command line is
   * built, so it is the one place the model really used is known at all —
   * saying so in the event stream is what lets an operator read the two
   * reports against each other. An executor that reports neither is visible
   * by the silence, which is as close to enforcement as a model gets.
   */
  it("reports the model it actually put on its command line", async () => {
    const dir = withCfg({ out: "{{ARGV}}" });
    const events: Array<Record<string, unknown>> = [];
    await createClaudeExecutor({
      bin,
      model: "opus",
      log: (name, data = {}) => { if (name === "step.completed") events.push(data); },
    }).run("x", { round: 1, signal: new AbortController().signal, cwd: dir, model: "haiku" });

    expect(events[0]).toMatchObject({ model: "haiku" });
  });

  it("reports the operator's own default when the run named no model", async () => {
    const dir = withCfg({ out: "{{ARGV}}" });
    const events: Array<Record<string, unknown>> = [];
    await createClaudeExecutor({
      bin,
      model: "opus",
      log: (name, data = {}) => { if (name === "step.completed") events.push(data); },
    }).run("x", { round: 1, signal: new AbortController().signal, cwd: dir });

    expect(events[0]).toMatchObject({ model: "opus" });
  });

  it("refuses a per-run model shaped like a flag, exactly as it refuses a configured one", async () => {
    const dir = withCfg({ out: "{{ARGV}}" });
    await expect(run("x", {}, { cwd: dir, model: "--dangerous-flag" })).rejects.toThrow(/refused model/);
  });

  it("refuses a model name shaped like a flag instead of passing it through to argv", async () => {
    const dir = withCfg({ out: "unreachable" });
    await expect(run("x", { model: "--dangerous-flag" }, { cwd: dir })).rejects.toThrow(/refused model/);
  });

  it("refuses a resume id shaped like a flag", async () => {
    const dir = withCfg({ out: "unreachable" });
    await expect(run("x", {}, { cwd: dir, resume: "-x" })).rejects.toThrow(/refused resume/);
  });

  it("refuses a resume id carrying shell metacharacters, even though no shell is ever invoked", async () => {
    const dir = withCfg({ out: "unreachable" });
    await expect(run("x", {}, { cwd: dir, resume: "sid-1; rm -rf /" })).rejects.toThrow(/refused resume/);
  });

  it("refuses a permissionMode outside the known set", async () => {
    const dir = withCfg({ out: "unreachable" });
    await expect(run("x", { permissionMode: "sudo" }, { cwd: dir })).rejects.toThrow(/refused permissionMode/);
  });

  it("accepts the real CLI's other permission modes, not just the ones this project happens to use", async () => {
    const dir = withCfg({ out: "{{ARGV}}" });
    const r = await run("x", { permissionMode: "auto" }, { cwd: dir });
    expect(r.text).toContain("--permission-mode auto");
  });

  it("warns at startup when configured for bypassPermissions, since that disables every prompt", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      createClaudeExecutor({ permissionMode: "bypassPermissions" });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("bypassPermissions"));
      warn.mockClear();
      createClaudeExecutor({ permissionMode: "plan" });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses a relative cwd", async () => {
    await expect(run("x", {}, { cwd: "relative/path" })).rejects.toThrow(/must be an absolute path/);
  });

  it("refuses a cwd that climbs out of where it lexically appears to be", async () => {
    // `containedPath` (src/workflow/load.ts) already rejects a ".." segment
    // for exactly this reason; reusing it here means an absolute path is not
    // treated as automatically safe just because it passed isAbsolute().
    await expect(run("x", {}, { cwd: "/tmp/lr56/../../etc" })).rejects.toThrow(/refused cwd/);
  });

  // --- a step's declared capabilities, translated into what the CLI enforces.
  //
  // The executor's construction-time options are the *operator's* setting for
  // every run it makes; a step's declaration is narrower and specific to one
  // invocation. These check that the declaration decides, in both directions,
  // rather than being merged with or quietly overridden by the default.

  /*
   * Not plan mode, which is what this was until a live check against the real
   * CLI (2.1.282): plan mode refuses every MCP call — the codebase graph a spec
   * step is told to ask first included — and quietly ran sonnet for a step that
   * said `model: haiku`. Manual mode honours both; `--restricted` and the deny
   * list are what keep "read-only" meaning it, and the same check refused a
   * write attempted under them.
   */
  it("gives a read-only step manual mode with the write and exec tools denied, even when the executor was built wider", async () => {
    const argv = await argvOf(
      createClaudeExecutor({ bin, permissionMode: "acceptEdits", restricted: false }),
      { capabilities: ["repo:read"] },
    );
    expect(argv.slice(0, 7)).toEqual(["-p", "--output-format", "json", "--permission-mode", "manual", "--restricted", "--disallowedTools"]);
    expect(argv.slice(7, 12).sort()).toEqual([...WRITE_TOOLS]);
    expect(argv).not.toContain("plan");
  });

  it("still hands a read-only step the model it asked for, which plan mode ignored", async () => {
    const argv = await argvOf(createClaudeExecutor({ bin, model: "opus" }), { capabilities: ["repo:read"], model: "haiku" });
    expect(argv[argv.indexOf("--model") + 1]).toBe("haiku");
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("manual");
  });

  it("lets a step that declared repo:write actually edit, where the executor default would not", async () => {
    const dir = withCfg({ out: "{{ARGV}}" });
    const argv = (await run("x", {}, { cwd: dir, capabilities: ["repo:read", "repo:write"] })).text;
    expect(argv).toContain("--permission-mode acceptEdits");
    expect(argv).not.toContain("--restricted");
  });

  it("treats a step that declares no capabilities as the most restricted one, not the least", async () => {
    const argv = await argvOf(
      createClaudeExecutor({ bin, permissionMode: "acceptEdits", restricted: false }),
      { capabilities: [] },
    );
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("manual");
    expect(argv).toContain("--restricted");
    expect(argv.slice(argv.indexOf("--disallowedTools") + 1, argv.indexOf("--disallowedTools") + 6).sort()).toEqual([...WRITE_TOOLS]);
  });

  /**
   * Fail closed on a word this executor cannot turn into a flag. Translating
   * "net:egress" into nothing at all is how a step comes to declare a
   * capability while the agent simply has it.
   */
  it("refuses a capability it cannot enforce instead of silently dropping it", async () => {
    const dir = withCfg({ out: "should never run" });
    await expect(run("x", {}, { cwd: dir, capabilities: ["repo:read", "net:egress"] }))
      .rejects.toThrow(/refused capabilit[\s\S]*net:egress/i);
  });

  it("never lets the parent process's environment reach the agent", async () => {
    process.env.LANDRACE_TEST_SECRET = "super-secret-value-should-not-leak";
    const dir = withCfg({ out: "secret=[{{ENV:LANDRACE_TEST_SECRET}}]" });
    const r = await run("x", {}, { cwd: dir });
    expect(r.text).toBe("secret=[]");
  });

  it("forwards USER, LOGNAME and SHELL, since the CLI's own keychain lookup and Bash tool need them", async () => {
    const saved = { USER: process.env.USER, LOGNAME: process.env.LOGNAME, SHELL: process.env.SHELL };
    process.env.USER = "test-user-xyz";
    process.env.LOGNAME = "test-user-xyz";
    process.env.SHELL = "/bin/test-shell";
    try {
      const dir = withCfg({ out: "[{{ENV:USER}}|{{ENV:LOGNAME}}|{{ENV:SHELL}}]" });
      const r = await run("x", {}, { cwd: dir });
      expect(r.text).toBe("[test-user-xyz|test-user-xyz|/bin/test-shell]");
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

/*
 * What a declared run is handed beyond its own tools: the operator's plugins
 * and the MCP servers `agent.mcp` allows, resolved once at startup from the
 * repository root's `.mcp.json` and handed over as definitions — never as a
 * path the agent's worktree could shadow.
 */
describe("plugins and MCP servers", () => {
  const tools = { plugins: [PLUGIN, "other@market"], mcpServers: { "codebase-memory-mcp": MEMORY } };

  it("enables the operator's plugins through one --settings element holding the JSON", async () => {
    const argv = await argvOf(createClaudeExecutor({ bin, ...tools }), { capabilities: ["repo:read"] });
    expect(JSON.parse(flag(argv, "--settings") as string)).toEqual({
      enabledPlugins: { [PLUGIN]: true, "other@market": true },
    });
    expect(argv.filter((a) => a === "--settings")).toHaveLength(1);
  });

  it("passes no --settings when no plugin is configured", async () => {
    const argv = await argvOf(createClaudeExecutor({ bin }), { capabilities: ["repo:read"] });
    expect(argv).not.toContain("--settings");
  });

  it("hands the step only the allowlisted servers, as defined, strictly, and allows them by name", async () => {
    const argv = await argvOf(createClaudeExecutor({ bin, ...tools }), { capabilities: ["repo:read"] });
    expect(JSON.parse(flag(argv, "--mcp-config") as string)).toEqual({ mcpServers: { "codebase-memory-mcp": MEMORY } });
    expect(argv).toContain("--strict-mcp-config");
    expect(list(argv, "--allowedTools")).toEqual(["mcp__codebase-memory-mcp"]);
  });

  it("allows only the listed tools of a server that lists them, and every tool of one named bare", async () => {
    const argv = await argvOf(
      createClaudeExecutor({
        bin,
        mcpServers: { "codebase-memory-mcp": MEMORY, other: { command: "other" } },
        mcpTools: { "codebase-memory-mcp": ["search_graph", "trace_path"] },
      }),
      { capabilities: ["repo:read"] },
    );
    expect(list(argv, "--allowedTools").sort()).toEqual([
      "mcp__codebase-memory-mcp__search_graph", "mcp__codebase-memory-mcp__trace_path", "mcp__other",
    ]);
    // Every server still loads — the list narrows what may be called, and the
    // config has to define a server for any of its tools to exist at all.
    expect(Object.keys(JSON.parse(flag(argv, "--mcp-config") as string).mcpServers).sort()).toEqual(["codebase-memory-mcp", "other"]);
  });

  /*
   * Strict even with nothing to allow: without it, a `.mcp.json` committed to
   * the repository — which is what the step's worktree is checked out from —
   * or the operator's own user-level servers would load beside the step. The
   * operator's server is one of those, and it can move the step's own ticket.
   */
  it("gives a step with an empty allowlist an empty, strict config and allows nothing", async () => {
    const argv = await argvOf(createClaudeExecutor({ bin }), { capabilities: ["repo:read"] });
    expect(JSON.parse(flag(argv, "--mcp-config") as string)).toEqual({ mcpServers: {} });
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).not.toContain("--allowedTools");
  });

  it("gives a writing step the same plugins and servers, and otherwise leaves it as it was", async () => {
    const argv = await argvOf(createClaudeExecutor({ bin, ...tools }), { capabilities: ["repo:read", "repo:write"] });
    expect(flag(argv, "--permission-mode")).toBe("acceptEdits");
    expect(argv).not.toContain("--restricted");
    expect(argv).not.toContain("--disallowedTools");
    expect(flag(argv, "--settings")).toBeDefined();
    expect(Object.keys(JSON.parse(flag(argv, "--mcp-config") as string).mcpServers)).toEqual(["codebase-memory-mcp"]);
    expect(argv).toContain("--strict-mcp-config");
    expect(list(argv, "--allowedTools")).toEqual(["mcp__codebase-memory-mcp"]);
  });

  it("hands a conversation turn the same servers, and never the create_child server it holds no binding for", async () => {
    const argv = await argvOf(createClaudeExecutor({ bin, ...tools, childServer: CHILD_SERVER }), {
      capabilities: ["tickets:create", "repo:read"],
    });
    expect(Object.keys(JSON.parse(flag(argv, "--mcp-config") as string).mcpServers)).toEqual(["codebase-memory-mcp"]);
    expect(list(argv, "--allowedTools")).toEqual(["mcp__codebase-memory-mcp"]);
  });

  it("gives a read-only step holding create_child both the allowlisted servers and its bound child server", async () => {
    const argv = await argvOf(createClaudeExecutor({ bin, ...tools, childServer: CHILD_SERVER }), {
      capabilities: ["tickets:create", "repo:read"], child: BINDING,
    });
    const servers = JSON.parse(flag(argv, "--mcp-config") as string).mcpServers;
    expect(Object.keys(servers).sort()).toEqual(["codebase-memory-mcp", "landrace"]);
    expect(servers["codebase-memory-mcp"]).toEqual(MEMORY);
    expect(servers.landrace.args).toEqual([...CHILD_SERVER.args, "--child", "12", "--stage", "breakdown", "--round", "2"]);
    expect(list(argv, "--allowedTools").sort()).toEqual(["mcp__codebase-memory-mcp", "mcp__landrace__landrace_create_child"]);
    expect(flag(argv, "--permission-mode")).toBe("manual");
  });

  /*
   * `--allowedTools`, `--disallowedTools` and `--mcp-config` are all variadic:
   * the CLI keeps reading values until the next flag. So each list has to be
   * followed by a flag or by nothing at all, or whatever sits after it —
   * another setting's value — would be allowed, denied or loaded as config.
   */
  it("ends every variadic list at the next flag or at the end of argv, with everything configured", async () => {
    const argv = await argvOf(createClaudeExecutor({ bin, ...tools, childServer: CHILD_SERVER }), {
      capabilities: ["tickets:create", "repo:read"], child: BINDING, model: "haiku",
    });
    // Read the way the CLI reads them, up to the next flag: exactly what each
    // was meant to hold, and not one element more.
    expect(list(argv, "--disallowedTools").sort()).toEqual([...WRITE_TOOLS]);
    expect(list(argv, "--mcp-config")).toHaveLength(1);
    expect(list(argv, "--allowedTools").sort()).toEqual(["mcp__codebase-memory-mcp", "mcp__landrace__landrace_create_child"]);
  });
});

describe("the create_child tool", () => {
  const server = CHILD_SERVER;
  const binding = BINDING;

  it("starts the agent with the bound child server when the step may create tickets", async () => {
    const argv = await argvOf(createClaudeExecutor({ bin, childServer: server }), {
      capabilities: ["tickets:create", "repo:read"], child: binding,
    });
    const config = JSON.parse(argv[argv.indexOf("--mcp-config") + 1] as string);
    expect(config.mcpServers.landrace).toEqual({
      command: "/usr/bin/node",
      args: [...server.args, "--child", "12", "--stage", "breakdown", "--round", "2"],
    });
    expect(Object.keys(config.mcpServers)).toEqual(["landrace"]);
    expect(argv[argv.indexOf("--allowedTools") + 1]).toBe("mcp__landrace__landrace_create_child");
    // Exactly the one tool: the flag is variadic, so whatever follows it up
    // to the next flag would be allowed too.
    expect(argv[argv.indexOf("--allowedTools") + 2] ?? "--").toMatch(/^-/);
    // A `.mcp.json` in the worktree the agent works in could otherwise add a
    // server of its own — or one named "landrace", whose create_child the
    // allowlist above would then approve.
    expect(argv).toContain("--strict-mcp-config");
  });

  it("runs a read-only step holding the tool in default mode, still restricted, with write and exec tools denied", async () => {
    // Plan mode is where the real CLI refuses every MCP call, so a breakdown
    // step in it could never file a child. Default mode — the CLI names it
    // `manual` — lets the one
    // allowlisted tool through; `--restricted` and an explicit deny list keep
    // it from editing or running anything while it does.
    const argv = await argvOf(createClaudeExecutor({ bin, childServer: server }), {
      capabilities: ["tickets:create", "repo:read"], child: binding,
    });
    expect(argv.slice(0, 7)).toEqual(["-p", "--output-format", "json", "--permission-mode", "manual", "--restricted", "--disallowedTools"]);
    const denied = argv.slice(7, argv.indexOf("--mcp-config"));
    expect([...denied].sort()).toEqual(["Bash", "Edit", "MultiEdit", "NotebookEdit", "Write"]);
    expect(argv).not.toContain("plan");
  });

  it("leaves a writing step holding the tool in acceptEdits, with nothing denied", async () => {
    const argv = await argvOf(createClaudeExecutor({ bin, childServer: server }), {
      capabilities: ["tickets:create", "repo:write"], child: binding,
    });
    expect(argv.slice(0, 5)).toEqual(["-p", "--output-format", "json", "--permission-mode", "acceptEdits"]);
    expect(argv).not.toContain("--restricted");
    expect(argv).not.toContain("--disallowedTools");
  });

  it("keeps a read-only step without the binding on exactly the flags any read-only step gets", async () => {
    const readOnly = [
      "-p", "--output-format", "json", "--permission-mode", "manual", "--restricted",
      "--disallowedTools", ...WRITE_TOOLS, "--mcp-config", JSON.stringify({ mcpServers: {} }), "--strict-mcp-config",
    ];
    const declaring = await argvOf(createClaudeExecutor({ bin, childServer: server }), { capabilities: ["tickets:create", "repo:read"] });
    expect(declaring).toEqual(readOnly);
    const unbound = await argvOf(createClaudeExecutor({ bin, childServer: server }), { capabilities: ["repo:read"], child: binding });
    expect(unbound).toEqual(readOnly);
  });

  it("offers nothing to a step that did not declare it, even with a binding", async () => {
    const argv = await argvOf(createClaudeExecutor({ bin, childServer: server }), { capabilities: ["repo:read"], child: binding });
    expect(JSON.parse(flag(argv, "--mcp-config") as string)).toEqual({ mcpServers: {} });
    expect(argv).not.toContain("--allowedTools");
  });

  it("offers nothing to a conversation turn, which is handed no binding", async () => {
    const argv = await argvOf(createClaudeExecutor({ bin, childServer: server }), { capabilities: ["tickets:create"] });
    expect(JSON.parse(flag(argv, "--mcp-config") as string)).toEqual({ mcpServers: {} });
    expect(argv).not.toContain("--allowedTools");
  });

  it("refuses rather than drops the capability when it was not told how to start the server", async () => {
    await expect(argvOf(createClaudeExecutor({ bin }), { capabilities: ["tickets:create"], child: binding }))
      .rejects.toThrow(/cannot give this step create_child/);
  });

  it("refuses a binding that could smuggle an argument", async () => {
    await expect(argvOf(createClaudeExecutor({ bin, childServer: server }), {
      capabilities: ["tickets:create"], child: { ...binding, stage: "-x" },
    })).rejects.toThrow(/refused stage/);
    await expect(argvOf(createClaudeExecutor({ bin, childServer: server }), {
      capabilities: ["tickets:create"], child: { ...binding, parent: "--workflow" },
    })).rejects.toThrow(/refused parent/);
    await expect(argvOf(createClaudeExecutor({ bin, childServer: server }), {
      capabilities: ["tickets:create"], child: { ...binding, round: 0 },
    })).rejects.toThrow(/refused round/);
  });
});
