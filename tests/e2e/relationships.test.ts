import { RELATIONS } from "#conventions.js";
import { artifactPreHook } from "#runner/artifacts.js";
import { createChild } from "#runner/children.js";
import { snapshotProvides } from "#runner/snapshot.js";
import { BLOCKED_NOTE, laneOf, statusRows } from "#runner/status.js";
import { createExternalState, createHarness } from "#testing/index.js";
import { loadShipped } from "#tests/support/shipped.js";
import { loadWorkflow } from "#workflow/load.js";
import { validate } from "#workflow/validate.js";
import type {
  ExternalItem, ExternalPull, ExternalState, Harness, Lane, LoadedWorkflow, RuntimeContext, ScriptedAnswer, StatusRow, Step, Workflow,
} from "#namespace.js";

/*
 * "Don't build #12 until #10 is done", end to end: the shipped workflows,
 * loaded from `.landrace` as `landrace start` loads them, and the ordered
 * children fixture, driven over the in-memory tracker, forge and docs with
 * only the agent scripted. Every relationship is the tracker's own — seeded
 * on a row, or written through the operator and the child tool — and every
 * decision is the workflow's, read off `rel.blocked-by.out` and the two facts
 * the tracker reports on the item.
 *
 * Each scenario asserts the stages the item went through and the trigger
 * that took it to the one that matters, the labels it wears, the note its
 * status row shows where it waits — rendered over the listing's graph, as
 * the board renders it — and that no build began while a blocker was still
 * open: the world records, at the start of every build, which of the item's
 * blockers were not closed as completed.
 */
jest.setTimeout(60_000);

const ctx: RuntimeContext = { config: {} as RuntimeContext["config"], secrets: new Map(), signal: new AbortController().signal, log: () => {} };
const json = (value: object): string => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
const blockedBy = (...ids: string[]) => ids.map((to) => ({ type: RELATIONS.blockedBy, to }));

/** What every step answers: a spec, an approval, a build, a clean review, and a breakdown into children. */
const ANSWERS: Record<string, ScriptedAnswer> = {
  spec: `# Spec\n\nDo the thing.\n\n${json({ kind: "spec", title: "T" })}`,
  triage: json({ intent: "approve" }),
  breakdown: json({ kind: "children" }),
  build: json({ kind: "done" }),
  "code-review": json({ kind: "reviewed" }),
};

/** The trigger names the gate is read by, word for word as the workflows write them. */
const BLOCKERS_DONE = "its blockers are done";
/** Why the gate sends an item to a person: each reason its own trigger, so the person is told which. */
const REASONS = {
  dropped: "a blocker was dropped",
  cycle: "it is on a cycle of blockers",
  unreadable: "its blockers cannot all be read",
} as const;

interface Flow {
  id: string;
  loaded: () => LoadedWorkflow;
  /** The stages a fresh item passes before its blockers are read: full-cycle writes and approves a spec first. */
  before: string[];
  /** From build to closed as completed, with nothing found in review. */
  road: string[];
  /** The gate's triggers where it is first read: to `waiting`, to build, and to a person — for each reason its own. */
  waits: string;
  frees: string;
  needsYou: (reason: string) => string;
  /** Where a person is sent, what it then wears beside the workflow's own labels, and what its row says. */
  person: { stage: string; labels: string[]; note: string };
}

let shipped: { full: LoadedWorkflow; fast: LoadedWorkflow } | null = null;
beforeAll(async () => {
  const full = await loadShipped();
  const fast = full.workspace.workflows.find((w) => w.id === "fastlane");
  if (!fast) throw new Error(".landrace has no workflows/fastlane");
  shipped = { full, fast };
});
const loadedOf = (id: "full" | "fast") => (): LoadedWorkflow => {
  if (!shipped) throw new Error("the shipped workflows are not loaded yet");
  return shipped[id];
};

