import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LandraceEvent, Step, TickOptions, Workflow } from "#namespace.js";
import { definePreHook, defineSource } from "#hooks/contracts.js";
import type { Candidate, Executor, HookContext, RuntimeContext } from "#namespace.js";
import { createDispatcher } from "#runner/effects.js";
import { createLogger } from "#runner/events.js";
import { acquire, held, release } from "#runner/lock.js";
import { eligibilityOf, tick } from "#runner/tick.js";
import { statusLines } from "#runner/status.js";

/**
 * One stage, entered and finished in a single pass, so what a test observes is
 * the tick's own behaviour — which tickets ran, when, and under what lock —
 * and not something the decision engine did with them.
 */
const workflow: Workflow = {
  version: 1,
  name: "t",
  eligible: [{ when: { "ticket.labels": { $in: ["lr:auto"] } }, else: "no lr:auto label" }],
  stages: [{ id: "a", entry: true, terminal: true, triggers: [{ when: { "run.stage": null } }] }],
};

/**
 * An identity predicate the allowlist refuses. locate() compiles every stage's
 * identity on every decision, and converge does not wrap decide() — so this is
 * a throw the tick itself has to catch rather than one converge turns into a
 * result.
 */
const exploding: Workflow = {
  ...workflow,
  stages: [{ id: "a", entry: true, terminal: true, identity: { $where: "1" } }],
};

const candidate = (ticket: number, labels: string[] = ["lr:auto"]): Candidate => ({
  ticket,
  title: `issue ${ticket}`,
  url: `u/${ticket}`,
  labels,
});

const source = (candidates: Candidate[]) => defineSource({ id: "fake", list: async () => candidates });

const quietPre = definePreHook({
  id: "fake",
  run: () => ({ ticket: { labels: ["lr:auto"] }, entries: [] }),
});

function deps(overrides: Partial<TickOptions["deps"]> = {}): TickOptions["deps"] {
  return {
    workflow,
    steps: new Map<string, Step>(),
    pre: [quietPre],
    dispatcher: createDispatcher([]),
    executor: { id: "none", run: async () => ({ text: "", sessionId: null }) } as Executor,
    ctx: {
      config: {} as HookContext["config"],
      secrets: new Map(),
      signal: new AbortController().signal,
      log: () => {},
    } satisfies RuntimeContext,
    log: createLogger({ sink: () => {} }),
    ...overrides,
  };
}

/**
 * A promise a test resolves by hand, to hold a ticket's converge open.
 *
 * Every gate is released after the test whether it passed or not: a failed
 * assertion between opening one and closing it would otherwise leave a worker
 * blocked forever, and the file would hang instead of reporting the failure.
 */
const gates: Array<() => void> = [];
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  gates.push(open);
  return { wait, open };
}
afterEach(() => {
  for (const open of gates.splice(0)) open();
});

/** Poll until a condition holds, rather than sleeping a guessed interval. */
async function until(predicate: () => boolean | Promise<boolean>, what: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lr-tick-"));
});

