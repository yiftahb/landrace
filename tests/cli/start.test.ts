import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runtimeConfigSchema } from "#config/schema.js";
import { defineExecutor } from "#hooks/contracts.js";
import { renderMarker } from "#conventions.js";
import type { Board, Executor, ExecutorContext, LandraceEvent, Registry, Schedule, Source, StartOptions, WakeResult, Workflow } from "#namespace.js";
import { createBoard } from "#ui/board.js";
import { createActivityLog } from "#runner/activity.js";
import { createDispatcher } from "#runner/effects.js";
import { buildSnapshot } from "#runner/snapshot.js";
import { createFakeTracker } from "#tests/support/fake-tracker.js";
import { describeLoopback } from "#tests/support/loopback.js";
import { workflowIn, workspaceOf } from "#tests/support/workspace.js";
import {
  boardSink,
  browserCommand,
  buildWorkspaceRuntime,
  childServerCommand,
  createInterrupt,
  executorFor,
  screenerFor,
  gotoFor,
  loop,
  openBoard,
  panelFor,
  parseInterval,
  parsePort,
  repoWorkspace,
  sandboxFor,
  sourceReaders,
  startCommand,
  startUi,
} from "#cli/start.js";
import { gitRepo, removeRepos } from "#tests/support/repo.js";

afterAll(removeRepos);

// Counts the SDK being loaded, and otherwise is the SDK.
let mockSdkLoads = 0;
jest.mock("@opentelemetry/sdk-logs", () => {
  mockSdkLoads += 1;
  return jest.requireActual("@opentelemetry/sdk-logs");
});

const TOKEN = "ghp_a_token_long_enough_to_redact";
const exec = promisify(execFile);

/**
 * A workflow directory on disk, because that is the only thing `buildWorkspaceRuntime`
 * takes: every failure it exists to report is a file a person can go and edit,
 * and a fixture built out of objects would prove nothing about reading them.
 *
 * No `hooks:` list, so nothing is imported — the default jest pass cannot
 * import a module by file URL at all (see jest.esm.config.mjs), and the tests
 * that need a real hook module live in tests/esm/cli-start.test.ts.
 */
async function fixture(
  config: Partial<Record<"log" | "agent" | "agentKeys" | "extra", string>> & { git?: boolean } = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lr-start-"));
  if (config.git) await exec("git", ["init", "-q", "-b", "main"], { cwd: root });
  const dir = join(root, ".landrace");
  await workspaceOf({ main: "tests/fixtures/minimal" }, dir);
  await writeFile(
    join(dir, "landrace.yaml"),
    `version: 1
agent: { adapter: ${config.agent ?? "claude"}, model: opus${config.agentKeys ? `, ${config.agentKeys}` : ""} }
tracker: { repo: acme/widgets }
tick: { interval: 30s, concurrency: 2 }
security: { screen: false }
log: { redact: [${config.log ?? "githubToken"}] }
secrets: { githubToken: $LR_TEST_TOKEN }
${config.extra ?? ""}`,
  );
  await writeFile(join(dir, ".env"), `LR_TEST_TOKEN=${TOKEN}\n`);
  return dir;
}

describe("parseInterval", () => {
  it("reads seconds, minutes and hours", () => {
    expect(parseInterval("30s")).toBe(30_000);
    expect(parseInterval("2m")).toBe(120_000);
    expect(parseInterval("1h")).toBe(3_600_000);
  });

  /**
   * A bare number is the likeliest typo, and the two ways of guessing are both
   * bad: read as milliseconds it polls a tracker sixty times a second, read as
   * seconds it silently means something the operator did not write.
   */
  it("refuses anything else rather than guessing a unit", () => {
    for (const bad of ["60", "", "2 m", "0.5m", "2d", "-1s", "s"]) {
      expect(() => parseInterval(bad)).toThrow(/interval/);
    }
  });
});

