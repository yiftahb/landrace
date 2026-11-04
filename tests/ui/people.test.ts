import { mkdtemp, readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { runtimeConfigSchema } from "#config/schema.js";
import { defineConnection } from "#hooks/contracts.js";
import { allowedHosts, frontDoorOrigins } from "#front/hosts.js";
import { createPeoplePanel } from "#people/panel.js";
import { createCredentialStore } from "#people/store.js";
import { createLogger } from "#runner/events.js";
import { boardListener } from "#ui/server.js";
import type { BoardView, ConnectionDef, LoadedConfig, RuntimeContext, UiOptions, WakeResult } from "#namespace.js";

/*
 * The Integrations tab's three routes, driven through the server's own
 * request listener in-process, over the real panel and a temporary store.
 */
const PORT = 4545;
const DOOR = { allowedHosts: allowedHosts({ host: "127.0.0.1" }, PORT), origins: frontDoorOrigins({ host: "127.0.0.1" }, PORT).origins };
const TOKEN = "ghp_pasted_token_long_enough";
const ME = { id: "local" };
const empty: BoardView = { generatedAt: 1, rows: [], nextTickAt: null, folder: "landrace", workspace: "/repo/landrace", workflows: [], needsYou: 0, listed: true };

function drive(opts: UiOptions, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = Object.assign(Readable.from(init.body === undefined ? [] : [Buffer.from(init.body)]), {
      method: init.method ?? "GET", url: path, headers: { host: `127.0.0.1:${PORT}`, ...init.headers },
    });
    let status = 0;
    const res = {
      writeHead(s: number) { status = s; return res; },
      end(b?: string) { resolve({ status, body: String(b ?? "") }); },
    };
    boardListener(opts)(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  });
}

const post = (action: string, body?: unknown) => ({
  method: "POST", headers: { "x-landrace-action": action, origin: `http://127.0.0.1:${PORT}` },
  ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
});

const config = runtimeConfigSchema.parse({ version: 1, agent: { adapter: "claude" }, secrets: { forgeToken: { perPerson: true, connection: "x.token" } } });
const loaded: LoadedConfig = { config, missing: [], secretValues: new Map(), vars: new Map(), telemetry: new Map(), missingVars: [], missingGit: [], missingPerson: [] };

async function world(opts: { check?: ConnectionDef["check"]; reload?: () => Promise<void> } = {}) {
  const root = join(await mkdtemp(join(tmpdir(), "lr-people-routes-")), "credentials");
  const store = createCredentialStore(root);
  const printed: string[] = [];
  const log = createLogger({ sink: (e) => printed.push(JSON.stringify(e)) });
  const defs = [
    defineConnection({ id: "x", label: "X", kind: "credential", fields: ["token"], paste: { hint: "an X token" }, ...(opts.check ? { check: opts.check } : {}) }),
    defineConnection({ id: "who", label: "Who", kind: "identity", fields: ["user"] }),
  ];
  let ready = false;
  const ctx = { config, secrets: new Map(), signal: new AbortController().signal, log: () => {} } as unknown as RuntimeContext;
  const panel = createPeoplePanel({
    store, registry: { connections: new Map(defs.map((d) => [d.id, d])) }, loaded, mode: { remote: false }, ctx, log,
    onChange: async () => {
      await opts.reload?.();
      ready = (await store.read("local")).connections["x"] !== undefined;
    },
  });
  let wakes = 0;
  const ui: UiOptions = {
    ...DOOR, view: async () => empty, tick: (): WakeResult => { wakes++; return "started"; },
    people: { panel, caller: () => ME }, ready: () => ready,
  };
  return { ui, root, store, printed, wakes: () => wakes };
}

