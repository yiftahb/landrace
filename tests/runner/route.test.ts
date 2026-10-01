import { claimItems } from "#core/index.js";
import type { Graph, ListedWorkflow, Node, Source, Workflow, WorkspaceListing } from "#namespace.js";
import { displayOf, writeOwnerOf, writeRoute } from "#runner/route.js";

const flow = (label: string): Workflow => ({
  version: 1, name: label, description: "test",
  eligible: [{ when: { "node.state.labels": { $in: [label] } }, else: `no ${label} label` }],
  stages: [{ id: "spec", entry: true, terminal: true }],
});
const source = (id: string): Source => ({ id, relations: [], list: async () => ({ nodes: [], relationships: [] }), read: async () => ({ nodes: [], relationships: [] }) });
const github = source("github");
const gitlab = source("gitlab");
/** `main` and `fast` on one tracker, `gl` on a second. */
const WORKFLOWS: ListedWorkflow[] = [
  { id: "main", source: github, deps: { workflow: flow("lr:auto") } },
  { id: "fast", source: github, deps: { workflow: flow("lr:fast") } },
  { id: "gl", source: gitlab, deps: { workflow: flow("lr:lab") } },
];
const sourceOf = new Map([["main", 0], ["fast", 0], ["gl", 1]]);

const item = (id: string, labels: string[]): Node => ({
  id, kind: "item", title: `t${id}`, link: "", closed: null, priority: null, origin: null, state: { labels },
});
const graph = (...nodes: Node[]): Graph => ({ nodes, relationships: [] });

/** What a tick lists of these two graphs, with `failed` naming the sources that could not list. */
const listing = (graphs: Graph[], failed: Map<number, string> = new Map()): WorkspaceListing => ({
  graphs, sourceOf, failed,
  claims: claimItems(WORKFLOWS.map((w) => ({ id: w.id, workflow: w.deps.workflow, source: sourceOf.get(w.id) ?? -1 })), graphs),
});

describe("writeOwnerOf: whose an item is for a write from the page", () => {
  it("is nobody's before the first listing", () => {
    expect(writeOwnerOf(undefined, "1")).toEqual({ refused: "#1 has not been listed yet; act on it after the first tick" });
  });

  it("is the one workflow the fresh listing gives it to, and otherwise the sentence saying why not", () => {
    const fresh = listing([graph(item("1", ["lr:auto"]), item("2", ["lr:auto", "lr:fast"])), graph(item("3", ["lr:lab"]))]);
    expect(writeOwnerOf(fresh, "1")).toEqual({ workflow: "main" });
    expect(writeOwnerOf(fresh, "3")).toEqual({ workflow: "gl" });
    expect(writeOwnerOf(fresh, "2")).toEqual({ refused: "#2 is claimed by fast and main; act on it after one workflow alone claims it" });
    expect(writeOwnerOf(fresh, "99")).toEqual({ refused: "#99 is not an item the last tick listed" });
  });

  it("refuses every write while a source could not list, naming it, even to an item the others list as owned", () => {
    const fresh = listing([graph(item("1", ["lr:auto"])), graph()], new Map([[1, "tracker down"]]));
    expect(writeOwnerOf(fresh, "1")).toEqual({
      refused: "#1 is not written to until every source lists again: could not list the source of gl: tracker down",
    });
  });

  /*
   * The page is shown a failed source as it last listed, and reads route by
   * that. A write never does: the last good listing may be stale, and an
   * item it shows as one workflow's may be a clash the failed source would
   * now report.
   */
  it("never routes a write by what the page is shown of a failed source", () => {
    const display = displayOf(WORKFLOWS);
    display(listing([graph(item("1", ["lr:auto"])), graph(item("3", ["lr:lab"]))]));
    const fresh = listing([graph(item("1", ["lr:auto"])), graph()], new Map([[1, "tracker down"]]));
    const shown = display(fresh);

    // The page still shows #3 as gl's, from the last listing that had it...
    expect(shown && writeRoute(shown, "3")).toEqual({ workflow: "gl" });
    // ...and a write to it is refused, by the listing that did not.
    expect(writeOwnerOf(fresh, "3")).toEqual({
      refused: "#3 is not written to until every source lists again: could not list the source of gl: tracker down",
    });
  });
});

describe("displayOf: what the page is shown of each listing", () => {
  it("shows a listing every source answered as it is", () => {
    const fresh = listing([graph(item("1", ["lr:auto"])), graph()]);
    expect(displayOf(WORKFLOWS)(fresh)).toBe(fresh);
  });

  it("shows a source that could not list as it last listed, with claims judged again over what is shown", () => {
    const display = displayOf(WORKFLOWS);
    display(listing([graph(item("1", ["lr:auto"])), graph(item("3", ["lr:lab"]))]));
    const shown = display(listing([graph(item("1", ["lr:fast"])), graph()], new Map([[1, "tracker down"]])));
    expect(shown?.graphs.map((g) => g.nodes.map((n) => n.id))).toEqual([["1"], ["3"]]);
    expect(shown?.claims.owner).toEqual(new Map([["1", "fast"], ["3", "gl"]]));
  });

  it("shows nothing new while a source that failed has never listed at all", () => {
    expect(displayOf(WORKFLOWS)(listing([graph(item("1", ["lr:auto"])), graph()], new Map([[1, "tracker down"]])))).toBeNull();
  });
});
