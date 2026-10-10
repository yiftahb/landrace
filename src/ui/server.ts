import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { itemIdProblem } from "#conventions.js";
import type { UiOptions, UiServer } from "#namespace.js";
import { messageOf, Refusal } from "#runner/errors.js";
import { oneLine } from "#runner/status.js";
import { APP_CSS, APP_JS, FAVICON_SVG, PAGE_HTML, THEME_JS } from "#ui/page.js";

const HOST = "127.0.0.1";

/** Even a slipped innerHTML in the page could not run a script under this. */
const CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "img-src 'self'",
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join("; ");

const STATIC: Record<string, { type: string; body: string }> = {
  "/": { type: "text/html; charset=utf-8", body: PAGE_HTML },
  "/app.js": { type: "text/javascript; charset=utf-8", body: APP_JS },
  "/app.css": { type: "text/css; charset=utf-8", body: APP_CSS },
  "/theme.js": { type: "text/javascript; charset=utf-8", body: THEME_JS },
  "/favicon.svg": { type: "image/svg+xml", body: FAVICON_SVG },
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

/** Where the page's Retry posts: one item, named in the path. */
const RETRY_PATH = /^\/items\/([^/]+)\/retry$/;

/** Where the page's Clear & retry posts: one item, named in the path. */
const CLEAR_PATH = /^\/items\/([^/]+)\/clear$/;

/** Where the page's "Go to step…" posts: one item, and the step it names. */
const GOTO_PATH = /^\/items\/([^/]+)\/goto\/([^/]+)$/;

/** Where the page's Start work posts: one item, and the workflow it is admitted to. */
const ADMIT_PATH = /^\/items\/([^/]+)\/admit\/([^/]+)$/;

/** Any Unicode control, format, or line/paragraph separator: nothing a name the page shows back may carry. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

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

/** The item panel's routes: one item, named in the path, and what is asked of it. */
const PANEL_PATH = /^\/items\/([^/]+)\/(activity|conversation|reply|ask|resolve|pairing|pair|finish|release)$/;

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
 * The item panel: three reads and six writes on one item. Its activity
 * is a local file read, open like /board.json. Its conversation and its
 * Pairing section each spend a tracker read, so like /refresh they are asked
 * only from the page's own script — a cross-site `<img>` would otherwise make
 * the operator's token pay for one. Reply, Ask, Resolve, and a pairing's
 * Pair, Finish and Release each carry their own name in the header, like
 * every other write here; all but Reply move the item, so they wake the loop.
 */
function servePanel(
  opts: UiOptions, req: IncomingMessage, res: ServerResponse, port: number, id: string, what: string,
): void {
  const text = "text/plain; charset=utf-8";
  const panel = opts.panel;
  if (!panel) return send(res, 404, text, "not found");
  const reading = what === "activity" || what === "conversation" || what === "pairing";
  if (req.method !== (reading ? "GET" : "POST")) return send(res, 405, text, "method not allowed");
  if (what !== "activity") {
    const foreign = foreignWrite(req, what, port);
    if (foreign) return send(res, 403, text, foreign);
  }
  let item: string;
  try {
    item = decodeURIComponent(id);
  } catch {
    return send(res, 400, text, "that is not an item id");
  }
  const problem = itemIdProblem(item);
  if (problem) return send(res, 400, text, problem);

  const json = (value: unknown): void => send(res, 200, "application/json; charset=utf-8", JSON.stringify(value));

  if (what === "activity") {
    const after = new URL(req.url ?? "/", "http://x").searchParams.get("after") ?? "0";
    if (!/^\d+$/.test(after)) return send(res, 400, text, "after must be a whole number");
    // A local file, nothing that can quote a tracker; still never a stack trace.
    panel.activity(item, Number(after)).then(json, () => send(res, 500, text, "the activity could not be read"));
    return;
  }
  if (what === "conversation" || what === "pairing") {
    (what === "conversation" ? panel.conversation(item) : panel.pairing(item)).then(json, (e: unknown) => {
      // Declined, not failed: the item is no one workflow's to read for.
      if (e instanceof Refusal) return send(res, 409, text, oneLine(e.message));
      // Logged in full for the operator; the page gets a fixed sentence,
      // because a tracker's error can quote the item it refused.
      console.error(`landrace: reading #${item}'s ${what} failed: ${oneLine(messageOf(e))}`);
      send(res, 502, text, `could not read the ${what}; the landrace log says why`);
    });
    return;
  }

  bodyOf(req).then(async (body) => {
    if (body === null) return send(res, 413, text, "that is far longer than a comment can be");
    // A Resolve, a Finish's note and a Release may all be empty; the rest say something.
    const needsText = what === "reply" || what === "ask" || what === "pair";
    if (needsText && body.trim() === "") return send(res, 400, text, what === "pair" ? "name a step to pair on" : "write something first");
    // A hand-in that is refused has still written the rejected round, which
    // the loop is what halts the item on — so it wakes either way.
    const wakesAnyway = what === "finish";
    try {
      if (what === "reply") {
        await panel.reply(item, body);
        // A reply is a comment and nothing more: the loop reads it on its
        // own next pass, as it would one typed into the tracker.
        return send(res, 200, text, "posted");
      }
      const answer = what === "ask" ? await panel.ask(item, body)
        : what === "pair" ? await panel.pair(item, body.trim())
        : what === "finish" ? await panel.finish(item, body)
        : what === "release" ? await panel.release(item)
        : await panel.resolve(item);
      // The item is back in the loop's hands: the pass that picks it up
      // runs now, not when the countdown comes round.
      opts.tick?.();
      return json(answer);
    } catch (e) {
      // Declined before anything was asked of any workflow: nothing was
      // written, so nothing wakes, and the sentence is the whole answer.
      if (e instanceof Refusal) return send(res, 409, text, oneLine(e.message));
      if (wakesAnyway) opts.tick?.();
      // Said, not hidden: the person waiting on a paid turn needs "no
      // session to join yet" or "screening blocked this turn", and the
      // panel wiring has already scrubbed secrets out of it. One line,
      // because the page shows it on one.
      console.error(`landrace: ${what} on #${item} failed: ${oneLine(messageOf(e))}`);
      return send(res, 502, text, oneLine(messageOf(e)));
    }
  }, () => send(res, 400, text, "the request could not be read"));
}

/**
 * Start work on a Not admitted item: the workflow's admit labels added, and
 * the loop woken for the tick that starts it. A refusal is said in its own
 * sentence, like a refused goto; a tracker's failure in a fixed one.
 */
function serveAdmit(opts: UiOptions, req: IncomingMessage, res: ServerResponse, port: number, id: string, wf: string): void {
  const text = "text/plain; charset=utf-8";
  const admit = opts.admit;
  if (!admit) return send(res, 404, text, "not found");
  if (req.method !== "POST") return send(res, 405, text, "method not allowed");
  const foreign = foreignWrite(req, "admit", port);
  if (foreign) return send(res, 403, text, foreign);
  let item: string;
  let workflow: string;
  try {
    item = decodeURIComponent(id);
    workflow = decodeURIComponent(wf);
  } catch {
    return send(res, 400, text, "that is not an item and a workflow");
  }
  const problem = itemIdProblem(item);
  if (problem) return send(res, 400, text, problem);
  // `admitItem`, not this route, decides whether the workspace has it.
  if (workflow === "" || UNPRINTABLE.test(workflow)) return send(res, 400, text, "that is not a workflow");
  admit(item, workflow).then(
    (r) => {
      opts.tick?.();
      const added = r.labels.length ? `added ${r.labels.join(", ")}` : "added nothing";
      send(res, 202, text, `admitted #${item} to ${r.workflow}: ${added}; the next tick starts it`);
    },
    (e: unknown) => {
      // Declined before anything was written: nothing wakes, and the sentence is the answer.
      if (e instanceof Refusal) return send(res, 409, text, oneLine(e.message));
      // Logged in full for the operator; the page gets a fixed sentence,
      // because a tracker's error can quote the item it refused.
      console.error(`landrace: admitting #${item} to ${workflow} failed: ${oneLine(messageOf(e))}`);
      send(res, 502, text, "could not start work on it; the landrace log says why");
    },
  );
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
    // private item titles through the user's browser.
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
          // because a tracker's error can quote the item it refused.
          console.error(`landrace: refresh failed: ${oneLine(messageOf(e))}`);
          send(res, 502, "text/plain; charset=utf-8", "could not refresh; the landrace log says why");
        },
      );
      return;
    }

    // The page's item writes, guarded the same way as /tick, and answered
    // in short sentences the page shows beside the menu item that asked. A Retry
    // is a goto with no step named: the stage that last failed. A Clear &
    // retry is a Retry that also clears that step's next round of the
    // security check — `sendTo` alone decides whether the item was screened.
    const retrying = RETRY_PATH.exec(path);
    const clearing = retrying ? null : CLEAR_PATH.exec(path);
    const going = retrying || clearing ? null : GOTO_PATH.exec(path);
    const writing = retrying ?? clearing ?? going;
    if (writing) {
      if (!opts.goto) {
        send(res, 404, "text/plain; charset=utf-8", "not found");
        return;
      }
      if (req.method !== "POST") {
        send(res, 405, "text/plain; charset=utf-8", "method not allowed");
        return;
      }
      const foreign = foreignWrite(req, retrying ? "retry" : clearing ? "clear" : "goto", port);
      if (foreign) {
        send(res, 403, "text/plain; charset=utf-8", foreign);
        return;
      }
      let item: string;
      let target: string | null = null;
      try {
        item = decodeURIComponent(writing[1] ?? "");
        if (going) target = decodeURIComponent(going[2] ?? "");
      } catch {
        // A Retry's path names only an item, so a malformed `%` there can
        // only be a bad item id; a goto's path names both, and decoding
        // does not say which one broke.
        send(res, 400, "text/plain; charset=utf-8", going ? "that is not an item and a step" : "that is not an item id");
        return;
      }
      const problem = itemIdProblem(item);
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
      if (target !== null && (target === "" || UNPRINTABLE.test(target))) {
        send(res, 400, "text/plain; charset=utf-8", "that is not a step");
        return;
      }
      const goto = opts.goto;
      Promise.resolve().then(() => (clearing ? goto.send(item, target, { clear: true }) : goto.send(item, target))).then(
        (r) => {
          if ("refused" in r) {
            send(res, 409, "text/plain; charset=utf-8", r.refused);
            return;
          }
          // The person is waiting on the item they just sent back: the
          // pass that picks it up runs now, not when the countdown comes round.
          opts.tick?.();
          send(res, 202, "text/plain; charset=utf-8", clearing
            ? `cleared #${item} of the security check and sent it back to ${r.to}`
            : `sent #${item} back to ${r.to}`);
        },
        (e: unknown) => {
          // Logged in full for the operator; the page gets a fixed sentence,
          // because a tracker's error can quote the item it refused.
          console.error(`landrace: sending #${item} back failed: ${oneLine(messageOf(e))}`);
          send(res, 502, "text/plain; charset=utf-8", "could not send it back; the landrace log says why");
        },
      );
      return;
    }

    // The page's Start work, guarded like every other write, under its own
    // header. `admitItem` reads the item again and alone decides; the row's
    // offer was only its prediction.
    const admitting = ADMIT_PATH.exec(path);
    if (admitting) {
      serveAdmit(opts, req, res, port, admitting[1] ?? "", admitting[2] ?? "");
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
 * wake; POST /items/<id>/retry and /items/<id>/goto/<stage>, present
 * only when it hands us a way to send an item back, and which wake that
 * schedule too once they have; POST /refresh, present only when it hands us
 * a way to re-read the tracker, which starts no agent but still spends a
 * tracker read and so is guarded the same way; the item panel's
 * Reply, Ask and Resolve, present only when it hands us a panel; and
 * POST /items/<id>/admit/<workflow>, Start work, present only when it hands
 * us a way to admit, and which wakes the schedule once it has.
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
