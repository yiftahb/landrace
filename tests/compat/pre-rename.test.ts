import { ITEM_KIND } from "#conventions.js";
import { buildSnapshot } from "#runner/snapshot.js";
import type { Source } from "#namespace.js";
import { createFakeTracker } from "#tests/support/fake-tracker.js";

/*
 * Bytes an item carries on GitHub today, copied from live issues (#39, #43).
 * The rename of "ticket" to "item" must never change how these read back:
 * an item in flight keeps its stage, its rounds and its pull request. Edit
 * identifiers in this file if a rename asks you to — never these strings.
 */
const LABELS = ["lr:auto", "lr:stage:code-review", "lr:working"];
const COMMENTS = [
  'Writing the spec, round 1.\n\n<!-- landrace {"stage":"spec","kind":"enter","round":1,"marker":"enter:spec:1"} -->',
  'Recorded the output of "spec", round 1.\n\n<!-- landrace {"stage":"spec","kind":"output","round":1,"marker":"spec:1","output":{"kind":"spec","title":"Export"}} -->',
  'Reading your reply, round 1.\n\n<!-- landrace {"stage":"triage","kind":"enter","round":1,"marker":"enter:triage:1","from":"spec-human-review"} -->',
  '\n\n<!-- landrace {"stage":"triage","kind":"output","round":1,"marker":"intent:1","output":{"intent":"approve"}} -->',
  'Implementing the spec, round 1.\n\n<!-- landrace {"stage":"build","kind":"enter","round":1,"marker":"enter:build:1","from":"triage"} -->',
  'Recorded the output of "build", round 1.\n\n<!-- landrace {"stage":"build","kind":"output","round":1,"marker":"done:1","output":{"kind":"done"}} -->',
  'Reviewing the pull request, round 1.\n\n<!-- landrace {"stage":"code-review","kind":"enter","round":1,"marker":"enter:code-review:1","from":"publish"} -->',
];
const BRANCH = "landrace/7";

describe("an item written before the rename", () => {
  const read = async () => {
    const tracker = createFakeTracker([{ number: 7, labels: LABELS }]);
    for (const body of COMMENTS) tracker.say(7, body);
    tracker.openPull({ head: BRANCH });
    const source = tracker.registry.source as Source;
    return { tracker, source, snapshot: await buildSnapshot({ item: "7", source, hooks: tracker.registry.pre, ctx: { ...tracker.ctx, item: "7" } }) };
  };

  it("keeps its stage, rounds and outputs", async () => {
    const { snapshot } = await read();
    expect(snapshot.run?.stage).toBe("code-review");
    expect(snapshot.run?.counters).toMatchObject({ spec: 1, triage: 1, build: 1 });
    expect(snapshot.run?.outputs.triage).toEqual({ intent: "approve" });
    expect(snapshot.run?.outputs.spec).toEqual({ kind: "spec", title: "Export" });
  });

  it("keeps its pull request, found by its branch", async () => {
    const { snapshot } = await read();
    expect((snapshot as { rel?: { implements?: { in?: { total?: number } } } }).rel?.implements?.in?.total).toBe(1);
  });

  it("is listed as the kind the engine works", async () => {
    const { source, tracker } = await read();
    const graph = await source.list(tracker.ctx);
    expect(graph.nodes.find((n) => n.id === "7")?.kind).toBe(ITEM_KIND);
  });
});