describe("tick", () => {
  it("acts on every eligible ticket", async () => {
    const out = await tick({ source: source([1, 2, 3].map((n) => candidate(n))), deps: deps(), lock: { root } });
    expect(out.map((r) => r.ticket)).toEqual([1, 2, 3]);
    expect(out.map((r) => r.outcome)).toEqual([
      "terminal after 1 pass(es)",
      "terminal after 1 pass(es)",
      "terminal after 1 pass(es)",
    ]);
  });

  it("skips a locked ticket without acting on it, and still does the others", async () => {
    const seen: number[] = [];
    const recording = definePreHook({
      id: "fake",
      run: ({ ticket }) => {
        seen.push(ticket);
        return { ticket: { labels: ["lr:auto"] }, entries: [] };
      },
    });

    await acquire(1, "conversation", { root, holder: "mcp:ask" });
    const out = await tick({
      source: source([candidate(1), candidate(2)]),
      deps: deps({ pre: [recording] }),
      lock: { root },
    });

    expect(out.find((r) => r.ticket === 1)?.outcome).toMatch(/locked by mcp:ask/);
    expect(out.find((r) => r.ticket === 2)?.outcome).not.toMatch(/locked/);
    // A skip is a skip: nothing about the locked ticket was read or decided.
    expect(seen).toEqual([2]);
    await release(1, { root });
  });

  it("releases each lock when the ticket is done", async () => {
    await tick({ source: source([candidate(1)]), deps: deps(), lock: { root } });
    expect(await acquire(1, "tick", { root })).toBe(true);
    await release(1, { root });
  });

  it("releases the lock even when the ticket threw", async () => {
    const out = await tick({ source: source([candidate(1)]), deps: deps({ workflow: exploding }), lock: { root } });

    expect(out[0]?.outcome).toMatch(/^error: .*\$where/);
    expect(await acquire(1, "tick", { root })).toBe(true);
    await release(1, { root });
  });

  it("reports a ticket that threw without abandoning the rest", async () => {
    const out = await tick({
      source: source([candidate(1), candidate(2)]),
      deps: deps({ workflow: exploding }),
      lock: { root },
    });

    expect(out).toHaveLength(2);
    expect(out.map((r) => r.outcome)).toEqual([
      expect.stringMatching(/^error: /),
      expect.stringMatching(/^error: /),
    ]);
  });

  it("reports a ticket whose hook rejected with something that is not an Error", async () => {
    const weird = definePreHook({
      id: "weird",
      run: () => {
        throw Object.assign(Object.create(null) as object, { message: "no prototype here" });
      },
    });
    const out = await tick({ source: source([candidate(1)]), deps: deps({ pre: [weird] }), lock: { root } });

    // converge turns a pre-hook failure into a halt rather than a throw, so
    // what this pins is that the reason survives into the row either way —
    // "halt after 1 pass(es)" on its own tells an operator nothing.
    expect(out[0]?.outcome).toMatch(/no prototype here/);
  });

  it("keeps a reason that spans lines to one line", async () => {
    const shouty = definePreHook({
      id: "shouty",
      run: () => {
        throw new Error("first line\n#99 terminal after 1 pass(es)");
      },
    });
    const out = await tick({ source: source([candidate(1)]), deps: deps({ pre: [shouty] }), lock: { root } });

    expect(out[0]?.outcome).not.toContain("\n");
  });

  /**
   * The reason mutual exclusion is per ticket and not "is a tick running":
   * one ticket's ten-minute agent must not stop every other ticket moving.
   */
  it("does not let one slow ticket hold up the others", async () => {
    const slow = gate();
    const done: number[] = [];
    const blocking = definePreHook({
      id: "blocking",
      run: async ({ ticket }) => {
        if (ticket === 1) await slow.wait;
        done.push(ticket);
        return { ticket: { labels: ["lr:auto"] }, entries: [] };
      },
    });

    const running = tick({
      source: source([1, 2, 3].map((n) => candidate(n))),
      deps: deps({ pre: [blocking] }),
      concurrency: 3,
      lock: { root },
    });

    await until(() => done.includes(2) && done.includes(3), "tickets 2 and 3 to finish while 1 is still blocked");
    expect(done).not.toContain(1);
    slow.open();
    await running;
    // Order between 2 and 3 is whichever won the race for a worker; what is
    // pinned is that neither of them waited on 1.
    expect(done.at(-1)).toBe(1);
    expect([...done].sort()).toEqual([1, 2, 3]);
  });

  it("never runs more tickets at once than the concurrency bound allows", async () => {
    const open = gate();
    let inFlight = 0;
    let peak = 0;
    const counting = definePreHook({
      id: "counting",
      run: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await open.wait;
        inFlight--;
        return { ticket: { labels: ["lr:auto"] }, entries: [] };
      },
    });

    const running = tick({
      source: source([1, 2, 3, 4, 5].map((n) => candidate(n))),
      deps: deps({ pre: [counting] }),
      concurrency: 2,
      lock: { root },
    });

    // Every ticket blocks on one gate, so an unbounded implementation reaches
    // five in flight and this reaches two and stays there.
    await until(() => peak >= 2, "the bound to be reached");
    await new Promise((r) => setTimeout(r, 25));
    expect(peak).toBe(2);

    open.open();
    expect(await running).toHaveLength(5);
    expect(peak).toBe(2);
  });

  it("holds the ticket's lock for as long as it is working on it", async () => {
    const slow = gate();
    const blocking = definePreHook({
      id: "blocking",
      run: async () => {
        await slow.wait;
        return { ticket: { labels: ["lr:auto"] }, entries: [] };
      },
    });

    const running = tick({ source: source([candidate(1)]), deps: deps({ pre: [blocking] }), lock: { root } });

    await until(async () => (await held(1, { root })) !== null, "the tick to take the lock");
    expect((await held(1, { root }))?.kind).toBe("tick");
    expect(await acquire(1, "conversation", { root })).toBe(false);

    slow.open();
    await running;
    expect(await held(1, { root })).toBeNull();
  });

  it("skips an ineligible ticket with the workflow's own reason, and never locks it", async () => {
    const out = await tick({
      source: source([candidate(1, []), candidate(2)]),
      deps: deps(),
      lock: { root },
    });

    expect(out.find((r) => r.ticket === 1)?.outcome).toBe("skipped: no lr:auto label");
    expect(out.find((r) => r.ticket === 2)?.outcome).toMatch(/^terminal/);
    // Never locked, so there was never anything to release.
    expect(await acquire(1, "tick", { root })).toBe(true);
    await release(1, { root });
  });

  it("surfaces a failure to enumerate, rather than reporting an empty tick", async () => {
    const broken = defineSource({
      id: "broken",
      list: async () => {
        throw new Error("GET /issues → 401");
      },
    });
    await expect(tick({ source: broken, deps: deps(), lock: { root } })).rejects.toThrow(/401/);
  });

  it("logs the tick's own boundaries, an acquired lock and a denied one", async () => {
    const seen: LandraceEvent[] = [];
    await acquire(1, "conversation", { root, holder: "mcp:ask" });
    await tick({
      source: source([candidate(1), candidate(2)]),
      deps: deps({ log: createLogger({ sink: (e) => seen.push(e) }) }),
      lock: { root },
    });
    await release(1, { root });

    const names = seen.map((e) => e.name);
    expect(names[0]).toBe("tick.started");
    expect(names.at(-1)).toBe("tick.finished");
    expect(names).toContain("lock.denied");
    expect(names).toContain("lock.acquired");
  });
});

