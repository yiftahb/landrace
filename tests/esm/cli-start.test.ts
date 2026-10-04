import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildWorkspaceRuntime, childServerCommand, runStart } from "#cli/start.js";
import { runStatus } from "#cli/status.js";
import type { BoardView, BuildOptions, LandraceEvent, WorkflowRuntime, WorkspaceRuntime } from "#namespace.js";
import { createActivityLog } from "#runner/activity.js";
import { acquire, release } from "#runner/lock.js";
import { sandboxRoot } from "#sandbox.js";
import { tickWorkspace } from "#runner/tick.js";
import { touchWake, wakePath } from "#wake.js";
import { describeLoopback } from "#tests/support/loopback.js";
import { workflowIn } from "#tests/support/workspace.js";

/**
 * `buildWorkspaceRuntime` over a hook module that is a real file on disk, imported the
 * way the CLI imports one.
 *
 * This file runs in the second jest pass (see jest.esm.config.mjs): the
 * default pass rewrites `await import(url)` onto jest's own resolver, which
 * cannot resolve a `file:` URL, so the loader's one dynamic moment — and
 * therefore everything `buildWorkspaceRuntime` assembles out of it — is unreachable
 * there.
 */
const ITEM = "4242";
const TOKEN = "ghp_a_token_long_enough_to_redact";

/**
 * Branded through `Symbol.for`, exactly as `landrace/hooks` does it, so this
 * module needs no import at all: what the loader classifies is the brand, and
 * a fixture that imported the engine would be testing a different path than
 * a hook module out in a user's own directory.
 *
 * The post hook appends every effect it applies to the file named by
 * `tracker.record` — tracker config is opaque to the engine and handed to
 * hooks as it stands, so this also pins that the config reaches them.
 */
const hookSource = (
  provides?: string[], preflight?: "pass" | "throw", preFails?: string,
  items: Array<{ id: string; labels: string[]; closed?: "done" }> = [{ id: ITEM, labels: ["lr:auto"] }], listFails?: string,
  listFailsWhen?: string,
): string => `import { existsSync } from "node:fs";
import { appendFile } from "node:fs/promises";

const KIND = Symbol.for("landrace.hook.kind");
const brand = (kind: string, value: object): object =>
  Object.defineProperty(value, KIND, { value: kind, enumerable: false });

interface Ctx { item: string; config: { tracker: { record: string } } }

const graph = {
  nodes: ${JSON.stringify(items.map(({ id, labels, closed }) => ({
    id, kind: "item", title: "Add export", link: `u/${id}`, closed: closed ?? null, priority: null, origin: null, state: { labels, assignees: [] },
  })))},
  relationships: [],
};

export const source = brand("source", {
  id: "fake",
  relations: [],
  list: async (): Promise<unknown> => {
    ${listFails === undefined ? "" : `throw new Error(${JSON.stringify(listFails)});`}
    ${listFailsWhen === undefined ? "" : `if (existsSync(${JSON.stringify(listFailsWhen)})) throw new Error("GET /issues → 502");`}
    return graph;
  },
  read: async (): Promise<unknown> => graph,
});

export const pre = brand("pre", {
  id: "fake",
${provides === undefined ? "" : `  provides: ${JSON.stringify(provides)},\n`}  run: ({ item }: Ctx): Record<string, unknown> => {
    ${preFails === undefined ? "" : `throw new Error(${JSON.stringify(preFails)});`}
    return { item: { body: "about " + item }, entries: [] };
  },
});

export const post = brand("post", {
  id: "fake",
  handles: ["tracker.comment"],
  satisfied: (): boolean => false,
  apply: async (effect: { type: string }, ctx: Ctx): Promise<void> => {
    await appendFile(ctx.config.tracker.record, JSON.stringify({ item: ctx.item, type: effect.type }) + "\\n");
  },
});
${preflight === undefined ? "" : `
export const preflight = brand("preflight", {
  id: "fake",
  // Recorded in the same file post.apply writes to, tagged so a test can
  // tell "this ran at all" apart from "this ran and threw" — the write a
  // real preflight would make is exactly what invoking check() stands in for
  // here, so a preflight never invoked is a write that never happened.
  check: async (ctx: { config: { tracker: { record: string } } }): Promise<void> => {
    await appendFile(ctx.config.tracker.record, JSON.stringify({ preflight: true }) + "\\n");
    ${preflight === "throw" ? 'throw new Error("token needs \\"Contents: Read and write\\" on acme/widgets");' : ""}
  },
});
`}`;

const HOOK = hookSource();

/** A notifier exported as `name`, branded the way `landrace/hooks` brands one. */
const notifierSource = (name: string, id: string): string => `
export const ${name} = brand("notifier", { id: ${JSON.stringify(id)}, send: async (): Promise<void> => {} });
`;

/** A notifier `chat` that writes down, in the record file, each event it is asked to send. */
const RECORDING_NOTIFIER = `
export const chat = brand("notifier", {
  id: "chat",
  send: async (event: { item: string; workflow: string; stage: string | null; why: string }, ctx: Ctx): Promise<void> => {
    await appendFile(ctx.config.tracker.record, JSON.stringify({ notified: event.item, workflow: event.workflow, stage: event.stage, why: event.why }) + "\\n");
  },
});
`;

/** A hook-registered executor, branded the way `landrace/hooks` brands one. */
const EXECUTOR = `export const executor = brand("executor", {
  id: "fake",
  run: async (): Promise<{ text: string; sessionId: string | null }> => ({ text: "", sessionId: null }),
});
`;

const workflowReading = (path?: string, budget?: string): string => `version: 1
name: e2e
description: test
hooks: [../../hooks/fake.ts, ../../hooks/claude.ts]
eligible:
  - when: { "node.state.labels": { $in: ["lr:auto"] } }
    else: "no lr:auto label"
${budget === undefined ? "" : `budget:\n  stepTimeout: ${budget}\n`}stages:
  - id: spec
    entry: true
    terminal: true
    triggers:
      - name: fresh item
        when: { "run.stage": null${path === undefined ? "" : `, "${path}": { $exists: true }`} }
    on_enter:
      - { type: tracker.comment, kind: enter, marker: "enter:{stage}:{round}", body: "Writing the spec, round {round}." }
`;

const WORKFLOW = workflowReading();

interface Fixture { dir: string; record: string }

const exec = promisify(execFile);

/**
 * A repository, because `agent.isolation` defaults to `worktree` and a
 * runtime that isolates steps resolves the repository it will cut them from
 * before it will start. `git: false` is how the test below asks what happens
 * when there is none.
 */
