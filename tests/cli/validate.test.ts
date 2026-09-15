import { runValidate } from "../../src/cli/validate.js";
import { runNext } from "../../src/cli/next.js";
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
