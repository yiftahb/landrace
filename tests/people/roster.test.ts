import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "#config/load.js";
import { defineConnection } from "#hooks/contracts.js";
import { personFields } from "#people/person.js";
import { ambiguousClaims, createRoster } from "#people/roster.js";
import { createCredentialStore } from "#people/store.js";
import { createDispatcher } from "#runner/effects.js";
import { createLogger } from "#runner/events.js";
import { createSlotPool } from "#runner/pool.js";
import { createExternalState } from "#testing/index.js";
import type {
  ConnectionDef, CredentialStore, ExternalState, LandraceEvent, LoadedConfig, Person, Roster, RosterOptions, RuntimeContext, SlotPool,
  Source, Step, TickRow, Workflow, WorkspaceRuntime,
} from "#namespace.js";

/*
 * #185: one runner, many people. Each person's runtime claims the items
 * labelled theirs, `for:<id>`; an item labelled for two is claimed by both.
 * What is observed is whose agent ran on what, the rows and the events —
 * never how the tick decided, which the tick tests own.
 */
const ENTER = { type: "tracker.comment", kind: "enter", marker: "enter:{stage}:{round}" };

const workflowFor = (person: string): Workflow => ({
  version: 1, name: "main", description: "test",
  eligible: [{ when: { "node.state.labels": { $in: [`for:${person}`] } }, else: `not ${person}'s` }],
  stages: [
    { id: "spec", entry: true, step: "spec", triggers: [{ when: { "run.stage": null } }], on_enter: [ENTER, { type: "tracker.status", value: "spec" }] },
    { id: "done", terminal: true, triggers: [{ when: { "run.outputs.spec": { $exists: true } } }], on_enter: [{ type: "tracker.status", value: "done" }] },
    {
      id: "retro", step: "retro", closed: "run",
      triggers: [{ name: "resolved", when: { "node.closed": "done" } }],
      on_enter: [ENTER, { type: "tracker.status", value: "retro" }],
    },
  ],
});

/** Its prompt names the step's kind and the item, which is how a run says what it is on. */
const answering = (kind: string): Step => ({
  prompt: `${kind} #{node.id}`,
  output: { discriminator: "kind", shapes: { [kind]: {} }, routes: [{ when: { kind }, effect: { type: "tracker.comment", marker: `${kind}:{round}` } }] },
});
const steps = new Map<string, Step>([["spec", answering("spec")], ["retro", answering("retro")]]);

const claude = defineConnection({ id: "claude", label: "Claude", kind: "credential", fields: ["token"], required: "always" });
const connections = new Map<string, ConnectionDef>([["claude", claude]]);

const gates: Array<() => void> = [];
afterEach(() => {
  for (const open of gates.splice(0)) open();
});

async function until(predicate: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function configured(): Promise<LoadedConfig> {
  const dir = join(await mkdtemp(join(tmpdir(), "lr-roster-")), ".landrace");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "landrace.yaml"), "version: 1\nagent: { adapter: claude }\n");
  await writeFile(join(dir, ".env"), "");
  return loadConfig(dir);
}

/** A store holding `people`, each with a Claude connection unless `without` names them; `corrupt` people's files are not JSON. */
async function storeOf(people: string[], o: { without?: string[]; corrupt?: string[] } = {}): Promise<CredentialStore> {
  const root = join(await mkdtemp(join(tmpdir(), "lr-roster-creds-")), "credentials");
  const store = createCredentialStore(root);
  for (const id of people) {
    if (o.corrupt?.includes(id)) {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, `${id}.json`), "{ not json");
      continue;
    }
    const connected = o.without?.includes(id) ? "other" : "claude";
    await store.put(id, { id }, connected, { fields: { token: `tok-${id}-123456` }, source: "paste", connectedAt: new Date().toISOString() });
  }
  return store;
}

interface World {
  state: ExternalState;
  roster: Roster;
  pool: SlotPool;
  events: LandraceEvent[];
  rows: Map<string, TickRow[][]>;
  /** Each agent run, whose and on which item, and whether it was stopped. */
  runs: Array<{ person: string; item: string; stopped: boolean }>;
  /** Runs of each person's in flight now. */
  inFlight: (person: string) => number;
  /** Make a person's source fail its lists, or list again. */
  down: (person: string, failing: boolean) => void;
  named: (name: string) => LandraceEvent[];
}

/**
 * A roster over one tracker, every person's runtime sharing a pool of
 * `capacity`. `held` keeps each agent running until the test ends or it is
 * stopped, so what holds a slot can be counted.
 */
