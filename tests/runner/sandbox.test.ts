import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { ensureWorktree, removeWorktree } from "#agent/worktree.js";
import { defineArtifactHook, definePostHook, definePreHook } from "#hooks/contracts.js";
import type { Executor, HookContext, Step, StepResult, Workflow } from "#namespace.js";
import { converge } from "#runner/converge.js";
import { createDispatcher } from "#runner/effects.js";
import { createLogger } from "#runner/events.js";
import { runStep } from "#runner/step.js";
import { gitRepo as repo, plainDir, removeRepos, worktreesOf as sandboxes } from "#tests/support/repo.js";

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
      step: step(["repo:read"]),
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
      step: step(["repo:read"]),
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
      step: step(["repo:read"]),
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
      step: step(["repo:read", "repo:write"]),
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
      step: step(["repo:read"]),
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
      step: step(["repo:read"]),
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
      step: step(["repo:read"]),
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
      step: step(["repo:read", "net:egress"]),
      stageId: "spec", round: 1, snapshot: {},
      executor: spy,
      signal: new AbortController().signal,
    });

    expect(r).toMatchObject({ ok: false, kind: "refused" });
    expect((r as Fail).reason).toMatch(/net:egress/);
    expect(invoked).toBe(false);
  });

  it("hands the step's declaration to the executor, so the executor can enforce it too", async () => {
    let seen: readonly string[] | undefined;
    const spy: Executor = {
      id: "spy",
      run: async (_p, o) => { seen = o.capabilities; return { text: "", sessionId: null }; },
    };

    await runStep({
      step: { prompt: "go" },
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
  version: 1, name: "t",
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
    pre: definePreHook({
      id: "w",
      run: () => ({ ticket: { labels: [...labels] }, entries: [...entries] }),
    }),
    post: definePostHook({
      id: "w",
      handles: ["tracker.status", "tracker.comment"],
      satisfied: (s, e) => {
        const present = (s.ticket as { labels?: string[] }).labels ?? [];
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
  pre: [w.pre],
  dispatcher: createDispatcher([w.post]),
  executor: wellBehaved(),
  ctx: {
    ticket: "1", config: {} as HookContext["config"], secrets: new Map(),
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
   * ticket carries the refusal where a person can read it.
   */
  it("records the refusal on the ticket and keeps the write out of the repository", async () => {
    const root = await repo();
    const w = world();
    await converge("1", deps(w, { executor: writer("planted.ts"), sandbox: { root } }));

    expect(existsSync(join(root, "planted.ts"))).toBe(false);
    const malformed = w.entries.filter((e) => e.kind === "malformed");
    expect(malformed).toHaveLength(1);
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
