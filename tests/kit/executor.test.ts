import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { hookKindOf } from "#hooks/contracts.js";
import { loadConfig } from "#config/load.js";
import { BaseExecutor, gitIdentityEnv } from "#kit/executor.js";
import type { EventReading, ExecutorContext, HandoffArg, HandoffPlan, PairingKind, RunPlan, SandboxSettings, Step } from "#namespace.js";
import { gitRepo, removeRepos } from "#tests/support/repo.js";
import { frontDoorOrigins } from "#front/hosts.js";

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

/**
 * A binary that leaves `spawned` in its cwd the moment it starts, reads its
 * prompt, and answers. It reads the prompt as a real agent does: one that
 * exited without reading left the executor's write to raise EPIPE whenever
 * the exit won the race, which failed this suite on a loaded CI runner.
 */
const markingBin = (): string => {
  const dir = tempDir("tiny-bin-");
  const bin = join(dir, "tiny");
  writeFileSync(bin, "#!/bin/sh\ntouch \"$PWD/spawned\"\ncat >/dev/null\necho '{\"answer\":\"ok\"}'\n", { mode: 0o755 });
  return bin;
};

const settings = { servers: {}, tools: {}, sandbox: { hosts: [], deny: [] }, colour: "red" };

/** The door a start on serve.port 4600 with a public URL serves, as `start` builds it. */
const DOOR = frontDoorOrigins({ host: "127.0.0.1", publicUrl: "https://board.example.org/" }, 4600);

const ctxFor = (agent: Record<string, unknown>, steps?: Map<string, Step>): ExecutorContext => ({
  config: { agent } as unknown as ExecutorContext["config"],
  secrets: new Map(), signal: new AbortController().signal, log: () => {}, dir: tempDir("tiny-dir-"), redact: () => {},
  frontDoor: DOOR,
  ...(steps === undefined ? {} : { steps }),
});