async function world(o: {
  people: string[]; items: Array<{ id: string; labels: string[]; closed?: "done" }>; capacity?: number; held?: boolean;
  store?: CredentialStore; release?: Map<string, () => void>; slow?: string[];
  /** People given a second workflow claiming what their first does: on the same source (a conflict), or on one of its own (a clash). */
  twice?: Record<string, "same source" | "own source">;
}): Promise<World> {
  const state = createExternalState({ items: o.items });
  const pool = createSlotPool(o.capacity ?? 3);
  const events: LandraceEvent[] = [];
  const rows = new Map<string, TickRow[][]>();
  const runs: World["runs"] = [];
  const flying = new Map<string, number>();
  const failing = new Set<string>();
  const lockRoot = await mkdtemp(join(tmpdir(), "lr-roster-locks-"));
  const base = createLogger({ sink: (e) => events.push(e) });
  const stop = new AbortController();

  const build = async (person: Person): Promise<WorkspaceRuntime> => {
    const log = base.with(personFields(person));
    const ctx: RuntimeContext = { config: {} as RuntimeContext["config"], secrets: new Map(), signal: stop.signal, log: () => {}, person };
    const source: Source = {
      ...state.source,
      list: (c) => (failing.has(person.id) ? Promise.reject(new Error(`${person.id}'s tracker is down`)) : state.source.list(c)),
      // A slow person's checks ask for their slot well after everyone else's have.
      read: async (item, c) => {
        if (o.slow?.includes(person.id)) await new Promise((r) => setTimeout(r, 40));
        return state.source.read(item, c);
      },
    };
    const twice = o.twice?.[person.id];
    const workflows = (twice === undefined ? ["main"] : ["main", "second"]).map((id): WorkspaceRuntime["workflows"][number] => {
      const own = id === "second" && twice === "own source" ? { ...source } : source;
      return {
        id, name: id, description: "test", source: own,
        deps: {
          workflow: workflowFor(person.id), steps, source: own, pre: [state.pre], dispatcher: createDispatcher([state.post]), ctx, log, scrub: (t) => t,
          executor: {
            id: "agent",
            run: async (prompt, { signal }) => {
              const [kind = "", item = ""] = prompt.trim().split(" #");
              const run = { person: person.id, item, stopped: false };
              runs.push(run);
              flying.set(person.id, (flying.get(person.id) ?? 0) + 1);
              try {
                if (o.held) {
                  let open!: () => void;
                  const opened = new Promise<void>((resolve) => { open = resolve; });
                  gates.push(open);
                  o.release?.set(`${person.id}:${item}`, open);
                  const stopped = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
                  await Promise.race([stopped, opened]);
                }
                run.stopped = signal.aborted;
                return { text: `\`\`\`json\n{"kind":"${kind}"}\n\`\`\``, sessionId: null };
              } finally {
                flying.set(person.id, (flying.get(person.id) ?? 1) - 1);
              }
            },
          },
        },
      };
    });
    return {
      dir: ".",
      workflows,
      preflights: [], intervalMs: 60_000, concurrency: pool.capacity, agents: 0, checking: false, asking: [], turnedAway: [],
      // Each person's own runs and own record of what was told, as `start` gives them.
      stop, running: new Map(), seen: new Map(), log, ctx, slots: pool,
    };
  };

  const store = o.store ?? await storeOf(o.people);
  const opts: RosterOptions = {
    dir: ".", loaded: await configured(), registry: { connections }, store, mode: { remote: true }, pool, log: base, build, lock: { root: lockRoot },
    rows: (person, _rt, r) => rows.set(person.id, [...(rows.get(person.id) ?? []), r]),
  };
  const roster = createRoster(opts);
  await roster.sync();
  return {
    state, roster, pool, events, rows, runs,
    inFlight: (person) => flying.get(person) ?? 0,
    down: (person, f) => (f ? failing.add(person) : failing.delete(person)),
    named: (name) => events.filter((e) => e.name === name),
  };
}

const lastRows = (w: World, person: string): TickRow[] => w.rows.get(person)?.at(-1) ?? [];

describe("ambiguousClaims", () => {
  it("names an item two or three people claim, and leaves out one only one claims", () => {
    expect(ambiguousClaims([
      { personId: "bob", items: ["7", "8"] },
      { personId: "alice", items: ["7", "9"] },
      { personId: "carol", items: ["8"] },
    ])).toEqual(new Map([["7", ["alice", "bob"]], ["8", ["bob", "carol"]]]));
    expect(ambiguousClaims([{ personId: "alice", items: ["7"] }])).toEqual(new Map());
  });
});