async function fixture(
  opts: {
    agent?: string;
    screen?: boolean;
    provides?: string[];
    reads?: string;
    /** `budget.stepTimeout`, written into the generated workflow.yaml. */
    budget?: string;
    git?: boolean;
    preflight?: "pass" | "throw";
    /** More of `agent:`, written inside its braces. */
    agentKeys?: string;
    /** More of `security:`, written inside its braces. */
    securityKeys?: string;
    /** The `.mcp.json` at the repository root, as agsync would have written it. */
    mcpJson?: unknown;
    /** A message the pre hook fails with, as an upstream error would quote what it was sent. */
    preFails?: string;
    /** More of the fake hook module, after everything else in it. */
    hookExtra?: string;
    /** More of `landrace.yaml`, after everything else in it. */
    configExtra?: string;
    /** The items the fake source lists; one `lr:auto` item by default. */
    items?: Array<{ id: string; labels: string[]; closed?: "done" }>;
    /** A message the source's `list` fails with. */
    listFails?: string;
    /** A file whose presence makes the source's `list` fail, for a test to switch the tracker off mid-run. */
    listFailsWhen?: string;
    /** The whole of `workflows/main/workflow.yaml`, in place of the generated one. */
    workflow?: string;
  } = {},
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "lr-cli-"));
  if (opts.git !== false) await exec("git", ["init", "-q", "-b", "main"], { cwd: root });
  const dir = join(root, ".landrace");
  const record = join(root, "applied.jsonl");
  await mkdir(join(dir, "hooks"), { recursive: true });
  await writeFile(join(dir, "hooks", "fake.ts"), hookSource(opts.provides, opts.preflight, opts.preFails, opts.items, opts.listFails, opts.listFailsWhen) + (opts.hookExtra ?? ""));
  // The project's own coding agent, by the path this repository's workflow
  // loads it from: the engine ships none. A dynamic import with a computed
  // specifier — the loader's own `import(pathToFileURL(path).href)` pattern —
  // rather than a static `export … from "…claude.ts"`: ts-jest type-checks a
  // literal specifier under this project's `moduleResolution: NodeNext` and
  // refuses one ending in `.ts` (TS5097), a rule real Node's type-stripping
  // does not enforce at all.
  await writeFile(
    join(dir, "hooks", "claude.ts"),
    `import { pathToFileURL } from "node:url";
export const { claude } = await import(pathToFileURL(${JSON.stringify(join(process.cwd(), ".landrace", "hooks", "claude.ts"))}).href);
`,
  );
  await mkdir(workflowIn(dir), { recursive: true });
  await writeFile(join(workflowIn(dir), "workflow.yaml"), opts.workflow ?? workflowReading(opts.reads, opts.budget));
  await writeFile(
    join(dir, "landrace.yaml"),
    `version: 1
agent: { adapter: ${opts.agent ?? "claude"}, model: opus${opts.agentKeys ? `, ${opts.agentKeys}` : ""} }
tracker: { record: ${JSON.stringify(record)} }
tick: { interval: 30s, concurrency: 2 }
security: { screen: ${opts.screen ?? false}${opts.securityKeys ? `, ${opts.securityKeys}` : ""} }
log: { redact: [githubToken] }
secrets: { githubToken: $LR_TEST_TOKEN }
${opts.configExtra ?? ""}`,
  );
  await writeFile(join(dir, ".env"), `LR_TEST_TOKEN=${TOKEN}\n`);
  if (opts.mcpJson !== undefined) await writeFile(join(root, ".mcp.json"), JSON.stringify(opts.mcpJson));
  return { dir, record };
}

/** The workspace runtime with its workflow `main` beside it: every fixture here has that one, and most only that. */
async function buildMain(dir: string, opts: BuildOptions): Promise<WorkspaceRuntime & WorkflowRuntime> {
  const rt = await buildWorkspaceRuntime(dir, opts);
  const main = rt.workflows.find((w) => w.id === "main");
  if (!main) throw new Error("the fixture's workspace has no main workflow");
  return { ...rt, ...main };
}

