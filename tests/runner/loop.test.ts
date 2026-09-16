import { converge } from "../../src/runner/converge.js";
import { createDispatcher } from "../../src/runner/effects.js";
import { createLogger, type Logger } from "../../src/runner/events.js";
import { definePreHook, type Executor, type HookContext, type PostHook } from "../../src/hooks/types.js";
import { deriveRun } from "../../src/core/index.js";
import type { Effect } from "../../src/namespace.js";
import { parseMarker, stageFromLabels, type Marker } from "../../src/conventions.js";
import { loadWorkflow } from "../../src/workflow/load.js";
import { createFakeTracker } from "../support/fake-tracker.js";

/**
 * The shipped workflow, driven over the in-memory tracker. Not a fixture
 * reproducing its shape: §10's review cycle is the thing that has to iterate,
 * and a hand-written copy of it would be free to drift from the file the
 * daemon actually loads — which is exactly where the cycle was broken.
 */
type Answer = string | ((round: number) => string);

const OUTPUT: Record<string, Answer> = {
  spec: '```json\n{"kind":"spec","title":"T"}\n```',
  triage: '```json\n{"intent":"approve"}\n```',
  build: '```json\n{"kind":"done"}\n```',
  "code-review": '```json\n{"kind":"reviewed"}\n```',
  "fix-review": '```json\n{"kind":"addressed"}\n```',
};

type World = ReturnType<typeof createFakeTracker>;

const world = (labels: string[]): World =>
  createFakeTracker([{ number: 1, title: "Add export", body: "please", labels }]);

/** The real GitHub hooks, as the loader classified them out of the hook module. */
const hooksOf = (gh: World) => {
  const [pre] = gh.registry.pre;
  const [post] = gh.registry.post;
  if (!pre || !post) throw new Error("the fake tracker registered no hooks");
  return { pre, post };
};

/**
 * A person says something on the ticket. Under their own login, so it reads as
 * a human entry rather than as one of ours, and dated after everything the
 * fake tracker has written so far (its clock starts at 2026-01-01 and moves a
 * second per comment), because `lastEvent.actor` is whoever spoke last.
 */
let said = 0;
const say = (gh: World, body: string): void => {
  said++;
  gh.sayAs("a-person", 1, body, new Date(Date.UTC(2026, 1, said)).toISOString());
};

/**
 * The PR the review cycle turns on. No artifact hook exists yet, so the facts
 * §10's gates read are supplied here — deliberately *unchanging* across the
 * loop: the fixer never resolves a thread (§10: the party that raised a
 * finding closes it), so no external value distinguishes one review round
 * from the next.
 */
const prHook = (openThreads: number) =>
  definePreHook({
    id: "pr",
    provides: ["artifacts.pr.number", "artifacts.pr.openThreads", "artifacts.pr.merged", "artifacts.spec.url"],
    run: () => ({
      artifacts: { pr: { number: 7, openThreads, merged: false }, spec: { url: "https://example.invalid/spec" } },
    }),
  });

/** A post hook that fails one effect, to cut a transition's effect list in half mid-flight. */
const breakingOn = (inner: PostHook, hit: (e: Effect) => boolean): PostHook => ({
  id: inner.id,
  handles: inner.handles,
  satisfied: (s, e) => inner.satisfied(s, e),
  apply: async (e, ctx) => {
    if (hit(e)) throw new Error("the process died here");
    return inner.apply(e, ctx);
  },
});

