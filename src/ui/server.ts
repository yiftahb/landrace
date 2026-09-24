import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { UiOptions, UiServer } from "#namespace.js";
import { messageOf } from "#runner/errors.js";
import { APP_CSS, APP_JS, PAGE_HTML, THEME_JS } from "#ui/page.js";

const HOST = "127.0.0.1";

/** Even a slipped innerHTML in the page could not run a script under this. */
const CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'",
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join("; ");

const STATIC: Record<string, { type: string; body: string }> = {
  "/": { type: "text/html; charset=utf-8", body: PAGE_HTML },
  "/app.js": { type: "text/javascript; charset=utf-8", body: APP_JS },
  "/app.css": { type: "text/css; charset=utf-8", body: APP_CSS },
  "/theme.js": { type: "text/javascript; charset=utf-8", body: THEME_JS },
};

/**
 * What proves a request came from this page's own script, not a cross-site
 * `<form>` or a plain `fetch` with no special treatment: a browser refuses to
 * let either of those set a custom header, and refuses to let a cross-origin
 * `fetch` that does set one reach the server at all, because a header outside
 * the CORS-safelisted set forces a preflight — and this server answers no
 * preflight with permission, so the browser never sends the real request.
 */
const TICK_HEADER = "x-landrace-action";
const TICK_HEADER_VALUE = "tick";

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, {
    "content-type": type,
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  res.end(body);
}

/**
 * The triage page, on loopback only. Every route is a GET except the one
 * write this page has: POST /tick, present only when the caller hands us a
 * schedule to trigger.
 */
export function serveBoard(opts: UiOptions): Promise<UiServer> {
  let port: number;

  const server = createServer((req, res) => {
    // DNS rebinding: a page on attacker.example can point its own name at
    // 127.0.0.1, and the browser will then send its requests here with that
    // name in Host. Answering only our own names is what stops it reading
    // private ticket titles through the user's browser.
    if (req.headers.host !== `${HOST}:${port}` && req.headers.host !== `localhost:${port}`) {
      send(res, 421, "text/plain; charset=utf-8", "misdirected request");
      return;
    }
    const path = (req.url ?? "/").split("?")[0] ?? "/";

    // The page's one write. Checked ahead of the blanket "GET only" rule
    // below, which would otherwise answer POST /tick with the same 405 it
    // gives every other route and never reach the checks that matter here.
    if (path === "/tick") {
      if (!opts.tick) {
        send(res, 404, "text/plain; charset=utf-8", "not found");
        return;
      }
      if (req.method !== "POST") {
        send(res, 405, "text/plain; charset=utf-8", "method not allowed");
        return;
      }
      // HTML forms cannot set a custom header, and a cross-origin fetch that
      // does triggers a CORS preflight this server never answers with
      // permission — so a request that has this header proves it came from
      // this page's own script, not a page an attacker put in the user's browser.
      if (req.headers[TICK_HEADER] !== TICK_HEADER_VALUE) {
        send(res, 403, "text/plain; charset=utf-8", "forbidden");
        return;
      }
      // Absent Origin is allowed; present-and-foreign is refused. A browser
      // sends Origin on same-origin fetch POSTs too, so an absent one in
      // practice means a non-browser local client (curl, a script) rather
      // than the page itself — and the header check above already covers
      // what a browser could send without our script's cooperation. The Host
      // check already pinned the server's own name, so `port` here is the
      // one the request actually landed on.
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== `http://${HOST}:${port}` && origin !== `http://localhost:${port}`) {
        send(res, 403, "text/plain; charset=utf-8", "forbidden");
        return;
      }
      const started = opts.tick();
      send(res, started ? 202 : 409, "text/plain; charset=utf-8", started ? "tick started" : "a tick is already running");
      return;
    }

    if (req.method !== "GET") {
      send(res, 405, "text/plain; charset=utf-8", "method not allowed");
      return;
    }
    const asset = STATIC[path];
    if (asset) {
      send(res, 200, asset.type, asset.body);
      return;
    }
    if (path === "/board.json") {
      opts.view().then(
        (view) => send(res, 200, "application/json; charset=utf-8", JSON.stringify(view)),
        // Fixed text: the error may quote tracker content, and this page is
        // not the place an operator reads a stack trace.
        () => send(res, 500, "text/plain; charset=utf-8", "the board could not be built"),
      );
      return;
    }
    send(res, 404, "text/plain; charset=utf-8", "not found");
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, HOST, () => {
      server.off("error", reject);
      port = (server.address() as AddressInfo).port;
      // Persistent error handler to prevent uncaught errors from crashing the process
      server.on("error", (e) => console.error(`landrace: triage page error: ${messageOf(e)}`));
      resolve({
        url: `http://${HOST}:${port}/`,
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}
