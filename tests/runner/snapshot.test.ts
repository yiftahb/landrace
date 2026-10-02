import { buildSnapshot, snapshotProvides } from "#runner/snapshot.js";
import { decide, deriveRel, deriveRun } from "#core/index.js";
import { GOTO_TRIGGER, stageFromLabels } from "#conventions.js";
import { definePreHook } from "#hooks/contracts.js";
import { createExternalState, staticSource } from "#testing/index.js";
import { loadShipped } from "#tests/support/shipped.js";
import type { Entry, HookContext, Node, Rel, Run, RuntimeConfig, Workflow } from "#namespace.js";

const ctx = (): Omit<HookContext, "snapshot"> => ({
  item: "1",
  config: {} as HookContext["config"],
  secrets: new Map(),
  signal: new AbortController().signal,
  log: () => {},
});

const ctxFor = (item: string) => ({
  item, config: {} as RuntimeConfig, secrets: new Map(), signal: new AbortController().signal, log: () => {},
});

const itemNode = (id: string, labels: string[] = []): Node => ({
  id, kind: "item", title: `issue ${id}`, link: `u/${id}`, closed: null, priority: null, origin: null,
  state: { labels, assignees: [] },
});

/** One item, "1", alone in its graph — for the cases that are about the pre hooks rather than the source. */
const lone = (labels: string[] = []) => staticSource({ nodes: [itemNode("1", labels)], relationships: [] });

describe("buildSnapshot reads the graph first", () => {
  it("puts the item's node and graph in the snapshot before any pre hook runs, and its rel counts after", async () => {
    const state = createExternalState({ items: [{ id: "1", labels: ["lr:stage:build"] }] });
    state.openPull("1", { openThreads: 2 });
    let seenByHook: { node?: unknown; graph?: unknown; rel?: unknown } = {};
    const peek = definePreHook({ id: "peek", provides: [], run: ({ snapshot }) => {
      seenByHook = { node: snapshot.node, graph: snapshot.graph, rel: snapshot.rel };
      return {};
    } });
    const s = await buildSnapshot({ item: "1", source: state.source, hooks: [state.pre, peek], workflow: null, ctx: ctxFor("1") });
    expect((s.node as Node).id).toBe("1");
    expect(seenByHook.node).toEqual(s.node);
    expect(seenByHook.graph).toEqual(s.graph);
    // rel reads the run's rounds, which come from the hooks' entries.
    expect(seenByHook.rel).toBeUndefined();
    expect((s.rel as Rel)["implements"]?.in).toMatchObject({ total: 1, not: { merged: 1 }, sum: { openThreads: 2 } });
    expect((s.run as Run).stage).toBe("build");
  });

  it("fails the snapshot, naming the source, when its graph is not one to decide from", async () => {
    const broken = staticSource({ nodes: [], relationships: [] });
    await expect(buildSnapshot({ item: "1", source: broken, hooks: [], workflow: null, ctx: ctxFor("1") }))
      .rejects.toThrow(/source "static".*"1" is not in the graph/);
  });

  it("names the source when its read throws", async () => {
    const failing = { ...lone(), read: async () => { throw new Error("rate limited"); } };
    await expect(buildSnapshot({ item: "1", source: failing, hooks: [], workflow: null, ctx: ctxFor("1") }))
      .rejects.toThrow(/source "static" could not read "1": rate limited/);
  });

  it("does not let a pre hook move the item by returning a node of its own", async () => {
    const liar = definePreHook({ id: "liar", provides: [], run: () => ({ node: itemNode("1", ["lr:stage:done"]) }) });
    const s = await buildSnapshot({ item: "1", source: lone(["lr:stage:spec"]), hooks: [liar], workflow: null, ctx: ctxFor("1") });
    expect((s.run as Run).stage).toBe("spec");
    expect(labelsIn(s.node)).toEqual(["lr:stage:spec"]);
  });
});

