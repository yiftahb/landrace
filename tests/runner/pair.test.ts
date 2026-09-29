import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseMarker, renderMarker } from "#conventions.js";
import { decide } from "#core/index.js";
import type { Executor, PairDeps, Source, Step, Workflow } from "#namespace.js";
import { createDispatcher } from "#runner/effects.js";
import { finishPair, pairingView, releasePair, startPair } from "#runner/pair.js";
import { buildSnapshot } from "#runner/snapshot.js";
import { createFakeTracker, type FakeTracker } from "#tests/support/fake-tracker.js";
import { gitRepo, removeRepos, worktreesOf } from "#tests/support/repo.js";

// Real git worktrees, real processes: see tests/mcp/conversation.test.ts.
jest.setTimeout(60_000);

let repo: string;
let lockRoot: string;
beforeEach(async () => {
  repo = await gitRepo();
  lockRoot = await mkdtemp(join(tmpdir(), "lr-pair-"));
});
afterAll(removeRepos);

const ENTER = { type: "tracker.comment", kind: "enter", marker: "enter:{stage}:{round}", body: "Entered {stage}." };
const status = (value: string) => ({ type: "tracker.status", value });

const workflow: Workflow = {
  version: 1, name: "t",
  stages: [
    { id: "spec", step: "spec", entry: true, on_enter: [ENTER, status("spec")], triggers: [{ when: { "run.stage": null } }] },
    {
      id: "review", goto: [{ stage: "spec", when: { "run.counters.spec": { $lt: 3 } } }], on_enter: [status("review")],
      triggers: [{ when: { "run.stage": "spec", "run.lastOutputValid": null, "run.lastOutputBy": "agent" } }],
    },
    {
      id: "build", step: "build", on_enter: [ENTER, status("build")],
      goto: [{ stage: "build", when: { "run.counters.build": { $lt: 3 } } }],
      triggers: [{ when: { "run.stage": "spec", "run.lastOutputValid": null, "run.lastOutputBy": "pair" } }],
    },
    { id: "blocked", goto: ["spec"], on_enter: [status("blocked")], triggers: [{ when: { "run.lastOutputValid": false } }] },
  ],
};

const specStep: Step = {
  prompt: "Write the spec for {node.title}.",
  capabilities: ["repo:read"],
  output: {
    discriminator: "kind",
    shapes: { spec: {} },
    routes: [{ when: { kind: "spec" }, effect: { type: "tracker.comment", marker: "spec:{round}" } }],
  },
};
const buildStep: Step = {
  prompt: "Build it.",
  capabilities: ["repo:read", "repo:write"],
  output: {
    discriminator: "kind",
    shapes: { built: {} },
    routes: [{ when: { kind: "built" }, effect: { type: "tracker.comment", marker: "built:{round}" } }],
  },
};
const steps = new Map<string, Step>([["spec", specStep], ["build", buildStep]]);

const DONE = "The spec.\n\n```json\n{\"kind\":\"spec\"}\n```";
const BUILT = "Built.\n\n```json\n{\"kind\":\"built\"}\n```";

/** An agent that can hand a session over, and remembers what it was asked. */
function agent(answer = DONE) {
  const runs: Array<{ prompt: string; resume?: string; fork?: boolean; cwd?: string }> = [];
  const handoffs: Array<{ cwd: string; session: string; prompt: string; resume?: string }> = [];
  let text = answer;
  const executor: Executor = {
    id: "fake",
    run: async (prompt, o) => {
      runs.push({ prompt, ...(o.resume ? { resume: o.resume } : {}), ...(o.fork ? { fork: o.fork } : {}), ...(o.cwd ? { cwd: o.cwd } : {}) });
      return { text, sessionId: "sid-fork" };
    },
    handoff: async (o) => {
      handoffs.push(o);
      return { argv: ["agent", "--session-id", o.session, o.prompt], cwd: o.cwd };
    },
  };
  return { executor, runs, handoffs, answer: (next: string) => { text = next; } };
}

const screener = (verdict: "ok" | "suspicious"): Executor => ({
  id: "screen",
  run: async () => ({ text: `\`\`\`json\n{"verdict":"${verdict}","reason":"exfiltration"}\n\`\`\``, sessionId: null }),
});

function world(labels: string[], executor: Executor | null, over: Partial<PairDeps> = {}) {
  const tracker = createFakeTracker([{ number: 29, title: "Pairing", labels: ["lr:auto", ...labels] }]);
  const source = tracker.registry.source as Source;
  const deps: PairDeps = {
    source, pre: tracker.registry.pre, dispatcher: createDispatcher(tracker.registry.post), ctx: tracker.ctx,
    workflow, steps, executor, sandbox: { root: repo }, lock: { root: lockRoot }, ...over,
  };
  const run = async () =>
    (await buildSnapshot({ ticket: "29", source, hooks: tracker.registry.pre, ctx: { ...tracker.ctx, ticket: "29" } })).run;
  return { tracker, deps, run };
}

