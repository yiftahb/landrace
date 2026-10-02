import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { ensureWorktree, removeWorktree } from "#agent/worktree.js";
import { labelsOf } from "#conventions.js";
import { fetchBranch, gitIn } from "#kit/git.js";
import { defineArtifactHook, definePostHook, definePreHook, defineSource } from "#hooks/contracts.js";
import type { Effect, Executor, HookContext, Node, Step, StepResult, Workflow } from "#namespace.js";
import { converge } from "#runner/converge.js";
import { createDispatcher } from "#runner/effects.js";
import { createLogger } from "#runner/events.js";
import { runStep } from "#runner/step.js";
import { commitOn, gitRepo as repo, gitRepoWithOrigin, plainDir, pushedElsewhere, removeRepos, worktreesOf as sandboxes } from "#tests/support/repo.js";

/*
 * Every test here starts real processes — git worktree operations, child
 * node — and on a machine whose endpoint-security agent inspects each exec,
 * starting one can take seconds when that agent is backed up. Measured: these
 * files ran 50-370 s in failing runs while most of their tests still passed,
 * which is slow, not hung. Jest's 5 s default turned that into failures that
 * looked like regressions. Sixty seconds still fails a real hang within a
 * minute; these tests normally take well under one.
 */
jest.setTimeout(60_000);

const exec = promisify(execFile);
type Fail = Extract<StepResult, { ok: false }>;

/**
 * An agent that does the forbidden thing: it writes into whatever working
 * directory it is handed. Nothing here asks its permission-mode flag — an
 * executor is free to ignore that, and one registered by a hook never sees it
 * at all, which is precisely why the engine has to check the result.
 */
const writer = (file: string, text = '```json\n{"kind":"spec"}\n```'): Executor => ({
  id: "writer",
  run: async (_prompt, { cwd }) => {
    if (cwd === undefined) throw new Error("the sandbox handed the agent no cwd");
    await writeFile(join(cwd, file), "export const planted = true;\n");
    return { text, sessionId: "sid-1" };
  },
});

const wellBehaved = (text = '```json\n{"kind":"spec"}\n```'): Executor => ({
  id: "quiet",
  run: async () => ({ text, sessionId: "sid-1" }),
});

const step = (capabilities?: string[]): Step => ({
  prompt: "write the spec",
  ...(capabilities === undefined ? {} : { capabilities }),
  output: {
    discriminator: "kind",
    shapes: { spec: {} },
    routes: [{ when: { kind: "spec" }, effect: { type: "tracker.comment", marker: "spec:{round}" } }],
  },
});

afterAll(removeRepos);