describe("one runner, many people", () => {
  it("works an item one person claims, leaves one nobody claims absent, and works none two or three claim", async () => {
    const w = await world({
      people: ["alice", "bob", "carol"],
      items: [
        { id: "5", labels: [] },
        { id: "6", labels: ["for:alice"] },
        { id: "7", labels: ["for:alice", "for:bob"] },
        { id: "8", labels: ["for:alice", "for:bob", "for:carol"] },
      ],
    });

    await w.roster.tick();

    expect(lastRows(w, "alice")).toEqual([
      { item: "5", outcome: "skipped: not alice's" },
      { item: "6", workflow: "main", outcome: expect.stringMatching(/^terminal/) },
      { item: "7", outcome: "claimed by more than one person: alice and bob" },
      { item: "8", outcome: "claimed by more than one person: alice, bob and carol" },
    ]);
    expect(lastRows(w, "carol")).toEqual([
      { item: "5", outcome: "skipped: not carol's" },
      { item: "6", outcome: "skipped: not carol's" },
      { item: "7", outcome: "skipped: not carol's" },
      { item: "8", outcome: "claimed by more than one person: alice, bob and carol" },
    ]);
    expect(w.runs.map((r) => r.person)).toEqual(["alice"]);
    expect([w.state.stage("7"), w.state.stage("8")]).toEqual([null, null]);
    // Once a tick, whatever the number of boards it is on.
    expect(w.named("item.ambiguous")).toEqual([
      { name: "item.ambiguous", item: "7", people: ["alice", "bob"] },
      { name: "item.ambiguous", item: "8", people: ["alice", "bob", "carol"] },
    ]);
    expect(w.roster.ambiguous()).toEqual(new Map([["7", ["alice", "bob"]], ["8", ["alice", "bob", "carol"]]]));
  });

  it("works none of two people's way a closed item each one's closed: run stage claims", async () => {
    const w = await world({ people: ["alice", "bob"], items: [{ id: "9", labels: ["for:alice", "for:bob"], closed: "done" }] });

    await w.roster.tick();

    expect(w.runs).toEqual([]);
    expect(lastRows(w, "alice")).toEqual([{ item: "9", outcome: "claimed by more than one person: alice and bob" }]);
    expect(w.named("item.ambiguous")).toEqual([{ name: "item.ambiguous", item: "9", people: ["alice", "bob"] }]);
  });

  it("stops alice's run on 7 the tick after bob is given it too, and starts no run of bob's", async () => {
    const w = await world({ people: ["alice", "bob"], items: [{ id: "7", labels: ["for:alice"] }], held: true });
    const first = w.roster.tick();
    await until(() => w.inFlight("alice") === 1, "alice's run on 7");

    w.state.label("7", "for:bob");
    await w.roster.tick();
    await first;

    expect(w.named("item.aborted")).toEqual([
      expect.objectContaining({ item: "7", person: "alice", reason: "claimed by more than one person: alice and bob" }),
    ]);
    expect(w.runs).toEqual([{ person: "alice", item: "7", stopped: true }]);
  });

  it("splits a pool of two one each when alice has three items to run and bob one, though alice's asks land first", async () => {
    const w = await world({
      people: ["alice", "bob"], capacity: 2, held: true, slow: ["bob"],
      items: [{ id: "1", labels: ["for:alice"] }, { id: "2", labels: ["for:alice"] }, { id: "3", labels: ["for:alice"] }, { id: "4", labels: ["for:bob"] }],
    });

    void w.roster.tick();
    await until(() => w.inFlight("alice") + w.inFlight("bob") === 2, "two runs");
    // Long enough for a third to start, were the pool to allow one.
    await new Promise((r) => setTimeout(r, 50));

    expect([w.inFlight("alice"), w.inFlight("bob")]).toEqual([1, 1]);
  });

  it("starts bob's waiting item in the slot alice's run gives back", async () => {
    const release = new Map<string, () => void>();
    const w = await world({
      people: ["alice", "bob"], capacity: 1, held: true, release,
      items: [{ id: "1", labels: ["for:alice"] }, { id: "4", labels: ["for:bob"] }],
    });

    const ticking = w.roster.tick();
    await until(() => w.inFlight("alice") + w.inFlight("bob") === 1, "one run");
    const [first] = w.runs;
    const other = first?.person === "alice" ? "bob" : "alice";
    expect(w.inFlight(other)).toBe(0);

    release.get(`${first?.person ?? ""}:${first?.item ?? ""}`)?.();
    await until(() => w.inFlight(other) === 1, `${other}'s item in the freed slot`);
    release.get(`${other}:${other === "bob" ? "4" : "1"}`)?.();
    await ticking;

    expect(w.runs.map((r) => r.person).sort()).toEqual(["alice", "bob"]);
  });

  /*
   * A runtime the roster let go of keeps nothing on the pool: its queue
   * does not hold alice to half the cap, nor does a slot she frees start
   * an agent for a person no longer running.
   */
  it("gives the slot bob's run frees to alice, not to the item bob's runtime turned away before he left", async () => {
    const release = new Map<string, () => void>();
    const store = await storeOf(["alice", "bob"]);
    const w = await world({
      people: ["alice", "bob"], store, capacity: 2, held: true, release, slow: ["bob"],
      items: [{ id: "1", labels: ["for:alice"] }, { id: "2", labels: ["for:alice"] }, { id: "4", labels: ["for:bob"] }, { id: "5", labels: ["for:bob"] }],
    });
    const ticking = w.roster.tick();
    await until(() => w.inFlight("alice") === 1 && w.inFlight("bob") === 1, "one run each");
    // Long enough for the asks turned away to have settled.
    await new Promise((r) => setTimeout(r, 50));
    // Which of alice's two runs first is the tick's to rank; each person has one, and one more of each was turned away.
    const [bobs] = w.runs.filter((r) => r.person === "bob").map((r) => r.item);
    expect(w.runs).toHaveLength(2);
    expect(["4", "5"]).toContain(bobs);

    const alices = w.runs.find((r) => r.person === "alice")?.item ?? "";
    const other = alices === "1" ? "2" : "1";

    // Bob's Claude login is gone: he is no longer running, and alice ticks alone.
    await store.remove("bob", "claude");
    await w.roster.sync();
    // The slot bob's run frees starts nothing for him.
    release.get(`bob:${bobs ?? ""}`)?.();
    await until(() => w.inFlight("bob") === 0, "bob's run to end");
    await new Promise((r) => setTimeout(r, 50));
    expect(w.runs).toHaveLength(2);

    // Nor does his old queue hold alice to half the cap.
    const alone = w.roster.tick();
    await until(() => w.inFlight("alice") === 2, `alice's run on ${other} in the cap's second slot`);
    expect(w.runs.map((r) => `${r.person}:${r.item}`).sort()).toEqual(["alice:1", "alice:2", `bob:${bobs ?? ""}`]);
    release.get(`alice:${alices}`)?.();
    release.get(`alice:${other}`)?.();
    await Promise.all([ticking, alone]);
  });

  it("skips everyone's items while bob's listing fails, keeps alice's run going, and works them once it lists again", async () => {
    const release = new Map<string, () => void>();
    const w = await world({
      people: ["alice", "bob"], held: true, release,
      items: [{ id: "1", labels: ["for:alice"] }, { id: "2", labels: ["for:alice"] }],
    });
    w.state.label("2", "hold");
    w.state.unlabel("2", "for:alice");
    const first = w.roster.tick();
    await until(() => w.inFlight("alice") === 1, "alice's run on 1");

    w.down("bob", true);
    w.state.label("2", "for:alice");
    await expect(w.roster.tick()).rejects.toThrow(/bob's tracker is down/);

    expect(w.named("item.aborted")).toEqual([]);
    expect(w.inFlight("alice")).toBe(1);
    expect(lastRows(w, "alice")).toEqual(expect.arrayContaining([
      { item: "2", outcome: "whether another person also claims it is unknown: bob's items could not be listed" },
    ]));
    expect(w.runs.map((r) => r.item)).toEqual(["1"]);

    w.down("bob", false);
    release.get("alice:1")?.();
    await first;
    const again = w.roster.tick();
    await until(() => w.runs.some((r) => r.item === "2"), "alice's run on 2");
    release.get("alice:2")?.();
    await again;
    expect(w.state.stage("2")).toBe("done");
  });

  /*
   * An item a person's own workflows both claim, or two of their sources
   * report, is still theirs: their board halts it, and it must not run for
   * the one other person who also claims it.
   */
  it.each(["same source", "own source"] as const)(
    "works 7 for nobody when alice's two workflows on the %s both claim it and bob owns it",
    async (twice) => {
      const w = await world({ people: ["alice", "bob"], twice: { alice: twice }, items: [{ id: "7", labels: ["for:alice", "for:bob"] }] });

      await w.roster.tick();

      expect(w.runs).toEqual([]);
      expect(w.state.stage("7")).toBeNull();
      expect(lastRows(w, "bob")).toEqual([{ item: "7", outcome: "claimed by more than one person: alice and bob" }]);
      expect(w.named("item.ambiguous")).toEqual([{ name: "item.ambiguous", item: "7", people: ["alice", "bob"] }]);
    },
  );

  /*
   * Page writes, Refresh and the MCP tools read the last tick's set: one
   * judged while bob was here must not hold 7 from alice once she ticks alone.
   */
  it.each([
    ["one person ticks alone", ["bob"], ["alice:7"]],
    ["nobody is ready", ["alice", "bob"], []],
  ] as const)("forgets what two people claimed once %s", async (_, leaving, ran) => {
    const store = await storeOf(["alice", "bob"]);
    const w = await world({ people: ["alice", "bob"], store, items: [{ id: "7", labels: ["for:alice", "for:bob"] }] });
    await w.roster.tick();
    expect(w.roster.ambiguous()).toEqual(new Map([["7", ["alice", "bob"]]]));

    for (const id of leaving) await store.remove(id, "claude");
    await w.roster.sync();
    await w.roster.tick();

    expect(w.roster.ambiguous()).toEqual(new Map());
    expect(w.runs.map((r) => `${r.person}:${r.item}`)).toEqual(ran);
  });

  it("ticks alice while bob has no Claude connection, and bob's board is not ready", async () => {
    const w = await world({
      people: ["alice", "bob"], store: await storeOf(["alice", "bob"], { without: ["bob"] }),
      items: [{ id: "1", labels: ["for:alice"] }, { id: "4", labels: ["for:bob"] }],
    });

    await w.roster.tick();

    expect(w.runs.map((r) => r.person)).toEqual(["alice"]);
    expect(w.roster.get("bob")?.slot.current()).toBeNull();
    expect(w.roster.get("bob")?.statuses).toEqual([expect.objectContaining({ id: "claude", state: "missing" })]);
    expect(w.roster.get("bob")?.board.has?.("4")).toBe(false);
    await expect(w.roster.get("bob")?.board.view()).rejects.toThrow(/not running/);
  });

  it("marks only alice failed when her credentials file is corrupt, logs it, and bob still ticks", async () => {
    const w = await world({
      people: ["alice", "bob"], store: await storeOf(["alice", "bob"], { corrupt: ["alice"] }),
      items: [{ id: "1", labels: ["for:alice"] }, { id: "4", labels: ["for:bob"] }],
    });

    await w.roster.tick();

    expect(w.roster.get("alice")?.statuses).toEqual([expect.objectContaining({ id: "claude", state: "failed" })]);
    expect(w.named("connection.failed")).toEqual([expect.objectContaining({ person: "alice", error: expect.stringMatching(/is not JSON/) })]);
    expect(w.runs.map((r) => r.person)).toEqual(["bob"]);
  });

  it("marks only the person whose build throws, and holds everyone else", async () => {
    const pool = createSlotPool(2);
    const events: LandraceEvent[] = [];
    const roster = createRoster({
      dir: ".", loaded: await configured(), registry: { connections }, store: await storeOf(["alice", "bob"]), mode: { remote: true }, pool,
      log: createLogger({ sink: (e) => events.push(e) }),
      build: async (person) => {
        if (person.id === "alice") throw new Error("alice's hooks do not load");
        return null;
      },
    });

    await expect(roster.sync()).resolves.toBeUndefined();

    expect(roster.people().map((p) => p.person.id)).toEqual(["alice", "bob"]);
    expect(events).toEqual([expect.objectContaining({ name: "connection.failed", person: "alice", error: expect.stringMatching(/alice's hooks do not load/) })]);
  });

  it("holds exactly the local person when not remote, whoever the store has files for", async () => {
    const roster = createRoster({
      dir: ".", loaded: await configured(), registry: { connections: new Map() }, store: await storeOf(["alice", "bob"]), mode: { remote: false },
      log: createLogger({ sink: () => {} }), local: { id: "local" }, build: async () => null,
    });
    await roster.sync();
    expect(roster.people().map((p) => p.person.id)).toEqual(["local"]);
  });
});
