import { isEffectRefused, parseMarker } from "#conventions.js";
import { createdSatisfied } from "#kit/tracker.js";
import { createExternalState } from "#testing/index.js";
import type { Effect, ExternalState, HookContext, RuntimeContext, Snapshot } from "#namespace.js";

/*
 * `tracker.create`: an issue filed in another project of the tracker, linked
 * to the item, unlabelled so nothing works it here, and a `created` record
 * on the item naming it — only where the tracker opts in.
 */
const ctx: RuntimeContext = { config: {} as RuntimeContext["config"], secrets: new Map(), signal: new AbortController().signal, log: () => {} };

const bug = (over: Partial<Effect> = {}): Effect => ({
  type: "tracker.create", project: "ENG", title: "Crash on export", body: "Stack trace",
  stage: "diagnose", round: 1, kind: "part", marker: "part:diagnose:1:2", ...over,
});

const hookCtx = async (state: ExternalState): Promise<HookContext> => {
  const base = { ...ctx, item: "1" };
  return { ...base, snapshot: (await state.pre.run(base as HookContext)) as unknown as Snapshot };
};

const snapshotOf = async (state: ExternalState): Promise<Snapshot> => (await hookCtx(state)).snapshot;

describe("a tracker that does not opt in", () => {
  it("creates in no project, and refuses a tracker.create, filing nothing", async () => {
    const state = createExternalState({ items: [{ id: "1" }] });
    expect(state.post.creates).toEqual([]);
    const refused = await state.post.apply(bug(), await hookCtx(state)).catch((e: unknown) => e);
    expect(isEffectRefused(refused)).toBe(true);
    expect((refused as Error).message).toMatch(/files issues in no other project, not "ENG"/);
    expect(state.filed()).toEqual([]);
    expect(state.comments("1")).toEqual([]);
  });
});

describe("a tracker that creates in ENG", () => {
  const opted = () => createExternalState({ items: [{ id: "1" }], createIn: ["ENG"] });

  it("says so on its post hook", () => {
    expect(opted().post.creates).toEqual(["ENG"]);
  });

  it("files one unlabelled issue linked to the item, and records it on the item by its key", async () => {
    const state = opted();
    await state.post.apply(bug(), await hookCtx(state));

    expect(state.filed()).toEqual([
      expect.objectContaining({ key: "ENG-1", project: "ENG", title: "Crash on export", body: "Stack trace", item: "1", labels: [] }),
    ]);
    // Never one of the tracker's own items: it is listed nowhere.
    expect((await state.source.list(ctx)).nodes.map((n) => n.id)).toEqual(["1"]);
    const [record] = state.comments("1");
    expect(record).toMatch(/^Filed ENG-1: Crash on export/);
    expect(parseMarker(record ?? "")).toMatchObject({ kind: "created", stage: "diagnose", round: 1, marker: "created:part:diagnose:1:2" });
  });

  it("is satisfied by its record, so a replan files none", async () => {
    const state = opted();
    expect(state.post.satisfied(await snapshotOf(state), bug())).toBe(false);
    await state.post.apply(bug(), await hookCtx(state));
    expect(state.post.satisfied(await snapshotOf(state), bug())).toBe(true);
    // Another part's issue is not this one's.
    expect(state.post.satisfied(await snapshotOf(state), bug({ marker: "part:diagnose:1:3" }))).toBe(false);
  });

  it("reuses the issue it already filed when the record never landed", async () => {
    const state = opted();
    await state.post.apply(bug(), await hookCtx(state));
    state.item("1").comments = []; // a crash between filing the issue and recording it
    await state.post.apply(bug(), await hookCtx(state));
    expect(state.filed()).toHaveLength(1);
    expect(state.comments("1")[0]).toMatch(/^Filed ENG-1/);
  });

  it("refuses a project it does not create in", async () => {
    const state = opted();
    const refused = await state.post.apply(bug({ project: "OPS" }), await hookCtx(state)).catch((e: unknown) => e);
    expect(isEffectRefused(refused)).toBe(true);
    expect((refused as Error).message).toMatch(/files issues in "ENG", not "OPS"/);
    expect(state.filed()).toEqual([]);
  });

  it("refuses an effect with no title", async () => {
    const state = opted();
    const refused = await state.post.apply(bug({ title: "" }), await hookCtx(state)).catch((e: unknown) => e);
    expect((refused as Error).message).toMatch(/names no title/);
  });

  it("escapes what it files, so the issue carries no marker of ours", async () => {
    const state = opted();
    await state.post.apply(bug({ title: "t <!-- x -->", body: "b <!-- landrace {} -->" }), await hookCtx(state));
    const [filed] = state.filed();
    expect(filed?.body).not.toContain("<!--");
    expect(filed?.title).not.toContain("<!--");
  });
});

describe("createdSatisfied", () => {
  it("cannot reconcile an effect with no marker, and says so", () => {
    const snapshot = { item: { comments: [] }, tracker: { bot: "bot" } } as unknown as Snapshot;
    expect(() => createdSatisfied(snapshot, bug({ marker: undefined }))).toThrow(/no marker cannot be reconciled/);
  });

  it("reads only a record we wrote", () => {
    const body = "Filed ENG-1\n\n<!-- landrace {\"stage\":\"diagnose\",\"kind\":\"created\",\"round\":1,\"marker\":\"created:part:diagnose:1:2\"} -->";
    const by = (login: string) => ({ item: { comments: [{ body, user: { login } }] }, tracker: { bot: "bot" } }) as unknown as Snapshot;
    expect(createdSatisfied(by("bot"), bug())).toBe(true);
    expect(createdSatisfied(by("stranger"), bug())).toBe(false);
  });
});