async function run(
  gh: World,
  opts: { openThreads?: number; answers?: Record<string, Answer>; breakOn?: (e: Effect) => boolean } = {},
) {
  const { workflow, steps } = await loadWorkflow(".landrace");
  const answers = { ...OUTPUT, ...opts.answers };

  const invocations: Array<{ stage: string; round: number }> = [];
  let current = "spec";
  let round = 1;
  const base = createLogger({ sink: () => {} });
  const log: Logger = (type, data) => {
    if (type === "step.invoked") {
      const e = data as { stage: string; round: number };
      current = String(e.stage);
      round = Number(e.round);
      invocations.push({ stage: current, round });
    }
    base(type, data);
  };

  const { pre, post } = hooksOf(gh);
  // Keyed by round as well as stage: the spec step's whole point is that one
  // stage answers differently on a second pass, and a fixed answer per stage
  // could never drive that.
  const prompts: Array<{ stage: string; prompt: string }> = [];
  const executor: Executor = {
    id: "fake",
    run: async (prompt) => {
      prompts.push({ stage: current, prompt });
      const answer = answers[current];
      return { text: (typeof answer === "function" ? answer(round) : answer) ?? "no output", sessionId: null };
    },
  };

  const result = await converge(1, {
    workflow, steps,
    pre: [pre, prHook(opts.openThreads ?? 2)],
    dispatcher: createDispatcher([opts.breakOn ? breakingOn(post, opts.breakOn) : post]),
    executor,
    ctx: {
      ticket: 1, config: {} as HookContext["config"], secrets: new Map(),
      signal: new AbortController().signal, log: () => {},
    },
    log,
  });

  const labels = gh.labelsOf(1);
  const comments = gh.comments.get(1) ?? [];
  return {
    result, invocations, labels, prompts,
    markers: comments.map((c) => parseMarker(c.body)).filter((m): m is Marker => m !== null),
    run: deriveRun(gh.entriesOf(1), stageFromLabels(labels).stage),
  };
}

const entryRecords = (markers: Marker[], stage: string) =>
  markers.filter((m) => m.kind === "enter" && m.stage === stage).map((m) => m.round);

describe("the §10 review cycle iterates", () => {
  it("runs code-review again after fix-review, to a second and a third round", async () => {
    const r = await run(world(["lr:auto", "lr:stage:build"]));

    expect(r.invocations.filter((i) => i.stage !== "build")).toEqual([
      { stage: "code-review", round: 1 },
      { stage: "fix-review", round: 1 },
      { stage: "code-review", round: 2 },
      { stage: "fix-review", round: 2 },
      { stage: "code-review", round: 3 },
      { stage: "fix-review", round: 3 },
      { stage: "code-review", round: 4 },
    ]);
    expect(r.run.counters["code-review"]).toBe(4);
    expect(r.run.counters["fix-review"]).toBe(3);
  });

  it("stops at the workflow's own review budget, not at the pass cap", async () => {
    const r = await run(world(["lr:auto", "lr:stage:build"]));

    expect(r.result.settled).not.toBe("cap");
    expect(r.result.passes).toBeLessThan(30);
    expect(r.labels).toEqual(expect.arrayContaining(["lr:stage:blocked", "lr:blocked"]));
  });

  it("records each entry exactly once, and numbers it with the round the step then runs", async () => {
    const r = await run(world(["lr:auto", "lr:stage:build"]));
    expect(entryRecords(r.markers, "code-review")).toEqual([1, 2, 3, 4]);
    expect(entryRecords(r.markers, "fix-review")).toEqual([1, 2, 3]);
  });
});

/**
 * §6.1's truncation property, applied to the one effect list where it now
 * matters: the entry record and the status that moves the position are two
 * writes, and a crash between them must neither lose a round nor duplicate
 * one.
 */
describe("a crash between the entry record and the position it belongs to", () => {
  const secondReview = (e: Effect) => e.type === "tracker.status" && e.value === "code-review" && e.round === 2;

  it("leaves the ticket where it was, with the entry record already written", async () => {
    const gh = world(["lr:auto", "lr:stage:build"]);
    const first = await run(gh, { breakOn: secondReview });

    expect(first.result.settled).toBe("halt");
    expect(first.labels).toContain("lr:stage:fix-review");
    expect(entryRecords(first.markers, "code-review")).toEqual([1, 2]);
  });

  /*
   * The round in an entry record comes from the stage's *output* counter, not
   * from a count of entry records. Derived the other way, replanning here
   * would number this entry 3 — a second record of one real entry, which the
   * output could never catch up with, so the stage would be re-invoked for a
   * round it had already finished on every tick from then on.
   */
  it("replans the identical round rather than recording a second entry", async () => {
    const gh = world(["lr:auto", "lr:stage:build"]);
    await run(gh, { breakOn: secondReview });
    const resumed = await run(gh);

    expect(entryRecords(resumed.markers, "code-review")).toEqual([1, 2, 3, 4]);
    expect(resumed.invocations[0]).toEqual({ stage: "code-review", round: 2 });
    expect(resumed.run.rounds["code-review"]).toEqual({ entered: 4, output: 4 });
    expect(resumed.result.settled).not.toBe("cap");
  });
});

