import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * `landrace next` run as the binary is, because what is under test is how it
 * exits: a stage that closes nodes cannot be planned from a snapshot with no
 * node or graph, and that has to come out as a sentence and a non-zero exit —
 * it came out as an unhandled rejection's stack trace.
 */
describe("landrace next, from the command line", () => {
  it("reports a snapshot it cannot plan from, and exits non-zero", async () => {
    const dir = await mkdtemp(join(tmpdir(), "landrace-next-cli-"));
    await mkdir(join(dir, "steps"));
    await writeFile(join(dir, "workflow.yaml"), [
      "version: 1",
      "name: nx",
      "stages:",
      "  - id: b",
      "    entry: true",
      "    step: steps/b.md",
      "    on_enter:",
      '      - { type: tracker.comment, kind: enter, marker: "enter:{stage}:{round}", body: "round {round}" }',
      "      - { type: nodes.close, follow: [child-of] }",
      "  - id: done",
      "    terminal: true",
      "    triggers:",
      '      - { when: { "run.outputs.b": { $exists: true } } }',
      "",
    ].join("\n"));
    await writeFile(join(dir, "steps", "b.md"), "---\ncapabilities: [items:create]\n---\n\ngo\n");
    const snapshot = join(dir, "snap.json");
    await writeFile(snapshot, JSON.stringify({ entries: [], run: { stage: null } }));

    const failure = await exec(process.execPath,
      ["--experimental-strip-types", "--no-warnings", "src/cli/index.ts", "next", "-w", dir, "-s", snapshot])
      .then(() => null, (e: { code?: number; stderr?: string }) => e);

    expect(failure?.code).toBe(1);
    expect(failure?.stderr?.trim()).toMatch(/^landrace next: stage "b" closes nodes, but the snapshot has no (node|graph)$/);
  });
});
