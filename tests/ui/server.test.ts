import { request } from "node:http";
import type { BoardView, UiServer } from "#namespace.js";
import { serveBoard } from "#ui/server.js";

const empty: BoardView = { generatedAt: 1, listedAt: null, rows: [] };

/** A raw request, so a test can send a Host header fetch would refuse to forge. */
function get(port: number, path: string, opts: { host?: string; method?: string } = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: { host: opts.host ?? `127.0.0.1:${port}` } },
      (res) => {
        let body = "";
        res.on("data", (d: Buffer) => { body += d.toString(); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
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
    for (const path of ["/", "/app.js", "/board.json", "/nope"]) {
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
});