describe("a step that exceeds what it declared", () => {
  it("is refused when it writes to the worktree without repo:write, and the write is named", async () => {
    const root = await repo();
    const path = await ensureWorktree("101", root);

    const r = await runStep({
      item: "1", step: step(["repo:read"]),
      stageId: "spec", round: 1, snapshot: {},
      executor: writer("planted.ts"),
      signal: new AbortController().signal,
      sandbox: { path },
    });

    expect(r).toMatchObject({ ok: false, kind: "refused" });
    expect((r as Fail).reason).toMatch(/planted\.ts/);
    expect((r as Fail).reason).toMatch(/repo:write/);
    await removeWorktree("101", root);
  });

  /**
   * The tidy version of the same violation: `git add -A && git commit` leaves
   * the status completely clean, so a check reading only the status would wave
   * it through.
   */
  it("is refused when it commits, which leaves nothing for `git status` to report", async () => {
    const root = await repo();
    const path = await ensureWorktree("102", root);

    const committer: Executor = {
      id: "committer",
      run: async (_p, { cwd }) => {
        await writeFile(join(cwd as string, "src", "a.ts"), "export const a = 2;\n");
        await exec("git", ["add", "-A"], { cwd });
        await exec("git", ["commit", "-qm", "sneaky"], { cwd });
        return { text: '```json\n{"kind":"spec"}\n```', sessionId: "sid-1" };
      },
    };

    const r = await runStep({
      item: "1", step: step(["repo:read"]),
      stageId: "spec", round: 1, snapshot: {},
      executor: committer,
      signal: new AbortController().signal,
      sandbox: { path },
    });

    expect(r).toMatchObject({ ok: false, kind: "refused" });
    expect((r as Fail).reason).toMatch(/commit/i);
    await removeWorktree("102", root);
  });

  it("produces no effects when it is refused, so nothing it wrote reaches the tracker", async () => {
    const root = await repo();
    const path = await ensureWorktree("103", root);

    const r = await runStep({
      item: "1", step: step(["repo:read"]),
      stageId: "spec", round: 1, snapshot: {},
      executor: writer("planted.ts"),
      signal: new AbortController().signal,
      sandbox: { path },
    });
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty("effects");
    await removeWorktree("103", root);
  });

  it("lets the same write through for a step that declared repo:write", async () => {
    const root = await repo();
    const path = await ensureWorktree("104", root);

    const r = await runStep({
      item: "1", step: step(["repo:read", "repo:write"]),
      stageId: "spec", round: 1, snapshot: {},
      executor: writer("planted.ts"),
      signal: new AbortController().signal,
      sandbox: { path },
    });

    expect(r).toMatchObject({ ok: true });
    expect(existsSync(join(path, "planted.ts"))).toBe(true);
    await removeWorktree("104", root);
  });

  it("does not refuse a read-only step that touched nothing", async () => {
    const root = await repo();
    const path = await ensureWorktree("105", root);

    const r = await runStep({
      item: "1", step: step(["repo:read"]),
      stageId: "spec", round: 1, snapshot: {},
      executor: wellBehaved(),
      signal: new AbortController().signal,
      sandbox: { path },
    });
    expect(r).toMatchObject({ ok: true });
    await removeWorktree("105", root);
  });

  /**
   * A check that cannot run has verified nothing — the screener's own rule,
   * applied to the other half of the same control. The expensive half is the
   * ordering: an unreadable sandbox stops the step before it is paid for,
   * rather than after.
   */
  it("refuses, without invoking the agent, when it cannot read the worktree beforehand", async () => {
    let invoked = false;
    const spy: Executor = {
      id: "spy",
      run: async () => { invoked = true; return { text: "", sessionId: null }; },
    };

    const r = await runStep({
      item: "1", step: step(["repo:read"]),
      stageId: "spec", round: 1, snapshot: {},
      executor: spy,
      signal: new AbortController().signal,
      sandbox: { path: join(tmpdir(), "lr-not-a-worktree-at-all") },
    });

    expect(r).toMatchObject({ ok: false, kind: "refused" });
    expect((r as Fail).reason).toMatch(/worktree/i);
    expect(invoked).toBe(false);
  });

  it("refuses rather than throwing when the worktree is gone by the time the step ends", async () => {
    const root = await repo();
    const path = await ensureWorktree("106", root);
    const vanishing: Executor = {
      id: "vanishing",
      run: async () => {
        await rm(path, { recursive: true, force: true });
        return { text: '```json\n{"kind":"spec"}\n```', sessionId: "sid-1" };
      },
    };

    const r = await runStep({
      item: "1", step: step(["repo:read"]),
      stageId: "spec", round: 1, snapshot: {},
      executor: vanishing,
      signal: new AbortController().signal,
      sandbox: { path },
    });

    expect(r).toMatchObject({ ok: false, kind: "refused" });
    await removeWorktree("106", root);
  });

  /**
   * Fail closed before spending anything. A word the engine cannot enforce is
   * not a smaller problem than a violation — it is the operator believing in a
   * restriction that was never applied — so the agent must not run at all.
   */
  it("refuses a capability nothing enforces without invoking the agent", async () => {
    let invoked = false;
    const spy: Executor = {
      id: "spy",
      run: async () => { invoked = true; return { text: "", sessionId: null }; },
    };

    const r = await runStep({
      item: "1", step: step(["repo:read", "net:egress"]),
      stageId: "spec", round: 1, snapshot: {},
      executor: spy,
      signal: new AbortController().signal,
    });

    expect(r).toMatchObject({ ok: false, kind: "refused" });
    expect((r as Fail).reason).toMatch(/net:egress/);
    expect(invoked).toBe(false);
  });

  // A step file written before the rename must say what to write instead,
  // not just that the word is unknown.
  it("refuses the retired capability tickets:create, naming items:create", async () => {
    let invoked = false;
    const spy: Executor = { id: "spy", run: async () => { invoked = true; return { text: "", sessionId: null }; } };
    const r = await runStep({
      item: "1", step: step(["repo:read", "tickets:create"]),
      stageId: "spec", round: 1, snapshot: {},
      executor: spy,
      signal: new AbortController().signal,
    });
    expect(r).toMatchObject({ ok: false, kind: "refused" });
    expect((r as Fail).reason).toMatch(/"tickets:create" is now "items:create"/);
    expect(invoked).toBe(false);
  });

  it("hands the step's declaration to the executor, so the executor can enforce it too", async () => {
    let seen: readonly string[] | undefined;
    const spy: Executor = {
      id: "spy",
      run: async (_p, o) => { seen = o.capabilities; return { text: "", sessionId: null }; },
    };

    await runStep({
      item: "1", step: { prompt: "go" },
      stageId: "spec", round: 1, snapshot: {},
      executor: spy,
      signal: new AbortController().signal,
    });
    // A step declaring nothing is handed an empty set, not undefined: absent
    // must reach the executor as "the most restricted", not as "unspecified".
    expect(seen).toEqual([]);
  });
});

