import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runMcp, STDIO_REMOVED } from "#cli/mcp.js";
import { childServerCommand } from "#cli/start.js";

const run = promisify(execFile);

describe("landrace mcp over stdio", () => {
  it("refuses a bare run before reading any configuration, pointing at the front door", async () => {
    // No such workspace: a refusal that read the configuration first would say that instead.
    await expect(runMcp(join(tmpdir(), "no-such-workspace"), { pairing: false })).rejects.toThrow(STDIO_REMOVED);
    await expect(runMcp(join(tmpdir(), "no-such-workspace"), { scope: "main", pairing: false })).rejects.toThrow(STDIO_REMOVED);
    expect(STDIO_REMOVED).toContain("claude mcp add --transport http landrace http://127.0.0.1:4545/mcp");
  });

  it("says so on stderr and exits 1, from the CLI an editor spawns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lr-mcp-stdio-"));
    const failed = await run(process.execPath, [join(process.cwd(), "src", "cli", "index.ts"), "mcp", "--workspace", dir]).then(
      () => null,
      (e: { code?: number; stderr?: string; stdout?: string }) => e,
    );
    expect(failed?.code).toBe(1);
    expect(failed?.stderr).toContain(`landrace mcp: ${STDIO_REMOVED}`);
    // stdout is the protocol an editor reads; nothing goes there.
    expect(failed?.stdout).toBe("");
  });

  it("still reaches the configuration with --pairing, which a pairing's session is handed", async () => {
    await expect(runMcp(join(tmpdir(), "no-such-workspace"), { scope: "main", pairing: true })).rejects.toThrow(/landrace\.yaml/);
    await expect(runMcp(join(tmpdir(), "no-such-workspace"), { pairing: true })).rejects.toThrow("--pairing needs --workflow");
  });

  it("is what a pairing's server, and with --child a step's, is started as", () => {
    const { args } = childServerCommand("/w/.landrace", "main");
    expect(args.slice(-6)).toEqual(["mcp", "--workspace", "/w/.landrace", "--workflow", "main", "--pairing"]);
  });
});
