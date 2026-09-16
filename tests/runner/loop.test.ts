import { createHarness } from "#testing/index.js";
import { deriveRun } from "#core/index.js";
import type { Effect, Marker, ScriptedAnswer } from "#namespace.js";
import { parseMarker, stageFromLabels } from "#conventions.js";
import { loadWorkflow } from "#workflow/load.js";
import { createFakeTracker } from "#tests/support/fake-tracker.js";

/**
 * The shipped workflow, driven over the in-memory tracker. Not a fixture
 * reproducing its shape: §10's review cycle is the thing that has to iterate,
 * and a hand-written copy of it would be free to drift from the file the
 * daemon actually loads — which is exactly where the cycle was broken.
 */
type Answer = ScriptedAnswer;

/*
 * The spec answer carries prose as well as its json block, because the prose
 * *is* the document: the block is stripped out and what is left is what gets
 * published. An answer that is nothing but a block produced no spec, and the
 * artifact hook refuses to put an empty page up.
 */
const OUTPUT: Record<string, Answer> = {
  spec: '# The spec\n\nDo the thing.\n\n```json\n{"kind":"spec","title":"T"}\n```',
  triage: '```json\n{"intent":"approve"}\n```',
  build: '```json\n{"kind":"done"}\n```',
  "code-review": '```json\n{"kind":"reviewed"}\n```',
  "fix-review": '```json\n{"kind":"addressed"}\n```',
};

type World = ReturnType<typeof createFakeTracker>;

const world = (labels: string[]): World =>
  createFakeTracker([{ number: 1, title: "Add export", body: "please", labels }]);

/**
 * The real GitHub hooks, as the loader classified them out of the hook module:
 * the tracker's two halves, both halves of the spec artifact — a ticket cannot
 * leave `spec` without something publishing what the step wrote — and the pull
 * request artifact, which is every fact the review half of §10 routes on.
 */
