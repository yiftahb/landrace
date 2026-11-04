import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { runtimeConfigSchema } from "#config/schema.js";

/*
 * AGENTS.md (CLAUDE.md links to it) is generated from .agsync/instructions.md
 * by `agsync sync`. The retros of #41 and #43 each added a rule to the
 * instructions while sync could not reach the network in the step sandbox,
 * and the generated file — the one every agent actually reads — silently
 * went without it until someone synced by hand.
 */
describe("AGENTS.md", () => {
  it("carries every line of .agsync/instructions.md; run `agsync sync` if not", () => {
    const generated = readFileSync("AGENTS.md", "utf8");
    const missing = readFileSync(".agsync/instructions.md", "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "" && !generated.includes(line));
    expect(missing).toEqual([]);
  });

  // `sync` re-downloads every skill imported with `source:`, and a write step
  // reaches only the hosts landrace.yaml lists. A skill kept here instead
  // syncs with no network at all.
  it("is generated from skills kept in this repository, never fetched", () => {
    const skill = readFileSync(".agsync/skills/agsync/SKILL.md", "utf8");
    const frontmatter = skill.split(/^---$/m)[1] ?? "";
    expect(frontmatter).not.toMatch(/^source:/m);
  });

  // This checkout's engine serves on 4546, since another checkout's holds
  // 4545 on the same machine; an editor pointed at the default port would
  // talk to the other repository's engine.
  it("points the landrace MCP server at this repository's own serve.port", () => {
    const loaded = runtimeConfigSchema.parse(parse(readFileSync(".landrace/landrace.yaml", "utf8")));
    const server = parse(readFileSync(".agsync/mcp/landrace.yaml", "utf8")) as { url?: string };
    expect(loaded.serve.port).toBe(4546);
    expect(server.url).toBe(`http://127.0.0.1:${loaded.serve.port}/mcp`);
  });
});