describe("buildSnapshot's rel", () => {
  it("does not let a pre hook replace the rel counts", async () => {
    const state = createExternalState({ items: [{ id: "1", labels: ["lr:stage:build"] }] });
    state.openPull("1");
    const liar = definePreHook({ id: "liar", provides: [], run: () => ({ rel: { implements: { in: { total: 0 } } } }) });
    const s = await buildSnapshot({ item: "1", source: state.source, hooks: [state.pre, liar], workflow: null, ctx: ctxFor("1") });
    expect((s.rel as Rel)["implements"]?.in.total).toBe(1);
  });

  it("leaves out a child an earlier round of the stage created once the stage is entered again", async () => {
    const state = createExternalState({ items: [{ id: "1", labels: ["lr:stage:breakdown"] }] });
    const make = (round: number) => state.operator.createItem(
      { title: `r${round}`, parent: "1", origin: { parent: "1", stage: "breakdown", round } }, ctxFor("1"),
    );
    const old = await make(1);
    state.item(old.id).closed = "done";
    await make(2);
    // The engine's own entry records, as the tracker would hold them.
    const post = state.post;
    for (const round of [1, 2]) {
      await post.apply({ type: "tracker.comment", kind: "enter", stage: "breakdown", round, marker: `enter:breakdown:${round}`, body: "in" }, { ...ctxFor("1"), snapshot: {} });
    }

    const s = await buildSnapshot({ item: "1", source: state.source, hooks: [state.pre], workflow: null, ctx: ctxFor("1") });

    expect((s.run as Run).rounds["breakdown"]?.entered).toBe(2);
    expect((s.rel as Rel)["child-of"]?.in).toMatchObject({ total: 1, not: { closed: 1 } });
  });
});

const labelsIn = (node: unknown): unknown => (node as Node).state.labels;

describe("buildSnapshot", () => {
  it("merges fragments in declaration order", async () => {
    const s = await buildSnapshot({
      item: "1",
      source: lone(),
      hooks: [
        definePreHook({ id: "a", run: () => ({ x: 1, shared: "first" }) }),
        definePreHook({ id: "b", run: () => ({ y: 2, shared: "second" }) }),
      ],
      workflow: null,
      ctx: ctx(),
    });
    expect(s).toMatchObject({ x: 1, y: 2, shared: "second" });
  });

  it("gives each hook what previous hooks produced", async () => {
    const s = await buildSnapshot({
      item: "1",
      source: lone(),
      hooks: [
        definePreHook({ id: "a", run: () => ({ base: 2 }) }),
        definePreHook({
          id: "b",
          run: ({ snapshot }) => ({ doubled: ((snapshot as { base: number }).base ?? 0) * 2 }),
        }),
      ],
      workflow: null,
      ctx: ctx(),
    });
    expect(s.doubled).toBe(4);
  });

  it("derives run state from entries and the stage label", async () => {
    const at = "2026-01-01T00:00:00Z";
    const s = await buildSnapshot({
      item: "1",
      source: lone(["lr:auto", "lr:stage:spec"]),
      hooks: [
        definePreHook({
          id: "t",
          run: () => ({
            entries: [{ stage: "spec", kind: "output", round: 1, at, byAgent: true }],
          }),
        }),
      ],
      workflow: null,
      ctx: ctx(),
    });
    expect(s.run).toMatchObject({ stage: "spec", counters: { spec: 1 } });
  });

  it("carries the clock in, so core never reads it", async () => {
    const s = await buildSnapshot({ item: "1", source: lone(), hooks: [], workflow: null, ctx: ctx(), now: 1234 });
    expect(s.now).toBe(1234);
  });

  it("names the hook that threw, rather than failing anonymously", async () => {
    await expect(
      buildSnapshot({
        item: "1",
        source: lone(),
        hooks: [definePreHook({ id: "flaky", run: () => { throw new Error("no network"); } })],
        workflow: null,
        ctx: ctx(),
      }),
    ).rejects.toThrow(/pre hook "flaky".*no network/);
  });

  // N1/N3 class: `(e as Error).message` on a non-Error rejection does not
  // evaluate to undefined, it *throws* — from inside the very catch block
  // whose job is to attribute the failure. A hook is a plain interface, and
  // nothing stops one (especially one doing real network I/O) from rejecting
  // with something that is not an Error.
  it("does not itself crash when the hook rejects with a non-Error value", async () => {
    await expect(
      buildSnapshot({
        item: "1",
        source: lone(),
        hooks: [definePreHook({ id: "flaky", run: () => { throw null; } })],
        workflow: null,
        ctx: ctx(),
      }),
    ).rejects.toThrow(/pre hook "flaky"/);
  });

  it("records the snapshot hash, which the decision cache reads later", async () => {
    const s = await buildSnapshot({
      item: "1", source: lone(), hooks: [], workflow: null, ctx: ctx(), now: 5, digest: (input) => `len:${input.length}`,
    });
    expect(String(s.hash)).toMatch(/^len:\d+$/);
  });

  it("gives the same hash for the same inputs at different times", async () => {
    const digest = (input: string) => `len:${input.length}`;
    const a = await buildSnapshot({ item: "1", source: lone(), hooks: [], workflow: null, ctx: ctx(), now: 1, digest });
    const b = await buildSnapshot({ item: "1", source: lone(), hooks: [], workflow: null, ctx: ctx(), now: 999, digest });
    expect(a.hash).toBe(b.hash);
  });

  it("places the item as null when no stage label is present", async () => {
    const s = await buildSnapshot({
      item: "1",
      source: lone(["lr:auto"]),
      hooks: [definePreHook({ id: "t", run: () => ({ item: { body: "" } }) })],
      workflow: null,
      ctx: ctx(),
    });
    expect(s.run).toMatchObject({ stage: null });
  });
});

