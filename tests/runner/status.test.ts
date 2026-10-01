import type { Node, Workflow } from "#namespace.js";
import { statusRows } from "#runner/status.js";

const workflow: Workflow = {
  version: 1,
  name: "t",
  // Deliberately not `lr:auto`: a status line reports the workflow's own rule,
  // and a hard-coded label name here would look right against the shipped
  // workflow and be wrong against every other one.
  eligible: [{ when: { "node.state.labels": { $in: ["go"] } }, else: "no go label" }],
  stages: [{ id: "spec", entry: true, terminal: true, triggers: [{ when: { "run.stage": null } }] }],
};

const candidate = (labels: string[], assignees: string[] = [], id = "1"): Node => ({
  id, kind: "item", title: "Add export", link: "u/1", closed: null, priority: null, origin: null,
  state: { labels, assignees },
});

const noteFor = (labels: string[]): string | undefined => statusRows(workflow, [candidate(labels)])[0]?.note;

describe("statusRows", () => {
  /*
   * Blocked either way — the note starts "blocked" for everything that reads
   * it so — and says which: a security check is not an agent that could not
   * follow a format, and a person looks in a different place for each.
   */
  it("says an item a security check stopped is blocked, and why", () => {
    expect(noteFor(["go", "lr:stage:screened", "lr:blocked", "lr:screened"])).toBe("blocked by a security check");
    expect(noteFor(["go", "lr:stage:blocked", "lr:blocked"])).toBe("blocked: needs a human");
  });

  it("skips an item with the workflow's own reason, not a label name of its own", () => {
    expect(noteFor([])).toBe("skipped: no go label");
  });

  it("reads the position out of the stage label", () => {
    expect(statusRows(workflow, [candidate(["go", "lr:stage:spec"])])[0]).toMatchObject({
      item: "1",
      title: "Add export",
      stage: "spec",
    });
  });

  /**
   * Ambiguity halts, and it must not be resolved by ordering here either: two
   * stage labels mean the item cannot be placed, and printing the first one
   * would report a position the engine itself refuses to believe.
   */
  it("reports an item carrying two stage labels as unplaceable, and names no position", () => {
    const [row] = statusRows(workflow, [candidate(["go", "lr:stage:spec", "lr:stage:build"])]);
    expect(row?.stage).toBeNull();
    expect(row?.note).toMatch(/more than one/);
  });

  /**
   * A table an operator reads to find out what their instance will do. With
   * the assignee unanswerable from a candidate the eligibility rule abstained,
   * so a colleague's item printed as `queued` — a promise to work it that
   * converge then broke on the next tick.
   */
  it("says a colleague's item is skipped, rather than promising to work it", () => {
    const shared: Workflow = {
      ...workflow,
      eligible: [{ when: { "node.state.assignees": { $in: ["ann"] } }, else: "assigned to somebody else" }],
    };
    const rows = statusRows(shared, [candidate(["go"], ["bo"])]);
    expect(rows[0]?.note).toBe("skipped: assigned to somebody else");
  });

  it("says whose turn it is", () => {
    expect(noteFor(["go", "lr:blocked"])).toMatch(/blocked/);
    expect(noteFor(["go", "lr:awaiting"])).toMatch(/waiting on you/);
    expect(noteFor(["go", "lr:working"])).toBe("working");
    expect(noteFor(["go"])).toBe("queued");
  });

  it("prints items in id order, whatever order the source listed them in", () => {
    const rows = statusRows(workflow, [candidate(["go"], [], "10"), candidate(["go"], [], "9"), candidate(["go"], [], "2")]);
    expect(rows.map((r) => r.item)).toEqual(["2", "9", "10"]);
  });
});
