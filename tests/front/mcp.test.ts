import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { BoardView, FrontDoorOptions, Tools } from "#namespace.js";
import { createMcpEndpoint } from "#front/mcp.js";
import { mcpEndpointFor } from "#cli/start.js";
import { frontDoorListener } from "#front/server.js";
import { createTools } from "#mcp/tools.js";
import { ANY, hooked, loaded } from "#tests/support/loaded.js";
import { createFakeTracker } from "#tests/support/fake-tracker.js";
import { memoryFetch } from "#tests/support/memory-http.js";

const PORT = 4545;
const DOOR = `http://127.0.0.1:${PORT}`;
const empty: BoardView = { generatedAt: 1, rows: [], nextTickAt: null, folder: "landrace", workspace: "/repo/landrace", workflows: [], needsYou: 0, listed: true };

/** Two workflows on one tracker, served as `landrace start` serves them, and every tools built, by scope. */
function door(over: Partial<FrontDoorOptions> = {}) {
  const tracker = createFakeTracker([{ number: 1 }]);
  const workflows = [hooked(tracker.registry, loaded(ANY, new Map(), "a")), hooked(tracker.registry, loaded(ANY, new Map(), "b"))];
  const scopes: Array<string | undefined> = [];
  let wakes = 0;
  const mcp = createMcpEndpoint({
    workflows: workflows.map((w) => w.id),
    toolsFor: (_caller, scope): Tools => {
      scopes.push(scope);
      return createTools(workflows, tracker.ctx, { wake: () => { wakes++; }, ...(scope === undefined ? {} : { scope }) });
    },
  });
  const opts: FrontDoorOptions = { host: "127.0.0.1", port: PORT, board: { view: async () => empty }, mcp, ...over };
  return { fetch: memoryFetch(frontDoorListener(opts, PORT)), scopes, wakes: () => wakes, mcp };
}

async function connect(fetch: typeof globalThis.fetch, url: string): Promise<Client> {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { fetch }) as unknown as Transport);
  return client;
}

const textOf = (r: unknown): string => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