const say = (tracker: FakeTracker, stage: string, kind: string, round: number, extra: Record<string, unknown> = {}) =>
  tracker.say(29, `${kind} ${stage} ${round}${renderMarker({ stage, kind, round, ...extra })}`);

const records = (tracker: FakeTracker, kind: string) =>
  (tracker.comments.get(29) ?? []).map((c) => parseMarker(c.body)).filter((m) => m?.kind === kind);

/** A ticket at spec whose round one is owed: entered, never answered. */
function owed(executor: Executor | null, over: Partial<PairDeps> = {}) {
  const w = world(["lr:stage:spec"], executor, over);
  say(w.tracker, "spec", "enter", 1, { marker: "enter:spec:1" });
  return w;
}

/** A ticket waiting at review after the agent wrote the spec, under its own session. */
function reviewed(executor: Executor | null) {
  const w = world(["lr:stage:review"], executor);
  say(w.tracker, "spec", "enter", 1, { marker: "enter:spec:1" });
  say(w.tracker, "spec", "output", 1, { marker: "spec:1", output: { kind: "spec" }, session: "sid-agent" });
  return w;
}

/** A ticket resting at build with its round settled — where it stays when publish's push fails. */
function built(executor: Executor | null) {
  const w = world(["lr:stage:build"], executor);
  say(w.tracker, "build", "enter", 1, { marker: "enter:build:1" });
  say(w.tracker, "build", "output", 1, { marker: "built:1", output: { kind: "built" }, session: "sid-agent" });
  return w;
}

const snapshotOf = (deps: PairDeps) =>
  buildSnapshot({ ticket: "29", source: deps.source, hooks: deps.pre, ctx: { ...deps.ctx, ticket: "29" } });

describe("what may be paired on", () => {
  it("is the stage's own step while its round is owed", async () => {
    const { deps } = owed(agent().executor);
    expect(await pairingView(deps, "29")).toEqual({ open: null, offers: [{ stage: "spec", round: 1, continue: false }] });
  });

  it("is otherwise each step the stage may send the ticket to, continuing the agent's session there", async () => {
    const { deps } = reviewed(agent().executor);
    expect((await pairingView(deps, "29")).offers).toEqual([{ stage: "spec", round: 2, continue: true }]);
  });

  it("is nothing past a goto's cap", async () => {
    const { deps, tracker } = reviewed(agent().executor);
    for (const round of [2, 3]) say(tracker, "spec", "output", round, { output: { kind: "spec" } });
    expect((await pairingView(deps, "29")).offers).toEqual([]);
  });

  it("is nothing for an agent that cannot hand a session over, and asking is refused", async () => {
    const plain: Executor = { id: "plain", run: async () => ({ text: "", sessionId: null }) };
    const { deps, tracker } = owed(plain);
    expect((await pairingView(deps, "29")).offers).toEqual([]);
    await expect(startPair(deps, "29", "spec")).rejects.toThrow(/cannot hand a session/);
    expect(records(tracker, "pair")).toHaveLength(0);
  });
});

