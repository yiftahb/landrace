import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildRuntime, runStart } from "#cli/start.js";
import { runStatus } from "#cli/status.js";
import type { LandraceEvent } from "#namespace.js";
import { acquire, release } from "#runner/lock.js";
import { tick } from "#runner/tick.js";

/**
 * `buildRuntime` over a hook module that is a real file on disk, imported the
 * way the CLI imports one.
 *
 * This file runs in the second jest pass (see jest.esm.config.mjs): the
 * default pass rewrites `await import(url)` onto jest's own resolver, which
 * cannot resolve a `file:` URL, so the loader's one dynamic moment — and
 * therefore everything `buildRuntime` assembles out of it — is unreachable
 * there.
 */
const TICKET = "4242";
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
const hookSource = (provides?: string[], preflight?: "pass" | "throw"): string => `import { appendFile } from "node:fs/promises";

const KIND = Symbol.for("landrace.hook.kind");
const brand = (kind: string, value: object): object =>
  Object.defineProperty(value, KIND, { value: kind, enumerable: false });

interface Ctx { ticket: string; config: { tracker: { record: string } } }

export const source = brand("source", {
  id: "fake",
  list: async (): Promise<unknown[]> => [
    { ticket: "${TICKET}", title: "Add export", url: "u/${TICKET}", labels: ["lr:auto"], assignees: [] },
  ],
});

export const pre = brand("pre", {
  id: "fake",
${provides === undefined ? "" : `  provides: ${JSON.stringify(provides)},\n`}  run: ({ ticket }: Ctx): Record<string, unknown> => ({
    ticket: { number: ticket, title: "Add export", labels: ["lr:auto"] },
    entries: [],
  }),
});

export const post = brand("post", {
  id: "fake",
  handles: ["tracker.comment"],
  satisfied: (): boolean => false,
  apply: async (effect: { type: string }, ctx: Ctx): Promise<void> => {
    await appendFile(ctx.config.tracker.record, JSON.stringify({ ticket: ctx.ticket, type: effect.type }) + "\\n");
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

/** A hook-registered executor, branded the way `landrace/hooks` brands one. */
const EXECUTOR = `export const executor = brand("executor", {
  id: "fake",
  run: async (): Promise<{ text: string; sessionId: string | null }> => ({ text: "", sessionId: null }),
});
`;

const workflowReading = (path?: string): string => `version: 1
name: e2e
hooks: [hooks/fake.ts]
eligible:
  - when: { "ticket.labels": { $in: ["lr:auto"] } }
    else: "no lr:auto label"
stages:
  - id: spec
    entry: true
    terminal: true
    triggers:
      - name: fresh ticket
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
    git?: boolean;
    preflight?: "pass" | "throw";
  } = {},
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "lr-cli-"));
  if (opts.git !== false) await exec("git", ["init", "-q", "-b", "main"], { cwd: root });
  const dir = join(root, ".landrace");
  const record = join(root, "applied.jsonl");
  await mkdir(join(dir, "hooks"), { recursive: true });
  await writeFile(join(dir, "hooks", "fake.ts"), hookSource(opts.provides, opts.preflight));
  await writeFile(join(dir, "workflow.yaml"), workflowReading(opts.reads));
  await writeFile(
    join(dir, "landrace.yaml"),
    `version: 1
agent: { adapter: ${opts.agent ?? "claude"}, model: opus }
tracker: { record: ${JSON.stringify(record)} }
tick: { interval: 30s, concurrency: 2 }
security: { screen: ${opts.screen ?? false} }
log: { redact: [githubToken] }
secrets: { githubToken: $LR_TEST_TOKEN }
`,
  );
  await writeFile(join(dir, ".env"), `LR_TEST_TOKEN=${TOKEN}\n`);
  return { dir, record };
}