describe("the front door's /mcp", () => {
  it("lists all 15 landrace tools to an SDK client over Streamable HTTP", async () => {
    const { fetch, mcp } = door();
    const client = await connect(fetch, `${DOOR}/mcp`);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toHaveLength(15);
    expect(names.every((n) => n.startsWith("landrace_"))).toBe(true);
    await client.close();
    await mcp.close();
  });

  it("scopes a session to ?workflow=<id> at its initialize, and every other to the whole workspace", async () => {
    const { fetch, mcp, scopes } = door();
    const whole = await connect(fetch, `${DOOR}/mcp`);
    const scoped = await connect(fetch, `${DOOR}/mcp?workflow=a`);
    const ids = async (c: Client) => (JSON.parse(textOf(await c.callTool({ name: "landrace_workflows", arguments: {} }))) as Array<{ id: string }>).map((w) => w.id);
    expect(await ids(whole)).toEqual(["a", "b"]);
    expect(await ids(scoped)).toEqual(["a"]);
    const described = (await scoped.listTools()).tools.find((t) => t.name === "landrace_items")?.description;
    expect(described).toContain("This server acts for workflow a alone.");
    expect(scopes).toEqual([undefined, "a"]);
    await whole.close();
    await scoped.close();
    await mcp.close();
  });

  it("refuses an initialize scoped to a workflow the workspace does not have, making no session", async () => {
    const { fetch, scopes } = door();
    await expect(connect(fetch, `${DOOR}/mcp?workflow=ghost`)).rejects.toThrow();
    const r = await fetch(`${DOOR}/mcp?workflow=ghost`, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
    });
    expect(r.status).toBe(400);
    expect(await r.text()).toBe('no workflow "ghost"; the workspace has a, b');
    expect(scopes).toEqual([]);
  });

  it("answers an unknown session 404, and a request with none that is not an initialize 400", async () => {
    const { fetch } = door();
    const call = { jsonrpc: "2.0", id: 2, method: "tools/list" };
    const unknown = await fetch(`${DOOR}/mcp`, { method: "POST", headers: { "mcp-session-id": "nope", "content-type": "application/json" }, body: JSON.stringify(call) });
    expect(unknown.status).toBe(404);
    const none = await fetch(`${DOOR}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(call) });
    expect(none.status).toBe(400);
  });

  it("refuses a foreign Host with 421 before routing, on /mcp as on the board", async () => {
    const { fetch } = door();
    for (const path of ["/", "/board.json", "/mcp"]) {
      expect((await fetch(`http://evil.example:${PORT}${path}`)).status).toBe(421);
    }
  });

  it("refuses /mcp from a foreign Origin with 403, and lets the door's own through", async () => {
    const { fetch, mcp } = door();
    const r = await fetch(`${DOOR}/mcp`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(403);
    const ours = await fetch(`${DOOR}/mcp`, { method: "POST", headers: { origin: DOOR, "content-type": "application/json" }, body: "{}" });
    expect(ours.status).toBe(400);
    await mcp.close();
  });

  it("still serves the board's own routes beside it", async () => {
    const { fetch } = door();
    expect((await fetch(`${DOOR}/`)).status).toBe(200);
    expect(await (await fetch(`http://localhost:${PORT}/board.json`)).json()).toEqual(empty);
  });

  it("is 404 when the door was handed no endpoint", async () => {
    const { fetch } = door({ mcp: undefined as never });
    expect((await fetch(`${DOOR}/mcp`, { method: "POST", body: "{}" })).status).toBe(404);
  });

  it("wakes the loop's own schedule after a person's write, with no wake file", async () => {
    const tracker = createFakeTracker([{ number: 4 }]);
    const wake = jest.fn(() => "started" as const);
    const mcp = mcpEndpointFor({ workflows: [], ctx: tracker.ctx, toolWorkflows: [hooked(tracker.registry, loaded(ANY))] }, { wake });
    const fetch = memoryFetch(frontDoorListener({ host: "127.0.0.1", port: PORT, board: { view: async () => empty }, mcp }, PORT));
    const client = await connect(fetch, `${DOOR}/mcp`);
    await client.callTool({ name: "landrace_items", arguments: {} });
    expect(wake).not.toHaveBeenCalled();
    const r = await client.callTool({ name: "landrace_reply", arguments: { item: "4", message: "go ahead" } });
    expect(r.isError).toBeFalsy();
    expect(wake).toHaveBeenCalledTimes(1);
    await client.close();
    await mcp.close();
  });

  /*
   * #209: each session holds a server and its transport in memory, and
   * nothing ended one but the client, so one person could open them forever.
   */
  it("closes a person's oldest session when they open a 17th, and nobody else's", async () => {
    const { fetch, mcp } = door({ callerOf: (req) => ({ id: String(req.headers["x-who"] ?? "nobody") }) });
    const as = (who: string): typeof globalThis.fetch => (input, init) =>
      fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), "x-who": who } });
    const bobs = await connect(as("bob"), `${DOOR}/mcp`);
    const alices: Client[] = [];
    for (let i = 0; i < 17; i++) alices.push(await connect(as("alice"), `${DOOR}/mcp`));
    const [first, second, ...rest] = alices;
    if (first === undefined || second === undefined) throw new Error("no sessions");
    await expect(first.listTools()).rejects.toThrow(/404|no such MCP session/);
    expect((await second.listTools()).tools.length).toBeGreaterThan(0);
    expect((await rest[rest.length - 1]?.listTools())?.tools.length).toBeGreaterThan(0);
    expect((await bobs.listTools()).tools.length).toBeGreaterThan(0);
    await mcp.close();
  });

  it("refuses a body far past any tool call with 413", async () => {
    const { fetch } = door();
    const r = await fetch(`${DOOR}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: `"${"x".repeat(2 * 1024 * 1024)}"` });
    expect(r.status).toBe(413);
  });
});
