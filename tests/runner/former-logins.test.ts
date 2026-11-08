import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMarker } from "#conventions.js";
import { createExternalState, createHarness } from "#testing/index.js";
import { loadWorkflow } from "#workflow/load.js";
import type { ExternalState, FormerLogin, Harness, Run, Snapshot } from "#namespace.js";

/*
 * #237, through the engine: a tracker login changed from `old` to the one
 * landrace posts as now (the in-memory tracker's `landrace`). With `old`
 * listed until T, its records still count; without, they are foreign —
 * neither a record nor a reply — and the engine says so once per item.
 */
const T = "2026-06-01T00:00:00Z";
const AFTER = "2026-07-01T00:00:00Z";
const SPEC = '# The spec\n\nDo it.\n\n```json\n{"kind":"spec","title":"T"}\n```';

/**
 * spec runs a step; waiting follows once it has output; a person's reply
 * (`run.lastHuman.at`) sends it back to spec once; done follows the second.
 */
const WORKFLOW = `version: 1
name: former
description: test
stages:
  - id: spec
    entry: true
    step: steps/spec.md
    triggers:
      - name: fresh
        when: { "run.stage": null }
      - name: again
        when: { "run.stage": "waiting", "run.lastHuman.at": { $exists: true }, "run.counters.spec": { $lt: 2 } }
    on_enter:
      - { type: tracker.comment, kind: enter, marker: "enter:{stage}:{round}", body: "Writing the spec, round {round}." }
      - { type: tracker.status, value: spec }
  - id: waiting
    triggers:
      - name: written
        when: { "run.stage": "spec", "run.outputs.spec": { $exists: true } }
    on_enter:
      - { type: tracker.status, value: waiting }
  - id: done
    terminal: true
    triggers:
      - name: twice
        when: { "run.stage": "waiting", "run.counters.spec": { $gte: 2 } }
    on_enter:
      - { type: tracker.status, value: done }
`;

const STEP = `---
capabilities: [repo:read]
output:
  discriminator: kind
  shapes:
    spec: { title: string }
  routes:
    - when: { kind: spec }
      effect: { type: tracker.comment, marker: "spec:{round}" }
---

Write the spec for {node.title}.
`;

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "landrace-former-"));
  await mkdir(join(dir, "steps"), { recursive: true });
  await writeFile(join(dir, "workflow.yaml"), WORKFLOW);
  await writeFile(join(dir, "steps", "spec.md"), STEP);
});

interface Driven { run: Harness; events: Array<[string, Record<string, unknown>]>; lastRun: () => Run | undefined }

async function drive(state: ExternalState, formerLogins?: FormerLogin[]): Promise<Driven> {
  const { workflow, steps } = await loadWorkflow(dir);
  const events: Array<[string, Record<string, unknown>]> = [];
  const run = createHarness({
    workflow, steps, source: state.source, pre: [state.pre], post: [state.post], answers: { spec: SPEC },
    ...(formerLogins === undefined ? {} : { config: { tracker: { formerLogins } } }),
    log: (name, data = {}) => { events.push([name, data]); },
  });
  const lastRun = (): Run | undefined =>
    (events.filter(([name]) => name === "snapshot.built").at(-1)?.[1].snapshot as Snapshot | undefined)?.run as Run | undefined;
  return { run, events, lastRun };
}

/**
 * An item whose spec ran under the login landrace used to post as: every
 * record there is `old`'s, dated before T (the in-memory clock starts at
 * 2026-01-01), and the item sits at `waiting` — or at `spec`, as though the
 * crash came before the status moved.
 */
async function switched(at: "waiting" | "spec"): Promise<ExternalState> {
  const state = createExternalState({ items: [{ id: "1", labels: ["lr:auto"] }] });
  const first = await drive(state);
  await first.run.converge();
  expect(state.stage("1")).toBe("waiting");
  for (const c of state.item("1").comments) if (c.user?.login === "landrace") c.user = { login: "old" };
  if (at === "spec") {
    state.unlabel("1", "lr:stage:waiting");
    state.label("1", "lr:stage:spec");
  }
  return state;
}

