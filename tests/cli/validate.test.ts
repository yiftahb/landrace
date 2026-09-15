import { runValidate } from "../../src/cli/validate.js";
import { runNext } from "../../src/cli/next.js";
import { loadWorkflow } from "../../src/workflow/load.js";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("landrace validate", () => {
  it("reports a sound workflow as valid", async () => {
    const r = await runValidate("tests/fixtures/minimal");
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
  });

  it("returns the problems it found, not just a boolean", async () => {
    const r = await runValidate("tests/fixtures/duplicate-id");
    expect(r.ok).toBe(false);
    expect(r.problems).toContainEqual(
      expect.objectContaining({ rule: "duplicate-id", message: expect.stringMatching(/duplicate stage id/) }),
    );
  });

  it("reports a missing step file as a problem instead of throwing", async () => {
    const r = await runValidate("tests/fixtures/missing-step");
    expect(r.ok).toBe(false);
    expect(r.problems).toContainEqual(
      expect.objectContaining({ rule: "missing-step", message: expect.stringMatching(/does not exist/) }),
    );
  });

  it("reports a schema failure as a problem instead of throwing", async () => {
    const r = await runValidate("tests/fixtures/bad-schema");
    expect(r.ok).toBe(false);
    expect(r.problems).toContainEqual(expect.objectContaining({ rule: "schema" }));
  });

  // C1's real-world proof, checked against the real file rather than a
  // fixture. The shipped workflow burned 30 paid opus invocations in a
  // single converge() call, forever, because build, code-review and
  // fix-review each named a step with no output: block — assess() can never
  // see run.outputs[stage.id] and decide() invokes it again on every pass.
  it("gives every stage with a step a real output contract, so assess() can mark it complete", async () => {
    const { workflow, steps } = await loadWorkflow(".landrace");
    const missingOutput = workflow.stages
      .filter((s) => s.step && !steps.get(s.step)?.output)
      .map((s) => s.id);
    expect(missingOutput).toEqual([]);
  });

  // `validate` is the thing that is supposed to catch this before it ever
  // reaches a converge loop — proved against the real file, not a fixture.
  it("validates the shipped .landrace workflow clean, with no step-output-required problems", async () => {
    const r = await runValidate(".landrace");
    expect(r.problems.filter((p) => p.rule === "step-output-required")).toEqual([]);
  });
});

describe("landrace next", () => {
  it("prints the decision for a snapshot with no I/O", async () => {
    const dir = await mkdtemp(join(tmpdir(), "landrace-cli-"));
    const file = join(dir, "snap.json");
    await writeFile(file, JSON.stringify({ entries: [], run: { stage: null, counters: {}, outputs: {} } }));

    const r = await runNext("tests/fixtures/minimal", file);
    expect(r.decision.action).toBe("transition");
    expect(r.decision.to?.id).toBe("spec");
    expect(r.effects).toEqual([]);
  });
});