const FULL: Flow = {
  id: "full-cycle",
  loaded: loadedOf("full"),
  before: ["spec", "spec-human-review", "triage"],
  road: ["build", "publish", "code-review", "pr-human-review", "done"],
  waits: "you approved the spec, and a blocker is open",
  frees: "you approved the spec",
  needsYou: (reason) => `you approved the spec, but ${reason}`,
  person: { stage: "blocked", labels: ["lr:blocked", "lr:stage:blocked"], note: BLOCKED_NOTE },
};

const FAST: Flow = {
  id: "fastlane",
  loaded: loadedOf("fast"),
  before: [],
  road: ["build", "publish", "code-review", "ci", "merge", "done"],
  waits: "a fresh item, and a blocker is open",
  frees: "a fresh item",
  needsYou: (reason) => `a fresh item, but ${reason}`,
  person: { stage: "stuck", labels: ["lr:awaiting", "lr:stage:stuck"], note: "waiting on you" },
};

/** The pull request opened from `item`'s own branch, if there is one. */
const pullOf = (state: ExternalState, item: string): ExternalPull | null => {
  for (let n = 1; ; n++) {
    let pull: ExternalPull;
    try {
      pull = state.pull(`pr-${n}`);
    } catch {
      return null;
    }
    if (pull.branch === `landrace/${item}`) return pull;
  }
};