/*
 * A stage a custom identity places an item at, with no `lr:stage:` label to
 * say so, is where its run is read from: the goto written there, the round
 * refused there. Read from the label — none — both belonged to nobody, and
 * the tick decided as though neither had happened.
 */
describe("buildSnapshot reads the run from the stage the item is at", () => {
  const w: Workflow = {
    version: 1, name: "t", description: "test",
    stages: [
      { id: "build", entry: true, step: "steps/build.md" },
      { id: "review", identity: { "node.state.labels": { $in: ["needs-my-review"] } }, waits: "person", goto: ["build"] },
      { id: "check", identity: { "node.state.labels": { $in: ["check"] } }, step: "steps/check.md" },
    ],
  };
  const records = (entries: Entry[]) => definePreHook({ id: "records", run: () => ({ entries }) });
  const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
  const read = (labels: string[], entries: Entry[], workflow: Workflow | null) =>
    buildSnapshot({ item: "1", source: lone(labels), hooks: [records(entries)], workflow, ctx: ctxFor("1"), now: 7 });

  it("reads a goto written at a stage an identity places the item at as pending there, and the tick takes it", async () => {
    const s = await read(["needs-my-review"], [
      { stage: "review", kind: "enter", round: 1, from: "build", at: at(1), byAgent: true },
      { stage: "review", kind: "goto", round: 0, goto: "build", at: at(2), byAgent: true },
    ], w);
    expect(s.run).toMatchObject({ stage: "review", goto: "build", previousStage: "build" });
    expect(decide(w, s)).toMatchObject({ action: "transition", stage: { id: "review" }, to: { id: "build" }, trigger: GOTO_TRIGGER });
  });

  it("reads a round refused there as that stage's refusal", async () => {
    const s = await read(["check"], [
      { stage: "check", kind: "enter", round: 1, from: "build", at: at(1), byAgent: true },
      { stage: "check", kind: "refused", round: 1, at: at(2), byAgent: true },
    ], w);
    expect(s.run).toMatchObject({ stage: "check", lastOutputValid: false, lastRefused: true, failedStages: ["check"] });
  });

  /*
   * Main places every item by its label, so for main this is the derivation
   * it always was — run and hash alike — wherever the item is, and wherever
   * it cannot be placed.
   */
  it("reads main's items exactly as their labels always have", async () => {
    const { workflow } = await loadShipped();
    const entries: Entry[] = [
      { stage: "spec", kind: "enter", round: 1, at: at(1), byAgent: true },
      { stage: "spec", kind: "output", round: 1, data: { kind: "spec" }, at: at(2), byAgent: true },
      { stage: "build", kind: "enter", round: 1, from: "triage", at: at(3), byAgent: true },
      { stage: "build", kind: "refused", round: 1, at: at(4), byAgent: true },
      { stage: "blocked", kind: "goto", round: 0, goto: "build", at: at(5), byAgent: true },
      { stage: "blocked", kind: "unblocked", round: 1, at: at(6), byAgent: true },
    ];
    for (const labels of [
      ["lr:auto", "lr:stage:build"],
      ["lr:auto", "lr:stage:blocked", "lr:blocked"],
      ["lr:auto"],
      ["lr:auto", "lr:stage:build", "lr:stage:blocked"],
    ]) {
      const [located, labelled] = await Promise.all([read(labels, entries, workflow), read(labels, entries, null)]);
      expect({ labels, run: located.run }).toEqual({ labels, run: deriveRun(entries, stageFromLabels(labels).stage) });
      expect({ labels, snapshot: located }).toEqual({ labels, snapshot: labelled });
    }
  });
});

