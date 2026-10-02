import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EffectRefused, MALFORMED_KIND } from "#conventions.js";
import { createDispatcher } from "#runner/effects.js";
import { sendTo } from "#runner/goto.js";
import { createExternalState, createHarness } from "#testing/index.js";
import type { Effect, ExternalState, GotoDeps, PostHook, RuntimeContext, Workflow } from "#namespace.js";

/*
 * An effect refused while an item enters a stage — a merge the forge will
 * not make, a pull request it will not open — is the stage's rejected round:
 * recorded on the item with the refusal's sentence, read where the item
 * still stands, and routed to the workflow's halt by the trigger a broken
 * output takes. Never asked again on its own; a person's Retry asks once.
 * What failed on the way — an outage — is left to the next tick.
 */
const ENTER = { type: "tracker.comment", kind: "enter", marker: "enter:{stage}:{round}", body: "Entering {stage}, round {round}." };

const flow = (merge: Effect[] = [ENTER, { type: "pull.merge", branch: "landrace/{item}" }, { type: "tracker.status", value: "merge" }]): Workflow => ({
  version: 1, name: "t", description: "test",
  stages: [
    { id: "ready", entry: true, triggers: [{ when: { "run.stage": null } }], on_enter: [{ type: "tracker.status", value: "ready" }] },
    {
      id: "merge",
      triggers: [{ name: "green", when: { "run.stage": "ready", "run.lastOutputValid": null, "rel.implements.in.total": { $gt: 0 } } }],
      on_enter: merge,
    },
    {
      id: "done", terminal: true,
      triggers: [{ when: { "run.stage": "merge", "run.lastOutputValid": null, "rel.implements.in.not.merged": 0 } }],
      on_enter: [{ type: "tracker.status", value: "done" }],
    },
    {
      id: "blocked",
      goto: [{ stage: "merge", when: { "run.counters.merge": { $lt: 3 } } }],
      triggers: [{ name: "broke", when: { "run.lastOutputValid": false, "run.lastRefused": false } }],
      on_enter: [{ type: "tracker.status", value: "blocked" }, { type: "tracker.label", add: ["lr:blocked"] }],
    },
  ],
});

const ctx: RuntimeContext = { config: {} as RuntimeContext["config"], secrets: new Map(), signal: new AbortController().signal, log: () => {} };

/** The composed hooks, counting every merge asked of the forge, and refusing whatever `refuse` says. */
const counted = (state: ExternalState, refuse: (e: Effect) => string | null = () => null) => {
  const asked: string[] = [];
  const post: PostHook = {
    id: state.post.id,
    handles: state.post.handles,
    satisfied: (s, e) => state.post.satisfied(s, e),
    apply: async (e, c) => {
      asked.push(e.type);
      const why = refuse(e);
      if (why !== null) throw new EffectRefused(why);
      return state.post.apply(e, c);
    },
  };
  return { post, merges: () => asked.filter((t) => t === "pull.merge").length };
};

const at = (labels: string[] = ["lr:stage:ready"]) => createExternalState({ items: [{ id: "1", labels }] });
const rejections = (state: ExternalState) => state.entriesOf("1").filter((e) => e.kind === MALFORMED_KIND);

const harness = (state: ExternalState, post: PostHook, workflow = flow()) =>
  createHarness({ workflow, steps: new Map(), source: state.source, pre: [state.pre], post: [post] });

