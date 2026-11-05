import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildWorkspaceRuntime, childServerCommand, localGate, runStart } from "#cli/start.js";
import { buildChildTool } from "#cli/mcp.js";
import { createLogger } from "#runner/events.js";
import { runStatus } from "#cli/status.js";
import { portCommand, readInstance, writeInstance } from "#cli/port.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { BoardView, BuildOptions, CredentialStore, FrontDoorOptions, LandraceEvent, RunningItem, StartOptions, WorkflowRuntime, WorkspaceRuntime } from "#namespace.js";
import { frontDoorListener } from "#front/server.js";
import { reportValidate, runValidate } from "#cli/validate.js";
import { createCredentialStore } from "#people/store.js";
import { repositoryRoot } from "#agent/worktree.js";
import { createActivityLog } from "#runner/activity.js";
import { acquire, release } from "#runner/lock.js";
import { sandboxRoot } from "#sandbox.js";
import { tickWorkspace } from "#runner/tick.js";
import { touchWake, wakePath } from "#wake.js";
import { describeLoopback } from "#tests/support/loopback.js";
import { memoryFetch } from "#tests/support/memory-http.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
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
    expect(rt.deps.childServer).toEqual(childServerCommand(dir, "main", "local"));
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
   * #179: every event the runtime logs is the local person's — its own log,
   * every hook's ctx.log and each workflow's deps — and a workflow's deps
   * name the workflow too, which is how `agent.limited` names it.
   */
  it("stamps every runtime event with the local person, and a workflow's own with its id", async () => {
    const seen: LandraceEvent[] = [];
    const { dir } = await fixture({ configExtra: "people: { local: { email: dev1@example.invalid } }\n" });
    const rt = await buildMain(dir, { sink: (e) => seen.push(e) });

    rt.log("tick.started", {});
    rt.ctx.log("tracker.request", {});
    rt.deps.ctx.log("tracker.request", {});
    rt.deps.log("step.finished", { item: ITEM });

    const who = { person: "local", personEmail: "dev1@example.invalid" };
    expect(seen).toEqual([
      { name: "tick.started", ...who },
      { name: "tracker.request", ...who },
      { name: "tracker.request", ...who },
      { name: "step.finished", ...who, workflow: "main", item: ITEM },
    ]);
  });

  /*
   * #185: the process's own logger names nobody, and each person's runtime
   * stamps its own. Locally that is one person, so a local start prints
   * every event as theirs, and its rows as it always did.
   */
  it("prints every event of a local --once run as the local person's, and a row per item", async () => {
    const { dir } = await fixture();
    const printed: string[] = [];
    const log = console.log;
    console.log = (line: unknown): void => { printed.push(String(line)); };
    try {
      await runStart(dir, { once: true, ui: false });
    } finally {
      console.log = log;
    }
    const events = printed.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as LandraceEvent);
    expect(events.map((e) => e.name)).toEqual(expect.arrayContaining(["tick.started", "tick.finished"]));
    expect(events.filter((e) => e.person !== "local")).toEqual([]);
    expect(printed.filter((l) => l.startsWith("#"))).toEqual([expect.stringMatching(new RegExp(`^#${ITEM} terminal after`))]);
  });

  it("stamps only the person, with no email, when landrace.yaml names no people", async () => {
    const seen: LandraceEvent[] = [];
    const { dir } = await fixture();
    const rt = await buildMain(dir, { sink: (e) => seen.push(e) });
    rt.log("tick.started", {});
    expect(seen).toEqual([{ name: "tick.started", person: "local" }]);
  });

  it("refuses to start while people.local.email's variable is unset", async () => {
    const { dir } = await fixture({ configExtra: "people: { local: { email: $LR_TEST_UNSET_EMAIL } }\n" });
    await expect(buildWorkspaceRuntime(dir, {})).rejects.toThrow(/people\.local\.email: people\.local\.email is \$LR_TEST_UNSET_EMAIL/);
  });

  /*
   * The item panel's live lines: where the page reads them, and never with
   * a secret in them, whatever the agent put on its own command line.
   */
  it("hands converge an activity log under this repository's root that keeps the secret off disk", async () => {
    const { dir } = await fixture();
    const rt = await buildMain(dir, {});
    rt.deps.activity?.record(ITEM, "spec", 1, { kind: "tool", text: `Bash curl -H "Authorization: Bearer ${TOKEN}"`, at: 1 });
    const page = await createActivityLog(sandboxRoot(dir), "local", (t) => t).read(ITEM, 0);
    expect(page).toMatchObject({ stage: "spec", round: 1, total: 1 });
    expect(JSON.stringify(page)).not.toContain(TOKEN);
  });

  // The page's panel reads the person's one log, the one every workflow's steps write to.
  it("hands the page the person's one activity log every workflow writes to", async () => {
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

  // In `validate`'s words: a pairing is cut a checkout of its own.
  it("refuses a stage that waits for a pairing when steps do not run in worktrees", async () => {
    const { dir } = await fixture({ agentKeys: "isolation: none" });
    await mkdir(join(workflowIn(dir), "steps"), { recursive: true });
    await writeFile(join(workflowIn(dir), "steps", "design.md"), [
      "---", "capabilities: [repo:read]", "output:", "  discriminator: kind", "  shapes: { done: {} }",
      "  routes:", "    - when: { kind: done }", '      effect: { type: tracker.comment, marker: "done:{round}" }',
      "---", "", "design", "",
    ].join("\n"));
    await writeFile(join(workflowIn(dir), "workflow.yaml"), WORKFLOW
      .replace("    terminal: true\n", "    step: steps/design.md\n    waits: pairing\n")
      .concat('  - id: done\n    terminal: true\n    triggers: [{ when: { "run.outputs.spec.kind": done } }]\n'));

    await expect(buildMain(dir, {})).rejects.toThrow(/waits: stage "spec" waits for a pairing, but agent\.isolation is "none"/);
    await expect(buildMain(dir, { readOnly: true })).resolves.toBeDefined();
  });

  // The executor is built against the stages that wait for a pairing, and
  // Codex can only carry on a session an agent there never started.
  it("refuses a stage that waits for a pairing under an executor that cannot start one afresh", async () => {
    const codex = JSON.stringify(join(process.cwd(), "integrations", "codex", "index.ts"));
    const { dir } = await fixture({
      agent: "codex", agentKeys: "sandbox: { deny: [] }",
      hookExtra: `\nconst { Codex } = await import((await import("node:url")).pathToFileURL(${codex}).href);\nexport const codex = new Codex();\n`,
    });
    await mkdir(join(workflowIn(dir), "steps"), { recursive: true });
    await writeFile(join(workflowIn(dir), "steps", "design.md"), [
      "---", "capabilities: [repo:read]", "output:", "  discriminator: kind", "  shapes: { done: {} }",
      "  routes:", "    - when: { kind: done }", '      effect: { type: tracker.comment, marker: "done:{round}" }',
      "---", "", "design", "",
    ].join("\n"));
    await writeFile(join(workflowIn(dir), "workflow.yaml"), WORKFLOW
      .replace("    terminal: true\n", "    step: steps/design.md\n    waits: pairing\n")
      .concat('  - id: done\n    terminal: true\n    triggers: [{ when: { "run.outputs.spec.kind": done } }]\n'));

    await expect(buildMain(dir, {})).rejects.toThrow(/executor "codex" could not start: stage "spec" waits for a pairing, but the codex executor can only carry on/);
  });

  // Not only the kit's: a plain Executor hook with no handoff could never be
  // paired with either, and the item would sit in Needs you for good.
  it("refuses a stage that waits for a pairing under a plain executor hook with no handoff, and accepts one with", async () => {
    const pairing = async (handoff: boolean): Promise<string> => {
      const { dir } = await fixture({
        agent: "plain",
        hookExtra: `\nexport const plain = brand("executor", { id: "plain", run: async () => ({ text: "", sessionId: null })${
          handoff ? ', handoff: async () => ({ argv: [], cwd: "" })' : ""} });\n`,
      });
      await mkdir(join(workflowIn(dir), "steps"), { recursive: true });
      await writeFile(join(workflowIn(dir), "steps", "design.md"), [
        "---", "capabilities: [repo:read]", "output:", "  discriminator: kind", "  shapes: { done: {} }",
        "  routes:", "    - when: { kind: done }", '      effect: { type: tracker.comment, marker: "done:{round}" }',
        "---", "", "design", "",
      ].join("\n"));
      await writeFile(join(workflowIn(dir), "workflow.yaml"), WORKFLOW
        .replace("    terminal: true\n", "    step: steps/design.md\n    waits: pairing\n")
        .concat('  - id: done\n    terminal: true\n    triggers: [{ when: { "run.outputs.spec.kind": done } }]\n'));
      return dir;
    };

    await expect(buildMain(await pairing(false), {})).rejects.toThrow(
      'executor "plain" could not start: stage "spec" waits for a pairing, but the plain executor cannot hand a session to a person, so nobody could ever pair on it',
    );
    await expect(buildMain(await pairing(true), {})).resolves.toBeDefined();
  });

  /*
   * The item branch landrace.yaml names is the one every stage's branch is
   * held to, before any hook loads and again beside the hooks' coverage; and
   * a template that is none is refused with the configuration.
   */
  it("holds a stage's branch to the one landrace.yaml names, and refuses one that is no template", async () => {
    const branched = async (config: string, branch: string): Promise<string> => {
      const { dir } = await fixture({ configExtra: config });
      await mkdir(join(workflowIn(dir), "steps"), { recursive: true });
      await writeFile(join(workflowIn(dir), "steps", "build.md"), [
        "---", "capabilities: [repo:read, repo:write]", "output:", "  discriminator: kind", "  shapes: { done: {} }",
        "  routes:", "    - when: { kind: done }", '      effect: { type: tracker.comment, marker: "done:{round}" }',
        "---", "", "build", "",
      ].join("\n"));
      await writeFile(join(workflowIn(dir), "workflow.yaml"), WORKFLOW
        .replace("    terminal: true\n", `    step: steps/build.md\n    branch: "${branch}"\n`)
        .concat('  - id: done\n    terminal: true\n    triggers: [{ when: { "run.outputs.spec.kind": done } }]\n'));
      return dir;
    };

    await expect(buildMain(await branched('branch: "lr-{item}"\n', "landrace/{item}"), {}))
      .rejects.toThrow(/branch: stage "spec" works on branch "landrace\/\{item\}"; it must be lr-\{item\}, the branch landrace\.yaml names/);
    await expect(buildMain(await branched('branch: "lr-{item}"\n', "lr-{item}"), {})).resolves.toBeDefined();
    await expect(buildMain(await branched('branch: "{item}"\n', "{item}"), {})).rejects.toThrow(/branch: .*fixed text before \{item\}/);
  });

  // `validate` names it in the same words.
  it("refuses an issue filed in a project the loaded tracker does not create in", async () => {
    const { dir } = await fixture();
    await writeFile(join(workflowIn(dir), "workflow.yaml"), WORKFLOW.concat(
      '      - { type: tracker.create, project: ENG, title: Bug, marker: "bug:{round}" }\n',
    ));
    await expect(buildMain(dir, {})).rejects.toThrow(/tracker-create: stage "spec" files an issue in "ENG", but its tracker files issues in no other project/);
    // Reading files nothing, so `status` still works on it.
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

  /*
   * #182: `start` rebuilds its runtime on a connect, and the replaced one
   * never ticks again. A run it left in flight must still stop when its item
   * closes, so the new runtime's ticks judge the runs of the one map handed in.
   */
  it("stops, on its own tick, a closed item's run that a runtime it replaced started", async () => {
    const { dir } = await fixture({ items: [{ id: ITEM, labels: ["lr:auto"], closed: "done" }] });
    const controller = new AbortController();
    const running = new Map<string, RunningItem>([[ITEM, { controller, workflow: "main", done: Promise.resolve(), closed: false }]]);
    const events: LandraceEvent[] = [];
    const rt = await buildWorkspaceRuntime(dir, { running, sink: (e) => events.push(e) });

    expect(rt.running).toBe(running);
    await tickWorkspace({ runtime: rt });
    expect(controller.signal.aborted).toBe(true);
    expect(events.filter((e) => e.name === "item.aborted")).toEqual([
      expect.objectContaining({ item: ITEM, reason: "the item was closed" }),
    ]);

    const own = await buildWorkspaceRuntime(dir, {});
    expect(own.running).not.toBe(running);
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
    expect(rt.workflows.map((w) => w.deps.childServer)).toEqual([childServerCommand(dir, "main", "local"), childServerCommand(dir, "fast", "local")]);

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

  /*
   * #186, through the runtime a loop runs: the deny list is what
   * `buildWorkspaceRuntime` hands the executor, from the `others` the roster
   * passes it. A test that builds `denyPaths` by hand passes just as well
   * with either dropped.
   */
  describe("a step's deny list, from the people beside it", () => {
    const readDenied = async (opts: BuildOptions): Promise<{ dir: string; deny: string[] }> => {
      const { dir } = await fixture();
      const rt = await buildMain(dir, opts);
      const bin = await mkdtemp(join(tmpdir(), "lr-bin-"));
      await copyFile(join(process.cwd(), "tests", "agent", "fake-agent.mjs"), join(bin, "claude"));
      await chmod(join(bin, "claude"), 0o755);
      const cwd = await mkdtemp(join(tmpdir(), "lr-worktree-"));
      await writeFile(join(cwd, "fake.json"), JSON.stringify({ out: "{{ARGV_JSON}}" }));
      const path = process.env.PATH;
      process.env.PATH = `${bin}:${path ?? ""}`;
      try {
        const argv = JSON.parse((await rt.deps.executor.run("x", {
          round: 1, cwd, capabilities: ["repo:read"], signal: new AbortController().signal,
        })).text) as string[];
        const settings = JSON.parse(argv[argv.indexOf("--settings") + 1] as string) as { permissions: { deny: string[] } };
        return { dir, deny: settings.permissions.deny };
      } finally {
        process.env.PATH = path;
      }
    };

    it("denies another person's worktrees, asked of the others the runtime was handed", async () => {
      const { dir, deny } = await readDenied({ others: () => [{ id: "bob" }] });
      const bob = join(sandboxRoot(dir), "worktrees", "bob");
      expect(deny).toContain(`Read(/${bob}/**)`);
      expect(deny).toContain("Read(~/.landrace/credentials/**)");
    });

    it("denies only the credentials to a runtime with nobody beside it", async () => {
      const { dir, deny } = await readDenied({});
      expect(deny).toContain("Read(~/.landrace/credentials/**)");
      expect(deny.join("\n")).not.toContain(join(sandboxRoot(dir), "worktrees"));
    });
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

  /**
   * The tracker names a field a `tracker.create` maps that its issues cannot
   * hold, and it learns which fields are mapped only from what runStart hands
   * it: absent, nothing is checked and the first bug filed is refused.
   */
  it("hands the preflights each project's fields the loaded routes' tracker.create maps", async () => {
    const { dir, record } = await fixture({ items: [], workflow: stepped(false), hookExtra: CREATE_FIELDS });
    await mkdir(join(workflowIn(dir), "steps"), { recursive: true });
    await writeFile(join(workflowIn(dir), "steps", "breakdown.md"), FILING_STEP);
    await runStart(dir, { once: true });
    expect(await applied(record)).toEqual([{ createFields: { ENG: ["customfield_10050"] } }]);
  });

  /**
   * `tracker.field`'s `satisfied` reads `node.state.fields`, which a tracker
   * fills only with the ids the runtime's context names — the one context
   * every list, read and preflight is handed — and its preflight checks only
   * the values it is handed. Absent, every field reads as not read, and is
   * written again on every entry.
   */
  it("hands the runtime's context the fields the loaded tracker.field effects set, and the preflights their values", async () => {
    const { dir, record } = await fixture({ items: [], workflow: FIELDS_WORKFLOW, hookExtra: FIELD_VALUES });
    await mkdir(join(workflowIn(dir), "steps"), { recursive: true });
    await writeFile(join(workflowIn(dir), "steps", "breakdown.md"), FIELD_STEP);
    await runStart(dir, { once: true });
    expect(await applied(record)).toEqual([{
      trackerFields: ["customfield_10123", "customfield_10124"],
      fieldValues: { customfield_10123: [["R&D"]], customfield_10124: [3] },
    }]);
  });

  /**
   * Each tracker checks the values against its own project's screens, so a
   * preflight is handed only the values of the workflows that load it: handed
   * a second workflow's, on another project, it would refuse an option only
   * that project offers. One both load is handed both.
   */
  it("hands each preflight the field values of the workflows that load it, and no other's", async () => {
    const { dir, record } = await fixture({ items: [], workflow: FIELDS_WORKFLOW, hookExtra: FIELD_VALUES });
    await mkdir(join(workflowIn(dir), "steps"), { recursive: true });
    await writeFile(join(workflowIn(dir), "steps", "breakdown.md"), FIELD_STEP);
    await mkdir(join(workflowIn(dir, "ops"), "steps"), { recursive: true });
    await writeFile(join(workflowIn(dir, "ops"), "workflow.yaml"), FIELDS_WORKFLOW
      .replace("name: e2e", "name: ops").replace("lr:auto", "lr:ops")
      .replace("../../hooks/claude.ts]", "../../hooks/ops.ts, ../../hooks/claude.ts]")
      .replace('customfield_10123: ["R&D"]', 'customfield_10125: ["Ops"]'));
    await writeFile(join(workflowIn(dir, "ops"), "steps", "breakdown.md"), FIELD_STEP.replace("customfield_10124: 3", "customfield_10126: 4"));
    await writeFile(join(dir, "hooks", "ops.ts"), OPS_FIELD_VALUES);
    await runStart(dir, { once: true });
    expect(await applied(record)).toEqual([
      {
        trackerFields: ["customfield_10123", "customfield_10124", "customfield_10125", "customfield_10126"],
        fieldValues: { customfield_10123: [["R&D"]], customfield_10124: [3], customfield_10125: [["Ops"]], customfield_10126: [4] },
      },
      { ops: { customfield_10125: [["Ops"]], customfield_10126: [4] } },
    ]);
  });
});

/** A preflight only the ops workflow loads, writing down the values it was handed. */
const OPS_FIELD_VALUES = `import { appendFile } from "node:fs/promises";

export const opsValues = Object.defineProperty({
  id: "ops-field-values",
  check: async (ctx: { config: { tracker: { record: string } }; fieldValues?: Map<string, unknown[]> }): Promise<void> => {
    await appendFile(ctx.config.tracker.record, JSON.stringify({ ops: ctx.fieldValues ? Object.fromEntries(ctx.fieldValues) : null }) + "\\n");
  },
}, Symbol.for("landrace.hook.kind"), { value: "preflight", enumerable: false });
`;

/** A stage setting a field as it is entered, whose step sets another on its route. */
const FIELDS_WORKFLOW = `version: 1
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
      - { type: tracker.field, fields: { customfield_10123: ["R&D"] }, onlyIfEmpty: true }
  - id: done
    terminal: true
    triggers:
      - name: broken down
        when: { "run.stage": breakdown, "run.outputs.breakdown.kind": done }
`;

const FIELD_STEP = `---
capabilities: [repo:read]
model: opus
output:
  discriminator: kind
  shapes:
    done: {}
  routes:
    - when: { kind: done }
      effects:
        - { type: tracker.field, fields: { customfield_10124: 3 } }
---

Break it down.
`;

/** A post hook that sets fields, and a preflight that writes down the field ids its context carries and the values it was handed. */
const FIELD_VALUES = `
export const fielder = brand("post", {
  id: "fielder",
  handles: ["tracker.field"],
  satisfied: (): boolean => false,
  apply: async (): Promise<void> => {},
});

export const fieldValues = brand("preflight", {
  id: "field-values",
  check: async (ctx: Ctx & { trackerFields?: Set<string>; fieldValues?: Map<string, unknown[]> }): Promise<void> => {
    await appendFile(ctx.config.tracker.record, JSON.stringify({
      trackerFields: ctx.trackerFields ? [...ctx.trackerFields].sort() : null,
      fieldValues: ctx.fieldValues ? Object.fromEntries(ctx.fieldValues) : null,
    }) + "\\n");
  },
});
`;

/** `stepped`'s step, filing an ENG bug whose design field is the answer's plan. */
const FILING_STEP = `---
capabilities: [repo:read]
model: opus
output:
  discriminator: kind
  shapes:
    done: { bugTitle: string, plan: string }
  routes:
    - when: { kind: done }
      effects:
        - { type: tracker.create, project: ENG, titleFrom: bugTitle, fieldsFrom: { customfield_10050: plan } }
---

File the bug.
`;

/** A post hook that files in ENG, and a preflight that writes down the fields it was handed, or that it was handed none. */
const CREATE_FIELDS = `
export const filer = brand("post", {
  id: "filer",
  handles: ["tracker.create"],
  creates: ["ENG"],
  satisfied: (): boolean => false,
  apply: async (): Promise<void> => {},
});

export const createFields = brand("preflight", {
  id: "create-fields",
  check: async (ctx: Ctx & { createFields?: Map<string, Set<string>> }): Promise<void> => {
    const fields = ctx.createFields ? Object.fromEntries([...ctx.createFields].map(([p, f]) => [p, [...f].sort()])) : null;
    await appendFile(ctx.config.tracker.record, JSON.stringify({ createFields: fields }) + "\\n");
  },
});
`;

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

/**
 * The events among what `runStart` printed. Stdout carries the human item
 * rows (`#4242 …`) beside the JSON events, and whether a row lands before an
 * assertion is timing: parsing every line passed locally and failed in CI.
 */
const eventsIn = (printed: readonly string[]): LandraceEvent[] =>
  printed.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as LandraceEvent);

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
    expect(seen).toEqual([{ name: "step.started", person: "local", workflow: "main", note: "deploying to production" }]);
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
    // A terminal, so the board is opened, by a stub: no test spawns a browser.
    const opened: string[] = [];
    const running = runStart(dir, { uiPort: 0, interactive: true, open: async (u) => { opened.push(u); } });
    try {
      await until(() => said.some((l) => l.includes("triage page at ")), "the page to start");
      const url = said.find((l) => l.includes("triage page at "))?.split("triage page at ")[1] ?? "";
      expect(opened).toEqual([url]);
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
 * Whether the board is opened, when nothing says: the default is the only
 * guard keeping a start under a supervisor or in CI from opening a browser,
 * so it is tested through runStart with `interactive` left unset.
 */
describeLoopback("runStart's browser, with interactive unset", () => {
  it.each([[true, 1], [false, 0]] as const)("opens the board when stdout is a terminal (isTTY %s: %i)", async (tty, times) => {
    const { dir } = await fixture();
    const said: string[] = [];
    const [log, error] = [console.log, console.error];
    console.log = (): void => {};
    console.error = (line: unknown): void => {
      said.push(String(line));
    };
    const was = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { value: tty, configurable: true, writable: true });
    const opened: string[] = [];
    const running = runStart(dir, { uiPort: 0, open: async (u) => { opened.push(u); } });
    try {
      await until(() => said.some((l) => l.includes("triage page at ")), "the page to start");
      expect(opened).toHaveLength(times);
    } finally {
      process.emit("SIGINT");
      await running;
      if (was) Object.defineProperty(process.stdout, "isTTY", was);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
      [console.log, console.error] = [log, error];
    }
  }, 30_000);

  it("opens nothing with --headless or --once, even in a terminal", async () => {
    const { dir, record } = await fixture();
    const [log, error] = [console.log, console.error];
    console.log = (): void => {};
    console.error = (): void => {};
    const opened: string[] = [];
    const open = async (u: string): Promise<void> => { opened.push(u); };
    let headless: Promise<void> | undefined;
    try {
      await runStart(dir, { once: true, interactive: true, open });
      const ran = (await applied(record)).length;
      headless = runStart(dir, { ui: false, interactive: true, open });
      await until(async () => (await applied(record)).length > ran, "the headless start to tick");
      expect(opened).toEqual([]);
    } finally {
      process.emit("SIGINT");
      await headless;
      [console.log, console.error] = [log, error];
    }
  }, 30_000);

  it.each([
    ["throws", (): Promise<void> => { throw new Error("spawn xdg-open ENOENT"); }],
    ["reports an error", (): Promise<void> => Promise.reject(new Error("spawn xdg-open ENOENT"))],
  ])("keeps the start running when the opener %s, and says where the board is", async (_, open) => {
    const { dir, record } = await fixture();
    const said: string[] = [];
    const [log, error] = [console.log, console.error];
    console.log = (): void => {};
    console.error = (line: unknown): void => {
      said.push(String(line));
    };
    const running = runStart(dir, { uiPort: 0, interactive: true, open });
    try {
      await until(() => said.some((l) => l.includes("could not open a browser")), "the opener's failure");
      const url = said.find((l) => l.includes("triage page at "))?.split("triage page at ")[1] ?? "";
      expect(said.filter((l) => l.includes("could not open a browser")))
        .toEqual([`landrace: could not open a browser (spawn xdg-open ENOENT); the board is at ${url}`]);
      // Still running: its first tick works the item after the opener failed.
      await until(async () => (await applied(record)).length === 1, "the first tick");
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
    const running = runStart(dir, { uiPort: 0, interactive: false, open: async () => { throw new Error("opened a browser"); } });
    try {
      await until(() => said.some((l) => l.includes("triage page at ")), "the page to start");
      const url = said.find((l) => l.includes("triage page at "))?.split("triage page at ")[1] ?? "";
      const rows = async (): Promise<BoardView["rows"]> => ((await (await fetch(`${url}board.json`)).json()) as BoardView).rows;
      // A root is drawn once per page and lane it holds a match in, so the
      // four items are counted by id, not by row.
      const ids = async (): Promise<Set<string>> => new Set((await rows()).map((r) => r.id));
      await until(async () => (await applied(record)).length === 2 && (await ids()).size === 4, "the first tick to work both items");

      const row = async (id: string) => (await rows()).find((r) => r.id === id);
      // Needs you lists it, and so does each claimant's page.
      expect((await rows()).filter((r) => r.id === "4444").map((r) => [r.page, r.lane]))
        .toEqual([[null, "needs-you"], ["fast", "needs-you"], ["main", "needs-you"]]);
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

/*
 * The instance record `landrace port` reads, through the daemon's own path:
 * written once the board listens, gone on a clean stop, and never by a start
 * that serves no board.
 */
describe("runStart's instance record, with no board", () => {
  it("writes none for --once", async () => {
    const { dir } = await fixture();
    const [log, error] = [console.log, console.error];
    console.log = (): void => {};
    console.error = (): void => {};
    try {
      await runStart(dir, { once: true });
      expect(await readInstance(dir)).toEqual({ missing: true });
    } finally {
      [console.log, console.error] = [log, error];
    }
  });
});

describeLoopback("runStart's instance record", () => {
  const quiet = (): { said: string[]; restore: () => void } => {
    const said: string[] = [];
    const [log, error] = [console.log, console.error];
    console.log = (): void => {};
    console.error = (line: unknown): void => {
      said.push(String(line));
    };
    return { said, restore: () => { [console.log, console.error] = [log, error]; } };
  };
  const portOf = async (dir: string): Promise<{ out: string[]; err: string[]; code: number }> => {
    const out: string[] = [];
    const err: string[] = [];
    let code = 0;
    await portCommand({ out: (l) => out.push(l), err: (l) => err.push(l), exit: (c) => { code = c; } })
      .parseAsync(["-w", dir], { from: "user" });
    return { out, err, code };
  };
  const pageOf = (said: string[]): string => said.find((l) => l.includes("triage page at "))?.split("triage page at ")[1] ?? "";

  it("is written once the board listens, answered by landrace port, and removed on a clean stop", async () => {
    const { dir } = await fixture();
    const { said, restore } = quiet();
    const running = runStart(dir, { uiPort: 0, interactive: false });
    try {
      await until(() => said.some((l) => l.includes("triage page at ")), "the page to start");
      const url = pageOf(said);
      const read = await readInstance(dir);
      expect(read).toEqual({ instance: expect.objectContaining({ pid: process.pid, port: Number(new URL(url).port) }) });
      expect(await portOf(dir)).toEqual({ out: [url.replace(/\/$/, "")], err: [], code: 0 });
    } finally {
      process.emit("SIGINT");
      await running;
      restore();
    }
    expect(await readInstance(dir)).toEqual({ missing: true });
    expect(await portOf(dir)).toMatchObject({ out: ["offline"], code: 1 });
  }, 30_000);

  it("refuses a second board-serving start on the workspace, naming the running URL and pid, before its first tick", async () => {
    const { dir, record } = await fixture();
    const { said, restore } = quiet();
    const running = runStart(dir, { uiPort: 0, interactive: false });
    try {
      await until(() => said.some((l) => l.includes("triage page at ")), "the page to start");
      await until(async () => (await applied(record)).length === 1, "the first tick");
      const url = pageOf(said).replace(/\/$/, "");
      await expect(runStart(dir, { uiPort: 0, interactive: false })).rejects.toThrow(
        `a landrace start already serves this workspace's board at ${url} (pid ${process.pid}); stop it first, or start this one with --headless`,
      );
      // Refused before it ticked: the first start's one write is still the only one.
      expect(await applied(record)).toHaveLength(1);
      // The refused start took nothing: the record still names the live one.
      expect(await portOf(dir)).toEqual({ out: [url], err: [], code: 0 });
    } finally {
      process.emit("SIGINT");
      await running;
      restore();
    }
  }, 30_000);

  /*
   * Refused by a live board alone: the record names a real board answering
   * for this workspace, so a start that read it would be refused, and these
   * pass only because a start that serves no board never reads it.
   */
  it("does not refuse --once or --headless while a board serves the workspace, and neither touches its record", async () => {
    const { dir, record } = await fixture();
    const { said, restore } = quiet();
    const running = runStart(dir, { uiPort: 0, interactive: false });
    let headless: Promise<void> | undefined;
    try {
      await until(() => said.some((l) => l.includes("triage page at ")), "the page to start");
      const url = pageOf(said).replace(/\/$/, "");
      const before = await readInstance(dir);
      await runStart(dir, { once: true });
      headless = runStart(dir, { ui: false });
      // It ran: a refused start would have rejected before any tick wrote.
      const ran = (await applied(record)).length;
      await until(async () => (await applied(record)).length > ran, "the headless start to tick");
      expect(await readInstance(dir)).toEqual(before);
      expect(await portOf(dir)).toEqual({ out: [url], err: [], code: 0 });
    } finally {
      process.emit("SIGINT");
      await running;
      await headless;
      restore();
    }
  }, 30_000);

  /*
   * The first check runs before the runtime is built and the preflights run,
   * which can take seconds; a board another start brings up in that window
   * would otherwise be overwritten in the record, leaving `port` naming one
   * of two. The preflight here holds the first start in that window.
   */
  it("refuses a start whose board another start brought up while it was still preparing, and closes its own", async () => {
    const root = await mkdtemp(join(tmpdir(), "lr-gate-"));
    const [hold, held, release] = ["hold", "held", "release"].map((f) => join(root, f)) as [string, string, string];
    const { dir } = await fixture({
      hookExtra: `
import { renameSync } from "node:fs";
export const preflight = brand("preflight", {
  id: "gate",
  check: async (): Promise<void> => {
    try { renameSync(${JSON.stringify(hold)}, ${JSON.stringify(held)}); } catch { return; }
    while (!existsSync(${JSON.stringify(release)})) await new Promise((r) => setTimeout(r, 25));
  },
});
`,
    });
    await writeFile(hold, "");
    const { said, restore } = quiet();
    // A terminal, so a start that passed would open its board: refused, it opens none.
    const opened: string[] = [];
    const first = runStart(dir, { uiPort: 0, interactive: true, open: async (u) => { opened.push(u); } });
    const refused = first.then(() => null, (e: unknown) => e as Error);
    let second: Promise<void> | undefined;
    try {
      await until(() => existsSync(held), "the first start to reach its preflight");
      second = runStart(dir, { uiPort: 0, interactive: false });
      await until(() => said.some((l) => l.includes("triage page at ")), "the second start's page");
      const url = pageOf(said).replace(/\/$/, "");
      await writeFile(release, "");
      expect((await refused)?.message).toBe(
        `a landrace start already serves this workspace's board at ${url} (pid ${process.pid}); stop it first, or start this one with --headless`,
      );
      // It served nothing: the only page is the second start's, still named by the record.
      expect(said.filter((l) => l.includes("triage page at "))).toHaveLength(1);
      expect(opened).toEqual([]);
      expect(await portOf(dir)).toEqual({ out: [url], err: [], code: 0 });
    } finally {
      await writeFile(release, "");
      process.emit("SIGINT");
      await refused;
      await second;
      restore();
    }
  }, 30_000);

  it("is not blocked by a record a crash left behind, and overwrites it", async () => {
    const { dir } = await fixture();
    await writeInstance(dir, { pid: 999_999_999, port: 1, workspace: "/gone", startedAt: "2026-10-10T00:00:00.000Z" });
    const { said, restore } = quiet();
    const running = runStart(dir, { uiPort: 0, interactive: false });
    try {
      await until(() => said.some((l) => l.includes("triage page at ")), "the page to start");
      expect(await readInstance(dir)).toEqual({ instance: expect.objectContaining({ pid: process.pid, port: Number(new URL(pageOf(said)).port) }) });
    } finally {
      process.emit("SIGINT");
      await running;
      restore();
    }
  }, 30_000);

  /*
   * A crash left a record for a port, and its pid has gone to an unrelated
   * live process. The first check passes, since nothing answers that port;
   * this start then binds it, and the re-check finds a live pid and its own
   * board answering for this workspace. The record can only be stale.
   */
  it("is not refused by a stale record naming the port its own board then bound, under a reused pid", async () => {
    const { dir } = await fixture();
    const free = createServer();
    await new Promise<void>((resolve) => free.listen(0, "127.0.0.1", resolve));
    const port = (free.address() as AddressInfo).port;
    await new Promise((resolve) => free.close(resolve));
    const workspace = await repositoryRoot(dir).catch(() => process.cwd());
    await writeInstance(dir, { pid: process.ppid, port, workspace, startedAt: "2026-10-10T00:00:00.000Z" });
    const { said, restore } = quiet();
    const running = runStart(dir, { uiPort: port, interactive: false });
    const failed = running.then(() => null, (e: unknown) => e as Error);
    try {
      await Promise.race([
        until(() => said.some((l) => l.includes("triage page at ")), "the page to start"),
        failed.then((e) => { if (e) throw e; }),
      ]);
      expect(new URL(pageOf(said)).port).toBe(String(port));
      expect(await readInstance(dir)).toEqual({ instance: expect.objectContaining({ pid: process.pid, port }) });
    } finally {
      process.emit("SIGINT");
      await failed;
      restore();
    }
  }, 30_000);
});

/*
 * A per-person key answered from the local person's stored connection, the
 * connection defined by a hook the workflow loads. The store is a temporary
 * one handed in: the operator's own `~/.landrace/credentials` is never read.
 */
describe("buildWorkspaceRuntime, for a per-person key", () => {
  const STORED_TOKEN = "ghp_stored_token_long_enough";
  const CONNECTION = (lifetime = "") => `
export const forge = brand("connection", { id: "forge", label: "Forge", kind: "credential", fields: ["login", "token"]${lifetime} });
`;
  const PER_PERSON = "vars: { assignee: { perPerson: true, env: LR_TEST_ASSIGNEE, connection: forge.login } }\n" +
    "people: { local: { email: dev1@example.invalid } }\n";
  const usingAssignee = WORKFLOW.replace("Writing the spec, round {round}.", "Writing the spec for {vars.assignee}, round {round}.");

  async function storeOf(connections: Record<string, unknown> | null): Promise<CredentialStore> {
    const root = join(await mkdtemp(join(tmpdir(), "lr-creds-")), "credentials");
    if (connections !== null) {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "local.json"), JSON.stringify({ person: { id: "local" }, connections }));
    }
    return createCredentialStore(root);
  }

  const connected = (daysAgo: number) => ({
    forge: { fields: { login: "dev1", token: STORED_TOKEN }, source: "paste", connectedAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString() },
  });

  /*
   * #185: one runtime per person. Alice and bob each have a file of their
   * own; what is checked is that each runtime is theirs alone — its config
   * object, its values, its events, the person every hook is handed.
   */
  async function peopleStore(logins: Record<string, string>): Promise<CredentialStore> {
    const root = join(await mkdtemp(join(tmpdir(), "lr-creds-")), "credentials");
    await mkdir(root, { recursive: true });
    for (const [id, login] of Object.entries(logins)) {
      const forge = { fields: { login, token: `${STORED_TOKEN}-${id}` }, source: "paste", connectedAt: new Date().toISOString() };
      await writeFile(join(root, `${id}.json`), JSON.stringify({ person: { id }, connections: { forge } }));
    }
    return createCredentialStore(root);
  }

  it("builds alice's and bob's runtimes apart: their own config object, values, person and events", async () => {
    const { dir } = await fixture({ hookExtra: CONNECTION(), configExtra: PER_PERSON, workflow: usingAssignee });
    const credentials = await peopleStore({ alice: "alice-login", bob: "bob-login" });
    const seen: LandraceEvent[] = [];
    const alice = await buildMain(dir, { sink: (e) => seen.push(e), credentials, person: { id: "alice" } });
    const bob = await buildMain(dir, { sink: (e) => seen.push(e), credentials, person: { id: "bob" } });

    expect(alice.ctx.config).not.toBe(bob.ctx.config);
    expect(alice.ctx.config).toEqual(bob.ctx.config);
    expect([alice.ctx.person?.id, bob.ctx.person?.id, bob.deps.ctx.person?.id]).toEqual(["alice", "bob", "bob"]);
    expect(alice.deps.workflow.stages[0]?.on_enter?.[0]).toMatchObject({ body: "Writing the spec for alice-login, round {round}." });
    expect(bob.deps.workflow.stages[0]?.on_enter?.[0]).toMatchObject({ body: "Writing the spec for bob-login, round {round}." });
    // Each in a worktree folder of their own.
    expect([alice.deps.sandbox?.scope, bob.deps.sandbox?.scope]).toEqual(["alice", "bob"]);

    bob.deps.log("step.finished", { item: ITEM });
    bob.deps.ctx.log("tracker.request", {});
    expect(seen).toEqual([
      { name: "step.finished", person: "bob", workflow: "main", item: ITEM },
      { name: "tracker.request", person: "bob" },
    ]);
  });

  it("takes a person's values from the resolution its caller judged, over the store's", async () => {
    const { dir } = await fixture({ hookExtra: CONNECTION(), configExtra: PER_PERSON, workflow: usingAssignee });
    const credentials = await peopleStore({ bob: "bob-login" });
    const resolution = { vars: new Map([["assignee", "bob-judged"]]), secretValues: new Map([["jiraAssignee", "bob-account-id"]]), statuses: [], problems: [], ready: true };
    const bob = await buildMain(dir, { sink: () => {}, credentials, person: { id: "bob" }, resolution });
    expect(bob.deps.workflow.stages[0]?.on_enter?.[0]).toMatchObject({ body: "Writing the spec for bob-judged, round {round}." });
    expect(bob.ctx.secrets.get("jiraAssignee")).toBe("bob-account-id");
  });

  it("runs with the stored value when the env is unset, and redacts what the store holds", async () => {
    const { dir } = await fixture({ hookExtra: CONNECTION(), configExtra: PER_PERSON, workflow: usingAssignee });
    const seen: LandraceEvent[] = [];
    const rt = await buildMain(dir, { sink: (e) => seen.push(e), credentials: await storeOf(connected(1)) });
    expect(rt.deps.workflow.stages[0]?.on_enter?.[0]).toMatchObject({ body: "Writing the spec for dev1, round {round}." });
    rt.deps.log("step.invoked", { cmd: `curl -H "Authorization: Bearer ${STORED_TOKEN}"` });
    const line = JSON.stringify(seen.find((e) => e.name === "step.invoked"));
    expect(line).not.toContain(STORED_TOKEN);
    expect(line).toContain("[redacted]");
  });

  it("refuses with connection.missing, in validate's words, when neither the env nor a connection answers", async () => {
    const { dir } = await fixture({ hookExtra: CONNECTION(), configExtra: PER_PERSON, workflow: usingAssignee });
    const credentials = await storeOf(null);
    const { ok, problems } = await runValidate(dir, { credentials });
    expect(ok).toBe(false);
    const missing = problems.find((p) => p.rule === "connection.missing");
    expect(missing?.message).toMatch(/vars entry "assignee" has no value: LR_TEST_ASSIGNEE is unset/);
    await expect(buildWorkspaceRuntime(dir, { credentials })).rejects.toThrow(`connection.missing: ${missing?.message ?? "?"}`);
  });

  it("refuses an expired connection, and a key naming a connection no hook defines", async () => {
    const lasting = await fixture({ hookExtra: CONNECTION(", lifetimeDays: 365"), configExtra: PER_PERSON, workflow: usingAssignee });
    await expect(buildWorkspaceRuntime(lasting.dir, { credentials: await storeOf(connected(366)) })).rejects.toThrow(/connection\.expired: .*365 days/);
    await expect(buildWorkspaceRuntime(lasting.dir, { credentials: await storeOf(connected(1)) })).resolves.toBeDefined();
    const unknown = await fixture({ hookExtra: "", configExtra: PER_PERSON, workflow: usingAssignee });
    await expect(buildWorkspaceRuntime(unknown.dir, { credentials: await storeOf(connected(1)) })).rejects.toThrow(/connection\.unknown: .*"forge", which no hook defines/);
  });

  it("needs no stored connection, locally, for a key its env answers, nor a store that reads", async () => {
    const { dir } = await fixture({ hookExtra: CONNECTION(), configExtra: PER_PERSON, workflow: usingAssignee });
    await writeFile(join(dir, ".env"), `LR_TEST_TOKEN=${TOKEN}\nLR_TEST_ASSIGNEE=dev2\n`);
    const corrupt = await storeOf(null);
    await mkdir(corrupt.root, { recursive: true });
    await writeFile(join(corrupt.root, "local.json"), "{ not json");
    expect((await runValidate(dir, { credentials: corrupt })).problems.filter((p) => p.rule.startsWith("connection."))).toEqual([]);
    const rt = await buildMain(dir, { credentials: corrupt });
    expect(rt.deps.workflow.stages[0]?.on_enter?.[0]).toMatchObject({ body: "Writing the spec for dev2, round {round}." });
  });

  it("runs a key its env answers, locally, when no hook defines its connection", async () => {
    const { dir } = await fixture({ hookExtra: "", configExtra: PER_PERSON, workflow: usingAssignee });
    await writeFile(join(dir, ".env"), `LR_TEST_TOKEN=${TOKEN}\nLR_TEST_ASSIGNEE=dev2\n`);
    const credentials = await storeOf(null);
    expect((await runValidate(dir, { credentials })).problems.filter((p) => p.rule.startsWith("connection."))).toEqual([]);
    const rt = await buildMain(dir, { credentials });
    expect(rt.deps.workflow.stages[0]?.on_enter?.[0]).toMatchObject({ body: "Writing the spec for dev2, round {round}." });
  });
});

/*
 * #182: a start whose local person is missing a connection serves the front
 * door, shows only the Integrations tab and ticks nothing; a paste there
 * rebuilds the runtime and the next wake ticks. A temporary store throughout.
 */
const PASTED = "ghp_pasted_through_the_tab_long";
const FORGE_CONNECTION = `
export const forge = brand("connection", { id: "forge", label: "Forge", kind: "credential", fields: ["token"], paste: { hint: "a token" } });
`;
const PER_PERSON_SECRET = "secrets: { githubToken: $LR_TEST_TOKEN, forgeToken: { perPerson: true, connection: forge.token } }";

async function unready(perPerson: "secret" | "var"): Promise<Fixture & { credentials: CredentialStore }> {
  const f = perPerson === "secret"
    ? await fixture({ hookExtra: FORGE_CONNECTION })
    : await fixture({
      hookExtra: FORGE_CONNECTION,
      configExtra: "vars: { assignee: { perPerson: true, env: LR_TEST_ASSIGNEE, connection: forge.token } }\n",
      workflow: WORKFLOW.replace("Writing the spec, round {round}.", "Writing the spec for {vars.assignee}, round {round}."),
    });
  if (perPerson === "secret") {
    const yaml = join(f.dir, "landrace.yaml");
    await writeFile(yaml, (await readFile(yaml, "utf8")).replace("secrets: { githubToken: $LR_TEST_TOKEN }", PER_PERSON_SECRET));
  }
  return { ...f, credentials: createCredentialStore(join(await mkdtemp(join(tmpdir(), "lr-creds-")), "credentials")) };
}

describe("runStart --once while the local person is not ready", () => {
  it("refuses with connection.missing, since there is no door to connect through", async () => {
    const { dir, credentials } = await unready("secret");
    await expect(runStart(dir, { once: true, credentials })).rejects.toThrow(/connection\.missing: secrets entry "forgeToken" has no value/);
  });
});

/**
 * `runStart`'s front door with no socket: `serve` keeps the options it was
 * handed and the test drives the front door's own listener over them, so
 * what is proved is the wiring `runStart` hands the door, Host checks and all.
 */
const DOOR_PORT = 4545;
function inProcessDoor(): {
  serve: NonNullable<StartOptions["serve"]>;
  drive: (path: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; body: string; headers: Record<string, string> }>;
  /** What `runStart` handed its door, once it has. */
  options: () => FrontDoorOptions;
} {
  let door: FrontDoorOptions | null = null;
  const serve: NonNullable<StartOptions["serve"]> = async (opts) => {
    door = opts;
    return { url: `http://127.0.0.1:${DOOR_PORT}/`, port: DOOR_PORT, host: "127.0.0.1", close: async () => { await opts.mcp?.close(); } };
  };
  const drive = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string; headers: Record<string, string> }> =>
    new Promise((resolve, reject) => {
      if (door === null) return reject(new Error("runStart has not served its door yet"));
      const req = Object.assign(Readable.from(init.body === undefined ? [] : [Buffer.from(init.body)]), {
        method: init.method ?? "GET", url: path, headers: { host: `127.0.0.1:${DOOR_PORT}`, ...init.headers },
      });
      let status = 0;
      let headers: Record<string, string> = {};
      const res = {
        writeHead(s: number, h?: Record<string, string>) { status = s; headers = h ?? {}; return res; },
        end(b?: string) { resolve({ status, body: String(b ?? ""), headers }); },
      };
      frontDoorListener(door, DOOR_PORT)(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    });
  const options = (): FrontDoorOptions => {
    if (door === null) throw new Error("runStart has not served its door yet");
    return door;
  };
  return { serve, drive, options };
}

describe("runStart while the local person is not ready", () => {
  it.each(["secret", "var"] as const)("serves only the Integrations tab for a missing per-person %s, ticks once it is connected, and stops on a disconnect", async (kind) => {
    const { dir, record, credentials } = await unready(kind);
    const { serve, drive } = inProcessDoor();
    const printed: string[] = [];
    const said: string[] = [];
    const [log, error] = [console.log, console.error];
    console.log = (line: unknown): void => { printed.push(String(line)); };
    console.error = (line: unknown): void => { said.push(String(line)); };
    const running = runStart(dir, { interactive: false, credentials, serve });
    const ticks = (): number => printed.filter((l) => l.includes('"name":"tick.started"')).length;
    const post = (path: string, action: string, body?: unknown) =>
      drive(path, { method: "POST", headers: { "x-landrace-action": action }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const board = async (): Promise<unknown> => JSON.parse((await drive("/board.json")).body) as unknown;
    try {
      await until(() => said.some((l) => l.includes("triage page at ")), "the page to start");
      expect(said.join("\n")).toMatch(/nothing runs until these are connected in the board's Integrations tab:\n {2}connection\.missing: /);
      expect(await board()).toEqual({ ready: false });
      expect((await drive("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(503);
      expect((await post("/tick", "tick")).status).toBe(409);
      const me = JSON.parse((await drive("/people/me")).body) as { ready: boolean; connections: Array<{ id: string; state: string }>; hints: Record<string, string> };
      expect(me).toMatchObject({ ready: false, hints: { forge: "a token" } });
      expect(me.connections).toEqual([expect.objectContaining({ id: "forge", state: "missing" })]);
      touchWake(wakePath(dir));
      await new Promise((r) => setTimeout(r, 300));
      expect(ticks()).toBe(0);

      const connected = await post("/connect/forge", "connect", { fields: { token: PASTED } });
      expect([connected.status, JSON.parse(connected.body)]).toEqual([200, expect.objectContaining({ id: "forge", state: "connected" })]);
      await until(async () => ticks() > 0 && (await applied(record)).length === 1, "the next wake to tick");
      await until(async () => (await board() as { listed?: boolean }).listed === true, "the board to list");
      expect(JSON.parse((await drive("/people/me")).body)).toMatchObject({ ready: true });

      expect((await post("/disconnect/forge", "disconnect")).status).toBe(200);
      expect(await board()).toEqual({ ready: false });
      // Whatever pass was in flight has finished; no new one starts.
      await new Promise((r) => setTimeout(r, 300));
      const before = ticks();
      touchWake(wakePath(dir));
      expect((await post("/tick", "tick")).status).toBe(409);
      await new Promise((r) => setTimeout(r, 300));
      expect(ticks()).toBe(before);
      expect(printed.some((l) => l.includes('"name":"person.connected"') && l.includes('"connection":"forge"'))).toBe(true);
      expect([...printed, ...said].join("\n")).not.toContain(PASTED);
    } finally {
      process.emit("SIGINT");
      await running;
      [console.log, console.error] = [log, error];
    }
  }, 30_000);

  it("keeps the previous runtime when the reload after a connect fails, answering 502", async () => {
    const { dir, record, credentials } = await unready("secret");
    const { serve, drive } = inProcessDoor();
    const said: string[] = [];
    const [log, error] = [console.log, console.error];
    console.log = (): void => {};
    console.error = (line: unknown): void => { said.push(String(line)); };
    const running = runStart(dir, { interactive: false, credentials, serve });
    const post = (path: string, action: string, body?: unknown) =>
      drive(path, { method: "POST", headers: { "x-landrace-action": action }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    try {
      await until(() => said.some((l) => l.includes("triage page at ")), "the page to start");
      expect((await post("/connect/forge", "connect", { fields: { token: PASTED } })).status).toBe(200);
      await until(async () => (await applied(record)).length === 1, "the first tick");
      // A workflow that no longer validates: the rebuild a disconnect asks for fails.
      await writeFile(join(workflowIn(dir), "workflow.yaml"), "version: 1\nname: broken\ndescription: test\nstages:\n  - id: only\n    triggers: [{ when: { \"run.stage\": null } }]\n");
      const res = await post("/connect/forge", "connect", { fields: { token: `${PASTED}-2` } });
      expect(res.status).toBe(502);
      expect(res.body).toMatch(/"forge" is connected, but Landrace could not reload with it: .*does not validate/);
      expect(res.body).not.toContain(PASTED);
      expect(JSON.parse((await drive("/board.json")).body)).toMatchObject({ listed: true });
    } finally {
      process.emit("SIGINT");
      await running;
      [console.log, console.error] = [log, error];
    }
  }, 30_000);

  /*
   * The thread on #182: `seen` is what tells that an item placed by its own
   * state has already been told of. A connect rebuilds the runtime, and a
   * rebuild that started from an empty one told everyone again.
   */
  it("tells once of an item waiting on you, however many connects rebuild the runtime", async () => {
    const review = (await readFile("tests/fixtures/review/workflow.yaml", "utf8"))
      .replace("eligible:", "hooks: [../../hooks/fake.ts, ../../hooks/claude.ts]\neligible:");
    const { dir, record } = await fixture({
      workflow: review, items: [{ id: ITEM, labels: ["review-requested"] }],
      hookExtra: FORGE_CONNECTION + RECORDING_NOTIFIER, configExtra: "notify: { on: [needs-you], via: [chat] }\n",
    });
    const yaml = join(dir, "landrace.yaml");
    await writeFile(yaml, (await readFile(yaml, "utf8")).replace("secrets: { githubToken: $LR_TEST_TOKEN }", PER_PERSON_SECRET));
    const credentials = createCredentialStore(join(await mkdtemp(join(tmpdir(), "lr-creds-")), "credentials"));
    const { serve, drive } = inProcessDoor();
    const printed: string[] = [];
    const said: string[] = [];
    const [log, error] = [console.log, console.error];
    console.log = (line: unknown): void => { printed.push(String(line)); };
    console.error = (line: unknown): void => { said.push(String(line)); };
    const running = runStart(dir, { interactive: false, credentials, serve });
    const finished = (): number => printed.filter((l) => l.includes('"name":"tick.finished"')).length;
    const connect = (token: string) =>
      drive("/connect/forge", { method: "POST", headers: { "x-landrace-action": "connect" }, body: JSON.stringify({ fields: { token } }) });
    try {
      await until(() => said.some((l) => l.includes("triage page at ")), "the page to start");
      expect((await connect(PASTED)).status).toBe(200);
      await until(async () => (await applied(record)).length > 0, "the notification");
      const before = finished();
      expect((await connect(`${PASTED}-2`)).status).toBe(200);
      await until(() => finished() > before, "a tick under the rebuilt runtime");
      await new Promise((r) => setTimeout(r, 300));
      expect(await applied(record)).toEqual([{ notified: ITEM, workflow: "main", stage: "reviewing", why: "waiting on you" }]);
    } finally {
      process.emit("SIGINT");
      await running;
      [console.log, console.error] = [log, error];
    }
  }, 30_000);

  /*
   * The thread on #182: a `log.redact` entry that means nothing is a config
   * problem, and refuses the start, unready or not, rather than waiting for
   * the first connect to 502 on it. A per-person secret nobody has answered
   * yet is not one: the build judges it once it is.
   */
  it.each([
    ["names no secret", (y: string) => y.replace("log: { redact: [githubToken] }", "log: { redact: [githubToken, nope] }"), /log\.redact names "nope", which no secret defines/],
    ["names a secret too short to redact by", (y: string) => y.replace("$LR_TEST_TOKEN,", "$LR_TEST_SHORT,"), /secret\(s\) "githubToken" resolve to fewer than/],
  ])("refuses an unready start whose log.redact %s", async (_, edit, refusal) => {
    const { dir, credentials } = await unready("secret");
    const yaml = join(dir, "landrace.yaml");
    await writeFile(yaml, edit(await readFile(yaml, "utf8")));
    await writeFile(join(dir, ".env"), `LR_TEST_TOKEN=${TOKEN}\nLR_TEST_SHORT=abc\n`);
    const { serve } = inProcessDoor();
    await expect(runStart(dir, { interactive: false, credentials, serve })).rejects.toThrow(refusal);
  });

  it("serves an unready start whose log.redact names the per-person secret not yet connected", async () => {
    const { dir, credentials } = await unready("secret");
    const yaml = join(dir, "landrace.yaml");
    await writeFile(yaml, (await readFile(yaml, "utf8")).replace("log: { redact: [githubToken] }", "log: { redact: [githubToken, forgeToken] }"));
    const { serve, drive } = inProcessDoor();
    const said: string[] = [];
    const [log, error] = [console.log, console.error];
    console.log = (): void => {};
    console.error = (line: unknown): void => { said.push(String(line)); };
    const running = runStart(dir, { interactive: false, credentials, serve });
    const failed = running.then(() => null, (e: unknown) => e as Error);
    try {
      await Promise.race([
        until(() => said.some((l) => l.includes("triage page at ")), "the page to start"),
        failed.then((e) => { if (e) throw e; }),
      ]);
      expect(JSON.parse((await drive("/board.json")).body)).toEqual({ ready: false });
    } finally {
      process.emit("SIGINT");
      await running.catch(() => undefined);
      [console.log, console.error] = [log, error];
    }
  }, 30_000);

  it("keeps a .env-only setup starting and ticking as it did", async () => {
    const { dir, record } = await fixture();
    const { serve, drive } = inProcessDoor();
    const said: string[] = [];
    const [log, error] = [console.log, console.error];
    console.log = (): void => {};
    console.error = (line: unknown): void => { said.push(String(line)); };
    const running = runStart(dir, { interactive: false, serve });
    try {
      await until(async () => (await applied(record)).length === 1, "the first tick");
      expect(said.join("\n")).not.toMatch(/Integrations tab/);
      await until(async () => (JSON.parse((await drive("/board.json")).body) as { listed?: boolean }).listed === true, "the board to list");
    } finally {
      process.emit("SIGINT");
      await running;
      [console.log, console.error] = [log, error];
    }
  }, 30_000);
});

/*
 * #183: a person's own connections through `start`'s gate and build — the
 * Claude login a step runs on, the identity looked up by email, and a token
 * the agent refused. A temporary store throughout.
 */
describe("a person's own connections, through start", () => {
  const PERSON_TOKEN = "sk-ant-oat01-person-token-for-e2e";
  const LOOKED_UP = "U0LOOKEDUP42";
  const CLAUDE_CONNECTION = `
export const claudeLogin = brand("connection", { id: "claude", label: "Claude", kind: "credential", fields: ["token"], lifetimeDays: 365 });
`;
  const CHAT_IDENTITY = `
export const chatIdentity = brand("connection", {
  id: "chat", label: "Chat", kind: "identity", fields: ["user"],
  resolve: async (email: string): Promise<Record<string, string> | null> => (email === "dev1@example.invalid" ? { user: ${JSON.stringify(LOOKED_UP)} } : null),
});
`;
  const EMAIL = "people: { local: { email: dev1@example.invalid } }\n";

  async function storeOf(connections: Record<string, unknown> | null): Promise<CredentialStore> {
    const root = join(await mkdtemp(join(tmpdir(), "lr-creds-")), "credentials");
    if (connections !== null) {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "local.json"), JSON.stringify({ person: { id: "local" }, connections }));
    }
    return createCredentialStore(root);
  }
  const claudeStored = { claude: { fields: { token: PERSON_TOKEN }, source: "paste", connectedAt: new Date(Date.now() - 86_400_000).toISOString() } };

  /** The fake agent on PATH as `claude`, so the runtime's own executor spawns it. */
  async function onPath<T>(body: () => Promise<T>): Promise<T> {
    const binDir = await mkdtemp(join(tmpdir(), "fake-claude-bin-"));
    await copyFile(join(process.cwd(), "tests", "agent", "fake-agent.mjs"), join(binDir, "claude"));
    await chmod(join(binDir, "claude"), 0o755);
    const saved = { PATH: process.env.PATH, KEY: process.env.ANTHROPIC_API_KEY };
    process.env.PATH = `${binDir}:${saved.PATH ?? ""}`;
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-operator-key";
    try {
      return await body();
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved.KEY;
    }
  }

  const envOfRun = async (rt: WorkflowRuntime): Promise<string> => {
    const cwd = await mkdtemp(join(tmpdir(), "fake-agent-"));
    await writeFile(join(cwd, "fake.json"), JSON.stringify({ out: "[{{ENV:CLAUDE_CODE_OAUTH_TOKEN}}|{{ENV:ANTHROPIC_API_KEY}}]" }));
    const r = await rt.deps.executor.run("p", { round: 1, signal: new AbortController().signal, cwd, capabilities: ["repo:read"] });
    return r.text;
  };

  it("runs a step on the person's stored Claude token, and on the operator's login with none stored", async () => {
    const { dir } = await fixture({ hookExtra: CLAUDE_CONNECTION });
    await onPath(async () => {
      const mine = await buildMain(dir, { credentials: await storeOf(claudeStored) });
      expect(await envOfRun(mine)).toBe(`[${PERSON_TOKEN}|]`);
      const none = await buildMain(dir, { credentials: await storeOf(null) });
      expect(await envOfRun(none)).toBe("[|]");
      expect(none.deps.connectionFailed).toBeUndefined();
    });
  }, 30_000);

  it("marks a refused token failed and reloads, and the next build finds the person not ready", async () => {
    const { dir } = await fixture({ hookExtra: CLAUDE_CONNECTION });
    const credentials = await storeOf(claudeStored);
    let reloads = 0;
    const rt = await buildMain(dir, { credentials, onConnectionFailed: async () => { reloads++; } });
    await rt.deps.connectionFailed?.("claude exited 1: OAuth token has expired");
    const stored = (await credentials.read("local")).connections["claude"];
    expect(stored).toMatchObject({ fields: { token: PERSON_TOKEN }, failedAt: expect.any(String), failure: "claude exited 1: OAuth token has expired" });
    expect(reloads).toBe(1);
    await expect(buildWorkspaceRuntime(dir, { credentials })).rejects.toThrow(/connection\.failed: .*"claude" connection \(Claude\) is failed: claude exited 1: OAuth token has expired/);
  }, 30_000);

  /*
   * The screener runs on `security.adapter`'s executor, which need not be
   * the steps': a refused login is blamed on the connection of the executor
   * that ran, so steps on the operator's login never mark a screener's token,
   * and the reverse.
   */
  it("hands the screener its own executor's connection handler when the two adapters differ", async () => {
    const screenOnClaude = await fixture({ agent: "fake", screen: true, securityKeys: "adapter: claude, model: haiku", hookExtra: CLAUDE_CONNECTION + EXECUTOR });
    const credentials = await storeOf(claudeStored);
    const rt = await buildMain(screenOnClaude.dir, { credentials });
    expect(rt.deps.connectionFailed).toBeUndefined();
    await rt.deps.screen?.connectionFailed?.("claude exited 1: OAuth token has expired");
    expect((await credentials.read("local")).connections["claude"]).toHaveProperty("failedAt");

    const stepsOnClaude = await fixture({ screen: true, securityKeys: "adapter: fake, model: fake-small", hookExtra: CLAUDE_CONNECTION + EXECUTOR });
    const other = await buildMain(stepsOnClaude.dir, { credentials: await storeOf(claudeStored) });
    expect(other.deps.connectionFailed).toBeDefined();
    expect(other.deps.screen?.executor.id).toBe("fake");
    expect(other.deps.screen?.connectionFailed).toBeUndefined();
  }, 30_000);

  it("looks the person's identity up by their email at the gate, stores it, and keeps it out of every log line and telemetry record", async () => {
    const { dir } = await fixture({ hookExtra: CHAT_IDENTITY, configExtra: EMAIL });
    const credentials = await storeOf(null);
    const printed: LandraceEvent[] = [];
    const exported: LandraceEvent[] = [];
    const log = createLogger({ sink: (e) => printed.push(e), exporter: (e) => exported.push(e) });
    const gate = await localGate(dir, credentials, { log });
    expect(gate.lookups).toEqual(new Map());
    expect((await credentials.read("local")).connections["chat"]).toMatchObject({ fields: { user: LOOKED_UP }, source: "lookup" });
    expect(gate.resolution.statuses).toEqual([expect.objectContaining({ id: "chat", state: "connected" })]);
    log("step.invoked", { said: `posting to ${LOOKED_UP}` });
    const rt = await buildMain(dir, { credentials, log });
    rt.deps.log("step.invoked", { said: `again to ${LOOKED_UP}` });
    expect(printed.length).toBeGreaterThan(0);
    expect(JSON.stringify([...printed, ...exported])).not.toContain(LOOKED_UP);
  }, 30_000);

  /*
   * The whole path the warning takes: a stored connection's `connectedAt`
   * turned into an expiry by the gate's judging, and `runStart` handing that
   * judging to the warner on its tick. Made 340 days ago, lasting 365.
   */
  it("warns on its tick that a Claude login made 340 days ago, lasting 365, has under 25 whole days left", async () => {
    const { dir } = await fixture({ hookExtra: CLAUDE_CONNECTION });
    const credentials = await storeOf({ claude: { ...claudeStored.claude, connectedAt: new Date(Date.now() - 340 * 86_400_000).toISOString() } });
    const { serve } = inProcessDoor();
    const printed: string[] = [];
    const said: string[] = [];
    const [log, error] = [console.log, console.error];
    console.log = (line: unknown): void => { printed.push(String(line)); };
    console.error = (line: unknown): void => { said.push(String(line)); };
    const running = runStart(dir, { interactive: false, credentials, serve });
    const expiring = (): LandraceEvent[] =>
      eventsIn(printed).filter((e) => e.name === "connection.expiring");
    try {
      await until(() => said.some((l) => l.includes("triage page at ")), "the page to start");
      await until(() => expiring().length > 0, "the tick's expiry warning");
      expect(expiring()).toEqual([expect.objectContaining({ connection: "claude", daysLeft: 24 })]);
      expect(printed.join("\n")).not.toContain(PERSON_TOKEN);
    } finally {
      process.emit("SIGINT");
      await running;
      [console.log, console.error] = [log, error];
    }
  }, 30_000);

  it("says why a lookup found nobody, and asks again at the next gate", async () => {
    const { dir } = await fixture({ hookExtra: CHAT_IDENTITY, configExtra: "people: { local: { email: other@example.invalid } }\n" });
    const credentials = await storeOf(null);
    const gate = await localGate(dir, credentials);
    expect(gate.lookups).toEqual(new Map([["chat", "Chat found nobody with your email"]]));
    expect((await credentials.read("local")).connections).toEqual({});
  }, 30_000);
});

/*
 * #184: `start`'s refresher, through `runStart`. A forge connection made by
 * OAuth, two minutes from its end; the token endpoint is a stub. A spy
 * preflight keeps the context the runtime's hooks are handed, so the test
 * reads the very `ctx.secrets` every hook reads.
 */
describe("runStart's OAuth refresher", () => {
  const OLD = "glo-old-access-token-0123456789";
  const NEW = "glo-new-access-token-0123456789";
  const REFRESH = "glr-old-refresh-token-0123456789";
  const NEXT_REFRESH = "glr-new-refresh-token-0123456789";
  const OAUTH_FORGE = `
export const forge = brand("connection", {
  id: "forge", label: "Forge", kind: "credential", fields: ["token"], paste: { hint: "a token" },
  oauth: () => ({
    authorizeUrl: "https://forge.example.invalid/oauth/authorize", tokenUrl: "https://forge.example.invalid/oauth/token",
    clientId: "client-123", clientSecret: "client-secret-0123456789", scope: "api",
  }),
});
export const spy = brand("preflight", {
  id: "spy",
  check: async (ctx: { secrets: ReadonlyMap<string, string> }): Promise<void> => { (globalThis as Record<string, unknown>).__lrLiveSecrets = ctx.secrets; },
});
`;
  const live = (): ReadonlyMap<string, string> | undefined => (globalThis as Record<string, unknown>).__lrLiveSecrets as ReadonlyMap<string, string> | undefined;

  async function oauthFixture(): Promise<{ dir: string; credentials: CredentialStore }> {
    const f = await fixture({ hookExtra: OAUTH_FORGE });
    const yaml = join(f.dir, "landrace.yaml");
    await writeFile(yaml, (await readFile(yaml, "utf8")).replace("secrets: { githubToken: $LR_TEST_TOKEN }", PER_PERSON_SECRET));
    const root = join(await mkdtemp(join(tmpdir(), "lr-creds-")), "credentials");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "local.json"), JSON.stringify({
      person: { id: "local" },
      connections: {
        forge: {
          fields: { token: OLD }, source: "oauth", connectedAt: new Date(Date.now() - 3_600_000).toISOString(),
          expiresAt: new Date(Date.now() + 120_000).toISOString(), refresh: { token: REFRESH },
        },
      },
    }));
    return { dir: f.dir, credentials: createCredentialStore(root) };
  }

  async function started<T>(dir: string, credentials: CredentialStore, answer: () => Response, body: (door: ReturnType<typeof inProcessDoor>, printed: string[]) => Promise<T>): Promise<T> {
    delete (globalThis as Record<string, unknown>).__lrLiveSecrets;
    const door = inProcessDoor();
    const printed: string[] = [];
    const said: string[] = [];
    const [log, error] = [console.log, console.error];
    console.log = (line: unknown): void => { printed.push(String(line)); };
    console.error = (line: unknown): void => { said.push(String(line)); };
    const fetch = (async () => answer()) as typeof globalThis.fetch;
    const running = runStart(dir, { interactive: false, credentials, serve: door.serve, oauth: { everyMs: 20, fetch } });
    try {
      await until(() => said.some((l) => l.includes("triage page at ")), "the page to start");
      return await body(door, printed);
    } finally {
      process.emit("SIGINT");
      await running;
      [console.log, console.error] = [log, error];
    }
  }

  it("renews a token near its end, stores it, and the live ctx.secrets every hook reads holds it — never logging either token", async () => {
    const { dir, credentials } = await oauthFixture();
    // The renewal before the build answers a token still inside the window,
    // so the loop's own pass renews it again under a running runtime.
    const MID = "glo-mid-access-token-0123456789";
    const MID_REFRESH = "glr-mid-refresh-token-0123456789";
    let asked = 0;
    const answer = (): Response => (asked++ === 0
      ? new Response(JSON.stringify({ access_token: MID, refresh_token: MID_REFRESH, expires_in: 300 }), { status: 200 })
      : new Response(JSON.stringify({ access_token: NEW, refresh_token: NEXT_REFRESH, expires_in: 7200 }), { status: 200 }));
    await started(dir, credentials, answer, async (_door, printed) => {
      await until(() => live()?.get("forgeToken") !== undefined, "the runtime's hooks to be handed a token");
      expect([MID, NEW]).toContain(live()?.get("forgeToken"));
      await until(async () => (await credentials.read("local")).connections["forge"]?.fields["token"] === NEW, "the renewed token to be stored");
      await until(() => live()?.get("forgeToken") === NEW, "the live secrets to hold the renewed token");
      expect((await credentials.read("local")).connections["forge"]).toMatchObject({ source: "oauth", refresh: { token: NEXT_REFRESH } });
      await until(() => printed.some((l) => l.includes("connection.refreshed")), "connection.refreshed");
      for (const secret of [OLD, MID, NEW, REFRESH, MID_REFRESH, NEXT_REFRESH]) expect(printed.join("\n")).not.toContain(secret);
      // Two minutes from its end, but renewed before it: nothing to warn a person of.
      expect(printed.filter((l) => l.includes("connection.expiring"))).toEqual([]);
    });
  }, 30_000);

  it("marks the row Not working when the token endpoint refuses the refresh with a 400", async () => {
    const { dir, credentials } = await oauthFixture();
    const answer = (): Response => new Response(JSON.stringify({ error: "invalid_grant", error_description: "The refresh token is revoked" }), { status: 400 });
    await started(dir, credentials, answer, async (door, printed) => {
      await until(async () => (await credentials.read("local")).connections["forge"]?.failure !== undefined, "the refused refresh to be marked");
      await until(async () => {
        const me = JSON.parse((await door.drive("/people/me")).body) as { connections: Array<{ id: string; state: string }>; ready: boolean };
        return me.connections.some((c) => c.id === "forge" && c.state === "failed") && !me.ready;
      }, "the row to be Not working");
      expect((await credentials.read("local")).connections["forge"]?.failure).toMatch(/invalid_grant: The refresh token is revoked/);
      // A row printed beside the events, the way timing lets one land in CI.
      printed.push(`#4242 term after 1 pass(es)`);
      const failed = eventsIn(printed).filter((e) => e.name === "connection.failed");
      expect(failed[0]).toMatchObject({ connection: "forge", error: expect.stringMatching(/invalid_grant/) });
      for (const secret of [OLD, REFRESH]) expect(printed.join("\n")).not.toContain(secret);
    });
  }, 30_000);

  it("connects through the door: the provider is sent back to the door's own callback, and the token is stored", async () => {
    const { dir, credentials } = await oauthFixture();
    await credentials.remove("local", "forge");
    const answer = (): Response => new Response(JSON.stringify({ access_token: NEW, refresh_token: NEXT_REFRESH, expires_in: 7200 }), { status: 200 });
    await started(dir, credentials, answer, async (door) => {
      const me = JSON.parse((await door.drive("/people/me")).body) as { oauth: Record<string, string> };
      expect(me.oauth).toEqual({ forge: "/connect/forge/start" });
      const start = await door.drive("/connect/forge/start");
      expect(start.status).toBe(302);
      const consent = new URL(start.headers["location"] ?? "");
      expect(consent.searchParams.get("redirect_uri")).toBe(`http://127.0.0.1:${DOOR_PORT}/connect/forge/callback`);
      const back = await door.drive(`/connect/forge/callback?code=c&state=${consent.searchParams.get("state") ?? ""}`);
      expect([back.status, back.headers["location"]]).toEqual([302, "/#/integrations"]);
      expect((await credentials.read("local")).connections["forge"]).toMatchObject({ fields: { token: NEW }, source: "oauth", refresh: { token: NEXT_REFRESH } });
      await until(() => live()?.get("forgeToken") === NEW, "the reload to hand the hooks the connected token");
    });
  }, 30_000);

  /*
   * With no door to connect through, the gate refuses a person not ready.
   * An OAuth token past its end is not ready, but its refresh token can mend
   * it: the gate renews it first, as the refresher would, and judges after.
   */
  async function expired(): Promise<{ dir: string; credentials: CredentialStore }> {
    const f = await oauthFixture();
    const stored = (await f.credentials.read("local")).connections["forge"];
    if (stored === undefined) throw new Error("fixture stored no forge connection");
    await f.credentials.put("local", { id: "local" }, "forge", { ...stored, expiresAt: new Date(Date.now() - 3 * 3_600_000).toISOString() });
    return f;
  }
  async function headless(dir: string, credentials: CredentialStore, answer: () => Response): Promise<{ printed: string[]; refused: unknown }> {
    delete (globalThis as Record<string, unknown>).__lrLiveSecrets;
    const printed: string[] = [];
    const log = console.log;
    console.log = (line: unknown): void => { printed.push(String(line)); };
    const fetch = (async () => answer()) as typeof globalThis.fetch;
    try {
      await runStart(dir, { interactive: false, credentials, ui: false, once: true, oauth: { fetch } });
      return { printed, refused: null };
    } catch (e) {
      return { printed, refused: e };
    } finally {
      console.log = log;
    }
  }

  it("renews an expired token before a headless --once start judges the person, and starts on it", async () => {
    const { dir, credentials } = await expired();
    expect((await localGate(dir, credentials)).resolution.ready).toBe(false);
    const answer = (): Response => new Response(JSON.stringify({ access_token: NEW, refresh_token: NEXT_REFRESH, expires_in: 7200 }), { status: 200 });
    const { printed, refused } = await headless(dir, credentials, answer);
    expect(refused).toBeNull();
    expect((await credentials.read("local")).connections["forge"]).toMatchObject({ fields: { token: NEW }, refresh: { token: NEXT_REFRESH } });
    expect(live()?.get("forgeToken")).toBe(NEW);
    expect(printed.some((l) => l.includes("connection.refreshed"))).toBe(true);
    for (const secret of [OLD, NEW, REFRESH, NEXT_REFRESH]) expect(printed.join("\n")).not.toContain(secret);
  }, 30_000);

  it("renews a --once start's ready token inside the renewal window before its one pass, which runs on the new token", async () => {
    const { dir, credentials } = await oauthFixture();
    // Ready, but two minutes from its end: a step in the one pass would outlive it.
    expect((await localGate(dir, credentials)).resolution.ready).toBe(true);
    const answer = (): Response => new Response(JSON.stringify({ access_token: NEW, refresh_token: NEXT_REFRESH, expires_in: 7200 }), { status: 200 });
    const { printed, refused } = await headless(dir, credentials, answer);
    expect(refused).toBeNull();
    expect((await credentials.read("local")).connections["forge"]).toMatchObject({ fields: { token: NEW }, refresh: { token: NEXT_REFRESH } });
    expect(live()?.get("forgeToken")).toBe(NEW);
    for (const secret of [OLD, NEW, REFRESH, NEXT_REFRESH]) expect(printed.join("\n")).not.toContain(secret);
  }, 30_000);

  it("renews a board start's expired token before the person is judged: the runtime is built on it, and no Integrations-tab warning is printed", async () => {
    const { dir, credentials } = await expired();
    delete (globalThis as Record<string, unknown>).__lrLiveSecrets;
    const door = inProcessDoor();
    const said: string[] = [];
    const [log, error] = [console.log, console.error];
    console.log = (): void => {};
    console.error = (line: unknown): void => { said.push(String(line)); };
    const fetch = (async () => new Response(JSON.stringify({ access_token: NEW, refresh_token: NEXT_REFRESH, expires_in: 7200 }), { status: 200 })) as typeof globalThis.fetch;
    const running = runStart(dir, { interactive: false, credentials, serve: door.serve, oauth: { everyMs: 60_000, fetch } });
    try {
      await until(() => said.some((l) => l.includes("triage page at ")), "the page to start");
      // The runtime's preflight ran before the page opened, on the renewed token.
      expect(live()?.get("forgeToken")).toBe(NEW);
      expect(said.join("\n")).not.toContain("nothing runs until");
    } finally {
      process.emit("SIGINT");
      await running;
      [console.log, console.error] = [log, error];
    }
  }, 30_000);

  it("still refuses a headless start whose expired token the provider will not renew, marking it failed", async () => {
    const { dir, credentials } = await expired();
    const answer = (): Response => new Response(JSON.stringify({ error: "invalid_grant", error_description: "revoked" }), { status: 400 });
    const { printed, refused } = await headless(dir, credentials, answer);
    expect(String(refused)).toMatch(/^Error: connection\.\w+: .*forge/im);
    expect((await credentials.read("local")).connections["forge"]?.failure).toMatch(/invalid_grant: revoked/);
    expect(live()).toBeUndefined();
    for (const secret of [OLD, REFRESH]) expect(printed.join("\n")).not.toContain(secret);
  }, 30_000);

  it("keeps the token and tries again after a 5xx, marking nothing", async () => {
    const { dir, credentials } = await oauthFixture();
    let asked = 0;
    const answer = (): Response => { asked++; return new Response("upstream down", { status: 503 }); };
    await started(dir, credentials, answer, async (_door, printed) => {
      await until(() => asked >= 2, "a second try after the first 503");
      expect((await credentials.read("local")).connections["forge"]).toMatchObject({ fields: { token: OLD } });
      expect((await credentials.read("local")).connections["forge"]).not.toHaveProperty("failure");
      expect(printed.some((l) => l.includes("connection.failed"))).toBe(true);
    });
  }, 30_000);
});

/*
 * #187: `people.oidc` makes the start remote. What is observed is what the
 * door it serves answers before anyone signs in, and who its roster holds:
 * everyone who signed in before, never the operator's own `local` file.
 */
describe("runStart with people.oidc", () => {
  const REMOTE = "serve: { host: 0.0.0.0, publicUrl: \"https://landrace.example.org/\" }\n" +
    "people: { oidc: { issuer: https://id.example.invalid, clientId: landrace, clientSecret: oidc-client-secret-value }, allow: [\"@example.invalid\"] }\n";

  it("serves a door that asks who is calling, and holds who signed in before but the local file", async () => {
    const { dir } = await fixture({ configExtra: REMOTE, items: [] });
    const credentials = createCredentialStore(join(await mkdtemp(join(tmpdir(), "lr-remote-start-")), "credentials"));
    await credentials.remember({ id: "local" });
    await credentials.remember({ id: "sub-alice", email: "alice@example.invalid" });
    const { serve, drive } = inProcessDoor();
    const said: string[] = [];
    const [log, error] = [console.log, console.error];
    console.log = (): void => {};
    console.error = (line: unknown): void => { said.push(String(line)); };
    const running = runStart(dir, { interactive: false, credentials, serve });
    try {
      await until(() => said.some((l) => l.includes("people sign in at")), "the door to open");
      expect(said.join("\n")).toContain("people sign in at http://127.0.0.1:4545/; 1 have before");
      const page = await drive("/");
      expect([page.status, page.headers["location"]]).toEqual([302, "/login?return=%2F"]);
      expect((await drive("/board.json")).status).toBe(401);
      expect((await drive("/people/me")).status).toBe(401);
    } finally {
      process.emit("SIGINT");
      await running;
      [console.log, console.error] = [log, error];
    }
  }, 30_000);

  /*
   * Which runtime answers a caller is `runStart`'s own choice, by who the
   * session or the bearer names: the fake source lists by the person's own
   * pasted token, so alice's runtime holds #101 and bob's #202, and a door
   * that answered everyone from one runtime shows one of them the other's.
   */
  it("answers each signed-in person's /board.json and bearer /mcp from their own runtime alone", async () => {
    const PUBLIC = "https://landrace.example.org";
    const ALICE_TOKEN = "ghp_alice_pasted_token_long_enough";
    const BOB_TOKEN = "ghp_bob_pasted_token_long_enough_x";
    const { dir } = await fixture({
      hookExtra: FORGE_CONNECTION, configExtra: REMOTE,
      items: [{ id: "101", labels: ["lr:auto"] }, { id: "202", labels: ["lr:auto"] }],
    });
    const yaml = join(dir, "landrace.yaml");
    await writeFile(yaml, (await readFile(yaml, "utf8")).replace("secrets: { githubToken: $LR_TEST_TOKEN }", PER_PERSON_SECRET));
    const hook = join(dir, "hooks", "fake.ts");
    const theirs = `((ctx: { secrets: ReadonlyMap<string, string> }) => ({ nodes: graph.nodes.filter((n) => n.id === (ctx.secrets.get("forgeToken") === ${JSON.stringify(ALICE_TOKEN)} ? "101" : "202")), relationships: [] }))`;
    const source = (await readFile(hook, "utf8"))
      .replace("list: async (): Promise<unknown> => {", "list: async (ctx: { secrets: ReadonlyMap<string, string> }): Promise<unknown> => {")
      .replace("    return graph;\n", `    return ${theirs}(ctx);\n`)
      .replace("read: async (): Promise<unknown> => graph,", `read: async (_id: string, ctx: { secrets: ReadonlyMap<string, string> }): Promise<unknown> => ${theirs}(ctx),`);
    // Both of the source's reads now list by the token, or the test proves nothing.
    expect(source.split('ctx.secrets.get("forgeToken")').length - 1).toBe(2);
    expect(source).not.toContain("return graph;");
    await writeFile(hook, source);

    const credentials = createCredentialStore(join(await mkdtemp(join(tmpdir(), "lr-remote-start-")), "credentials"));
    const alice = { id: "sub-alice", email: "alice@example.invalid" };
    const bob = { id: "sub-bob", email: "bob@example.invalid" };
    for (const [person, token] of [[alice, ALICE_TOKEN], [bob, BOB_TOKEN]] as const) {
      await credentials.put(person.id, person, "forge", { fields: { token }, source: "paste", connectedAt: new Date().toISOString() });
    }
    const { serve, drive, options } = inProcessDoor();
    const said: string[] = [];
    const [log, error] = [console.log, console.error];
    console.log = (): void => {};
    console.error = (line: unknown): void => { said.push(String(line)); };
    const running = runStart(dir, { interactive: false, credentials, serve });
    try {
      await until(() => said.some((l) => l.includes("people sign in at")), "the door to open");
      const sessions = options().remote?.sessions;
      if (!sessions) throw new Error("runStart handed a remote door no sessions");
      const cookieOf = (person: typeof alice): string => sessions.issue(person).split(";")[0] ?? "";

      // The board, by the browser's session.
      const rowsOf = async (cookie: string): Promise<string[] | null> => {
        const view = JSON.parse((await drive("/board.json", { headers: { cookie } })).body) as { listed?: boolean; rows?: Array<{ id: string }> };
        return view.listed === true ? (view.rows ?? []).map((r) => r.id) : null;
      };
      const [aliceCookie, bobCookie] = [cookieOf(alice), cookieOf(bob)];
      await until(async () => (await rowsOf(aliceCookie)) !== null && (await rowsOf(bobCookie)) !== null, "both boards to list");
      expect(await rowsOf(aliceCookie)).toEqual(["101"]);
      expect(await rowsOf(bobCookie)).toEqual(["202"]);

      // `/mcp`, by the bearer each one's own consent issued.
      const fetch = memoryFetch(frontDoorListener(options(), DOOR_PORT));
      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const redirect = "http://127.0.0.1:33418/callback";
      const bearerOf = async (cookie: string): Promise<string> => {
        const registered = await fetch(`${PUBLIC}/register`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ redirect_uris: [redirect], client_name: "test", token_endpoint_auth_method: "none" }),
        });
        const clientId = ((await registered.json()) as { client_id: string }).client_id;
        const page = await (await fetch(`${PUBLIC}/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirect)}` +
          `&code_challenge=${challenge}&code_challenge_method=S256&state=st-1`, { headers: { cookie } })).text();
        const consent = /name="token" value="([^"]+)"/.exec(page)?.[1] ?? "";
        const approved = await fetch(`${PUBLIC}/authorize/consent`, {
          method: "POST", headers: { cookie, origin: PUBLIC, "content-type": "application/x-www-form-urlencoded" }, body: `token=${consent}&decision=approve`,
        });
        const code = new URL(approved.headers.get("location") ?? "").searchParams.get("code") ?? "";
        const issued = await fetch(`${PUBLIC}/token`, {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: redirect }).toString(),
        });
        expect(issued.status).toBe(200);
        return ((await issued.json()) as { access_token: string }).access_token;
      };
      const itemsOf = async (bearer: string): Promise<string[]> => {
        const client = new Client({ name: "test", version: "0" });
        const withBearer: typeof globalThis.fetch = (input, init) =>
          fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), authorization: `Bearer ${bearer}` } });
        await client.connect(new StreamableHTTPClientTransport(new URL(`${PUBLIC}/mcp`), { fetch: withBearer }) as unknown as Transport);
        try {
          const text = (await client.callTool({ name: "landrace_items", arguments: {} }) as { content: Array<{ text: string }> }).content[0]?.text ?? "";
          return ["101", "202"].filter((id) => text.includes(`"${id}"`));
        } finally {
          await client.close();
        }
      };
      expect(await itemsOf(await bearerOf(aliceCookie))).toEqual(["101"]);
      expect(await itemsOf(await bearerOf(bobCookie))).toEqual(["202"]);
    } finally {
      process.emit("SIGINT");
      await running;
      [console.log, console.error] = [log, error];
    }
  }, 30_000);

  /*
   * #208: alice's tracker lists #4242 and bob's #202, and each runs its
   * items:create step. Each step's child server is started as its own
   * person, so the child tool it serves reads that person's token — never
   * the local person's, stored here too. Then both trackers list both
   * items, and each person's panel shows only the lines their own run
   * wrote: nothing of the other's item, which both now list.
   */
  it("files each person's sub-items with their own token, and shows each only their own activity for an item both list", async () => {
    const [ALICE_TOKEN, BOB_TOKEN, LOCAL_TOKEN] = ["ghp_alice_pasted_token_long_enough", "ghp_bob_pasted_token_long_enough_x", "ghp_local_stored_token_long_enough"];
    const { dir, record } = await fixture({
      agent: "fake", agentKeys: "isolation: none", hookExtra: FORGE_CONNECTION, configExtra: REMOTE, workflow: stepped(true),
      items: [{ id: ITEM, labels: ["lr:auto", "lr:stage:breakdown"] }, { id: "202", labels: ["lr:auto", "lr:stage:breakdown"] }],
    });
    await mkdir(join(workflowIn(dir), "steps"), { recursive: true });
    await writeFile(join(workflowIn(dir), "steps", "breakdown.md"), breakdownStep("repo:read, items:create"));
    const yaml = join(dir, "landrace.yaml");
    await writeFile(yaml, (await readFile(yaml, "utf8")).replace("secrets: { githubToken: $LR_TEST_TOKEN }", PER_PERSON_SECRET));
    // Each tracker lists its person's own item, and both once `both` exists.
    const both = join(dir, "both");
    const hook = join(dir, "hooks", "fake.ts");
    const theirs = `((ctx: { secrets: ReadonlyMap<string, string> }) => ({ nodes: graph.nodes.filter((n) => existsSync(${JSON.stringify(both)}) || ` +
      `n.id === (ctx.secrets.get("forgeToken") === ${JSON.stringify(ALICE_TOKEN)} ? ${JSON.stringify(ITEM)} : "202")), relationships: [] }))`;
    const source = (await readFile(hook, "utf8"))
      .replace("list: async (): Promise<unknown> => {", "list: async (ctx: { secrets: ReadonlyMap<string, string> }): Promise<unknown> => {")
      .replace("    return graph;\n", `    return ${theirs}(ctx);\n`)
      .replace("read: async (): Promise<unknown> => graph,", `read: async (_id: string, ctx: { secrets: ReadonlyMap<string, string> }): Promise<unknown> => ${theirs}(ctx),`);
    expect(source.split('ctx.secrets.get("forgeToken")').length - 1).toBe(2);
    await writeFile(hook, source);
    // The executor writes down the child server it was handed and says, on the panel, whose that server is;
    // the operator writes down the token each child is created with.
    await appendFile(join(dir, "hooks", "fake.ts"), `
export const executor = brand("executor", {
  id: "fake",
  run: async (_prompt: string, o: { child?: { server?: { args: string[] } }; onActivity?: (e: unknown) => void }): Promise<{ text: string; sessionId: string | null }> => {
    const args = o.child?.server?.args ?? [];
    o.onActivity?.({ kind: "message", text: "ran as " + (args.find((a) => a.startsWith("--person=")) ?? "nobody"), at: 1 });
    await appendFile(${JSON.stringify(record)}, JSON.stringify({ child: args }) + "\\n");
    return { text: "", sessionId: null };
  },
});

export const operator = brand("operator", {
  id: "fake",
  createItem: async (input: { title: string }, ctx: { secrets: ReadonlyMap<string, string> }): Promise<unknown> => {
    await appendFile(${JSON.stringify(record)}, JSON.stringify({ createdWith: ctx.secrets.get("forgeToken") }) + "\\n");
    return { id: "9", kind: "item", title: input.title, link: "u/9", closed: null, priority: null, origin: null, state: { labels: [], assignees: [] } };
  },
  updateItem: async (): Promise<unknown> => { throw new Error("not here"); },
  relates: (): string[] => [],
});

// No child was ever made before the first round, so none is left to close.
export const closer = brand("post", { id: "closer", handles: ["nodes.close"], satisfied: (): boolean => true, apply: async (): Promise<void> => {} });
`);
    const credentials = createCredentialStore(join(await mkdtemp(join(tmpdir(), "lr-remote-start-")), "credentials"));
    const alice = { id: "sub-alice", email: "alice@example.invalid" };
    const bob = { id: "sub-bob", email: "bob@example.invalid" };
    for (const [person, token] of [[alice, ALICE_TOKEN], [bob, BOB_TOKEN], [{ id: "local" }, LOCAL_TOKEN]] as const) {
      await credentials.put(person.id, person, "forge", { fields: { token }, source: "paste", connectedAt: new Date().toISOString() });
    }
    const { serve, drive, options } = inProcessDoor();
    const said: string[] = [];
    const [log, error] = [console.log, console.error];
    console.log = (): void => {};
    console.error = (line: unknown): void => { said.push(String(line)); };
    const running = runStart(dir, { interactive: false, credentials, serve });
    try {
      const children = async (): Promise<string[][]> =>
        (await applied(record)).flatMap((r) => ((r as { child?: string[] }).child ? [(r as { child: string[] }).child] : []));
      await until(async () => (await children()).length === 2, "each person's step to run");
      const byPerson = new Map((await children()).map((args) => [args.find((a) => a.startsWith("--person="))?.slice("--person=".length), args]));
      expect([...byPerson.keys()].sort()).toEqual(["sub-alice", "sub-bob"]);

      // Each child server, as its own command line says to build it.
      for (const [person, token] of [["sub-alice", ALICE_TOKEN], ["sub-bob", BOB_TOKEN]] as const) {
        const args = byPerson.get(person) ?? [];
        const flag = (name: string): string => args[args.indexOf(name) + 1] ?? "";
        const tool = await buildChildTool(flag("--workspace"), { parent: flag("--child"), stage: flag("--stage"), round: Number(flag("--round")) }, flag("--workflow"), person, credentials);
        await tool.createChild({ title: "API" });
        expect((await applied(record)).at(-1)).toEqual({ createdWith: token });
      }

      // Both trackers list both items now: each board shows both, once a pass has listed again.
      const sessions = options().remote?.sessions;
      if (!sessions) throw new Error("runStart handed a remote door no sessions");
      const cookieOf = (person: typeof alice): string => sessions.issue(person).split(";")[0] ?? "";
      await writeFile(both, "");
      const rowsOf = async (person: typeof alice): Promise<string[]> => {
        expect((await drive("/refresh", { method: "POST", headers: { cookie: cookieOf(person), "x-landrace-action": "refresh", origin: "https://landrace.example.org" } })).status).toBeLessThan(300);
        const view = JSON.parse((await drive("/board.json", { headers: { cookie: cookieOf(person) } })).body) as { rows?: Array<{ id: string }> };
        return (view.rows ?? []).map((r) => r.id).sort();
      };
      await until(async () => (await rowsOf(alice)).length === 2 && (await rowsOf(bob)).length === 2, "both boards to list both items");

      // Each person's panel, by their own session.
      const linesOf = async (person: typeof alice, item: string): Promise<string[]> => {
        const res = await drive(`/items/${item}/activity`, { headers: { cookie: cookieOf(person) } });
        expect(res.status).toBe(200);
        return (JSON.parse(res.body) as { lines: Array<{ text: string }> }).lines.map((l) => l.text);
      };
      expect(await linesOf(alice, ITEM)).toEqual(["ran as --person=sub-alice"]);
      expect(await linesOf(bob, "202")).toEqual(["ran as --person=sub-bob"]);
      expect(await linesOf(bob, ITEM)).toEqual([]);
      expect(await linesOf(alice, "202")).toEqual([]);
    } finally {
      process.emit("SIGINT");
      await running;
      [console.log, console.error] = [log, error];
    }
  }, 30_000);

  /*
   * #208: a session for someone the roster has not judged yet — here one
   * issued without a sign-in, which nothing judges — asks for its
   * Integrations tab. The start's own judging is the local person's, and
   * must never answer for them.
   */
  it("refuses the Integrations tab of a person not judged yet, rather than answering with the local person's", async () => {
    const { dir } = await fixture({ hookExtra: FORGE_CONNECTION, configExtra: REMOTE, items: [] });
    const yaml = join(dir, "landrace.yaml");
    await writeFile(yaml, (await readFile(yaml, "utf8")).replace("secrets: { githubToken: $LR_TEST_TOKEN }", PER_PERSON_SECRET));
    const credentials = createCredentialStore(join(await mkdtemp(join(tmpdir(), "lr-remote-start-")), "credentials"));
    await credentials.put("local", { id: "local" }, "forge", { fields: { token: "ghp_local_stored_token_long_enough" }, source: "paste", connectedAt: new Date().toISOString() });
    const { serve, drive, options } = inProcessDoor();
    const said: string[] = [];
    const [log, error] = [console.log, console.error];
    console.log = (): void => {};
    console.error = (line: unknown): void => { said.push(String(line)); };
    const running = runStart(dir, { interactive: false, credentials, serve });
    try {
      await until(() => said.some((l) => l.includes("people sign in at")), "the door to open");
      const sessions = options().remote?.sessions;
      if (!sessions) throw new Error("runStart handed a remote door no sessions");
      const cookie = sessions.issue({ id: "sub-carol", email: "carol@example.invalid" }).split(";")[0] ?? "";
      const me = await drive("/people/me", { headers: { cookie } });
      expect([me.status, me.body]).toEqual([409, "sub-carol's connections are not ready yet; try again in a moment"]);
    } finally {
      process.emit("SIGINT");
      await running;
      [console.log, console.error] = [log, error];
    }
  }, 30_000);

  /*
   * A person whose judging threw has no gate either, but waiting will not
   * give them one: their tab says it could not be judged, and why, rather
   * than "try again in a moment" on every poll for as long as it keeps failing.
   */
  it("says a person's connections could not be judged, with the judging's error, when it threw", async () => {
    const { dir } = await fixture({ hookExtra: FORGE_CONNECTION, configExtra: REMOTE, items: [] });
    const yaml = join(dir, "landrace.yaml");
    await writeFile(yaml, (await readFile(yaml, "utf8")).replace("secrets: { githubToken: $LR_TEST_TOKEN }", PER_PERSON_SECRET));
    const store = createCredentialStore(join(await mkdtemp(join(tmpdir(), "lr-remote-start-")), "credentials"));
    await store.put("local", { id: "local" }, "forge", { fields: { token: "ghp_local_stored_token_long_enough" }, source: "paste", connectedAt: new Date().toISOString() });
    const carol = { id: "sub-carol", email: "carol@example.invalid" };
    await store.remember(carol);
    // Carol's file cannot be read, so every judging of her throws.
    const credentials: typeof store = { ...store, read: async (id) => { if (id === carol.id) throw new Error("carol's file is unreadable near ghp_local_stored_token_long_enough"); return store.read(id); } };
    const { serve, drive, options } = inProcessDoor();
    const said: string[] = [];
    const [log, error] = [console.log, console.error];
    console.log = (line: unknown): void => { said.push(String(line)); };
    console.error = (line: unknown): void => { said.push(String(line)); };
    const running = runStart(dir, { interactive: false, credentials, serve });
    try {
      await until(() => said.some((l) => l.includes("people sign in at")), "the door to open");
      await until(() => said.some((l) => l.includes("could not build their runtime")), `carol's judging to fail: ${said.join("\n")}`);
      const sessions = options().remote?.sessions;
      if (!sessions) throw new Error("runStart handed a remote door no sessions");
      const cookie = sessions.issue(carol).split(";")[0] ?? "";
      const me = await drive("/people/me", { headers: { cookie } });
      expect(me.status).toBe(409);
      expect(me.body).toContain("sub-carol's connections could not be judged");
      expect(me.body).toContain("carol's file is unreadable");
      expect(me.body).not.toContain("try again in a moment");
      expect(me.body).not.toContain("ghp_local_stored_token_long_enough");
    } finally {
      process.emit("SIGINT");
      await running;
      [console.log, console.error] = [log, error];
    }
  }, 30_000);

  it("refuses --headless, which leaves nobody a door to sign in through", async () => {
    const { dir } = await fixture({ configExtra: REMOTE, items: [] });
    const credentials = createCredentialStore(join(await mkdtemp(join(tmpdir(), "lr-remote-start-")), "credentials"));
    await expect(runStart(dir, { interactive: false, credentials, ui: false })).rejects.toThrow(/people\.oidc is set.*--headless/);
  });

  it("refuses people.oidc with no serve.publicUrl, in validate's words", async () => {
    const { dir } = await fixture({
      configExtra: "people: { oidc: { issuer: https://id.example.invalid, clientId: landrace, clientSecret: oidc-client-secret-value } }\n", items: [],
    });
    const credentials = createCredentialStore(join(await mkdtemp(join(tmpdir(), "lr-remote-start-")), "credentials"));
    await expect(runStart(dir, { interactive: false, credentials, serve: inProcessDoor().serve })).rejects.toThrow(/serve\.public-url: people\.oidc is set and serve\.publicUrl is not/);
  });

  // #204: a remote instance that lists nobody would admit nobody.
  it.each([
    ["absent", REMOTE.replace(', allow: ["@example.invalid"]', "")],
    ["empty", REMOTE.replace('allow: ["@example.invalid"]', "allow: []")],
  ])("refuses a remote start whose people.allow is %s, naming people.allow", async (_, config) => {
    expect(config).not.toContain("@example.invalid");
    const { dir } = await fixture({ configExtra: config, items: [] });
    const credentials = createCredentialStore(join(await mkdtemp(join(tmpdir(), "lr-remote-start-")), "credentials"));
    await expect(runStart(dir, { interactive: false, credentials, serve: inProcessDoor().serve })).rejects.toThrow(/people\.allow: people\.oidc is set and people\.allow lists no one/);
  });

  /*
   * #204: removing someone is taking them off people.allow and restarting.
   * Carol signed in and connected an editor before; the list no longer
   * names her domain. Her file stays, so putting her back restores her.
   */
  it("restarted without a stored person on people.allow, holds no runtime for them, keeps their file, and drops their refresh tokens", async () => {
    const { dir } = await fixture({ configExtra: REMOTE, items: [] });
    const credentials = createCredentialStore(join(await mkdtemp(join(tmpdir(), "lr-remote-start-")), "credentials"));
    const alice = { id: "sub-alice", email: "alice@example.invalid" };
    const carol = { id: "sub-carol", email: "carol@example.org" };
    await credentials.remember(alice);
    await credentials.remember(carol);
    const at = Date.now();
    await mkdir(join(credentials.root, "mcp"), { recursive: true });
    await writeFile(join(credentials.root, "mcp", "mcp-tokens.json"), JSON.stringify({
      a: { clientId: "c1", person: alice, scopes: [], expires: at + 60_000, consentedAt: at },
      c: { clientId: "c2", person: carol, scopes: [], expires: at + 60_000, consentedAt: at },
    }));
    const { serve, drive, options } = inProcessDoor();
    const said: string[] = [];
    const [log, error] = [console.log, console.error];
    console.log = (): void => {};
    console.error = (line: unknown): void => { said.push(String(line)); };
    const running = runStart(dir, { interactive: false, credentials, serve });
    try {
      await until(() => said.some((l) => l.includes("people sign in at")), "the door to open");
      expect(said.join("\n")).toContain("; 1 have before");
      expect((await credentials.list()).map((p) => p.id).sort()).toEqual([alice.id, carol.id]);
      const sessions = options().remote?.sessions;
      if (!sessions) throw new Error("runStart handed a remote door no sessions");
      const cookie = sessions.issue(carol).split(";")[0] ?? "";
      expect((await drive("/board.json", { headers: { cookie } })).status).toBe(401);
      // The tokens file is read when the door's MCP routes are first reached.
      const fetch = memoryFetch(frontDoorListener(options(), DOOR_PORT));
      await fetch("https://landrace.example.org/register", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const kept = JSON.parse(await readFile(join(credentials.root, "mcp", "mcp-tokens.json"), "utf8")) as Record<string, unknown>;
      expect(Object.keys(kept)).toEqual(["a"]);
    } finally {
      process.emit("SIGINT");
      await running;
      [console.log, console.error] = [log, error];
    }
  }, 30_000);
});

describe("landrace validate with people.oidc", () => {
  it("says each stored person's own problem by their email, and is still ok when the instance is", async () => {
    const { dir, credentials } = await unready("secret");
    const yaml = join(dir, "landrace.yaml");
    await writeFile(yaml, `${await readFile(yaml, "utf8")}serve: { host: 0.0.0.0, publicUrl: "https://landrace.example.org/" }\n` +
      "people: { oidc: { issuer: https://id.example.invalid, clientId: landrace, clientSecret: oidc-client-secret-value }, allow: [\"@example.invalid\"] }\n");
    await credentials.put("sub-alice", { id: "sub-alice", email: "alice@example.invalid" }, "forge", {
      fields: { token: PASTED }, source: "paste", connectedAt: new Date().toISOString(),
    });
    await credentials.remember({ id: "sub-bob", email: "bob@example.invalid" });
    // Off people.allow: the instance runs nothing for her, so her problems are nobody's to mend.
    await credentials.remember({ id: "sub-carol", email: "carol@example.org" });
    // The operator's own file: nobody's, remotely, so never judged.
    await credentials.remember({ id: "local" });
    await writeFile(join(dir, "..", ".gitignore"), ".env\n");
    const { ok, problems, people } = await runValidate(dir, { credentials });
    expect(problems).toEqual([]);
    expect(ok).toBe(true);
    expect(people).toEqual([expect.stringMatching(/^bob@example\.invalid: connection\.missing: secrets entry "forgeToken" has no value/)]);
  });

  // #204: what a remote instance shares that it may not mean to is said, and never fails it.
  it("warns of a string secret and of a per-person key with env set, naming each, and exits 0", async () => {
    const { dir, credentials } = await unready("secret");
    const yaml = join(dir, "landrace.yaml");
    const config = (await readFile(yaml, "utf8")).replace("forgeToken: { perPerson: true, connection: forge.token }", "forgeToken: { perPerson: true, env: LR_TEST_FORGE_UNSET, connection: forge.token }");
    expect(config).toContain("githubToken: $LR_TEST_TOKEN");
    expect(config).toContain("env: LR_TEST_FORGE_UNSET");
    await writeFile(yaml, `${config}serve: { host: 0.0.0.0, publicUrl: "https://landrace.example.org/" }\n` +
      "people: { oidc: { issuer: https://id.example.invalid, clientId: landrace, clientSecret: oidc-client-secret-value }, allow: [\"ann@example.com\"] }\n");
    await writeFile(join(dir, "..", ".gitignore"), ".env\n");
    const result = await runValidate(dir, { credentials });
    expect(result.problems).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringMatching(/^secrets\.githubToken is one value for everyone/),
      expect.stringMatching(/^secrets\.forgeToken reads \$LR_TEST_FORGE_UNSET first/),
    ]);
    const printed: string[] = [];
    expect(reportValidate(dir, result, { out: (l) => printed.push(l), err: (l) => printed.push(l) })).toBe(0);
    expect(printed.filter((l) => l.startsWith("warning: "))).toHaveLength(2);
  });

  // `start` refuses a key naming a connection no hook defines whoever is
  // stored; a verdict that waited for someone to sign in flipped as they did.
  it("reports connection.unknown once from the config, with nobody stored or with people stored", async () => {
    const { dir, credentials } = await unready("secret");
    const yaml = join(dir, "landrace.yaml");
    await writeFile(yaml, `${(await readFile(yaml, "utf8")).replace("connection: forge.token", "connection: nope.token")}` +
      `serve: { host: 0.0.0.0, publicUrl: "https://landrace.example.org/" }\n` +
      "people: { oidc: { issuer: https://id.example.invalid, clientId: landrace, clientSecret: oidc-client-secret-value }, allow: [\"@example.invalid\"] }\n");
    await writeFile(join(dir, "..", ".gitignore"), ".env\n");
    const unknown = [{ rule: "connection.unknown", message: expect.stringMatching(/"forgeToken" names connection "nope", which no hook defines/) }];
    const empty = await runValidate(dir, { credentials });
    expect(empty.problems).toEqual(unknown);
    expect(empty.ok).toBe(false);
    await credentials.remember({ id: "sub-alice", email: "alice@example.invalid" });
    await credentials.remember({ id: "sub-bob", email: "bob@example.invalid" });
    const stored = await runValidate(dir, { credentials });
    expect(stored.problems).toEqual(unknown);
    expect(stored.ok).toBe(false);
  });
});
