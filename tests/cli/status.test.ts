import type { Workflow } from "../../src/namespace.js";
import type { Candidate } from "../../src/hooks/types.js";
import { statusRows } from "../../src/cli/status.js";

const workflow: Workflow = {
  version: 1,
  name: "t",
  // Deliberately not `lr:auto`: a status line reports the workflow's own rule,
  // and a hard-coded label name here would look right against the shipped
  // workflow and be wrong against every other one.
  eligible: [{ when: { "ticket.labels": { $in: ["go"] } }, else: "no go label" }],
  stages: [{ id: "spec", entry: true, terminal: true, triggers: [{ when: { "run.stage": null } }] }],
};

const candidate = (labels: string[]): Candidate => ({ ticket: 1, title: "Add export", url: "u/1", labels });

const noteFor = (labels: string[]): string | undefined => statusRows(workflow, [candidate(labels)])[0]?.note;

describe("statusRows", () => {
  it("skips a ticket with the workflow's own reason, not a label name of its own", () => {
    expect(noteFor([])).toBe("skipped: no go label");
  });

  it("reads the position out of the stage label", () => {
    expect(statusRows(workflow, [candidate(["go", "lr:stage:spec"])])[0]).toMatchObject({
      ticket: 1,
      title: "Add export",
      stage: "spec",
    });
  });

  /**
   * Ambiguity halts, and it must not be resolved by ordering here either: two
   * stage labels mean the ticket cannot be placed, and printing the first one
   * would report a position the engine itself refuses to believe.
   */
  it("reports a ticket carrying two stage labels as unplaceable, and names no position", () => {
    const [row] = statusRows(workflow, [candidate(["go", "lr:stage:spec", "lr:stage:build"])]);
    expect(row?.stage).toBeNull();
    expect(row?.note).toMatch(/more than one/);
  });

  it("says whose turn it is", () => {
    expect(noteFor(["go", "lr:blocked"])).toMatch(/blocked/);
    expect(noteFor(["go", "lr:awaiting"])).toMatch(/waiting on you/);
    expect(noteFor(["go", "lr:working"])).toBe("working");
    expect(noteFor(["go"])).toBe("queued");
  });
});
