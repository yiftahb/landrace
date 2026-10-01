import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChildTool } from "#cli/mcp.js";

const TOKEN = "ghp_a_token_long_enough_to_redact";

/**
 * A workspace whose one workflow's `breakdown` step declares items:create and
 * whose `spec` step does not, following the fixture pattern in
 * tests/cli/start.test.ts.
 */
async function dirWithBreakdown(): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), "lr-mcp-child-")), ".landrace");
  const main = join(dir, "workflows", "main");
  await mkdir(join(main, "steps"), { recursive: true });
  await writeFile(
    join(main, "workflow.yaml"),
    `version: 1
name: test
description: test
hooks: []
stages:
  - id: spec
    step: steps/spec.md
  - id: breakdown
    step: steps/breakdown.md
`,
  );
  await writeFile(join(main, "steps", "spec.md"), "---\ncapabilities: []\n---\n\nWrite the spec.\n");
  await writeFile(join(main, "steps", "breakdown.md"), "---\ncapabilities: [items:create]\n---\n\nBreak it down.\n");
  await writeFile(
    join(dir, "landrace.yaml"),
    `version: 1
agent: { adapter: claude, model: opus }
tracker: { repo: acme/widgets }
tick: { interval: 30s, concurrency: 2 }
security: { screen: false }
log: { redact: [githubToken] }
secrets: { githubToken: $LR_TEST_TOKEN }
`,
  );
  await writeFile(join(dir, ".env"), `LR_TEST_TOKEN=${TOKEN}\n`);
  return dir;
}

describe("buildChildTool", () => {
  it("refuses a stage whose step did not declare items:create", async () => {
    await expect(buildChildTool(await dirWithBreakdown(), { parent: "1", stage: "spec", round: 1 }, "main"))
      .rejects.toThrow(/spec.*items:create/);
  });

  it("refuses a stage the workflow does not have", async () => {
    await expect(buildChildTool(await dirWithBreakdown(), { parent: "1", stage: "nope", round: 1 }, "main"))
      .rejects.toThrow(/no stage "nope"/);
  });

  it("refuses a round that is not a positive integer, and a parent that is not an item id", async () => {
    const dir = await dirWithBreakdown();
    await expect(buildChildTool(dir, { parent: "1", stage: "breakdown", round: 0 }, "main")).rejects.toThrow(/round/);
    await expect(buildChildTool(dir, { parent: "a/b", stage: "breakdown", round: 1 }, "main")).rejects.toThrow(/item id/);
  });
});