describe("BaseExecutor", () => {
  it("is an executor hook the loader classifies by its brand", () => {
    expect(hookKindOf(new Tiny("tiny"))).toBe("executor");
  });

  // A prompt past the pipe buffer, so a fake that stops reading its input
  // fails here every time rather than on a slow machine now and then.
  it("runs the binary and answers with what the integration read", async () => {
    const cwd = tempDir("tiny-cwd-");
    const r = await new Tiny(markingBin()).build(settings).run("p".repeat(1 << 20), { round: 1, cwd, signal: new AbortController().signal });
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

  describe("the model and effort a run answers with, for the line that signs its text", () => {
    /** A binary printing these lines, then the answer. */
    const printing = (...lines: object[]): string => {
      const bin = join(tempDir("tiny-model-"), "tiny");
      const said = [...lines, { answer: "ok" }].map((l) => `echo '${JSON.stringify(l)}'`).join("\n");
      writeFileSync(bin, `#!/bin/sh\ncat >/dev/null\n${said}\n`, { mode: 0o755 });
      return bin;
    };
    class Reporting extends Tiny {
      protected override readEvent(event: object): EventReading {
        const e = event as { model?: unknown };
        return "model" in e ? { model: e.model } : super.readEvent(event);
      }
    }
    const go = (bin: string, over: Partial<typeof settings & { model: string; effort: string }> = {}, run: Record<string, unknown> = {}) =>
      new Reporting(bin).build({ ...settings, ...over }).run("p", { round: 1, capabilities: [], signal: new AbortController().signal, ...run });

    it("answers with the model the agent reported, over the one configured", async () => {
      expect(await go(printing({ model: "claude-haiku-4-5-20251001" }), { model: "opus", effort: "low" }))
        .toEqual({ text: "ok", sessionId: "s-1", model: "claude-haiku-4-5-20251001", effort: "low" });
    });

    it("falls back to the step's model, then agent.model, and to none; the step's effort over agent.effort", async () => {
      expect(await go(printing(), { model: "opus", effort: "low" }, { model: "haiku", effort: "high" }))
        .toMatchObject({ model: "haiku", effort: "high" });
      expect(await go(printing(), { model: "opus" })).toMatchObject({ model: "opus" });
      const bare = await go(printing());
      expect(bare).not.toHaveProperty("model");
      expect(bare).not.toHaveProperty("effort");
    });

    it("refuses a run whose agent reported a model that is not a string, as it refuses such a session", async () => {
      await expect(go(printing({ model: 42 }))).rejects.toThrow(/malformed model: expected a string, got number/);
    });
  });

  describe("create(), at startup", () => {
    /*
     * An agent never runs a stage that waits for a pairing alone, so there is
     * never an agent session there to continue or fork: the person has to be
     * able to start one fresh.
     */
    it("refuses a stage that waits for a pairing unless a person can take a fresh session, naming each stage", async () => {
      const waiting = { ...ctxFor({ adapter: "tiny" }), pairingStages: ["design", "plan"] };
      await expect(new Tiny("tiny").create(waiting)).rejects.toThrow(
        /^stages "design", "plan" wait for a pairing, but the tiny executor can only carry on the agent's own session/);
      await expect(new Tiny("tiny", []).create(waiting)).rejects.toThrow(
        /^stages "design", "plan" wait for a pairing, but the tiny executor cannot hand a session to a person/);
      await expect(new Tiny("tiny", ["take"]).create(waiting)).resolves.toBeDefined();
      await expect(new Tiny("tiny").create({ ...waiting, pairingStages: [] })).resolves.toBeDefined();
    });

    it("says nothing of a pairing stage when it only screens beside another agent", async () => {
      await expect(new Tiny("tiny").create({ ...ctxFor({ adapter: "other" }), pairingStages: ["design"] })).resolves.toBeDefined();
    });

    it("reads agent.signature, the engine's own key, without refusing it", async () => {
      await expect(new Tiny("tiny").create(ctxFor({ adapter: "tiny", signature: false }))).resolves.toBeDefined();
    });

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

    describe("the operator's front door, which no step may reach", () => {
      /** Tiny with a network allowlist, so only the door's own refusal is left to say. */
      class Networked extends Tiny {
        protected override sandboxProblems(): string[] {
          return [];
        }
      }

      it.each([
        ["the door's loopback origin", "http://127.0.0.1:4600/mcp"],
        ["its other loopback name", "http://localhost:4600/mcp"],
        ["another loopback address on its port", "http://127.0.0.2:4600/mcp"],
        ["IPv6 loopback on its port", "http://[::1]:4600/"],
        ["its public URL", "https://board.example.org/mcp"],
      ])("refuses an agent.mcp server at %s, whatever it is named", async (_, url) => {
        const dir = await gitRepo();
        writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { tools: { type: "http", url } } }));
        await expect(new Tiny("tiny").create({ ...ctxFor({ adapter: "tiny", mcp: ["tools"] }), dir }))
          .rejects.toThrow(/^mcp: agent\.mcp names "tools", whose URL is landrace's own operator server/);
      });

      it("lets through a server on loopback at another port", async () => {
        const dir = await gitRepo();
        writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { tools: { type: "http", url: "http://127.0.0.1:9999/mcp" } } }));
        await expect(new Tiny("tiny").create({ ...ctxFor({ adapter: "tiny", mcp: ["tools"] }), dir })).resolves.toBeDefined();
      });

      it.each([["127.0.0.1"], ["localhost"], ["board.example.org"], ["*.example.org"]])(
        "refuses agent.sandbox.hosts holding %s, which reaches the door", async (host) => {
          await expect(new Networked("tiny").create(ctxFor({ adapter: "tiny", sandbox: { hosts: ["github.com", host] } })))
            .rejects.toThrow(`agent.sandbox.hosts[1] is "${host}", which reaches landrace's own front door`);
        });

      it("lets through a sandbox host that is not the door's", async () => {
        await expect(new Networked("tiny").create(ctxFor({ adapter: "tiny", sandbox: { hosts: ["github.com", "*.npmjs.org"] } })))
          .resolves.toBeDefined();
      });

      it("hands every run, the screener's too, the door to keep its agent from", async () => {
        const tiny = new Tiny(markingBin());
        const step = await tiny.create(ctxFor({ adapter: "tiny" }));
        await step.run("p", { round: 1, capabilities: [], cwd: tempDir("tiny-cwd-"), signal: new AbortController().signal });
        const screener = await tiny.create(ctxFor({ adapter: "other" }));
        await screener.run("p", { round: 1, cwd: tempDir("tiny-cwd-"), signal: new AbortController().signal });
        expect(tiny.plans.map((p) => p.frontDoor)).toEqual([DOOR, DOOR]);
      });
    });

    it.each([
      ["no email", { name: "landrace" }, /agent\.git\.email must be a non-empty string/],
      ["an empty name", { name: "", email: "bot@example.invalid" }, /agent\.git\.name must be a non-empty string/],
      ["a non-object value", "landrace", /agent\.git must be \{ name, email \}/],
      ["a list", [], /agent\.git must be \{ name, email \}/],
      ["null", null, /agent\.git must be \{ name, email \}/],
      ["an unknown key", { name: "landrace", email: "bot@example.invalid", signingkey: "x" }, /agent\.git\.signingkey is not a setting the tiny executor reads/],
    ])("refuses agent.git with %s, naming which", async (_, git, message) => {
      await expect(new Tiny("tiny").create(ctxFor({ adapter: "tiny", git }))).rejects.toThrow(message);
    });

    it("refuses only the part of agent.git that is wrong", async () => {
      const refused = new Tiny("tiny").create(ctxFor({ adapter: "tiny", git: { name: "landrace" } }));
      await expect(refused).rejects.toThrow(/email/);
      await expect(refused).rejects.not.toThrow(/agent\.git\.name/);
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

/**
 * #173: a step's commits name the configured identity, not whoever the
 * operator's `~/.gitconfig` names. Through `create` and `run`, so the
 * environment is the one the kit hands a real agent, not one built here.
 */
describe("agent.git, the identity an agent commits as", () => {
  const exec = promisify(execFile);
  let home: string;
  const savedHome = process.env.HOME;
  beforeAll(() => {
    home = tempDir("tiny-home-");
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Operator\n\temail = operator@example.com\n");
    process.env.HOME = home;
  });
  afterAll(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  /** A repository with no identity of its own, so only HOME's or the environment's can name one. */
  const bareRepo = async (): Promise<string> => {
    const dir = tempDir("tiny-repo-");
    await exec("git", ["init", "-q", "-b", "main"], { cwd: dir });
    return dir;
  };

  /** A stand-in agent that commits in its cwd, then answers. */
  const committingBin = (): string => {
    const bin = join(tempDir("tiny-bin-"), "tiny");
    writeFileSync(bin, "#!/bin/sh\ncat >/dev/null\ngit commit -q --allow-empty -m step || exit 1\necho '{\"answer\":\"ok\"}'\n", { mode: 0o755 });
    return bin;
  };

  const identities = async (cwd: string): Promise<string> =>
    (await exec("git", ["log", "-1", "--format=%an <%ae> / %cn <%ce>"], { cwd })).stdout.trim();

  const commitAs = async (agent: Record<string, unknown>, capabilities?: string[]): Promise<string> => {
    const cwd = await bareRepo();
    const executor = await new Tiny(committingBin()).create(ctxFor({ adapter: "tiny", ...agent }));
    await executor.run("p", { round: 1, cwd, signal: new AbortController().signal, ...(capabilities ? { capabilities } : {}) });
    return identities(cwd);
  };

  it.each([[["repo:write"]], [["repo:read"]]])("commits as agent.git's name and email, over HOME's .gitconfig, for a %j step", async (capabilities) => {
    await expect(commitAs({ git: { name: "landrace", email: "bot@example.invalid" } }, capabilities))
      .resolves.toBe("landrace <bot@example.invalid> / landrace <bot@example.invalid>");
  });

  it("commits as HOME's .gitconfig names when agent.git is unset", async () => {
    await expect(commitAs({}, ["repo:write"])).resolves.toBe("Operator <operator@example.com> / Operator <operator@example.com>");
  });

  /*
   * #175: values written per instance, as `$VAR` or `${VAR}`, resolved by
   * `loadConfig` from `.env` — never a config built here, so what the agent
   * commits as is what a real `landrace.yaml` and `.env` produce.
   */
  describe("through loadConfig, from .env", () => {
    const loadedWith = async (git: string, env: string) => {
      const dir = tempDir("tiny-cfg-");
      writeFileSync(join(dir, "landrace.yaml"), `version: 1\nagent: { adapter: tiny, git: ${git} }\n`);
      writeFileSync(join(dir, ".env"), env);
      return loadConfig(dir);
    };
    const commitWith = async (git: string, env: string): Promise<string> => {
      const { config } = await loadedWith(git, env);
      const cwd = await bareRepo();
      const ctx = { ...ctxFor({}), config };
      const executor = await new Tiny(committingBin()).create(ctx);
      await executor.run("p", { round: 1, cwd, signal: new AbortController().signal, capabilities: ["repo:write"] });
      return identities(cwd);
    };
    const env = "LANDRACE_GIT_NAME=Dev One\nLANDRACE_GIT_EMAIL=dev1@example.invalid\n";

    it.each([
      ["$VAR", "{ name: $LANDRACE_GIT_NAME, email: $LANDRACE_GIT_EMAIL }"],
      ["${VAR}", '{ name: "${LANDRACE_GIT_NAME}", email: "${LANDRACE_GIT_EMAIL}" }'],
    ])("commits as the values .env gives a %s reference", async (_, git) => {
      await expect(commitWith(git, env)).resolves.toBe("Dev One <dev1@example.invalid> / Dev One <dev1@example.invalid>");
    });

    it("commits as a literal identity, which needs no .env", async () => {
      await expect(commitWith("{ name: landrace, email: bot@example.invalid }", ""))
        .resolves.toBe("landrace <bot@example.invalid> / landrace <bot@example.invalid>");
    });
  });
});

/**
 * #175: a hook that commits from the runner process names the configured
 * identity too, by passing `gitIdentityEnv(ctx)` to its git.
 */
describe("gitIdentityEnv, the identity a hook commits as", () => {
  const exec = promisify(execFile);
  let home: string;
  beforeAll(() => {
    home = tempDir("hook-home-");
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Operator\n\temail = operator@example.com\n");
  });

  const hookCommit = async (agent: Record<string, unknown>): Promise<string> => {
    const cwd = tempDir("hook-repo-");
    const env = { PATH: process.env.PATH ?? "", HOME: home, ...gitIdentityEnv(ctxFor(agent)) };
    await exec("git", ["init", "-q", "-b", "main"], { cwd, env });
    await exec("git", ["commit", "-q", "--allow-empty", "-m", "derived"], { cwd, env });
    return (await exec("git", ["log", "-1", "--format=%an <%ae> / %cn <%ce>"], { cwd, env })).stdout.trim();
  };

  it("commits as agent.git's name and email, over HOME's .gitconfig", async () => {
    await expect(hookCommit({ adapter: "tiny", git: { name: "landrace", email: "bot@example.invalid" } }))
      .resolves.toBe("landrace <bot@example.invalid> / landrace <bot@example.invalid>");
  });

  it("is empty when agent.git is unset, so HOME's .gitconfig names the commit", async () => {
    expect(gitIdentityEnv(ctxFor({ adapter: "tiny" }))).toEqual({});
    await expect(hookCommit({ adapter: "tiny" })).resolves.toBe("Operator <operator@example.com> / Operator <operator@example.com>");
  });

  it("throws readGit's problems for a malformed agent.git, naming each", () => {
    expect(() => gitIdentityEnv(ctxFor({ adapter: "tiny", git: { name: "landrace", colour: "red" } })))
      .toThrow(/agent\.git\.colour is not a setting[\s\S]*agent\.git\.email must be a non-empty string/);
  });
});
