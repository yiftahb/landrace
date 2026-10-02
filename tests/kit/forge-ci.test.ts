import { deriveRel } from "#core/rel.js";
import { compose } from "#kit/compose.js";
import { BRIEF_CI_CHARS, BRIEF_LOG_CHARS } from "#kit/forge.js";
import { createExternalState, createHarness, MemoryForge, MemoryTracker } from "#testing/index.js";
import { loadWorkflow } from "#workflow/load.js";
import type {
  ComposedHooks, Effect, ExternalState, Graph, HookContext, Logger, MergeAnswer, PostHook, RuntimeContext, Snapshot,
} from "#namespace.js";

/**
 * A pull request's CI, read on its head commit, and the merge that waits for
 * it: driven through `compose` over the in-memory forge, so what runs is the
 * kit's own `read()`, `pull.merge` and `ci` briefing — the same code every
 * vendor's forge inherits.
 */
const ctx = { config: {}, secrets: new Map(), signal: new AbortController().signal, log: () => {} } as unknown as RuntimeContext;

const read = async (hooks: ComposedHooks, item = "7"): Promise<Snapshot & { graph: Graph }> => {
  const graph = await hooks.source.read(item, ctx);
  return { graph, node: graph.nodes.find((n) => n.id === item) };
};

const stateOf = async (hooks: ComposedHooks, id: string): Promise<Record<string, unknown> | undefined> =>
  (await read(hooks)).graph.nodes.find((n) => n.id === id)?.state;

const apply = (hooks: ComposedHooks, effect: Effect, snapshot: Snapshot, log: HookContext["log"] = () => {}): Promise<void> =>
  hooks.post.apply(effect, { ...ctx, item: "7", snapshot, log } as HookContext);

const ciBrief = async (hooks: ComposedHooks): Promise<string> => {
  if (!hooks.source.brief) throw new Error("the composed source briefs nothing");
  const briefed = await hooks.source.brief({ ...ctx, item: "7", snapshot: {} } as HookContext);
  const ci = briefed.ci;
  if (ci === undefined) throw new Error(`no ci briefing among ${Object.keys(briefed).join(", ")}`);
  return ci;
};

const state = (): ExternalState => createExternalState({ items: [{ id: "7" }] });

/** The memory forge itself, for a test that counts what it was asked or what it answered. */
const world = (): { hooks: ComposedHooks; forge: MemoryForge; answers: MergeAnswer[] } => {
  const forge = new MemoryForge();
  const answers: MergeAnswer[] = [];
  const merge = forge.merge.bind(forge);
  forge.merge = async (pull, headSha) => {
    const answer = await merge(pull, headSha);
    answers.push(answer);
    return answer;
  };
  return { hooks: compose({ tracker: new MemoryTracker({ items: [{ id: "7" }] }), forge }), forge, answers };
};

describe("a pull request's checks", () => {
  it.each([
    ["failure", 0, 1],
    ["pending", 1, 0],
    ["success", 0, 0],
    ["none", 0, 0],
  ] as const)("puts %s and its two counts on an open pull request", async (checks, ciPending, ciFailed) => {
    const s = state();
    const pr = s.openPull("7", { checks });
    expect(await stateOf(s, pr)).toMatchObject({ checks, ciPending, ciFailed });
  });

  it("reads a closed pull request as none, with no checks call", async () => {
    const { hooks, forge } = world();
    const merged = forge.add("7", { merged: true, checks: "failure" });
    const dropped = forge.add("7", { closed: "dropped", checks: "pending" });
    expect(await stateOf(hooks, merged)).toMatchObject({ checks: "none", ciPending: 0, ciFailed: 0 });
    expect(await stateOf(hooks, dropped)).toMatchObject({ checks: "none", ciPending: 0, ciFailed: 0 });
    expect(forge.checkCalls).toBe(0);
    // And an open one is asked: the count is the read's, not a constant.
    forge.add("7", { checks: "failure" });
    await read(hooks);
    expect(forge.checkCalls).toBe(1);
  });

  it("lets a workflow count failures across pull requests", async () => {
    const s = state();
    s.openPull("7", { checks: "failure" });
    s.openPull("7", { checks: "success" });
    s.openPull("7", { merged: true, checks: "failure" });
    const rel = deriveRel((await read(s)).graph, "7", ["implements"]);
    if (!rel.ok) throw new Error(rel.why);
    expect(rel.rel.implements?.in.total).toBe(3);
    expect(rel.rel.implements?.in.sum).toMatchObject({ ciFailed: 1, ciPending: 0 });
  });

  it("carries no checks on a listed pull request, which is never asked for them", async () => {
    const { hooks, forge } = world();
    const pr = forge.add("7", { checks: "failure" });
    const listed = await hooks.source.list(ctx);
    expect(listed.nodes.find((n) => n.id === pr)?.state).not.toHaveProperty("checks");
    expect(forge.checkCalls).toBe(0);
  });
});

