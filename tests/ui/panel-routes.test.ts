import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ActivityPage, BoardView, ConversationLine, ItemPanel, UiOptions, WakeResult } from "#namespace.js";
import { boardListener } from "#ui/server.js";

/*
 * The item panel's routes, driven through the server's own request
 * listener in-process: the same function serveBoard hands createServer, with
 * no socket in between, so what is pinned here is what the page reaches.
 */
const PORT = 4545;
const empty: BoardView = { generatedAt: 1, rows: [], nextTickAt: null, folder: "landrace", workspace: "/repo/landrace", workflows: [], needsYou: 0 };
const ORIGIN = `http://127.0.0.1:${PORT}`;

interface Answer { status: number; body: string; headers: Record<string, unknown> }

function drive(opts: UiOptions, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Answer> {
  return new Promise((resolve) => {
    const req = Object.assign(Readable.from(init.body === undefined ? [] : [Buffer.from(init.body)]), {
      method: init.method ?? "GET",
      url: path,
      headers: { host: `127.0.0.1:${PORT}`, ...init.headers },
    });
    let status = 0;
    let headers: Record<string, unknown> = {};
    const res = {
      writeHead(s: number, h: Record<string, unknown>) { status = s; headers = h; return res; },
      end(b?: string) { resolve({ status, headers, body: String(b ?? "") }); },
    };
    boardListener(opts, () => PORT)(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  });
}

const PAGE: ActivityPage = { stage: "build", round: 2, lines: [{ kind: "tool", text: "Read a.ts", at: 5 }], total: 3 };
const LINES: ConversationLine[] = [{ at: "2026-01-01T00:00:01Z", by: "landrace", byAgent: true, kind: "output", stage: "spec", round: 1, text: "Questions" }];

/** A panel that writes down every call, and a tick that counts its wakes. */
function world(over: Partial<ItemPanel> = {}) {
  const calls: unknown[][] = [];
  let wakes = 0;
  const panel: ItemPanel = {
    activity: async (...a) => { calls.push(["activity", ...a]); return PAGE; },
    conversation: async (...a) => { calls.push(["conversation", ...a]); return LINES; },
    reply: async (...a) => { calls.push(["reply", ...a]); },
    ask: async (...a) => { calls.push(["ask", ...a]); return { reply: "Understood.", resolved: true }; },
    resolve: async (...a) => { calls.push(["resolve", ...a]); return { alreadyResolved: false }; },
    pairing: async (...a) => { calls.push(["pairing", ...a]); return { open: null, offers: [{ stage: "spec", round: 1, continue: false }] }; },
    pair: async (...a) => {
      calls.push(["pair", ...a]);
      return { stage: "spec", round: 1, session: "s", cwd: "/w/7.pair", command: "cd /w/7.pair && agent" };
    },
    finish: async (...a) => { calls.push(["finish", ...a]); return { stage: "spec", round: 1, discarded: [] }; },
    release: async (...a) => { calls.push(["release", ...a]); return { stage: "spec", round: 1 }; },
    ...over,
  };
  const opts: UiOptions = { port: 0, view: async () => empty, panel, tick: (): WakeResult => { wakes++; return "started"; } };
  return { opts, calls, wakes: () => wakes };
}

const write = (action: string, body?: string, headers: Record<string, string> = {}) => ({
  method: "POST", headers: { "x-landrace-action": action, origin: ORIGIN, ...headers }, ...(body === undefined ? {} : { body }),
});

describe("the item panel's routes", () => {
  it("are not there at all when the server was given no panel", async () => {
    const opts: UiOptions = { port: 0, view: async () => empty };
    for (const [path, init] of [
      ["/items/7/activity", {}], ["/items/7/conversation", { headers: { "x-landrace-action": "conversation" } }],
      ["/items/7/reply", write("reply", "hi")], ["/items/7/ask", write("ask", "hi")], ["/items/7/resolve", write("resolve")],
    ] as const) {
      expect((await drive(opts, path, init)).status).toBe(404);
    }
  });

  it("still refuses a foreign Host before anything else", async () => {
    const { opts, calls } = world();
    expect((await drive(opts, "/items/7/reply", { ...write("reply", "hi"), headers: { host: "evil.example" } })).status).toBe(421);
    expect(calls).toEqual([]);
  });
});

describe("GET /items/<id>/activity", () => {
  it("answers the item's activity from the line asked for, as JSON", async () => {
    const { opts, calls } = world();
    const res = await drive(opts, "/items/7/activity?after=2");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(JSON.parse(res.body)).toEqual(PAGE);
    expect(calls).toEqual([["activity", "7", 2]]);
  });

  it("reads from the first line when no line is named", async () => {
    const { opts, calls } = world();
    await drive(opts, "/items/7/activity");
    expect(calls).toEqual([["activity", "7", 0]]);
  });

  it("refuses a line that is not a whole number, and an item id that is not one", async () => {
    const { opts, calls } = world();
    expect((await drive(opts, "/items/7/activity?after=-1")).status).toBe(400);
    expect((await drive(opts, "/items/7/activity?after=x")).status).toBe(400);
    expect((await drive(opts, "/items/..%2F7/activity")).status).toBe(400);
    expect((await drive(opts, "/items/%E0/activity")).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("answers only GET", async () => {
    const { opts } = world();
    expect((await drive(opts, "/items/7/activity", { method: "POST" })).status).toBe(405);
  });
});

describe("GET /items/<id>/conversation", () => {
  it("answers the item's conversation to the page's own script", async () => {
    const { opts, calls } = world();
    const res = await drive(opts, "/items/7/conversation", { headers: { "x-landrace-action": "conversation", origin: ORIGIN } });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual(LINES);
    expect(calls).toEqual([["conversation", "7"]]);
  });

  // It spends a tracker read, which a cross-site <img> could otherwise make
  // the operator's token pay for — the reason /refresh is guarded too.
  it("refuses a read without the page's header, and reads nothing", async () => {
    const { opts, calls } = world();
    expect((await drive(opts, "/items/7/conversation")).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("says the log has the reason when the read fails, without echoing it", async () => {
    const said = jest.spyOn(console, "error").mockImplementation(() => {});
    const { opts } = world({ conversation: async () => { throw new Error("token ghp_x refused #7"); } });
    const res = await drive(opts, "/items/7/conversation", { headers: { "x-landrace-action": "conversation" } });
    said.mockRestore();
    expect(res.status).toBe(502);
    expect(res.body).not.toContain("ghp_x");
  });
});

describe("the panel's writes: POST /items/<id>/reply, /ask and /resolve", () => {
  it.each([
    ["no header at all — what a cross-site <form> sends", { "x-landrace-action": "" }],
    ["another write's header", { "x-landrace-action": "ask" }],
    ["a foreign Origin", { origin: "https://evil.example" }],
    ["a browser that says it came from another site", { "sec-fetch-site": "cross-site" }],
  ])("refuses a reply with %s, and posts nothing", async (_, headers) => {
    const { opts, calls, wakes } = world();
    const res = await drive(opts, "/items/7/reply", write("reply", "hi", headers));
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
    expect(wakes()).toBe(0);
  });

  it.each(["ask", "resolve"])("refuses %s without its own header", async (action) => {
    const { opts, calls } = world();
    expect((await drive(opts, `/items/7/${action}`, write("reply", "hi"))).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("posts a reply with the words it was sent, and does not wake the loop", async () => {
    const { opts, calls, wakes } = world();
    const res = await drive(opts, "/items/7/reply", write("reply", "B2B only, please"));
    expect(res.status).toBe(200);
    expect(calls).toEqual([["reply", "7", "B2B only, please"]]);
    expect(wakes()).toBe(0);
  });

  it("asks the step and answers with its reply, then wakes the loop", async () => {
    const { opts, calls, wakes } = world();
    const res = await drive(opts, "/items/7/ask", write("ask", "Which markets?"));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ reply: "Understood.", resolved: true });
    expect(calls).toEqual([["ask", "7", "Which markets?"]]);
    expect(wakes()).toBe(1);
  });

  it("hands the item back, says whether it already was, and wakes the loop", async () => {
    const { opts, calls, wakes } = world();
    const res = await drive(opts, "/items/7/resolve", write("resolve"));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ alreadyResolved: false });
    expect(calls).toEqual([["resolve", "7"]]);
    expect(wakes()).toBe(1);
  });

  it("refuses an empty reply or question, and sends nothing", async () => {
    const { opts, calls } = world();
    expect((await drive(opts, "/items/7/reply", write("reply", "  \n"))).status).toBe(400);
    expect((await drive(opts, "/items/7/ask", write("ask"))).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("refuses a body far past anything a record can carry, and sends nothing", async () => {
    const { opts, calls } = world();
    expect((await drive(opts, "/items/7/reply", write("reply", "x".repeat(300 * 1024)))).status).toBe(413);
    expect(calls).toEqual([]);
  });

  it("refuses an item id that is not one, and a GET", async () => {
    const { opts, calls } = world();
    expect((await drive(opts, "/items/a%20b/reply", write("reply", "hi"))).status).toBe(400);
    expect((await drive(opts, "/items/7/reply")).status).toBe(405);
    expect(calls).toEqual([]);
  });

  it("says why a write failed, on one line, and wakes nothing", async () => {
    const said = jest.spyOn(console, "error").mockImplementation(() => {});
    const { opts, wakes } = world({
      ask: async () => { throw new Error("cannot ask: #7 has no session to join yet:\nno step on it has produced a draft"); },
    });
    const res = await drive(opts, "/items/7/ask", write("ask", "hi"));
    said.mockRestore();
    expect(res.status).toBe(502);
    expect(res.body).toBe("cannot ask: #7 has no session to join yet: no step on it has produced a draft");
    expect(wakes()).toBe(0);
  });

  it("carries the CSP and no-store headers on a panel answer", async () => {
    const { opts } = world();
    const res = await drive(opts, "/items/7/reply", write("reply", "hi"));
    expect(String(res.headers["content-security-policy"])).toContain("default-src 'none'");
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe("the panel's Pairing section", () => {
  it("reads what may be paired on, from the page's own script only — it spends a tracker read", async () => {
    const { opts, calls } = world();
    expect((await drive(opts, "/items/7/pairing")).status).toBe(403);
    const res = await drive(opts, "/items/7/pairing", { headers: { "x-landrace-action": "pairing" } });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ open: null, offers: [{ stage: "spec", round: 1, continue: false }] });
    expect(calls).toEqual([["pairing", "7"]]);
  });

  it("starts a pairing on the step the body names, answers its command and wakes the loop", async () => {
    const { opts, calls, wakes } = world();
    const res = await drive(opts, "/items/7/pair", write("pair", "spec"));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ command: "cd /w/7.pair && agent" });
    expect(calls).toEqual([["pair", "7", "spec"]]);
    expect(wakes()).toBe(1);
  });

  it("needs a step to pair on", async () => {
    const { opts, calls } = world();
    expect((await drive(opts, "/items/7/pair", write("pair", " "))).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("finishes with an optional note, and releases with none", async () => {
    const { opts, calls, wakes } = world();
    expect((await drive(opts, "/items/7/finish", write("finish", ""))).status).toBe(200);
    expect((await drive(opts, "/items/7/finish", write("finish", "short version"))).status).toBe(200);
    expect((await drive(opts, "/items/7/release", write("release"))).status).toBe(200);
    expect(calls).toEqual([["finish", "7", ""], ["finish", "7", "short version"], ["release", "7"]]);
    expect(wakes()).toBe(3);
  });

  it("refuses a write made for another of the page's actions", async () => {
    const { opts, calls } = world();
    expect((await drive(opts, "/items/7/release", write("finish"))).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("wakes the loop after a refused hand-in too: it recorded the rejected round", async () => {
    const said = jest.spyOn(console, "error").mockImplementation(() => {});
    const { opts, wakes } = world({ finish: async () => { throw new Error("the hand-in was refused: no json block"); } });
    const res = await drive(opts, "/items/7/finish", write("finish", ""));
    said.mockRestore();
    expect(res.status).toBe(502);
    expect(res.body).toBe("the hand-in was refused: no json block");
    expect(wakes()).toBe(1);
  });
});
