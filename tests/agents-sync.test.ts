import { readFileSync } from "node:fs";

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
});
