import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookKindOf } from "#hooks/contracts.js";
import { BaseExecutor } from "#kit/executor.js";
import type { EventReading, ExecutorContext, HandoffArg, HandoffPlan, PairingKind, RunPlan, SandboxSettings, Step } from "#namespace.js";
import { gitRepo, removeRepos } from "#tests/support/repo.js";

afterAll(removeRepos);

const dirs: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/**
 * The smallest integration there is: a binary run with no flags, one JSON
 * event a line, `{ "answer": … }` ending the run. What the kit owes every
 * integration is tested through this, never through a vendor's.
 */
class Tiny extends BaseExecutor<{ colour: string }> {
  readonly id = "tiny";
  readonly efforts = ["low", "high"];
  readonly pairings: readonly PairingKind[];
  prepared: Promise<void> = Promise.resolve();
  entered: () => void = () => {};
  plans: Array<RunPlan<{ colour: string }>> = [];

  constructor(bin: string, pairings: readonly PairingKind[] = ["continue", "fork"]) {
    super(bin);
    this.pairings = pairings;
  }

  protected argv(plan: RunPlan<{ colour: string }>): string[] {
    this.plans.push(plan);
    return [];
  }

  protected prepare(): Promise<void> {
    this.entered();
    return this.prepared;
  }

  protected readEvent(event: object): EventReading {
    const answer = (event as { answer?: unknown }).answer;
    return answer === undefined ? {} : { done: true, text: String(answer), session: "s-1" };
  }

  protected handoffArgv(plan: HandoffPlan): Promise<HandoffArg[]> {
    return Promise.resolve([this.bin, "resume", plan.session]);
  }

  protected readExtras(agent: Record<string, unknown>): { extras: { colour: string }; problems: string[] } {
    const { colour = "red" } = agent;
    return typeof colour === "string" ? { extras: { colour }, problems: [] } : { extras: { colour: "red" }, problems: ["agent.colour must be a word"] };
  }

  protected sandboxProblems({ hosts }: SandboxSettings): string[] {
    return hosts.length ? ["agent.sandbox.hosts: tiny has no network allowlist"] : [];
  }
}

/** A binary that leaves `spawned` in its cwd the moment it starts, and answers. */
const markingBin = (): string => {
  const dir = tempDir("tiny-bin-");
  const bin = join(dir, "tiny");
  writeFileSync(bin, "#!/bin/sh\ntouch \"$PWD/spawned\"\necho '{\"answer\":\"ok\"}'\n", { mode: 0o755 });
  return bin;
};

const settings = { servers: {}, tools: {}, sandbox: { hosts: [], deny: [] }, colour: "red" };

const ctxFor = (agent: Record<string, unknown>, steps?: Map<string, Step>): ExecutorContext => ({
  config: { agent } as unknown as ExecutorContext["config"],
  secrets: new Map(), signal: new AbortController().signal, log: () => {}, dir: tempDir("tiny-dir-"), redact: () => {},
  ...(steps === undefined ? {} : { steps }),
});