describe("a merge the forge refuses on the way into the stage", () => {
  it("is the stage's rejected round, with the refusal's sentence, and the item lands in the halt", async () => {
    const state = at();
    state.openPull("1", { branch: "landrace/1", checks: "success", mergeable: false });
    const { post } = counted(state);
    const r = await harness(state, post).converge();

    expect(r.result.settled).toBe("wait");
    expect(state.stage("1")).toBe("blocked");
    expect(state.item("1").labels).toContain("lr:blocked");
    expect(state.pull("pr-1")).toMatchObject({ merged: false, closed: null });
    expect(rejections(state)).toEqual([expect.objectContaining({ stage: "merge", round: 1, from: "ready" })]);
    const said = state.comments("1").find((c) => c.includes("cannot be merged"));
    expect(said).toContain("pr-1 for #1 cannot be merged: the forge finds it not mergeable");
  });

  it("is not asked of the forge again on the next tick", async () => {
    const state = at();
    state.openPull("1", { branch: "landrace/1", checks: "success", mergeable: false });
    const { post, merges } = counted(state);
    const run = harness(state, post);
    await run.converge();
    const second = await run.converge();

    expect(merges()).toBe(1);
    expect(second.result.settled).toBe("wait");
    expect(rejections(state)).toHaveLength(1);
  });

  it("is asked once more by a person's Retry, which merges once the forge allows it", async () => {
    const state = at();
    state.openPull("1", { branch: "landrace/1", checks: "success", mergeable: false });
    const { post, merges } = counted(state);
    const run = harness(state, post);
    await run.converge();

    delete state.pull("pr-1").mergeable;
    const deps: GotoDeps = {
      source: state.source, pre: [state.pre], dispatcher: createDispatcher([post]), ctx, workflow: flow(),
      lock: { root: await mkdtemp(join(tmpdir(), "lr-refused-")) },
    };
    expect(await sendTo(deps, "1", null)).toEqual({ to: "merge" });
    const r = await run.converge();

    expect(merges()).toBe(2);
    expect(r.result.settled).toBe("terminal");
    expect(state.stage("1")).toBe("done");
    expect(state.pull("pr-1").merged).toBe(true);
  });

  it("is recorded again when the Retry is refused too, and the item stays in the halt", async () => {
    const state = at();
    state.openPull("1", { branch: "landrace/1", checks: "success", mergeable: false });
    const { post, merges } = counted(state);
    const run = harness(state, post);
    await run.converge();

    const deps: GotoDeps = {
      source: state.source, pre: [state.pre], dispatcher: createDispatcher([post]), ctx, workflow: flow(),
      lock: { root: await mkdtemp(join(tmpdir(), "lr-refused-")) },
    };
    await sendTo(deps, "1", null);
    const r = await run.converge();
    await run.converge();

    expect(merges()).toBe(2);
    expect(r.result.settled).toBe("wait");
    expect(state.stage("1")).toBe("blocked");
    expect(rejections(state)).toEqual([
      expect.objectContaining({ stage: "merge", round: 1, from: "ready" }),
      expect.objectContaining({ stage: "merge", round: 2, from: "blocked" }),
    ]);
  });
});

describe("a person's Retries, each refused", () => {
  /*
   * At the halt a refused Retry is read as a failure where the item stands,
   * so a second one would be the halt's own way out failing again — but it
   * is a person's goto, and each one is recorded: Retry then finds the stage
   * that refused, until its cap declines it in a sentence.
   */
  it("records every one, so Retry always finds what refused, until the cap declines it", async () => {
    const state = at();
    state.openPull("1", { branch: "landrace/1", checks: "success", mergeable: false });
    const { post, merges } = counted(state);
    const run = harness(state, post);
    await run.converge();
    const deps: GotoDeps = {
      source: state.source, pre: [state.pre], dispatcher: createDispatcher([post]), ctx, workflow: flow(),
      lock: { root: await mkdtemp(join(tmpdir(), "lr-refused-")) },
    };

    expect(await sendTo(deps, "1", null)).toEqual({ to: "merge" });
    await run.converge();
    expect(await sendTo(deps, "1", null)).toEqual({ to: "merge" });
    await run.converge();

    expect(merges()).toBe(3);
    expect(rejections(state)).toEqual([
      expect.objectContaining({ stage: "merge", round: 1, from: "ready" }),
      expect.objectContaining({ stage: "merge", round: 2, from: "blocked" }),
      expect.objectContaining({ stage: "merge", round: 3, from: "blocked" }),
    ]);
    expect(state.stage("1")).toBe("blocked");
    expect(await sendTo(deps, "1", null)).toEqual({ refused: expect.stringMatching(/"blocked" sends an item to "merge" only while/) });
  });
});

