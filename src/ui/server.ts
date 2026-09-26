import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ticketIdProblem } from "#conventions.js";
import type { UiOptions, UiServer } from "#namespace.js";
import { messageOf } from "#runner/errors.js";
import { oneLine } from "#runner/status.js";
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
const ACTION_HEADER = "x-landrace-action";

/** Where the page's Retry posts: one ticket, named in the path. */
const RETRY_PATH = /^\/tickets\/([^/]+)\/retry$/;

/** Where the page's "Go to step…" posts: one ticket, and the step it names. */
const GOTO_PATH = /^\/tickets\/([^/]+)\/goto\/([^/]+)$/;

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
 * Why a write did not come from this page's own script, or null if it did —
 * the one guard both of the page's writes stand behind, so they cannot drift
 * apart. `action` is the write's own name, carried in the header: a request
 * made for one write is not accepted by the other.
 *
 * HTML forms cannot set a custom header, and a cross-origin fetch that does
 * triggers a CORS preflight this server never answers with permission — so a
 * request that has the header proves it came from a script on this origin.
 * Absent Origin is allowed; present-and-foreign is refused. A browser sends
 * Origin on same-origin fetch POSTs too, so an absent one in practice means a
 * non-browser local client (curl, a script) rather than the page itself — and
 * the header check already covers what a browser could send without our
 * script's cooperation. Sec-Fetch-Site the same way: a browser that says the
 * request came from another site is believed.
 */
function foreignWrite(req: IncomingMessage, action: string, port: number): string | null {
  // One sentence for every refusal, shown as-is where the page asked: which
  // check failed is for a debugger, not for the person clicking.
  const refused = "refused: this can be asked only from the Landrace page itself";
  if (req.headers[ACTION_HEADER] !== action) return refused;
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${HOST}:${port}` && origin !== `http://localhost:${port}`) return refused;
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin") return refused;
  return null;
}

/**
 * The triage page, on loopback only. Every route is a GET except the page's
 * three writes: POST /tick, present only when the caller hands us a schedule
 * to trigger, and POST /tickets/<id>/retry and /tickets/<id>/goto/<stage>,
 * present only when it hands us a way to send a ticket back.
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
      // The Host check already pinned the server's own name, so `port` here
      // is the one the request actually landed on.
      const foreign = foreignWrite(req, "tick", port);
      if (foreign) {
        send(res, 403, "text/plain; charset=utf-8", foreign);
        return;
      }
      const started = opts.tick();
      send(res, started ? 202 : 409, "text/plain; charset=utf-8", started ? "tick started" : "a tick is already running");
      return;
    }

    // The page's ticket writes, guarded the same way as /tick, and answered
    // in short sentences the page shows beside the item that asked. A Retry
    // is a goto with no step named: the stage that last failed.
    const retrying = RETRY_PATH.exec(path);
    const going = retrying ? null : GOTO_PATH.exec(path);
    const writing = retrying ?? going;
    if (writing) {
      if (!opts.goto) {
        send(res, 404, "text/plain; charset=utf-8", "not found");
        return;
      }
      if (req.method !== "POST") {
        send(res, 405, "text/plain; charset=utf-8", "method not allowed");
        return;
      }
      const foreign = foreignWrite(req, retrying ? "retry" : "goto", port);
      if (foreign) {
        send(res, 403, "text/plain; charset=utf-8", foreign);
        return;
      }
      let ticket: string;
      let target: string | null = null;
      try {
        ticket = decodeURIComponent(writing[1] ?? "");
        if (going) target = decodeURIComponent(going[2] ?? "");
      } catch {
        // A Retry's path names only a ticket, so a malformed `%` there can
        // only be a bad ticket id; a goto's path names both, and decoding
        // does not say which one broke.
        send(res, 400, "text/plain; charset=utf-8", retrying ? "that is not a ticket id" : "that is not a ticket and a step");
        return;
      }
      const problem = ticketIdProblem(ticket);
      if (problem) {
        send(res, 400, "text/plain; charset=utf-8", problem);
        return;
      }
      // A step id is the workflow's own and unbounded in the schema — a
      // length cap invented here would refuse a longer valid one for no
      // reason — so this only guards an empty target and what would ride
      // along into the 409 sentence the page shows: any Unicode control,
      // format, or line/paragraph separator, printable otherwise or not.
      // `sendTo`, not this route, is what decides whether the step itself is
      // one this stage actually lists.
      if (target !== null && (target === "" || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(target))) {
        send(res, 400, "text/plain; charset=utf-8", "that is not a step");
        return;
      }
      const goto = opts.goto;
      Promise.resolve().then(() => goto.send(ticket, target)).then(
        (r) => ("refused" in r
          ? send(res, 409, "text/plain; charset=utf-8", r.refused)
          : send(res, 202, "text/plain; charset=utf-8", `sent #${ticket} back to ${r.to}`)),
        (e: unknown) => {
          // Logged in full for the operator; the page gets a fixed sentence,
          // because a tracker's error can quote the ticket it refused.
          console.error(`landrace: sending #${ticket} back failed: ${oneLine(messageOf(e))}`);
          send(res, 502, "text/plain; charset=utf-8", "could not send it back; the landrace log says why");
        },
      );
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
