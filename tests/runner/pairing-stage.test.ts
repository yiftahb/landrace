import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseMarker } from "#conventions.js";
import type { Executor, ExternalState, Harness, PairDeps, RuntimeContext, Step, Workflow } from "#namespace.js";
import { createDispatcher } from "#runner/effects.js";
import { sendTo } from "#runner/goto.js";
import { finishPair, releasePair, startPair } from "#runner/pair.js";
import { buildSnapshot } from "#runner/snapshot.js";
import { laneOf, statusRows } from "#runner/status.js";
import { createExternalState, createHarness } from "#testing/index.js";
import { gitRepo, removeRepos } from "#tests/support/repo.js";
import { loadWorkflow } from "#workflow/load.js";
import { validate } from "#workflow/validate.js";

/*
 * #140: a stage that waits for a pairing runs its step only with a person.
 * Every way into it — a route, a goto, a released pairing — leaves the item
 * waiting there in Needs you, and no tick hands the step to the agent.
 * Driven through the in-memory tracker, so the converge, the goto and the
 * pairing are the engine's own.
 */

// Real git worktrees for the pairing: see tests/runner/pair.test.ts.
jest.setTimeout(60_000);

const TRIAGED = 'Triaged.\n\n```json\n{"kind":"triaged"}\n```';
const DESIGNED = 'Designed.\n\n```json\n{"kind":"designed"}\n```';

let loaded: { workflow: Workflow; steps: Map<string, Step> };
beforeAll(async () => {
  loaded = await loadWorkflow("tests/fixtures/pairing");
});
afterAll(removeRepos);

const ctx: RuntimeContext = { config: {} as RuntimeContext["config"], secrets: new Map(), signal: new AbortController().signal, log: () => {} };

/** A person's session: handed over to start a pairing, forked for the hand-in. */
const person: Executor = {
  id: "person",
  run: async () => ({ text: DESIGNED, sessionId: "sid-fork" }),
  handoff: async (o) => ({ argv: ["agent", "--session-id", o.session, { file: o.promptFile }], cwd: o.cwd }),
};

/** An item converged to the stage that waits for a pairing, by its route from triage. */
async function atDesign(): Promise<{ state: ExternalState; run: Harness; deps: PairDeps }> {
  const state = createExternalState({ items: [{ id: "1", title: "Pick a vendor", labels: ["lr:auto"] }] });
  const { workflow, steps } = loaded;
  const run = createHarness({ workflow, steps, source: state.source, pre: [state.pre], post: [state.post], answers: { triage: TRIAGED } });
  await run.converge();
  expect(state.stage("1")).toBe("design");
  const deps: PairDeps = {
    source: state.source, pre: [state.pre], dispatcher: createDispatcher([state.post]), ctx, workflow, steps,
    executor: person, sandbox: { root: await gitRepo() }, lock: { root: await mkdtemp(join(tmpdir(), "lr-pairing-stage-")) },
  };
  return { state, run, deps };
}

const snapshotOf = (deps: PairDeps) =>
  buildSnapshot({ item: "1", source: deps.source, hooks: deps.pre, workflow: deps.workflow, ctx: { ...deps.ctx, item: "1" } });

async function rowOf(state: ExternalState) {
  const node = (await state.source.list(ctx)).nodes.find((n) => n.id === "1");
  if (!node) throw new Error("item 1 is not listed");
  const [row] = statusRows(loaded.workflow, [node]);
  if (!row) throw new Error("item 1 has no status row");
  return { stage: row.stage, note: row.note, lane: laneOf(row, loaded.workflow) };
}

describe("a stage that waits for a pairing", () => {
  it("validates clean", () => {
    expect(validate(loaded.workflow, loaded.steps)).toEqual([]);
  });

  it("holds an item that reaches it in Needs you, and runs no agent over several ticks", async () => {
    const { state, run } = await atDesign();
    for (let tick = 0; tick < 3; tick++) {
      const { result } = await run.converge();
      expect(result.why).toMatch(/"design" is worked only with a person/);
    }

    expect(run.counts()).toEqual({ triage: 1 });
    expect(state.stage("1")).toBe("design");
    expect(await rowOf(state)).toEqual({ stage: "design", note: "waiting on you", lane: "needs-you" });
  });

  it("a goto out of it while its round is owed says to pair, never to wait for an answer", async () => {
    const { deps } = await atDesign();
    const answer = await sendTo(deps, "1", "review");
    expect(answer).toEqual({
      refused: expect.stringMatching(/"design" is worked only with a person: pair on it and finish the pairing first/),
    });
    // Neither moves it: a release leaves the round owed, and decide waits before it reads a route out.
    expect(answer).not.toEqual({ refused: expect.stringMatching(/wait for its answer|release|route out/) });
  });

  it("leaves the item waiting there once a pairing is released", async () => {
    const { state, run, deps } = await atDesign();
    await startPair(deps, "1", "design");
    const paired = state.comments("1").find((c) => parseMarker(c)?.kind === "pair");
    expect(paired).toMatch(/a release leaves the item waiting at design for the next pairing/);
    expect(paired).not.toMatch(/runs alone again/);
    expect(await releasePair(deps, "1")).toEqual({ stage: "design", round: 1, next: "pairing" });
    const released = state.comments("1").find((c) => parseMarker(c)?.kind === "release");
    expect(released).toMatch(/waits at design for the next pairing/);

    await run.converge();
    await run.converge();

    expect(run.counts()).toEqual({ triage: 1 });
    expect(state.stage("1")).toBe("design");
    expect(await rowOf(state)).toMatchObject({ lane: "needs-you" });
  });

  it("finishing a pairing routes on its answer, recorded as the pair's", async () => {
    const { state, run, deps } = await atDesign();
    await startPair(deps, "1", "design");
    await finishPair(deps, "1", "");
    expect((await snapshotOf(deps)).run).toMatchObject({ lastOutputBy: "pair", pairing: null });

    await run.converge();

    expect(state.stage("1")).toBe("review");
    expect(run.counts()).toEqual({ triage: 1 });
  });

  it("a goto into it leaves the item waiting there, and runs no agent", async () => {
    const { state, run, deps } = await atDesign();
    await startPair(deps, "1", "design");
    await finishPair(deps, "1", "");
    await run.converge();
    expect(state.stage("1")).toBe("review");

    expect(await sendTo(deps, "1", "design")).toEqual({ to: "design" });
    await run.converge();
    await run.converge();

    expect(state.stage("1")).toBe("design");
    expect((await snapshotOf(deps)).run?.rounds["design"]).toMatchObject({ entered: 2 });
    expect(run.counts()).toEqual({ triage: 1 });
    expect(await rowOf(state)).toMatchObject({ stage: "design", lane: "needs-you" });
  });
});
