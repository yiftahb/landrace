import {
  chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { claude } from "#landrace/hooks/claude.js";
import { createClaudeExecutor } from "landrace/integrations/claude";
import type { Executor, ExecutorContext } from "#namespace.js";
import { gitRepo, removeRepos } from "#tests/support/repo.js";

afterAll(removeRepos);

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
const bin = join(__dirname, "..", "agent", "fake-agent.mjs");

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
  // `Pick<Executor, "run">`, not `ReturnType<typeof createClaudeExecutor>`:
  // the factory's own `create(ctx)` (tested below) returns the same shape
  // without an `id`, and this only ever calls `.run`.
  executor: Pick<Executor, "run">,
  opts: {
    capabilities?: readonly string[];
    model?: string;
    effort?: string;
    child?: { parent: string; stage: string; round: number; server?: typeof SERVER };
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
/** What a step's `--settings` carries so `--add-dir` loads its `CLAUDE.md`. */
const INSTRUCTIONS = { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" };
/** The copy of a step's instructions that `--add-dir` names, written `<instructions>` so a whole argv can be compared. */
const atInstructions = (argv: string[]): string[] =>
  argv.map((a, i) => (argv[i - 1] === "--add-dir" ? "<instructions>" : a));
const PLUGIN = "superpowers@claude-plugins-official";
const MEMORY = { command: "codebase-memory-mcp", args: [], env: { MEMORY_HOME: "/var/memory" } };
const BINDING = { parent: "12", stage: "breakdown", round: 2 };
/**
 * The engine's own item server for BINDING, described in full: this is
 * what an executor is handed on `child.server` now — the binding is already
 * on its command line, so an executor builds `mcp__<name>__<tool>` without
 * knowing landrace's CLI or its tool's name.
 */
const SERVER = {
  name: "landrace",
  command: "/usr/bin/node",
  args: ["cli.js", "mcp", "--workspace", "/w", "--child", "12", "--stage", "breakdown", "--round", "2"],
  tools: ["landrace_create_child"],
};

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

  // stream-json still ends on the result event that carries the session id,
  // and prints each tool call and message as a line of its own before it —
  // which is what the item panel shows. The CLI refuses stream-json under
  // -p without --verbose.
  it("asks for stream-json with --verbose: the session id at the end, the agent's work as it happens", async () => {
    const dir = withCfg({ out: "{{ARGV}}" });
    expect((await run("x", {}, { cwd: dir })).text).toContain("--output-format stream-json --verbose");
  });

  describe("what the agent is doing, as it happens", () => {
    const assistant = (...content: object[]) => ({ type: "assistant", message: { role: "assistant", content } });

    it("reports each tool call and each thing it says, then answers with the result", async () => {
      const dir = withCfg({
        out: "done",
        events: [
          { type: "system", subtype: "init", session_id: "sid-1" },
          assistant({ type: "text", text: "Looking at the parser." }),
          { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "file text" }] } },
          assistant({ type: "tool_use", name: "Read", input: { file_path: join("{{CWD}}", "src", "a.ts") } }),
          assistant({ type: "tool_use", name: "Bash", input: { command: "pnpm test" } }, { type: "tool_use", name: "mcp__memory__search", input: {} }),
        ],
      });
      const seen: Array<{ kind: string; text: string; at: number }> = [];
      const r = await run("x", {}, { cwd: dir, onActivity: (e: { kind: string; text: string; at: number }) => seen.push(e) });
      expect(r).toEqual({ text: "done", sessionId: "sid-1" });
      expect(seen.map(({ kind, text }) => ({ kind, text }))).toEqual([
        { kind: "message", text: "Looking at the parser." },
        { kind: "tool", text: `Read ${join("src", "a.ts")}` },
        { kind: "tool", text: "Bash pnpm test" },
        { kind: "tool", text: "mcp__memory__search" },
      ]);
      expect(seen.every((e) => typeof e.at === "number")).toBe(true);
    });

    it("answers as before with nobody listening, and skips a line that is not an event", async () => {
      const dir = withCfg({ out: "done", events: ["not an event", assistant({ type: "text", text: "hi" })] });
      expect(await run("x", {}, { cwd: dir })).toEqual({ text: "done", sessionId: "sid-1" });
    });

    // stream-json carries every tool's result — the files the agent read,
    // the output of what it ran — and agent.event reaches telemetry even
    // without --debug. Logged parsed, a secret inside an event is a string
    // the redactor sees whole, not one split across two chunks or escaped
    // inside a JSON line; and a tool's result is not logged at all.
    it("logs each event parsed, and never a tool's result", async () => {
      const dir = withCfg({
        out: "done",
        events: [
          assistant({ type: "tool_use", name: "Read", input: { file_path: ".env" } }),
          { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "TOKEN=ghp_from_the_file" }] } },
          "a warning the CLI printed",
        ],
      });
      const logged: Array<[string, Record<string, unknown>]> = [];
      await run("x", { log: (event: string, data?: Record<string, unknown>) => logged.push([event, data ?? {}]) }, { cwd: dir });
      const events = logged.filter(([name]) => name === "agent.event").map(([, data]) => data);
      expect(JSON.stringify(events)).not.toContain("ghp_from_the_file");
      expect(events.map((d) => (d.event as { type?: string } | undefined)?.type ?? d.raw)).toEqual(["assistant", "a warning the CLI printed", "result"]);
    });

    it("treats a stream that never reaches its result as a failure", async () => {
      const dir = withCfg({ events: [assistant({ type: "text", text: "hi" })], raw: "" });
      await expect(run("x", {}, { cwd: dir })).rejects.toThrow(/did not return json/);
    });
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

  // A pairing's closing turn: the person's session is asked for the answer
  // without a turn being added to it.
  it("forks the session it resumes when asked to, and refuses a fork with nothing to resume", async () => {
    const dir = withCfg({ out: "{{ARGV}}" });
    const r = await createClaudeExecutor({ bin }).run("x", {
      round: 2, resume: "sid-9", fork: true, cwd: dir, signal: new AbortController().signal,
    });
    expect(r.text).toContain("--resume sid-9 --fork-session");
    await expect(createClaudeExecutor({ bin }).run("x", { round: 1, fork: true, cwd: dir, signal: new AbortController().signal }))
      .rejects.toThrow(/fork/);
  });

  // A pairing's hand-in forks in the pairing's own checkout, and its record
  // names that fork; a later Ask resumes it from the item's worktree.
  it("brings the session it resumes over from the directory it ran in", async () => {
    const home = mkdtempSync(join(tmpdir(), "fake-home-"));
    dirs.push(home);
    const dir = realpathSync(withCfg({ out: "{{ARGV}}" }));
    const ranIn = join(home, ".claude", "projects", "-elsewhere-29-pair");
    await mkdir(ranIn, { recursive: true });
    await writeFile(join(ranIn, "sid-fork.jsonl"), "{\"x\":1}\n");
    const r = await createClaudeExecutor({ bin, home }).run("x", {
      round: 2, resume: "sid-fork", cwd: dir, signal: new AbortController().signal,
    });
    expect(r.text).toContain("--resume sid-fork");
    const here = join(home, ".claude", "projects", dir.replace(/[^A-Za-z0-9]/g, "-"));
    expect(readFileSync(join(here, "sid-fork.jsonl"), "utf8")).toBe("{\"x\":1}\n");
  });

  describe("handing a session to a person", () => {
    const SESSION = "0b7f4c1e-9a2d-5e3f-8c4b-1d2e3f4a5b6c";
    /** Where the CLI keeps a directory's sessions, under a home of the test's own. */
    const projectOf = (home: string, cwd: string) => join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
    const setup = (prompt = "You are pairing.") => {
      const home = mkdtempSync(join(tmpdir(), "fake-home-"));
      const cwd = mkdtempSync(join(tmpdir(), "pair-"));
      dirs.push(home, cwd);
      const promptFile = join(home, "seed.md");
      writeFileSync(promptFile, prompt);
      return { home, cwd: realpathSync(cwd), promptFile, executor: createClaudeExecutor({ bin: "claude", home }) };
    };

    // The seed is item text, and the command is pasted into a terminal:
    // the argument names the file, and the person's shell reads it.
    it("starts the session under the id it was given, seeded from the prompt's file, with the engine's server loaded", async () => {
      const { cwd, promptFile, executor } = setup();
      const hand = await executor.handoff?.({
        cwd, session: SESSION, promptFile,
        server: { name: "landrace", command: "node", args: ["cli.js", "mcp"], tools: [] },
      });
      expect(hand).toEqual({
        cwd,
        argv: ["claude", { file: promptFile }, "--session-id", SESSION,
          "--mcp-config", JSON.stringify({ mcpServers: { landrace: { command: "node", args: ["cli.js", "mcp"] } } })],
      });
    });

    it("resumes the session instead once it exists — the command run a second time", async () => {
      const { home, cwd, promptFile, executor } = setup();
      await mkdir(projectOf(home, cwd), { recursive: true });
      await writeFile(join(projectOf(home, cwd), `${SESSION}.jsonl`), "{}\n");
      const hand = await executor.handoff?.({ cwd, session: SESSION, promptFile, resume: "sid-agent" });
      expect(hand?.argv).toEqual(["claude", "--resume", SESSION]);
    });

    it("continues the agent's session as a fork, bringing it over from the directory the step ran in", async () => {
      const { home, cwd, promptFile, executor } = setup();
      const stepRanIn = join(home, ".claude", "projects", "-elsewhere-29");
      await mkdir(stepRanIn, { recursive: true });
      await writeFile(join(stepRanIn, "sid-agent.jsonl"), "{\"x\":1}\n");
      const hand = await executor.handoff?.({ cwd, session: SESSION, promptFile, resume: "sid-agent" });
      expect(hand?.argv).toEqual(["claude", { file: promptFile }, "--resume", "sid-agent", "--fork-session", "--session-id", SESSION]);
      expect(readFileSync(join(projectOf(home, cwd), "sid-agent.jsonl"), "utf8")).toBe("{\"x\":1}\n");
    });

    it("starts fresh, seeded, when the agent's session is nowhere to be found", async () => {
      const { cwd, promptFile, executor } = setup();
      const hand = await executor.handoff?.({ cwd, session: SESSION, promptFile, resume: "sid-gone" });
      expect(hand?.argv).toEqual(["claude", { file: promptFile }, "--session-id", SESSION]);
    });

    it("refuses a session id or a prompt a command line would read as a flag", async () => {
      const { cwd, promptFile, executor } = setup();
      await expect(executor.handoff?.({ cwd, session: "-x", promptFile })).rejects.toThrow(/refused session/);
      const flag = setup("--dangerously-skip-permissions");
      await expect(flag.executor.handoff?.({ cwd, session: SESSION, promptFile: flag.promptFile })).rejects.toThrow(/prompt/);
    });
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
      "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "manual", "--restricted", "--tools", "",
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

  // A step's own timeout, on the run: a build that needs two hours and a
  // classifier that needs two minutes are run by the same executor.
  it("kills a hung agent at the run's own timeout, which wins over the one it was built with", async () => {
    const dir = withCfg({ hang: true });
    await expect(run("x", { timeoutMs: 60_000 }, { cwd: dir, timeoutMs: 100 })).rejects.toThrow(/exceeded 100ms/);
  }, 5_000);

  it("kills the agent when the caller aborts, leaving the promise settled rather than hanging", async () => {
    const dir = withCfg({ hang: true });
    const controller = new AbortController();
    const p = createClaudeExecutor({ bin }).run("x", { round: 1, cwd: dir, signal: controller.signal, timeoutMs: 5_000 });
    setTimeout(() => controller.abort(), 30);
    await expect(p).rejects.toThrow(/agent aborted/);
  });

  it("rejects immediately on an already-aborted signal, instead of running the agent anyway", async () => {
    const dir = withCfg({ out: "should never run" });
    const controller = new AbortController();
    controller.abort();
    await expect(run("x", {}, { cwd: dir, signal: controller.signal } as never)).rejects.toThrow(/agent aborted/);
  });

  // #33: a tick stops a closed item's run whenever it lists it, and that
  // can land while the run still awaits its checkout, before any listener
  // exists to hear it. Missed, the agent ran on to its timeout.
  it("still stops an agent whose abort landed while the run was getting ready", async () => {
    const dir = withCfg({ hang: true });
    const controller = new AbortController();
    const p = createClaudeExecutor({ bin }).run("x", { round: 1, cwd: dir, signal: controller.signal, timeoutMs: 2_000 });
    controller.abort();
    await expect(p).rejects.toThrow(/agent aborted/);
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
      // Well above jest's own default test timeout (5s): a broken abort must
      // fail this test by timing out, not by coincidentally hitting this
      // fallback at the same 5s mark the assertion below has no message check
      // to catch it with.
      const p = createClaudeExecutor({ bin }).run(bigPrompt, { round: 1, cwd: dir, signal: controller.signal, timeoutMs: 60_000 });
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
    const started = createClaudeExecutor({ bin }).run("x", { round: 1, cwd: dir, signal: controller.signal, timeoutMs: 5_000 });

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

  // Effort mirrors model: the run's own wins over the operator's, absent both the CLI decides.
  it("puts the operator's effort on a step's command line", async () => {
    const argv = await argvOf(createClaudeExecutor({ bin, effort: "high" }), { capabilities: ["repo:read"] });
    expect(flag(argv, "--effort")).toBe("high");
  });

  it("lets the run's own effort override the executor's default", async () => {
    const argv = await argvOf(createClaudeExecutor({ bin, effort: "high" }), { capabilities: ["repo:read"], effort: "low" });
    expect(flag(argv, "--effort")).toBe("low");
    expect(argv).not.toContain("high");
  });

  it("passes a step's effort when the operator named none", async () => {
    const argv = await argvOf(createClaudeExecutor({ bin }), { capabilities: ["repo:read", "repo:write"], effort: "max" });
    expect(flag(argv, "--effort")).toBe("max");
  });

  it("passes no effort when neither the step nor the operator named one", async () => {
    expect(await argvOf(createClaudeExecutor({ bin }), { capabilities: ["repo:read"] })).not.toContain("--effort");
  });

  // The screener is built from the same `agent:` block, and judges a prompt: out of scope for effort.
  it("never gives the screener an effort", async () => {
    expect(await argvOf(createClaudeExecutor({ bin, effort: "high" }), {})).not.toContain("--effort");
  });

  it("refuses an effort it does not know, naming the levels it does", async () => {
    const dir = withCfg({ out: "unreachable" });
    await expect(run("x", {}, { cwd: dir, capabilities: ["repo:read"], effort: "extreme" }))
      .rejects.toThrow(/refused effort "extreme"[\s\S]*low, medium, high, xhigh, max/);
    await expect(run("x", {}, { cwd: dir, capabilities: ["repo:read"], effort: "--dangerous-flag" }))
      .rejects.toThrow(/refused effort/);
  });

  it("reports the effort it actually put on its command line, or null", async () => {
    const events: Array<Record<string, unknown>> = [];
    const executor = createClaudeExecutor({
      bin,
      effort: "high",
      log: (name, data = {}) => { if (name === "step.completed") events.push(data); },
    });
    await argvOf(executor, { capabilities: ["repo:read"], effort: "low" });
    await argvOf(executor, {});
    expect(events).toMatchObject([{ effort: "low" }, { effort: null }]);
  });

  it("refuses a resume id shaped like a flag", async () => {
    const dir = withCfg({ out: "unreachable" });
    await expect(run("x", {}, { cwd: dir, resume: "-x" })).rejects.toThrow(/refused resume/);
  });

  it("refuses a resume id carrying shell metacharacters, even though no shell is ever invoked", async () => {
    const dir = withCfg({ out: "unreachable" });
    await expect(run("x", {}, { cwd: dir, resume: "sid-1; rm -rf /" })).rejects.toThrow(/refused resume/);
  });

  /*
   * The engine's own `containedPath` (src/workflow/load.ts) refuses each of
   * these shapes for `root: "/"` — that root can never be lexically escaped,
   * so its whole contribution here was these shape rules plus "does not
   * exist" underneath them. This hook reimplements the same rules directly
   * (see `assertCwd` in .landrace/hooks/claude.ts) rather than importing the
   * engine's file, so an absolute path is not treated as automatically safe
   * just because it passed `isAbsolute()`.
   */
  it.each<[string, string, RegExp]>([
    ["a relative path", "relative/path", /must be an absolute path/],
    ["a \"..\" segment", "/tmp/lr56/../../etc", /contains a "\.\." segment/],
    ["a backslash", "/tmp/lr56\\x", /contains a backslash/],
    ["percent-encoding", "/tmp/lr56%2e%2e", /is percent-encoded/],
    ["a path that does not exist", "/nonexistent-lr-cwd-does-not-exist", /does not exist/],
    ["the bare root", "/", /is empty/],
    ["a doubled leading slash", "//tmp", /is absolute/],
    ["a scheme- or drive-like first segment", "/foo:bar/x", /is a URL or a drive path, not a relative path/],
  ])("refuses a cwd with %s", async (_, cwd, reason) => {
    await expect(run("x", {}, { cwd })).rejects.toThrow(reason);
  });

  // --- a step's declared capabilities, translated into what the CLI enforces.
  //
  // There is no operator-wide permission setting to merge with or fall back
  // on: the declaration alone decides, and a run that makes none is the
  // screener's, which gets less than any step.

  /*
   * Not plan mode, which is what this was until a live check against the real
   * CLI (2.1.282): plan mode refuses every MCP call — the codebase graph a spec
   * step is told to ask first included — and quietly ran sonnet for a step that
   * said `model: haiku`. Manual mode honours both; `--restricted` and the deny
   * list are what keep "read-only" meaning it, and the same check refused a
   * write attempted under them.
   */
  it("gives a read-only step manual mode with the write and exec tools denied", async () => {
    const argv = await argvOf(createClaudeExecutor({ bin }), { capabilities: ["repo:read"] });
    expect(argv.slice(0, 8)).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "manual", "--restricted", "--disallowedTools"]);
    expect(argv.slice(8, 13).sort()).toEqual([...WRITE_TOOLS]);
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
    const argv = await argvOf(createClaudeExecutor({ bin }), { capabilities: [] });
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

  it("refuses the retired capability tickets:create, naming items:create", async () => {
    const dir = withCfg({ out: "should never run" });
    await expect(run("x", {}, { cwd: dir, capabilities: ["tickets:create"] }))
      .rejects.toThrow(/"tickets:create" is now "items:create"/);
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
      enabledPlugins: { [PLUGIN]: true, "other@market": true }, env: INSTRUCTIONS,
    });
    expect(argv.filter((a) => a === "--settings")).toHaveLength(1);
  });

  it("passes only the setting that loads the step's CLAUDE.md when no plugin is configured", async () => {
    const argv = await argvOf(createClaudeExecutor({ bin }), { capabilities: ["repo:read"] });
    expect(JSON.parse(flag(argv, "--settings") as string)).toEqual({ env: INSTRUCTIONS });
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
   * operator's server is one of those, and it can move the step's own item.
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
    const argv = await argvOf(createClaudeExecutor({ bin, ...tools }), {
      capabilities: ["items:create", "repo:read"],
    });
    expect(Object.keys(JSON.parse(flag(argv, "--mcp-config") as string).mcpServers)).toEqual(["codebase-memory-mcp"]);
    expect(list(argv, "--allowedTools")).toEqual(["mcp__codebase-memory-mcp"]);
  });

  it("gives a read-only step holding create_child both the allowlisted servers and its bound child server", async () => {
    const argv = await argvOf(createClaudeExecutor({ bin, ...tools }), {
      capabilities: ["items:create", "repo:read"], child: { ...BINDING, server: SERVER },
    });
    const servers = JSON.parse(flag(argv, "--mcp-config") as string).mcpServers;
    expect(Object.keys(servers).sort()).toEqual(["codebase-memory-mcp", "landrace"]);
    expect(servers["codebase-memory-mcp"]).toEqual(MEMORY);
    expect(servers.landrace).toEqual({ command: SERVER.command, args: SERVER.args });
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
    const argv = await argvOf(createClaudeExecutor({ bin, ...tools }), {
      capabilities: ["items:create", "repo:read"], child: { ...BINDING, server: SERVER }, model: "haiku",
    });
    // Read the way the CLI reads them, up to the next flag: exactly what each
    // was meant to hold, and not one element more.
    expect(list(argv, "--disallowedTools").sort()).toEqual([...WRITE_TOOLS]);
    expect(list(argv, "--mcp-config")).toHaveLength(1);
    expect(list(argv, "--allowedTools").sort()).toEqual(["mcp__codebase-memory-mcp", "mcp__landrace__landrace_create_child"]);
  });
});

