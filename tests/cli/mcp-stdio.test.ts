import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runMcp, STDIO_REMOVED } from "#cli/mcp.js";
import { childServerCommand } from "#cli/start.js";
import type { KeyLocator } from "#namespace.js";

const run = promisify(execFile);
const none = (): KeyLocator => ({ source: "none" });
const cli = (args: string[]) => run(process.execPath, [join(process.cwd(), "src", "cli", "index.ts"), ...args])
  .then(() => null, (e: { code?: number; stderr?: string; stdout?: string }) => e);

describe("landrace mcp over stdio", () => {
  it("refuses a bare run before reading any configuration, pointing at the front door", async () => {
    // No such workspace: a refusal that read the configuration first would say that instead.
    await expect(runMcp(join(tmpdir(), "no-such-workspace"), { pairing: false, key: none })).rejects.toThrow(STDIO_REMOVED);
    await expect(runMcp(join(tmpdir(), "no-such-workspace"), { scope: "main", pairing: false, key: none })).rejects.toThrow(STDIO_REMOVED);
    expect(STDIO_REMOVED).toContain("over HTTP: http://127.0.0.1:4545/mcp");
  });

  it("says so on stderr and exits 1, from the CLI an editor spawns, with no key flag to ask for", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lr-mcp-stdio-"));
    const failed = await cli(["mcp", "--workspace", dir]);
    expect(failed?.code).toBe(1);
    expect(failed?.stderr).toContain(`landrace mcp: ${STDIO_REMOVED}`);
    // stdout is the protocol an editor reads; nothing goes there.
    expect(failed?.stdout).toBe("");
  });

  it("still reaches the configuration with --pairing, which a pairing's session is handed", async () => {
    await expect(runMcp(join(tmpdir(), "no-such-workspace"), { scope: "main", pairing: true, key: none })).rejects.toThrow(/landrace\.yaml/);
    await expect(runMcp(join(tmpdir(), "no-such-workspace"), { pairing: true, key: none })).rejects.toThrow("--pairing needs --workflow");
  });

  it("is what a pairing's server, and with --child a step's, is started as: where the key is, never the key", () => {
    const { args } = childServerCommand("/w/.landrace", "main", "sub-alice", { source: "systemd", dir: "/run/credentials/landrace.service" });
    expect(args.slice(-9)).toEqual([
      "mcp", "--workspace", "/w/.landrace", "--workflow", "main", "--person=sub-alice",
      "--key-source=systemd", "--key-dir=/run/credentials/landrace.service", "--pairing",
    ]);
  });

  /*
   * A person id is a sign-in's subject, which can start with "-". The CLI
   * must read it as the id, which only the refusal naming it can show: a
   * local configuration refuses any person but the local one, by name.
   */
  it("reads a person id starting with - as the id, from the CLI the loop spawns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lr-mcp-person-"));
    await writeFile(join(dir, "landrace.yaml"), "version: 1\nagent: { adapter: claude, model: opus }\n");
    const { args } = childServerCommand(dir, "main", "-sub-x", { source: "none" });
    const failed = await cli([...args.slice(args.indexOf("mcp")), "--child", "1", "--stage", "breakdown", "--round", "1"]);
    expect(failed?.code).toBe(1);
    expect(failed?.stderr).toContain('only the local person "local" runs steps here, not "-sub-x"');
  });

  it("refuses --child with no --person, from the CLI the loop spawns, before reading any configuration", async () => {
    const failed = await cli([
      "mcp", "--workspace", join(tmpdir(), "no-such-workspace"), "--workflow", "main", "--child", "1", "--stage", "breakdown", "--round", "1",
    ]);
    expect(failed?.code).toBe(1);
    expect(failed?.stderr).toContain("--child needs --person");
  });

  // #205: a server that guessed its key's source could make a key, and orphan every sealed file.
  it("refuses --child and --pairing with no --key-source, before reading any configuration", async () => {
    const base = ["mcp", "--workspace", join(tmpdir(), "no-such-workspace"), "--workflow", "main", "--person=local"];
    for (const args of [[...base, "--child", "1", "--stage", "breakdown", "--round", "1"], [...base, "--pairing"]]) {
      const failed = await cli(args);
      expect(failed?.code).toBe(1);
      expect(failed?.stderr).toContain("needs --key-source");
    }
  });

  it("refuses a pinned source that holds no key, naming it, from the CLI the loop spawns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lr-mcp-key-"));
    await writeFile(join(dir, "landrace.yaml"), "version: 1\nagent: { adapter: claude, model: opus }\n");
    const empty = await mkdtemp(join(tmpdir(), "lr-mcp-creds-dir-"));
    const { args } = childServerCommand(dir, "main", "local", { source: "systemd", dir: empty });
    for (const extra of [["--child", "1", "--stage", "breakdown", "--round", "1"], []]) {
      const failed = await cli([...args.slice(args.indexOf("mcp")), ...extra]);
      expect(failed?.code).toBe(1);
      expect(failed?.stderr).toContain("no credentials key is in the systemd credential");
    }
  });

  it("refuses --pairing as anyone but the local person", async () => {
    await expect(runMcp(join(tmpdir(), "no-such-workspace"), { scope: "main", pairing: true, person: "sub-alice", key: none }))
      .rejects.toThrow('--pairing serves only the local person, not "sub-alice"');
  });
});
