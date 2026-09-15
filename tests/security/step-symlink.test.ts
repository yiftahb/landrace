import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runValidate } from "../../src/cli/validate.js";
import { loadWorkflow, WorkflowLoadError } from "../../src/workflow/load.js";

const SECRET = "SSH_KEY=very-secret-material";

/**
 * Containment by path arithmetic alone is containment against a typo, not
 * against a contributor: git tracks symlinks, so the PR that edits
 * workflow.yaml can add the link that makes a contained path read an
 * uncontained file.
 */
async function fixture(step: string, link: (dir: string, outside: string) => Promise<void>): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "landrace-link-"));
  const dir = join(base, "flow");
  await mkdir(dir, { recursive: true });
  await writeFile(join(base, "outside-secret.md"), `---\ncapabilities: []\n---\n${SECRET}\n`);
  await writeFile(join(dir, "workflow.yaml"), `version: 1
name: linked
stages:
  - id: spec
    entry: true
    step: ${step}
    triggers:
      - name: fresh
        when: { "run.stage": null }
  - id: done
    terminal: true
    triggers:
      - name: spec written
        when: { "outputs.spec": { $exists: true } }
`);
  await link(dir, join(base, "outside-secret.md"));
  return dir;
}

const symlinkedFile = () => fixture("link.md", (dir, outside) => symlink(outside, join(dir, "link.md")));
const symlinkedDir = () => fixture("sl/outside-secret.md", async (dir, outside) => {
  await symlink(join(outside, ".."), join(dir, "sl"));
});

describe("a symlink cannot smuggle a file into an agent's prompt", () => {
  it.each([
    ["a symlinked step file", symlinkedFile],
    ["a symlinked directory", symlinkedDir],
  ])("refuses %s", async (_name, build) => {
    const dir = await build();
    const err = await loadWorkflow(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowLoadError);
    expect((err as WorkflowLoadError).rule).toBe("step-path");
    expect(JSON.stringify(err)).not.toContain("very-secret-material");
  });

  it.each([
    ["a symlinked step file", symlinkedFile],
    ["a symlinked directory", symlinkedDir],
  ])("reports %s as a problem instead of validating clean", async (_name, build) => {
    const { ok, problems } = await runValidate(await build());
    expect(problems).toContainEqual(expect.objectContaining({ rule: "step-path" }));
    expect(ok).toBe(false);
  });

  it("still loads a step reached through a link that stays inside", async () => {
    const base = await mkdtemp(join(tmpdir(), "landrace-link-ok-"));
    const dir = join(base, "flow");
    await mkdir(join(dir, "real"), { recursive: true });
    await writeFile(join(dir, "real", "spec.md"), "---\ncapabilities: []\n---\nWrite it.\n");
    await symlink(join(dir, "real", "spec.md"), join(dir, "spec.md"));
    await writeFile(join(dir, "workflow.yaml"), `version: 1
name: inside
stages:
  - id: spec
    entry: true
    step: spec.md
    triggers:
      - name: fresh
        when: { "run.stage": null }
  - id: done
    terminal: true
    triggers:
      - name: spec written
        when: { "outputs.spec": { $exists: true } }
`);
    const { steps } = await loadWorkflow(dir);
    expect(steps.get("spec.md")?.prompt.trim()).toBe("Write it.");
  });
});

describe("a malformed step path is reported as a path problem, not a missing file", () => {
  const dirFor = async (step: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "landrace-badpath-"));
    await writeFile(join(dir, "workflow.yaml"), `version: 1
name: bad
stages:
  - id: spec
    entry: true
    step: ${JSON.stringify(step)}
    triggers:
      - name: fresh
        when: { "run.stage": null }
  - id: done
    terminal: true
    triggers:
      - name: spec written
        when: { "outputs.spec": { $exists: true } }
`);
    return dir;
  };

  for (const step of ["....//outside-secret.md", "%2e%2e/outside-secret.md", "file:///etc/passwd", "..\\..\\outside.md"]) {
    it(`names a rule for ${JSON.stringify(step)}`, async () => {
      const err = await loadWorkflow(await dirFor(step)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WorkflowLoadError);
      expect((err as WorkflowLoadError).rule).toBe("step-path");
    });
  }
});