describe("starting a pairing", () => {
  it("writes the pair record, cuts the pairing's own worktree and hands back its command", async () => {
    const a = agent();
    const { deps, tracker, run } = owed(a.executor);
    const started = await startPair(deps, "29", "spec");

    expect(records(tracker, "pair")).toEqual([expect.objectContaining({ stage: "spec", round: 1, marker: "pair:spec:1:1" })]);
    expect((await run())?.pairing).toMatchObject({ stage: "spec", round: 1, n: 1 });
    expect(started.cwd.endsWith("/29.pair")).toBe(true);
    expect(await worktreesOf(repo)).toHaveLength(1);
    expect(started.command).toBe(`cd ${started.cwd} && agent --session-id ${started.session} '${a.handoffs[0]?.prompt.replaceAll("'", `'\\''`)}'`);
    // Seeded with the step as it would have run, and told it is a pairing.
    expect(a.handoffs[0]?.prompt).toMatch(/pairing with a person/);
    expect(a.handoffs[0]?.prompt).toContain("Write the spec for Pairing.");
    expect(a.handoffs[0]).not.toHaveProperty("resume");
  });

  it("asked again, writes nothing more and hands back the same session", async () => {
    const { deps, tracker } = owed(agent().executor);
    const first = await startPair(deps, "29", "spec");
    const again = await startPair(deps, "29", "spec");
    expect(again.session).toBe(first.session);
    expect(records(tracker, "pair")).toHaveLength(1);
  });

  it("on a goto target, enters the stage after the pair record and continues the agent's session", async () => {
    const a = agent();
    const { deps, tracker, run } = reviewed(a.executor);
    await startPair(deps, "29", "spec");

    const kinds = (tracker.comments.get(29) ?? []).map((c) => parseMarker(c.body)?.kind);
    expect(kinds.slice(-2)).toEqual(["pair", "enter"]);
    expect(tracker.labelsOf(29)).toContain("lr:stage:spec");
    expect(await run()).toMatchObject({ stage: "spec", previousStage: "review", pairing: { stage: "spec", round: 2 } });
    expect(a.handoffs[0]?.resume).toBe("sid-agent");
  });

  it("retried after a crash between the pair record and the stage's entry, enters it once and keeps one pair record", async () => {
    const a = agent();
    const { deps, tracker, run } = reviewed(a.executor);
    say(tracker, "spec", "pair", 2, { marker: "pair:spec:2:1" });
    const started = await startPair(deps, "29", "spec");

    expect(records(tracker, "pair")).toHaveLength(1);
    expect(records(tracker, "enter").filter((m) => m?.round === 2)).toHaveLength(1);
    expect((await run())?.stage).toBe("spec");
    const fresh = await startPair(deps, "29", "spec");
    expect(fresh.session).toBe(started.session);
  });

  it("retried after a crash between the stage's entry record and its status, finishes entering it", async () => {
    const { deps, tracker, run } = reviewed(agent().executor);
    say(tracker, "spec", "pair", 2, { marker: "pair:spec:2:1" });
    say(tracker, "spec", "enter", 2, { marker: "enter:spec:2" });
    await startPair(deps, "29", "spec");

    expect(records(tracker, "enter").filter((m) => m?.round === 2)).toHaveLength(1);
    expect((await run())?.stage).toBe("spec");
  });

  it("asked again once a refused hand-in has halted the ticket, leaves it at the halt", async () => {
    const a = agent("no answer block at all");
    const { deps, tracker, run } = owed(a.executor);
    const first = await startPair(deps, "29", "spec");
    await expect(finishPair(deps, "29")).rejects.toThrow(/refused/);
    const issue = tracker.issues.get(29);
    if (issue) issue.labels = ["lr:auto", "lr:stage:blocked", "lr:blocked"];

    const again = await startPair(deps, "29", "spec");
    expect(again.session).toBe(first.session);
    expect(tracker.labelsOf(29)).toEqual(expect.arrayContaining(["lr:stage:blocked", "lr:blocked"]));
    expect((await run())?.stage).toBe("blocked");
  });

  it("on the stage the ticket rests at with its round settled, enters the next round so the tick waits on it", async () => {
    const a = agent(BUILT);
    const { deps, tracker, run } = built(a.executor);
    expect((await pairingView(deps, "29")).offers).toEqual([{ stage: "build", round: 2, continue: true }]);
    await startPair(deps, "29", "build");

    expect(records(tracker, "enter").filter((m) => m?.stage === "build").map((m) => m?.round)).toEqual([1, 2]);
    expect(decide(workflow, await snapshotOf(deps))).toMatchObject({ action: "wait", paired: { stage: "build", round: 2 } });

    expect(await finishPair(deps, "29")).toMatchObject({ stage: "build", round: 2 });
    expect(records(tracker, "output").at(-1)).toMatchObject({ stage: "build", round: 2, by: "pair" });
    expect((await run())?.pairing).toBeNull();
  });

  it("refuses a second pairing on another stage while one is open, and writes nothing", async () => {
    const { deps, tracker } = owed(agent().executor);
    await startPair(deps, "29", "spec");
    const before = tracker.comments.get(29)?.length;
    await expect(startPair(deps, "29", "build")).rejects.toThrow(/already pairing on "spec"/);
    expect(tracker.comments.get(29)?.length).toBe(before);
  });

  it("refuses a step it may not pair on now, naming what it may", async () => {
    const { deps, tracker } = owed(agent().executor);
    await expect(startPair(deps, "29", "build")).rejects.toThrow(/may pair on "spec"/);
    expect(records(tracker, "pair")).toHaveLength(0);
  });

  it("writes nothing when screening blocks the seeded prompt", async () => {
    const { deps, tracker } = owed(agent().executor, { screen: { executor: screener("suspicious"), model: "haiku" } });
    await expect(startPair(deps, "29", "spec")).rejects.toThrow(/screening blocked/);
    expect(records(tracker, "pair")).toHaveLength(0);
    expect(await worktreesOf(repo)).toHaveLength(0);
  });
});

describe("finishing a pairing", () => {
  it("forks the person's session for the step's answer and records it as the pair's", async () => {
    const a = agent();
    const { deps, tracker, run } = owed(a.executor);
    const started = await startPair(deps, "29", "spec");
    const finished = await finishPair(deps, "29", "ship the short version");

    expect(a.runs).toEqual([expect.objectContaining({ resume: started.session, fork: true, cwd: started.cwd })]);
    expect(a.runs[0]?.prompt).toContain("ship the short version");
    expect(records(tracker, "output")).toEqual([expect.objectContaining({ stage: "spec", round: 1, by: "pair", session: "sid-fork" })]);
    expect(finished).toEqual({ stage: "spec", round: 1, discarded: [] });
    expect(await run()).toMatchObject({ pairing: null, lastOutputBy: "pair" });
    expect(existsSync(started.cwd)).toBe(false);
  });

  it("does not count the person's own edits against a read-only step, and discards what they left uncommitted", async () => {
    const { deps, tracker } = owed(agent().executor);
    const started = await startPair(deps, "29", "spec");
    await writeFile(join(started.cwd, "notes.md"), "scratch\n");

    const finished = await finishPair(deps, "29");
    expect(finished.discarded).toEqual(["?? notes.md"]);
    expect(records(tracker, "output")).toHaveLength(1);
    expect(existsSync(started.cwd)).toBe(false);
  });

  it("refuses a closing turn that writes to a read-only step's worktree, and leaves the pairing open", async () => {
    const a = agent();
    const { deps, tracker, run } = owed(a.executor);
    const started = await startPair(deps, "29", "spec");
    a.executor.run = async () => {
      await writeFile(join(started.cwd, "sneaky.md"), "x\n");
      return { text: DONE, sessionId: null };
    };
    await expect(finishPair(deps, "29")).rejects.toThrow(/without declaring repo:write/);
    expect(records(tracker, "refused")).toHaveLength(1);
    expect((await run())?.pairing).toMatchObject({ stage: "spec" });
  });

  it("records a malformed hand-in, keeps the pairing, and a second Finish re-enters the stage and closes it", async () => {
    const a = agent("no answer block at all");
    const { deps, tracker, run } = owed(a.executor);
    await startPair(deps, "29", "spec");
    await expect(finishPair(deps, "29")).rejects.toThrow(/refused/);
    expect(records(tracker, "malformed")).toEqual([expect.objectContaining({ stage: "spec", round: 1 })]);
    expect((await run())?.pairing).toMatchObject({ stage: "spec", round: 1 });

    // The tick halts the ticket on the rejected round.
    const issue = tracker.issues.get(29);
    if (issue) issue.labels = ["lr:auto", "lr:stage:blocked"];
    a.answer(DONE);
    expect(await finishPair(deps, "29")).toMatchObject({ stage: "spec", round: 2 });
    expect(records(tracker, "enter").filter((m) => m?.stage === "spec").map((m) => m?.round)).toEqual([1, 2]);
    expect(records(tracker, "output")).toEqual([expect.objectContaining({ round: 2, by: "pair" })]);
    expect((await run())?.pairing).toBeNull();
  });

  it("enters the round a crash left unentered on the settled stage the ticket rests at, and closes it", async () => {
    const { deps, tracker, run } = built(agent(BUILT).executor);
    say(tracker, "build", "pair", 2, { marker: "pair:build:2:1" });

    expect(await finishPair(deps, "29")).toMatchObject({ stage: "build", round: 2 });
    expect(records(tracker, "enter").filter((m) => m?.stage === "build").map((m) => m?.round)).toEqual([1, 2]);
    expect((await run())?.pairing).toBeNull();
  });

  it("says so when there is nothing to finish", async () => {
    const { deps } = owed(agent().executor);
    await expect(finishPair(deps, "29")).rejects.toThrow(/no pairing/);
  });
});

describe("releasing a pairing", () => {
  it("records the release, removes the worktree, and a second pairing at the round is its own", async () => {
    const { deps, tracker, run } = owed(agent().executor);
    const first = await startPair(deps, "29", "spec");
    expect(await releasePair(deps, "29")).toEqual({ stage: "spec", round: 1 });

    expect(records(tracker, "release")).toEqual([expect.objectContaining({ marker: "release:spec:1:1" })]);
    expect((await run())?.pairing).toBeNull();
    expect(existsSync(first.cwd)).toBe(false);

    const second = await startPair(deps, "29", "spec");
    expect(records(tracker, "pair").map((m) => m?.marker)).toEqual(["pair:spec:1:1", "pair:spec:1:2"]);
    expect(second.session).not.toBe(first.session);
  });
});
