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

/** The ticket panel's routes: one ticket, named in the path, and what is asked of it. */
const PANEL_PATH = /^\/tickets\/([^/]+)\/(activity|conversation|reply|ask|resolve)$/;

/** Far past what a record carries (conventions' own cap is 32 KiB): the post's own check words the limit. */
const MAX_BODY_BYTES = 256 * 1024;

/** A write's text, or null when it runs past MAX_BODY_BYTES. */
function bodyOf(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) resolve(null);
      else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * The ticket panel: two reads and three writes on one ticket. Its activity
 * is a local file read, open like /board.json. Its conversation spends a
 * tracker read, so like /refresh it is asked only from the page's own script
 * — a cross-site `<img>` would otherwise make the operator's token pay for
 * one. Reply, Ask and Resolve each carry their own name in the header, like
 * every other write here; Ask and Resolve hand the ticket back to the loop,
 * so they wake it.
 */
function servePanel(
  opts: UiOptions, req: IncomingMessage, res: ServerResponse, port: number, id: string, what: string,
): void {
  const text = "text/plain; charset=utf-8";
  const panel = opts.panel;
  if (!panel) return send(res, 404, text, "not found");
  const reading = what === "activity" || what === "conversation";
  if (req.method !== (reading ? "GET" : "POST")) return send(res, 405, text, "method not allowed");
  if (what !== "activity") {
    const foreign = foreignWrite(req, what, port);
    if (foreign) return send(res, 403, text, foreign);
  }
  let ticket: string;
  try {
    ticket = decodeURIComponent(id);
  } catch {
    return send(res, 400, text, "that is not a ticket id");
  }
  const problem = ticketIdProblem(ticket);
  if (problem) return send(res, 400, text, problem);

  const json = (value: unknown): void => send(res, 200, "application/json; charset=utf-8", JSON.stringify(value));

  if (what === "activity") {
    const after = new URL(req.url ?? "/", "http://x").searchParams.get("after") ?? "0";
    if (!/^\d+$/.test(after)) return send(res, 400, text, "after must be a whole number");
    // A local file, nothing that can quote a tracker; still never a stack trace.
    panel.activity(ticket, Number(after)).then(json, () => send(res, 500, text, "the activity could not be read"));
    return;
  }
  if (what === "conversation") {
    panel.conversation(ticket).then(json, (e: unknown) => {
      // Logged in full for the operator; the page gets a fixed sentence,
      // because a tracker's error can quote the ticket it refused.
      console.error(`landrace: reading #${ticket}'s conversation failed: ${oneLine(messageOf(e))}`);
      send(res, 502, text, "could not read the conversation; the landrace log says why");
    });
    return;
  }

  bodyOf(req).then(async (body) => {
    if (body === null) return send(res, 413, text, "that is far longer than a comment can be");
    if (what !== "resolve" && body.trim() === "") return send(res, 400, text, "write something first");
    try {
      if (what === "reply") {
        await panel.reply(ticket, body);
        // A reply is a comment and nothing more: the loop reads it on its
        // own next pass, as it would one typed into the tracker.
        return send(res, 200, text, "posted");
      }
      const answer = what === "ask" ? await panel.ask(ticket, body) : await panel.resolve(ticket);
      // The ticket is back in the loop's hands: the pass that picks it up
      // runs now, not when the countdown comes round.
      opts.tick?.();
      return json(answer);
    } catch (e) {
      // Said, not hidden: the person waiting on a paid turn needs "no
      // session to join yet" or "screening blocked this turn", and the
      // panel wiring has already scrubbed secrets out of it. One line,
      // because the page shows it on one.
      console.error(`landrace: ${what} on #${ticket} failed: ${oneLine(messageOf(e))}`);
      return send(res, 502, text, oneLine(messageOf(e)));
    }
  }, () => send(res, 400, text, "the request could not be read"));
}

/**
 * The page's request listener, apart from the socket it is served on, so a
 * test can drive it in-process. `port` is the one the server listened on,
 * asked for per request because it is only known once listening has begun.
 */
export function boardListener(opts: UiOptions, portOf: () => number): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const port = portOf();
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
      const woke = opts.tick();
      if (woke === "stopped") send(res, 503, "text/plain; charset=utf-8", "landrace is stopping");
      else send(res, 202, "text/plain; charset=utf-8", `tick ${woke}`);
      return;
    }

    // The page's fourth write: re-read the tracker and reload the board from
    // it. No converge, no step, no agent — but still a tracker read the page
    // itself pays for, so it is guarded exactly like the other three rather
    // than left open as a plain GET would be.
    if (path === "/refresh") {
      if (!opts.refresh) {
        send(res, 404, "text/plain; charset=utf-8", "not found");
        return;
      }
      if (req.method !== "POST") {
        send(res, 405, "text/plain; charset=utf-8", "method not allowed");
        return;
      }
      const foreign = foreignWrite(req, "refresh", port);
      if (foreign) {
        send(res, 403, "text/plain; charset=utf-8", foreign);
        return;
      }
      opts.refresh().then(
        () => send(res, 200, "text/plain; charset=utf-8", "refreshed"),
        (e: unknown) => {
          // Logged in full for the operator; the page gets a fixed sentence,
          // because a tracker's error can quote the ticket it refused.
          console.error(`landrace: refresh failed: ${oneLine(messageOf(e))}`);
          send(res, 502, "text/plain; charset=utf-8", "could not refresh; the landrace log says why");
        },
      );
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
        (r) => {
          if ("refused" in r) {
            send(res, 409, "text/plain; charset=utf-8", r.refused);
            return;
          }
          // The person is waiting on the ticket they just sent back: the
          // pass that picks it up runs now, not when the countdown comes round.
          opts.tick?.();
          send(res, 202, "text/plain; charset=utf-8", `sent #${ticket} back to ${r.to}`);
        },
        (e: unknown) => {
          // Logged in full for the operator; the page gets a fixed sentence,
          // because a tracker's error can quote the ticket it refused.
          console.error(`landrace: sending #${ticket} back failed: ${oneLine(messageOf(e))}`);
          send(res, 502, "text/plain; charset=utf-8", "could not send it back; the landrace log says why");
        },
      );
      return;
    }

    const panelling = PANEL_PATH.exec(path);
    if (panelling) {
      servePanel(opts, req, res, port, panelling[1] ?? "", panelling[2] ?? "");
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
  };
}

/**
 * The triage page, on loopback only. Every route is a GET except the page's
 * writes: POST /tick, present only when the caller hands us a schedule to
 * wake; POST /tickets/<id>/retry and /tickets/<id>/goto/<stage>, present
 * only when it hands us a way to send a ticket back, and which wake that
 * schedule too once they have; POST /refresh, present only when it hands us
 * a way to re-read the tracker, which starts no agent but still spends a
 * tracker read and so is guarded the same way; and the ticket panel's
 * Reply, Ask and Resolve, present only when it hands us a panel.
 */
export function serveBoard(opts: UiOptions): Promise<UiServer> {
  let port = 0;
  const server = createServer(boardListener(opts, () => port));

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