const hooksOf = (gh: World) => {
  const pre = gh.registry.pre;
  const post = gh.registry.post;
  const ids = pre.map((h) => h.id).join(",");
  if (ids !== "github,pr,spec") throw new Error(`the fake tracker registered the wrong pre hooks: ${ids}`);
  if (post.length !== 3) throw new Error("the fake tracker registered the wrong post hooks");
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
 * What the world does around the ticket while the loop runs, on the in-memory
 * GitHub the real artifact hook reads.
 *
 * Nothing here is a stand-in for an engine part: opening the pull request and
 * resolving a thread are both things *people and pushes* do, and the engine
 * reads them back. What this models is §10's own rule that the party who
 * raised a finding closes it — so a fix round leaves `openThreads` exactly
 * where it was, and only the next review round moves it.
 */
const BRANCH = "landrace/1";

const openThePr = (gh: World, openThreads: number): void => {
  if ([...gh.pulls.values()].some((p) => p.head === BRANCH)) return;
  gh.openPull({
    head: BRANCH,
    number: 7,
    headSha: "sha-1",
    threads: Array.from({ length: openThreads }, (_, i) => ({ isResolved: false, body: `finding ${i}` })),
  });
};

const resolveEveryThread = (gh: World): void => {
  for (const pull of gh.pulls.values()) for (const t of pull.threads) t.isResolved = true;
};

async function run(
  gh: World,
  opts: {
    openThreads?: number;
    answers?: Record<string, Answer>;
    breakOn?: (e: Effect) => boolean;
    /** The review round on which the reviewer resolves what it raised. Never, by default. */
    resolveOn?: number;
  } = {},
) {
  const { workflow, steps } = await loadWorkflow(".landrace");
  const { pre, post } = hooksOf(gh);

  const harness = createHarness({
    workflow, steps, pre, post,
    artifacts: gh.registry.artifacts,
    answers: { ...OUTPUT, ...opts.answers },
    // The two things that happen *outside* the engine while a step runs. The
    // push and the `gh pr create` that follow a build are nobody's hook yet,
    // and resolving a thread is the reviewer's own act — §10 is explicit that
    // the fixer never does it.
    during: ({ stage, round }) => {
      if (stage === "build") openThePr(gh, opts.openThreads ?? 2);
      if (stage === "code-review" && round === opts.resolveOn) resolveEveryThread(gh);
    },
    ...(opts.breakOn ? { interrupt: (effect: Effect) => opts.breakOn?.(effect) ?? false } : {}),
  });

  const { result, calls, trail } = await harness.converge();

  const labels = gh.labelsOf(1);
  const comments = gh.comments.get(1) ?? [];
  return {
    result, labels, positions: trail,
    invocations: calls.map(({ stage, round }) => ({ stage, round })),
    prompts: calls.map(({ stage, prompt }) => ({ stage, prompt })),
    published: gh.published(),
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

  /**
   * The gap that made a fix round theatre: `fix-review` was told to address
   * the open threads and was never shown one. The artifact carries a count and
   * nothing else, deliberately — a thread body is written by anyone with
   * comment access, and `artifacts.*` is hashed into the snapshot and read by
   * every predicate — so the bodies reach the *prompt*, through the briefing,
   * escaped and bounded, and reach nothing else.
   */
  it("shows the fixer the threads it is told to address, without putting them in the snapshot", async () => {
    const gh = world(["lr:auto", "lr:stage:build"]);
    const r = await run(gh);

    const fixing = r.prompts.find((p) => p.stage === "fix-review")?.prompt ?? "";
    expect(fixing).toContain("finding 0");
    expect(fixing).toContain("finding 1");
    expect(fixing).not.toContain("{brief.pr.threads}");

    // And the reviewer, who raises findings rather than addressing them, is
    // shown none: a briefing is prompt text for the step that asked for it.
    expect(r.prompts.find((p) => p.stage === "code-review")?.prompt ?? "").not.toContain("finding 0");
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
 * A ticket's whole position is one label, and the swap that writes it is two
 * requests with an await in between — so a crash, a 502 on the add, or a
 * person with triage rights can leave a ticket with none at all. "No position"
 * then read as "a new ticket", which is the one place the "a crash costs
 * nothing" guarantee did not hold: the crash is *inside* one effect's apply,
 * below the level reconcile can replan.
 */
describe("a ticket that has lost its one stage label", () => {
  const stageless = (gh: World): void => {
    const issue = gh.issues.get(1);
    if (!issue) throw new Error("no ticket #1");
    issue.labels = issue.labels.filter((l) => !l.startsWith("lr:stage:"));
  };

  it("halts for a human rather than restarting a finished run from the entry stage", async () => {
    const gh = world(["lr:auto", "lr:stage:build"]);
    const finished = await run(gh);
    expect(finished.run.counters["code-review"]).toBe(4);
    expect(finished.run.counters["fix-review"]).toBe(3);

    stageless(gh);
    const r = await run(gh);

    // Not `spec` again: that was a fresh paid spec step, the spec page
    // republished over the old one, and a whole build-and-review run left on
    // the ticket unread.
    expect(r.invocations).toEqual([]);
    expect(r.positions).toEqual([]);
    expect(r.result.settled).toBe("halt");
    expect(r.result.why).toMatch(/no position/);
    expect(r.result.why).toMatch(/code-review/);
  });

  /*
   * The boundary of that rule, and it has to stay on this side of it: a crash
   * between the entry stage's own first record and the status that moves the
   * position leaves history and no position too — but nothing has been paid
   * for and nothing is discarded, so replanning writes the identical record
   * and the label it was missing. That is the ordinary crash recovery this
   * design is built on, not a restart.
   */
  it("still resumes a first entry whose position write never landed", async () => {
    const gh = world(["lr:auto"]);
    await run(gh, { breakOn: (e: Effect) => e.type === "tracker.status" });
    expect(gh.labelsOf(1).some((l) => l.startsWith("lr:stage:"))).toBe(false);

    const resumed = await run(gh);
    expect(resumed.invocations[0]).toEqual({ stage: "spec", round: 1 });
    expect(entryRecords(resumed.markers, "spec")).toEqual([1]);
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
      : '# Export CSV\n\nOne file, comma separated.\n\n```json\n{"kind":"spec","title":"Export CSV"}\n```',
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

    // The document is on the Pages branch, and the ticket carries only the
    // record that it was written — §8.2's destination, in place of the comment
    // it was rerouted to while no artifact hook existed.
    expect(r.published.get("specs/1/index.md")).toBe("# Export CSV\n\nOne file, comma separated.");
    expect((gh.comments.get(1) ?? []).map((c) => c.body).join("\n")).not.toContain("One file, comma separated");
    expect(r.markers.some((m) => m.kind === "output" && m.stage === "spec" && m.round === 2)).toBe(true);
  });

  /*
   * The stall this revert had to close. The route no longer writes to the
   * tracker, so without a record beside it the stage produces a page and stays
   * pending: converge catches the second attempt in the same call, and every
   * poll after that pays for one more invocation of an opus step.
   */
  it("finishes the round rather than re-invoking a stage that published and recorded nothing", async () => {
    const gh = world(["lr:auto"]);
    await run(gh, { answers });
    say(gh, "in-house, and CSV only");
    const r = await run(gh, { answers });

    expect(r.invocations).toEqual([{ stage: "spec", round: 2 }]);
    expect(r.result.why ?? "").not.toMatch(/left nothing readable/);
    expect(r.run.rounds.spec).toEqual({ entered: 2, output: 2 });
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
    // `{artifacts.spec.url}` in build.md and code-review.md, filled by the
    // artifact's own read rather than by a value a test supplied.
    expect(r.prompts.find((p) => p.stage === "build")?.prompt)
      .toContain("https://acme.github.io/widgets/specs/1/");
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

    // Everything the agent tried to add — `title`, `intent`, `stage` — is
    // gone, which is what this pins. The engine's own session is not here
    // either: it rides beside the value on the record, so `outputs.<stage>` is
    // the agent's declared fields and nothing else.
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

/**
 * The whole of §10, from a fresh ticket to `done`, over the in-memory GitHub.
 *
 * Nothing is seeded and nothing is injected: the position comes from a label,
 * the rounds from records on the ticket, the spec from the Pages branch, and
 * every gate in the review half from the pull request artifact's own read. The
 * only things supplied from outside are the two a person and a push do — a
 * pull request appearing after the build, and a merge.
 */
describe("a ticket goes all the way round §10", () => {
  const answers: Record<string, Answer> = {
    spec: (round) => round === 1
      ? '```json\n{"kind":"questions","questions":["in-house or vendor?"]}\n```'
      : '# Export CSV\n\nOne file, comma separated.\n\n```json\n{"kind":"spec","title":"Export CSV"}\n```',
  };

  /**
   * The position trail across several converge calls, without the repeat where
   * one call picks up where the last left off.
   *
   * The final position comes out of the evaluation that *moved* the ticket
   * there, not out of a later one: nothing evaluates the ticket again after
   * the last transition, because `done` removes `lr:auto` and the next pass
   * finds it ineligible. So the event says where it went as well as where it
   * was, and a reader of the log never has to know how this tracker spells a
   * position.
   */
  const trail = (...runs: Array<{ positions: string[] }>): string[] =>
    runs.flatMap((r) => r.positions).filter((at, i, all) => at !== all[i - 1]);

  it("walks spec → review → done, and the pull request is what turns the second half", async () => {
    const gh = world(["lr:auto"]);

    const asked = await run(gh, { answers });
    say(gh, "in-house, and CSV only");
    const specced = await run(gh, { answers });
    say(gh, "looks right, go ahead");
    // The reviewer closes its own findings on its second pass — §10's "the
    // party that raised a finding closes it", which is also the only thing
    // that can end the loop.
    const reviewed = await run(gh, { answers, resolveOn: 2 });

    // A person merges it.
    const pull = gh.pulls.get(7);
    if (!pull) throw new Error("the build never opened a pull request");
    pull.merged = true;
    const done = await run(gh, { answers });

    expect(trail(asked, specced, reviewed, done)).toEqual([
      "spec", "spec-questions", "spec", "spec-human-review", "triage", "build",
      "code-review", "fix-review", "code-review", "pr-human-review", "done",
    ]);
    expect(reviewed.invocations).toEqual([
      { stage: "triage", round: 1 },
      { stage: "build", round: 1 },
      { stage: "code-review", round: 1 },
      { stage: "fix-review", round: 1 },
      { stage: "code-review", round: 2 },
    ]);
    // Terminal: the engine's own labels are gone, so the next tick does not
    // pick the ticket up again.
    expect(done.labels).toEqual(["lr:stage:done"]);
    expect(done.result.settled).not.toBe("cap");
  });

  /*
   * The property the round-aware half of the engine leans on: a fix round
   * changes nothing the gate reads. If anything here ever resolved a thread on
   * the fixer's behalf, `pr-human-review` would be reached with findings still
   * open on the pull request and nobody would be told.
   */
  it("leaves the thread count exactly where it was across every fix round", async () => {
    const gh = world(["lr:auto", "lr:stage:build"]);
    const r = await run(gh);

    expect(r.invocations.filter((i) => i.stage === "fix-review").length).toBe(3);
    expect([...gh.pulls.values()][0]?.threads.filter((t) => !t.isResolved).length).toBe(2);
    expect(r.labels).toContain("lr:blocked");
  });

  /*
   * What the artifact costs. §3.1 asks for artifact state every tick and
   * converge runs many passes per call, so this is the number that grows with
   * the workflow: one GraphQL query per pass for the state, and one more per
   * invocation of a step whose prompt actually names the pull request's
   * briefing — not one per review thread, not one per round, and nothing at
   * all for the four steps that have no use for the threads.
   */
  it("costs one GraphQL query per pass, plus one per step that asks to see the threads", async () => {
    const gh = world(["lr:auto", "lr:stage:build"]);
    const r = await run(gh);

    const briefed = r.invocations.filter((i) => i.stage === "fix-review").length;
    expect(briefed).toBeGreaterThan(0);
    expect(gh.requests.filter((q) => q.path === "/graphql").length).toBe(r.result.passes + briefed);
    // The reviewer runs more often than the fixer and pays for no briefing:
    // the four invocations of `code-review` add nothing to the number above.
    expect(r.invocations.filter((i) => i.stage === "code-review").length).toBeGreaterThan(briefed);
  });
});
