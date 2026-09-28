import * as http from "node:http";
import { request } from "node:http";
import type { BoardView, GotoResult, UiServer, WakeResult } from "#namespace.js";
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
 * or a "Go to step…" sends a ticket back through `sendTo`, which is what
 * hands it back and re-runs a paid step. So both carry every guard POST
 * /tick does, and one more that only they need — the ticket has to allow the
 * goto *now*, read afresh when the request arrives, whatever the page that
 * asked believed. A Retry is a goto with no step named: the stage that last
 * failed.
 */
describeLoopback("the page's writes to a ticket: POST /tickets/<id>/retry and /tickets/<id>/goto/<stage>", () => {
  let server: UiServer;
  afterEach(async () => { await server?.close(); });

  const going = (send: (ticket: string, target: string | null) => Promise<GotoResult> = async (_, t) => ({ to: t ?? "build" })) => {
    const calls: Array<[string, string | null]> = [];
    return { calls, goto: { send: async (ticket: string, target: string | null) => { calls.push([ticket, target]); return send(ticket, target); } } };
  };
  const ours = (action: string) => ({
    "x-landrace-action": action, origin: `http://127.0.0.1:${server.port}`, "sec-fetch-site": "same-origin",
  });

  it("sends a Retry as a goto with no step named, and says where it went", async () => {
    const g = going();
    server = await serveBoard({ port: 0, view: async () => empty, goto: g.goto });
    const res = await get(server.port, "/tickets/19/retry", { method: "POST", headers: ours("retry") });
    expect(res.status).toBe(202);
    expect(res.body).toBe("sent #19 back to build");
    expect(g.calls).toEqual([["19", null]]);
  });

  it("sends a goto to the step in its path", async () => {
    const g = going();
    server = await serveBoard({ port: 0, view: async () => empty, goto: g.goto });
    const res = await get(server.port, "/tickets/19/goto/spec", { method: "POST", headers: ours("goto") });
    expect(res.status).toBe(202);
    expect(g.calls).toEqual([["19", "spec"]]);
  });

  it("answers a refusal with its own sentence", async () => {
    const g = going(async () => ({ refused: "#19: \"blocked\" sends a ticket only to \"spec\", not to \"done\"" }));
    server = await serveBoard({ port: 0, view: async () => empty, goto: g.goto });
    const res = await get(server.port, "/tickets/19/goto/done", { method: "POST", headers: ours("goto") });
    expect(res.status).toBe(409);
    expect(res.body).toMatch(/only to "spec"/);
  });

  it("says the landrace log has the reason when the write itself fails", async () => {
    const g = going(async () => { throw new Error("tracker down: token ghp_x"); });
    server = await serveBoard({ port: 0, view: async () => empty, goto: g.goto });
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await get(server.port, "/tickets/19/retry", { method: "POST", headers: ours("retry") });
      expect(res.status).toBe(502);
      expect(res.body).toMatch(/could not send it back/);
      expect(res.body).not.toMatch(/ghp_/);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * A person who sent a ticket back is waiting on it: the pass that picks it
   * up runs now rather than when the countdown next comes round.
   */
  it.each([["retry", "/tickets/19/retry"], ["goto", "/tickets/19/goto/spec"]])(
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
    expect((await get(server.port, "/tickets/19/goto/done", { method: "POST", headers: ours("goto") })).status).toBe(409);
    await server.close();

    const throwing = going(async () => { throw new Error("tracker down"); });
    server = await serveBoard({ port: 0, view: async () => empty, goto: throwing.goto, tick });
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await get(server.port, "/tickets/19/retry", { method: "POST", headers: ours("retry") })).status).toBe(502);
    } finally {
      spy.mockRestore();
    }
    expect(tick).not.toHaveBeenCalled();
  });

  it("refuses a request with no custom header — what a cross-site <form> sends — and sends nothing", async () => {
    const g = going();
    server = await serveBoard({ port: 0, view: async () => empty, goto: g.goto });
    const res = await get(server.port, "/tickets/19/retry", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=1",
    });
    expect(res.status).toBe(403);
    expect(g.calls).toEqual([]);
  });

  it.each([["retry", "/tickets/19/goto/spec"], ["goto", "/tickets/19/retry"], ["tick", "/tickets/19/goto/spec"]])(
    "refuses the %s header on %s: each write names itself", async (action, path) => {
      const g = going();
      server = await serveBoard({ port: 0, view: async () => empty, goto: g.goto });
      expect((await get(server.port, path, { method: "POST", headers: { "x-landrace-action": action } })).status).toBe(403);
      expect(g.calls).toEqual([]);
    });

  it.each(["..", "a%20b", "-rf", "%2E%2E%2Fetc"])("refuses a ticket id that is not one (%s)", async (id) => {
    const g = going();
    server = await serveBoard({ port: 0, view: async () => empty, goto: g.goto });
    expect((await get(server.port, `/tickets/${id}/goto/spec`, { method: "POST", headers: ours("goto") })).status).toBe(400);
    expect(g.calls).toEqual([]);
  });

  it("refuses a ticket id that is not one on the retry route too", async () => {
    const g = going();
    server = await serveBoard({ port: 0, view: async () => empty, goto: g.goto });
    expect((await get(server.port, "/tickets/../retry", { method: "POST", headers: ours("retry") })).status).toBe(400);
    expect(g.calls).toEqual([]);
  });

  it("says 'ticket id' for a malformed % on the retry route, and 'ticket and a step' on the goto route", async () => {
    const g = going();
    server = await serveBoard({ port: 0, view: async () => empty, goto: g.goto });
    const retrying = await get(server.port, "/tickets/%E0%A4%A/retry", { method: "POST", headers: ours("retry") });
    expect(retrying.status).toBe(400);
    expect(retrying.body).toBe("that is not a ticket id");
    const going_ = await get(server.port, "/tickets/%E0%A4%A/goto/spec", { method: "POST", headers: ours("goto") });
    expect(going_.status).toBe(400);
    expect(going_.body).toBe("that is not a ticket and a step");
    expect(g.calls).toEqual([]);
  });

  // "%E2%80%8B" is U+200B ZERO WIDTH SPACE — Unicode category Cf (Format),
  // proving the check reaches past C0/DEL to every control-like category, not
  // just the ones a naive ASCII check would catch.
  it.each(["%00", "%E0%A4%A", "%E2%80%8B"])("refuses a step that is not one (%s)", async (stage) => {
    const g = going();
    server = await serveBoard({ port: 0, view: async () => empty, goto: g.goto });
    expect((await get(server.port, `/tickets/19/goto/${stage}`, { method: "POST", headers: ours("goto") })).status).toBe(400);
    expect(g.calls).toEqual([]);
  });

  it("refuses a cross-origin request, a cross-site one and a GET, and sends nothing", async () => {
    const g = going();
    server = await serveBoard({ port: 0, view: async () => empty, goto: g.goto });
    const h = { "x-landrace-action": "goto" };
    expect((await get(server.port, "/tickets/19/goto/spec", { method: "POST", headers: { ...h, origin: "http://evil.example" } })).status).toBe(403);
    expect((await get(server.port, "/tickets/19/goto/spec", { method: "POST", headers: { ...h, "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await get(server.port, "/tickets/19/goto/spec", { headers: h })).status).toBe(405);
    expect(g.calls).toEqual([]);
  });

  it("is not there at all when nothing can write to the tracker", async () => {
    server = await serveBoard({ port: 0, view: async () => empty });
    expect((await get(server.port, "/tickets/19/goto/spec", { method: "POST", headers: ours("goto") })).status).toBe(404);
  });

  it("sends the CSP and no-store headers, and no Access-Control-Allow-*, on a write response", async () => {
    const g = going();
    server = await serveBoard({ port: 0, view: async () => empty, goto: g.goto });
    const res = await get(server.port, "/tickets/19/retry", { method: "POST", headers: ours("retry") });
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(Object.keys(res.headers).some((h) => h.toLowerCase().startsWith("access-control-allow"))).toBe(false);
  });
});
