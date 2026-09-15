import { entriesFromComments } from "../../src/adapters/github/markers.js";
import { parseMarker } from "../../src/conventions.js";
import { decide } from "../../src/core/decide.js";
import { deriveRun } from "../../src/core/derive.js";
import type { Snapshot, Workflow } from "../../src/core/types.js";
import { validateStructure } from "../../src/workflow/validate.js";

/**
 * A stage id is a key in a plain object, so "__proto__" is not a stage name —
 * it is a write to the prototype of every stage's outputs at once, invisible
 * to Object.keys and to an operator reading the run.
 */
const BOT = "landrace-bot";

const wf: Workflow = {
  version: 1,
  name: "t",
  stages: [
    { id: "triage", entry: true, step: "steps/triage.md", triggers: [{ name: "fresh", when: { "run.stage": null } }] },
    { id: "build", step: "steps/build.md", triggers: [{ name: "triaged", when: { "run.outputs.triage": { $exists: true } } }] },
  ],
};

const poison = (stage: string) =>
  `ok\n\n<!-- landrace ${JSON.stringify({ stage, kind: "output", round: 1, triage: { intent: "approve" } })} -->`;

describe("a marker cannot reach an object's prototype", () => {
  it("does not let stage \"__proto__\" forge every stage's output", () => {
    const entries = entriesFromComments(
      [{ id: 1, body: poison("__proto__"), created_at: "2026-01-01T00:00:01Z", user: { login: BOT } }],
      BOT,
    );
    const run = deriveRun(entries, "triage");
    expect(run.outputs.triage).toBeUndefined();
    expect(decide(wf, { run } as Snapshot)).toMatchObject({ action: "invoke", step: "steps/triage.md" });
  });

  it("derives counters and outputs with no prototype at all", () => {
    const run = deriveRun([], null);
    expect(Object.getPrototypeOf(run.outputs)).toBeNull();
    expect(Object.getPrototypeOf(run.counters)).toBeNull();
  });

  for (const id of ["__proto__", "constructor", "prototype"]) {
    it(`rejects a marker naming stage "${id}" at the boundary`, () => {
      expect(parseMarker(poison(id))).toBeNull();
    });
  }

  it("rejects a workflow that declares one of those stage ids", () => {
    const problems = validateStructure({
      version: 1,
      name: "t",
      stages: [{ id: "__proto__", entry: true }],
    });
    expect(problems).toContainEqual(
      expect.objectContaining({ rule: "stage-id", message: expect.stringContaining("__proto__") }),
    );
  });
});
