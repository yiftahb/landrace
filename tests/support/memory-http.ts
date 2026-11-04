import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { duplexPair, Readable } from "node:stream";

/**
 * A `fetch` that reaches `listener` through a real `http.Server` and a real
 * client request, over an in-memory stream pair instead of a socket: the
 * whole HTTP stack, headers and streamed bodies included, where a sandbox
 * may not bind even loopback. `host` is what the URL names, and what the
 * Host header carries.
 */
export function memoryFetch(listener: (req: IncomingMessage, res: ServerResponse) => void): typeof fetch {
  const server = createServer(listener);
  return (input, init) => new Promise<Response>((resolve, reject) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    const [here, there] = duplexPair();
    server.emit("connection", there);
    const req = request({
      host: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method: init?.method ?? "GET",
      headers: { host: url.host, ...headers }, createConnection: () => here,
    }, (res) => {
      const out = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (value !== undefined) out.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      const empty = res.statusCode === 202 || res.statusCode === 204;
      if (empty) res.resume();
      resolve(new Response(empty ? null : (Readable.toWeb(res) as ReadableStream), { status: res.statusCode ?? 0, headers: out }));
    });
    init?.signal?.addEventListener("abort", () => req.destroy(new Error("aborted")), { once: true });
    req.on("error", reject);
    req.end(typeof init?.body === "string" ? init.body : undefined);
  });
}
