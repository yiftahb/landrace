import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { loadConfig } from "#config/load.js";
import { allowedHosts, frontDoorOrigins } from "#front/hosts.js";
import { createPeoplePanel } from "#people/panel.js";
import { createRoster, pausePath } from "#people/roster.js";
import { createCredentialStore } from "#people/store.js";
import { createLogger } from "#runner/events.js";
import { boardListener } from "#ui/server.js";
import type { BoardView, LandraceEvent, RuntimeContext, UiOptions, WakeResult } from "#namespace.js";

/*
 * #231: the cog menu's Pause my runs and Resume my runs, driven through the
 * server's own listener in-process over a real roster and store — the
 * `pausePath` `start` hands each caller's board.
 */
const PORT = 4545;
const DOOR = { allowedHosts: allowedHosts({ host: "127.0.0.1" }, PORT), origins: frontDoorOrigins({ host: "127.0.0.1" }, PORT).origins };
const ME = { id: "local", email: "dev1@example.invalid" };
const empty: BoardView = { generatedAt: 1, rows: [], nextTickAt: null, folder: "landrace", workspace: "/repo/landrace", workflows: [], needsYou: 0, listed: true };

function drive(opts: UiOptions, path: string, init: { method?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = Object.assign(Readable.from([]), {
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

const post = (action: string, origin = `http://127.0.0.1:${PORT}`) => ({ method: "POST", headers: { "x-landrace-action": action, origin } });

async function world(o: { ready?: boolean } = {}) {
  const dir = join(await mkdtemp(join(tmpdir(), "lr-pause-")), ".landrace");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "landrace.yaml"), "version: 1\nagent: { adapter: claude }\n");
  await writeFile(join(dir, ".env"), "");
  const loaded = await loadConfig(dir);
  const store = createCredentialStore(join(await mkdtemp(join(tmpdir(), "lr-pause-creds-")), "credentials"));
  const events: LandraceEvent[] = [];
  const log = createLogger({ sink: (e) => events.push(e) });
  const roster = createRoster({
    dir: ".", loaded, registry: { connections: new Map() }, store, mode: { remote: false }, admits: () => true, log, local: ME, build: async () => null,
  });
  let wakes = 0;
  const ctx = { config: loaded.config, secrets: new Map(), signal: new AbortController().signal, log: () => {} } as unknown as RuntimeContext;
  const panel = createPeoplePanel({
    store, gate: () => ({ registry: { connections: new Map() }, loaded, ctx }), mode: { remote: false }, log, onChange: async () => {},
  });
  const ui: UiOptions = {
    ...DOOR, view: async () => empty, tick: (): WakeResult => { wakes++; return "started"; },
    people: { panel, caller: () => ME }, ready: () => o.ready ?? true,
    pause: pausePath(roster, ME, () => { wakes++; }),
  };
  return { ui, store, events, roster, wakes: () => wakes };
}

describe("POST /pause and POST /resume", () => {
  it("pauses the caller's runs, says so on /board.json, and logs person.paused once with who", async () => {
    const w = await world();
    expect(JSON.parse((await drive(w.ui, "/board.json")).body)).toEqual({ ...empty, paused: false });

    expect(await drive(w.ui, "/pause", post("pause"))).toEqual({ status: 200, body: "paused" });

    expect(JSON.parse((await drive(w.ui, "/board.json")).body)).toEqual({ ...empty, paused: true });
    expect((await w.store.read("local")).paused).toEqual({ at: expect.any(String) });
    expect(w.events.filter((e) => e.name === "person.paused")).toEqual([{ name: "person.paused", person: "local", personEmail: "dev1@example.invalid" }]);
    expect(w.wakes()).toBe(0);
  });

  it("refuses /tick while paused, never waking the loop, and wakes it again once resumed", async () => {
    const w = await world();
    await drive(w.ui, "/pause", post("pause"));

    expect(await drive(w.ui, "/tick", post("tick"))).toEqual({ status: 409, body: "refused: your runs are paused; resume them to run a tick" });
    expect(w.wakes()).toBe(0);

    expect(await drive(w.ui, "/resume", post("resume"))).toEqual({ status: 200, body: "resumed" });
    // The resume itself wakes the loop, so the next tick picks the items up now.
    expect(w.wakes()).toBe(1);
    expect(JSON.parse((await drive(w.ui, "/board.json")).body)).toEqual({ ...empty, paused: false });
    expect(await drive(w.ui, "/tick", post("tick"))).toEqual({ status: 202, body: "tick started" });
    expect(w.wakes()).toBe(2);
    expect(w.events.filter((e) => e.name === "person.resumed")).toEqual([expect.objectContaining({ person: "local" })]);
  });

  it("keeps the board and the Integrations tab answering while paused", async () => {
    const w = await world();
    await drive(w.ui, "/pause", post("pause"));
    expect((await drive(w.ui, "/board.json")).status).toBe(200);
    expect((await drive(w.ui, "/people/me")).status).toBe(200);
  });

  it.each([
    ["no action header", { method: "POST", headers: {} }],
    ["the tick's header", post("tick")],
    ["the resume's header", post("resume")],
    ["another site's Origin", post("pause", "https://evil.example")],
  ])("refuses a pause with %s 403, and pauses nothing", async (_, init) => {
    const w = await world();
    const res = await drive(w.ui, "/pause", init);
    expect(res).toEqual({ status: 403, body: "refused: this can be asked only from the Landrace page itself" });
    expect(await w.roster.paused("local")).toBe(false);
    expect(w.events).toEqual([]);
  });

  it("refuses GET /pause 405", async () => {
    const w = await world();
    expect((await drive(w.ui, "/pause", { headers: { "x-landrace-action": "pause" } })).status).toBe(405);
  });

  it("404s both routes on a board handed no pause", async () => {
    const w = await world();
    const without: UiOptions = { ...w.ui };
    delete without.pause;
    expect((await drive(without, "/pause", post("pause"))).status).toBe(404);
    expect((await drive(without, "/resume", post("resume"))).status).toBe(404);
    expect(JSON.parse((await drive(without, "/board.json")).body)).toEqual(empty);
  });

  it("pauses a person not running yet, and says so on the Integrations tab's { ready: false }", async () => {
    const w = await world({ ready: false });
    expect(await drive(w.ui, "/pause", post("pause"))).toEqual({ status: 200, body: "paused" });
    expect(JSON.parse((await drive(w.ui, "/board.json")).body)).toEqual({ ready: false, paused: true });
  });

  it("refuses a pause over a credentials file that does not read 502, and writes nothing", async () => {
    const w = await world();
    await mkdir(w.store.root, { recursive: true });
    await writeFile(join(w.store.root, "local.json"), "{ not json");
    const res = await drive(w.ui, "/pause", post("pause"));
    expect(res).toEqual({ status: 502, body: "could not pause; the landrace log says why" });
    expect(w.events).toEqual([]);
  });
});
