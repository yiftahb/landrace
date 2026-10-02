import { claimItems, UNPLACED } from "#core/index.js";
import type { Graph, Node, Workflow } from "#namespace.js";
import { BLOCKED_NOTE, laneOf, SCREENED_NOTE, statusRows, workspaceStatusRows } from "#runner/status.js";
import { staticSource } from "#testing/index.js";

const workflow: Workflow = {
  version: 1,
  name: "t", description: "test",
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
    expect(noteFor(["go", "lr:working"])).toBe("working");
    expect(noteFor(["go"])).toBe("queued");
  });

  it("prints items in id order, whatever order the source listed them in", () => {
    const rows = statusRows(workflow, [candidate(["go"], [], "10"), candidate(["go"], [], "9"), candidate(["go"], [], "2")]);
    expect(rows.map((r) => r.item)).toEqual(["2", "9", "10"]);
  });
});

/*
 * Whose turn it is belongs to the stage, not to a label: `waits: person` on
 * the stage the item is located at — which a read-only workflow can place by
 * the item's own state, writing nothing. `lr:awaiting` is still written by a
 * workflow that writes it, and is no longer what Needs you reads.
 */
describe("statusRows, read from where the item is", () => {
  const turns: Workflow = {
    version: 1, name: "t", description: "test",
    eligible: [{ when: { "node.state.labels": { $in: ["go"] } }, else: "no go label" }],
    stages: [
      { id: "spec", entry: true, step: "spec", triggers: [{ when: { "run.stage": null } }] },
      { id: "questions", waits: "person", triggers: [{ when: { "run.stage": "spec" } }] },
      // Placed by the item's own labels: nothing ever writes lr:stage:reviewing.
      { id: "reviewing", waits: "person", identity: { "node.state.labels": { $in: ["needs-my-review"] } },
        triggers: [{ when: { "run.stage": "spec" } }] },
      { id: "done", terminal: true, triggers: [{ when: { "run.stage": "questions" } }] },
    ],
  };
  const rowFor = (labels: string[]) => statusRows(turns, [candidate(labels)])[0];
  const laneFor = (labels: string[]) => {
    const row = rowFor(labels);
    return row ? laneOf(row, turns) : undefined;
  };

  it("says an item at a stage that waits on a person is waiting on you, with no lr:awaiting label", () => {
    expect(rowFor(["go", "lr:stage:questions"])).toMatchObject({ stage: "questions", note: "waiting on you" });
    expect(laneFor(["go", "lr:stage:questions"])).toBe("needs-you");
  });

  it("does not read lr:awaiting: an item at a stage that runs a step is not waiting on you", () => {
    expect(rowFor(["go", "lr:stage:spec", "lr:awaiting"])).toMatchObject({ stage: "spec", note: "queued" });
    expect(laneFor(["go", "lr:stage:spec", "lr:awaiting"])).toBe("waiting");
  });

  // A crash between a stage's status and its label effect leaves the old
  // stage's lr:working behind: the stage, not that label, says whose turn it is.
  it("says waiting on you at a stage that waits, whatever lr:working a crash left behind", () => {
    expect(rowFor(["go", "lr:stage:questions", "lr:working"])?.note).toBe("waiting on you");
  });

  it("still says blocked first, at a stage that waits on a person", () => {
    expect(rowFor(["go", "lr:stage:questions", "lr:blocked"])?.note).toBe("blocked: needs a human");
    expect(rowFor(["go", "lr:stage:questions", "lr:blocked", "lr:screened"])?.note).toBe("blocked by a security check");
  });

  it("reports an item placed by its stage's identity alone, with no lr:stage: label, at that stage", () => {
    expect(rowFor(["go", "needs-my-review"])).toMatchObject({ stage: "reviewing", note: "waiting on you" });
    expect(laneFor(["go", "needs-my-review"])).toBe("needs-you");
  });

  it("reports a terminal stage an item is located at as discharged", () => {
    expect(laneFor(["go", "lr:stage:done"])).toBe("discharged");
  });

  // Ambiguity halts: the label says one stage and an identity another, and
  // the row names both rather than believing either.
  it("halts an item whose label and a stage's identity disagree, naming both", () => {
    const row = rowFor(["go", "lr:stage:spec", "needs-my-review"]);
    expect(row).toMatchObject({ stage: null, note: "halted: cannot place the item: spec, reviewing all match" });
    expect(laneFor(["go", "lr:stage:spec", "needs-my-review"])).toBe("needs-you");
  });
});