const markers = (state: ExternalState): string[] =>
  state.item("1").comments.flatMap((c) => {
    const marker = parseMarker(c.body)?.marker;
    return typeof marker === "string" ? [marker] : [];
  });

describe("a tracker login change, through the engine", () => {
  it("does not re-enter a stage old finished before its until, and posts nothing", async () => {
    const state = await switched("spec");
    const before = state.item("1").comments.length;
    const { run, lastRun } = await drive(state, [{ login: "old", until: T }]);
    const { calls, trail } = await run.converge();
    expect(calls).toEqual([]);
    expect(trail.at(-1)).toBe("waiting");
    expect(state.item("1").comments).toHaveLength(before);
    expect(lastRun()?.counters.spec).toBe(1);
  });

  it("reads old's records and new ones as one run: its counters continue", async () => {
    const state = await switched("waiting");
    const { run } = await drive(state, [{ login: "old", until: T }]);
    state.say("1", "Not quite: try again.");
    const { calls, trail } = await run.converge();
    expect(calls.map((c) => [c.stage, c.round])).toEqual([["spec", 2]]);
    expect(markers(state)).toContain("enter:spec:2");
    expect(markers(state)).not.toContain("enter:spec:3");
    expect(trail.at(-1)).toBe("done");
  });

  it("without the list, keeps old's marks out of entries and lastHuman: a lastHuman trigger stays silent", async () => {
    const state = await switched("waiting");
    const { run, lastRun } = await drive(state, []);
    const { calls, trail } = await run.converge();
    expect(calls).toEqual([]);
    // Evaluated where it is, and moved nowhere: `again` did not fire.
    expect(trail).toEqual(["waiting"]);
    expect(lastRun()?.lastHuman).toBeNull();
    expect(lastRun()?.counters.spec).toBeUndefined();
  });

  it("with a config that has no tracker block at all, does not halt, and reads old's marks as foreign", async () => {
    const state = await switched("waiting");
    const { run, lastRun } = await drive(state);
    const { result } = await run.converge();
    expect(result.settled).not.toBe("halt");
    expect(lastRun()?.lastHuman).toBeNull();
  });

  it("says records.foreign once over two ticks, naming the item, the count and old as unlisted", async () => {
    const state = await switched("waiting");
    const foreign = state.item("1").comments.filter((c) => parseMarker(c.body) !== null).length;
    const { run, events } = await drive(state, []);
    await run.converge();
    await run.converge();
    expect(events.filter(([name]) => name === "records.foreign")).toEqual([
      ["records.foreign", { item: "1", count: foreign, authors: [{ login: "old", why: "unlisted" }] }],
    ]);
  });

  it("names why for old's marks after its until", async () => {
    const state = await switched("waiting");
    for (const c of state.item("1").comments) {
      c.created_at = AFTER;
      c.updated_at = AFTER;
    }
    const { run, events } = await drive(state, [{ login: "old", until: T }]);
    await run.converge();
    expect(events.find(([name]) => name === "records.foreign")?.[1]).toMatchObject({ authors: [{ login: "old", why: "after-until" }] });
  });

  it("reads a plain comment from any author as lastHuman, old's after its until included", async () => {
    const state = await switched("waiting");
    state.item("1").comments.push({ id: 9_001, body: "please redo it", created_at: AFTER, updated_at: AFTER, user: { login: "old" } });
    const { run, lastRun } = await drive(state, [{ login: "old", until: T }]);
    const { calls } = await run.converge();
    expect(calls.map((c) => c.stage)).toEqual(["spec"]);
    expect(lastRun()?.lastHuman?.data).toMatchObject({ author: "old", body: "please redo it" });
  });

  it("lets an author in neither list complete nothing: a stranger's copy of the output is not the stage's", async () => {
    const state = await switched("spec");
    for (const c of state.item("1").comments) c.user = { login: "mallory" };
    const { run } = await drive(state, [{ login: "old", until: T }]);
    const { calls } = await run.converge();
    expect(calls.map((c) => c.stage)).toEqual(["spec"]);
  });
});