/* --------------------------------------------------------------- converge -- */

const stepWorkflow: Workflow = {
  version: 1, name: "t", description: "test",
  stages: [
    {
      id: "spec", step: "spec", entry: true,
      triggers: [{ when: { "run.stage": null } }],
      on_enter: [{ type: "tracker.status", value: "spec" }],
    },
    { id: "done", terminal: true, triggers: [{ when: { "run.outputs.spec": { $exists: true } } }] },
  ],
};

function world() {
  const labels = new Set<string>(["lr:auto"]);
  const entries: Array<Record<string, unknown>> = [];
  let clock = 0;
  return {
    labels, entries,
    source: defineSource({
      id: "w",
      relations: [],
      list: async () => ({ nodes: [], relationships: [] }),
      read: async (id) => ({
        nodes: [{
          id, kind: "item", title: `item ${id}`, link: `u/${id}`, closed: null, priority: null, origin: null,
          state: { labels: [...labels], assignees: [] },
        }],
        relationships: [],
      }),
    }),
    pre: definePreHook({
      id: "w",
      run: () => ({ entries: [...entries] }),
    }),
    post: definePostHook({
      id: "w",
      handles: ["tracker.status", "tracker.comment"],
      satisfied: (s, e) => {
        const present = labelsOf(s.node as Node | undefined);
        if (e.type === "tracker.status") return present.includes(`lr:stage:${String(e.value)}`);
        return entries.some((x) => x.marker === e.marker);
      },
      apply: async (e) => {
        if (e.type === "tracker.status") {
          for (const l of [...labels]) if (l.startsWith("lr:stage:")) labels.delete(l);
          labels.add(`lr:stage:${String(e.value)}`);
        } else {
          entries.push({
            stage: String(e.stage ?? "-"), kind: String(e.kind ?? "note"), round: Number(e.round ?? 0),
            data: e.output ?? { marker: e.marker }, marker: e.marker,
            at: new Date(clock++).toISOString(), byAgent: true,
          });
        }
      },
    }),
  };
}

const deps = (w: ReturnType<typeof world>, over: Record<string, unknown> = {}) => ({
  workflow: stepWorkflow,
  steps: new Map<string, Step>([["spec", step(["repo:read"])]]),
  source: w.source,
  pre: [w.pre],
  dispatcher: createDispatcher([w.post]),
  executor: wellBehaved(),
  ctx: {
    item: "1", config: {} as HookContext["config"], secrets: new Map(),
    signal: new AbortController().signal, log: () => {},
  },
  log: createLogger({ sink: () => {} }),
  ...over,
});