const applied = async (record: string): Promise<unknown[]> =>
  (await readFile(record, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);

afterEach(async () => {
  await release(ITEM);
});

describe("buildWorkspaceRuntime", () => {
  it("assembles a runnable loop out of the config, the workflow and the hook modules", async () => {
    const { dir } = await fixture();
    const rt = await buildMain(dir, {});

    expect(rt.intervalMs).toBe(30_000);
    expect(rt.concurrency).toBe(2);
    expect(rt.source.id).toBe("fake");
    expect(rt.deps.pre.map((h) => h.id)).toEqual(["fake"]);
    expect(rt.deps.executor.id).toBe("claude");
    expect(rt.deps.screen).toBeUndefined();
  });

  /**
   * An `items:create` step's item server is this fact, and nothing built
   * `buildWorkspaceRuntime`'s own `deps.childServer` was ever read back: a typo here
   * would only ever surface, days later, as a step refusing create_child
   * against a real repository.
   */
  it("hands converge how to start its own item server, as this process on this workflow directory", async () => {
    const { dir } = await fixture();
    const rt = await buildMain(dir, {});
    expect(rt.deps.childServer).toEqual(childServerCommand(dir, "main"));
  });

  /**
   * The workflow's own `budget.stepTimeout`, not the engine's 10-minute
   * default: the shipped workflow happens to name 10m too, so a fixture that
   * left `deps.stepTimeoutMs` off `buildWorkspaceRuntime`'s returned deps entirely
   * would still pass every other test here — this is the one case where the
   * two numbers disagree, and the only thing standing between them.
   */
  it("hands converge the workflow's own step timeout, not the engine's default", async () => {
    const { dir } = await fixture({ budget: "7m" });
    const rt = await buildMain(dir, {});
    expect(rt.deps.stepTimeoutMs).toBe(420_000);
  });

  /**
   * The wiring item 1 of this task exists for: `createLogger` had no call site
   * anywhere in the running system, so nothing in it redacted anything.
   * Asserted on the logger the runtime actually hands to converge, and to
   * every hook through ctx.log, rather than on one this test built.
   */
  it("hands the loop a logger that redacts the resolved secret", async () => {
    const seen: LandraceEvent[] = [];
    const { dir } = await fixture();
    const rt = await buildMain(dir, { sink: (e) => seen.push(e) });

    rt.deps.log("step.invoked", { cmd: `curl -H "Authorization: Bearer ${TOKEN}"` });
    rt.deps.ctx.log("tracker.request", { url: `https://x.invalid/?t=${TOKEN}` });

    expect(JSON.stringify(seen)).not.toContain(TOKEN);
    expect(seen.filter((e) => JSON.stringify(e).includes("[redacted]"))).toHaveLength(2);
  });

  /*
   * The item panel's live lines: where the page reads them, and never with
   * a secret in them, whatever the agent put on its own command line.
   */
  it("hands converge an activity log under this repository's root that keeps the secret off disk", async () => {
    const { dir } = await fixture();
    const rt = await buildMain(dir, {});
    rt.deps.activity?.record(ITEM, "spec", 1, { kind: "tool", text: `Bash curl -H "Authorization: Bearer ${TOKEN}"`, at: 1 });
    const page = await createActivityLog(sandboxRoot(dir), (t) => t).read(ITEM, 0);
    expect(page).toMatchObject({ stage: "spec", round: 1, total: 1 });
    expect(JSON.stringify(page)).not.toContain(TOKEN);
  });

  // The page's panel reads the workspace's one log, the one every workflow's steps write to.
  it("hands the page the one activity log every workflow writes to", async () => {
    const { dir } = await fixture();
    await withFast(dir);
    const rt = await buildWorkspaceRuntime(dir, {});
    expect(rt.activity).toBeDefined();
    expect(rt.workflows.map((w) => w.deps.activity === rt.activity)).toEqual([true, true]);
  });

  it("keeps no activity for a runtime built only to read", async () => {
    const { dir } = await fixture();
    const rt = await buildMain(dir, { readOnly: true });
    expect(rt.deps.activity).toBeUndefined();
    expect(rt.activity).toBeUndefined();
  });

  /**
   * Ordering, and it is the point of the check rather than a detail of it:
   * importing a hook module runs whatever is at its top level, and a workflow
   * that cannot be proved sound must not get that far. Pinned because moving
   * the load earlier would look like tidying and would quietly run a user's
   * code against a workflow the engine has already decided not to run.
   */
  it("proves the workflow sound before importing anything out of the hooks directory", async () => {
    const { dir } = await fixture();
    const ran = join(dir, "imported.txt");
    await writeFile(
      join(dir, "hooks", "fake.ts"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(ran)}, "ran");\n${HOOK}`,
    );
    await writeFile(join(workflowIn(dir), "workflow.yaml"), WORKFLOW.replace("    entry: true\n", ""));

    await expect(buildMain(dir, {})).rejects.toThrow(/does not validate/);
    await expect(readFile(ran, "utf8")).rejects.toThrow();
  });

  /*
   * `validate` reports it and `start` refuses it: an item started in main
   * carries main's admit labels, fast claims every item, and the next tick
   * would halt it claimed twice. The two share a source because they load
   * one hook module. `status` only reads, and still describes them.
   */
  it("refuses two workflows over one source that both claim what one starts, and still lets status read", async () => {
    const { dir } = await fixture();
    await writeFile(join(workflowIn(dir), "workflow.yaml"), WORKFLOW.replace("description: test\n", "description: test\nadmit: [lr:auto]\n"));
    const eligible = 'eligible:\n  - when: { "node.state.labels": { $in: ["lr:auto"] } }\n    else: "no lr:auto label"\n';
    expect(WORKFLOW).toContain(eligible);
    await mkdir(workflowIn(dir, "fast"), { recursive: true });
    await writeFile(join(workflowIn(dir, "fast"), "workflow.yaml"), WORKFLOW.replace("name: e2e", "name: fast").replace(eligible, ""));

    await expect(buildWorkspaceRuntime(dir, {})).rejects.toThrow(
      "claims: workflows main and fast both claim an item started in main (fast states no eligible rule, so it claims every item)",
    );
    expect((await buildWorkspaceRuntime(dir, { readOnly: true })).workflows.map((w) => w.id)).toEqual(["main", "fast"]);
  });

  /*
   * `validate` reports it and `start` refuses it, in the same words: a stage
   * that names a branch, with no worktree for the branch to be checked out
   * in, would have its agent commit wherever this checkout happens to be.
   */
  it("refuses a stage's branch when steps do not run in worktrees", async () => {
    const { dir } = await fixture({ agentKeys: "isolation: none" });
    await mkdir(join(workflowIn(dir), "steps"), { recursive: true });
    await writeFile(join(workflowIn(dir), "steps", "build.md"), [
      "---", "capabilities: [repo:read, repo:write]", "output:", "  discriminator: kind", "  shapes: { done: {} }",
      "  routes:", "    - when: { kind: done }", '      effect: { type: tracker.comment, marker: "done:{round}" }',
      "---", "", "build", "",
    ].join("\n"));
    await writeFile(join(workflowIn(dir), "workflow.yaml"), WORKFLOW
      .replace("    terminal: true\n", "    step: steps/build.md\n    branch: \"landrace/{item}\"\n")
      .concat('  - id: done\n    terminal: true\n    triggers: [{ when: { "run.outputs.spec.kind": done } }]\n'));

    await expect(buildMain(dir, {})).rejects.toThrow(/branch: stage "spec"[\s\S]*agent\.isolation[\s\S]*"none"/);
    // Reading does not run a step, so `status` still works on it.
    await expect(buildMain(dir, { readOnly: true })).resolves.toBeDefined();
  });

  // `validate` names it, and `start` refuses it before the first step runs.
  it("refuses a step whose effort the executor does not take", async () => {
    const { dir } = await fixture();
    await mkdir(join(workflowIn(dir), "steps"), { recursive: true });
    await writeFile(join(workflowIn(dir), "steps", "build.md"), [
      "---", "capabilities: [repo:read]", "effort: extreme", "output:", "  discriminator: kind", "  shapes: { done: {} }",
      "  routes:", "    - when: { kind: done }", '      effect: { type: tracker.comment, marker: "done:{round}" }',
      "---", "", "build", "",
    ].join("\n"));
    await writeFile(join(workflowIn(dir), "workflow.yaml"), WORKFLOW
      .replace("    terminal: true\n", "    step: steps/build.md\n")
      .concat('  - id: done\n    terminal: true\n    triggers: [{ when: { "run.outputs.spec.kind": done } }]\n'));

    await expect(buildMain(dir, {})).rejects.toThrow(/steps\/build\.md asks for effort "extreme", which the claude executor does not take/);
  });

  /**
   * §11.8 in the daemon, not only in the CLI.
   *
   * `landrace validate` unions the hooks' `provides` and rejects a workflow
   * whose predicate reads a path nothing supplies; `start` used to run that
   * same workflow, halting items one at a time against a live repository
   * over a fact the engine already knew before the first request. A validator
   * that checks less in the daemon than in the CLI is the "silently stops
   * checking" failure, one layer over.
   *
   * The hook here declares `provides` — with no declaration the rule abstains
   * for the whole graph, which is the state every other fixture in this file
   * is in and the reason none of them could ever have caught this.
   */
  it("refuses to start a workflow whose predicate reads a path no hook provides", async () => {
    const { dir } = await fixture({
      provides: ["item", "item.body", "entries"],
      reads: "artifacts.pr.number",
    });

    await expect(buildMain(dir, {})).rejects.toThrow(
      /path-coverage: stage "spec" reads artifacts\.pr\.number, which no hook provides/,
    );
  });

  it("starts when the hooks do provide what the workflow reads", async () => {
    const { dir } = await fixture({
      provides: ["item", "item.body", "entries", "artifacts.pr.*"],
      reads: "artifacts.pr.number",
    });

    expect((await buildMain(dir, {})).source.id).toBe("fake");
  });

  it("screens prompts when the config says to", async () => {
    const { dir } = await fixture({ screen: true });
    expect((await buildMain(dir, {})).deps.screen).toBeDefined();
  });

  /**
   * Screening is a security control (§15) that silently ignored configuration:
   * it always ran the engine's own claude executor, so a workflow whose hook
   * registers an executor screened with something the operator never asked
   * for — or, with no claude on the machine, not at all.
   */
  it("screens with the executor the config names, not always with the engine's own", async () => {
    const { dir } = await fixture({ agent: "fake", screen: true, securityKeys: "model: fake-small" });
    await writeFile(join(dir, "hooks", "fake.ts"), `${HOOK}
${EXECUTOR}`);

    const rt = await buildMain(dir, {});
    expect(rt.deps.executor.id).toBe("fake");
    expect(rt.deps.screen?.executor).toBe(rt.deps.executor);
    expect(rt.deps.screen?.model).toBe("fake-small");
  });

  it("screens with security.adapter's executor while the steps stay on claude", async () => {
    const { dir } = await fixture({ screen: true, securityKeys: "adapter: fake, model: fake-small" });
    await writeFile(join(dir, "hooks", "fake.ts"), `${HOOK}
${EXECUTOR}`);

    const rt = await buildMain(dir, {});
    expect(rt.deps.executor.id).toBe("claude");
    expect(rt.deps.screen?.executor.id).toBe("fake");
    expect(rt.deps.screen?.model).toBe("fake-small");
  });

  /**
   * The sandbox is resolved at startup, not at the first invoke: a loop
   * started outside a repository would otherwise assemble, poll, and fail at
   * its first paid step — hours in, on an item it has already moved.
   */
  it("refuses to start when steps are to be isolated and there is no repository to isolate from", async () => {
    const { dir } = await fixture({ git: false });
    await expect(buildMain(dir, {})).rejects.toThrow(/not inside a git repository/);
  });

  /**
   * `agent.adapter` is the one id the engine still resolves by name. A name
   * nothing answers to used to mean a loop that ran and then failed at the
   * first invocation, hours in and one paid tick at a time.
   */
  it("refuses an agent.adapter no executor answers to, naming what it could have used", async () => {
    const { dir } = await fixture({ agent: "gpt-9" });
    await expect(buildMain(dir, {})).rejects.toThrow(/gpt-9[\s\S]*claude/);
  });

  it("refuses two notifiers under one id, naming both", async () => {
    const { dir } = await fixture({ hookExtra: `${notifierSource("one", "slack")}${notifierSource("two", "slack")}` });
    await expect(buildMain(dir, {})).rejects.toThrow('two notifiers share the id "slack": "../../hooks/fake.ts" and "../../hooks/fake.ts"');
  });

  it("refuses a notify.via the loaded notifiers do not answer to, naming the ones they do", async () => {
    const { dir } = await fixture({
      hookExtra: notifierSource("chat", "chat"), configExtra: "notify: { on: [needs-you], via: [slack] }\n",
    });
    await expect(buildMain(dir, {})).rejects.toThrow('notify.via names "slack", which no notifier registers: the loaded hooks register "chat"');
  });

  it("hands converge a notify when notify is configured, and none to a runtime built only to read", async () => {
    const { dir } = await fixture({
      hookExtra: notifierSource("chat", "chat"), configExtra: "notify: { on: [needs-you], via: [chat] }\n",
    });
    expect(typeof (await buildMain(dir, {})).deps.notify).toBe("function");
    expect((await buildMain(dir, { readOnly: true })).deps.notify).toBeUndefined();
  });

  /*
   * A workflow placed by the item's own labels, as `start` runs it: it
   * validates though no stage is entered, nothing is applied however many
   * ticks it runs, and the person it waits on is told once.
   */
  it("runs a workflow placed by the item's own state, and tells you once that an item waits on you", async () => {
    const review = (await readFile("tests/fixtures/review/workflow.yaml", "utf8"))
      .replace("eligible:", "hooks: [../../hooks/fake.ts, ../../hooks/claude.ts]\neligible:");
    const { dir, record } = await fixture({
      workflow: review, items: [{ id: ITEM, labels: ["review-requested"] }],
      hookExtra: RECORDING_NOTIFIER, configExtra: "notify: { on: [needs-you], via: [chat] }\n",
    });
    const rt = await buildWorkspaceRuntime(dir, {});

    for (let tick = 0; tick < 2; tick++) {
      expect(await tickWorkspace({ runtime: rt })).toEqual([
        { item: ITEM, workflow: "main", outcome: "wait after 1 pass(es): no trigger matched" },
      ]);
    }

    await until(async () => (await applied(record)).length > 0, "the notification");
    expect(await applied(record)).toEqual([{ notified: ITEM, workflow: "main", stage: "reviewing", why: "waiting on you" }]);
  });

  /**
   * `agent:` is opaque past `adapter` and `isolation`: everything else is the
   * executor's own vocabulary, and the claude hook refuses a key it does not
   * read rather than silently ignoring it. Reached only once the hook's
   * `create` actually runs, which is why this is `buildWorkspaceRuntime` and not a unit
   * test of `readClaudeSettings` — the wiring is what could still be wrong.
   */
  /*
   * Two workflows loading one hook module get its one set of objects: the
   * source the tick lists once, the preflight `runStart` runs once. What is
   * each workflow's own stays its own — the child server bound to its id, and
   * the steps a shared executor factory is built against, so an effort only
   * the second workflow's step asks for is still refused at startup.
   */
  it("builds each workflow its own deps, sharing by identity what one hook module exports", async () => {
    const { dir } = await fixture({ preflight: "pass" });
    await withFast(dir);
    const rt = await buildWorkspaceRuntime(dir, {});

    expect(rt.workflows.map((w) => w.id)).toEqual(["main", "fast"]);
    expect(rt.workflows[0]?.source).toBe(rt.workflows[1]?.source);
    expect(rt.preflights).toHaveLength(1);
    expect(rt.workflows.map((w) => w.deps.childServer)).toEqual([childServerCommand(dir, "main"), childServerCommand(dir, "fast")]);

    await mkdir(join(workflowIn(dir, "fast"), "steps"), { recursive: true });
    await writeFile(join(workflowIn(dir, "fast"), "steps", "build.md"), [
      "---", "capabilities: [repo:read]", "effort: extreme", "output:", "  discriminator: kind", "  shapes: { done: {} }",
      "  routes:", "    - when: { kind: done }", '      effect: { type: tracker.comment, marker: "done:{round}" }',
      "---", "", "build", "",
    ].join("\n"));
    await writeFile(join(workflowIn(dir, "fast"), "workflow.yaml"), WORKFLOW.replace("name: e2e", "name: fast").replaceAll("lr:auto", "lr:fast")
      .replace("    terminal: true\n", "    step: steps/build.md\n")
      .concat('  - id: done\n    terminal: true\n    triggers: [{ when: { "run.outputs.spec.kind": done } }]\n'));
    await expect(buildWorkspaceRuntime(dir, {})).rejects.toThrow(/steps\/build\.md asks for effort "extreme"/);
  });

  it("refuses to start when the claude hook cannot use its settings, naming the executor and the key", async () => {
    const { dir } = await fixture({ agentKeys: "plugin: [p@m]" });
    await expect(buildMain(dir, {})).rejects.toThrow(/executor "claude" could not start: agent\.plugin is not a setting/);
  });

  /*
   * `agent.plugins` and `agent.mcp`, end to end through the runtime a loop
   * actually runs: resolved from the repository root once, and handed to the
   * step's executor as definitions — so a step running somewhere with a
   * `.mcp.json` of its own still gets the operator's, and only the servers
   * named. The screener gets none of it.
   */
  it("hands the step's executor the servers resolved from the repository root, wherever the step runs, and the screener none", async () => {
    const memory = { command: "codebase-memory-mcp", args: [], env: {} };
    const { dir } = await fixture({
      screen: true,
      securityKeys: "model: haiku",
      agentKeys: "plugins: [superpowers@claude-plugins-official], mcp: [{ name: codebase-memory-mcp, tools: [search_graph, trace_path] }]",
      mcpJson: { mcpServers: { "codebase-memory-mcp": memory, landrace: { command: "node", args: ["dist/cli.js", "mcp"] } } },
    });
    const rt = await buildMain(dir, {});

    const bin = await mkdtemp(join(tmpdir(), "lr-bin-"));
    await copyFile(join(process.cwd(), "tests", "agent", "fake-agent.mjs"), join(bin, "claude"));
    await chmod(join(bin, "claude"), 0o755);
    // Where the step runs: somewhere with a `.mcp.json` of its own, the way a
    // worktree cut from a repository that committed one would be.
    const worktree = await mkdtemp(join(tmpdir(), "lr-worktree-"));
    await writeFile(join(worktree, "fake.json"), JSON.stringify({ out: "{{ARGV_JSON}}" }));
    await writeFile(join(worktree, ".mcp.json"), JSON.stringify({ mcpServers: { "codebase-memory-mcp": { command: "decoy" } } }));

    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ""}`;
    let step: string[];
    let screener: string[];
    try {
      const signal = new AbortController().signal;
      step = JSON.parse((await rt.deps.executor.run("x", { round: 1, cwd: worktree, capabilities: ["repo:read"], signal })).text) as string[];
      const screen = rt.deps.screen;
      if (!screen) throw new Error("screening was configured and the runtime built no screener");
      // The model on the run, the way screenPrompt asks for it: it is no
      // longer fixed into the executor, where a hook's never heard it.
      screener = JSON.parse((await screen.executor.run("x", { round: 0, cwd: worktree, ...(screen.model === undefined ? {} : { model: screen.model }), signal })).text) as string[];
    } finally {
      process.env.PATH = path;
    }

    expect(JSON.parse(step[step.indexOf("--mcp-config") + 1] as string)).toEqual({ mcpServers: { "codebase-memory-mcp": memory } });
    // Only the tools landrace.yaml listed, never the whole server.
    expect(step.slice(step.indexOf("--allowedTools") + 1)).toEqual([
      "mcp__codebase-memory-mcp__search_graph", "mcp__codebase-memory-mcp__trace_path",
    ]);
    expect(step).toContain("--settings");
    // The screener: no plugin, no server, no tool, and the model
    // `security.model` names — never `agent.model`, which is the step's own
    // "opus" and would otherwise be indistinguishable from the screener
    // quietly inheriting the executor's default.
    const after = (argv: string[], name: string): string | undefined => argv[argv.indexOf(name) + 1];
    expect(JSON.parse(after(screener, "--mcp-config") as string)).toEqual({ mcpServers: {} });
    expect(screener).toContain("--strict-mcp-config");
    expect(after(screener, "--tools")).toBe("");
    expect(screener).not.toContain("--settings");
    expect(after(screener, "--permission-mode")).toBe("manual");
    expect(after(screener, "--model")).toBe("haiku");
  });
});

/**
 * The startup preflight: a hook's `check` runs before the first tick, so a
 * permission problem is found before the first paid agent runs rather than
 * after a mid-run write fails with nothing durable recorded to show for it.
 *
 * Driven through a real hook module on disk, exactly as the wiring in
 * `runStart` reaches it — a unit test of `runPreflights` alone would prove
 * nothing about whether `landrace start` actually calls it.
 *
 * `buildWorkspaceRuntime` deliberately does *not* run it: `landrace status` builds a
 * runtime the same way, only to read, and a preflight can make a real write
 * (the GitHub hook's blob probe) that a read-only diagnostic must never make
 * and must never be refused for either — the token being *diagnosed* is
 * exactly the one most likely to fail a preflight. Only `runStart` runs
 * `rt.preflights`, once `buildWorkspaceRuntime` has handed them back unrun.
 */
describe("the startup preflight", () => {
  it("does not run when only buildWorkspaceRuntime is used — the write belongs to runStart alone", async () => {
    const { dir, record } = await fixture({ preflight: "pass" });
    await buildMain(dir, {});
    expect(await applied(record)).toEqual([]);
  });

  it("does not run for `landrace status`, which only reads", async () => {
    const { dir, record } = await fixture({ preflight: "pass" });
    await runStatus(dir);
    expect(await applied(record)).toEqual([]);
  });

  it("runs through runStart, before the tick it gates", async () => {
    const { dir, record } = await fixture({ preflight: "pass" });
    await runStart(dir, { once: true });
    expect(await applied(record)).toEqual([
      { preflight: true },
      { item: ITEM, type: "tracker.comment" },
    ]);
  });

  /**
   * A preflight skips what no loaded step asks for — the tracker's `childType`
   * is checked only when one may create children — so what runStart hands it
   * has to be the loaded steps' own capabilities. Absent, the check comes
   * back and refuses a project that names its child type differently.
   */
  it("hands the preflights the capabilities the loaded steps declare", async () => {
    const capabilities = async (declared: string): Promise<unknown[]> => {
      // No item to work, so the one tick runs no step.
      const { dir, record } = await fixture({ items: [], workflow: stepped(declared.includes("items:create")), hookExtra: CAPABILITIES });
      await mkdir(join(workflowIn(dir), "steps"), { recursive: true });
      await writeFile(join(workflowIn(dir), "steps", "breakdown.md"), breakdownStep(declared));
      await runStart(dir, { once: true });
      return await applied(record);
    };
    expect(await capabilities("repo:read, items:create")).toEqual([{ capabilities: ["items:create", "repo:read"] }]);
    expect(await capabilities("repo:read")).toEqual([{ capabilities: ["repo:read"] }]);
  });
});

/** A stage that runs a step, `steps/breakdown.md`, written by the test; one that `creates` children closes the last round's. */
const stepped = (creates: boolean): string => `version: 1
name: e2e
description: test
hooks: [../../hooks/fake.ts, ../../hooks/claude.ts]
eligible:
  - when: { "node.state.labels": { $in: ["lr:auto"] } }
    else: "no lr:auto label"
stages:
  - id: breakdown
    entry: true
    step: steps/breakdown.md
    triggers:
      - name: fresh item
        when: { "run.stage": null }
    on_enter:
      - { type: tracker.comment, kind: enter, marker: "enter:{stage}:{round}", body: "Breaking it down, round {round}." }
${creates ? "      - { type: nodes.close, follow: [child-of] }\n" : ""}  - id: done
    terminal: true
    triggers:
      - name: broken down
        when: { "run.stage": breakdown, "run.outputs.breakdown.kind": done }
`;

/** The step `stepped` runs, declaring `capabilities`. */
const breakdownStep = (capabilities: string): string => `---
capabilities: [${capabilities}]
model: opus
output:
  discriminator: kind
  shapes:
    done: {}
  routes:
    - when: { kind: done }
      effect: { type: tracker.comment, marker: "done:{round}" }
---

Break it down.
`;

/** A preflight that writes down the capabilities it was handed, or that it was handed none. */
const CAPABILITIES = `
export const capabilities = brand("preflight", {
  id: "capabilities",
  check: async (ctx: Ctx & { capabilities?: Set<string> }): Promise<void> => {
    await appendFile(ctx.config.tracker.record, JSON.stringify({ capabilities: ctx.capabilities ? [...ctx.capabilities].sort() : null }) + "\\n");
  },
});
`;

/** A second workflow, `fast`, beside the fixture's `main`: the same hook modules, so the same source and preflight objects, and its own label. */
async function withFast(dir: string): Promise<void> {
  await mkdir(workflowIn(dir, "fast"), { recursive: true });
  await writeFile(join(workflowIn(dir, "fast"), "workflow.yaml"), WORKFLOW.replace("name: e2e", "name: fast").replaceAll("lr:auto", "lr:fast"));
}

/** What `fn` printed to stdout, line by line. ESM mode has no `jest` global to spy with. */
async function stdoutOf(fn: () => Promise<unknown>): Promise<string[]> {
  const printed: string[] = [];
  const wrote = console.log;
  console.log = (line: unknown): void => {
    printed.push(String(line));
  };
  try {
    await fn();
  } finally {
    console.log = wrote;
  }
  return printed;
}

describe("runStart --once over two workflows", () => {
  it("works each item under the workflow that claims it, running the shared preflight once", async () => {
    const { dir, record } = await fixture({ preflight: "pass", items: [{ id: ITEM, labels: ["lr:auto"] }, { id: "4343", labels: ["lr:fast"] }] });
    await withFast(dir);

    const printed = await stdoutOf(() => runStart(dir, { once: true }));

    expect(printed.filter((l) => l.startsWith("#"))).toEqual([
      `#${ITEM} [main] terminal after 1 pass(es)`,
      "#4343 [fast] terminal after 1 pass(es)",
    ]);
    const writes = await applied(record);
    expect(writes.filter((w) => JSON.stringify(w).includes("preflight"))).toEqual([{ preflight: true }]);
    expect(writes.filter((w) => !JSON.stringify(w).includes("preflight"))).toEqual(expect.arrayContaining([
      { item: ITEM, type: "tracker.comment" }, { item: "4343", type: "tracker.comment" },
    ]));
  });

  it("works neither workflow's way an item both claim, and says so", async () => {
    const { dir, record } = await fixture({ items: [{ id: ITEM, labels: ["lr:auto", "lr:fast"] }] });
    await withFast(dir);

    const printed = await stdoutOf(() => runStart(dir, { once: true }));

    expect(printed.filter((l) => l.startsWith("#"))).toEqual([`#${ITEM} claimed by fast and main`]);
    expect(await applied(record)).toEqual([]);
  });

  /*
   * One shot, one answer: a source that could not list is the tick's
   * failure, said by the exit code, naming the workflows it serves.
   */
  it("fails, naming the workflows, when a source cannot list", async () => {
    const { dir } = await fixture({ listFails: "GET /issues → 401" });
    await withFast(dir);
    await expect(stdoutOf(() => runStart(dir, { once: true }))).rejects.toThrow("could not list the source of fast and main: GET /issues → 401");
  });
});

describe("runStart --once", () => {

  it("enumerates, locks, builds a snapshot, decides and applies, then releases the lock", async () => {
    const { dir, record } = await fixture();
    // Swapped by hand: ESM mode takes the `jest` global away from this pass
    // (see jest.esm.config.mjs), so there is no spy to reach for.
    const printed: string[] = [];
    const wrote = console.log;
    console.log = (line: unknown): void => {
      printed.push(String(line));
    };

    try {
      await runStart(dir, { once: true });
    } finally {
      console.log = wrote;
    }

    // One workflow: nothing to tell apart, so no `[main]` beside the id.
    expect(printed.filter((l) => l.startsWith("#"))).toEqual([`#${ITEM} terminal after 1 pass(es)`]);
    expect(await applied(record)).toEqual([{ item: ITEM, type: "tracker.comment" }]);
    // Nothing is left holding the item: the next run is free to take it.
    expect(await acquire(ITEM, "tick")).toBe(true);
  });

  /*
   * The row printed per item is stdout, beside the log and outside it. A
   * value an executor's setup registered through `redact` — an allowlisted
   * server's env — was kept out of the log and printed here in the clear,
   * whenever a failure quoted it.
   */
  it("keeps a value the executor registered through redact out of the row it prints", async () => {
    const { dir } = await fixture({
      agentKeys: "mcp: [codebase-memory-mcp]",
      mcpJson: { mcpServers: { "codebase-memory-mcp": { command: "codebase-memory-mcp", env: { MEMORY_TOKEN: "env-secret-value" } } } },
      preFails: "upstream refused MEMORY_TOKEN=env-secret-value",
    });
    const printed: string[] = [];
    const wrote = console.log;
    console.log = (line: unknown): void => {
      printed.push(String(line));
    };

    try {
      await runStart(dir, { once: true });
    } finally {
      console.log = wrote;
    }

    const rows = printed.filter((l) => l.startsWith("#"));
    expect(rows).toEqual([expect.stringMatching(new RegExp(`^#${ITEM} halt after 1 pass\\(es\\): .*\\[redacted\\]`))]);
    expect(printed.join("\n")).not.toContain("env-secret-value");
  });

  /*
   * Telemetry from the command line to the collector: `--telemetry` and
   * `--otel` reach the settings, every event reaches the exporter, and the
   * batch — whose 5s delay this run never waits out — is flushed on the way
   * out. The console exporter stands in for a collector: it writes each
   * record with console.dir.
   */
  it("exports every event as a log record and flushes them before it returns", async () => {
    const { dir } = await fixture();
    const records: { body?: unknown; resource?: { attributes?: Record<string, unknown> } }[] = [];
    const [log, dir_] = [console.log, console.dir];
    console.log = (): void => {};
    console.dir = (record: unknown): void => {
      records.push(record as (typeof records)[number]);
    };

    try {
      await runStart(dir, { once: true, otel: ["OTEL_LOGS_EXPORTER=console", "OTEL_SERVICE_NAME=lr-e2e", "LANDRACE_ENABLE_TELEMETRY=1"] });
    } finally {
      [console.log, console.dir] = [log, dir_];
    }

    expect(records.map((r) => r.body)).toEqual(expect.arrayContaining(["tick.started", "effect.applied", "tick.finished"]));
    expect(records[0]?.resource?.attributes?.["service.name"]).toBe("lr-e2e");
  });

  // A header value is not a secret by virtue of being a header: redacting
  // every one would strike "production" out of every event and comment.
  it("leaves an ordinary word that happens to be a header value in the log", async () => {
    const seen: LandraceEvent[] = [];
    const { dir } = await fixture();
    const rt = await buildMain(dir, {
      sink: (e) => seen.push(e),
      otel: ["LANDRACE_ENABLE_TELEMETRY=1", "OTEL_LOGS_EXPORTER=console", "OTEL_EXPORTER_OTLP_HEADERS=x-scope-orgid=production"],
    });
    const dir_ = console.dir;
    console.dir = (): void => {};
    try {
      rt.deps.log("step.started", { note: "deploying to production" });
      await rt.telemetry?.shutdown();
    } finally {
      console.dir = dir_;
    }
    expect(seen).toEqual([{ name: "step.started", note: "deploying to production" }]);
  });

  /**
   * `--once` is refused too, not only the daemon loop: a failing preflight
   * must stop the process before the one tick `--once` would otherwise run,
   * proved here by the tick's own side effects never happening at all.
   */
  it("refuses to start, and never runs the one tick, when a preflight fails", async () => {
    const { dir, record } = await fixture({ preflight: "throw" });
    const printed: string[] = [];
    const wrote = console.log;
    console.log = (line: unknown): void => {
      printed.push(String(line));
    };

    try {
      await expect(runStart(dir, { once: true })).rejects.toThrow(
        /preflight "fake" failed: token needs "Contents: Read and write" on acme\/widgets/,
      );
    } finally {
      console.log = wrote;
    }

    // The preflight itself ran (and threw) — nothing past it did: no line was
    // printed, and the tick's own effect never landed.
    expect(printed).toEqual([]);
    expect(await applied(record)).toEqual([{ preflight: true }]);
  });

  /**
   * Ctrl-C. The signal the interrupt handler aborts is the one every hook and
   * executor was handed, so a pass that has not started does not start — and
   * the lock comes off on the way out rather than waiting for the pid check
   * to reclaim it.
   */
  it("stops the work in flight and releases the lock when the runtime is asked to stop", async () => {
    const { dir, record } = await fixture();
    const rt = await buildMain(dir, {});
    rt.stop.abort();

    const rows = await tickWorkspace({ runtime: rt });

    expect(rows[0]?.outcome).toMatch(/aborted/);
    expect(await applied(record)).toEqual([]);
    expect(await acquire(ITEM, "tick")).toBe(true);
  });
});

/*
 * What a server's definition carries in argv — `env`, `headers` — can come
 * back in the agent's own stderr when a server fails to start, and from there
 * into an `agent exited …` message the loop logs. The runtime's logger
 * redacts it like any declared secret.
 */
describe("an allowlisted server's env and headers", () => {
  it("are redacted from an `agent exited …` message the loop logs", async () => {
    const seen: LandraceEvent[] = [];
    const { dir } = await fixture({
      agentKeys: "mcp: [codebase-memory-mcp, remote]",
      mcpJson: { mcpServers: {
        "codebase-memory-mcp": { command: "codebase-memory-mcp", env: { MEMORY_TOKEN: "env-secret-value" } },
        remote: { type: "http", url: "https://mcp.example.invalid", headers: { Authorization: "Bearer header-secret" } },
      } },
    });
    const rt = await buildMain(dir, { sink: (e) => seen.push(e) });

    const bin = await mkdtemp(join(tmpdir(), "lr-bin-"));
    await copyFile(join(process.cwd(), "tests", "agent", "fake-agent.mjs"), join(bin, "claude"));
    await chmod(join(bin, "claude"), 0o755);
    const cwd = await mkdtemp(join(tmpdir(), "lr-exit-"));
    await writeFile(join(cwd, "fake.json"), JSON.stringify({
      exit: 3, stderr: "MCP server failed: MEMORY_TOKEN=env-secret-value, Authorization: Bearer header-secret",
    }));

    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ""}`;
    let reason = "";
    try {
      await rt.deps.executor.run("x", { round: 1, cwd, capabilities: ["repo:read"], signal: new AbortController().signal });
    } catch (e) {
      reason = (e as Error).message;
    } finally {
      process.env.PATH = path;
    }
    // What converge logs when a step's executor fails, through the same logger.
    expect(reason).toMatch(/^agent exited 3: /);
    rt.deps.log("step.rejected", { item: ITEM, kind: "unavailable", reason });

    const logged = JSON.stringify(seen);
    expect(logged).not.toContain("env-secret-value");
    expect(logged).not.toContain("Bearer header-secret");
    expect(logged).toContain("[redacted]");
  });
});

describe("runStatus", () => {
  it("prints each item with the workflow that claims it, and an item two claim with both", async () => {
    const { dir } = await fixture({ items: [{ id: ITEM, labels: ["lr:auto"] }, { id: "4343", labels: ["lr:fast"] }, { id: "4444", labels: ["lr:auto", "lr:fast"] }] });
    await withFast(dir);

    const lines = await runStatus(dir);

    expect(lines).toEqual([
      expect.stringMatching(new RegExp(`^#${ITEM} \\[main\\] .*Add export.*queued$`)),
      expect.stringMatching(/^#4343 \[fast\] .*Add export.*queued$/),
      expect.stringMatching(/^#4444 .*Add export.*halted: claimed by fast and main$/),
    ]);
  });

  it("prints one line per item, from the same source the loop enumerates, untagged with one workflow", async () => {
    const { dir } = await fixture();
    const lines = await runStatus(dir);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`^#${ITEM} {2}— {2}Add export.*queued`));
  });

  /*
   * `status` never runs a step, so what a step would be handed is none of its
   * business: a fresh clone nobody has run `agsync sync` in yet is exactly
   * where someone asks what landrace thinks of their items. `start` still
   * refuses the same checkout — the buildWorkspaceRuntime tests pin that.
   */
  it("reads the items with agent.mcp set and no .mcp.json at all", async () => {
    const { dir } = await fixture({ agentKeys: "mcp: [codebase-memory-mcp]" });
    await expect(buildMain(dir, {})).rejects.toThrow(/\.mcp\.json does not exist/);

    const lines = await runStatus(dir);
    expect(lines[0]).toMatch(new RegExp(`#${ITEM}.*Add export.*queued`));

    // And what it built can read and nothing more: a step run without the
    // servers its configuration names would be a step run bare.
    const rt = await buildMain(dir, { readOnly: true });
    await expect(rt.deps.executor.run("x", { round: 1, capabilities: ["repo:read"], signal: new AbortController().signal }))
      .rejects.toThrow(/not to run steps/);
  });
});