describe("eligibilityOf", () => {
  it("reads the workflow's own rule off the labels a candidate already carries", () => {
    expect(eligibilityOf(workflow, candidate(1))).toEqual({ eligible: true });
    expect(eligibilityOf(workflow, candidate(1, []))).toEqual({ eligible: false, reason: "no lr:auto label" });
  });

  /**
   * Abstain rather than guess: a rule reading anything a candidate cannot
   * carry is unanswerable from labels alone, and answering it "ineligible"
   * would silently park every ticket in the repository.
   */
  it("abstains when the rule reads something a candidate cannot answer", () => {
    // An equality against a derived path, not a range: mongo semantics make
    // `{ $lt: 3 }` match a *missing* field, so a rule written that way would
    // come back eligible with or without this guard — a test that could never
    // fail, pinning nothing.
    const derived: Workflow = {
      ...workflow,
      eligible: [{ when: { "run.stage": "spec" }, else: "not in the spec phase" }],
    };
    expect(eligibilityOf(derived, candidate(1, []))).toEqual({ eligible: true });
  });

  it("abstains for the whole rule set when only one rule is unanswerable", () => {
    const mixed: Workflow = {
      ...workflow,
      eligible: [
        { when: { "ticket.labels": { $in: ["lr:auto"] } }, else: "no lr:auto label" },
        { when: { "run.stage": "spec" }, else: "not in the spec phase" },
      ],
    };
    expect(eligibilityOf(mixed, candidate(1, []))).toEqual({ eligible: true });
  });

  it("treats a workflow with no eligibility rule as taking every ticket", () => {
    const open: Workflow = { version: 1, name: "t", stages: workflow.stages };
    expect(eligibilityOf(open, candidate(1, []))).toEqual({ eligible: true });
  });
});

describe("statusLines", () => {
  it("renders position and reason in one line per ticket", () => {
    const lines = statusLines([
      { ticket: 12, title: "Add export", stage: "spec", note: "waiting on you" },
      { ticket: 15, title: "Old bug", stage: null, note: "skipped: no lr:auto label" },
    ]);
    expect(lines[0]).toMatch(/#12.*spec.*waiting on you/);
    expect(lines[1]).toMatch(/#15.*skipped: no lr:auto label/);
  });

  it("names the ticket, so a line is readable without opening the tracker", () => {
    const [line] = statusLines([{ ticket: 12, title: "Add export", stage: "spec", note: "queued" }]);
    expect(line).toContain("Add export");
  });

  it("lines the note column up across rows whose stages are different widths", () => {
    const [first, second] = statusLines([
      { ticket: 3, title: "a", stage: "spec", note: "queued" },
      { ticket: 4, title: "b", stage: "code-review", note: "working" },
    ]);
    expect((first as string).indexOf("queued")).toBe((second as string).indexOf("working"));
  });

  /**
   * A title is a tracker field anyone can write, and a status line is what a
   * person reads to decide what the loop is doing. A newline in a title would
   * let whoever opened the ticket print a row of their own.
   */
  it("cannot be made to print a second row by a title containing a newline", () => {
    const lines = statusLines([
      { ticket: 1, title: "fine\n#99    spec   waiting on you", stage: "spec", note: "queued" },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
  });

  it("strips the escape character out of a title, so a line cannot repaint the terminal", () => {
    const [line] = statusLines([
      { ticket: 1, title: "plain\u001b[31mred\u001b[0m\rrewritten", stage: null, note: "queued" },
    ]);
    // eslint-disable-next-line no-control-regex
    expect(line).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it("truncates a very long title rather than letting it run the line away", () => {
    const [line] = statusLines([{ ticket: 1, title: "x".repeat(200), stage: null, note: "queued" }]);
    expect((line as string).length).toBeLessThan(120);
    expect(line).toContain("…");
  });

  it("renders nothing for no rows", () => {
    expect(statusLines([])).toEqual([]);
  });
});
