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
    const pr = s.openPull("7", { branch: "landrace/7", checks, headSha: "abc" });
    await expect(apply(s, merge, await read(s))).rejects.toThrow(`will not merge pr-1 for #7: its checks on abc are ${checks}`);
    expect(s.pull(pr)).toMatchObject({ merged: false, closed: null });
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

    expect(answers).toEqual(["moved"]);
    expect(forge.pull(pr)).toMatchObject({ merged: false, closed: null });
    const after = await read(hooks);
    expect(hooks.post.satisfied(after, merge)).toBe(false);
    expect(after.graph.nodes.find((n) => n.id === pr)?.state).toMatchObject({ headSha: "def" });
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
    expect(answers).toEqual(["merged", "merged"]);
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

  it("says when there is no open pull request", async () => {
    const s = state();
    s.openPull("7", { merged: true, checks: "failure", failed: [{ name: "test", log: "boom" }] });
    const ci = await ciBrief(s);
    expect(ci).toContain("no open pull request");
    expect(ci).not.toContain("pr-1");
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
