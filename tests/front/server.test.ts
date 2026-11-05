import type { IncomingMessage } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { BoardView, FrontDoorOptions, ItemPanel, Person, Tools } from "#namespace.js";
import { createMcpEndpoint } from "#front/mcp.js";
import { frontDoorListener } from "#front/server.js";
import { createTools } from "#mcp/tools.js";
import { ANY, hooked, loaded } from "#tests/support/loaded.js";
import { createFakeTracker } from "#tests/support/fake-tracker.js";
import { memoryFetch } from "#tests/support/memory-http.js";

/*
 * #185: one front door, each request its caller's. The caller is named by a
 * header here, as a test's stand-in for `callerOf`; locally it is always the
 * local person. Alice's board holds #1, bob's #2.
 */
const PORT = 4545;
const DOOR = `http://127.0.0.1:${PORT}`;
const PEOPLE: Record<string, Person> = { alice: { id: "alice" }, bob: { id: "bob" } };
const ITEMS: Record<string, number> = { alice: 1, bob: 2 };
const view = (id: string): BoardView => ({
  generatedAt: 1, rows: [], nextTickAt: null, folder: id, workspace: "/repo", workflows: [], needsYou: 0, listed: true,
});
const callerOf = (req: IncomingMessage): Person | null => {
  const who = req.headers["x-test-person"];
  return typeof who === "string" ? PEOPLE[who] ?? null : null;
};

/** A panel that reads every item's activity as nothing, so a 200 says the route reached it. */
const panel = { activity: async () => ({ lines: [], next: 0 }) } as unknown as ItemPanel;

function door(o: { pairing?: boolean } = {}) {
  const trackers = { alice: createFakeTracker([{ number: ITEMS.alice ?? 0 }]), bob: createFakeTracker([{ number: ITEMS.bob ?? 0 }]) };
  const mcp = createMcpEndpoint({
    workflows: ["main"],
    ...(o.pairing === undefined ? {} : { pairing: o.pairing }),
    toolsFor: (caller): Tools => {
      const tracker = caller.id === "bob" ? trackers.bob : trackers.alice;
      return createTools([hooked(tracker.registry, loaded(ANY, new Map(), "main"))], tracker.ctx);
    },
  });
  const opts: FrontDoorOptions = {
    host: "127.0.0.1", port: PORT, mcp, callerOf,
    board: { view: async () => view("nobody's") },
    boardFor: (caller) => ({
      view: async () => view(caller.id), panel,
      has: (item) => item === String(ITEMS[caller.id]),
      ...(o.pairing === undefined ? {} : { pairing: o.pairing }),
    }),
  };
  return { fetch: memoryFetch(frontDoorListener(opts, PORT)), mcp };
}

/** A fetch that names `person` as the caller on every request. */
const as = (fetch: typeof globalThis.fetch, person: string): typeof globalThis.fetch =>
  (input, init) => fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), "x-test-person": person } });

async function connect(fetch: typeof globalThis.fetch): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const client = new Client({ name: "test", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${DOOR}/mcp`), { fetch });
  await client.connect(transport as unknown as Transport);
  return { client, transport };
}

const textOf = (r: unknown): string => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

describe("the front door, for many people", () => {
  it("answers a request from nobody it knows with 401, the board and /mcp alike", async () => {
    const { fetch } = door();
    for (const path of ["/board.json", "/items/1/activity", "/mcp"]) expect((await fetch(`${DOOR}${path}`)).status).toBe(401);
  });

  it("serves each caller their own board", async () => {
    const { fetch } = door();
    expect(((await (await as(fetch, "alice")(`${DOOR}/board.json`)).json()) as BoardView).folder).toBe("alice");
    expect(((await (await as(fetch, "bob")(`${DOOR}/board.json`)).json()) as BoardView).folder).toBe("bob");
  });

  it("answers alice's request for bob's item 404, on every item route, and serves her own", async () => {
    const { fetch } = door();
    const alice = as(fetch, "alice");
    expect((await alice(`${DOOR}/items/1/activity`)).status).toBe(200);
    for (const [method, path] of [["GET", "/items/2/activity"], ["POST", "/items/2/reply"], ["POST", "/items/2/retry"], ["POST", "/items/2/goto/spec"], ["POST", "/items/2/admit/main"]] as const) {
      expect((await alice(`${DOOR}${path}`, { method, headers: { "x-landrace-action": "reply" } })).status).toBe(404);
    }
  });

  it("lists alice's items only in her MCP session, and answers bob naming her session 404", async () => {
    const { fetch, mcp } = door();
    const alice = await connect(as(fetch, "alice"));
    const listed = textOf(await alice.client.callTool({ name: "landrace_items", arguments: {} }));
    expect(listed).toContain('"1"');
    expect(listed).not.toContain('"2"');

    const session = alice.transport.sessionId ?? "";
    expect(session).not.toBe("");
    const stolen = await as(fetch, "bob")(`${DOOR}/mcp`, {
      method: "POST", headers: { "mcp-session-id": session, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
    });
    expect(stolen.status).toBe(404);
    await alice.client.close();
    await mcp.close();
  });

  it("ends one person's sessions alone when asked to", async () => {
    const { fetch, mcp } = door();
    const alice = await connect(as(fetch, "alice"));
    const bob = await connect(as(fetch, "bob"));
    await mcp.close("alice");
    await expect(alice.client.listTools()).rejects.toThrow();
    expect((await bob.client.listTools()).tools.length).toBeGreaterThan(0);
    await bob.client.close();
    await mcp.close();
  });

  it("offers no pairing tool or route when pairing is off, and both when it is on", async () => {
    const off = door({ pairing: false });
    const client = await connect(as(off.fetch, "alice"));
    const names = (await client.client.listTools()).tools.map((t) => t.name);
    expect(names).not.toEqual(expect.arrayContaining(["landrace_pair"]));
    expect(names.filter((n) => ["landrace_pair", "landrace_finish", "landrace_release"].includes(n))).toEqual([]);
    expect((await as(off.fetch, "alice")(`${DOOR}/items/1/pairing`)).status).toBe(404);
    await client.client.close();
    await off.mcp.close();

    const on = door();
    const paired = await connect(as(on.fetch, "alice"));
    expect((await paired.client.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(["landrace_pair", "landrace_finish", "landrace_release"]));
    await paired.client.close();
    await on.mcp.close();
  });
});
