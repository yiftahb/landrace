import * as http from "node:http";
import { request } from "node:http";
import { gotoByClaim, panelByClaim } from "#cli/start.js";
import { claimItems } from "#core/index.js";
import type {
  ActivityLog, BoardView, GotoPath, GotoResult, Graph, ItemPanel, ItemReads, Node, UiServer, WakeResult, Workflow,
} from "#namespace.js";
import { createBoard } from "#ui/board.js";
import { serveBoard } from "#ui/server.js";
import { describeLoopback } from "#tests/support/loopback.js";

const empty: BoardView = {
  generatedAt: 1, rows: [], nextTickAt: null, folder: "landrace", workspace: "/repo/landrace",
};

/**
 * A raw request, so a test can send a Host header fetch would refuse to
 * forge, or a header/body combination fetch would refuse to send at all
 * (a cross-site `<form>` cannot set a custom header, so proving the server
 * refuses one that lacks it takes a raw request too).
 */
function get(port: number, path: string, opts: {
  host?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
} = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: opts.method ?? "GET",
        headers: { host: opts.host ?? `127.0.0.1:${port}`, ...opts.headers },
      },
      (res) => {
        let body = "";
        res.on("data", (d: Buffer) => { body += d.toString(); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

describeLoopback("serveBoard", () => {
  let server: UiServer;
  afterEach(async () => { await server?.close(); });

  it("serves the page, its script, its style and the board", async () => {
    server = await serveBoard({ port: 0, view: async () => empty });
    expect((await get(server.port, "/")).body).toContain("<title>Landrace</title>");
    expect((await get(server.port, "/app.js")).headers["content-type"]).toMatch(/javascript/);
    expect((await get(server.port, "/app.css")).headers["content-type"]).toMatch(/css/);
    const board = await get(server.port, "/board.json");
    expect(board.headers["content-type"]).toMatch(/json/);
    expect(JSON.parse(board.body)).toEqual(empty);
  });

  it("serves /theme.js as script, through the same send() so it carries the CSP", async () => {
    server = await serveBoard({ port: 0, view: async () => empty });
    const res = await get(server.port, "/theme.js");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/javascript/);
    expect(String(res.headers["content-security-policy"])).toContain("script-src 'self'");
  });

  it("405s POST /theme.js, like every other route that is not /tick", async () => {
    server = await serveBoard({ port: 0, view: async () => empty });
    expect((await get(server.port, "/theme.js", { method: "POST" })).status).toBe(405);
  });

  it("binds 127.0.0.1 and reports a url on it", async () => {
    server = await serveBoard({ port: 0, view: async () => empty });
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/`);
  });

  it("answers localhost too", async () => {
    server = await serveBoard({ port: 0, view: async () => empty });
    expect((await get(server.port, "/board.json", { host: `localhost:${server.port}` })).status).toBe(200);
  });

  it("refuses a foreign Host header, which is what DNS rebinding sends", async () => {
    server = await serveBoard({ port: 0, view: async () => empty });
    const res = await get(server.port, "/board.json", { host: `attacker.example:${server.port}` });
    expect(res.status).toBe(421);
    expect(res.body).not.toContain("rows");
  });

  it("refuses anything but GET", async () => {
    server = await serveBoard({ port: 0, view: async () => empty });
    expect((await get(server.port, "/board.json", { method: "POST" })).status).toBe(405);
  });

  it("sends a CSP that forbids inline script on every response", async () => {
    server = await serveBoard({ port: 0, view: async () => empty });
    for (const path of ["/", "/app.js", "/theme.js", "/board.json", "/nope"]) {
      const csp = String((await get(server.port, path)).headers["content-security-policy"]);
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toContain("unsafe-inline");
    }
  });

  it("404s an unknown path", async () => {
    server = await serveBoard({ port: 0, view: async () => empty });
    expect((await get(server.port, "/etc/passwd")).status).toBe(404);
  });

  it("500s a failing view without echoing its message", async () => {
    server = await serveBoard({ port: 0, view: async () => { throw new Error("secret tracker text"); } });
    const res = await get(server.port, "/board.json");
    expect(res.status).toBe(500);
    expect(res.body).not.toContain("secret tracker text");
  });

  it("rejects when the port is taken", async () => {
    server = await serveBoard({ port: 0, view: async () => empty });
    await expect(serveBoard({ port: server.port, view: async () => empty })).rejects.toMatchObject({ code: "EADDRINUSE" });
  });

  it("closes cleanly even if a request is stuck in view()", async () => {
    server = await serveBoard({ port: 0, view: () => new Promise(() => {}) });
    // Fire a request that will hang forever
    const requestPromise = get(server.port, "/board.json").catch(() => {});
    // Give it time to start
    await new Promise((r) => setTimeout(r, 50));
    // close() should resolve within 2 seconds, not hang forever. The two
    // branches must resolve to distinct values — both resolving to
    // `undefined` let this assertion pass whichever one won the race, timeout
    // included. The timer is cleared in `finally`: left running, it is the
    // handle that makes jest report "did not exit one second after the test
    // run has completed".
    let timer: ReturnType<typeof setTimeout>;
    const closePromise = server.close().then((): "closed" => "closed");
    const timeout = new Promise<"timed out">((resolve) => {
      timer = setTimeout(() => resolve("timed out"), 2000);
    });
    try {
      const result = await Promise.race([closePromise, timeout]);
      expect(result).toBe("closed");
    } finally {
      clearTimeout(timer!);
    }
    // Ignore the request error from the destroyed socket
    await requestPromise;
  });

  it("handles server errors without crashing", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation();
    const createServerSpy = jest.spyOn(http, "createServer");

    try {
      server = await serveBoard({ port: 0, view: async () => empty });
      const createdServer = createServerSpy.mock.results[createServerSpy.mock.results.length - 1]?.value;

      // Emit an error on the server
      createdServer.emit("error", new Error("EMFILE"));

      // Verify console.error was called with the error message
      expect(consoleErrorSpy).toHaveBeenCalled();
      const calls = consoleErrorSpy.mock.calls;
      const errorCall = calls.find((c) => String(c[0]).includes("EMFILE"));
      expect(errorCall).toBeDefined();
    } finally {
      consoleErrorSpy.mockRestore();
      createServerSpy.mockRestore();
    }
  });
});

describeLoopback("POST /tick", () => {
  let server: UiServer;
  afterEach(async () => { await server?.close(); });

  const HEADER = { "x-landrace-action": "tick" };
  const started = (): WakeResult => "started";

  /**
   * Every attack case must also leave the callback uncalled — a refusal that
   * still started a paid agent run would be no refusal at all.
   */
  it("refuses a POST with no custom header — what a cross-site <form> POST looks like — and never calls tick", async () => {
    const tick = jest.fn(started);
    server = await serveBoard({ port: 0, view: async () => empty, tick });
    const res = await get(server.port, "/tick", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "a=1",
    });
    expect(res.status).toBe(403);
    expect(tick).not.toHaveBeenCalled();
  });

  /**
   * The header check is content-type-agnostic — a cross-site <form> can post
   * as text/plain or multipart/form-data too, and neither lets it set a
   * custom header, so all three must be refused the same way.
   */
  it.each(["text/plain", "multipart/form-data; boundary=x"])(
    "refuses a POST with no custom header and content-type %s, and never calls tick",
    async (contentType) => {
      const tick = jest.fn(started);
      server = await serveBoard({ port: 0, view: async () => empty, tick });
      const res = await get(server.port, "/tick", {
        method: "POST",
        headers: { "content-type": contentType },
        body: "a=1",
      });
      expect(res.status).toBe(403);
      expect(tick).not.toHaveBeenCalled();
    },
  );

  /**
   * A sandboxed cross-origin iframe posting a form sends a literal
   * `Origin: null` — still no custom header, so the header check refuses it
   * before the Origin is ever read.
   */
  it("refuses a POST with Origin: null and no custom header, and never calls tick", async () => {
    const tick = jest.fn(started);
    server = await serveBoard({ port: 0, view: async () => empty, tick });
    const res = await get(server.port, "/tick", {
      method: "POST",
      headers: { origin: "null" },
    });
    expect(res.status).toBe(403);
    expect(tick).not.toHaveBeenCalled();
  });

  it("refuses a POST with the header but an Origin on a different 127.0.0.1 port, and never calls tick", async () => {
    const tick = jest.fn(started);
    server = await serveBoard({ port: 0, view: async () => empty, tick });
    const res = await get(server.port, "/tick", {
      method: "POST",
      headers: { "x-landrace-action": "tick", origin: `http://127.0.0.1:${server.port + 1}` },
    });
    expect(res.status).toBe(403);
    expect(tick).not.toHaveBeenCalled();
  });

  it("refuses a POST with the header but a foreign Origin, and never calls tick", async () => {
    const tick = jest.fn(started);
    server = await serveBoard({ port: 0, view: async () => empty, tick });
    const res = await get(server.port, "/tick", {
      method: "POST",
      headers: { ...HEADER, origin: "http://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(tick).not.toHaveBeenCalled();
  });

  it("refuses a POST the browser says came from another site, and never calls tick", async () => {
    const tick = jest.fn(started);
    server = await serveBoard({ port: 0, view: async () => empty, tick });
    const res = await get(server.port, "/tick", {
      method: "POST",
      headers: { ...HEADER, "sec-fetch-site": "same-site" },
    });
    expect(res.status).toBe(403);
    expect(tick).not.toHaveBeenCalled();
  });

  it("refuses the retry's header: each write names itself", async () => {
    const tick = jest.fn(started);
    server = await serveBoard({ port: 0, view: async () => empty, tick });
    const res = await get(server.port, "/tick", { method: "POST", headers: { "x-landrace-action": "retry" } });
    expect(res.status).toBe(403);
    expect(tick).not.toHaveBeenCalled();
  });

  it("refuses a POST to a foreign Host with 421 before anything else, and never calls tick", async () => {
    const tick = jest.fn(started);
    server = await serveBoard({ port: 0, view: async () => empty, tick });
    const res = await get(server.port, "/tick", {
      method: "POST",
      host: `attacker.example:${server.port}`,
      headers: HEADER,
    });
    expect(res.status).toBe(421);
    expect(tick).not.toHaveBeenCalled();
  });

  it("refuses GET /tick with 405, and never calls tick", async () => {
    const tick = jest.fn(started);
    server = await serveBoard({ port: 0, view: async () => empty, tick });
    const res = await get(server.port, "/tick", { headers: HEADER });
    expect(res.status).toBe(405);
    expect(tick).not.toHaveBeenCalled();
  });

  it("refuses an OPTIONS preflight: not 2xx, no access-control-allow-* header, and never calls tick", async () => {
    const tick = jest.fn(started);
    server = await serveBoard({ port: 0, view: async () => empty, tick });
    const res = await get(server.port, "/tick", { method: "OPTIONS", headers: HEADER });
    expect(res.status < 200 || res.status >= 300).toBe(true);
    expect(Object.keys(res.headers).some((h) => h.toLowerCase().startsWith("access-control-allow"))).toBe(false);
    expect(tick).not.toHaveBeenCalled();
  });

  it("202s and calls tick once, with the header and the server's own Origin", async () => {
    const tick = jest.fn(started);
    server = await serveBoard({ port: 0, view: async () => empty, tick });
    const res = await get(server.port, "/tick", {
      method: "POST",
      headers: { ...HEADER, origin: `http://127.0.0.1:${server.port}` },
    });
    expect(res.status).toBe(202);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("accepts a localhost Origin too", async () => {
    const tick = jest.fn(started);
    server = await serveBoard({ port: 0, view: async () => empty, tick });
    const res = await get(server.port, "/tick", {
      method: "POST",
      headers: { ...HEADER, origin: `http://localhost:${server.port}` },
    });
    expect(res.status).toBe(202);
  });

  it("says the tick started when the schedule ran one", async () => {
    server = await serveBoard({ port: 0, view: async () => empty, tick: started });
    const res = await get(server.port, "/tick", { method: "POST", headers: HEADER });
    expect(res.status).toBe(202);
    expect(res.body).toBe("tick started");
  });

  it("202s 'tick queued' when a tick is already running, rather than dropping the ask", async () => {
    server = await serveBoard({ port: 0, view: async () => empty, tick: (): WakeResult => "queued" });
    const res = await get(server.port, "/tick", { method: "POST", headers: HEADER });
    expect(res.status).toBe(202);
    expect(res.body).toBe("tick queued");
  });

  it("503s when the schedule has stopped", async () => {
    server = await serveBoard({ port: 0, view: async () => empty, tick: (): WakeResult => "stopped" });
    const res = await get(server.port, "/tick", { method: "POST", headers: HEADER });
    expect(res.status).toBe(503);
    expect(res.body).toBe("landrace is stopping");
  });

  it("never sends an Access-Control-Allow-* header on a successful tick either", async () => {
    server = await serveBoard({ port: 0, view: async () => empty, tick: started });
    const res = await get(server.port, "/tick", { method: "POST", headers: HEADER });
    expect(Object.keys(res.headers).some((h) => h.toLowerCase().startsWith("access-control-allow"))).toBe(false);
  });

  it("404s POST /tick when serveBoard was not given a tick callback", async () => {
    server = await serveBoard({ port: 0, view: async () => empty });
    const res = await get(server.port, "/tick", { method: "POST", headers: HEADER });
    expect(res.status).toBe(404);
  });

  it("still sends the CSP and no-store headers on a tick response", async () => {
    server = await serveBoard({ port: 0, view: async () => empty, tick: started });
    const res = await get(server.port, "/tick", { method: "POST", headers: HEADER });
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

/**
 * The page's fourth write, and the one that spends no agent at all — only a
 * tracker read, which is still worth guarding the same way: it is still a
 * request only the page's own script should be able to trigger.
 */
describeLoopback("POST /refresh", () => {
  let server: UiServer;
  afterEach(async () => { await server?.close(); });

  const HEADER = { "x-landrace-action": "refresh" };

  it("404s when serveBoard was not given a refresh callback", async () => {
    server = await serveBoard({ port: 0, view: async () => empty });
    const res = await get(server.port, "/refresh", { method: "POST", headers: HEADER });
    expect(res.status).toBe(404);
  });

  it("405s GET /refresh, and never calls refresh", async () => {
    const refresh = jest.fn(async () => {});
    server = await serveBoard({ port: 0, view: async () => empty, refresh });
    const res = await get(server.port, "/refresh", { headers: HEADER });
    expect(res.status).toBe(405);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("403s a POST with no custom header, and never calls refresh", async () => {
    const refresh = jest.fn(async () => {});
    server = await serveBoard({ port: 0, view: async () => empty, refresh });
    const res = await get(server.port, "/refresh", { method: "POST" });
    expect(res.status).toBe(403);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("403s a foreign Origin even with the header, and never calls refresh", async () => {
    const refresh = jest.fn(async () => {});
    server = await serveBoard({ port: 0, view: async () => empty, refresh });
    const res = await get(server.port, "/refresh", {
      method: "POST", headers: { ...HEADER, origin: "http://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("403s the tick header on /refresh: each write names itself", async () => {
    const refresh = jest.fn(async () => {});
    server = await serveBoard({ port: 0, view: async () => empty, refresh });
    const res = await get(server.port, "/refresh", { method: "POST", headers: { "x-landrace-action": "tick" } });
    expect(res.status).toBe(403);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("200s and calls refresh once, with the server's own Origin", async () => {
    const refresh = jest.fn(async () => {});
    server = await serveBoard({ port: 0, view: async () => empty, refresh });
    const res = await get(server.port, "/refresh", {
      method: "POST", headers: { ...HEADER, origin: `http://127.0.0.1:${server.port}` },
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe("refreshed");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("502s with a one-line reason when refresh throws, without echoing its message", async () => {
    server = await serveBoard({ port: 0, view: async () => empty, refresh: async () => { throw new Error("tracker down: token ghp_x"); } });
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await get(server.port, "/refresh", { method: "POST", headers: HEADER });
      expect(res.status).toBe(502);
      expect(res.body).not.toContain("ghp_");
      expect(res.body.split("\n")).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("sends the CSP and no-store headers, and no Access-Control-Allow-*, on a refresh response", async () => {
    server = await serveBoard({ port: 0, view: async () => empty, refresh: async () => {} });
    const res = await get(server.port, "/refresh", { method: "POST", headers: HEADER });
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(Object.keys(res.headers).some((h) => h.toLowerCase().startsWith("access-control-allow"))).toBe(false);
  });
});

/**
 * The page's second and third writes, and the ones that spend money: a Retry
 * or a "Go to step…" sends an item back through `sendTo`, which is what
 * hands it back and re-runs a paid step. So both carry every guard POST
 * /tick does, and one more that only they need — the item has to allow the
 * goto *now*, read afresh when the request arrives, whatever the page that
 * asked believed. A Retry is a goto with no step named: the stage that last
 * failed.
 */
describeLoopback("the page's writes to an item: POST /items/<id>/retry and /items/<id>/goto/<stage>", () => {
  let server: UiServer;
  afterEach(async () => { await server?.close(); });

  const going = (send: (item: string, target: string | null) => Promise<GotoResult> = async (_, t) => ({ to: t ?? "build" })) => {
    const calls: Array<[string, string | null]> = [];
    return { calls, goto: { send: async (item: string, target: string | null) => { calls.push([item, target]); return send(item, target); } } };
  };
  const ours = (action: string) => ({
    "x-landrace-action": action, origin: `http://127.0.0.1:${server.port}`, "sec-fetch-site": "same-origin",
  });

  it("sends a Retry as a goto with no step named, and says where it went", async () => {
    const g = going();
    server = await serveBoard({ port: 0, view: async () => empty, goto: g.goto });
    const res = await get(server.port, "/items/19/retry", { method: "POST", headers: ours("retry") });
    expect(res.status).toBe(202);
    expect(res.body).toBe("sent #19 back to build");
    expect(g.calls).toEqual([["19", null]]);
  });

  it("sends a Clear & retry as a clearing goto with no step named, and says so", async () => {
    const calls: unknown[][] = [];
    const goto = { send: async (item: string, target: string | null, o?: { clear?: boolean }) => {
      calls.push([item, target, o]);
      return { to: "spec" };
    } };
    server = await serveBoard({ port: 0, view: async () => empty, goto });
    const res = await get(server.port, "/items/39/clear", { method: "POST", headers: ours("clear") });
    expect(res.status).toBe(202);
    expect(res.body).toBe("cleared #39 of the security check and sent it back to spec");
    expect(calls).toEqual([["39", null, { clear: true }]]);
  });

  it("refuses a Clear & retry that names itself as anything else", async () => {
    const g = going();
    server = await serveBoard({ port: 0, view: async () => empty, goto: g.goto });
    const res = await get(server.port, "/items/39/clear", { method: "POST", headers: ours("retry") });
    expect(res.status).toBe(403);
    expect(g.calls).toEqual([]);
  });

  it("sends a goto to the step in its path", async () => {
    const g = going();
    server = await serveBoard({ port: 0, view: async () => empty, goto: g.goto });
    const res = await get(server.port, "/items/19/goto/spec", { method: "POST", headers: ours("goto") });
    expect(res.status).toBe(202);
    expect(g.calls).toEqual([["19", "spec"]]);
  });

  it("answers a refusal with its own sentence", async () => {
    const g = going(async () => ({ refused: "#19: \"blocked\" sends an item only to \"spec\", not to \"done\"" }));
    server = await serveBoard({ port: 0, view: async () => empty, goto: g.goto });
    const res = await get(server.port, "/items/19/goto/done", { method: "POST", headers: ours("goto") });
    expect(res.status).toBe(409);
    expect(res.body).toMatch(/only to "spec"/);
  });

  it("says the landrace log has the reason when the write itself fails", async () => {
    const g = going(async () => { throw new Error("tracker down: token ghp_x"); });
    server = await serveBoard({ port: 0, view: async () => empty, goto: g.goto });
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await get(server.port, "/items/19/retry", { method: "POST", headers: ours("retry") });
      expect(res.status).toBe(502);
      expect(res.body).toMatch(/could not send it back/);
      expect(res.body).not.toMatch(/ghp_/);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * A person who sent an item back is waiting on it: the pass that picks it
   * up runs now rather than when the countdown next comes round.
   */
  it.each([["retry", "/items/19/retry"], ["goto", "/items/19/goto/spec"]])(
    "wakes the schedule once after a %s is sent",
    async (action, path) => {
      const g = going();
      const tick = jest.fn((): WakeResult => "started");
      server = await serveBoard({ port: 0, view: async () => empty, goto: g.goto, tick });
      const res = await get(server.port, path, { method: "POST", headers: ours(action) });
      expect(res.status).toBe(202);
      expect(tick).toHaveBeenCalledTimes(1);
    },
  );

  it("does not wake the schedule when the goto is refused or the write throws", async () => {
    const tick = jest.fn((): WakeResult => "started");
    const refused = going(async () => ({ refused: "#19: not now" }));
    server = await serveBoard({ port: 0, view: async () => empty, goto: refused.goto, tick });
    expect((await get(server.port, "/items/19/goto/done", { method: "POST", headers: ours("goto") })).status).toBe(409);
    await server.close();

    const throwing = going(async () => { throw new Error("tracker down"); });
    server = await serveBoard({ port: 0, view: async () => empty, goto: throwing.goto, tick });
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await get(server.port, "/items/19/retry", { method: "POST", headers: ours("retry") })).status).toBe(502);
    } finally {
      spy.mockRestore();
    }
    expect(tick).not.toHaveBeenCalled();
  });

  it("refuses a request with no custom header — what a cross-site <form> sends — and sends nothing", async () => {
    const g = going();
    server = await serveBoard({ port: 0, view: async () => empty, goto: g.goto });
    const res = await get(server.port, "/items/19/retry", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=1",
    });
    expect(res.status).toBe(403);
    expect(g.calls).toEqual([]);
  });

  it.each([["retry", "/items/19/goto/spec"], ["goto", "/items/19/retry"], ["tick", "/items/19/goto/spec"]])(
    "refuses the %s header on %s: each write names itself", async (action, path) => {
      const g = going();
      server = await serveBoard({ port: 0, view: async () => empty, goto: g.goto });
      expect((await get(server.port, path, { method: "POST", headers: { "x-landrace-action": action } })).status).toBe(403);
      expect(g.calls).toEqual([]);
    });

  it.each(["..", "a%20b", "-rf", "%2E%2E%2Fetc"])("refuses an item id that is not one (%s)", async (id) => {
    const g = going();
    server = await serveBoard({ port: 0, view: async () => empty, goto: g.goto });
    expect((await get(server.port, `/items/${id}/goto/spec`, { method: "POST", headers: ours("goto") })).status).toBe(400);
    expect(g.calls).toEqual([]);
  });

  it("refuses an item id that is not one on the retry route too", async () => {
    const g = going();
    server = await serveBoard({ port: 0, view: async () => empty, goto: g.goto });
    expect((await get(server.port, "/items/../retry", { method: "POST", headers: ours("retry") })).status).toBe(400);
    expect(g.calls).toEqual([]);
  });

  it("says 'item id' for a malformed % on the retry route, and 'item and a step' on the goto route", async () => {
    const g = going();
    server = await serveBoard({ port: 0, view: async () => empty, goto: g.goto });
    const retrying = await get(server.port, "/items/%E0%A4%A/retry", { method: "POST", headers: ours("retry") });
    expect(retrying.status).toBe(400);
    expect(retrying.body).toBe("that is not an item id");
    const going_ = await get(server.port, "/items/%E0%A4%A/goto/spec", { method: "POST", headers: ours("goto") });
    expect(going_.status).toBe(400);
    expect(going_.body).toBe("that is not an item and a step");
    expect(g.calls).toEqual([]);
  });

  // "%E2%80%8B" is U+200B ZERO WIDTH SPACE — Unicode category Cf (Format),
  // proving the check reaches past C0/DEL to every control-like category, not
  // just the ones a naive ASCII check would catch.
  it.each(["%00", "%E0%A4%A", "%E2%80%8B"])("refuses a step that is not one (%s)", async (stage) => {
    const g = going();
    server = await serveBoard({ port: 0, view: async () => empty, goto: g.goto });
    expect((await get(server.port, `/items/19/goto/${stage}`, { method: "POST", headers: ours("goto") })).status).toBe(400);
    expect(g.calls).toEqual([]);
  });

  it("refuses a cross-origin request, a cross-site one and a GET, and sends nothing", async () => {
    const g = going();
    server = await serveBoard({ port: 0, view: async () => empty, goto: g.goto });
    const h = { "x-landrace-action": "goto" };
    expect((await get(server.port, "/items/19/goto/spec", { method: "POST", headers: { ...h, origin: "http://evil.example" } })).status).toBe(403);
    expect((await get(server.port, "/items/19/goto/spec", { method: "POST", headers: { ...h, "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await get(server.port, "/items/19/goto/spec", { headers: h })).status).toBe(405);
    expect(g.calls).toEqual([]);
  });

  it("is not there at all when nothing can write to the tracker", async () => {
    server = await serveBoard({ port: 0, view: async () => empty });
    expect((await get(server.port, "/items/19/goto/spec", { method: "POST", headers: ours("goto") })).status).toBe(404);
  });

  it("sends the CSP and no-store headers, and no Access-Control-Allow-*, on a write response", async () => {
    const g = going();
    server = await serveBoard({ port: 0, view: async () => empty, goto: g.goto });
    const res = await get(server.port, "/items/19/retry", { method: "POST", headers: ours("retry") });
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(Object.keys(res.headers).some((h) => h.toLowerCase().startsWith("access-control-allow"))).toBe(false);
  });
});

/*
 * The page's writes and its panel, each reaching the workflow that owns the
 * item by the board's last listing — and, for an item no one workflow owns,
 * nothing at all: a 409 in the board's own words, never a guess at the first
 * workflow, and never the 502 a failed write gets.
 */
describeLoopback("the page's routes follow the item's workflow", () => {
  let server: UiServer;
  afterEach(async () => { await server?.close(); });

  const flow = (name: string, label: string, first: string): Workflow => ({
    version: 1, name, description: "test",
    eligible: [{ when: { "node.state.labels": { $in: [label] } }, else: `no ${label} label` }],
    stages: [
      { id: first, entry: true, step: `steps/${first}.md`, goto: [first], triggers: [{ when: { "run.stage": null } }] },
      { id: "blocked", goto: [first], triggers: [{ when: { "run.lastOutputValid": false } }] },
    ],
  });
  /** `main` and `fast` on one tracker, `gl` on a second. */
  const WORKFLOWS = [
    { id: "main", workflow: flow("Main", "lr:auto", "spec") },
    { id: "fast", workflow: flow("Fastlane", "lr:fast", "build") },
    { id: "gl", workflow: flow("Lab", "lr:auto", "spec") },
  ];
  const item = (id: string, labels: string[], closed: Node["closed"] = null): Node => ({
    id, kind: "item", title: `t${id}`, link: "", closed, priority: null, origin: null,
    state: { labels: [...labels, "lr:stage:blocked", "lr:blocked"] },
  });
  // #7 is closed where only the first tracker lists it, #9 where both do.
  const first: Graph = {
    nodes: [
      item("1", ["lr:auto"]), item("2", ["lr:fast"]), item("4", ["lr:auto", "lr:fast"]), item("5", ["lr:auto"]), item("6", []),
      item("7", ["lr:auto"], "done"), item("9", ["lr:auto"], "done"),
    ],
    relationships: [],
  };
  const second: Graph = { nodes: [item("5", ["lr:auto"]), item("9", ["lr:auto"], "done")], relationships: [] };

  const ours = (action: string) => ({
    "x-landrace-action": action, origin: `http://127.0.0.1:${server.port}`, "sec-fetch-site": "same-origin",
  });

  /** Each workflow's goto and panel writing down every call, and the page served over the board's own claims. */
  const serve = async () => {
    const board = createBoard({ workflows: WORKFLOWS, held: async () => null, folder: "f", workspace: "/w", nest: [] });
    board.list({
      graphs: [first, second],
      sourceOf: new Map(WORKFLOWS.map((w) => [w.id, w.id === "gl" ? 1 : 0])),
      claims: claimItems(WORKFLOWS.map((w) => ({ ...w, source: w.id === "gl" ? 1 : 0 })), [first, second]),
    });
    const calls: unknown[][] = [];
    const gotoOf = (workflow: string): GotoPath => ({
      send: async (item, target, opts) => { calls.push([workflow, "send", item, target, opts?.clear === true]); return { to: target ?? "blocked" }; },
    });
    const panelOf = (workflow: string): ItemPanel => ({
      activity: async () => ({ stage: null, round: null, lines: [], total: 0 }),
      conversation: async (item) => { calls.push([workflow, "conversation", item]); return []; },
      reply: async (item) => { calls.push([workflow, "reply", item]); },
      ask: async (item) => { calls.push([workflow, "ask", item]); return { reply: "ok", resolved: false }; },
      resolve: async (item) => { calls.push([workflow, "resolve", item]); return { alreadyResolved: false }; },
      pairing: async (item) => { calls.push([workflow, "pairing", item]); return { open: null, offers: [] }; },
      pair: async (item) => { calls.push([workflow, "pair", item]); return { stage: "spec", round: 1, session: "s", cwd: "/w", command: "c" }; },
      finish: async (item) => { calls.push([workflow, "finish", item]); return { stage: "spec", round: 1, discarded: [] }; },
      release: async (item) => { calls.push([workflow, "release", item]); return { stage: "spec", round: 1 }; },
    });
    const readsOf = (source: number): ItemReads => ({
      conversation: async (item) => { calls.push([`source ${source}`, "conversation", item]); return []; },
      pairing: async (item) => { calls.push([`source ${source}`, "pairing", item]); return { open: null, offers: [] }; },
    });
    const activity: ActivityLog = { begin: () => {}, record: () => {}, read: async () => ({ stage: null, round: null, lines: [], total: 0 }) };
    const owner = (item: string) => board.ownerOf(item);
    const ids = ["main", "fast", "gl"];
    const tick = jest.fn((): WakeResult => "started");
    const goto = gotoByClaim(owner, new Map(ids.map((id) => [id, gotoOf(id)])));
    if (!goto) throw new Error("every workflow here can write a record");
    server = await serveBoard({
      port: 0, view: () => board.view(), tick, goto,
      panel: panelByClaim({
        read: (item) => board.readerOf(item), write: owner, activity,
        panels: new Map(ids.map((id) => [id, panelOf(id)])), sources: new Map([[0, readsOf(0)], [1, readsOf(1)]]),
      }),
    });
    return { calls, tick };
  };

  it("sends a Retry, a Clear and a Go to through the goto of the workflow that owns the item, and no other", async () => {
    const { calls } = await serve();
    expect((await get(server.port, "/items/1/retry", { method: "POST", headers: ours("retry") })).status).toBe(202);
    expect((await get(server.port, "/items/2/clear", { method: "POST", headers: ours("clear") })).status).toBe(202);
    expect((await get(server.port, "/items/2/goto/build", { method: "POST", headers: ours("goto") })).status).toBe(202);
    expect(calls).toEqual([["main", "send", "1", null, false], ["fast", "send", "2", null, true], ["fast", "send", "2", "build", false]]);
  });

  it("reads and writes an item's panel through the workflow that owns it", async () => {
    const { calls } = await serve();
    expect((await get(server.port, "/items/1/conversation", { headers: ours("conversation") })).status).toBe(200);
    expect((await get(server.port, "/items/2/reply", { method: "POST", headers: ours("reply"), body: "hi" })).status).toBe(200);
    expect((await get(server.port, "/items/2/resolve", { method: "POST", headers: ours("resolve") })).status).toBe(200);
    expect(calls).toEqual([["main", "conversation", "1"], ["fast", "reply", "2"], ["fast", "resolve", "2"]]);
  });

  const refusals = [
    ["two workflows claim", "4", "#4 is claimed by fast and main; act on it after one workflow alone claims it"],
    ["two trackers report", "5", "#5 is reported by the sources of fast, gl and main; act on it after one source alone reports it"],
    ["no workflow claims", "6", "#6 is claimed by no workflow: no lr:auto label; no lr:fast label"],
    ["the last listing never saw", "99", "#99 is not an item the last tick listed"],
  ] as const;

  const writes = [
    ["retry", "retry"], ["clear", "clear"], ["goto/spec", "goto"],
    ["reply", "reply", "hi"], ["ask", "ask", "hi"], ["resolve", "resolve"], ["pair", "pair", "spec"], ["finish", "finish"], ["release", "release"],
  ] as const;

  it.each(refusals)("refuses every write to an item %s with 409 and the board's sentence, reaching no workflow", async (_, id, sentence) => {
    const { calls, tick } = await serve();
    for (const [path, action, body] of writes) {
      const res = await get(server.port, `/items/${id}/${path}`, { method: "POST", headers: ours(action), ...(body === undefined ? {} : { body }) });
      expect([path, res.status, res.body]).toEqual([path, 409, sentence]);
    }
    expect(calls).toEqual([]);
    expect(tick).not.toHaveBeenCalled();
  });

  /*
   * Reads decide nothing: only an id two trackers report — two items, maybe,
   * and which was meant is not the page's to pick — or one no listing showed
   * while there are two trackers it could be in, is refused.
   */
  it.each([
    ["two trackers report", "5", "#5 is reported by the sources of fast, gl and main; read it in its own tracker"],
    ["the last listing never saw", "99", "#99 is not an item the last tick listed"],
  ] as const)("refuses to read an item %s with 409 and the board's sentence, reaching no reader", async (_, id, sentence) => {
    const { calls } = await serve();
    for (const action of ["conversation", "pairing"] as const) {
      const res = await get(server.port, `/items/${id}/${action}`, { headers: ours(action) });
      expect([action, res.status, res.body]).toEqual([action, 409, sentence]);
    }
    expect(calls).toEqual([]);
  });

  it.each([["two workflows claim", "4"], ["no workflow claims", "6"]] as const)(
    "reads an item %s through the one source that lists it, never one of its workflows",
    async (_, id) => {
      const { calls } = await serve();
      expect((await get(server.port, `/items/${id}/conversation`, { headers: ours("conversation") })).status).toBe(200);
      expect((await get(server.port, `/items/${id}/pairing`, { headers: ours("pairing") })).status).toBe(200);
      expect(calls).toEqual([["source 0", "conversation", id], ["source 0", "pairing", id]]);
    },
  );

  /*
   * One workflow on one tracker, as this repository runs: a Not admitted
   * row's conversation is read, and so is an id the listing's window left
   * out — one tracker is the only place it can be.
   */
  it("reads a Not admitted item, and an id the listing did not show, through a one-tracker workspace's source", async () => {
    const main = { id: "main", workflow: flow("Main", "lr:auto", "spec") };
    const only = [main];
    const listed: Graph = { nodes: [item("1", ["lr:auto"]), item("6", [])], relationships: [] };
    const board = createBoard({ workflows: only, held: async () => null, folder: "f", workspace: "/w", nest: [] });
    board.list({ graphs: [listed], sourceOf: new Map([["main", 0]]), claims: claimItems([{ ...main, source: 0 }], [listed]) });
    const read: string[] = [];
    const none: ItemPanel = {
      activity: async () => ({ stage: null, round: null, lines: [], total: 0 }),
      conversation: async () => { throw new Error("read through the workflow"); }, pairing: async () => { throw new Error("read through the workflow"); },
      reply: async () => {}, ask: async () => ({ reply: "", resolved: false }), resolve: async () => ({ alreadyResolved: false }),
      pair: async () => { throw new Error("no"); }, finish: async () => { throw new Error("no"); }, release: async () => { throw new Error("no"); },
    };
    server = await serveBoard({
      port: 0, view: () => board.view(),
      panel: panelByClaim({
        read: (i) => board.readerOf(i), write: (i) => board.ownerOf(i),
        activity: { begin: () => {}, record: () => {}, read: async () => ({ stage: null, round: null, lines: [], total: 0 }) },
        panels: new Map([["main", none]]),
        sources: new Map([[0, { conversation: async (i) => { read.push(i); return []; }, pairing: async () => ({ open: null, offers: [] }) }]]),
      }),
    });
    expect((await get(server.port, "/items/6/conversation", { headers: ours("conversation") })).status).toBe(200);
    expect((await get(server.port, "/items/42/conversation", { headers: ours("conversation") })).status).toBe(200);
    expect(read).toEqual(["6", "42"]);
  });

  /*
   * A Done item's conversation was readable before workspaces, and is again:
   * through the one tracker that lists it. Nothing is written to it.
   */
  it("reads a closed item through the one source that lists it, and refuses every write to it", async () => {
    const { calls, tick } = await serve();
    expect((await get(server.port, "/items/7/conversation", { headers: ours("conversation") })).status).toBe(200);
    expect((await get(server.port, "/items/7/pairing", { headers: ours("pairing") })).status).toBe(200);
    for (const [path, action] of [["reply", "reply"], ["resolve", "resolve"], ["release", "release"], ["retry", "retry"]] as const) {
      const res = await get(server.port, `/items/7/${path}`, { method: "POST", headers: ours(action), body: "hi" });
      expect([path, res.status, res.body]).toEqual([path, 409, "#7 is closed, so nothing is written to it"]);
    }
    expect(calls).toEqual([["source 0", "conversation", "7"], ["source 0", "pairing", "7"]]);
    expect(tick).not.toHaveBeenCalled();
  });

  it("refuses to read a closed id two trackers both list, rather than picking one", async () => {
    const { calls } = await serve();
    const res = await get(server.port, "/items/9/conversation", { headers: ours("conversation") });
    expect([res.status, res.body]).toEqual([409, "#9 is reported by the sources of fast, gl and main; read it in its own tracker"]);
    expect(calls).toEqual([]);
  });
});
