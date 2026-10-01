/**
 * Every shape of run the Claude integration builds a command line for, each
 * named: the executor's own settings, and the run's options. The command lines
 * `.landrace/hooks/claude.ts` built for these before the kit existed are kept
 * in `tests/fixtures/claude-argv.json`, and `tests/integrations/claude-argv.test.ts`
 * holds `new Claude()` to them element by element.
 */
const PLUGIN = "superpowers@claude-plugins-official";
const MEMORY = { command: "codebase-memory-mcp", args: [], env: { MEMORY_HOME: "/var/memory" } };
const SERVER = {
  name: "landrace",
  command: "/usr/bin/node",
  args: ["cli.js", "mcp", "--workspace", "/w", "--child", "12", "--stage", "breakdown", "--round", "2"],
  tools: ["landrace_create_child"],
};
const CHILD = { parent: "12", stage: "breakdown", round: 2, server: SERVER };
const EVERYTHING = {
  model: "opus",
  effort: "high",
  plugins: [PLUGIN, "other@market"],
  mcpServers: { "codebase-memory-mcp": MEMORY, other: { command: "other" } },
  mcpTools: { "codebase-memory-mcp": ["search_graph", "trace_path"] },
  sandbox: { hosts: ["github.com", "registry.npmjs.org"], deny: ["~/.ssh", "~/Library/Application Support/x"] },
};

export const ARGV_CASES: Record<string, { executor: Record<string, unknown>; run: Record<string, unknown> }> = {
  "screener, bare": { executor: {}, run: {} },
  "screener, configured with everything a step gets": { executor: EVERYTHING, run: {} },
  "screener, the run's model": { executor: EVERYTHING, run: { model: "haiku" } },
  "read, bare": { executor: {}, run: { capabilities: ["repo:read"] } },
  "no capabilities declared": { executor: {}, run: { capabilities: [] } },
  "read, everything": {
    executor: EVERYTHING,
    run: { capabilities: ["repo:read"], model: "haiku", effort: "low", resume: "sid-9" },
  },
  "read, holding create_child": { executor: EVERYTHING, run: { capabilities: ["items:create", "repo:read"], child: CHILD } },
  "read, declaring create_child with no binding": { executor: EVERYTHING, run: { capabilities: ["items:create", "repo:read"] } },
  "write, bare": { executor: {}, run: { capabilities: ["repo:read", "repo:write"] } },
  "write, everything": {
    executor: EVERYTHING,
    run: { capabilities: ["repo:read", "repo:write", "items:create"], child: CHILD, effort: "max", resume: "sid-9", fork: true },
  },
  "write, nothing denied": { executor: { sandbox: { hosts: [], deny: [] } }, run: { capabilities: ["repo:write"] } },
};