describe("agent.worktree", () => {
  const config = (agent: Record<string, unknown>) => runtimeConfigSchema.parse({ version: 1, agent: { adapter: "fake", ...agent } });

  it("defaults to nothing to copy or set up, with a 15 minute setup timeout", async () => {
    const root = await gitRepo();
    expect(await sandboxFor(config({}), root)).toMatchObject({
      worktree: { copy: [], setup: [], timeoutMs: 900_000, lockfiles: ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"] },
    });
  });

  it("takes the lockfiles setup runs again for, and refuses one absolute or climbing out, naming it", async () => {
    const root = await gitRepo();
    const lockfiles = ["backend/pnpm-lock.yaml", "**/yarn.lock"];
    expect(await sandboxFor(config({ worktree: { lockfiles } }), root)).toMatchObject({ worktree: { lockfiles } });
    await expect(sandboxFor(config({ worktree: { lockfiles: ["/etc/hosts", "ok"] } }), root))
      .rejects.toThrow(/agent\.worktree\.lockfiles "\/etc\/hosts" is an absolute path/);
    await expect(sandboxFor(config({ worktree: { lockfiles: ["../x/pnpm-lock.yaml"] } }), root))
      .rejects.toThrow(/agent\.worktree\.lockfiles "\.\.\/x\/pnpm-lock\.yaml" climbs out/);
    await expect(sandboxFor(config({ isolation: "none", worktree: { lockfiles } }), root)).rejects.toThrow(/lockfiles[\s\S]*agent\.isolation: worktree/);
  });

  it("is refused at start when a copy glob matches a tracked file, naming it", async () => {
    const root = await gitRepo();
    await expect(sandboxFor(config({ worktree: { copy: ["src/**"] } }), root)).rejects.toThrow(/src\/a\.ts/);
  });

  it("is refused when there is no worktree to copy into or set up", async () => {
    const root = await gitRepo();
    await expect(sandboxFor(config({ isolation: "none", worktree: { setup: ["pnpm install"] } }), root))
      .rejects.toThrow(/agent\.isolation: worktree/);
    expect(await sandboxFor(config({ isolation: "none" }), root)).toBeNull();
  });

  it("refuses a setupTimeout that is not a duration, and a key it does not read", () => {
    expect(() => config({ worktree: { setupTimeout: "soon" } })).toThrow(/duration/);
    expect(() => config({ worktree: { setupTimeout: "0m" } })).toThrow(/duration/);
    expect(() => config({ worktree: { install: ["x"] } })).toThrow(/install/);
  });
});

describe("buildWorkspaceRuntime", () => {
  it("refuses to start when the workflow does not validate", async () => {
    const dir = await fixture();
    // Schema-valid and unsound: no entry stage, so nothing can ever begin.
    await writeFile(
      join(workflowIn(dir), "workflow.yaml"),
      "version: 1\nname: broken\ndescription: test\nstages:\n  - id: only\n    triggers: [{ when: { \"run.stage\": null } }]\n",
    );
    await expect(buildWorkspaceRuntime(dir, {})).rejects.toThrow(/does not validate[\s\S]*entry/);
  });

  // `validate` reports it, so `start` refuses it: every item create_item
  // starts there would be skipped as ineligible on the next tick.
  it("refuses a workflow that admits labels its own eligible rule turns away, and still lets status read", async () => {
    const dir = await fixture();
    const yaml = join(workflowIn(dir), "workflow.yaml");
    await writeFile(yaml, (await readFile(yaml, "utf8")).replace("description: test\n",
      'description: test\nadmit: [lr:fast]\neligible:\n  - { when: { "node.state.labels": { $in: ["lr:auto"] } }, else: "no lr:auto label" }\n'));
    await expect(buildWorkspaceRuntime(dir, {})).rejects.toThrow(/admit: workflow "main" admits \[lr:fast\] but its eligible rule "no lr:auto label"/);
    await expect(buildWorkspaceRuntime(dir, { readOnly: true })).rejects.toThrow(/no source hook/);
  });

  /*
   * Every workflow is proved sound before any hook is imported, and the one
   * that is not is named by its folder: two workflows are run together now,
   * so "the workflow" no longer says which file to open.
   */
  it("names the one of two workflows that does not validate, for start and for status alike", async () => {
    const dir = await fixture();
    await workspaceOf({ fastlane: "tests/fixtures/minimal" }, dir);
    await writeFile(
      join(workflowIn(dir, "fastlane"), "workflow.yaml"),
      "version: 1\nname: broken\ndescription: test\nstages:\n  - id: only\n    triggers: [{ when: { \"run.stage\": null } }]\n",
    );
    await expect(buildWorkspaceRuntime(dir, {})).rejects.toThrow(/does not validate[\s\S]*workflows\/fastlane: .*entry/);
    await expect(buildWorkspaceRuntime(dir, { readOnly: true })).rejects.toThrow(/workflows\/fastlane: .*entry/);
  });

  // Matched on the missing-secret wording, not just the name: an unresolved
  // secret is also absent from the redaction map, so `log.redact` would refuse
  // it a line later — and a test that accepted either message would pass with
  // this check deleted.
  it("refuses to start when a secret does not resolve", async () => {
    const dir = await fixture();
    await writeFile(join(dir, ".env"), "\n");
    await expect(buildWorkspaceRuntime(dir, {})).rejects.toThrow(/secret "githubToken" does not resolve/);
  });

  /**
   * The redaction rule the operator believes they have. A `log.redact` entry
   * naming no secret matches nothing, and a logger that quietly redacts
   * nothing is worse than none: the operator reads the config, sees the name,
   * and trusts the log. Startup is the only place this can still be caught.
   */
  it("refuses to start when log.redact names a secret nothing declares", async () => {
    await expect(buildWorkspaceRuntime(await fixture({ log: "slackToken" }), {})).rejects.toThrow(/slackToken/);
  });

  it("refuses to start when a redacted secret is too short to redact by", async () => {
    const dir = await fixture();
    await writeFile(join(dir, ".env"), "LR_TEST_TOKEN=x\n");
    await expect(buildWorkspaceRuntime(dir, {})).rejects.toThrow(/githubToken/);
  });

  it("refuses a notify.via no loaded notifier answers to, naming what is registered", async () => {
    const dir = await fixture({ extra: "notify: { on: [needs-you], via: [slack] }\n" });
    await expect(buildWorkspaceRuntime(dir, {})).rejects.toThrow('notify.via names "slack", which no notifier registers: the loaded hooks register none');
  });

  it("refuses a notify block naming an event there is none of, saying where", async () => {
    const dir = await fixture({ extra: "notify: { on: [done], via: [slack] }\n" });
    await expect(buildWorkspaceRuntime(dir, {})).rejects.toThrow(/landrace\.yaml: notify\.on\.0: .*"needs-you"/);
  });

  it("refuses to start when no hook module provides a source to enumerate", async () => {
    await expect(buildWorkspaceRuntime(await fixture(), {})).rejects.toThrow(/source/);
  });

  /*
   * A var is substituted into the workflow before anything validates it, so an
   * unresolved one is not a value that is merely absent — it is a graph filled
   * in with nothing, and a predicate filled in with nothing matches no item.
   * The daemon finds that out as a repository where nothing ever happens.
   */
  it("refuses to start when a var does not resolve", async () => {
    const dir = await fixture({ extra: "vars: { assignee: $LR_TEST_NOBODY }\n" });
    await expect(buildWorkspaceRuntime(dir, {})).rejects.toThrow(/assignee[\s\S]*does not resolve/);
  });

  /**
   * And refuses a var holding a secret. The log redacts by value and knows
   * only the values `secrets` declares; a var reaches a comment body, an
   * agent's prompt and the events that record both, with nothing suppressing
   * it — so the same string under two names is one of them printed in the
   * clear.
   */
  it("refuses to start when a var resolves to a value a secret also holds", async () => {
    const dir = await fixture({ extra: "vars: { leaked: $LR_TEST_TOKEN }\n" });
    await expect(buildWorkspaceRuntime(dir, {})).rejects.toThrow(/leaked[\s\S]*secret/);
  });

  it("refuses an --otel key it does not read", async () => {
    await expect(buildWorkspaceRuntime(await fixture(), { otel: ["OTEL_TRACES_EXPORTER=otlp"] })).rejects.toThrow(/--otel OTEL_TRACES_EXPORTER/);
  });

  it("refuses grpc from .env rather than downgrading it", async () => {
    const dir = await fixture();
    await writeFile(join(dir, ".env"), `LR_TEST_TOKEN=${TOKEN}\nLANDRACE_ENABLE_TELEMETRY=1\nOTEL_EXPORTER_OTLP_PROTOCOL=grpc\n`);
    await expect(buildWorkspaceRuntime(dir, {})).rejects.toThrow(/grpc is not supported/);
  });

  // In order: the second proves the counter sees a load, so the first's zero
  // means the SDK was never loaded rather than that the mock missed it.
  it("never loads the OpenTelemetry SDK with telemetry off", async () => {
    await expect(buildWorkspaceRuntime(await fixture(), {})).rejects.toThrow(/source/);
    expect(mockSdkLoads).toBe(0);
  });

  it("loads it once telemetry is on", async () => {
    await expect(buildWorkspaceRuntime(await fixture(), { otel: ["LANDRACE_ENABLE_TELEMETRY=1", "OTEL_LOGS_EXPORTER=console"] }))
      .rejects.toThrow(/source/);
    expect(mockSdkLoads).toBe(1);
  });
});

/**
 * Screening is the engine's (§15), and which executor answers for it is the
 * operator's: `security.adapter`, else `agent.adapter`. The model is theirs
 * too, and has no default — a model name is a provider's word, and the
 * engine names no provider.
 */
describe("which executor screens", () => {
  const empty: Registry = {
    preflights: [], pre: [], post: [], artifacts: [], source: null, operator: null, executors: new Map(), notifiers: new Map(),
  };
  const ctx = (): ExecutorContext => ({
    config: runtimeConfigSchema.parse({ version: 1, agent: { adapter: "fake" } }),
    secrets: new Map(), signal: new AbortController().signal, log: () => {}, dir: ".", redact: () => {},
  });
  const plain = (id: string): Registry => ({
    ...empty, executors: new Map([[id, defineExecutor({ id, run: async () => ({ text: "", sessionId: null }) })]]),
  });

  it("screens with the executor agent.adapter names, asking it for security.model", async () => {
    const registry = plain("fake");
    const config = runtimeConfigSchema.parse({ version: 1, agent: { adapter: "fake" }, security: { model: "small" } });
    expect(await screenerFor(config, registry, ctx())).toEqual({ executor: registry.executors.get("fake"), model: "small" });
  });

  it("names no model when security.model names none, so the executor's own default decides", async () => {
    const config = runtimeConfigSchema.parse({ version: 1, agent: { adapter: "fake" } });
    expect((await screenerFor(config, plain("fake"), ctx()))?.model).toBeUndefined();
  });

  it("screens with security.adapter's executor while the steps stay on agent.adapter", async () => {
    const registry: Registry = { ...empty, executors: new Map([...plain("local").executors, ...plain("fake").executors]) };
    const config = runtimeConfigSchema.parse({ version: 1, agent: { adapter: "fake" }, security: { adapter: "local" } });
    expect((await screenerFor(config, registry, ctx()))?.executor).toBe(registry.executors.get("local"));
    expect((await executorFor(config, registry, ctx())).id).toBe("fake");
  });

  it("refuses an adapter no executor answers to, naming the key and the ids it could have used", async () => {
    const config = runtimeConfigSchema.parse({ version: 1, agent: { adapter: "fake" }, security: { adapter: "gpt-9" } });
    await expect(screenerFor(config, plain("fake"), ctx())).rejects.toThrow(/security\.adapter "gpt-9"[\s\S]*"fake"/);
  });

  it("builds no screener when screening is off", async () => {
    const config = runtimeConfigSchema.parse({ version: 1, agent: { adapter: "gpt-9" }, security: { screen: false } });
    expect(await screenerFor(config, empty, ctx())).toBeUndefined();
  });

  /*
   * A factory builds its executor from the runtime's context: its settings,
   * its log, and the secrets it must keep out of that log. Built once per
   * context, so a runtime whose steps and screener name the same executor
   * reads its settings, and registers its secrets, once.
   */
  it("builds a factory's executor once per context, however many roles name it", async () => {
    let made = 0;
    const factory = defineExecutor({
      id: "made",
      create: async () => { made += 1; return { run: async () => ({ text: "", sessionId: null }) }; },
    });
    const registry: Registry = { ...empty, executors: new Map([["made", factory]]) };
    const config = runtimeConfigSchema.parse({ version: 1, agent: { adapter: "made" } });
    const shared = ctx();
    const step = await executorFor(config, registry, shared);
    const screener = await screenerFor(config, registry, shared);
    expect(made).toBe(1);
    expect(screener?.executor).toBe(step);
    expect(step.id).toBe("made");
  });

  it("says which executor could not start, and why", async () => {
    const factory = defineExecutor({ id: "made", create: async () => { throw new Error("agent.mcp names nothing it can find"); } });
    const registry: Registry = { ...empty, executors: new Map([["made", factory]]) };
    const config = runtimeConfigSchema.parse({ version: 1, agent: { adapter: "made" } });
    await expect(executorFor(config, registry, ctx())).rejects.toThrow(/executor "made" could not start: agent\.mcp names nothing it can find/);
  });

  /*
   * A hook is JavaScript by the time it runs, and the type says nothing then.
   * Without this, a factory that forgot to return its executor started the
   * loop, and the first paid tick met "run is not a function" on an item it
   * had already moved.
   */
  it.each([
    ["an object with no run", {}],
    ["nothing", undefined],
    ["a run that is not a function", { run: "claude -p" }],
  ])("refuses at startup a factory that resolves %s", async (_, made) => {
    const factory = defineExecutor({ id: "made", create: async () => made as unknown as Pick<Executor, "run"> });
    const registry: Registry = { ...empty, executors: new Map([["made", factory]]) };
    const config = runtimeConfigSchema.parse({ version: 1, agent: { adapter: "made" } });
    await expect(executorFor(config, registry, ctx()))
      .rejects.toThrow('executor "made" could not start: its factory returned no run function');
  });

  // Pairing is offered only where the executor can hand a session over, so a
  // factory's `handoff` has to survive being built — and one it did not
  // return must not appear from nowhere.
  it("carries a factory's handoff, and adds none it did not build", async () => {
    const handoff: NonNullable<Executor["handoff"]> = async (o) => ({ argv: ["agent"], cwd: o.cwd });
    const run: Executor["run"] = async () => ({ text: "", sessionId: null });
    const config = runtimeConfigSchema.parse({ version: 1, agent: { adapter: "made" } });
    const withIt: Registry = { ...empty, executors: new Map([["made", defineExecutor({ id: "made", create: async () => ({ run, handoff }) })]]) };
    const without: Registry = { ...empty, executors: new Map([["made", defineExecutor({ id: "made", create: async () => ({ run }) })]]) };
    expect((await executorFor(config, withIt, ctx())).handoff).toBe(handoff);
    expect(await executorFor(config, without, ctx())).not.toHaveProperty("handoff");
  });
});

/**
 * The loop's item server is this very process started again as `landrace
 * mcp`, pointed at an absolute workspace directory: the agent runs in a
 * worktree, so a relative one would resolve somewhere else entirely.
 */
describe("the item server an items:create step is handed", () => {
  it("is this process started again as `landrace mcp` on the absolute workspace directory", () => {
    expect(childServerCommand("relative/.landrace", "main")).toEqual({
      command: process.execPath,
      args: [...process.execArgv, process.argv[1], "mcp", "--workspace", resolve("relative/.landrace"), "--workflow", "main"],
    });
  });
});

describe("createInterrupt", () => {
  it("asks the work in flight to stop, and says so", () => {
    const said: string[] = [];
    const stop = new AbortController();
    createInterrupt({ stop, say: (l) => said.push(l), exit: () => {} })();

    expect(stop.signal.aborted).toBe(true);
    // What the line has to carry, whatever the wording: the locks are being
    // let go, and there is a way to stop waiting for that.
    expect(said.join(" ")).toMatch(/lock/i);
    expect(said.join(" ")).toMatch(/again/i);
  });

  /**
   * The case the guard exists for: an operator who pressed Ctrl-C once,
   * watched a ten-minute agent keep running and pressed it again. A second
   * abort of an already-aborted controller does nothing at all, so without
   * this the terminal is wedged until the step's own timeout.
   */
  it("exits on the second interrupt rather than aborting an aborted controller again", () => {
    const said: string[] = [];
    const codes: number[] = [];
    const interrupt = createInterrupt({
      stop: new AbortController(),
      say: (l) => said.push(l),
      exit: (c) => codes.push(c),
    });

    interrupt();
    expect(codes).toEqual([]);
    interrupt();

    expect(codes).toEqual([130]);
    expect(said).toHaveLength(2);
    expect(said[1]).toMatch(/now/i);
  });
});

describe("boardSink", () => {
  /**
   * A display must never be able to stop the work it displays: the sink is
   * called from inside runStep outside any try (see the comment on it in
   * runStart), so a throwing observe would otherwise abort an agent step
   * mid-run. Deleting the sink's own try/catch made all 361 other cli/ui/
   * runner tests still pass, which is exactly the gap this closes.
   */
  it("lets print still receive the event when the board's observe throws, and reports via console.error", () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation();
    try {
      const printed: LandraceEvent[] = [];
      const board: { current?: Board } = {
        current: {
          observe: () => { throw new Error("display broke"); },
          list: () => {},
          ownerOf: (item) => ({ refused: `#${item} is not listed` }),
          readerOf: (item) => ({ refused: `#${item} is not listed` }),
          view: async () => ({ generatedAt: 0, rows: [], nextTickAt: null, folder: "f", workspace: "/w", workflows: [], needsYou: 0, listed: true }),
        },
      };
      const sink = boardSink((e) => printed.push(e), board);
      const event: LandraceEvent = { name: "step.started", item: "1" };

      expect(() => sink(event)).not.toThrow();
      expect(printed).toEqual([event]);
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(String(consoleErrorSpy.mock.calls[0]?.[0])).toMatch(/display broke/);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("still hands the event to both print and a board whose observe behaves", () => {
    const printed: LandraceEvent[] = [];
    const observed: LandraceEvent[] = [];
    const board: { current?: Board } = {
      current: {
        observe: (e) => { observed.push(e); },
        list: () => {},
        ownerOf: (item) => ({ refused: `#${item} is not listed` }),
        readerOf: (item) => ({ refused: `#${item} is not listed` }),
        view: async () => ({ generatedAt: 0, rows: [], nextTickAt: null, folder: "f", workspace: "/w", workflows: [], needsYou: 0, listed: true }),
      },
    };
    const event: LandraceEvent = { name: "step.finished", item: "1" };

    boardSink((e) => printed.push(e), board)(event);

    expect(printed).toEqual([event]);
    expect(observed).toEqual([event]);
  });
});

describe("parsePort", () => {
  it.each(["1", "4545", "65535"])("accepts %s", (p) => expect(parsePort(p)).toBe(Number(p)));
  it.each(["0", "65536", "-1", "80.5", "abc", ""])("refuses %s, naming the flag", (p) => {
    expect(() => parsePort(p)).toThrow(/--ui-port/);
  });
});

describe("browserCommand", () => {
  const url = "http://127.0.0.1:4545/";
  it("is open on macOS", () => expect(browserCommand("darwin", url)).toEqual({ command: "open", args: [url] }));
  it.each(["linux", "freebsd", "openbsd"] as const)("is xdg-open on %s", (platform) => {
    expect(browserCommand(platform, url)).toEqual({ command: "xdg-open", args: [url] });
  });
  // `start`'s first quoted argument is the window title, so an empty one keeps the URL from being taken for it.
  it("is cmd /c start on Windows, with an empty title", () => {
    expect(browserCommand("win32", url)).toEqual({ command: "cmd", args: ["/c", "start", "", url] });
  });
});

describe("openBoard", () => {
  const url = "http://127.0.0.1:4545/";
  let said: string[];
  let spy: jest.SpyInstance;
  beforeEach(() => {
    said = [];
    spy = jest.spyOn(console, "error").mockImplementation((line: unknown) => { said.push(String(line)); });
  });
  afterEach(() => spy.mockRestore());
  const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

  it("opens the URL once in a terminal", async () => {
    const open = jest.fn(async () => {});
    openBoard(url, { interactive: true, open });
    await settle();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(url);
    expect(said).toEqual([]);
  });

  it("opens nothing when stdout is not a terminal", async () => {
    const open = jest.fn(async () => {});
    openBoard(url, { interactive: false, open });
    await settle();
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    ["throws", (): Promise<void> => { throw new Error("spawn xdg-open ENOENT"); }],
    ["reports an error", (): Promise<void> => Promise.reject(new Error("xdg-open exited with 3"))],
  ])("returns, and says where the board is, when the opener %s", async (_, open) => {
    expect(() => openBoard(url, { interactive: true, open })).not.toThrow();
    await settle();
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^landrace: could not open a browser \((spawn xdg-open ENOENT|xdg-open exited with 3)\); the board is at http:\/\/127\.0\.0\.1:4545\/$/);
  });
});

describe("the start command line", () => {
  const parsed = async (...argv: string[]): Promise<{ dir: string; opts: StartOptions }> => {
    const run = jest.fn<Promise<void>, [string, StartOptions]>(async () => {});
    await startCommand(run).parseAsync(argv, { from: "user" });
    expect(run).toHaveBeenCalledTimes(1);
    const [dir, opts] = run.mock.calls[0] ?? [];
    if (dir === undefined || opts === undefined) throw new Error("runStart was not reached");
    return { dir, opts };
  };

  it("serves the board by default", async () => {
    expect((await parsed()).opts).toMatchObject({ ui: true, uiPort: 4545 });
  });
  it.each([["--headless"], ["--no-ui"], ["--headless", "--no-ui"]])("serves none with %s", async (...flags) => {
    expect((await parsed(...flags)).opts.ui).toBe(false);
  });
  it("passes the rest through", async () => {
    const { dir, opts } = await parsed("-w", "ws", "--once", "--debug", "--ui-port", "5000", "--telemetry", "--otel", "A=1");
    expect(dir).toBe("ws");
    expect(opts).toEqual({ once: true, debug: true, ui: true, uiPort: 5000, otel: ["A=1", "LANDRACE_ENABLE_TELEMETRY=1"] });
  });
  it("refuses a bad --ui-port as a usage error, naming the flag, and runs nothing", async () => {
    const run = jest.fn(async () => {});
    let said = "";
    const command = startCommand(run).exitOverride().configureOutput({ writeErr: (text) => { said += text; } });
    await expect(command.parseAsync(["--ui-port", "0"], { from: "user" })).rejects.toThrow(/--ui-port must be a whole number/);
    expect(said).toMatch(/--ui-port must be a whole number from 1 to 65535, got "0"/);
    expect(run).not.toHaveBeenCalled();
  });
  it("lists --headless in its help", () => {
    expect(startCommand(async () => {}).helpInformation()).toMatch(/--headless/);
  });
});

describe("repoWorkspace", () => {
  it("reports the repository's own top-level directory and its name, from a subdirectory", async () => {
    // Reuses this checkout rather than a fixture repo: repositoryRoot's own
    // behaviour is already pinned by tests/agent/worktree.test.ts, so this
    // only needs to prove repoWorkspace calls it and derives `folder`
    // from what it returns.
    const { folder, workspace } = await repoWorkspace(process.cwd());
    expect(workspace.endsWith(folder)).toBe(true);
    expect(workspace).not.toContain("\n");
  });

  it("falls back to process.cwd() outside a repository, rather than refusing", async () => {
    const plain = await mkdtemp(join(tmpdir(), "lr-plain-workspace-"));
    const { folder, workspace } = await repoWorkspace(plain);
    expect(workspace).toBe(process.cwd());
    expect(folder).toBe(process.cwd().split("/").pop());
  });
});

// Starts a real server on 127.0.0.1: skipped only where a sandbox forbids that.
describeLoopback("startUi", () => {
  const board = () =>
    createBoard({ workflows: [{ id: "main", workflow: { version: 1, name: "t", description: "test", stages: [] } }], held: async () => null, folder: "f", workspace: "/w", nest: [] });

  it("serves nothing with --headless", async () => {
    expect(await startUi({ board: board(), ui: false, once: false, port: 0 })).toBeNull();
  });

  it("serves nothing for --once, which has nobody to watch it", async () => {
    expect(await startUi({ board: board(), ui: true, once: true, port: 0 })).toBeNull();
  });

  it("serves the board otherwise", async () => {
    const ui = await startUi({ board: board(), ui: true, once: false, port: 0 });
    expect(ui?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    await ui?.close();
  });

  it("refuses a taken port, naming both ways out", async () => {
    const squatter = createServer();
    await new Promise<void>((r) => squatter.listen(0, "127.0.0.1", r));
    const port = (squatter.address() as { port: number }).port;
    try {
      await expect(startUi({ board: board(), ui: true, once: false, port })).rejects.toThrow(/--ui-port.*--headless|--headless.*--ui-port/);
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()));
    }
  });

  describe("opening the board in a browser", () => {
    let said: string[];
    let spy: jest.SpyInstance;
    beforeEach(() => {
      said = [];
      spy = jest.spyOn(console, "error").mockImplementation((line: unknown) => { said.push(String(line)); });
    });
    afterEach(() => spy.mockRestore());
    // What the opener's failure prints is said after a turn of the loop, never before startUi returns.
    const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

    it("opens the served board's URL once, when run in a terminal", async () => {
      const open = jest.fn(async () => {});
      const ui = await startUi({ board: board(), ui: true, once: false, port: 0, interactive: true, open });
      try {
        await settle();
        expect(open).toHaveBeenCalledTimes(1);
        expect(open).toHaveBeenCalledWith(ui?.url);
        expect(said).toEqual([]);
      } finally {
        await ui?.close();
      }
    });

    it("opens nothing with --headless, --once, or when stdout is not a terminal", async () => {
      const open = jest.fn(async () => {});
      expect(await startUi({ board: board(), ui: false, once: false, port: 0, interactive: true, open })).toBeNull();
      expect(await startUi({ board: board(), ui: true, once: true, port: 0, interactive: true, open })).toBeNull();
      const ui = await startUi({ board: board(), ui: true, once: false, port: 0, interactive: false, open });
      try {
        // Not a terminal still serves the board: only the browser is skipped.
        expect(ui?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
        await settle();
        expect(open).not.toHaveBeenCalled();
      } finally {
        await ui?.close();
      }
    });

    it.each([
      ["throws", (): Promise<void> => { throw new Error("spawn xdg-open ENOENT"); }],
      ["reports an error", (): Promise<void> => Promise.reject(new Error("spawn xdg-open ENOENT"))],
    ])("keeps the start running when the opener %s, and says where the board is", async (_, open) => {
      const ui = await startUi({ board: board(), ui: true, once: false, port: 0, interactive: true, open });
      try {
        expect(ui?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
        await settle();
        expect(said).toEqual([`landrace: could not open a browser (spawn xdg-open ENOENT); the board is at ${ui?.url}`]);
      } finally {
        await ui?.close();
      }
    });
  });

  /**
   * The wiring itself: startUi is the one place a caller's `tick` reaches
   * serveBoard, so this is what stands between the schedule's own wake and
   * a working POST /tick — proven with a real request rather than a spy on
   * serveBoard, since a mocked call site is exactly the kind of "looks right"
   * this codebase's testing rule warns against.
   */
  it("passes tick through to serveBoard, so POST /tick reaches it", async () => {
    const tick = jest.fn((): WakeResult => "started");
    const ui = await startUi({ board: board(), ui: true, once: false, port: 0, tick });
    try {
      const res = await fetch(`http://127.0.0.1:${ui?.port}/tick`, {
        method: "POST",
        headers: { "x-landrace-action": "tick", origin: `http://127.0.0.1:${ui?.port}` },
      });
      expect(res.status).toBe(202);
      expect(tick).toHaveBeenCalledTimes(1);
    } finally {
      await ui?.close();
    }
  });

  it("without tick, POST /tick is 404 even though the page is served", async () => {
    const ui = await startUi({ board: board(), ui: true, once: false, port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${ui?.port}/tick`, {
        method: "POST",
        headers: { "x-landrace-action": "tick" },
      });
      expect(res.status).toBe(404);
    } finally {
      await ui?.close();
    }
  });

  /**
   * The wiring itself: startUi is the one place a caller's `goto` reaches
   * serveBoard, so this is what stands between `gotoFor` and a working POST
   * /items/<id>/goto/<stage> — proven with a real request rather than a
   * spy on serveBoard. Deleting `opts.goto` from `startUi`'s call to
   * `serveBoard` would leave every other test in this file green while
   * Retry and "Go to step…" quietly 404; this is what catches that.
   */
  it("passes goto through to serveBoard, so POST /items/<id>/goto/<stage> reaches it", async () => {
    const calls: Array<[string, string | null]> = [];
    const ui = await startUi({
      board: board(), ui: true, once: false, port: 0,
      goto: { send: async (t, s) => { calls.push([t, s]); return { to: "spec" }; } },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${ui?.port}/items/19/goto/spec`, {
        method: "POST",
        headers: { "x-landrace-action": "goto", origin: `http://127.0.0.1:${ui?.port}` },
      });
      expect(res.status).toBe(202);
      expect(calls).toEqual([["19", "spec"]]);
    } finally {
      await ui?.close();
    }
  });

  /**
   * The wiring itself: startUi is the one place a caller's `refresh` reaches
   * serveBoard, so this is what stands between it and a working POST
   * /refresh — proven with a real request rather than a spy on serveBoard.
   */
  it("passes refresh through to serveBoard, so POST /refresh reaches it", async () => {
    const refresh = jest.fn(async () => {});
    const ui = await startUi({ board: board(), ui: true, once: false, port: 0, refresh });
    try {
      const res = await fetch(`http://127.0.0.1:${ui?.port}/refresh`, {
        method: "POST",
        headers: { "x-landrace-action": "refresh", origin: `http://127.0.0.1:${ui?.port}` },
      });
      expect(res.status).toBe(200);
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      await ui?.close();
    }
  });

  /** The same wiring for the item panel: deleting `opts.panel` from startUi would 404 every panel route. */
  it("passes the panel through to serveBoard, so POST /items/<id>/reply reaches it", async () => {
    const replies: Array<[string, string]> = [];
    const panel = {
      activity: async () => ({ stage: null, round: null, lines: [], total: 0 }),
      conversation: async () => [],
      reply: async (t: string, m: string) => { replies.push([t, m]); },
      ask: async () => ({ reply: "", resolved: false }),
      resolve: async () => ({ alreadyResolved: false }),
      pairing: async () => ({ open: null, offers: [] }),
      pair: async () => { throw new Error("not paired here"); },
      finish: async () => { throw new Error("not paired here"); },
      release: async () => { throw new Error("not paired here"); },
    };
    const ui = await startUi({ board: board(), ui: true, once: false, port: 0, panel });
    try {
      const res = await fetch(`http://127.0.0.1:${ui?.port}/items/19/reply`, {
        method: "POST",
        headers: { "x-landrace-action": "reply", origin: `http://127.0.0.1:${ui?.port}` },
        body: "B2B only",
      });
      expect(res.status).toBe(200);
      expect(replies).toEqual([["19", "B2B only"]]);
    } finally {
      await ui?.close();
    }
  });

  it("without refresh, POST /refresh is 404 even though the page is served", async () => {
    const ui = await startUi({ board: board(), ui: true, once: false, port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${ui?.port}/refresh`, {
        method: "POST",
        headers: { "x-landrace-action": "refresh" },
      });
      expect(res.status).toBe(404);
    } finally {
      await ui?.close();
    }
  });
});

const WF: Workflow = { version: 1, name: "t", description: "test", stages: [
  { id: "spec", entry: true, step: "steps/spec.md",
    on_enter: [{ type: "tracker.comment", kind: "enter", marker: "enter:{stage}:{round}" }],
    triggers: [{ when: { "run.stage": null } }] },
  { id: "blocked", goto: ["spec"], triggers: [{ when: { "run.lastOutputValid": false } }] },
] };

describe("the page's Retry and Go to step", () => {
  it("is absent when no hook can write a record", () => {
    const tracker = createFakeTracker([]);
    expect(gotoFor({ source: tracker.registry.source as Source, pre: [], dispatcher: createDispatcher([]), ctx: tracker.ctx, workflow: WF })).toBeUndefined();
  });

  it("sends a stopped item back to the stage that failed", async () => {
    const tracker = createFakeTracker([{ number: 19, labels: ["lr:auto", "lr:stage:blocked", "lr:blocked"] }]);
    tracker.say(19, `entered${renderMarker({ stage: "spec", kind: "enter", round: 1 })}`);
    tracker.say(19, `broken${renderMarker({ stage: "spec", kind: "malformed", round: 1 })}`);
    const source = tracker.registry.source as Source;
    const path = gotoFor({
      source, pre: tracker.registry.pre,
      dispatcher: createDispatcher(tracker.registry.post), ctx: tracker.ctx, workflow: WF,
      lock: { root: await mkdtemp(join(tmpdir(), "lr-start-goto-")) },
    });
    expect(await path?.send("19", null)).toEqual({ to: "spec" });

    // A record the next tick actually reads, not just an answer this call
    // happened to return.
    const snapshot = await buildSnapshot({ item: "19", source, hooks: tracker.registry.pre, workflow: WF, ctx: { ...tracker.ctx, item: "19" } });
    expect(snapshot.run?.goto).toBe("spec");
  });
});

/*
 * The item panel, assembled the way `landrace mcp` assembles a
 * conversation: the tick's own source, pre hooks and dispatcher, so what the
 * page writes is what the next tick re-derives.
 */
describe("the item panel", () => {
  const SPEC: Workflow = { version: 1, name: "t", description: "test", stages: [{ id: "spec", entry: true, step: "spec", triggers: [{ when: { "run.stage": null } }] }] };

  const panelWorld = async (run: Executor["run"] = async () => ({ text: "Understood.\n```json\n{ \"blocking\": false }\n```", sessionId: "sid-2" })) => {
    const tracker = createFakeTracker([{ number: 12, labels: ["lr:auto", "lr:stage:spec", "lr:awaiting"] }]);
    tracker.say(12, `Which markets?${renderMarker({ stage: "spec", kind: "output", round: 1, session: "sid-1" })}`);
    const root = await mkdtemp(join(tmpdir(), "lr-start-panel-"));
    const activity = createActivityLog(root, (t) => t);
    const panel = panelFor({
      source: tracker.registry.source as Source, pre: tracker.registry.pre,
      dispatcher: createDispatcher(tracker.registry.post),
      ctx: { ...tracker.ctx, secrets: new Map([["githubToken", TOKEN]]) },
      executor: defineExecutor({ id: "fake", run }),
      workflow: SPEC, steps: new Map([["spec", { prompt: "write the spec", capabilities: ["repo:read"] }]]),
      lock: { root }, activity,
    });
    return { tracker, panel };
  };

  it("reads the item's conversation, marker off, oldest first", async () => {
    const { panel } = await panelWorld();
    expect(await panel.conversation("12")).toMatchObject([{ by: "landrace", byAgent: true, stage: "spec", round: 1, text: "Which markets?" }]);
  });

  it("posts a reply as a person's turn", async () => {
    const { panel } = await panelWorld();
    await panel.reply("12", "B2B only");
    expect((await panel.conversation("12")).at(-1)).toMatchObject({ byAgent: false, text: "B2B only" });
  });

  it("asks the step, answering inline, with the turn's activity where the page reads it", async () => {
    const { panel } = await panelWorld(async (_p, o) => {
      o.onActivity?.({ kind: "tool", text: "Read spec.md", at: 3 });
      return { text: "Understood.\n```json\n{ \"blocking\": false }\n```", sessionId: "sid-2" };
    });
    expect(await panel.ask("12", "EU only")).toEqual({ reply: "Understood.", resolved: true });
    expect(await panel.activity("12", 0)).toMatchObject({ stage: "spec", round: 1, lines: [{ kind: "tool", text: "Read spec.md" }] });
  });

  it("hands the item back, once", async () => {
    const { panel } = await panelWorld();
    expect(await panel.resolve("12")).toEqual({ alreadyResolved: false });
    expect(await panel.resolve("12")).toEqual({ alreadyResolved: true });
  });

  it("says why a write failed with every secret taken out", async () => {
    const { panel } = await panelWorld(async () => { throw new Error(`agent exited 1: bad token ${TOKEN}`); });
    const failed = await panel.ask("12", "EU only").then(() => null, (e: Error) => e.message);
    expect(failed).toMatch(/agent exited 1/);
    expect(failed).not.toContain(TOKEN);
  });
});

/*
 * An item no one workflow owns is read through its source, with the pre hooks
 * every workflow on that source loads — and not read at all where they share
 * none: a read with none is an empty history said as if it were the item's.
 */
describe("reading an item through its source", () => {
  /** `main` and `fast` on one tracker, each loading what `pres` makes of the tracker's own pre hooks. */
  const readersOf = (pres: (own: Registry["pre"]) => { main: Registry["pre"]; fast: Registry["pre"] }) => {
    const tracker = createFakeTracker([{ number: 4, labels: [] }]);
    tracker.say(4, `Which markets?${renderMarker({ stage: "spec", kind: "output", round: 1 })}`);
    const source = tracker.registry.source as Source;
    const { main, fast } = pres(tracker.registry.pre);
    return sourceReaders([{ id: "main", source, deps: { pre: main } }, { id: "fast", source, deps: { pre: fast } }], tracker.ctx);
  };

  it("reads with the pre hooks both workflows load", async () => {
    const reads = readersOf((own) => ({ main: own, fast: own })).get(0);
    expect(await reads?.conversation("4")).toMatchObject([{ byAgent: true, text: "Which markets?" }]);
  });

  it("refuses, naming the workflows, when they load no pre hook in common", async () => {
    const reads = readersOf((own) => ({ main: own, fast: [{ id: "other", run: () => ({}) }] })).get(0);
    const sentence = "#4 cannot be read here: the workflows reading its source, fast and main, load no pre hook in common, " +
      "and a read with none would leave out what each of them reads";
    await expect(reads?.conversation("4")).rejects.toThrow(sentence);
    await expect(reads?.pairing("4")).rejects.toThrow(sentence);
  });

  it("reads with none where no workflow on the source loads any", async () => {
    expect(await readersOf(() => ({ main: [], fast: [] })).get(0)?.conversation("4")).toEqual([]);
  });
});

/**
 * `loop`'s own orchestration, against a stub Schedule and a bare
 * AbortController rather than a real Runtime — everything else `loop` reads
 * off `rt` is `rt.stop.signal`, so a full Runtime would only pad these tests
 * with fields they never touch.
 *
 * The types already stop `nextAt`/`wake` being swapped at the call site in
 * `runStart`, but nothing short of running `loop` itself catches it forgetting
 * to start the schedule, a schedule left running past stop, or an in-flight
 * tick being abandoned rather than waited out — and that last one is the lock
 * a stray Ctrl-C would otherwise leave held.
 */
describe("loop", () => {
  const fakeRuntime = (stop: AbortController): { stop: AbortController } => ({ stop });

  it("starts the schedule, stops it once asked to stop, and calls nothing further", async () => {
    const schedule: Schedule = {
      start: jest.fn(),
      stop: jest.fn(),
      nextAt: () => null,
      wake: jest.fn((): WakeResult => "started"),
    };
    const stop = new AbortController();
    stop.abort(); // already stopping before loop even starts waiting

    await loop(fakeRuntime(stop), schedule, new Set());

    expect(schedule.start).toHaveBeenCalledTimes(1);
    expect(schedule.stop).toHaveBeenCalledTimes(1);
    expect(schedule.wake).not.toHaveBeenCalled();
  });

  it("does not resolve until a tick already in flight finishes, even after the schedule is stopped", async () => {
    const order: string[] = [];
    const schedule: Schedule = {
      start: () => order.push("start"),
      stop: () => order.push("stop"),
      nextAt: () => null,
      wake: () => "started",
    };
    const stop = new AbortController();
    const inFlight = new Set<Promise<void>>();
    let resolveManual: () => void = () => {};
    inFlight.add(new Promise<void>((resolve) => { resolveManual = resolve; }));

    stop.abort();
    let resolved = false;
    const p = loop(fakeRuntime(stop), schedule, inFlight).then(() => { resolved = true; });

    // Let the abort-signal microtasks settle: schedule.stop() has already
    // run, but the item still holding its lock has not, so loop must not
    // have resolved — resolving here is exactly the "released the lock
    // before the work was done" bug this guards.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(order).toEqual(["start", "stop"]);
    expect(resolved).toBe(false);

    resolveManual();
    await p;
    expect(resolved).toBe(true);
  });
});
