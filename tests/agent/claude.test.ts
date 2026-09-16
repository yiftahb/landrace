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

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  it("restricts the agent by default, non-interactively: --restricted strips tools, plan mode makes no edits", async () => {
    const dir = withCfg({ out: "{{ARGV}}" });
    const argv = (await run("x", {}, { cwd: dir })).text;
    expect(argv).toContain("--restricted");
    expect(argv).toContain("--permission-mode plan");
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

  // I3 — a timeout must not orphan the grandchildren (bash, MCP servers) a
  // real `claude` spawns: killing only the direct child leaves them ticking.
  it("kills the whole process group, not just the direct child, so grandchildren do not outlive the timeout", async () => {
    const dir = withCfg({ grandchild: true });
    await expect(run("x", { timeoutMs: 300 }, { cwd: dir })).rejects.toThrow(/exceeded 300ms/);
    await wait(300);
    const pid = Number(readFileSync(join(dir, "grandchild.pid"), "utf8"));
    expect(isAlive(pid)).toBe(false);
  }, 8000);

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

  it("gives a read-only step plan mode and no tools, even when the executor was built wider", async () => {
    const dir = withCfg({ out: "{{ARGV}}" });
    const argv = (await run(
      "x",
      { permissionMode: "acceptEdits", restricted: false },
      { cwd: dir, capabilities: ["repo:read"] },
    )).text;
    expect(argv).toContain("--permission-mode plan");
    expect(argv).toContain("--restricted");
  });

  it("lets a step that declared repo:write actually edit, where the executor default would not", async () => {
    const dir = withCfg({ out: "{{ARGV}}" });
    const argv = (await run("x", {}, { cwd: dir, capabilities: ["repo:read", "repo:write"] })).text;
    expect(argv).toContain("--permission-mode acceptEdits");
    expect(argv).not.toContain("--restricted");
  });

  it("treats a step that declares no capabilities as the most restricted one, not the least", async () => {
    const dir = withCfg({ out: "{{ARGV}}" });
    const argv = (await run(
      "x",
      { permissionMode: "acceptEdits", restricted: false },
      { cwd: dir, capabilities: [] },
    )).text;
    expect(argv).toContain("--permission-mode plan");
    expect(argv).toContain("--restricted");
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
