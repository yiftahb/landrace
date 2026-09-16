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
  it("validates the shipped .landrace workflow clean, on every rule", async () => {
    const r = await runValidate(".landrace");
    // Every rule, not just the one that prompted this test. Filtering to a
    // single rule let a later rule — entry-record, which catches a looping
    // stage that records no entry and so silently runs its body once — pass
    // this test while the shipped file actually violated it.
    // "secret" is the one exception: it asks whether a token resolves in this
    // environment, which is a fact about the machine, not about the workflow.
    expect(r.problems.filter((p) => p.rule !== "secret")).toEqual([]);
  });

  // Round-3 Important: a step's own prompt printing a literal object (e.g.
  // `` `{"kind": "done"}` `` in build.md) is an honest completion away from
  // triggering the false-"many" it causes if the model echoes that exact
  // line back — the discriminator-key fix on the extractor makes it a real
  // (if unlikely) candidate, and two claimed candidates is still ambiguous.
  // The step files should describe the shape in prose, not print it.
  it("does not print a literal json object in any shipped step's prompt", async () => {
    const { steps } = await loadWorkflow(".landrace");
    for (const step of steps.values()) {
      expect(step.prompt).not.toMatch(/\{\s*"[a-zA-Z_]+"\s*:/);
    }
    expect(steps.size).toBeGreaterThan(0);
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
    // The plan for entering a stage, with the round filled in from the
    // destination's own counter — nothing in `next` reads the network.
    expect(r.effects).toEqual([{
      type: "tracker.comment", kind: "enter", stage: "spec", round: 1,
      marker: "enter:spec:1", body: "Writing the spec, round 1.",
    }]);
  });
});
