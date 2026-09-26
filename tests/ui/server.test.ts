import * as http from "node:http";
import { request } from "node:http";
import type { BoardView, UiServer } from "#namespace.js";
import { serveBoard } from "#ui/server.js";

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

describe("serveBoard", () => {
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

describe("POST /tick", () => {
  let server: UiServer;
  afterEach(async () => { await server?.close(); });

  const HEADER = { "x-landrace-action": "tick" };

  /**
   * Every attack case must also leave the callback uncalled — a refusal that
   * still started a paid agent run would be no refusal at all.
   */
  it("refuses a POST with no custom header — what a cross-site <form> POST looks like — and never calls tick", async () => {
    const tick = jest.fn(() => true);
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
      const tick = jest.fn(() => true);
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
    const tick = jest.fn(() => true);
    server = await serveBoard({ port: 0, view: async () => empty, tick });
    const res = await get(server.port, "/tick", {
      method: "POST",
      headers: { origin: "null" },
    });
    expect(res.status).toBe(403);
    expect(tick).not.toHaveBeenCalled();
  });

  it("refuses a POST with the header but an Origin on a different 127.0.0.1 port, and never calls tick", async () => {
    const tick = jest.fn(() => true);
    server = await serveBoard({ port: 0, view: async () => empty, tick });
    const res = await get(server.port, "/tick", {
      method: "POST",
      headers: { "x-landrace-action": "tick", origin: `http://127.0.0.1:${server.port + 1}` },
    });
    expect(res.status).toBe(403);
    expect(tick).not.toHaveBeenCalled();
  });

  it("refuses a POST with the header but a foreign Origin, and never calls tick", async () => {
    const tick = jest.fn(() => true);
    server = await serveBoard({ port: 0, view: async () => empty, tick });
    const res = await get(server.port, "/tick", {
      method: "POST",
      headers: { ...HEADER, origin: "http://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(tick).not.toHaveBeenCalled();
  });

  it("refuses a POST the browser says came from another site, and never calls tick", async () => {
    const tick = jest.fn(() => true);
    server = await serveBoard({ port: 0, view: async () => empty, tick });
    const res = await get(server.port, "/tick", {
      method: "POST",
      headers: { ...HEADER, "sec-fetch-site": "same-site" },
    });
    expect(res.status).toBe(403);
    expect(tick).not.toHaveBeenCalled();
  });

  it("refuses the retry's header: each write names itself", async () => {
    const tick = jest.fn(() => true);
    server = await serveBoard({ port: 0, view: async () => empty, tick });
    const res = await get(server.port, "/tick", { method: "POST", headers: { "x-landrace-action": "retry" } });
    expect(res.status).toBe(403);
    expect(tick).not.toHaveBeenCalled();
  });

  it("refuses a POST to a foreign Host with 421 before anything else, and never calls tick", async () => {
    const tick = jest.fn(() => true);
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
    const tick = jest.fn(() => true);
    server = await serveBoard({ port: 0, view: async () => empty, tick });
    const res = await get(server.port, "/tick", { headers: HEADER });
    expect(res.status).toBe(405);
    expect(tick).not.toHaveBeenCalled();
  });

  it("refuses an OPTIONS preflight: not 2xx, no access-control-allow-* header, and never calls tick", async () => {
    const tick = jest.fn(() => true);
    server = await serveBoard({ port: 0, view: async () => empty, tick });
    const res = await get(server.port, "/tick", { method: "OPTIONS", headers: HEADER });
    expect(res.status < 200 || res.status >= 300).toBe(true);
    expect(Object.keys(res.headers).some((h) => h.toLowerCase().startsWith("access-control-allow"))).toBe(false);
    expect(tick).not.toHaveBeenCalled();
  });

  it("202s and calls tick once, with the header and the server's own Origin", async () => {
    const tick = jest.fn(() => true);
    server = await serveBoard({ port: 0, view: async () => empty, tick });
    const res = await get(server.port, "/tick", {
      method: "POST",
      headers: { ...HEADER, origin: `http://127.0.0.1:${server.port}` },
    });
    expect(res.status).toBe(202);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("accepts a localhost Origin too", async () => {
    const tick = jest.fn(() => true);
    server = await serveBoard({ port: 0, view: async () => empty, tick });
    const res = await get(server.port, "/tick", {
      method: "POST",
      headers: { ...HEADER, origin: `http://localhost:${server.port}` },
    });
    expect(res.status).toBe(202);
  });

  it("409s when tick() reports one is already running", async () => {
    const tick = jest.fn(() => false);
    server = await serveBoard({ port: 0, view: async () => empty, tick });
    const res = await get(server.port, "/tick", { method: "POST", headers: HEADER });
    expect(res.status).toBe(409);
    expect(res.body).toMatch(/already running/);
  });

  it("never sends an Access-Control-Allow-* header on a successful tick either", async () => {
    server = await serveBoard({ port: 0, view: async () => empty, tick: () => true });
    const res = await get(server.port, "/tick", { method: "POST", headers: HEADER });
    expect(Object.keys(res.headers).some((h) => h.toLowerCase().startsWith("access-control-allow"))).toBe(false);
  });

  it("404s POST /tick when serveBoard was not given a tick callback", async () => {
    server = await serveBoard({ port: 0, view: async () => empty });
    const res = await get(server.port, "/tick", { method: "POST", headers: HEADER });
    expect(res.status).toBe(404);
  });

  it("still sends the CSP and no-store headers on a tick response", async () => {
    server = await serveBoard({ port: 0, view: async () => empty, tick: () => true });
    const res = await get(server.port, "/tick", { method: "POST", headers: HEADER });
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

/**
 * The page's second write, and the one that spends money: a Retry posts a
 * human turn on a blocked or screened ticket, which is what hands it back and
 * re-runs a paid step. So it carries every guard POST /tick does, and one
 * more that only it needs — the ticket has to be blocked *now*, by the
 * board's own latest listing, whatever the page that asked believed.
 */
describe("POST /tickets/<id>/retry", () => {
  let server: UiServer;
  afterEach(async () => { await server?.close(); });

  const HEADER = { "x-landrace-action": "retry" };
  const retrying = (allowed: (ticket: string) => boolean = () => true, post: (ticket: string) => Promise<void> = async () => {}) => {
    const calls: string[] = [];
    return {
      calls,
      retry: { allowed, post: async (ticket: string) => { calls.push(ticket); await post(ticket); } },
    };
  };
  const ours = () => ({ ...HEADER, origin: `http://127.0.0.1:${server.port}`, "sec-fetch-site": "same-origin" });

  it("posts exactly one reply for a blocked ticket, from the page's own origin", async () => {
    const r = retrying();
    server = await serveBoard({ port: 0, view: async () => empty, retry: r.retry });
    const res = await get(server.port, "/tickets/19/retry", { method: "POST", headers: ours() });
    expect(res.status).toBe(202);
    expect(r.calls).toEqual(["19"]);
  });

  it("refuses a ticket the board does not list as blocked or screened, and posts nothing", async () => {
    const r = retrying(() => false);
    server = await serveBoard({ port: 0, view: async () => empty, retry: r.retry });
    const res = await get(server.port, "/tickets/19/retry", { method: "POST", headers: ours() });
    expect(res.status).toBe(409);
    expect(res.body).toMatch(/#19 is not blocked/);
    expect(r.calls).toEqual([]);
  });

  it.each(["..", "a%20b", "-rf", "%2E%2E%2Fetc"])("refuses a ticket id that is not one (%s), and posts nothing", async (id) => {
    const r = retrying();
    server = await serveBoard({ port: 0, view: async () => empty, retry: r.retry });
    const res = await get(server.port, `/tickets/${id}/retry`, { method: "POST", headers: ours() });
    expect(res.status).toBe(400);
    expect(r.calls).toEqual([]);
  });

  it("refuses a request with no custom header — what a cross-site <form> sends — and posts nothing", async () => {
    const r = retrying();
    server = await serveBoard({ port: 0, view: async () => empty, retry: r.retry });
    const res = await get(server.port, "/tickets/19/retry", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=1",
    });
    expect(res.status).toBe(403);
    expect(r.calls).toEqual([]);
  });

  it("refuses the tick's header: each write names itself", async () => {
    const r = retrying();
    server = await serveBoard({ port: 0, view: async () => empty, retry: r.retry });
    const res = await get(server.port, "/tickets/19/retry", { method: "POST", headers: { "x-landrace-action": "tick" } });
    expect(res.status).toBe(403);
    expect(r.calls).toEqual([]);
  });

  it("refuses a cross-origin request, and posts nothing", async () => {
    const r = retrying();
    server = await serveBoard({ port: 0, view: async () => empty, retry: r.retry });
    const res = await get(server.port, "/tickets/19/retry", { method: "POST", headers: { ...HEADER, origin: "http://evil.example" } });
    expect(res.status).toBe(403);
    expect(r.calls).toEqual([]);
  });

  it("refuses a request the browser says came from another site, and posts nothing", async () => {
    const r = retrying();
    server = await serveBoard({ port: 0, view: async () => empty, retry: r.retry });
    const res = await get(server.port, "/tickets/19/retry", { method: "POST", headers: { ...HEADER, "sec-fetch-site": "cross-site" } });
    expect(res.status).toBe(403);
    expect(r.calls).toEqual([]);
  });

  it("refuses a GET, and posts nothing", async () => {
    const r = retrying();
    server = await serveBoard({ port: 0, view: async () => empty, retry: r.retry });
    const res = await get(server.port, "/tickets/19/retry", { headers: HEADER });
    expect(res.status).toBe(405);
    expect(r.calls).toEqual([]);
  });

  it("is 404 when there is no reply path to retry through", async () => {
    server = await serveBoard({ port: 0, view: async () => empty });
    const res = await get(server.port, "/tickets/19/retry", { method: "POST", headers: HEADER });
    expect(res.status).toBe(404);
  });

  it("says in a sentence that the reply could not be posted, without echoing why", async () => {
    const r = retrying(() => true, async () => { throw new Error("422 from the tracker, quoting ticket text"); });
    server = await serveBoard({ port: 0, view: async () => empty, retry: r.retry });
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await get(server.port, "/tickets/19/retry", { method: "POST", headers: ours() });
      expect(res.status).toBe(502);
      expect(res.body).toMatch(/could not post the reply/);
      expect(res.body).not.toContain("quoting ticket text");
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("sends the CSP and no-store headers, and no Access-Control-Allow-*, on a retry response", async () => {
    server = await serveBoard({ port: 0, view: async () => empty, retry: retrying().retry });
    const res = await get(server.port, "/tickets/19/retry", { method: "POST", headers: ours() });
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(Object.keys(res.headers).some((h) => h.toLowerCase().startsWith("access-control-allow"))).toBe(false);
  });
});