describe("pull.merge", () => {
  const merge = { type: "pull.merge", branch: "landrace/7" };

  it("merges the open pull request from the branch at the head its snapshot read", async () => {
    const { hooks, forge, answers } = world();
    const pr = forge.add("7", { branch: "landrace/7", checks: "success", headSha: "abc" });
    const snapshot = await read(hooks);
    expect(hooks.post.satisfied(snapshot, merge)).toBe(false);

    await apply(hooks, merge, snapshot);

    expect(forge.pull(pr)).toMatchObject({ merged: true, closed: "done" });
    expect(answers).toEqual(["merged"]);
    expect(hooks.post.satisfied(await read(hooks), merge)).toBe(true);
  });

  it("merges when nothing checks the pull request", async () => {
    const s = state();
    const pr = s.openPull("7", { branch: "landrace/7", checks: "none", headSha: "abc" });
    await apply(s, merge, await read(s));
    expect(s.pull(pr)).toMatchObject({ merged: true, closed: "done" });
  });

  it.each(["pending", "failure"] as const)("refuses to merge while checks are %s, saying so", async (checks) => {
    const s = state();
    // A whole SHA, so the sentence's short one is the one asserted.
    const pr = s.openPull("7", { branch: "landrace/7", checks, headSha: `abc1234${"0".repeat(33)}` });
    await expect(apply(s, merge, await read(s))).rejects.toThrow(`will not merge pr-1 for #7: its checks on abc1234 are ${checks}`);
    expect(s.pull(pr)).toMatchObject({ merged: false, closed: null });
  });

  it("refuses a pull request whose checks were never read", async () => {
    const s = state();
    const pr = s.openPull("7", { branch: "landrace/7", checks: "success", headSha: "abc" });
    const snapshot = await read(s);
    // As a node the kit's read() did not build carries them: a listing's, or a forge's own node().
    const node = snapshot.graph.nodes.find((n) => n.id === pr);
    if (!node) throw new Error(`no ${pr} in the read`);
    delete node.state.checks;
    delete node.state.ciPending;
    delete node.state.ciFailed;
    await expect(apply(s, merge, snapshot)).rejects.toThrow(/will not merge pr-1 for #7: its checks on abc are unread/);
    expect(s.pull(pr).merged).toBe(false);
  });

  it("refuses a pull request a person closed after the read, and leaves it closed", async () => {
    const { hooks, forge, answers } = world();
    const pr = forge.add("7", { branch: "landrace/7", checks: "success", headSha: "abc" });
    const snapshot = await read(hooks);
    forge.pull(pr).closed = "dropped";
    await expect(apply(hooks, merge, snapshot)).rejects.toThrow("will not merge pr-1 for #7: it was closed without being merged after it was read");
    expect(answers).toEqual([]);
    expect(forge.pull(pr)).toMatchObject({ merged: false, closed: "dropped" });
  });

  it("refuses, as the in-memory forge itself, to merge one a person closed", async () => {
    const forge = new MemoryForge();
    const pr = forge.add("7", { branch: "landrace/7", closed: "dropped", headSha: "abc" });
    await expect(forge.merge(1, "abc")).rejects.toThrow("pr-1 for #7 was closed without being merged, so there is nothing to merge");
    expect(forge.pull(pr)).toMatchObject({ merged: false, closed: "dropped" });
  });

  it("refuses one the forge will not merge, as a real forge does, saying so", async () => {
    const s = state();
    const pr = s.openPull("7", { branch: "landrace/7", checks: "success", headSha: "abc", mergeable: false });
    await expect(apply(s, merge, await read(s))).rejects.toThrow("pr-1 for #7 cannot be merged: the forge finds it not mergeable");
    expect(s.pull(pr)).toMatchObject({ merged: false, closed: null });
  });

  it("answers moved, not a refusal, for an unmergeable one whose head moved", async () => {
    const forge = new MemoryForge();
    const pr = forge.add("7", { branch: "landrace/7", headSha: "new", mergeable: false });
    expect(await forge.merge(1, "old")).toBe("moved");
    expect(forge.pull(pr)).toMatchObject({ merged: false, closed: null });
  });

  it.each(["pending", "failure"] as const)("refuses when its checks turned %s on the same head after the read", async (checks) => {
    const { hooks, forge, answers } = world();
    const pr = forge.add("7", { branch: "landrace/7", checks: "success", headSha: "abc" });
    const snapshot = await read(hooks);
    forge.pull(pr).checks = checks; // CI registered on the same commit after the read
    await expect(apply(hooks, merge, snapshot)).rejects.toThrow(`will not merge pr-1 for #7: its checks on abc are ${checks}`);
    expect(answers).toEqual([]);
    expect(forge.pull(pr)).toMatchObject({ merged: false, closed: null });
  });

  it("refuses one that is no longer among the item's pull requests", async () => {
    const { hooks, forge, answers } = world();
    const pr = forge.add("7", { branch: "landrace/7", checks: "success", headSha: "abc" });
    const snapshot = await read(hooks);
    forge.rows.delete(pr);
    await expect(apply(hooks, merge, snapshot)).rejects.toThrow("will not merge pr-1 for #7: the forge no longer names it among the item's pull requests");
    expect(answers).toEqual([]);
  });

  it("counts a pull request that reads merged as merged, not open, whatever its closed field says", async () => {
    const s = state();
    s.openPull("7", { branch: "landrace/7", merged: true, closed: null });
    expect(s.post.satisfied(await read(s), merge)).toBe(true);
  });

  it("refuses a pull request whose head was not read, rather than merging whatever is there", async () => {
    const s = state();
    const pr = s.openPull("7", { branch: "landrace/7", checks: "success", headSha: "" });
    await expect(apply(s, merge, await read(s))).rejects.toThrow(/will not merge pr-1 for #7: .*head/);
    expect(s.pull(pr).merged).toBe(false);
  });

  it("leaves a pull request whose head moved unmerged, unsatisfied, and does not throw", async () => {
    const { hooks, forge, answers } = world();
    const pr = forge.add("7", { branch: "landrace/7", checks: "success", headSha: "abc" });
    const snapshot = await read(hooks);
    forge.pull(pr).headSha = "def"; // a push landed after the read
    const log = jest.fn();

    await expect(apply(hooks, merge, snapshot, log)).resolves.toBeUndefined();

    // Seen on the read at apply, so the forge is never asked to merge.
    expect(answers).toEqual([]);
    expect(forge.pull(pr)).toMatchObject({ merged: false, closed: null });
    const after = await read(hooks);
    expect(hooks.post.satisfied(after, merge)).toBe(false);
    expect(after.graph.nodes.find((n) => n.id === pr)?.state).toMatchObject({ headSha: "def" });
    expect(log).toHaveBeenCalledWith("forge.merge.moved", expect.objectContaining({ pull: pr, branch: "landrace/7", headSha: "abc" }));
  });

  it("leaves it unmerged when the head moves after the read at apply, by the forge's own guard", async () => {
    const { hooks, forge, answers } = world();
    const pr = forge.add("7", { branch: "landrace/7", checks: "success", headSha: "abc" });
    const snapshot = await read(hooks);
    const naming = forge.pullsNaming.bind(forge);
    jest.spyOn(forge, "pullsNaming").mockImplementation(async (item) => {
      const pulls = await naming(item);
      forge.pull(pr).headSha = "def"; // a push lands between the read at apply and the merge
      return pulls;
    });
    const log = jest.fn();

    await expect(apply(hooks, merge, snapshot, log)).resolves.toBeUndefined();

    expect(answers).toEqual(["moved"]);
    expect(forge.pull(pr)).toMatchObject({ merged: false, closed: null, headSha: "def" });
    expect(log).toHaveBeenCalledWith("forge.merge.moved", expect.objectContaining({ pull: pr, branch: "landrace/7", headSha: "abc" }));
  });

  it("answers an already merged pull request as merged", async () => {
    // A crash after the merge and before the next read: the same snapshot
    // is applied again, and the forge says it is merged rather than refusing.
    const { hooks, forge, answers } = world();
    const pr = forge.add("7", { branch: "landrace/7", checks: "success", headSha: "abc" });
    const snapshot = await read(hooks);
    await apply(hooks, merge, snapshot);
    await expect(apply(hooks, merge, snapshot)).resolves.toBeUndefined();
    // The read at apply sees it merged: done, and the forge is not asked again.
    expect(answers).toEqual(["merged"]);
    expect(forge.pull(pr)).toMatchObject({ merged: true, closed: "done" });
    expect(hooks.post.satisfied(await read(hooks), merge)).toBe(true);
  });

  it("is not satisfied by an old merged pull request while a new one from the branch is open", async () => {
    const s = state();
    const old = s.openPull("7", { branch: "landrace/7", merged: true, headSha: "old" });
    const fresh = s.openPull("7", { branch: "landrace/7", checks: "success", headSha: "new" });
    expect(s.post.satisfied(await read(s), merge)).toBe(false);

    await apply(s, merge, await read(s));

    expect(s.pull(fresh)).toMatchObject({ merged: true, closed: "done" });
    expect(s.pull(old)).toMatchObject({ merged: true, closed: "done" });
    expect(s.post.satisfied(await read(s), merge)).toBe(true);
  });

  it("halts on two open pull requests from one branch, naming both", async () => {
    const s = state();
    s.openPull("7", { branch: "landrace/7", checks: "success" });
    s.openPull("7", { branch: "landrace/7", checks: "success" });
    expect(s.post.satisfied(await read(s), merge)).toBe(false);
    await expect(apply(s, merge, await read(s))).rejects.toThrow(/pr-1.*pr-2/);
    expect([s.pull("pr-1").merged, s.pull("pr-2").merged]).toEqual([false, false]);
  });

  it("halts when no pull request from the branch is open", async () => {
    const s = state();
    s.openPull("7", { branch: "landrace/7", closed: "dropped", checks: "success" });
    s.openPull("7", { branch: "other/7", checks: "success" });
    expect(s.post.satisfied(await read(s), merge)).toBe(false);
    await expect(apply(s, merge, await read(s))).rejects.toThrow(/no open pull request from landrace\/7/);
    expect(s.pull("pr-2").merged).toBe(false);
  });

  it("refuses a merge that names no branch", async () => {
    const s = state();
    expect(() => s.post.satisfied({}, { type: "pull.merge" })).toThrow(/pull.merge effect must name the branch/);
  });
});

describe("the ci briefing", () => {
  it("says each open pull request's checks, and each failed check's log tail", async () => {
    const s = state();
    s.openPull("7", {
      checks: "failure",
      failed: [{ name: "test", log: "x".repeat(9000) + "END" }, { name: "lint", log: null }],
    });
    s.openPull("7", { checks: "success" });
    const ci = await ciBrief(s);

    expect(ci).toContain("### pr-1: checks failure");
    expect(ci).toContain("### pr-2: checks success");
    const log = /#### test\n\n```\n([\s\S]*?)\n```/.exec(ci)?.[1];
    if (log === undefined) throw new Error(`no fenced log under "#### test" in:\n${ci.slice(0, 500)}`);
    expect(log.endsWith("END")).toBe(true);
    expect(log.startsWith("…")).toBe(true);
    expect(log.length).toBe(BRIEF_LOG_CHARS + 1);
    expect(ci).toContain("#### lint\n\n(log unavailable)");
  });

  it("cuts the whole briefing, however many checks failed", async () => {
    const s = state();
    s.openPull("7", {
      checks: "failure",
      failed: Array.from({ length: 6 }, (_, i) => ({ name: `job ${i}`, log: "y".repeat(BRIEF_LOG_CHARS) })),
    });
    const ci = await ciBrief(s);
    expect(ci.length).toBe(BRIEF_CI_CHARS + 1);
    expect(ci.endsWith("…")).toBe(true);
  });

  it("asks for failed checks only of a failing pull request", async () => {
    const { hooks, forge } = world();
    forge.add("7", { checks: "pending", failed: [{ name: "test", log: "boom" }] });
    const asked = jest.spyOn(forge, "failedChecks");
    const ci = await ciBrief(hooks);
    expect(ci).toContain("### pr-1: checks pending");
    expect(ci).not.toContain("#### test");
    expect(asked).not.toHaveBeenCalled();
  });

  it("says when a failing pull request names no failed check", async () => {
    const s = state();
    s.openPull("7", { checks: "failure" });
    expect(await ciBrief(s)).toContain("### pr-1: checks failure\n\n(the forge named no failed check)");
  });

  it("says when there is no open pull request", async () => {
    const s = state();
    s.openPull("7", { merged: true, checks: "failure", failed: [{ name: "test", log: "boom" }] });
    const ci = await ciBrief(s);
    expect(ci).toContain("no open pull request");
    expect(ci).not.toContain("pr-1");
  });
});

/*
 * A route effect is applied with the snapshot read before its step ran,
 * which can be minutes old: CI that registered and failed on the same commit
 * while the step ran must still hold the merge back.
 */
describe("pull.merge as a route effect", () => {
  it("refuses a head whose checks went red on the same commit while the step ran", async () => {
    const s = createExternalState({ items: [{ id: "7", labels: ["lr:auto"] }] });
    // Just pushed: nothing has registered on the head yet.
    const pr = s.openPull("7", { branch: "landrace/7", checks: "none", headSha: "abc" });
    const { workflow, steps } = await loadWorkflow("tests/fixtures/merge-route");
    const answer = 'Looks good.\n\n```json\n{"kind":"approved","note":"ok"}\n```';
    const events: Array<[string, Record<string, unknown> | undefined]> = [];
    const log: Logger = (name, data) => { events.push([name, data]); };
    const run = createHarness({
      workflow, steps, source: s.source, pre: [s.pre], post: [s.post], item: "7", answers: { review: answer }, log,
      during: () => { s.pull(pr).checks = "failure"; },
    });

    await run.converge();

    expect(s.pull(pr)).toMatchObject({ merged: false, closed: null, checks: "failure", headSha: "abc" });
    expect(s.stage("7")).not.toBe("done");
    const failed = events.find(([name]) => name === "effect.failed");
    expect(JSON.stringify(failed?.[1])).toContain("will not merge pr-1 for #7: its checks on abc are failure");
  });
});

/*
 * The runner, over a head that moved: `apply` returned without merging, the
 * effect is still unsatisfied, and nothing after an apply asks again — so
 * the item settles where its workflow put it rather than halting.
 */
describe("a tick over a head that moved", () => {
  it("leaves the pull request open and the item un-halted", async () => {
    const s = createExternalState({ items: [{ id: "7", labels: ["lr:auto"] }] });
    const pr = s.openPull("7", { branch: "landrace/7", checks: "success", headSha: "abc" });
    const { workflow, steps } = await loadWorkflow("tests/fixtures/merge");
    // A push lands between the read the merge was planned from and the merge itself.
    const pushed: PostHook = {
      ...s.post,
      apply: async (effect, c) => {
        if (effect.type === "pull.merge") s.pull(pr).headSha = "def";
        return s.post.apply(effect, c);
      },
    };
    const events: string[] = [];
    const log: Logger = (name) => { events.push(name); };
    const run = createHarness({ workflow, steps, source: s.source, pre: [s.pre], post: [pushed], item: "7", log });

    const { result } = await run.converge();

    // Waiting at `merge` for a trigger, as the fixture's workflow leaves it; never halted.
    expect(result).toMatchObject({ settled: "wait", why: "no trigger matched" });
    expect(events).not.toContain("effect.failed");
    expect(events).toContain("effect.applied");
    expect(s.pull(pr)).toMatchObject({ merged: false, closed: null, headSha: "def" });
    expect(s.stage("7")).toBe("merge");
  });
});

/*
 * pull.close: what a workflow that drops an item does to the pull request it
 * opened — every open one from the branch closed without merging, and never
 * one that is merged, by the read or since it.
 */
describe("pull.close", () => {
  const close = { type: "pull.close", branch: "landrace/7" };

  it("closes the open pull request from the branch, and is satisfied after", async () => {
    const { hooks, forge } = world();
    const pr = forge.add("7", { branch: "landrace/7" });
    const snapshot = await read(hooks);
    expect(hooks.post.satisfied(snapshot, close)).toBe(false);

    await apply(hooks, close, snapshot);

    expect(forge.pull(pr)).toMatchObject({ merged: false, closed: "dropped" });
    expect(hooks.post.satisfied(await read(hooks), close)).toBe(true);
  });

  it("closes every open one from the branch", async () => {
    const { hooks, forge } = world();
    const first = forge.add("7", { branch: "landrace/7" });
    const second = forge.add("7", { branch: "landrace/7" });
    await apply(hooks, close, await read(hooks));
    expect([forge.pull(first).closed, forge.pull(second).closed]).toEqual(["dropped", "dropped"]);
  });

  it("leaves a merged pull request, and an open one from another branch, as they are", async () => {
    const { hooks, forge } = world();
    const merged = forge.add("7", { branch: "landrace/7", merged: true });
    const other = forge.add("7", { branch: "landrace/7-docs" });
    const closes = jest.spyOn(forge, "closePull");
    const snapshot = await read(hooks);
    expect(hooks.post.satisfied(snapshot, close)).toBe(true);

    await apply(hooks, close, snapshot);

    expect(closes).not.toHaveBeenCalled();
    expect(forge.pull(merged)).toMatchObject({ merged: true, closed: "done" });
    expect(forge.pull(other)).toMatchObject({ merged: false, closed: null });
  });

  it("never closes one merged since the read", async () => {
    const { hooks, forge } = world();
    const pr = forge.add("7", { branch: "landrace/7" });
    const snapshot = await read(hooks);
    Object.assign(forge.pull(pr), { merged: true, closed: "done" });
    const closes = jest.spyOn(forge, "closePull");

    await apply(hooks, close, snapshot);

    expect(closes).not.toHaveBeenCalled();
    expect(forge.pull(pr)).toMatchObject({ merged: true, closed: "done" });
  });

  it("never closes one merged since the read, though another of the item's pull requests is open", async () => {
    const { hooks, forge } = world();
    const pr = forge.add("7", { branch: "landrace/7" });
    const other = forge.add("7", { branch: "landrace/7-docs" });
    const snapshot = await read(hooks);
    Object.assign(forge.pull(pr), { merged: true, closed: "done" });
    const closes = jest.spyOn(forge, "closePull");

    await apply(hooks, close, snapshot);

    expect(closes).not.toHaveBeenCalled();
    expect(forge.pull(other)).toMatchObject({ merged: false, closed: null });
  });

  it("is idempotent: applied again, on the old read or a new one, it closes nothing more", async () => {
    const { hooks, forge } = world();
    forge.add("7", { branch: "landrace/7" });
    const snapshot = await read(hooks);
    const closes = jest.spyOn(forge, "closePull");

    await apply(hooks, close, snapshot);
    await apply(hooks, close, snapshot);
    await apply(hooks, close, await read(hooks));

    expect(closes).toHaveBeenCalledTimes(1);
  });

  it("refuses an effect that names no branch", async () => {
    const { hooks, forge } = world();
    forge.add("7", { branch: "landrace/7" });
    expect(() => hooks.post.satisfied({ graph: { nodes: [], relationships: [] } }, { type: "pull.close" })).toThrow(/branch/);
  });
});
