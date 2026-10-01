import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OUTPUT_KIND, renderMarker } from "#conventions.js";
import { hooked, loaded } from "#tests/support/loaded.js";
import type { Executor, Step, Tools, Workflow } from "#namespace.js";
import { createMcpServer } from "#mcp/server.js";
import { createTools } from "#mcp/tools.js";
import { held } from "#runner/lock.js";
import { createFakeTracker, type FakeIssue, type FakeTracker } from "#tests/support/fake-tracker.js";

/** Wait for a fact rather than for a number of milliseconds. */
async function until(done: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (await done()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function connect(
  seed: Array<Partial<FakeIssue>> = [],
  make: (gh: FakeTracker) => Tools = (gh) => createTools([hooked(gh.registry)], gh.ctx),
) {
  const gh = createFakeTracker(seed);
  const server = createMcpServer(make(gh));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, gh };
}

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

describe("mcp server over a real transport", () => {
  it("advertises exactly the tools it implements", async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "landrace_ask",
      "landrace_clear",
      "landrace_create_item",
      "landrace_finish",
      "landrace_goto",
      "landrace_items",
      "landrace_pair",
      "landrace_release",
      "landrace_reply",
      "landrace_resolve",
      "landrace_status",
      "landrace_update_item",
      "landrace_waiting",
      "landrace_workflows",
    ]);
    await client.close();
  });

  /*
   * An executor that cannot hand a session to a person offers nothing to pair
   * on, and a pairing asked for anyway is refused in a sentence — never
   * half-started.
   */
  it("offers no pairing with an executor that cannot hand a session over, and refuses one asked for", async () => {
    const plain: Executor = { id: "plain", run: async () => ({ text: "", sessionId: null }) };
    const { client, gh } = await connect([{ number: 1, labels: ["lr:auto", "lr:stage:spec"] }], (t) => createTools([hooked(t.registry,
      loaded({ version: 1, name: "t", description: "test", stages: [{ id: "spec", step: "spec", entry: true, triggers: [] }] } as Workflow,
        new Map<string, Step>([["spec", { prompt: "write the spec", capabilities: ["repo:read"] }]])),
      { executor: plain })], t.ctx, { sandbox: { root: process.cwd() } }));
    const view = await client.callTool({ name: "landrace_pair", arguments: { item: 1 } });
    expect(JSON.parse(textOf(view))).toEqual({ open: null, offers: [] });

    const r = await client.callTool({ name: "landrace_pair", arguments: { item: 1, stage: "spec" } });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(textOf(r)).toMatch(/cannot hand a session/);
    expect(gh.comments.get(1) ?? []).toEqual([]);
    await client.close();
  });

  it("creates an item end to end through the protocol", async () => {
    const workflow: Workflow = { version: 1, name: "t", description: "test", admit: ["lr:auto"], stages: [{ id: "spec", entry: true, terminal: true }] };
    const { client, gh } = await connect([], (t) => createTools([hooked(t.registry, loaded(workflow))], t.ctx));
    const r = await client.callTool({ name: "landrace_create_item", arguments: { title: "Add CSV export" } });
    expect(JSON.parse(textOf(r))).toMatchObject({ item: "1", started: true });
    expect(gh.issues.get(1)?.title).toBe("Add CSV export");
    await client.close();
  });

  it("returns an error result rather than throwing when an item is missing", async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: "landrace_status", arguments: { item: 99 } });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(textOf(r)).toMatch(/error: .*#99 is not an item any source lists/);
    await client.close();
  });

  it("enforces the argument schema and says why", async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: "landrace_status", arguments: { item: -1 } });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(textOf(r)).toMatch(/validation error.*item/i);
    await client.close();
  });

  it("still accepts a numeric item id, for clients written before ids were strings", async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: "landrace_status", arguments: { item: 99 } });
    expect(textOf(r)).toMatch(/#99 is not an item any source lists/); // reached the tool
    await client.close();
  });

  it("accepts a string item id", async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: "landrace_status", arguments: { item: "99" } });
    expect(textOf(r)).toMatch(/#99 is not an item any source lists/); // reached the tool, as the same item
    await client.close();
  });

  it("refuses a hostile item id before any tool runs", async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: "landrace_status", arguments: { item: "../x" } });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(textOf(r)).toMatch(/item id/);
    expect(textOf(r)).not.toMatch(/404|not an item/);
    await client.close();
  });

  /**
   * The lock a conversation holds is the one that stops a tick resuming the
   * same session underneath it — and a conversation that takes it and never
   * gives it back starves that item for as long as the process lives. A
   * client that disconnects mid-call is the path nothing else covers: the
   * promise is still pending, so only the request's own abort signal ends it.
   */
  it("gives the item's lock back when a client disconnects in the middle of a turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "lr-mcp-"));
    const hanging: Executor = {
      id: "hanging",
      run: (_p, o) =>
        new Promise((_resolve, reject) => {
          o.signal.addEventListener("abort", () => reject(new Error("agent aborted")), { once: true });
        }),
    };
    const { client, gh } = await connect(
      [{ number: 1, labels: ["lr:auto", "lr:stage:spec"] }],
      // A turn is held to what its step declared, so the conversation has to
      // be told what that is — as the loop tells it.
      (t) => createTools([hooked(t.registry,
        loaded({ version: 1, name: "t", description: "test", stages: [{ id: "spec", step: "spec", triggers: [] }] } as Workflow,
          new Map<string, Step>([["spec", { prompt: "write the spec", capabilities: ["repo:read"] }]])),
        { executor: hanging })], t.ctx, { lock: { root } }),
    );
    gh.say(
      1,
      "draft" +
        renderMarker({ stage: "spec", kind: OUTPUT_KIND, round: 1, session: "sid-1", output: { kind: "questions" } }),
    );

    const call = client.callTool({ name: "landrace_ask", arguments: { item: 1, message: "B2B only" } });
    // Polled, not slept for. Both of these used to be a flat 30ms — a bet on
    // how long the handler takes to reach the lock and how long its finally
    // takes to give it back, on a machine running the rest of this suite
    // beside it. Waiting for the fact itself is the same assertion without
    // the bet.
    await until(async () => (await held("1", { root })) !== null, "the turn to take the lock");

    await client.close();
    await call.catch(() => undefined);
    await until(async () => (await held("1", { root })) === null, "the turn to give the lock back");
  });

  it("starting an item is opt-out, and the tool says which it did", async () => {
    const { client, gh } = await connect();
    const r = await client.callTool({
      name: "landrace_create_item",
      arguments: { title: "File for later", start: false },
    });
    expect(JSON.parse(textOf(r))).toMatchObject({ started: false });
    expect(gh.labelsOf(1)).not.toContain("lr:auto");
    await client.close();
  });

  /*
   * The workspace's tools, through the protocol: what reaches a tool is only
   * what its schema names, so a `workflow` the schema forgot would be dropped
   * on the way in and every call would read as one that named none.
   */
  describe("over two workflows", () => {
    const flow = (id: string, label: string): Workflow => ({
      version: 1, name: id, description: `the ${id} flow`, admit: [label],
      eligible: [{ when: { "node.state.labels": { $in: [label] } }, else: `no ${label} label` }],
      stages: [{ id: "spec", entry: true, terminal: true }],
    });
    const both = (t: FakeTracker): Tools => createTools([
      hooked(t.registry, loaded(flow("main", "lr:auto"))),
      hooked(t.registry, loaded(flow("fast", "lr:fast"), new Map(), "fast")),
    ], t.ctx);

    it("lists the workflows, and one workflow's items", async () => {
      const { client } = await connect([{ number: 1, labels: ["lr:auto"] }, { number: 2, labels: ["lr:fast"] }], both);
      const workflows = await client.callTool({ name: "landrace_workflows", arguments: {} });
      expect((JSON.parse(textOf(workflows)) as Array<{ id: string }>).map((w) => w.id)).toEqual(["main", "fast"]);
      const items = await client.callTool({ name: "landrace_items", arguments: { workflow: "fast" } });
      expect(JSON.parse(textOf(items))).toEqual([{ item: "2", title: "issue 2", workflow: "fast", stage: null, lane: "waiting" }]);
      const waiting = await client.callTool({ name: "landrace_waiting", arguments: { workflow: "nope" } });
      expect(textOf(waiting)).toMatch(/error: no workflow "nope"/);
      await client.close();
    });

    // An agent holding a bound server is told so before it calls anything.
    it("says in every tool's description when it acts for one workflow alone", async () => {
      const bound = (t: FakeTracker): Tools => createTools([
        hooked(t.registry, loaded(flow("main", "lr:auto"))),
        hooked(t.registry, loaded(flow("fast", "lr:fast"), new Map(), "fast")),
      ], t.ctx, { scope: "fast" });
      for (const [make, said] of [[bound, true], [both, false]] as const) {
        const { client } = await connect([], make);
        const { tools } = await client.listTools();
        expect(tools.map((t) => [t.name, t.description?.includes("This server acts for workflow fast alone.")]))
          .toEqual(tools.map((t) => [t.name, said]));
        await client.close();
      }
    });

    it("creates an item in the workflow the call names", async () => {
      const { client, gh } = await connect([], both);
      const r = await client.callTool({ name: "landrace_create_item", arguments: { workflow: "fast", title: "Hotfix" } });
      expect(JSON.parse(textOf(r))).toMatchObject({ item: "1", workflow: "fast", started: true });
      expect(gh.labelsOf(1)).toEqual(["lr:fast"]);
      await client.close();
    });
  });
});