describe("the create_child tool", () => {
  const binding = BINDING;

  it("starts the agent with the bound child server when the step may create items", async () => {
    const argv = await argvOf(createClaudeExecutor({ bin }), {
      capabilities: ["items:create", "repo:read"], child: { ...binding, server: SERVER },
    });
    const config = JSON.parse(argv[argv.indexOf("--mcp-config") + 1] as string);
    expect(config.mcpServers.landrace).toEqual({ command: SERVER.command, args: SERVER.args });
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
    const argv = await argvOf(createClaudeExecutor({ bin }), {
      capabilities: ["items:create", "repo:read"], child: { ...binding, server: SERVER },
    });
    expect(argv.slice(0, 8)).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "manual", "--restricted", "--disallowedTools"]);
    expect(list(argv, "--disallowedTools").sort()).toEqual(["Bash", "Edit", "MultiEdit", "NotebookEdit", "Write"]);
    expect(argv).not.toContain("plan");
  });

  it("leaves a writing step holding the tool in acceptEdits, with nothing denied", async () => {
    const argv = await argvOf(createClaudeExecutor({ bin }), {
      capabilities: ["items:create", "repo:write"], child: { ...binding, server: SERVER },
    });
    expect(argv.slice(0, 6)).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"]);
    expect(argv).not.toContain("--restricted");
    expect(argv).not.toContain("--disallowedTools");
  });

  it("keeps a read-only step without the binding on exactly the flags any read-only step gets", async () => {
    const readOnly = [
      "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "manual", "--restricted",
      "--disallowedTools", ...WRITE_TOOLS, "--settings", JSON.stringify({ env: INSTRUCTIONS }), "--add-dir", "<instructions>",
      "--mcp-config", JSON.stringify({ mcpServers: {} }), "--strict-mcp-config",
    ];
    const declaring = await argvOf(createClaudeExecutor({ bin }), { capabilities: ["items:create", "repo:read"] });
    expect(atInstructions(declaring)).toEqual(readOnly);
    const unbound = await argvOf(createClaudeExecutor({ bin }), { capabilities: ["repo:read"], child: { ...binding, server: SERVER } });
    expect(atInstructions(unbound)).toEqual(readOnly);
  });

  it("offers nothing to a step that did not declare it, even with a binding", async () => {
    const argv = await argvOf(createClaudeExecutor({ bin }), { capabilities: ["repo:read"], child: { ...binding, server: SERVER } });
    expect(JSON.parse(flag(argv, "--mcp-config") as string)).toEqual({ mcpServers: {} });
    expect(argv).not.toContain("--allowedTools");
  });

  it("offers nothing to a conversation turn, which is handed no binding", async () => {
    const argv = await argvOf(createClaudeExecutor({ bin }), { capabilities: ["items:create"] });
    expect(JSON.parse(flag(argv, "--mcp-config") as string)).toEqual({ mcpServers: {} });
    expect(argv).not.toContain("--allowedTools");
  });

  it("refuses rather than drops the capability when it was not told how to start the server", async () => {
    await expect(argvOf(createClaudeExecutor({ bin }), { capabilities: ["items:create"], child: binding }))
      .rejects.toThrow(/cannot give this step create_child/);
  });

  /*
   * `resolveStepServers` (this same file, `.landrace/hooks/claude.ts`) already
   * refuses an allowlisted server named "landrace" for the shipped executor,
   * before a step ever runs. This is the backstop inside the executor itself:
   * an allowlisted server under the engine's own name would otherwise be
   * silently replaced by whichever of the two `servers[name] = …` assigned
   * last, and the loser could be either the operator's server or the one
   * create_child is trusted to answer to.
   */
  it("refuses rather than silently replace an allowlisted server under the engine's own name", async () => {
    await expect(argvOf(createClaudeExecutor({ bin, mcpServers: { [SERVER.name]: { command: "decoy" } } }), {
      capabilities: ["items:create", "repo:read"], child: { ...binding, server: SERVER },
    })).rejects.toThrow(/already named "landrace"/);
  });

  /*
   * A server named and shaped nothing like "landrace"/create_child, so this
   * is not merely re-proving the fixed-name case above: two tools, listed in
   * the order the engine's own `server.tools` gives them, and nothing else
   * from this server allowed wholesale.
   */
  it("builds mcp__<name>__<tool> from whatever name and tools the engine's server carries, not from a fixed one", async () => {
    const OTHER = { name: "items", command: "/usr/bin/node", args: ["cli.js", "mcp"], tools: ["a", "b"] };
    const argv = await argvOf(createClaudeExecutor({ bin }), {
      capabilities: ["items:create", "repo:read"], child: { ...binding, server: OTHER },
    });
    expect(list(argv, "--allowedTools").sort()).toEqual(["mcp__items__a", "mcp__items__b"]);
    expect(argv).not.toContain("mcp__items");
  });

  /*
   * Moved from tests/cli/start.test.ts, which no longer builds an executor at
   * all: the engine's server is described once, by `childServerCommand`, and
   * handed to the executor on the run itself rather than at construction. What
   * this pins now is that the two sources of a server never collide: the
   * operator's own plugins and allowlisted servers (construction-time) and the
   * engine's per-run one (`child.server`) both reach the same argv, neither
   * one crowding out the other.
   */
  it("hands the step the plugins and servers it was given, beside the engine's server", async () => {
    const executor = createClaudeExecutor({
      bin, plugins: ["superpowers@claude-plugins-official"], mcpServers: { "codebase-memory-mcp": { command: "cbm" } }, mcpTools: {},
    });
    const argv = await argvOf(executor, { capabilities: ["items:create"], child: { parent: "12", stage: "breakdown", round: 2, server: SERVER } });
    const servers = JSON.parse(argv[argv.indexOf("--mcp-config") + 1] as string).mcpServers;
    expect(Object.keys(servers).sort()).toEqual(["codebase-memory-mcp", "landrace"]);
    expect(JSON.parse(argv[argv.indexOf("--settings") + 1] as string)).toEqual({
      enabledPlugins: { "superpowers@claude-plugins-official": true }, env: INSTRUCTIONS,
    });
  });
});