const applied = async (record: string): Promise<unknown[]> =>
  (await readFile(record, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);

afterEach(async () => {
  await release(TICKET);
});

describe("buildRuntime", () => {
  it("assembles a runnable loop out of the config, the workflow and the hook modules", async () => {
    const { dir } = await fixture();
    const rt = await buildRuntime(dir, {});

    expect(rt.intervalMs).toBe(30_000);
    expect(rt.concurrency).toBe(2);
    expect(rt.source.id).toBe("fake");
    expect(rt.deps.pre.map((h) => h.id)).toEqual(["fake"]);
    expect(rt.deps.executor.id).toBe("claude");
    expect(rt.deps.screen).toBeUndefined();
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
    const rt = await buildRuntime(dir, { sink: (e) => seen.push(e) });

    rt.deps.log("step.invoked", { cmd: `curl -H "Authorization: Bearer ${TOKEN}"` });
    rt.deps.ctx.log("tracker.request", { url: `https://x.invalid/?t=${TOKEN}` });

    expect(JSON.stringify(seen)).not.toContain(TOKEN);
    expect(seen.filter((e) => JSON.stringify(e).includes("[redacted]"))).toHaveLength(2);
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
    await writeFile(join(dir, "workflow.yaml"), WORKFLOW.replace("    entry: true\n", ""));

    await expect(buildRuntime(dir, {})).rejects.toThrow(/does not validate/);
    await expect(readFile(ran, "utf8")).rejects.toThrow();
  });

  /**
   * §11.8 in the daemon, not only in the CLI.
   *
   * `landrace validate` unions the hooks' `provides` and rejects a workflow
   * whose predicate reads a path nothing supplies; `start` used to run that
   * same workflow, halting tickets one at a time against a live repository
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
      provides: ["ticket", "ticket.labels", "entries"],
      reads: "artifacts.pr.number",
    });

    await expect(buildRuntime(dir, {})).rejects.toThrow(
      /path-coverage: stage "spec" reads artifacts\.pr\.number, which no hook provides/,
    );
  });

  it("starts when the hooks do provide what the workflow reads", async () => {
    const { dir } = await fixture({
      provides: ["ticket", "ticket.labels", "entries", "artifacts.pr.*"],
      reads: "artifacts.pr.number",
    });

    expect((await buildRuntime(dir, {})).source.id).toBe("fake");
  });

  it("screens prompts when the config says to", async () => {
    const { dir } = await fixture({ screen: true });
    expect((await buildRuntime(dir, {})).deps.screen).toBeDefined();
  });

  /**
   * Screening is a security control (§15) that silently ignored configuration:
   * it always ran the engine's own claude executor, so a workflow whose hook
   * registers an executor screened with something the operator never asked
   * for — or, with no claude on the machine, not at all.
   */
  it("screens with the executor the config names, not always with the engine's own", async () => {
    const { dir } = await fixture({ agent: "fake", screen: true });
    await writeFile(join(dir, "hooks", "fake.ts"), `${HOOK}
${EXECUTOR}`);

    const rt = await buildRuntime(dir, {});
    expect(rt.deps.executor.id).toBe("fake");
    expect(rt.deps.screen?.executor).toBe(rt.deps.executor);
  });

  /**
   * The sandbox is resolved at startup, not at the first invoke: a loop
   * started outside a repository would otherwise assemble, poll, and fail at
   * its first paid step — hours in, on a ticket it has already moved.
   */
  it("refuses to start when steps are to be isolated and there is no repository to isolate from", async () => {
    const { dir } = await fixture({ git: false });
    await expect(buildRuntime(dir, {})).rejects.toThrow(/not inside a git repository/);
  });

  /**
   * `agent.adapter` is the one id the engine still resolves by name. A name
   * nothing answers to used to mean a loop that ran and then failed at the
   * first invocation, hours in and one paid tick at a time.
   */
  it("refuses an agent.adapter no executor answers to, naming what it could have used", async () => {
    const { dir } = await fixture({ agent: "gpt-9" });
    await expect(buildRuntime(dir, {})).rejects.toThrow(/gpt-9[\s\S]*claude/);
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
 * `buildRuntime` deliberately does *not* run it: `landrace status` builds a
 * Runtime the same way, only to read, and a preflight can make a real write
 * (the GitHub hook's blob probe) that a read-only diagnostic must never make
 * and must never be refused for either — the token being *diagnosed* is
 * exactly the one most likely to fail a preflight. Only `runStart` runs
 * `rt.preflights`, once `buildRuntime` has handed them back unrun.
 */
describe("the startup preflight", () => {
  it("does not run when only buildRuntime is used — the write belongs to runStart alone", async () => {
    const { dir, record } = await fixture({ preflight: "pass" });
    await buildRuntime(dir, {});
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
      { ticket: TICKET, type: "tracker.comment" },
    ]);
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

    expect(printed.filter((l) => l.startsWith("#"))).toEqual([`#${TICKET} terminal after 1 pass(es)`]);
    expect(await applied(record)).toEqual([{ ticket: TICKET, type: "tracker.comment" }]);
    // Nothing is left holding the ticket: the next run is free to take it.
    expect(await acquire(TICKET, "tick")).toBe(true);
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
    const rt = await buildRuntime(dir, {});
    rt.stop.abort();

    const rows = await tick({ source: rt.source, deps: rt.deps, concurrency: rt.concurrency });

    expect(rows[0]?.outcome).toMatch(/aborted/);
    expect(await applied(record)).toEqual([]);
    expect(await acquire(TICKET, "tick")).toBe(true);
  });
});

describe("runStatus", () => {
  it("prints one line per candidate, from the same source the loop enumerates", async () => {
    const { dir } = await fixture();
    const lines = await runStatus(dir);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`#${TICKET}.*Add export.*queued`));
  });
});
