import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

import { DEFAULT_LOCKFILES, ensureWorktree, gitControlPaths, removeWorktree } from "#agent/worktree.js";
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
const LINUX = process.platform === "linux";
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

    const r = await runStep({ controls: null,
      item: "1", step: step(["repo:read"]),
      stageId: "spec", round: 1, snapshot: {},
      executor: writer("planted.ts"),
      signal: new AbortController().signal,
      sandbox: { path, root },
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

    const r = await runStep({ controls: null,
      item: "1", step: step(["repo:read"]),
      stageId: "spec", round: 1, snapshot: {},
      executor: committer,
      signal: new AbortController().signal,
      sandbox: { path, root },
    });

    expect(r).toMatchObject({ ok: false, kind: "refused" });
    expect((r as Fail).reason).toMatch(/commit/i);
    await removeWorktree("102", root);
  });

  it("produces no effects when it is refused, so nothing it wrote reaches the tracker", async () => {
    const root = await repo();
    const path = await ensureWorktree("103", root);

    const r = await runStep({ controls: null,
      item: "1", step: step(["repo:read"]),
      stageId: "spec", round: 1, snapshot: {},
      executor: writer("planted.ts"),
      signal: new AbortController().signal,
      sandbox: { path, root },
    });
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty("effects");
    await removeWorktree("103", root);
  });

  // A write step elsewhere may have rewritten this worktree's admin folder
  // while it ran (see worktreeIntact): the agent's own git there would follow it.
  it.each([["read", ["repo:read"]], ["write", ["repo:read", "repo:write"]]])(
    "refuses a %s step in a worktree whose commondir names another git directory, and never runs it",
    async (_tier, capabilities) => {
      const root = await repo();
      const path = await ensureWorktree("105", root);
      const common = realpathSync(join(root, ".git"));
      const admin = join(common, "worktrees", basename(path));
      await writeFile(join(admin, "commondir"), `${tmpdir()}\n`);
      let ran = false;
      const r = await runStep({ controls: { deny: [], absent: [], commons: [] },
        item: "1", step: step(capabilities),
        stageId: "spec", round: 1, snapshot: {},
        executor: { id: "never", run: async () => { ran = true; return { text: "", sessionId: null }; } },
        signal: new AbortController().signal,
        sandbox: { path, root },
      });
      expect(r).toMatchObject({ ok: false, kind: "refused" });
      expect((r as Fail).reason).toContain(join(admin, "commondir"));
      expect(ran).toBe(false);
      await writeFile(join(admin, "commondir"), "../..\n");
      await removeWorktree("105", root);
    },
  );

  it("lets the same write through for a step that declared repo:write", async () => {
    const root = await repo();
    const path = await ensureWorktree("104", root);

    const r = await runStep({ controls: await gitControlPaths(path, root),
      item: "1", step: step(["repo:read", "repo:write"]),
      stageId: "spec", round: 1, snapshot: {},
      executor: writer("planted.ts"),
      signal: new AbortController().signal,
      sandbox: { path, root },
    });

    expect(r).toMatchObject({ ok: true });
    expect(existsSync(join(path, "planted.ts"))).toBe(true);
    await removeWorktree("104", root);
  });

  it("does not refuse a read-only step that touched nothing", async () => {
    const root = await repo();
    const path = await ensureWorktree("105", root);

    const r = await runStep({ controls: null,
      item: "1", step: step(["repo:read"]),
      stageId: "spec", round: 1, snapshot: {},
      executor: wellBehaved(),
      signal: new AbortController().signal,
      sandbox: { path, root },
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

    const r = await runStep({ controls: null,
      item: "1", step: step(["repo:read"]),
      stageId: "spec", round: 1, snapshot: {},
      executor: spy,
      signal: new AbortController().signal,
      sandbox: { path: join(tmpdir(), "lr-not-a-worktree-at-all"), root: await repo() },
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

    const r = await runStep({ controls: null,
      item: "1", step: step(["repo:read"]),
      stageId: "spec", round: 1, snapshot: {},
      executor: vanishing,
      signal: new AbortController().signal,
      sandbox: { path, root },
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

    const r = await runStep({ controls: null,
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
    const r = await runStep({ controls: null,
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

    await runStep({ controls: null,
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

  describe("the git paths a write step's agent may not write", () => {
    /** An executor that writes down what each run was handed, and the control paths of where it ran, read as it ran. */
    const recorder = () => {
      const runs: Array<{ cwd: string | undefined; denyWrite: readonly string[] | undefined; expected?: string[] }> = [];
      const executor: Executor = {
        id: "recorder",
        run: async (_p, { cwd, denyWrite }) => {
          runs.push({ cwd, denyWrite });
          return { text: '```json\n{"kind":"spec"}\n```', sessionId: "sid-1" };
        },
      };
      return { runs, executor };
    };
    const write = new Map<string, Step>([["spec", step(["repo:read", "repo:write"])]]);
    // A Linux sandbox is denied only the paths that are there; the rest are checked after the run.
    const onThisPlatform = (paths: string[]): string[] => (LINUX ? paths.filter((p) => existsSync(p)) : paths);
    const common = async (dir: string): Promise<string> =>
      realpathSync(resolve(dir, (await exec("git", ["rev-parse", "--git-common-dir"], { cwd: dir })).stdout.trim()));

    it("hands a write step in a worktree that repository's config, commondir, hooks, info and admin files, and the worktree's .git file", async () => {
      const root = await repo();
      const { runs, executor } = recorder();
      await converge("1", deps(world(), { executor, steps: write, sandbox: { root } }));
      const [run] = runs;
      const cwd = run?.cwd as string;
      const git = await common(root);
      expect(run?.denyWrite).toEqual(expect.arrayContaining(onThisPlatform([
        join(git, "config"), join(git, "config.worktree"), join(git, "commondir"), join(git, "hooks"), join(git, "info"), join(cwd, ".git"),
      ])));
      expect(run?.denyWrite?.filter((p) => p.startsWith(join(git, "worktrees"))).map((p) => basename(p)))
        .toEqual(LINUX ? ["commondir", "gitdir"] : ["config", "config.worktree", "commondir", "gitdir", "hooks", "info"]);
    });

    it("hands a read step none", async () => {
      const root = await repo();
      const { runs, executor } = recorder();
      await converge("1", deps(world(), { executor, sandbox: { root } }));
      expect(runs.map((r) => r.denyWrite)).toEqual([undefined]);
    });

    it("hands a write step with isolation off the control paths of where it runs and of the workspace", async () => {
      const workspace = await repo();
      // A linked worktree of its own, whose admin files are the step's to plant in too.
      await ensureWorktree("9", workspace);
      const { runs, executor } = recorder();
      await converge("1", deps(world(), { executor, steps: write, workspace }));
      const [run] = runs;
      expect(run?.cwd).toBeUndefined();
      const theirs = await common(workspace);
      const here = await common(process.cwd());
      expect(run?.denyWrite).toEqual(expect.arrayContaining(onThisPlatform([
        ...["config", "commondir", "hooks", "info"].map((f) => join(theirs, f)),
        ...["config", "commondir", "hooks", "info"].map((f) => join(here, f)),
      ])));
      expect(run?.denyWrite?.filter((p) => p.startsWith(join(theirs, "worktrees"))).map((p) => basename(p)))
        .toEqual(LINUX ? ["commondir", "gitdir"] : ["config", "config.worktree", "commondir", "gitdir", "hooks", "info"]);
      await removeWorktree("9", workspace);
    });
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

  /** The write stage, then a stage that waits: the item is not finished, so its worktree is not either. */
  const waiting: Workflow = {
    ...branched("landrace/{item}"),
    stages: [
      ...branched("landrace/{item}").stages.filter((s) => s.id === "spec"),
      { id: "review", triggers: [{ when: { "run.outputs.spec": { $exists: true } } }], on_enter: [{ type: "tracker.status", value: "review" }] },
    ],
  };

  it("keeps a write step's worktree while the item waits, so its next write step reuses it", async () => {
    const root = await repo();
    const made: string[] = [];

    const r = await converge("1", deps(world(), {
      workflow: waiting,
      steps: new Map<string, Step>([["spec", writing]]),
      executor: committer(made),
      sandbox: { root },
    }));

    expect(r.settled).toBe("wait");
    const kept = (await sandboxes(root)).map((line) => line.slice("worktree ".length));
    expect(kept.map((p) => p.split("/").pop())).toEqual(["1.write"]);
    // Kept detached, at the branch's commit: the branch is free while the item
    // waits, so a person can check it out in their own checkout.
    expect(await git(kept[0] as string, "rev-parse", "HEAD")).toBe(made[0]);
    expect(await git(kept[0] as string, "status", "--porcelain", "--branch")).toMatch(/^## HEAD \(no branch\)/);
    await git(root, "switch", "-q", "landrace/1");
    expect(await git(root, "rev-parse", "HEAD")).toBe(made[0]);
    await git(root, "switch", "-q", "main");
    await removeWorktree("1", root, "1.write");
  });

  it("copies and runs setup before a write step, and halts before the agent when setup fails", async () => {
    const root = await repo();
    await writeFile(join(root, "local.env"), "TOKEN=1\n");
    const seen: string[] = [];
    const looker: Executor = {
      id: "looker",
      run: async (_p, { cwd }) => {
        seen.push(await readFile(join(cwd as string, "ready.txt"), "utf8"));
        return { text: '```json\n{"kind":"spec"}\n```', sessionId: "sid-1" };
      },
    };
    const worktree = { copy: ["*.env"], setup: ["cat local.env > ready.txt"], timeoutMs: 60_000, lockfiles: [...DEFAULT_LOCKFILES] };

    const ok = await converge("1", deps(world(), {
      workflow: branched("landrace/{item}"),
      steps: new Map<string, Step>([["spec", writing]]),
      executor: looker,
      sandbox: { root, worktree },
    }));
    expect(ok.settled).toBe("terminal");
    expect(seen).toEqual(["TOKEN=1\n"]);

    const w = world();
    const failed = await converge("2", deps(w, {
      workflow: branched("landrace/{item}"),
      steps: new Map<string, Step>([["spec", writing]]),
      executor: looker,
      sandbox: { root, worktree: { ...worktree, setup: ["echo 'no registry' >&2; exit 1"] } },
    }));
    expect(failed.settled).toBe("halt");
    expect(failed.why).toMatch(/no registry/);
    expect(seen).toHaveLength(1);
    // An outage, not a verdict: nothing recorded, and the round is still owed.
    expect(w.entries.filter((e) => ["output", "malformed", "refused"].includes(String(e.kind)))).toEqual([]);
    await removeWorktree("2", root, "2.write");
  });

  it("copies and runs setup for a write step on a stage that names no branch, and keeps nothing", async () => {
    const root = await repo();
    await writeFile(join(root, "local.env"), "TOKEN=1\n");
    const seen: string[] = [];
    const looker: Executor = {
      id: "looker",
      run: async (_p, { cwd }) => {
        seen.push(await readFile(join(cwd as string, "ready.txt"), "utf8"));
        return { text: '```json\n{"kind":"spec"}\n```', sessionId: "sid-1" };
      },
    };

    const r = await converge("1", deps(world(), {
      steps: new Map<string, Step>([["spec", writing]]),
      executor: looker,
      sandbox: { root, worktree: { copy: ["*.env"], setup: ["cat local.env > ready.txt"], timeoutMs: 60_000, lockfiles: [...DEFAULT_LOCKFILES] } },
    }));
    expect(r.settled).toBe("terminal");
    expect(seen).toEqual(["TOKEN=1\n"]);
    expect(await sandboxes(root)).toEqual([]);
  });

  it("neither copies nor sets up for a read-only step", async () => {
    const root = await repo();
    await writeFile(join(root, "local.env"), "TOKEN=1\n");
    const seen: boolean[] = [];
    const looker: Executor = {
      id: "looker",
      run: async (_p, { cwd }) => {
        seen.push(existsSync(join(cwd as string, "local.env")) || existsSync(join(cwd as string, "ready.txt")));
        return { text: '```json\n{"kind":"spec"}\n```', sessionId: "sid-1" };
      },
    };

    await converge("1", deps(world(), {
      workflow: branched("landrace/{item}"),
      executor: looker,
      sandbox: { root, worktree: { copy: ["*.env"], setup: ["touch ready.txt"], timeoutMs: 60_000, lockfiles: [...DEFAULT_LOCKFILES] } },
    }));
    expect(seen).toEqual([false]);
  });
});

/*
 * A Linux sandbox denies only the control paths that exist, so a write run can
 * make one that did not: each that was missing as it started and holds
 * something once it ends is refused, however the run ended, before the
 * engine's git runs there.
 */
describe("a write run that leaves a git control path holding something", () => {
  const OK = '```json\n{"kind":"spec"}\n```';
  const writeStep = step(["repo:read", "repo:write"]);
  /** Resolves once `signal` has aborted, at once if it already has. */
  const stopped = (signal: AbortSignal | undefined): Promise<void> => new Promise((done) => {
    if (signal === undefined || signal.aborted) done();
    else signal.addEventListener("abort", () => done(), { once: true });
  });
  const ENDS = ["answers", "throws", "runs past its limit", "is aborted"] as const;
  type End = typeof ENDS[number];
  /** An agent that plants `file` with `body`, then ends as `end` says. */
  const planter = (file: () => string, body: string, end: End, abort: AbortController): Executor => ({
    id: "planter",
    run: async (_p, { signal }) => {
      await writeFile(file(), body);
      if (end === "answers") return { text: OK, sessionId: "sid-1" };
      if (end === "throws") throw new Error("the agent crashed");
      if (end === "is aborted") abort.abort();
      await stopped(signal);
      throw new Error("the agent was stopped");
    },
  });

  it("refuses a step that may write when it is handed no control paths, and never runs it", async () => {
    const root = await repo();
    const path = await ensureWorktree("119", root);
    let ran = false;
    const r = await runStep({
      controls: null, item: "1", step: writeStep, stageId: "spec", round: 1, snapshot: {},
      executor: { id: "never", run: async () => { ran = true; return { text: OK, sessionId: null }; } },
      signal: new AbortController().signal, sandbox: { path, root },
    });
    expect(r).toMatchObject({ ok: false, kind: "refused" });
    expect((r as Fail).reason).toMatch(/git paths its agent may not write/);
    expect(ran).toBe(false);
    await removeWorktree("119", root);
  });

  it.each(ENDS)("refuses one that planted <common>/commondir when it %s, naming it", async (end) => {
    const root = await repo();
    const path = await ensureWorktree("120", root);
    const common = realpathSync(join(root, ".git"));
    const controls = await gitControlPaths(path, root, "linux");
    const abort = new AbortController();
    try {
      const r = await runStep({
        controls, item: "1", step: writeStep, stageId: "spec", round: 1, snapshot: {},
        executor: planter(() => join(common, "commondir"), "/elsewhere\n", end, abort),
        signal: abort.signal, sandbox: { path, root },
        ...(end === "runs past its limit" ? { defaultTimeoutMs: 300 } : {}),
      });
      expect(r).toMatchObject({ ok: false, kind: "refused", planted: true });
      expect((r as Fail).reason).toContain(join(common, "commondir"));
      expect((r as Fail).reason).toMatch(/a step that may write could have put it there/);
    } finally {
      await rm(join(common, "commondir"), { force: true });
      await removeWorktree("120", root);
    }
  });

  it("lets through the empty file a Linux sandbox leaves where it denied a path", async () => {
    const root = await repo();
    const path = await ensureWorktree("121", root);
    const common = realpathSync(join(root, ".git"));
    const controls = await gitControlPaths(path, root, "linux");
    try {
      const r = await runStep({
        controls, item: "1", step: writeStep, stageId: "spec", round: 1, snapshot: {},
        executor: planter(() => join(common, "config.worktree"), "", "answers", new AbortController()),
        signal: new AbortController().signal, sandbox: { path, root },
      });
      expect(r).toMatchObject({ ok: true });
    } finally {
      await rm(join(common, "config.worktree"), { force: true });
      await removeWorktree("121", root);
    }
  });

  describe("through converge", () => {
    const writes = new Map<string, Step>([["spec", writeStep]]);
    const commonOf = (root: string): string => realpathSync(join(root, ".git"));
    /** The admin folder of the worktree an agent ran in. */
    const adminOf = async (root: string, cwd: string): Promise<string> => {
      for (const name of await readdir(join(commonOf(root), "worktrees"))) {
        const folder = join(commonOf(root), "worktrees", name);
        if ((await readFile(join(folder, "gitdir"), "utf8")).trim() === join(cwd, ".git")) return folder;
      }
      throw new Error(`no admin folder names ${cwd}`);
    };

    it.each(ENDS)("halts the item and records the refusal when the run %s", async (end) => {
      const root = await repo();
      const w = world();
      const abort = new AbortController();
      const planted = join(commonOf(root), "commondir");
      try {
        const r = await converge("1", deps(w, {
          executor: planter(() => planted, "/elsewhere\n", end, abort), steps: writes, sandbox: { root },
          ctx: { item: "1", config: {} as HookContext["config"], secrets: new Map(), signal: abort.signal, log: () => {} },
          ...(end === "runs past its limit" ? { stepTimeoutMs: 300 } : {}),
        }));
        expect(r.settled).toBe("halt");
        expect(r.why).toContain(planted);
        const refused = w.entries.filter((e) => e.kind === "refused");
        expect(refused).toHaveLength(1);
        expect(JSON.stringify(refused[0])).toContain("spec");
      } finally {
        await rm(planted, { force: true });
      }
    });

    it("halts on an admin config.worktree setting a filter, and runs no git in the worktree after", async () => {
      const root = await repo();
      const marker = join(realpathSync(tmpdir()), `lr-filter-${Date.now()}`);
      const filter = `${marker}.sh`;
      await writeFile(filter, `#!/bin/sh\necho ran >> '${marker}'\ncat\n`, { mode: 0o755 });
      // With the extension on, git reads each admin folder's config.worktree.
      await exec("git", ["config", "extensions.worktreeConfig", "true"], { cwd: root });
      const w = world();
      let admin = "";
      let cwd = "";
      let armed = false;
      const executor: Executor = {
        id: "planter",
        run: async (_p, { cwd: at }) => {
          cwd = at as string;
          admin = await adminOf(root, cwd);
          await writeFile(join(admin, "config.worktree"), `[filter "trap"]\n\tclean = ${filter}\n`);
          await writeFile(join(cwd, ".gitattributes"), "* filter=trap\n");
          await writeFile(join(cwd, "src", "a.ts"), "export const a = 2;\n");
          // Armed: git run plainly there runs the filter. Cleared, so what follows is the engine's alone.
          await exec("git", ["status"], { cwd });
          armed = existsSync(marker);
          await rm(marker, { force: true });
          return { text: OK, sessionId: "sid-1" };
        },
      };
      try {
        const r = await converge("1", deps(w, { executor, steps: writes, sandbox: { root } }));
        expect(r.settled).toBe("halt");
        if (LINUX) {
          // On Linux no write run starts with the extension on.
          expect(r.why).toMatch(/extensions\.worktreeConfig/);
          expect(cwd).toBe("");
        } else {
          expect(r.why).toContain(join(admin, "config.worktree"));
          expect(w.entries.filter((e) => e.kind === "refused")).toHaveLength(1);
          expect(armed).toBe(true);
          expect(existsSync(marker)).toBe(false);
        }
      } finally {
        await rm(marker, { force: true });
        await rm(filter, { force: true });
      }
    });

    it.each([["in a worktree", true], ["with no worktree", false]])(
      "refuses a write step %s on Linux while extensions.worktreeConfig is on, naming it, and never runs it",
      async (_where, worktree) => {
        const root = await repo();
        await exec("git", ["config", "extensions.worktreeConfig", "true"], { cwd: root });
        let ran = false;
        const was = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
        Object.defineProperty(process, "platform", { value: "linux" });
        try {
          const r = await converge("1", deps(world(), {
            executor: { id: "never", run: async () => { ran = true; return { text: OK, sessionId: null }; } },
            steps: writes, ...(worktree ? { sandbox: { root } } : { workspace: root }),
          }));
          expect(r.settled).toBe("halt");
          expect(r.why).toMatch(/extensions\.worktreeConfig is on .*turn it off/);
        } finally {
          Object.defineProperty(process, "platform", was);
        }
        expect(ran).toBe(false);
      },
    );

    // actions/checkout runs `git sparse-checkout disable`, which writes <common>/config.worktree, and
    // then unsets the extension: refusing what it left halted every Linux write run in CI.
    it.each([["in a worktree", true], ["with no worktree", false]])(
      "runs a write step %s on Linux in a repository left the way actions/checkout leaves it",
      async (_where, worktree) => {
        const root = await repo();
        await exec("git", ["sparse-checkout", "disable"], { cwd: root });
        await exec("git", ["config", "--unset-all", "extensions.worktreeConfig"], { cwd: root });
        const left = await readFile(join(commonOf(root), "config.worktree"), "utf8");
        expect(left).toMatch(/sparseCheckout = false/);
        let ran = false;
        const was = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
        Object.defineProperty(process, "platform", { value: "linux" });
        let r: Awaited<ReturnType<typeof converge>>;
        try {
          r = await converge("1", deps(world(), {
            executor: { id: "counter", run: async () => { ran = true; return { text: OK, sessionId: "sid-1" }; } },
            steps: writes, ...(worktree ? { sandbox: { root } } : { workspace: root }),
          }));
        } finally {
          Object.defineProperty(process, "platform", was);
        }
        expect(r.why).toBeUndefined();
        expect(ran).toBe(true);
        expect(await readFile(join(commonOf(root), "config.worktree"), "utf8")).toBe(left);
      },
    );

    // A Linux step with no worktree could rename the checkout's .git away and make it again, and its
    // sandbox's binds would move with the old one: a configured agent.isolation: none is refused by
    // the run as well as at start. A run told no isolation — the in-memory harness's, which enters no
    // worktree either — runs: refused there, every harness write step on Linux failed, a third party's too.
    it.each([
      ["linux", "none", false], ["darwin", "none", true], ["linux", undefined, true], ["darwin", undefined, true],
    ] as const)("with no worktree, on %s, isolation %s configured, runs the write step: %s", async (platform, isolation, runs) => {
      const workspace = await repo();
      let ran = false;
      const was = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
      Object.defineProperty(process, "platform", { value: platform });
      let r: Awaited<ReturnType<typeof converge>>;
      try {
        r = await converge("1", deps(world(), {
          executor: { id: "counter", run: async () => { ran = true; return { text: OK, sessionId: "sid-1" }; } },
          steps: writes, workspace, ...(isolation === undefined ? {} : { isolation }),
        }));
      } finally {
        Object.defineProperty(process, "platform", was);
      }
      expect(ran).toBe(runs);
      if (runs) expect(r.settled).not.toBe("halt");
      else {
        expect(r.settled).toBe("halt");
        expect(r.why).toMatch(/agent\.isolation: none[\s\S]*agent\.isolation: worktree/);
      }
    });

    it("halts the item when a run with no worktree plants one in the workspace", async () => {
      const workspace = await repo();
      const planted = join(commonOf(workspace), "commondir");
      const w = world();
      try {
        const r = await converge("1", deps(w, {
          executor: planter(() => planted, "/elsewhere\n", "answers", new AbortController()), steps: writes, workspace,
        }));
        expect(r.settled).toBe("halt");
        expect(r.why).toContain(planted);
        expect(w.entries.filter((e) => e.kind === "refused")).toHaveLength(1);
      } finally {
        await rm(planted, { force: true });
      }
    });
  });
});
