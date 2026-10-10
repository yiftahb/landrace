import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { AdmitResult, BoardView, UiOptions, WakeResult } from "#namespace.js";
import { Refusal } from "#runner/errors.js";
import { boardListener } from "#ui/server.js";

/*
 * The page's Start work, POST /items/<id>/admit/<workflow>, driven through
 * the server's own request listener in-process, as the panel's routes are.
 */
const PORT = 4545;
const empty: BoardView = { generatedAt: 1, rows: [], nextTickAt: null, folder: "landrace", workspace: "/repo/landrace", workflows: [], needsYou: 0, listed: true };

function drive(opts: UiOptions, path: string, init: { method?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = Object.assign(Readable.from([]), { method: init.method ?? "GET", url: path, headers: { host: `127.0.0.1:${PORT}`, ...init.headers } });
    let status = 0;
    const res = {
      writeHead(s: number) { status = s; return res; },
      end(b?: string) { resolve({ status, body: String(b ?? "") }); },
    };
    boardListener(opts, () => PORT)(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  });
}

const ours = { method: "POST", headers: { "x-landrace-action": "admit", origin: `http://127.0.0.1:${PORT}` } };

function world(admit: (item: string, workflow: string) => Promise<AdmitResult> = async (item, workflow) => ({ item, workflow, labels: ["lr:auto"] })) {
  const calls: string[][] = [];
  let wakes = 0;
  const opts: UiOptions = {
    port: 0, view: async () => empty, tick: (): WakeResult => { wakes++; return "started"; },
    admit: async (item, workflow) => { calls.push([item, workflow]); return admit(item, workflow); },
  };
  return { opts, calls, wakes: () => wakes };
}

describe("the page's Start work", () => {
  it("admits the item to the workflow its path names, and wakes the loop", async () => {
    const { opts, calls, wakes } = world();
    const res = await drive(opts, "/items/19/admit/full-cycle", ours);
    expect(res).toEqual({ status: 202, body: "admitted #19 to full-cycle: added lr:auto; the next tick starts it" });
    expect(calls).toEqual([["19", "full-cycle"]]);
    expect(wakes()).toBe(1);
  });

  it.each([
    ["no header", { "x-landrace-action": undefined }],
    ["another write's header", { "x-landrace-action": "goto" }],
    ["a foreign origin", { origin: "http://evil.example" }],
    ["a cross-site fetch", { "sec-fetch-site": "cross-site" }],
  ])("refuses a post with %s, and admits nothing", async (_what, over) => {
    const { opts, calls, wakes } = world();
    const headers = Object.fromEntries(Object.entries({ ...ours.headers, ...over }).filter(([, v]) => v !== undefined)) as Record<string, string>;
    expect((await drive(opts, "/items/19/admit/fast", { method: "POST", headers })).status).toBe(403);
    expect([calls, wakes()]).toEqual([[], 0]);
  });

  it("is a write: a GET is refused", async () => {
    const { opts, calls } = world();
    expect((await drive(opts, "/items/19/admit/fast", { headers: ours.headers })).status).toBe(405);
    expect(calls).toEqual([]);
  });

  it("is not there when the server was given no way to admit", async () => {
    expect((await drive({ port: 0, view: async () => empty }, "/items/19/admit/fast", ours)).status).toBe(404);
  });

  it("refuses a malformed item or workflow before asking anything", async () => {
    const { opts, calls } = world();
    expect((await drive(opts, "/items/..%2F19/admit/fast", ours)).status).toBe(400);
    expect((await drive(opts, "/items/19/admit/fa%0Ast", ours)).status).toBe(400);
    expect((await drive(opts, "/items/19/admit/%E0%A4%A", ours)).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("shows a refusal's sentence, and wakes nothing", async () => {
    const { opts, wakes } = world(async () => { throw new Refusal("#19 would be claimed by fast, not full, with lr:auto added"); });
    expect(await drive(opts, "/items/19/admit/full", ours)).toEqual({ status: 409, body: "#19 would be claimed by fast, not full, with lr:auto added" });
    expect(wakes()).toBe(0);
  });

  it("gives a fixed sentence when the tracker fails, never its words", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { opts } = world(async () => { throw new Error("401 token ghp_secret rejected"); });
    const res = await drive(opts, "/items/19/admit/full", ours);
    expect(res).toEqual({ status: 502, body: "could not start work on it; the landrace log says why" });
    spy.mockRestore();
  });
});