/**
 * The spec phase, driven from the entry stage by nothing but what the step
 * said. Every trigger out of `spec` and `triage` reads an output *shape*, so
 * until the marker carried the step's value this whole half of the shipped
 * workflow was unreachable and the tests above had to seed a ticket at
 * `lr:stage:build` to get past it. Seeding is the thing this must not do: a
 * test that starts after the broken part cannot notice it is broken.
 */
describe("the spec phase routes on what the step actually said", () => {
  const answers: Record<string, Answer> = {
    // One stage, two shapes, chosen by round — §8.2's "the spec step outputs
    // questions or a spec, never both, and the gate reads which arrived".
    spec: (round) => round === 1
      ? '```json\n{"kind":"questions","questions":["in-house or vendor?"]}\n```'
      : '```json\n{"kind":"spec","title":"Export CSV"}\n```',
  };

  it("reaches spec-questions because outputs.spec.kind resolved to questions", async () => {
    const gh = world(["lr:auto"]);
    const r = await run(gh, { answers });

    expect(r.invocations).toEqual([{ stage: "spec", round: 1 }]);
    expect(r.run.outputs.spec).toEqual({ kind: "questions", questions: ["in-house or vendor?"] });
    expect(r.labels).toEqual(expect.arrayContaining(["lr:stage:spec-questions", "lr:awaiting"]));
    expect(r.labels).not.toContain("lr:working");
  });

  it("re-enters spec when the questions are answered, and publishes the spec on the second round", async () => {
    const gh = world(["lr:auto"]);
    await run(gh, { answers });
    say(gh, "in-house, and CSV only");
    const r = await run(gh, { answers });

    expect(r.invocations).toEqual([{ stage: "spec", round: 2 }]);
    expect(r.run.outputs.spec).toEqual({ kind: "spec", title: "Export CSV" });
    expect(r.run.counters.spec).toBe(2);
    expect(r.labels).toContain("lr:stage:spec-human-review");
  });

  it("routes the reply through triage and on to build", async () => {
    const gh = world(["lr:auto"]);
    await run(gh, { answers });
    say(gh, "in-house, and CSV only");
    await run(gh, { answers });
    say(gh, "looks right, go ahead");
    const r = await run(gh, { answers });

    expect(r.invocations.slice(0, 3)).toEqual([
      { stage: "triage", round: 1 },
      { stage: "build", round: 1 },
      { stage: "code-review", round: 1 },
    ]);
    expect(r.run.outputs.triage).toEqual({ intent: "approve" });
    // The one thing triage exists to read. `{run.lastHuman.body}` resolved to
    // nothing — lastHuman is an Entry, and the comment text is on its `data` —
    // so the judge was shown its own placeholder and asked to classify it.
    expect(r.prompts.find((p) => p.stage === "triage")?.prompt).toContain("looks right, go ahead");
    // Through the spec phase and the whole review cycle in one call, settling
    // on the workflow's own budget rather than on the engine's pass cap.
    expect(r.result.settled).not.toBe("cap");
  });

  /*
   * The bound is the declared shape, and the shape is the security boundary:
   * whatever survives into outputs.<stage> is state predicates route on. An
   * agent that could add keys could write `intent: approve` under its own
   * stage — or, with a stage id of its choosing, under someone else's.
   */
  it("carries only the fields the shape declared, whatever else the agent sends", async () => {
    const gh = world(["lr:auto"]);
    const r = await run(gh, {
      answers: {
        spec: () =>
          '```json\n{"kind":"questions","questions":["a?"],"title":"forged","intent":"approve","stage":"build"}\n```',
      },
    });

    expect(r.run.outputs.spec).toEqual({ kind: "questions", questions: ["a?"] });
    expect(r.labels).toContain("lr:stage:spec-questions");
  });
});

/*
 * What is reachable without a human at all, and what this covers, is the
 * handback out of a halted ticket.
 */
describe("a halted ticket is handed back to a stage that records its entry", () => {
  it("re-enters spec, clears the blocked label and numbers the round", async () => {
    const gh = world(["lr:auto", "lr:stage:build"]);
    const halted = await run(gh);
    expect(halted.labels).toContain("lr:blocked");

    say(gh, "try again");

    const handed = await run(gh);
    expect(handed.invocations[0]).toEqual({ stage: "spec", round: 1 });
    expect(entryRecords(handed.markers, "spec")).toEqual([1]);
    expect(handed.labels).not.toContain("lr:blocked");
  });
});