/*
 * In a workflow with no entry stage, an item none of its identities place is
 * not a new item waiting to be entered: decide halts it, saying so, on every
 * tick. The row read "queued" for it, so the board filed it under Waiting at
 * no stage and nobody was ever told of a halt only the log could show.
 */
describe("statusRows, of an item no stage places", () => {
  const gappy: Workflow = {
    version: 1, name: "t", description: "test",
    eligible: [{ when: { "node.state.labels": { $in: ["go"] } }, else: "no go label" }],
    stages: [
      { id: "reviewing", waits: "person", identity: { "node.state.labels": { $in: ["needs-review"] } } },
      { id: "approved", terminal: true, identity: { "node.state.labels": { $in: ["approved"] } } },
    ],
  };

  it("halts it in decide's own words, under Needs you, where there is no entry stage to start it at", () => {
    const [row] = statusRows(gappy, [candidate(["go"])]);
    expect(row).toMatchObject({ stage: null, note: `halted: ${UNPLACED}` });
    expect(row && laneOf(row, gappy)).toBe("needs-you");
  });

  it("still says queued where an entry stage would start it", () => {
    const entered: Workflow = {
      ...gappy, stages: [{ id: "triage", entry: true, triggers: [{ when: { "run.stage": null } }] }, ...gappy.stages],
    };
    expect(statusRows(entered, [candidate(["go"])])[0]).toMatchObject({ stage: null, note: "queued" });
  });

  // An identity reading what the listed item does not carry might place it:
  // nothing here can say it is unplaced, so nothing says it is halted.
  it("still says queued where an identity it cannot judge from the item alone might place it", () => {
    const unjudged: Workflow = {
      ...gappy, stages: [...gappy.stages, { id: "escalated", identity: { "node.state.labels": { $in: ["go"] }, "run.outputs.triage.kind": "escalate" } }],
    };
    expect(statusRows(unjudged, [candidate(["go"])])[0]).toMatchObject({ stage: null, note: "queued" });
  });
});

/*
 * A stage's own note, rendered from the item's relationships, in place of
 * "queued" while the item rests there. Display only: the lane is the one
 * "queued" is filed under, whatever the workflow wrote — "blocked by #10"
 * begins as a halt's own note does, and read as text it filed a waiting item
 * under Needs you. `x` is a type nobody gave a meaning.
 */