/** Resolves when `promise` does or `ms` have passed, whichever is first, and leaves no timer behind. */
const within = async (promise: Promise<void>, ms: number): Promise<void> => {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([promise, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
  clearTimeout(timer);
};

interface Move { item: string; to: string; why: string | null }
type During = (call: { item: string; stage: string; round: number }) => void | Promise<void>;

/**
 * A tracker holding `seed`, each item wearing the workflow's `admit` labels
 * unless it says otherwise, and a harness per item over the same world —
 * one converge being one tick of that item, as the daemon runs it.
 *
 * The docs role's spec page is wired as the hook loader wires an artifact:
 * its observe half as a pre hook, its publish as a post hook.
 */
function world(loaded: { workflow: Workflow; steps: Map<string, Step> }, seed: Array<Partial<ExternalItem>>, answers = ANSWERS) {
  const { workflow, steps } = loaded;
  const state = createExternalState({ items: seed.map((s) => ({ labels: [...(workflow.admit ?? [])], ...s })) });
  const moves: Move[] = [];
  const starts: Array<{ item: string; open: string[] }> = [];
  const runs = new Map<string, Harness>();
  const w = {
    state,
    workflow,
    /** What the world does while a step of `item` runs, beyond what is recorded: a test sets it. */
    during: undefined as During | undefined,

    /**
     * The blockers of `item` not closed as completed, now: off the blocker's
     * own row, or, for one this tracker does not hold, off the relationship.
     */
    open: (item: string): string[] =>
      state.item(item).related.filter((r) => {
        if (r.type !== RELATIONS.blockedBy) return false;
        let closed = r.closed ?? null;
        try {
          closed = state.item(r.to).closed;
        } catch {
          // Somebody else's: the relationship is all there is to read.
        }
        return closed !== "done";
      }).map((r) => r.to),

    run: (item: string): Harness => {
      const known = runs.get(item);
      if (known) return known;
      const made = createHarness({
        workflow, steps, item, answers, source: state.source,
        pre: [state.pre, artifactPreHook(state.spec)], post: [state.post, state.spec], artifacts: [state.spec],
        // Where a step on a branch starts: the head of its open pull request, there being no repository here.
        startedAt: (branch) => {
          const pull = pullOf(state, branch.replace(/^landrace\//, ""));
          return pull && pull.closed === null ? pull.headSha : null;
        },
        log: (name, data = {}) => {
          if (name === "item.evaluated" && typeof data.to === "string") {
            moves.push({ item, to: data.to, why: typeof data.why === "string" ? data.why : null });
          }
        },
        during: async ({ stage, round }) => {
          if (stage === "build") starts.push({ item, open: w.open(item) });
          await w.during?.({ item, stage, round });
        },
      });
      runs.set(item, made);
      return made;
    },

    /** The trigger that last took `item` to `stage`. */
    why: (item: string, stage: string): string | null | undefined => moves.filter((m) => m.item === item && m.to === stage).at(-1)?.why,
    /** Every build that began, in order, with the item's blockers that were still not done when it did. */
    starts: () => [...starts],
    builds: (item: string): number => w.run(item).counts().build ?? 0,
    trail: (item: string): string[] => w.run(item).trail(),
    labels: (item: string): string[] => [...state.item(item).labels].sort(),

    /** Its row as `landrace status` and the board draw it: from the listing, its note rendered over the listing's graph. */
    row: async (item: string): Promise<StatusRow & { lane: Lane }> => {
      const graph = await state.source.list(ctx);
      const found = statusRows(workflow, graph.nodes, graph).find((r) => r.item === item);
      if (!found) throw new Error(`no status row for #${item}`);
      return { ...found, lane: laneOf(found, workflow) };
    },

    /**
     * One tick of `item`, and what a person does first where it is their
     * turn: approve the spec, merge the pull request. full-cycle's `done`
     * leaves the item open — on GitHub the merged pull request's `Closes #n`
     * closes it, and the in-memory forge closes nothing — so the person
     * closes it there, as completed.
     */
    tick: async (item: string): Promise<void> => {
      const at = state.stage(item);
      if (at === "spec-human-review") state.say(item, "ship it");
      if (at === "pr-human-review") {
        const pull = pullOf(state, item);
        if (pull) Object.assign(pull, { merged: true, closed: "done" });
      }
      await w.run(item).converge();
      if (state.stage(item) === "done" && state.item(item).closed === null) state.item(item).closed = "done";
    },

    /** A fresh item, ticked to where its blockers are first read and past it: its spec approved first, where it has one. */
    start: async (item: string): Promise<void> => {
      await w.tick(item);
      if (state.stage(item) === "spec-human-review") await w.tick(item);
    },

    /** Ticked until it is closed, or a tick moves it nowhere. */
    settle: async (item: string): Promise<void> => {
      for (let i = 0; i < 8 && state.item(item).closed === null; i++) {
        const before = `${state.stage(item)} ${w.trail(item).length}`;
        await w.tick(item);
        if (`${state.stage(item)} ${w.trail(item).length}` === before) return;
      }
    },
  };
  return w;
}

const sorted = (labels: string[]): string[] => [...labels].sort();

describe.each([FULL, FAST])("$id, an item blocked by another", (flow) => {
  const admitted = (...more: string[]): string[] => sorted([...(flow.loaded().workflow.admit ?? []), ...more]);

  it("1. waits while its blocker is open, saying which, and builds once it is closed as completed", async () => {
    const w = world(flow.loaded(), [{ id: "10", title: "Schema", labels: [] }, { id: "12", title: "API", related: blockedBy("10") }]);

    await w.start("12");
    // More ticks, as the daemon would run them: nothing moves while #10 is open.
    await w.tick("12");
    await w.tick("12");

    expect(w.trail("12")).toEqual([...flow.before, "waiting"]);
    expect(w.why("12", "waiting")).toBe(flow.waits);
    expect(w.builds("12")).toBe(0);
    expect(w.labels("12")).toEqual(admitted("lr:stage:waiting"));
    expect(await w.row("12")).toMatchObject({ stage: "waiting", note: "waiting on #10", engineNote: "queued", lane: "waiting" });

    w.state.item("10").closed = "done";
    await w.settle("12");

    expect(w.trail("12")).toEqual([...flow.before, "waiting", ...flow.road]);
    expect(w.why("12", "build")).toBe(BLOCKERS_DONE);
    expect(w.starts()).toEqual([{ item: "12", open: [] }]);
    expect(w.state.item("12").closed).toBe("done");
    expect(w.labels("12")).toEqual(admitted("lr:stage:done"));
  });

  // Decision 4: any item the tracker relates, landrace's or not, here or in
  // another repository. One it does not hold is named by its relationship
  // alone, and is done when that says so.
  it("1. waits the same way on a blocker the tracker does not hold, and builds once its relationship says it is done", async () => {
    const elsewhere = { type: RELATIONS.blockedBy, to: "x-upstream-7", title: "Upstream fix" };
    const w = world(flow.loaded(), [{ id: "12", related: [elsewhere] }]);

    await w.start("12");
    await w.tick("12");
    expect(w.trail("12")).toEqual([...flow.before, "waiting"]);
    expect(w.builds("12")).toBe(0);
    expect(w.labels("12")).toEqual(admitted("lr:stage:waiting"));
    expect(await w.row("12")).toMatchObject({ stage: "waiting", note: "waiting on #x-upstream-7", lane: "waiting" });

    const [relation] = w.state.item("12").related;
    if (!relation) throw new Error("#12 lost its relationship");
    relation.closed = "done";
    await w.settle("12");

    expect(w.trail("12")).toEqual([...flow.before, "waiting", ...flow.road]);
    expect(w.starts()).toEqual([{ item: "12", open: [] }]);
    expect(w.state.item("12").closed).toBe("done");
  });

  it("2. goes to a person when the blocker it waits on is closed as not planned", async () => {
    const w = world(flow.loaded(), [{ id: "10", labels: [] }, { id: "12", related: blockedBy("10") }]);
    await w.start("12");
    expect(w.trail("12")).toEqual([...flow.before, "waiting"]);

    w.state.item("10").closed = "dropped";
    await w.tick("12");
    await w.tick("12");

    expect(w.trail("12")).toEqual([...flow.before, "waiting", flow.person.stage]);
    expect(w.why("12", flow.person.stage)).toBe(REASONS.dropped);
    expect(w.builds("12")).toBe(0);
    expect(w.labels("12")).toEqual(admitted(...flow.person.labels));
    expect(await w.row("12")).toMatchObject({ stage: flow.person.stage, note: flow.person.note, lane: "needs-you" });
  });

  it("2. goes to a person, never to waiting, when its blocker was closed as not planned before the gate", async () => {
    const w = world(flow.loaded(), [{ id: "10", labels: [], closed: "dropped" }, { id: "12", related: blockedBy("10") }]);
    await w.start("12");
    await w.tick("12");

    expect(w.trail("12")).toEqual([...flow.before, flow.person.stage]);
    expect(w.why("12", flow.person.stage)).toBe(flow.needsYou(REASONS.dropped));
    expect(w.builds("12")).toBe(0);
    expect(w.labels("12")).toEqual(admitted(...flow.person.labels));
    expect(await w.row("12")).toMatchObject({ stage: flow.person.stage, note: flow.person.note, lane: "needs-you" });
  });

  it("3. sends both items of a cycle to a person, and builds neither", async () => {
    const w = world(flow.loaded(), [{ id: "12", related: blockedBy("13") }, { id: "13", related: blockedBy("12") }]);
    await w.start("12");
    await w.start("13");
    await w.tick("12");
    await w.tick("13");

    for (const id of ["12", "13"]) {
      expect(w.trail(id)).toEqual([...flow.before, flow.person.stage]);
      expect(w.why(id, flow.person.stage)).toBe(flow.needsYou(REASONS.cycle));
      expect(w.builds(id)).toBe(0);
      expect(w.labels(id)).toEqual(admitted(...flow.person.labels));
      expect(await w.row(id)).toMatchObject({ stage: flow.person.stage, note: flow.person.note, lane: "needs-you" });
    }
    expect(w.starts()).toEqual([]);
  });

  it("4. goes to a person when its blockers cannot all be read, though the one it can read is open", async () => {
    const w = world(flow.loaded(), [{ id: "10", labels: [] }, { id: "12", related: blockedBy("10"), relatedComplete: false }]);
    await w.start("12");
    await w.tick("12");

    expect(w.trail("12")).toEqual([...flow.before, flow.person.stage]);
    expect(w.why("12", flow.person.stage)).toBe(flow.needsYou(REASONS.unreadable));
    expect(w.builds("12")).toBe(0);
    expect(w.labels("12")).toEqual(admitted(...flow.person.labels));
    expect(await w.row("12")).toMatchObject({ stage: flow.person.stage, note: flow.person.note, lane: "needs-you" });
  });

  // The tracker said which item it waits on, but not what state it is in.
  it("4. goes to a person when a blocker it knows cannot be read, never reading it as open or done", async () => {
    const unseen = { type: RELATIONS.blockedBy, to: "x-upstream-7", title: "Upstream fix", closed: "done" as const, unreadable: true as const };
    const w = world(flow.loaded(), [{ id: "12", related: [unseen] }]);
    await w.start("12");
    await w.tick("12");

    expect(w.trail("12")).toEqual([...flow.before, flow.person.stage]);
    expect(w.why("12", flow.person.stage)).toBe(flow.needsYou(REASONS.unreadable));
    expect(w.builds("12")).toBe(0);
    const listed = await w.state.source.list(ctx);
    expect(listed.nodes.find((n) => n.id === "x-upstream-7")).toMatchObject({ closed: null, unreadable: true });
  });

  it("5. starts three items nothing relates at once, and none of them waits", async () => {
    const w = world(flow.loaded(), []);
    const admit = [...(w.workflow.admit ?? [])];
    const ids: string[] = [];
    for (const title of ["Export", "Import", "Search"]) ids.push((await w.state.operator.createItem({ title, labels: admit }, ctx)).id);

    // Each build holds until every one has begun, or a second has passed:
    // three builds in flight together is what none of them waiting means.
    let begun = 0;
    let together = (): void => {};
    const all = new Promise<void>((resolve) => { together = resolve; });
    w.during = async ({ stage }) => {
      if (stage !== "build") return;
      if (++begun === ids.length) together();
      await within(all, 1000);
    };
    await Promise.all(ids.map((id) => w.start(id)));

    expect(begun).toBe(3);
    expect(w.starts().map((s) => s.item).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      expect(w.trail(id).slice(0, flow.before.length + 1)).toEqual([...flow.before, "build"]);
      expect(w.why(id, "build")).toBe(flow.frees);
      expect(w.why(id, "waiting")).toBeUndefined();
    }
  });

  it("5. runs a chain of three strictly in order: each builds only once the one before it is closed as completed", async () => {
    const w = world(flow.loaded(), []);
    const admit = [...(w.workflow.admit ?? [])];
    const create = async (title: string, after?: string): Promise<string> =>
      (await w.state.operator.createItem({ title, labels: admit, ...(after ? { relate: [{ type: RELATIONS.blockedBy, item: after }] } : {}) }, ctx)).id;
    const a = await create("Schema");
    const b = await create("API", a);
    const c = await create("UI", b);
    const chain = [a, b, c];

    // Tick by tick, the last of the chain first, so going first earns nothing.
    const notes = new Map<string, StatusRow & { lane: Lane }>();
    for (let round = 0; round < 12 && chain.some((id) => w.state.item(id).closed === null); round++) {
      for (const id of [c, b, a]) {
        if (w.state.item(id).closed !== null) continue;
        await w.tick(id);
        if (w.state.stage(id) === "waiting" && !notes.has(id)) notes.set(id, await w.row(id));
      }
    }

    expect(chain.map((id) => w.state.item(id).closed)).toEqual(["done", "done", "done"]);
    expect(w.starts()).toEqual([{ item: a, open: [] }, { item: b, open: [] }, { item: c, open: [] }]);
    expect(w.trail(a)).toEqual([...flow.before, ...flow.road]);
    for (const [id, before] of [[b, a], [c, b]] as const) {
      expect(w.trail(id)).toEqual([...flow.before, "waiting", ...flow.road]);
      expect(w.why(id, "build")).toBe(BLOCKERS_DONE);
      expect(notes.get(id)).toMatchObject({ stage: "waiting", note: `waiting on #${before}`, lane: "waiting" });
    }
    for (const id of chain) expect(w.builds(id)).toBe(1);
  });

  it("7. goes on when its blocker is reopened after the gate, and never waits again", async () => {
    const w = world(flow.loaded(), [{ id: "10", labels: [] }, { id: "12", related: blockedBy("10") }]);
    await w.start("12");
    expect(w.trail("12")).toEqual([...flow.before, "waiting"]);

    w.state.item("10").closed = "done";
    // Reopened while #12 builds: it passed the gate once, and that is the gate passed.
    w.during = ({ item, stage }) => {
      if (item === "12" && stage === "build") w.state.item("10").closed = null;
    };
    await w.tick("12");

    expect(w.state.item("10").closed).toBeNull();
    expect((await w.row("12")).note).not.toContain("#10");
    await w.settle("12");

    expect(w.trail("12")).toEqual([...flow.before, "waiting", ...flow.road]);
    expect(w.starts()).toEqual([{ item: "12", open: [] }]);
    expect(w.builds("12")).toBe(1);
    expect(w.state.item("12").closed).toBe("done");
    expect(w.labels("12")).toEqual(admitted("lr:stage:done"));
  });
});

describe("6. full-cycle, an item blocked by another", () => {
  it("writes and approves its spec while the blocker is open, and waits only between the approval and build", async () => {
    const w = world(FULL.loaded(), [{ id: "10", labels: [] }, { id: "12", related: blockedBy("10") }]);

    await w.tick("12");
    expect(w.trail("12")).toEqual(["spec", "spec-human-review"]);
    expect(w.run("12").counts()).toEqual({ spec: 1 });
    expect(w.labels("12")).toEqual(sorted(["lr:auto", "lr:awaiting", "lr:stage:spec-human-review"]));
    expect(await w.row("12")).toMatchObject({ stage: "spec-human-review", note: "waiting on you", lane: "needs-you" });

    await w.tick("12");   // the person approves the spec
    await w.tick("12");
    expect(w.trail("12")).toEqual(["spec", "spec-human-review", "triage", "waiting"]);
    expect(w.why("12", "waiting")).toBe(FULL.waits);
    expect(w.run("12").counts()).toEqual({ spec: 1, triage: 1 });
    expect(w.labels("12")).toEqual(sorted(["lr:auto", "lr:stage:waiting"]));
    expect(await w.row("12")).toMatchObject({ stage: "waiting", note: "waiting on #10", lane: "waiting" });
    expect(w.state.item("10").closed).toBeNull();

    w.state.item("10").closed = "done";
    await w.tick("12");
    expect(w.trail("12")).toEqual(["spec", "spec-human-review", "triage", "waiting", "build", "publish", "code-review", "pr-human-review"]);
    expect(w.run("12").counts()).toEqual({ spec: 1, triage: 1, build: 1, "code-review": 1 });
    expect(w.starts()).toEqual([{ item: "12", open: [] }]);
  });
});

/*
 * Decision 9: the gate is passed once. A change a person asks for on the
 * pull request amends the spec and goes back to build — whatever the item's
 * blockers say by then.
 */
describe("7. full-cycle, a spec amended on the pull request", () => {
  it("goes back to build while a blocker reopened since is open, and never waits", async () => {
    const answers: Record<string, ScriptedAnswer> = { ...ANSWERS, triage: (round) => json({ intent: round === 1 ? "approve" : "revise" }) };
    const w = world(FULL.loaded(), [{ id: "10", labels: [], closed: "done" }, { id: "12", related: blockedBy("10") }], answers);
    await w.start("12");
    expect(w.trail("12")).toEqual(["spec", "spec-human-review", "triage", "build", "publish", "code-review", "pr-human-review"]);

    // #10 reopens while the pull request waits on the person, who asks for a change.
    w.state.item("10").closed = null;
    w.state.say("12", "Use the new endpoint instead.");
    await w.run("12").converge();

    expect(w.trail("12").slice(7, 10)).toEqual(["triage", "spec", "build"]);
    expect(w.why("12", "build")).toBe("you amended the spec on the pull request");
    expect(w.why("12", "waiting")).toBeUndefined();
    expect(w.builds("12")).toBe(2);
    expect(w.starts()).toEqual([{ item: "12", open: [] }, { item: "12", open: ["10"] }]);
  });
});

/*
 * A breakdown that orders what it splits the work into: the second child is
 * created blocked by the first, through `relate` on the child tool, as the
 * breakdown's agent would call it. tests/fixtures/children starts every
 * child at build the moment its parent waits on them, so this drives a copy
 * of it whose children meet the gate the shipped workflows have.
 */
describe("8. a breakdown that orders its children", () => {
  const ORDERED = "tests/fixtures/ordered-children";

  const split = async () => {
    const loaded = await loadWorkflow(ORDERED);
    const w = world(loaded, [{ id: "1", title: "Payments revamp", body: "big" }]);
    const kids: string[] = [];
    w.during = async ({ item, stage, round }) => {
      if (stage === "breakdown") {
        const bind = { parent: "1", stage: "breakdown", round };
        const api = await createChild(w.state.operator, bind, { title: "API" }, ctx, w.workflow.admit);
        const ui = await createChild(w.state.operator, bind, { title: "UI", relate: [{ type: RELATIONS.blockedBy, item: api.id }] }, ctx, w.workflow.admit);
        kids.push(api.id, ui.id);
      }
      // This fixture's build pushes and opens its own pull request: the step does it, here.
      if (stage === "build") w.state.openPull(item);
    };
    await w.tick("1");                                   // spec → spec-human-review
    await w.tick("1");                                   // approved → triage → breakdown → children-running
    expect(w.trail("1")).toEqual(["spec", "spec-human-review", "triage", "breakdown", "children-running"]);
    const [api, ui] = kids;
    if (api === undefined || ui === undefined) throw new Error("the breakdown created no children");
    return { w, api, ui };
  };

  it("is a workflow validate passes, over the in-memory hooks", async () => {
    const { workflow, steps } = await loadWorkflow(ORDERED);
    const state = createExternalState();
    expect(validate(workflow, steps, snapshotProvides([state.pre, artifactPreHook(state.spec)], state.source) ?? undefined)).toEqual([]);
  });

  it("builds the child blocked by its sibling only once the sibling is closed as completed, and finishes the parent after both", async () => {
    const { w, api, ui } = await split();
    expect(w.state.item(ui).related).toEqual([{ type: RELATIONS.blockedBy, to: api }]);

    const notes = new Map<string, StatusRow & { lane: Lane }>();
    for (let round = 0; round < 8 && [api, ui].some((id) => w.state.item(id).closed === null); round++) {
      for (const id of [ui, api]) {
        if (w.state.item(id).closed !== null) continue;
        await w.tick(id);
        if (w.state.stage(id) === "waiting" && !notes.has(id)) {
          notes.set(id, await w.row(id));
          expect(w.labels(id)).toEqual(sorted(["lr:auto", "lr:stage:waiting"]));
          expect(w.builds(id)).toBe(0);
        }
      }
    }

    expect(w.trail(api)).toEqual(["build", "code-review", "pr-human-review", "done"]);
    expect(w.trail(ui)).toEqual(["waiting", "build", "code-review", "pr-human-review", "done"]);
    expect(w.why(ui, "build")).toBe(BLOCKERS_DONE);
    expect(notes.get(ui)).toMatchObject({ stage: "waiting", note: `waiting on #${api}`, lane: "waiting" });
    expect(notes.has(api)).toBe(false);
    expect(w.starts()).toEqual([{ item: api, open: [] }, { item: ui, open: [] }]);
    expect([api, ui].map((id) => w.state.item(id).closed)).toEqual(["done", "done"]);

    await w.tick("1");
    expect(w.trail("1").at(-1)).toBe("done");
    expect(w.state.item("1").closed).toBe("done");
  });

  it("sends a child whose sibling was closed as not planned to a person, and builds it never", async () => {
    const { w, api, ui } = await split();
    await w.tick(ui);
    expect(w.trail(ui)).toEqual(["waiting"]);

    w.state.item(api).closed = "dropped";
    await w.tick(ui);

    expect(w.trail(ui)).toEqual(["waiting", "stuck"]);
    expect(w.why(ui, "stuck")).toBe(REASONS.dropped);
    expect(w.builds(ui)).toBe(0);
    expect(w.labels(ui)).toEqual(sorted(["lr:auto", "lr:blocked", "lr:stage:stuck"]));
    expect(await w.row(ui)).toMatchObject({ stage: "stuck", note: BLOCKED_NOTE, lane: "needs-you" });
  });
});