/*
 * A step's own instructions and skills, from the worktree it runs in (#89):
 * copies Landrace checked and made outside the worktree, and nothing else of
 * the project's. The CLI rereads its instructions mid-run, after compacting,
 * and a step can change its worktree by then; it reads them, and what they
 * import, in its own process, outside the sandbox; and `--add-dir` also reads
 * the plugins a directory's own `.claude/settings.json` enables (2.1.289's
 * own source), whose hooks run outside the sandbox.
 */
describe("a step's own instructions and skills", () => {
  /** A worktree holding these files, under `.claude/` and beside it. */
  const worktree = (files: Record<string, string>): string => {
    const cwd = withCfg({ out: "{{ARGV_JSON}}" });
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), text);
    }
    return cwd;
  };
  const stepIn = async (cwd: string, capabilities?: readonly string[]): Promise<string[]> => {
    const r = await createClaudeExecutor({ bin }).run("p", {
      round: 1, signal: new AbortController().signal, cwd, ...(capabilities === undefined ? {} : { capabilities }),
    });
    return JSON.parse(r.text) as string[];
  };
  /** What each file in a directory holds, by its path in it. */
  const contents = (dir: string): Record<string, string> =>
    Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => [join(e.parentPath, e.name).slice(dir.length + 1), readFileSync(join(e.parentPath, e.name), "utf8")]));
  const TIERS = [["write", ["repo:read", "repo:write"]], ["read-only", ["repo:read"]]] as const;
  /** A worktree whose fake agent fails the run with "ran", had it started. */
  const refusing = (files: Record<string, string>): string =>
    worktree({ ...files, "fake.json": JSON.stringify({ exit: 1, stderr: "ran" }) });

  it.each(TIERS)("hands a %s step a copy of its CLAUDE.md, made outside the worktree, and none of its settings", async (_, capabilities) => {
    const cwd = worktree({
      "CLAUDE.md": "Say PROBE.\n",
      ".claude/settings.json": JSON.stringify({ enabledPlugins: { "x@y": true }, hooks: { SessionStart: [] } }),
      ".claude/CLAUDE.md": "x", "CLAUDE.local.md": "x",
    });
    const dir = flag(await stepIn(cwd, capabilities), "--add-dir") as string;
    expect(dir.startsWith(`${realpathSync(cwd)}/`)).toBe(false);
    expect(contents(dir)).toEqual({ "CLAUDE.md": "Say PROBE.\n" });
  });

  it("copies a CLAUDE.md that is a link to AGENTS.md beside it", async () => {
    const cwd = worktree({ "AGENTS.md": "x" });
    symlinkSync("AGENTS.md", join(cwd, "CLAUDE.md"));
    const dir = flag(await stepIn(cwd, ["repo:read"]), "--add-dir") as string;
    expect(lstatSync(join(dir, "CLAUDE.md")).isFile()).toBe(true);
    expect(contents(dir)).toEqual({ "CLAUDE.md": "x" });
  });

  // A step could relink its CLAUDE.md to a key mid-run; the CLI rereads the copy.
  it("keeps the CLAUDE.md it checked when the worktree's changes after", async () => {
    const out = withCfg({});
    writeFileSync(join(out, "credentials"), "aws_secret_access_key = x\n");
    const cwd = worktree({ "CLAUDE.md": "Say PROBE.\n" });
    const dir = flag(await stepIn(cwd, ["repo:read", "repo:write"]), "--add-dir") as string;
    rmSync(join(cwd, "CLAUDE.md"));
    symlinkSync(join(out, "credentials"), join(cwd, "CLAUDE.md"));
    expect(contents(dir)).toEqual({ "CLAUDE.md": "Say PROBE.\n" });
  });

  // A directory added is one the run may edit: a write step is denied the copies, by its sandbox and its Edit rules.
  it("denies a write step writing the copies it loads", async () => {
    const argv = await stepIn(worktree({ "CLAUDE.md": "x" }), ["repo:read", "repo:write"]);
    const built = dirname(flag(argv, "--add-dir") as string);
    const settings = JSON.parse(flag(argv, "--settings") as string);
    expect(settings.sandbox.filesystem.denyWrite).toEqual([built]);
    expect(settings.permissions.deny).toContain(`Edit(/${built}/**)`);
  });

  /*
   * The CLI follows `@path` imports in the CLAUDE.md it loads, among the
   * copies: each file imported is copied at the same place, its own imports
   * too. What it imports from `.claude/` would load beside more than
   * instructions, and is not copied; one that is not a file is not either.
   */
  it("copies what CLAUDE.md imports beside it, and nothing under .claude/", async () => {
    const root = "@AGENTS.md\nSee @docs/style.md#tone and @docs, not @missing.md; mail a@b.c.\n@.claude/settings.json\n@.CLAUDE/settings.local.json\n";
    const cwd = worktree({
      "CLAUDE.md": root,
      "AGENTS.md": "agents\n",
      "docs/style.md": "style, and @../AGENTS.md again\n",
      ".claude/settings.json": JSON.stringify({ enabledPlugins: { "x@y": true } }),
      ".CLAUDE/settings.local.json": JSON.stringify({ enabledPlugins: { "x@y": true } }),
    });
    const dir = flag(await stepIn(cwd, ["repo:read"]), "--add-dir") as string;
    expect(contents(dir)).toEqual({ "CLAUDE.md": root, "AGENTS.md": "agents\n", "docs/style.md": "style, and @../AGENTS.md again\n" });
  });

  /*
   * The CLI reads an import outside the sandbox, so one of `~/`, an absolute
   * path or a path above the worktree — anywhere, code included — is refused
   * before the agent starts, naming the file and the import.
   */
  it.each([
    ["@~/.aws/credentials", "~/.aws/credentials"],
    ["@/etc/passwd", "/etc/passwd"],
    ["@../outside.md", "../outside.md"],
    ["```\n@~/.ssh/id_ed25519\n```", "~/.ssh/id_ed25519"],
  ])("refuses a CLAUDE.md importing %j, under both tiers", async (line, path) => {
    const cwd = refusing({ "AGENTS.md": `# Probe\n\n${line}\n` });
    symlinkSync("AGENTS.md", join(cwd, "CLAUDE.md"));
    for (const [, capabilities] of TIERS) {
      await expect(stepIn(cwd, capabilities)).rejects.toThrow(
        `refused to load the step's instructions: CLAUDE.md imports ${path}, which is outside the worktree`);
    }
  });

  it("refuses an import that leads above the worktree from a file it imports, naming that file", async () => {
    const cwd = refusing({ "CLAUDE.md": "@docs/a.md\n", "docs/a.md": "@../../outside.md\n" });
    await expect(stepIn(cwd, ["repo:read"])).rejects.toThrow("docs/a.md imports ../../outside.md, which is outside the worktree");
  });

  /*
   * Landrace reads what it copies outside the sandbox: a CLAUDE.md, or a file
   * it imports, that leads outside the worktree would put the file in every
   * later run's instructions, past the sandbox's deny list and the Read rules.
   * A link that leads nowhere has nothing to copy, and loads nothing.
   */
  it("refuses a CLAUDE.md, or a file it imports, that leads outside the worktree, naming it", async () => {
    const out = withCfg({});
    writeFileSync(join(out, "credentials"), "aws_secret_access_key = x\n");
    const linked = refusing({});
    symlinkSync(join(out, "credentials"), join(linked, "CLAUDE.md"));
    const imported = refusing({ "CLAUDE.md": "@notes.md\n" });
    symlinkSync(join(out, "credentials"), join(imported, "notes.md"));
    for (const [, capabilities] of TIERS) {
      await expect(stepIn(linked, capabilities)).rejects.toThrow(
        "refused to load the step's instructions: CLAUDE.md leads outside the worktree");
      await expect(stepIn(imported, capabilities)).rejects.toThrow(
        "refused to load the step's instructions: CLAUDE.md imports notes.md, which leads outside the worktree");
    }
  });

  // agsync's `CLAUDE.md -> AGENTS.md`, on a branch that removed AGENTS.md.
  it("runs a step whose CLAUDE.md leads nowhere, loading nothing", async () => {
    const cwd = worktree({});
    symlinkSync("AGENTS.md", join(cwd, "CLAUDE.md"));
    for (const [, capabilities] of TIERS) expect(contents(flag(await stepIn(cwd, capabilities), "--add-dir") as string)).toEqual({});
  });

  // Landrace reads it before the step's timeout and abort exist; the CLI skips one too.
  it("loads nothing from a CLAUDE.md that is a named pipe, rather than wait on it", async () => {
    const cwd = worktree({});
    execFileSync("mkfifo", [join(cwd, "CLAUDE.md")]);
    expect(contents(flag(await stepIn(cwd, ["repo:read"]), "--add-dir") as string)).toEqual({});
  });

  it("gives the screener neither, since it loads nothing of the worktree", async () => {
    const cwd = worktree({ "CLAUDE.md": "x", ".claude/skills/probe/SKILL.md": "---\nname: probe\n---\n" });
    const argv = await stepIn(cwd);
    expect(argv).not.toContain("--add-dir");
    expect(argv).not.toContain("--plugin-dir");
  });

  const SKILL = "---\nname: probe\ndescription: A probe skill.\n---\n\nSay PROBE.\n";

  it.each([
    ["write", ["repo:read", "repo:write"]],
    ["read-only", ["repo:read"]],
  ])("hands a %s step the worktree's skills as a plugin of their own, made outside the worktree", async (_, capabilities) => {
    const cwd = worktree({ ".claude/skills/probe/SKILL.md": SKILL, ".claude/skills/probe/references/x.md": "x" });
    const dir = flag(await stepIn(cwd, capabilities), "--plugin-dir") as string;
    expect(realpathSync(dir).startsWith(`${realpathSync(cwd)}/`)).toBe(false);
    expect(readdirSync(dir).sort()).toEqual([".claude-plugin", "skills"]);
    expect(JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8"))).toEqual({ name: "project" });
    expect(readdirSync(join(dir, "skills"))).toEqual(["probe"]);
    // The SKILL.md that was read and checked, as a file of the plugin's own;
    // the rest of the skill's folder, as it is in the worktree.
    expect(lstatSync(join(dir, "skills", "probe", "SKILL.md")).isFile()).toBe(true);
    expect(readFileSync(join(dir, "skills", "probe", "SKILL.md"), "utf8")).toBe(SKILL);
    expect(realpathSync(join(dir, "skills", "probe", "references"))).toBe(realpathSync(join(cwd, ".claude", "skills", "probe", "references")));
  });

  // agsync's layout: `.claude/skills -> ../.agents/skills`.
  it("follows a skills folder that is a link to a synced one", async () => {
    const cwd = worktree({ ".agents/skills/probe/SKILL.md": SKILL });
    mkdirSync(join(cwd, ".claude"));
    symlinkSync("../.agents/skills", join(cwd, ".claude", "skills"));
    const dir = flag(await stepIn(cwd, ["repo:read"]), "--plugin-dir") as string;
    expect(readFileSync(join(dir, "skills", "probe", "SKILL.md"), "utf8")).toBe(SKILL);
  });

  /*
   * Landrace reads each SKILL.md in its own process, outside the sandbox, and
   * copies it into the plugin: one linked out of the worktree would hand the
   * agent a file its sandbox and Read rules deny it — a key, which has no
   * front matter to refuse. Refused before anything is read or started.
   */
  it.each([".claude/skills/probe/SKILL.md", ".claude/skills/probe", ".claude/skills"])(
    "refuses %s linked outside the worktree, naming it", async (path) => {
      const out = withCfg({});
      mkdirSync(join(out, "skills", "probe"), { recursive: true });
      writeFileSync(join(out, "skills", "probe", "SKILL.md"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
      const cwd = worktree({ "fake.json": JSON.stringify({ exit: 1, stderr: "ran" }) });
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      symlinkSync(join(out, path.slice(".claude/".length)), join(cwd, path));
      for (const capabilities of [["repo:read", "repo:write"], ["repo:read"]]) {
        await expect(stepIn(cwd, capabilities)).rejects.toThrow(`refused to load the project's skills: ${path} leads outside the worktree`);
      }
    });

  /*
   * Landrace reads it before the step's timeout and abort exist: a named
   * pipe there, opened to read, would wait for a writer forever. Refused,
   * naming it, under both tiers.
   */
  it("refuses a SKILL.md that is a named pipe rather than wait on it", async () => {
    const cwd = refusing({});
    mkdirSync(join(cwd, ".claude", "skills", "probe"), { recursive: true });
    execFileSync("mkfifo", [join(cwd, ".claude", "skills", "probe", "SKILL.md")]);
    for (const [, capabilities] of TIERS) {
      await expect(stepIn(cwd, capabilities)).rejects.toThrow(".claude/skills/probe/SKILL.md is not a regular file");
    }
  });

  // A skill folder left dangling by a branch that removed what it led to: nothing to copy.
  it("runs a step whose skill folder leads nowhere, loading no skill from it", async () => {
    const cwd = worktree({ ".claude/skills/probe/SKILL.md": SKILL });
    symlinkSync("../../missing", join(cwd, ".claude", "skills", "gone"));
    const dir = flag(await stepIn(cwd, ["repo:read"]), "--plugin-dir") as string;
    expect(readdirSync(join(dir, "skills"))).toEqual(["probe"]);
  });

  it("passes no --plugin-dir when the worktree has no skills, nor to the screener when it has", async () => {
    expect(await stepIn(worktree({}), ["repo:read"])).not.toContain("--plugin-dir");
    expect(await stepIn(worktree({ ".claude/skills/probe/SKILL.md": SKILL }))).not.toContain("--plugin-dir");
  });

  it("loads only what holds a SKILL.md, and rebuilds the plugin on every run", async () => {
    const cwd = worktree({
      ".claude/skills/probe/SKILL.md": SKILL, ".claude/skills/gone/SKILL.md": SKILL,
      ".claude/skills/empty/notes.md": "x", ".claude/skills/README.md": "x",
    });
    const dir = flag(await stepIn(cwd, ["repo:read"]), "--plugin-dir") as string;
    expect(readdirSync(join(dir, "skills")).sort()).toEqual(["gone", "probe"]);
    rmSync(join(cwd, ".claude", "skills", "gone"), { recursive: true });
    await stepIn(cwd, ["repo:read"]);
    expect(readdirSync(join(dir, "skills"))).toEqual(["probe"]);
  });

  /*
   * A skill's hooks run as the CLI's own hooks do — outside the sandbox, with
   * the operator's HOME and network — and its allowed-tools approve tools the
   * step never declared. So a skill declaring either is refused before the
   * agent starts, naming its file: the fake agent here would fail the run
   * with "ran" had it started.
   */
  it.each([
    ["hooks", "hooks:\n  PreToolUse:\n    - hooks:\n        - type: command\n          command: touch /tmp/escaped\n", /declares hooks/],
    ["allowed-tools", "allowed-tools: Bash, WebFetch\n", /declares allowed-tools/],
    // Any key not known to leave the step as it declared: a model it bills, servers it starts, an agent it runs under.
    ["model", "model: opus\n", /declares model/],
    ["mcpServers", "mcpServers:\n  x:\n    command: y\n", /declares mcpServers/],
    ["context", "context: fork\nagent: general-purpose\n", /declares context/],
    // YAML 1.1 reads U+0085, U+2028 and U+2029 as line breaks; a line reader splitting on "\n" would not.
    ["a next-line character", "metadata: x\u0085hooks: {}\n", /line break/],
    ["a line separator", "metadata: x\u2028hooks: {}\n", /line break/],
    ["a quoted key", '"hooks": {}\n', /line 3[\s\S]*not a plain key/],
    ["an explicit key", "? hooks\n: {}\n", /not a plain key/],
    ["a merge key", "<<: *x\n", /not a plain key/],
    ["a tab-led line", "\thooks: {}\n", /not a plain key/],
  ])("refuses a skill whose front matter holds %s, before the agent starts", async (_, extra, reason) => {
    const cwd = worktree({ ".claude/skills/probe/SKILL.md": `---\nname: probe\ndescription: x\n${extra}---\nbody\n` });
    writeFileSync(join(cwd, "fake.json"), JSON.stringify({ exit: 1, stderr: "ran" }));
    for (const capabilities of [["repo:read", "repo:write"], ["repo:read"]]) {
      const run = stepIn(cwd, capabilities);
      await expect(run).rejects.toThrow(/\.claude\/skills\/probe\/SKILL\.md/);
      await expect(run).rejects.toThrow(reason);
    }
  });

  it("refuses front matter whose first key is indented, which would hide every key under it", async () => {
    const cwd = worktree({ ".claude/skills/probe/SKILL.md": "---\n  name: probe\n  hooks: {}\n---\n" });
    await expect(stepIn(cwd, ["repo:read"])).rejects.toThrow(/not a plain key/);
  });

  it("loads a skill whose front matter only mentions hooks, in a value or a nested key, and one with none", async () => {
    const cwd = worktree({
      ".claude/skills/a/SKILL.md": '---\n# a comment\nname: a\ndescription: "says hooks: and allowed-tools: in a value"\nmetadata:\n  hooks: nested\n\n---\n',
      ".claude/skills/b/SKILL.md": "No front matter.\n---\nhooks: in the body\n",
      // A BOM and CRLF line ends, as an editor on Windows writes them.
      ".claude/skills/c/SKILL.md": "\uFEFF---\r\nname: c\r\ndescription: x\r\n---\r\n",
      // Every key a skill may hold.
      ".claude/skills/d/SKILL.md": "---\nname: d\ndescription: x\nwhen_to_use: x\nargument-hint: <x>\narguments: [x]\nversion: 1\n" +
        "license: MIT\nmetadata: {}\nuser-invocable: true\ndisable-model-invocation: false\ndisallowed-tools: Bash\npaths: src/**\n---\n",
    });
    const dir = flag(await stepIn(cwd, ["repo:read"]), "--plugin-dir") as string;
    expect(readdirSync(join(dir, "skills")).sort()).toEqual(["a", "b", "c", "d"]);
  });

  // The CLI reloads skills mid-run: the plugin holds what was checked, not a way back into the worktree.
  it("keeps the SKILL.md it checked when the worktree's changes after", async () => {
    const cwd = worktree({ ".claude/skills/probe/SKILL.md": SKILL });
    const dir = flag(await stepIn(cwd, ["repo:read"]), "--plugin-dir") as string;
    writeFileSync(join(cwd, ".claude", "skills", "probe", "SKILL.md"), "---\nhooks: {}\n---\n");
    expect(readFileSync(join(dir, "skills", "probe", "SKILL.md"), "utf8")).toBe(SKILL);
  });
});

/*
 * A run that may write gets Bash, confined by Claude Code's own sandbox: its
 * commands write only in the worktree, reach only the listed hosts, and read
 * nothing under the denied paths. The JSON's keys are Claude Code's, as a live
 * run on 2.1.283 used them; spelled out here so a release that renames one
 * fails this rather than quietly running a step unconfined.
 */
describe("a writing step's sandbox", () => {
  const CONFINED = {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [], strictAllowlist: true },
      filesystem: { denyRead: ["~/.config/gh", "~/.ssh", "~/.aws", "~/.npmrc"] },
    },
    permissions: {
      deny: [
        "Read(~/.config/gh)", "Read(~/.config/gh/**)", "Read(~/.ssh)", "Read(~/.ssh/**)",
        "Read(~/.aws)", "Read(~/.aws/**)", "Read(~/.npmrc)", "Read(~/.npmrc/**)",
      ],
    },
  };
  /** CONFINED for the step that printed `argv`, denied writing the copies of its instructions and skills. */
  const confined = (argv: string[]) => {
    const built = dirname(flag(argv, "--add-dir") as string);
    return {
      sandbox: { ...CONFINED.sandbox, filesystem: { ...CONFINED.sandbox.filesystem, denyWrite: [built] } },
      permissions: { deny: [...CONFINED.permissions.deny, `Edit(/${built}/**)`] },
    };
  };

  it("confines a writing step with no network and the default deny list when it was given no sandbox", async () => {
    const argv = await argvOf(createClaudeExecutor({ bin }), { capabilities: ["repo:read", "repo:write"] });
    expect(JSON.parse(flag(argv, "--settings") as string)).toEqual({ ...confined(argv), env: INSTRUCTIONS });
    expect(flag(argv, "--permission-mode")).toBe("acceptEdits");
  });

  /*
   * `--restricted` already keeps a read-only step off every settings file;
   * a write run is not `--restricted`, so without this flag its own
   * worktree's `.claude/settings.json`/`.claude/settings.local.json` would
   * load too — a step could commit one, and its hooks run outside the OS
   * sandbox entirely, live-checked on 2.1.283 against a plain `acceptEdits`
   * run with no `--setting-sources`.
   */
  it("limits a write run's settings to the operator's own, never the worktree's", async () => {
    const writing = await argvOf(createClaudeExecutor({ bin }), { capabilities: ["repo:read", "repo:write"] });
    expect(writing.filter((a) => a === "--setting-sources")).toHaveLength(1);
    expect(flag(writing, "--setting-sources")).toBe("user");
    const readOnly = await argvOf(createClaudeExecutor({ bin }), { capabilities: ["repo:read"] });
    expect(readOnly).not.toContain("--setting-sources");
  });

  it("puts the configured hosts and paths, and the plugins, in one --settings document", async () => {
    const argv = await argvOf(
      createClaudeExecutor({ bin, plugins: [PLUGIN], sandbox: { hosts: ["github.com", "registry.npmjs.org"], deny: ["~/.ssh"] } }),
      { capabilities: ["repo:read", "repo:write"] },
    );
    expect(argv.filter((a) => a === "--settings")).toHaveLength(1);
    expect(JSON.parse(flag(argv, "--settings") as string)).toEqual({
      enabledPlugins: { [PLUGIN]: true },
      sandbox: {
        ...CONFINED.sandbox,
        network: { allowedDomains: ["github.com", "registry.npmjs.org"], strictAllowlist: true },
        filesystem: { denyRead: ["~/.ssh"], denyWrite: [dirname(flag(argv, "--add-dir") as string)] },
      },
      permissions: { deny: ["Read(~/.ssh)", "Read(~/.ssh/**)", `Edit(/${dirname(flag(argv, "--add-dir") as string)}/**)`] },
      env: INSTRUCTIONS,
    });
  });

  it("sandboxes a writing step that also holds create_child, beside its bound server", async () => {
    const argv = await argvOf(createClaudeExecutor({ bin }), {
      capabilities: ["items:create", "repo:write"], child: { ...BINDING, server: SERVER },
    });
    expect(JSON.parse(flag(argv, "--settings") as string)).toEqual({ ...confined(argv), env: INSTRUCTIONS });
    expect(Object.keys(JSON.parse(flag(argv, "--mcp-config") as string).mcpServers)).toEqual(["landrace"]);
    expect(list(argv, "--allowedTools")).toEqual(["mcp__landrace__landrace_create_child"]);
  });

  /*
   * Only a run that may write has Bash to confine. A read-only step and the
   * screener get nothing of the sandbox, element for element, however the
   * executor's sandbox is configured.
   */
  it("gives a read-only step and the screener nothing of the sandbox", async () => {
    const executor = createClaudeExecutor({ bin, plugins: [PLUGIN], sandbox: { hosts: ["github.com"], deny: ["~/.ssh"] } });
    expect(atInstructions(await argvOf(executor, { capabilities: ["repo:read"] }))).toEqual([
      "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "manual", "--restricted",
      "--disallowedTools", ...WRITE_TOOLS,
      "--settings", JSON.stringify({ enabledPlugins: { [PLUGIN]: true }, env: INSTRUCTIONS }), "--add-dir", "<instructions>",
      "--mcp-config", JSON.stringify({ mcpServers: {} }), "--strict-mcp-config",
    ]);
    expect(await argvOf(executor, {})).toEqual([
      "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "manual", "--restricted", "--tools", "",
      "--mcp-config", JSON.stringify({ mcpServers: {} }), "--strict-mcp-config",
    ]);
  });
});