/**
 * What `landrace validate` checks predicate paths against.
 *
 * §4's rule 8 is only as good as the union it is given, and the union has two
 * halves: what the hooks declare, and what the engine itself puts in every
 * snapshot. Handing it only the first would flag `run.stage` — a path every
 * workflow reads and no hook provides — and a validator that flags healthy
 * workflows gets switched off.
 */
describe("snapshotProvides", () => {
  const declaring = (id: string, provides: string[]) => definePreHook({ id, provides, run: () => ({}) });

  it("unions what the hooks declare with what the engine derives", () => {
    const provided = snapshotProvides([declaring("a", ["item.labels"]), declaring("b", ["artifacts.pr.*"])], null);

    expect(provided).toEqual(expect.arrayContaining(["item.labels", "artifacts.pr.*", "run.stage", "run.counters.*"]));
  });

  /*
   * §4: "Declare nothing and you opt out." Opting out is for the whole graph,
   * not for that hook's own paths — the engine cannot tell which paths a
   * silent hook contributes, so checking the rest would report a possibly
   * wrong result. Abstaining is the same answer the cycle-bound rule gives
   * when it cannot analyse a trigger.
   */
  it("abstains entirely when any loaded hook declares nothing", () => {
    expect(snapshotProvides([declaring("a", ["item.labels"]), definePreHook({ id: "b", run: () => ({}) })], lone()))
      .toBeNull();
  });

  it("abstains when there are no hooks at all, rather than calling every path uncovered", () => {
    expect(snapshotProvides([], null)).toBeNull();
  });

  it("declares rel paths only for the types the source declares", () => {
    const provided = snapshotProvides([], staticSource({ nodes: [], relationships: [] }, [{ type: "child-of", singular: true }]));
    expect(provided).toContain("rel.child-of.in.total");
    expect(provided).not.toContain("rel.implements.in.total");
  });

  it("covers the node and the graph a source puts in every snapshot", () => {
    const provided = snapshotProvides([], lone()) ?? [];
    const covered = (path: string) =>
      provided.includes(path) || provided.some((k) => k.endsWith("*") && path.startsWith(k.slice(0, -1)));
    for (const path of ["node.id", "node.state.labels", "node.priority", "graph.nodes", "rel.implements.in.sum.openThreads"]) {
      expect({ path, covered: covered(path) }).toEqual({ path, covered: true });
    }
    expect(covered("nodes.id")).toBe(false);
  });

  /*
   * A meta-guard, not a restatement: the engine's list is written by hand and
   * `Run` is not. Add a field to deriveRun and forget this list, and validate
   * starts flagging a workflow that reads it — which is the failure mode that
   * gets a validator switched off.
   */
  it("covers every field the engine actually derives", () => {
    const provided = snapshotProvides([definePreHook({ id: "a", provides: [], run: () => ({}) })], null) ?? [];
    const covered = (path: string) =>
      provided.includes(path) || provided.some((k) => k.endsWith("*") && path.startsWith(k.slice(0, -1)));

    const run = deriveRun([], null);
    for (const field of Object.keys(run)) expect({ field, covered: covered(`run.${field}`) }).toEqual({ field, covered: true });
    expect(covered("now")).toBe(true);
  });

  // The same guard for `rel`: REL_AGG is written by hand and RelAgg is not.
  it("covers every field deriveRel counts, for a declared type, both ways", () => {
    const provided = snapshotProvides([], staticSource({ nodes: [], relationships: [] }, [{ type: "x", singular: false }])) ?? [];
    const covered = (path: string) =>
      provided.includes(path) || provided.some((k) => k.endsWith("*") && path.startsWith(k.slice(0, -1)));
    const derived = deriveRel({ nodes: [itemNode("1")], relationships: [] }, "1", ["x"]);
    if (!derived.ok) throw new Error(derived.why);
    for (const side of ["in", "out"] as const) {
      for (const field of Object.keys(derived.rel["x"]?.[side] ?? {})) {
        expect({ field, covered: covered(`rel.x.${side}.${field}`) }).toEqual({ field, covered: true });
      }
    }
  });
});