describe("the Integrations tab's routes", () => {
  it("GET /people/me lists a required connection missing, and the person not ready", async () => {
    const { ui } = await world();
    const res = await drive(ui, "/people/me");
    expect(res.status).toBe(200);
    const me = JSON.parse(res.body) as { ready: boolean; connections: Array<{ id: string; state: string }>; hints: Record<string, string> };
    expect(me.ready).toBe(false);
    expect(me.connections.find((c) => c.id === "x")?.state).toBe("missing");
    expect(me.hints).toEqual({ x: "an X token" });
  });

  it("POST /connect/x stores the pasted value, answers connected, and /people/me is then ready", async () => {
    const { ui, root, printed } = await world();
    const res = await drive(ui, "/connect/x", post("connect", { fields: { token: TOKEN } }));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ id: "x", state: "connected" });
    expect(JSON.parse((await drive(ui, "/people/me")).body)).toMatchObject({ ready: true });
    expect(await readFile(join(root, "local.json"), "utf8")).toContain(TOKEN);
    expect(printed.some((l) => l.includes("person.connected"))).toBe(true);
    expect(printed.join("\n")).not.toContain(TOKEN);
  });

  it.each([
    ["no action header", { method: "POST", headers: { origin: `http://127.0.0.1:${PORT}` }, body: JSON.stringify({ fields: { token: TOKEN } }) }],
    ["another write's header", { ...post("disconnect", { fields: { token: TOKEN } }) }],
    ["a foreign origin", { method: "POST", headers: { "x-landrace-action": "connect", origin: "http://evil.example" }, body: JSON.stringify({ fields: { token: TOKEN } }) }],
  ])("refuses a connect with %s, storing nothing", async (_what, init) => {
    const { ui, store } = await world();
    expect((await drive(ui, "/connect/x", init)).status).toBe(403);
    expect((await store.read("local")).connections).toEqual({});
  });

  it("refuses a body over 16 KiB with 413, storing nothing", async () => {
    const { ui, store } = await world();
    const res = await drive(ui, "/connect/x", post("connect", { fields: { token: "a".repeat(16 * 1024) } }));
    expect(res.status).toBe(413);
    expect((await store.read("local")).connections).toEqual({});
  });

  it.each([
    ["not JSON", "{ token"],
    ["no fields", { token: TOKEN }],
    ["a field that is not text", { fields: { token: 7 } }],
  ])("refuses a body that is %s with 400", async (_what, body) => {
    const { ui } = await world();
    expect((await drive(ui, "/connect/x", post("connect", body))).status).toBe(400);
  });

  it.each([
    ["an identity", "/connect/who", { fields: { user: "dev1" } }],
    ["an unknown id", "/connect/nope", { fields: { token: TOKEN } }],
  ])("refuses %s with 409", async (_what, path, body) => {
    const { ui, store } = await world();
    const res = await drive(ui, path, post("connect", body));
    expect(res.status).toBe(409);
    expect((await store.read("local")).connections).toEqual({});
  });

  it("refuses a value its check fails with 409, the reason scrubbed, and the store unchanged", async () => {
    const { ui, store, printed } = await world({ check: async (v) => `rejected ${v.fields["token"] ?? ""}` });
    const res = await drive(ui, "/connect/x", post("connect", { fields: { token: TOKEN } }));
    expect(res.status).toBe(409);
    expect(res.body).toContain("rejected [redacted]");
    expect(res.body).not.toContain(TOKEN);
    expect((await store.read("local")).connections).toEqual({});
    expect(printed.join("\n")).not.toContain(TOKEN);
  });

  it("answers 502, scrubbed, when the reload after a connect fails, and keeps the connection", async () => {
    const { ui, store } = await world({ reload: async () => { throw new Error(`build said ${TOKEN}`); } });
    const res = await drive(ui, "/connect/x", post("connect", { fields: { token: TOKEN } }));
    expect(res.status).toBe(502);
    expect(res.body).toMatch(/"x" is connected, but Landrace could not reload with it: build said \[redacted\]/);
    expect((await store.read("local")).connections["x"]).toBeDefined();
  });

  it("POST /disconnect/x removes it, under its own header", async () => {
    const { ui, store } = await world();
    await drive(ui, "/connect/x", post("connect", { fields: { token: TOKEN } }));
    expect((await drive(ui, "/disconnect/x", post("connect"))).status).toBe(403);
    expect((await drive(ui, "/disconnect/x", post("disconnect"))).status).toBe(200);
    expect((await store.read("local")).connections).toEqual({});
    expect((await drive(ui, "/disconnect/nope", post("disconnect"))).status).toBe(409);
  });

  it("is a write: GET /connect/x is refused, and POST /people/me is too", async () => {
    const { ui } = await world();
    expect((await drive(ui, "/connect/x", { headers: { "x-landrace-action": "connect" } })).status).toBe(405);
    expect((await drive(ui, "/people/me", post("me"))).status).toBe(405);
  });

  it("is not there when the server was given no panel", async () => {
    const bare: UiOptions = { ...DOOR, view: async () => empty };
    expect((await drive(bare, "/people/me")).status).toBe(404);
    expect((await drive(bare, "/connect/x", post("connect", { fields: { token: TOKEN } }))).status).toBe(404);
  });
});

describe("the board while the person is not ready", () => {
  it("answers /board.json with { ready: false }, never asking the board", async () => {
    const { ui } = await world();
    let asked = 0;
    const res = await drive({ ...ui, view: async () => { asked++; return empty; } }, "/board.json");
    expect([res.status, JSON.parse(res.body), asked]).toEqual([200, { ready: false }, 0]);
  });

  it.each([
    ["/tick", "tick"], ["/refresh", "refresh"], ["/items/19/retry", "retry"], ["/items/19/goto/spec", "goto"],
    ["/items/19/admit/main", "admit"], ["/items/19/reply", "reply"],
  ])("refuses POST %s with 409, and wakes nothing", async (path, action) => {
    const { ui, wakes } = await world();
    const wired: UiOptions = {
      ...ui,
      refresh: async () => { throw new Error("refreshed"); },
      goto: { send: async () => { throw new Error("sent"); } },
      admit: async () => { throw new Error("admitted"); },
      panel: { reply: async () => { throw new Error("replied"); } } as unknown as NonNullable<UiOptions["panel"]>,
    };
    const res = await drive(wired, path, { ...post(action), body: "hi" });
    expect(res.status).toBe(409);
    expect(res.body).toMatch(/Integrations/);
    expect(wakes()).toBe(0);
  });

  it("serves the page itself, so the tab can be reached", async () => {
    const { ui } = await world();
    expect((await drive(ui, "/")).status).toBe(200);
    expect((await drive(ui, "/app.js")).status).toBe(200);
  });
});