/*
 * The factory (`claude.create(ctx)`, exported by the same hook) is what the
 * engine actually builds at startup — `createClaudeExecutor` above is the
 * unbranded constructor it calls internally. This is the one test in the
 * file that goes through the factory, so a wiring mistake in `create()`
 * itself (settings read wrong, resolved servers dropped, the log or model
 * not threaded through) has something to fail it, not just the constructor
 * it delegates to.
 */
describe("the factory's wiring, end to end", () => {
  it("carries the model, plugins and an allowlisted server's tools through a real run's argv", async () => {
    const root = await gitRepo();
    const dir = join(root, ".landrace");
    await mkdir(dir, { recursive: true });
    await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { memory: { command: "codebase-memory-mcp", args: [] } } }));

    const ctx: ExecutorContext = {
      config: {
        agent: {
          adapter: "claude", model: "opus", effort: "high", plugins: ["p@m"], mcp: [{ name: "memory", tools: ["t"] }],
          sandbox: { hosts: ["github.com"] },
        },
      } as unknown as ExecutorContext["config"],
      secrets: new Map(),
      signal: new AbortController().signal,
      log: () => {},
      dir,
      redact: () => {},
    };
    const executor = await claude.create(ctx);

    // The factory always spawns the real "claude" binary; put the fake agent
    // on PATH under that name so this run exercises a real spawn end to end,
    // not just argv-building against a `bin` this test chose.
    const binDir = mkdtempSync(join(tmpdir(), "fake-claude-bin-"));
    dirs.push(binDir);
    const claudeBin = join(binDir, "claude");
    copyFileSync(bin, claudeBin);
    chmodSync(claudeBin, 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${binDir}:${savedPath ?? ""}`;
    try {
      const argv = await argvOf(executor, { capabilities: ["repo:read"] });
      expect(flag(argv, "--model")).toBe("opus");
      expect(flag(argv, "--effort")).toBe("high");
      expect(JSON.parse(flag(argv, "--settings") as string)).toEqual({ enabledPlugins: { "p@m": true }, env: INSTRUCTIONS });
      expect(JSON.parse(flag(argv, "--mcp-config") as string).mcpServers).toEqual({
        memory: { command: "codebase-memory-mcp", args: [] },
      });
      expect(list(argv, "--allowedTools")).toEqual(["mcp__memory__t"]);

      // The read-only run above got the plugins and nothing of the sandbox; a
      // write run gets both — the configured hosts, and the deny list the
      // block left out.
      const write = JSON.parse(flag(await argvOf(executor, { capabilities: ["repo:read", "repo:write"] }), "--settings") as string);
      expect(write.enabledPlugins).toEqual({ "p@m": true });
      expect(write.sandbox.network).toEqual({ allowedDomains: ["github.com"], strictAllowlist: true });
      expect(write.sandbox.filesystem.denyRead).toEqual(["~/.config/gh", "~/.ssh", "~/.aws", "~/.npmrc"]);
    } finally {
      process.env.PATH = savedPath;
    }
  });
});