describe("converge and the sandbox", () => {
  it("runs the step in a worktree and leaves none behind afterwards", async () => {
    const root = await repo();
    let ranIn: string | undefined;
    const watcher: Executor = {
      id: "watcher",
      run: async (_p, { cwd }) => {
        ranIn = cwd;
        return { text: '```json\n{"kind":"spec"}\n```', sessionId: "sid-1" };
      },
    };

    await converge("1", deps(world(), { executor: watcher, sandbox: { root } }));

    expect(ranIn).toBeDefined();
    expect(ranIn).not.toBe(root);
    expect(await sandboxes(root)).toEqual([]);
    expect(existsSync(ranIn as string)).toBe(false);
  });

  it("leaves none behind when the agent dies mid-step", async () => {
    const root = await repo();
    const dying: Executor = {
      id: "dying",
      // What a timeout and a Ctrl-C both look like from here: the executor
      // rejects, converge unwinds, and nothing tidies up on the way out unless
      // the cleanup is on the unwinding path itself.
      run: async () => { throw new Error("agent exceeded 600000ms"); },
    };

    const r = await converge("1", deps(world(), { executor: dying, sandbox: { root } }));

    expect(r.settled).toBe("halt");
    expect(await sandboxes(root)).toEqual([]);
  });

  it("leaves none behind when the run is aborted between passes", async () => {
    const root = await repo();
    const stop = new AbortController();
    const abandoning: Executor = {
      id: "abandoning",
      run: async () => {
        stop.abort();
        return { text: '```json\n{"kind":"spec"}\n```', sessionId: "sid-1" };
      },
    };
    const w = world();
    const d = deps(w, { executor: abandoning, sandbox: { root } });
    d.ctx.signal = stop.signal;

    await converge("1", d);
    expect(await sandboxes(root)).toEqual([]);
  });

  it("leaves none behind when an effect hook throws after the step ran", async () => {
    const root = await repo();
    const w = world();
    // The real hook, refusing only the step's own output: everything before it
    // must still apply, or the stage is never entered and the step never runs,
    // and the test would pass by never reaching the code it is about.
    const angry = definePostHook({
      id: "angry",
      handles: ["tracker.status", "tracker.comment"],
      satisfied: (s, e) => w.post.satisfied(s, e),
      apply: async (e, ctx) => {
        if (e.kind === "output") throw new Error("the tracker is unhappy");
        await w.post.apply(e, ctx);
      },
    });

    const r = await converge("1", deps(w, { dispatcher: createDispatcher([angry]), sandbox: { root } }));
    expect(r.why).toMatch(/unhappy/);
    expect(await sandboxes(root)).toEqual([]);
  });

  /**
   * Ordering, and it is the point rather than a detail of it. Two features
   * landed a pre-step block at the same line of converge — the artifact
   * briefing and the worktree — and either order leaves the repository clean,
   * because the `finally` in `converge` removes the worktree on a halt return
   * too. What the order actually decides is whether a briefing that was always
   * going to fail is paid for with a git checkout first.
   *
   * Pinned against a root that is not a repository, so the two orders give
   * visibly different reasons: briefed first, the halt names the briefing;
   * sandboxed first, it names the missing repository. Swapping the blocks
   * fails this (verified).
   */
  it("reads the briefing before it cuts a worktree, so a briefing that fails costs no checkout", async () => {
    const notARepo = await plainDir();
    const pr = defineArtifactHook({
      id: "pr",
      handles: [],
      satisfied: () => true,
      apply: async () => {},
      read: async () => ({}),
      brief: () => { throw new Error("the pull request could not be read"); },
    });
    const briefed: Step = { ...step(["repo:read"]), prompt: "address {brief.pr.threads}" };

    const r = await converge("1", deps(world(), {
      steps: new Map<string, Step>([["spec", briefed]]),
      artifacts: [pr],
      sandbox: { root: notARepo },
    }));

    expect(r.settled).toBe("halt");
    expect(r.why).toMatch(/the pull request could not be read/);
    expect(r.why).not.toMatch(/git repository/i);
  });

  it("halts with a readable reason when the sandbox cannot be created, rather than crashing", async () => {
    const notARepo = await plainDir();
    const r = await converge("1", deps(world(), { sandbox: { root: notARepo } }));
    expect(r.settled).toBe("halt");
    expect(r.why).toMatch(/worktree|not a git repository/i);
  });

  /**
   * End to end, against the file system: a read-only step whose agent writes
   * is stopped, its write never reaches the operator's checkout, and the
   * item carries the refusal where a person can read it.
   */
  it("records the refusal on the item and keeps the write out of the repository", async () => {
    const root = await repo();
    const w = world();
    await converge("1", deps(w, { executor: writer("planted.ts"), sandbox: { root } }));

    expect(existsSync(join(root, "planted.ts"))).toBe(false);
    // A refusal, not a broken contract: the agent's answer may have been
    // perfectly readable — what it did to get there is what was refused.
    expect(w.entries.filter((e) => e.kind === "refused")).toHaveLength(1);
    expect(w.entries.filter((e) => e.kind === "malformed")).toHaveLength(0);
    expect(await sandboxes(root)).toEqual([]);
  });

  it("does not reach for a worktree at all when isolation is off", async () => {
    let ranIn: string | undefined = "unset";
    const watcher: Executor = {
      id: "watcher",
      run: async (_p, { cwd }) => {
        ranIn = cwd;
        return { text: '```json\n{"kind":"spec"}\n```', sessionId: "sid-1" };
      },
    };

    // No sandbox in deps: the agent runs where the loop runs, which is the
    // operator's own checkout — so nothing may be checked against it either.
    await converge("1", deps(world(), { executor: watcher }));
    expect(ranIn).toBeUndefined();
  });
});