/**
 * The daemon's half of an MCP write reaching it: `landrace mcp` touches the
 * wake file, and the loop has to be watching it. A watcher never started in
 * `runStart` leaves every unit test of `watchWake` green while every MCP
 * write goes back to waiting out the interval — thirty seconds here.
 */
describe("runStart and the wake file", () => {
  const until = async (cond: () => Promise<boolean>, ms: number): Promise<void> => {
    const end = Date.now() + ms;
    while (!(await cond())) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  it("runs a pass as soon as the wake file is touched, well before the next scheduled tick", async () => {
    const { dir, record } = await fixture();
    const wrote = console.log;
    const said = console.error;
    console.log = (): void => {};
    console.error = (): void => {};
    const running = runStart(dir, { ui: false });
    try {
      await until(async () => (await applied(record)).length === 1, 10_000);
      touchWake(wakePath(dir));
      await until(async () => (await applied(record)).length === 2, 5_000);
    } finally {
      process.emit("SIGINT");
      await running;
      console.log = wrote;
      console.error = said;
    }
  }, 20_000);
});

/*
 * The page through the daemon's own path. A tracker blip used to hand the
 * board an empty graph, and `board.list` forgets every id it is not handed:
 * one failed list emptied the page and refused every action on it until the
 * next good tick. A source that cannot list is shown as it last listed, and
 * nothing is written to an item the failed listing could not judge.
 */
const until = async (cond: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

describeLoopback("runStart's page while a source cannot list", () => {

  it("keeps the items it last listed on the board, and refuses to write to one until the source lists again", async () => {
    const flag = join(await mkdtemp(join(tmpdir(), "lr-flag-")), "down");
    const { dir, record } = await fixture({ listFailsWhen: flag });
    const said: string[] = [];
    const [log, error] = [console.log, console.error];
    console.log = (): void => {};
    console.error = (line: unknown): void => {
      said.push(String(line));
    };
    const running = runStart(dir, { uiPort: 0 });
    try {
      await until(() => said.some((l) => l.includes("triage page at ")), "the page to start");
      const url = said.find((l) => l.includes("triage page at "))?.split("triage page at ")[1] ?? "";
      const listed = async (): Promise<string[]> => ((await (await fetch(`${url}board.json`)).json()) as BoardView).rows.map((r) => r.id);
      const post = (path: string, action: string): Promise<Response> =>
        fetch(`${url}${path}`, { method: "POST", headers: { "x-landrace-action": action } });
      await until(async () => (await applied(record)).length === 1 && (await listed()).includes(ITEM), "the first tick to work the item");

      await writeFile(flag, "");
      expect((await post("refresh", "refresh")).status).toBe(502);
      expect(await listed()).toEqual([ITEM]);

      touchWake(wakePath(dir));
      await until(() => said.some((l) => l.includes("tick failed: could not list the source of main")), "a tick that cannot list");
      expect(await listed()).toEqual([ITEM]);

      const retried = await post(`items/${ITEM}/retry`, "retry");
      expect(retried.status).toBe(409);
      expect(await retried.text()).toMatch(/could not list the source of main: GET \/issues → 502/);
      // The panel's writes are refused alike, in the same words.
      const replied = await fetch(`${url}items/${ITEM}/reply`, { method: "POST", headers: { "x-landrace-action": "reply" }, body: "hi" });
      expect(replied.status).toBe(409);
      expect(await replied.text()).toMatch(/not written to until every source lists again: could not list the source of main/);
      expect(await applied(record)).toEqual([{ item: ITEM, type: "tracker.comment" }]);
    } finally {
      process.emit("SIGINT");
      await running;
      [console.log, console.error] = [log, error];
    }
  }, 30_000);
});

/*
 * The page over two workflows, through the daemon's own wiring: each row
 * names the workflow that owns it, an item both claim waits in Needs you
 * naming both, and nothing the page can post reaches either workflow for it.
 */
describeLoopback("runStart's page over two workflows", () => {
  it("names each item's workflow, files one both claim under Needs you, and refuses to act on it", async () => {
    const { dir, record } = await fixture({
      items: [
        { id: ITEM, labels: ["lr:auto"] }, { id: "4343", labels: ["lr:fast"] }, { id: "4444", labels: ["lr:auto", "lr:fast"] },
        { id: "4545", labels: ["lr:auto"], closed: "done" },
      ],
    });
    await withFast(dir);
    const said: string[] = [];
    const [log, error] = [console.log, console.error];
    console.log = (): void => {};
    console.error = (line: unknown): void => {
      said.push(String(line));
    };
    const running = runStart(dir, { uiPort: 0 });
    try {
      await until(() => said.some((l) => l.includes("triage page at ")), "the page to start");
      const url = said.find((l) => l.includes("triage page at "))?.split("triage page at ")[1] ?? "";
      const rows = async (): Promise<BoardView["rows"]> => ((await (await fetch(`${url}board.json`)).json()) as BoardView).rows;
      await until(async () => (await applied(record)).length === 2 && (await rows()).length === 4, "the first tick to work both items");

      const row = async (id: string) => (await rows()).find((r) => r.id === id);
      // Tagged by name: two workflows, so which one is worth saying.
      expect(await row(ITEM)).toMatchObject({ workflow: "main", tag: "e2e" });
      expect(await row("4343")).toMatchObject({ workflow: "fast", tag: "fast" });
      expect(await row("4444")).toMatchObject({
        workflow: null, badge: "needs-you", note: "claimed by fast and main", retry: null, clear: null, goto: [],
      });

      const sentence = "#4444 is claimed by fast and main; act on it after one workflow alone claims it";
      for (const [path, action, body] of [["retry", "retry"], ["goto/spec", "goto"], ["reply", "reply", "hi"]] as const) {
        const res = await fetch(`${url}items/4444/${path}`, { method: "POST", headers: { "x-landrace-action": action }, ...(body === undefined ? {} : { body }) });
        expect([path, res.status, await res.text()]).toEqual([path, 409, sentence]);
      }
      expect((await applied(record)).filter((w) => JSON.stringify(w).includes("4444"))).toEqual([]);
      // Reads decide nothing: its conversation is read through the one source that lists it.
      const conflicted = await fetch(`${url}items/4444/conversation`, { headers: { "x-landrace-action": "conversation" } });
      expect([conflicted.status, await conflicted.json()]).toEqual([200, []]);

      // A closed item is no workflow's, but its conversation is read through
      // the one source that lists it; nothing is written to it.
      const read = await fetch(`${url}items/4545/conversation`, { headers: { "x-landrace-action": "conversation" } });
      expect([read.status, await read.json()]).toEqual([200, []]);
      const replied = await fetch(`${url}items/4545/reply`, { method: "POST", headers: { "x-landrace-action": "reply" }, body: "hi" });
      expect([replied.status, await replied.text()]).toEqual([409, "#4545 is closed, so nothing is written to it"]);
    } finally {
      process.emit("SIGINT");
      await running;
      [console.log, console.error] = [log, error];
    }
  }, 30_000);
});