describe("what is left as it was", () => {
  it("leaves an outage unrecorded, and the next tick merges", async () => {
    const state = at();
    state.openPull("1", { branch: "landrace/1", checks: "success" });
    let down = true;
    const { post } = counted(state);
    const flaky: PostHook = { ...post, apply: async (e, c) => {
      if (e.type === "pull.merge" && down) throw new Error("502 Bad Gateway");
      return post.apply(e, c);
    } };
    const run = harness(state, flaky);
    const first = await run.converge();

    expect(first.result).toMatchObject({ settled: "halt", why: expect.stringContaining("502 Bad Gateway") });
    expect(state.stage("1")).toBe("ready");
    expect(rejections(state)).toEqual([]);

    down = false;
    expect((await run.converge()).result.settled).toBe("terminal");
    expect(state.pull("pr-1").merged).toBe(true);
  });

  it("leaves a refusal unrecorded where the stage records no entry, as there is nothing to read it back by", async () => {
    const state = at();
    state.openPull("1", { branch: "landrace/1", checks: "success", mergeable: false });
    const { post } = counted(state);
    const r = await harness(state, post, flow([{ type: "pull.merge", branch: "landrace/{item}" }, { type: "tracker.status", value: "merge" }])).converge();

    expect(r.result.settled).toBe("halt");
    expect(state.stage("1")).toBe("ready");
    expect(rejections(state)).toEqual([]);
  });

  it("leaves a refusal unrecorded where it came before the stage's entry record", async () => {
    const state = at();
    state.openPull("1", { branch: "landrace/1", checks: "success", mergeable: false });
    const { post } = counted(state);
    const late = flow([{ type: "pull.merge", branch: "landrace/{item}" }, ENTER, { type: "tracker.status", value: "merge" }]);
    const r = await harness(state, post, late).converge();

    expect(r.result.settled).toBe("halt");
    expect(rejections(state)).toEqual([]);
  });

  /*
   * The entry record itself refused — the tracker would not take the
   * comment — is a stage nothing entered: there is no record to read a
   * rejection beside, so none is written.
   */
  it("leaves a refusal of the entry record itself unrecorded", async () => {
    const state = at();
    state.openPull("1", { branch: "landrace/1", checks: "success" });
    const { post, merges } = counted(state, (e) => (e.type === "tracker.comment" && e.kind === "enter" ? "the tracker refused the comment" : null));
    const r = await harness(state, post).converge();

    expect(r.result).toMatchObject({ settled: "halt", why: expect.stringContaining("refused the comment") });
    expect(merges()).toBe(0);
    expect(rejections(state)).toEqual([]);
    expect(state.stage("1")).toBe("ready");
  });

  it("leaves a refusal unrecorded for an item with no position yet", async () => {
    const state = at([]);
    const { post } = counted(state, (e) => (e.type === "tracker.status" ? "the tracker refused the label" : null));
    const entering = flow();
    const [ready] = entering.stages;
    if (ready) ready.on_enter = [ENTER, { type: "tracker.status", value: "ready" }];
    const r = await harness(state, post, entering).converge();

    expect(r.result.settled).toBe("halt");
    expect(rejections(state)).toEqual([]);
  });

  /*
   * The halt is entered because the item's last verdict failed; a refusal
   * on that way in, recorded too, would be read as the same failure and
   * send it to the halt again — a record on every pass.
   */
  it("records once, not again for a halt refused on its way in", async () => {
    const state = at();
    state.openPull("1", { branch: "landrace/1", checks: "success", mergeable: false });
    const { post } = counted(state, (e) => (e.type === "tracker.label" ? "the tracker refused the label" : null));
    const halting = flow();
    const blocked = halting.stages.find((s) => s.id === "blocked");
    if (blocked) blocked.on_enter = [ENTER, { type: "tracker.label", add: ["lr:blocked"] }, { type: "tracker.status", value: "blocked" }];
    const r = await harness(state, post, halting).converge();

    expect(r.result).toMatchObject({ settled: "halt", why: expect.stringContaining("refused the label") });
    expect(rejections(state)).toEqual([expect.objectContaining({ stage: "merge", round: 1 })]);
  });
});

/*
 * The round a stage with no step is entered at. It settles a round only when
 * its way in is refused, so a visit that went through leaves its round
 * unsettled: a crash between its entry and its position replans that same
 * round, the identical record reconciling away; a later visit is a round of
 * its own, with an entry record the refusal can be read beside.
 */
describe("the round a stage with no step is entered at", () => {
  const enters = (state: ExternalState) => state.entriesOf("1").filter((e) => e.kind === "enter" && e.stage === "merge").map((e) => e.round);

  it("is the same round after a crash between its entry record and its status", async () => {
    const state = at();
    state.openPull("1", { branch: "landrace/1", checks: "success" });
    let alive = true;
    const run = createHarness({
      workflow: flow(), steps: new Map(), source: state.source, pre: [state.pre], post: [state.post],
      interrupt: (e) => {
        if (alive && e.type === "pull.merge") {
          alive = false;
          return true;
        }
        return false;
      },
    });
    await run.converge();
    expect(enters(state)).toEqual([1]);
    expect(state.stage("1")).toBe("ready");

    expect((await run.converge()).result.settled).toBe("terminal");
    expect(enters(state)).toEqual([1]);
  });

  it("is a new round on a later visit, so a refusal then is read and the forge asked once", async () => {
    const state = at();
    state.openPull("1", { branch: "landrace/1", checks: "success", headSha: "a" });
    const looping: Workflow = {
      ...flow(),
      stages: flow().stages.map((s) => (s.id === "ready"
        ? { ...s, triggers: [...(s.triggers ?? []), { name: "moved", when: { "run.stage": "merge", "run.lastOutputValid": null, "rel.implements.in.not.merged": { $gt: 0 } } }],
          on_enter: [ENTER, { type: "tracker.status", value: "ready" }] }
        : s)),
    };
    let moved = false;
    const { post, merges } = counted(state, (e) => {
      if (e.type !== "pull.merge") return null;
      if (!moved) {
        moved = true;
        state.pull("pr-1").headSha = "b";
        return null;
      }
      return "pr-1 for #1 cannot be merged: the forge finds it not mergeable";
    });
    await harness(state, post, looping).converge();

    expect(enters(state)).toEqual([1, 2]);
    expect(merges()).toBe(2);
    expect(rejections(state)).toEqual([expect.objectContaining({ stage: "merge", round: 2, from: "ready" })]);
    expect(state.stage("1")).toBe("blocked");
  });
});