/* ------------------------------------------------------ a stage's branch -- */

/**
 * The branch a stage names is where its step's commits go, and what outlives
 * the worktree converge removes on the way out. Before this, a build committed
 * onto a detached HEAD in a directory that was then deleted: the work was
 * unreferenced, the pull request never came, and the item waited at build.
 */
describe("converge and a stage's branch", () => {
  const git = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", args, { cwd })).stdout.trim();
  const tip = (root: string, branch: string): Promise<string | null> =>
    exec("git", ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { cwd: root }).then((r) => r.stdout.trim(), () => null);

  const writing = step(["repo:read", "repo:write"]);
  const branched = (branch?: string): Workflow => ({
    ...stepWorkflow,
    stages: stepWorkflow.stages.map((s) => (s.id === "spec" && branch !== undefined ? { ...s, branch } : s)),
  });

  /** An agent that commits a file, and remembers the commit it made. */
  const committer = (made: string[], file = "built.ts"): Executor => ({
    id: "committer",
    run: async (_p, { cwd }) => {
      if (cwd === undefined) throw new Error("the sandbox handed the agent no cwd");
      await writeFile(join(cwd, file), `export const built = ${JSON.stringify(file)};\n`);
      await git(cwd, "add", "-A");
      await git(cwd, "commit", "-qm", `add ${file}`);
      made.push(await git(cwd, "rev-parse", "HEAD"));
      return { text: '```json\n{"kind":"spec"}\n```', sessionId: "sid-1" };
    },
  });

  it("keeps the step's commits on the stage's branch after the worktree is gone", async () => {
    const root = await repo();
    const made: string[] = [];

    const r = await converge("1", deps(world(), {
      workflow: branched("landrace/{item}"),
      steps: new Map<string, Step>([["spec", writing]]),
      executor: committer(made),
      sandbox: { root },
    }));

    expect(r.settled).toBe("terminal");
    expect(made).toHaveLength(1);
    expect(await tip(root, "landrace/1")).toBe(made[0]);
    expect(await sandboxes(root)).toEqual([]);
    // The operator's checkout is where it was, untouched.
    expect(await git(root, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(existsSync(join(root, "built.ts"))).toBe(false);
  });

  it("makes no branch for a stage that names none, exactly as before", async () => {
    const root = await repo();
    const made: string[] = [];

    await converge("1", deps(world(), {
      steps: new Map<string, Step>([["spec", writing]]),
      executor: committer(made),
      sandbox: { root },
    }));

    expect(made).toHaveLength(1);
    expect(await git(root, "branch", "--format=%(refname:short)")).toBe("main");
    expect(await git(root, "branch", "--contains", made[0] as string)).toBe("");
  });

  /*
   * "a..b" is a perfectly good item id and no branch at all. Found before
   * the step is paid for, and said in a sentence rather than as git's stderr.
   */
  it("halts before the step when this item's id cannot make the stage's branch", async () => {
    const root = await repo();
    let invoked = false;
    const spy: Executor = { id: "spy", run: async () => { invoked = true; return { text: "", sessionId: null }; } };

    const r = await converge("a..b", deps(world(), {
      workflow: branched("landrace/{item}"),
      steps: new Map<string, Step>([["spec", writing]]),
      executor: spy,
      sandbox: { root },
    }));

    expect(r.settled).toBe("halt");
    expect(r.why).toMatch(/#a\.\.b[\s\S]*not a usable branch name/);
    expect(invoked).toBe(false);
    expect(await sandboxes(root)).toEqual([]);
  });

  it("halts, naming where, when the branch is checked out in the operator's own checkout", async () => {
    const root = await repo();
    await git(root, "checkout", "-q", "-b", "landrace/1");
    let invoked = false;
    const spy: Executor = { id: "spy", run: async () => { invoked = true; return { text: "", sessionId: null }; } };

    const r = await converge("1", deps(world(), {
      workflow: branched("landrace/{item}"),
      steps: new Map<string, Step>([["spec", writing]]),
      executor: spy,
      sandbox: { root },
    }));

    expect(r.settled).toBe("halt");
    expect(r.why).toMatch(/landrace\/1 is checked out at/);
    expect(invoked).toBe(false);
    expect(await git(root, "symbolic-ref", "--short", "HEAD")).toBe("landrace/1");
  });

  /*
   * The commit a step on a branch started at (security audit H1) rides on
   * the record that settles its round — the output's, or the rejection's —
   * as the engine's own field: the branch's tip before the agent ran, not
   * the commit it made, and not anything its answer says.
   */
  it("stamps the commit the step's worktree started at on the record that settles its round", async () => {
    const root = await repo();
    await git(root, "branch", "landrace/1", "main");
    const started = await tip(root, "landrace/1");
    const made: string[] = [];
    const w = world();
    const applied: Array<Record<string, unknown>> = [];
    const watching = { ...w.post, apply: async (e: Effect, c: HookContext) => { applied.push(e); return w.post.apply(e, c); } };

    const r = await converge("1", deps(w, {
      workflow: branched("landrace/{item}"),
      steps: new Map<string, Step>([["spec", writing]]),
      executor: committer(made),
      dispatcher: createDispatcher([watching]),
      sandbox: { root },
    }));

    expect(r.settled).toBe("terminal");
    expect(started).not.toBeNull();
    expect(made[0]).not.toBe(started);
    expect(applied.filter((e) => e.marker === "spec:1")).toEqual([expect.objectContaining({ kind: "output", head: started })]);
  });

  it("stamps it on a rejected round's record too", async () => {
    const root = await repo();
    await git(root, "branch", "landrace/1", "main");
    const started = await tip(root, "landrace/1");
    const w = world();
    const applied: Array<Record<string, unknown>> = [];
    const watching = { ...w.post, apply: async (e: Effect, c: HookContext) => { applied.push(e); return w.post.apply(e, c); } };

    const r = await converge("1", deps(w, {
      workflow: branched("landrace/{item}"),
      executor: wellBehaved("no answer here"),
      dispatcher: createDispatcher([watching]),
      sandbox: { root },
    }));

    expect(r.settled).toBe("halt");
    expect(applied.filter((e) => e.kind === "malformed")).toEqual([expect.objectContaining({ stage: "spec", round: 1, head: started })]);
  });

  it("stamps none for a stage that names no branch", async () => {
    const root = await repo();
    const w = world();
    const applied: Array<Record<string, unknown>> = [];
    const watching = { ...w.post, apply: async (e: Effect, c: HookContext) => { applied.push(e); return w.post.apply(e, c); } };

    await converge("1", deps(w, { dispatcher: createDispatcher([watching]), sandbox: { root } }));

    const record = applied.find((e) => e.marker === "spec:1");
    expect(record).toBeDefined();
    expect(record).not.toHaveProperty("head");
  });

  /*
   * Re-review N2: the head a step starts at is origin's, fetched first. A
   * person's push — or the forge's "Update branch" — never reached this
   * checkout before, so a review recorded the commit it was not shown, and
   * the merge held to that review answered "unreviewed" until the item was
   * stuck. Real git: another clone pushes to landrace/1, and the next step's
   * worktree, and the head its record carries, is that push.
   */
  it("starts a step on a branch at the commit another clone pushed, fetched from origin first", async () => {
    const { root, origin } = await gitRepoWithOrigin();
    const built = await commitOn(root, "landrace/1", "built.ts");
    await git(root, "push", "-q", "origin", "landrace/1");
    const theirs = await pushedElsewhere(origin, "landrace/1");
    const w = world();
    const fetched: string[] = [];
    const source = defineSource({
      ...w.source,
      remoteHead: async (branch, c) => {
        fetched.push(branch);
        return fetchBranch(gitIn(root), `file://${origin}`, branch, c.signal, []);
      },
    });
    const applied: Array<Record<string, unknown>> = [];
    const watching = { ...w.post, apply: async (e: Effect, c: HookContext) => { applied.push(e); return w.post.apply(e, c); } };
    const sawHead: string[] = [];
    const looking: Executor = {
      id: "looking",
      run: async (_p, { cwd }) => {
        if (cwd === undefined) throw new Error("no cwd");
        sawHead.push(await git(cwd, "rev-parse", "HEAD"));
        return { text: '```json\n{"kind":"spec"}\n```', sessionId: "sid-1" };
      },
    };

    const r = await converge("1", deps(w, {
      workflow: branched("landrace/{item}"), source, executor: looking, dispatcher: createDispatcher([watching]), sandbox: { root },
    }));

    expect(r.settled).toBe("terminal");
    expect(theirs).not.toBe(built);
    expect(sawHead).toEqual([theirs]);
    expect(applied.filter((e) => e.marker === "spec:1")).toEqual([expect.objectContaining({ kind: "output", head: theirs })]);
    expect(fetched).toEqual(["landrace/1"]);
    // Caught up, forward: the local branch is the pushed commit now.
    expect(await tip(root, "landrace/1")).toBe(theirs);
  });

  /* A fetch that fails is an outage: said, unrecorded, and the step waits for the next tick. */
  it("runs no step, and records nothing, when origin's branch cannot be fetched", async () => {
    const root = await repo();
    await git(root, "branch", "landrace/1", "main");
    const w = world();
    const source = defineSource({ ...w.source, remoteHead: async () => { throw new Error("could not fetch landrace/1 from origin: 502"); } });
    let invoked = false;
    const spy: Executor = { id: "spy", run: async () => { invoked = true; return { text: "", sessionId: null }; } };

    const r = await converge("1", deps(w, { workflow: branched("landrace/{item}"), source, executor: spy, sandbox: { root } }));

    expect(r).toMatchObject({ settled: "halt", why: expect.stringContaining("could not fetch landrace/1 from origin: 502") });
    expect(invoked).toBe(false);
    expect(w.entries).toEqual([]);
    expect(await sandboxes(root)).toEqual([]);
  });

  it("asks origin for nothing for a stage on no branch", async () => {
    const root = await repo();
    const w = world();
    const fetched: string[] = [];
    const source = defineSource({ ...w.source, remoteHead: async (branch) => { fetched.push(branch); return null; } });
    await converge("1", deps(w, { source, sandbox: { root } }));
    expect(fetched).toEqual([]);
  });

  /*
   * Nothing in the engine limits an item to one branch: each stage names its
   * own, and two stages naming two templates leave two branches, each holding
   * only what its own stage committed.
   */
  it("gives one item two branches when two stages name two", async () => {
    const root = await repo();
    const made: string[] = [];
    const twoBranches: Workflow = {
      version: 1, name: "t", description: "test",
      stages: [
        {
          id: "api", step: "api", entry: true, branch: "api/{item}",
          triggers: [{ when: { "run.stage": null } }],
          on_enter: [{ type: "tracker.status", value: "api" }],
        },
        {
          id: "ui", step: "ui", branch: "ui/{item}",
          triggers: [{ when: { "run.stage": "api", "run.outputs.api": { $exists: true } } }],
          on_enter: [{ type: "tracker.status", value: "ui" }],
        },
        { id: "done", terminal: true, triggers: [{ when: { "run.stage": "ui", "run.outputs.ui": { $exists: true } } }] },
      ],
    };
    let calls = 0;
    const perStage: Executor = {
      id: "per-stage",
      run: async (prompt, opts) => committer(made, calls++ === 0 ? "api.ts" : "ui.ts").run(prompt, opts),
    };

    const r = await converge("1", deps(world(), {
      workflow: twoBranches,
      steps: new Map<string, Step>([["api", writing], ["ui", writing]]),
      executor: perStage,
      sandbox: { root },
    }));

    expect(r.settled).toBe("terminal");
    expect(await tip(root, "api/1")).toBe(made[0]);
    expect(await tip(root, "ui/1")).toBe(made[1]);
    // Each branch holds its own stage's work and not the other's.
    expect(await git(root, "ls-tree", "--name-only", "api/1")).toMatch(/api\.ts/);
    expect(await git(root, "ls-tree", "--name-only", "api/1")).not.toMatch(/ui\.ts/);
    expect(await git(root, "ls-tree", "--name-only", "ui/1")).not.toMatch(/api\.ts/);
    expect(await sandboxes(root)).toEqual([]);
  });
});
