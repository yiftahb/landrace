import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Claude } from "landrace/integrations/claude";
import { ARGV_CASES } from "#tests/support/claude-argv-cases.js";

/*
 * `tests/fixtures/claude-argv.json` is the command line `new Claude()` builds
 * for each case, element for element, for every tier. It began as what
 * `.landrace/hooks/claude.ts` built before the kit existed, recorded through
 * the fake agent, and changes only where a tier's flags do: since #89 a step
 * gets `--add-dir` over its own directory, written `<cwd>` here, and the
 * setting that loads its `CLAUDE.md` — and, beside skills, `--plugin-dir`
 * over the plugin made of them, written `<plugin-dir>`.
 */
const bin = join(__dirname, "..", "agent", "fake-agent.mjs");
const recorded = JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "claude-argv.json"), "utf8")) as Record<string, string[]>;
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("the Claude integration's command lines", () => {
  it("covers every recorded case", () => {
    expect(Object.keys(ARGV_CASES).sort()).toEqual(Object.keys(recorded).sort());
  });

  it.each(Object.entries(ARGV_CASES))("builds today's argv for %s", async (name, c) => {
    const home = mkdtempSync(join(tmpdir(), "fake-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "fake-agent-"));
    dirs.push(home, cwd);
    writeFileSync(join(cwd, "fake.json"), JSON.stringify({ out: "{{ARGV_JSON}}" }));
    for (const [path, text] of Object.entries(c.worktree ?? {})) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), text);
    }
    const { mcpServers = {}, mcpTools = {}, plugins = [], sandbox = { hosts: [], deny: ["~/.config/gh", "~/.ssh", "~/.aws", "~/.npmrc"] }, ...rest } =
      c.executor as Record<string, never>;
    const executor = new Claude({ bin, home }).build({ ...rest, servers: mcpServers, tools: mcpTools, plugins, sandbox });
    const r = await executor.run("p", { round: 1, signal: new AbortController().signal, cwd, ...c.run });
    const real = realpathSync(cwd);
    const argv = JSON.parse(r.text) as string[];
    expect(argv.map((a, i) => (a === real ? "<cwd>" : argv[i - 1] === "--plugin-dir" ? "<plugin-dir>" : a))).toEqual(recorded[name]);
  });
});