describe("statusRows, at a stage with a note", () => {
  const noted: Workflow = {
    version: 1, name: "t", description: "test",
    eligible: [{ when: { "node.state.labels": { $in: ["go"] } }, else: "no go label" }],
    stages: [
      { id: "spec", entry: true, step: "spec", triggers: [{ when: { "run.stage": null } }] },
      { id: "waiting", note: "blocked by {rel.x.out.open}", triggers: [{ when: { "run.stage": "spec" } }] },
      { id: "asking", waits: "person", note: "asked of {rel.x.out.open}", triggers: [{ when: { "run.stage": "spec" } }] },
      { id: "done", terminal: true, note: "{rel.x.out.total} related", triggers: [{ when: { "run.stage": "waiting" } }] },
    ],
  };
  const related = (id: string, closed: Node["closed"] = null): Node => ({ ...candidate([], [], id), closed });
  const around = (item: Node): Graph => ({
    nodes: [item, related("10"), related("11"), related("9", "done"), related("8", "dropped"), related("13")],
    relationships: [
      { from: "12", to: "11", type: "x" }, { from: "12", to: "10", type: "x" },
      { from: "12", to: "9", type: "x" }, { from: "12", to: "8", type: "x" },
      // Pointing in: not one of the item's own `out`.
      { from: "13", to: "12", type: "x" },
    ],
  });
  const rowAt = (labels: string[], withGraph = true) => {
    const item = candidate(["go", ...labels], [], "12");
    return statusRows(noted, [item], withGraph ? around(item) : undefined)[0];
  };

  it("shows the stage's note, rendered from the graph, and keeps the item in Waiting", () => {
    const row = rowAt(["lr:stage:waiting"]);
    expect(row).toMatchObject({ stage: "waiting", note: "blocked by #10, #11" });
    expect(row && laneOf(row, noted)).toBe("waiting");
  });

  it("still discharges an item at a terminal stage with a note", () => {
    const row = rowAt(["lr:stage:done"]);
    expect(row).toMatchObject({ stage: "done", note: "3 related" });
    expect(row && laneOf(row, noted)).toBe("discharged");
  });

  it("says queued where it has no graph to render the note from", () => {
    expect(rowAt(["lr:stage:waiting"], false)).toMatchObject({ stage: "waiting", note: "queued" });
  });

  it("keeps its own note while it works, waits on you, is blocked, screened or halted", () => {
    expect(rowAt(["lr:stage:waiting", "lr:working"])?.note).toBe("working");
    expect(rowAt(["lr:stage:asking"])?.note).toBe("waiting on you");
    expect(rowAt(["lr:stage:waiting", "lr:blocked"])?.note).toBe(BLOCKED_NOTE);
    expect(rowAt(["lr:stage:waiting", "lr:blocked", "lr:screened"])?.note).toBe(SCREENED_NOTE);
    expect(rowAt(["lr:stage:waiting", "lr:stage:done"])?.note).toMatch(/^halted: /);
    for (const labels of [["lr:stage:asking"], ["lr:stage:waiting", "lr:blocked"]]) {
      const row = rowAt(labels);
      expect(row && laneOf(row, noted)).toBe("needs-you");
    }
  });

  // A blocker the source holds only as a relationship's far end is named by
  // the note, and is no row of its own, in either table.
  it("names a placeholder in the note, and gives it no row", () => {
    const item = candidate(["go", "lr:stage:waiting"], [], "12");
    const far: Node = { ...candidate(["go"], [], "x-far-5"), placeholder: true };
    const g: Graph = { nodes: [item, far], relationships: [{ from: "12", to: "x-far-5", type: "x" }] };
    expect(statusRows(noted, [item, far], g).map((r) => [r.item, r.note])).toEqual([["12", "blocked by #x-far-5"]]);
    const workflows = [{ id: "t", source: staticSource(g, [{ type: "x", singular: false }]), deps: { workflow: noted } }];
    const listing = { graphs: [g], sourceOf: new Map([["t", 0]]), claims: claimItems([{ id: "t", workflow: noted, source: 0 }], [g]) };
    expect(workspaceStatusRows(workflows, listing).map((r) => [r.item, r.note])).toEqual([["12", "blocked by #x-far-5"]]);
  });

  // What `landrace status` prints: each item's note rendered from its own source's listing.
  it("renders it in the workspace's rows from the listing of the item's own source", () => {
    const g = around(candidate(["go", "lr:stage:waiting"], [], "12"));
    const workflows = [{ id: "t", source: staticSource(g, [{ type: "x", singular: false }]), deps: { workflow: noted } }];
    const listing = { graphs: [g], sourceOf: new Map([["t", 0]]), claims: claimItems([{ id: "t", workflow: noted, source: 0 }], [g]) };
    const row = workspaceStatusRows(workflows, listing).find((r) => r.item === "12");
    expect(row).toMatchObject({ workflow: "t", stage: "waiting", note: "blocked by #10, #11" });
    expect(row && laneOf(row, noted)).toBe("waiting");
  });
});
