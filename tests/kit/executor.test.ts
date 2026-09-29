import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookKindOf } from "#hooks/contracts.js";
import { BaseExecutor } from "#kit/executor.js";
import type { EventReading, ExecutorContext, HandoffArg, HandoffPlan, PairingKind, SandboxSettings, Step } from "#namespace.js";

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

  constructor(bin: string, pairings: readonly PairingKind[] = ["continue", "fork"]) {
    super(bin);
    this.pairings = pairings;
  }

  protected argv(): string[] {
    return [];
  }

  protected prepare(): Promise<void> {
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
    const controller = new AbortController();
    const running = tiny.build(settings).run("p", { round: 1, cwd, signal: controller.signal });
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
  });
});
