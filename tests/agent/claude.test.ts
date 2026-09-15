import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeExecutor } from "../../src/agent/claude.js";

// Relative to the repo root: every existing test in this suite (e.g.
// tests/workflow/load.test.ts) resolves fixtures the same way, and jest's
// cwd during a run is the project root, so this needs no import.meta
// machinery (which ts-jest's non-isolated ESM transform here does not
// support — see jest.config.mjs).
const bin = join(process.cwd(), "tests/agent/fake-agent.mjs");

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

const exec = (over: Record<string, unknown> = {}) => createClaudeExecutor({ bin: process.execPath, ...over });
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

  it("restricts the agent by default: no shell, no edits", async () => {
    const dir = withCfg({ out: "{{ARGV}}" });
    const argv = (await run("x", {}, { cwd: dir })).text;
    expect(argv).toContain("--restricted");
    expect(argv).toContain("--permission-mode plan");
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

  it("reports a missing binary as a startup failure", async () => {
    await expect(
      exec({ bin: "/nonexistent/agent" }).run("x", { round: 1, signal: new AbortController().signal }),
    ).rejects.toThrow(/could not start/);
  });

  // --- argv-injection hardening: a value that begins with "-" lands in a
  // flag slot even inside a validated argv array, so each value that reaches
  // argv is checked against the shape it is actually allowed to have.

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

  it("refuses a relative cwd", async () => {
    await expect(run("x", {}, { cwd: "relative/path" })).rejects.toThrow(/must be an absolute path/);
  });

  it("never lets the parent process's environment reach the agent", async () => {
    process.env.LANDRACE_TEST_SECRET = "super-secret-value-should-not-leak";
    const dir = withCfg({ out: "secret=[{{ENV:LANDRACE_TEST_SECRET}}]" });
    const r = await run("x", {}, { cwd: dir });
    expect(r.text).toBe("secret=[]");
  });
});