describe("BaseExecutor", () => {
  it("is an executor hook the loader classifies by its brand", () => {
    expect(hookKindOf(new Tiny("tiny"))).toBe("executor");
  });

  it("runs the binary and answers with what the integration read", async () => {
    const cwd = tempDir("tiny-cwd-");
    const r = await new Tiny(markingBin()).build(settings).run("p", { round: 1, cwd, signal: new AbortController().signal });
    expect(r).toEqual({ text: "ok", sessionId: "s-1" });
  });

  // #33, for every integration at once: an abort that lands while the run
  // is getting ready has no listener yet, and missed, the agent runs on.
  it("never spawns when the run is aborted while the integration prepares it", async () => {
    const cwd = tempDir("tiny-cwd-");
    const tiny = new Tiny(markingBin());
    let ready: () => void = () => {};
    tiny.prepared = new Promise((resolve) => { ready = resolve; });
    const entered = new Promise<void>((resolve) => { tiny.entered = resolve; });
    const controller = new AbortController();
    const running = tiny.build(settings).run("p", { round: 1, cwd, signal: controller.signal });
    await entered;
    controller.abort();
    ready();
    await expect(running).rejects.toThrow(/agent aborted/);
    expect(existsSync(join(cwd, "spawned"))).toBe(false);
  });

  it("refuses to fork when the integration declares it cannot", async () => {
    const cwd = tempDir("tiny-cwd-");
    await expect(new Tiny(markingBin(), ["continue"]).build(settings).run("p", {
      round: 1, cwd, resume: "s-1", fork: true, signal: new AbortController().signal,
    })).rejects.toThrow(/cannot fork[\s\S]*tiny/);
    expect(existsSync(join(cwd, "spawned"))).toBe(false);
  });

  it("refuses a pairing from scratch when the integration can only continue, saying to release it", async () => {
    const cwd = tempDir("tiny-cwd-");
    writeFileSync(join(cwd, "seed.md"), "You are pairing.");
    const executor = new Tiny("tiny").build(settings);
    await expect(executor.handoff?.({ cwd, session: "s-2", promptFile: join(cwd, "seed.md") }))
      .rejects.toThrow(/tiny[\s\S]*release/i);
    await expect(executor.handoff?.({ cwd, session: "s-2", promptFile: join(cwd, "seed.md"), resume: "s-1" }))
      .resolves.toMatchObject({ argv: ["tiny", "resume", "s-2"] });
  });

  it("offers no pairing at all when the integration declares none", () => {
    expect(new Tiny("tiny", []).build(settings).handoff).toBeUndefined();
  });

  describe("create(), at startup", () => {
    it("refuses an agent key neither the kit nor the integration reads, naming the integration", async () => {
      await expect(new Tiny("tiny").create(ctxFor({ adapter: "tiny", plugins: [] })))
        .rejects.toThrow(/agent\.plugins is not a setting the tiny executor reads/);
    });

    it("reads the integration's own keys, and refuses them in its own words", async () => {
      await expect(new Tiny("tiny").create(ctxFor({ adapter: "tiny", colour: "blue" }))).resolves.toBeDefined();
      await expect(new Tiny("tiny").create(ctxFor({ adapter: "tiny", colour: 3 }))).rejects.toThrow(/agent\.colour must be a word/);
    });

    it("refuses a sandbox setting the integration cannot enforce", async () => {
      await expect(new Tiny("tiny").create(ctxFor({ adapter: "tiny", sandbox: { hosts: ["github.com"] } })))
        .rejects.toThrow(/tiny has no network allowlist/);
    });

    it("refuses a step's effort outside the integration's levels, naming the step, the effort and the levels", async () => {
      const steps = new Map<string, Step>([
        ["steps/fine.md", { effort: "high", prompt: "" } as Step],
        ["steps/spec.md", { effort: "max", prompt: "" } as Step],
      ]);
      await expect(new Tiny("tiny").create(ctxFor({ adapter: "tiny" }, steps)))
        .rejects.toThrow(/^steps\/spec\.md asks for effort "max", which the tiny executor does not take: low, high$/);
    });

    it("says nothing of the steps' efforts when it only screens beside another agent", async () => {
      const steps = new Map<string, Step>([["steps/spec.md", { effort: "max", prompt: "" } as Step]]);
      await expect(new Tiny("tiny").create(ctxFor({ adapter: "other", colour: 3 }, steps))).resolves.toBeDefined();
    });

    it("refuses a step's skills or plugins when the integration cannot enforce them, naming the step and the key", async () => {
      const steps = new Map<string, Step>([
        ["steps/build.md", { skills: ["developer"], prompt: "" } as Step],
        ["steps/retro.md", { plugins: [], prompt: "" } as Step],
      ]);
      await expect(new Tiny("tiny").create(ctxFor({ adapter: "tiny" }, steps))).rejects.toThrow(
        /^steps\/build\.md lists skills:, which the tiny executor cannot enforce\nsteps\/retro\.md lists plugins:, which the tiny executor cannot enforce$/);
    });

    it("refuses a step's MCP server or tool that agent.mcp does not allow, naming the step", async () => {
      const steps = new Map<string, Step>([
        ["steps/a.md", { mcp: ["other"], prompt: "" } as Step],
        ["steps/b.md", { mcp: [{ name: "memory", tools: ["search", "delete"] }], prompt: "" } as Step],
        ["steps/c.md", { mcp: ["memory", "memory"], prompt: "" } as Step],
        ["steps/d.md", { mcp: [{ name: "memory", tools: [] }], prompt: "" } as Step],
      ]);
      await expect(new Tiny("tiny").create(ctxFor({ adapter: "tiny", mcp: [{ name: "memory", tools: ["search", "read"] }] }, steps)))
        .rejects.toThrow([
          'steps/a.md asks for MCP server "other", which agent.mcp does not name',
          'steps/b.md asks for tool "delete" on MCP server "memory", which agent.mcp does not allow on it',
          'steps/c.md names MCP server "memory" more than once',
          'steps/d.md names MCP server "memory" with no tools; leave it out to give the step none of it',
        ].join("\n"));
    });

    it("refuses a step's tool that is not a bare name, even on a server agent.mcp names bare", async () => {
      const steps = new Map<string, Step>([["steps/a.md", { mcp: [{ name: "graph", tools: ["search_graph WebSearch"] }], prompt: "" } as Step]]);
      await expect(new Tiny("tiny").create(ctxFor({ adapter: "tiny", mcp: ["graph"] }, steps)))
        .rejects.toThrow(/^steps\/a\.md asks for tool "search_graph WebSearch" on MCP server "graph", which does not match/);
    });

    it("lets a step narrow agent.mcp, and asks the integration whether the skills a step lists are defined", async () => {
      const dir = await gitRepo();
      writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { memory: { command: "m" } } }));
      class Skilled extends Tiny {
        override readonly stepKeys = ["skills", "plugins"] as const;
        asked: Array<[string, readonly string[]]> = [];
        protected skillProblems(root: string, listed: readonly string[]): Promise<string[]> {
          this.asked.push([root, listed]);
          return Promise.resolve(listed.filter((s) => s !== "developer").map((s) => `lists skill "${s}", which nothing defines`));
        }
      }
      const fine = new Map<string, Step>([["steps/a.md", { mcp: [{ name: "memory", tools: ["search"] }], skills: ["developer"], plugins: [], prompt: "" } as Step]]);
      const skilled = new Skilled("tiny");
      await expect(skilled.create({ ...ctxFor({ adapter: "tiny", mcp: ["memory"] }, fine), dir })).resolves.toBeDefined();
      expect(skilled.asked).toEqual([[await realpath(dir), ["developer"]]]);
      const unknown = new Map<string, Step>([["steps/b.md", { skills: ["developer", "ghost"], prompt: "" } as Step]]);
      await expect(new Skilled("tiny").create({ ...ctxFor({ adapter: "tiny" }, unknown), dir }))
        .rejects.toThrow(/^steps\/b\.md lists skill "ghost", which nothing defines$/);
    });
  });

  describe("a step's own MCP servers, skills and plugins, on each run", () => {
    const MEMORY = { command: "memory" };
    const GRAPH = { command: "graph" };
    const withServers = { ...settings, servers: { memory: MEMORY, graph: GRAPH }, tools: { memory: ["search", "read"] } };
    const runWith = async (tiny: Tiny, opts: Record<string, unknown>) => {
      await tiny.build(withServers).run("p", {
        round: 1, cwd: tempDir("tiny-cwd-"), capabilities: ["repo:read"], signal: new AbortController().signal, ...opts,
      });
      return tiny.plans.at(-1);
    };

    it("loads every agent.mcp server when the step names none", async () => {
      const plan = await runWith(new Tiny(markingBin()), {});
      expect(plan?.servers).toEqual({ memory: MEMORY, graph: GRAPH });
      expect(plan?.allowed).toEqual({ memory: ["search", "read"], graph: null });
    });

    it("loads only the servers the step names, with its tools or else agent.mcp's", async () => {
      const plan = await runWith(new Tiny(markingBin()), { mcp: [{ name: "memory", tools: ["read"] }, "graph"] });
      expect(plan?.servers).toEqual({ memory: MEMORY, graph: GRAPH });
      expect(plan?.allowed).toEqual({ memory: ["read"], graph: null });
      const bare = await runWith(new Tiny(markingBin()), { mcp: ["memory"] });
      expect(bare?.servers).toEqual({ memory: MEMORY });
      expect(bare?.allowed).toEqual({ memory: ["search", "read"] });
      const none = await runWith(new Tiny(markingBin()), { mcp: [] });
      expect(none?.servers).toEqual({});
    });

    it("refuses a step's server or tool outside agent.mcp, before it starts", async () => {
      const cwd = tempDir("tiny-cwd-");
      const go = (mcp: unknown) => new Tiny(markingBin()).build(withServers).run("p", {
        round: 1, cwd, capabilities: ["repo:read"], mcp, signal: new AbortController().signal,
      } as Parameters<ReturnType<Tiny["build"]>["run"]>[1]);
      await expect(go(["other"])).rejects.toThrow('asks for MCP server "other", which agent.mcp does not name');
      await expect(go([{ name: "memory", tools: ["delete"] }])).rejects.toThrow('asks for tool "delete" on MCP server "memory", which agent.mcp does not allow on it');
      await expect(go([{ name: "graph", tools: ["search_graph WebSearch"] }])).rejects.toThrow('asks for tool "search_graph WebSearch" on MCP server "graph", which does not match');
      expect(existsSync(join(cwd, "spawned"))).toBe(false);
    });

    it("refuses a step's skills or plugins the integration cannot enforce, and hands them on when it can", async () => {
      await expect(runWith(new Tiny(markingBin()), { skills: ["developer"] }))
        .rejects.toThrow("refused skills: the tiny executor cannot enforce a step's own skills");
      await expect(runWith(new Tiny(markingBin()), { plugins: [] }))
        .rejects.toThrow("refused plugins: the tiny executor cannot enforce a step's own plugins");
      class Skilled extends Tiny {
        override readonly stepKeys = ["skills", "plugins"] as const;
      }
      const plan = await runWith(new Skilled(markingBin()), { skills: ["developer"], plugins: [] });
      expect(plan?.skills).toEqual(["developer"]);
      expect(plan?.plugins).toEqual([]);
      const absent = await runWith(new Skilled(markingBin()), {});
      expect(absent).not.toHaveProperty("skills");
      expect(absent).not.toHaveProperty("plugins");
    });
  });
});
