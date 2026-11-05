import type { IncomingMessage, ServerResponse } from "node:http";
import { itemIdProblem } from "#conventions.js";
import type { UiOptions } from "#namespace.js";
import { messageOf, Refusal } from "#runner/errors.js";
import { oneLine } from "#runner/status.js";
import { APP_CSS, APP_JS, FAVICON_SVG, PAGE_HTML, THEME_JS } from "#ui/page.js";

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

export function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, {
    "content-type": type,
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  res.end(body);
}

/** Whether a request names an `Origin` other than the door's own; absent is not foreign. */
export function foreignOrigin(req: IncomingMessage, origins: readonly string[]): boolean {
  const origin = req.headers.origin;
  return origin !== undefined && !origins.includes(origin.toLowerCase());
}

/** Whether a request's Host is one the door answers; DNS rebinding sends a stranger's. */
export function knownHost(req: IncomingMessage, hosts: readonly string[]): boolean {
  const host = req.headers.host;
  return host !== undefined && hosts.includes(host.toLowerCase());
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
function foreignWrite(req: IncomingMessage, action: string, origins: readonly string[]): string | null {
  // One sentence for every refusal, shown as-is where the page asked: which
  // check failed is for a debugger, not for the person clicking.
  const refused = "refused: this can be asked only from the Landrace page itself";
  if (req.headers[ACTION_HEADER] !== action) return refused;
  if (foreignOrigin(req, origins)) return refused;
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin") return refused;
  return null;
}

/** The item panel's routes: one item, named in the path, and what is asked of it. */
const PANEL_PATH = /^\/items\/([^/]+)\/(activity|conversation|reply|ask|resolve|pairing|pair|finish|release)$/;

/** Every route about one item: the panel's, a Retry, Clear, Go to and Start work. */
const ITEM_PATH = /^\/items\/([^/]+)\//;

/** The panel's Pairing section: its read and its three writes. */
const PAIRING_PATH = /^\/items\/[^/]+\/(pairing|pair|finish|release)$/;

/** Far past what a record carries (conventions' own cap is 32 KiB): the post's own check words the limit. */
const MAX_BODY_BYTES = 256 * 1024;

/** A connect's body: a few fields of a token each, so anything near this is not one. */
const MAX_CONNECT_BYTES = 16 * 1024;

/** A write's text, or null when it runs past `limit` bytes. */
function bodyOf(req: IncomingMessage, limit: number = MAX_BODY_BYTES): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) resolve(null);
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
  opts: UiOptions, req: IncomingMessage, res: ServerResponse, id: string, what: string,
): void {
  const text = "text/plain; charset=utf-8";
  const panel = opts.panel;
  if (!panel) return send(res, 404, text, "not found");
  const reading = what === "activity" || what === "conversation" || what === "pairing";
  if (req.method !== (reading ? "GET" : "POST")) return send(res, 405, text, "method not allowed");
  if (what !== "activity") {
    const foreign = foreignWrite(req, what, opts.origins);
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
function serveAdmit(opts: UiOptions, req: IncomingMessage, res: ServerResponse, id: string, wf: string): void {
  const text = "text/plain; charset=utf-8";
  const admit = opts.admit;
  if (!admit) return send(res, 404, text, "not found");
  if (req.method !== "POST") return send(res, 405, text, "method not allowed");
  const foreign = foreignWrite(req, "admit", opts.origins);
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

/** Where the Integrations tab's writes post: the write, and the connection it names. */
const CONNECT_PATH = /^\/(connect|disconnect)\/([^/]+)$/;

/** A connect's body, `{ fields: { <name>: <text> } }`, or null when it is not one. */
function fieldsOf(body: string): Record<string, string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const fields = (parsed as { fields?: unknown } | null)?.fields;
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) return null;
  const entries = Object.entries(fields as Record<string, unknown>);
  return entries.every(([, v]) => typeof v === "string") ? Object.fromEntries(entries) as Record<string, string> : null;
}

/**
 * The Integrations tab. Its read is a local file, open like /board.json,
 * and holds states and hints, and the caller's own looked-up identities —
 * never a credential's value. Connect and Disconnect are
 * writes like every other here, each under its own header; a connect's body
 * is capped far below a comment's. A refusal — an unknown id, an identity, a
 * failing check — is 409 in its own scrubbed sentence; a reload that failed
 * after the value was stored is 502, in the panel's scrubbed sentence.
 */
function servePeople(opts: UiOptions, req: IncomingMessage, res: ServerResponse, path: string): void {
  const text = "text/plain; charset=utf-8";
  const people = opts.people;
  if (!people) return send(res, 404, text, "not found");
  const json = (value: unknown): void => send(res, 200, "application/json; charset=utf-8", JSON.stringify(value));
  const failed = (what: string) => (e: unknown): void => {
    if (e instanceof Refusal) return send(res, 409, text, oneLine(e.message));
    // The panel has already taken every secret out.
    console.error(`landrace: ${what} failed: ${oneLine(messageOf(e))}`);
    send(res, 502, text, oneLine(messageOf(e)));
  };
  if (path === "/people/me") {
    if (req.method !== "GET") return send(res, 405, text, "method not allowed");
    people.panel.me(people.caller(req)).then(json, failed("reading the connections"));
    return;
  }
  const [, action = "", raw = ""] = CONNECT_PATH.exec(path) ?? [];
  if (req.method !== "POST") return send(res, 405, text, "method not allowed");
  const foreign = foreignWrite(req, action, opts.origins);
  if (foreign) return send(res, 403, text, foreign);
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return send(res, 400, text, "that is not a connection");
  }
  if (id === "" || UNPRINTABLE.test(id)) return send(res, 400, text, "that is not a connection");
  const caller = people.caller(req);
  if (action === "disconnect") {
    people.panel.disconnect(caller, id).then(() => send(res, 200, text, `disconnected ${id}`), failed(`disconnecting ${id}`));
    return;
  }
  bodyOf(req, MAX_CONNECT_BYTES).then((body) => {
    if (body === null) return send(res, 413, text, "that is far longer than a credential can be");
    const fields = fieldsOf(body);
    if (fields === null) return send(res, 400, text, "send a JSON object whose fields holds each field's text");
    people.panel.connect(caller, id, fields).then(json, failed(`connecting ${id}`));
  }, () => send(res, 400, text, "the request could not be read"));
}

/** Where a Connect link starts an OAuth flow, and where the provider sends the person back: the connection it names. */
const OAUTH_PATH = /^\/connect\/([^/]+)\/(start|callback)$/;

/** Where the person lands once a callback stored the token: the page's own Integrations tab. */
const INTEGRATIONS_TAB = "/#/integrations";

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, {
    location,
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    // The callback's own URL carries the code and the state: neither goes on to the provider's next page.
    "referrer-policy": "no-referrer",
  });
  res.end();
}

/**
 * Connect with a provider: two GETs, since a link and a provider's redirect
 * are both a browser's navigation, which cannot carry the page's header.
 * The start is still refused when the browser says another site asked for
 * it. The callback cannot be — the provider is another site — so the state
 * it carries is what proves the flow was begun here, by this person, for
 * this connection. A refusal is 409 and anything else 502, in the panel's
 * scrubbed sentence; a stored token goes back to the Integrations tab.
 */
function serveOAuth(opts: UiOptions, req: IncomingMessage, res: ServerResponse, raw: string, step: string): void {
  const text = "text/plain; charset=utf-8";
  const people = opts.people;
  if (!people) return send(res, 404, text, "not found");
  if (req.method !== "GET") return send(res, 405, text, "method not allowed");
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return send(res, 400, text, "that is not a connection");
  }
  if (id === "" || UNPRINTABLE.test(id)) return send(res, 400, text, "that is not a connection");
  const failed = (e: unknown): void => {
    if (e instanceof Refusal) return send(res, 409, text, oneLine(e.message));
    console.error(`landrace: connecting ${id} failed: ${oneLine(messageOf(e))}`);
    send(res, 502, text, oneLine(messageOf(e)));
  };
  const caller = people.caller(req);
  if (step === "start") {
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin" && site !== "none") {
      return send(res, 403, text, "refused: this can be asked only from the Landrace page itself");
    }
    people.panel.begin(caller, id).then((url) => redirect(res, url), failed);
    return;
  }
  const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
  const param = (name: string): string | undefined => query.get(name) ?? undefined;
  people.panel.finish(caller, id, {
    state: param("state"), code: param("code"), error: param("error"), errorDescription: param("error_description"),
  }).then(() => redirect(res, INTEGRATIONS_TAB), failed);
}

/** What every board write answers while no runtime stands behind it: the page shows it beside the control. */
const UNREADY = "refused: Landrace is not running yet; connect what the Integrations tab lists first";

/**
 * The page's request listener, apart from the socket it is served on, so a
 * test can drive it in-process. Its hosts and origins are the ones the front
 * door computed once it knew the port it listened on.
 */
export function boardListener(opts: UiOptions): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    // DNS rebinding: a page on attacker.example can point its own name at
    // 127.0.0.1, and the browser will then send its requests here with that
    // name in Host. Answering only our own names is what stops it reading
    // private item titles through the user's browser. The front door checks
    // this before routing too; here as well, so the page never relies on it.
    if (!knownHost(req, opts.allowedHosts)) {
      send(res, 421, "text/plain; charset=utf-8", "misdirected request");
      return;
    }
    const path = (req.url ?? "/").split("?")[0] ?? "/";

    // Ahead of the board's routes: the Integrations tab is how a person who
    // is not ready becomes ready, so nothing below may stand in its way.
    if (path === "/people/me" || CONNECT_PATH.test(path)) {
      servePeople(opts, req, res, path);
      return;
    }
    const oauth = OAUTH_PATH.exec(path);
    if (oauth) {
      serveOAuth(opts, req, res, oauth[1] ?? "", oauth[2] ?? "");
      return;
    }

    // No runtime: no tick to wake, no source to read, no item to write to.
    // Refused before any of them is looked at, since none is there to answer.
    const unready = opts.ready !== undefined && !opts.ready();
    if (unready && (path === "/tick" || path === "/refresh" || path.startsWith("/items/"))) {
      send(res, 409, "text/plain; charset=utf-8", UNREADY);
      return;
    }

    // An item not on this caller's board is not there, whoever's it is: one
    // person never reaches another's item, nor learns that it exists. An id
    // that does not decode is the routes' own 400.
    const named = ITEM_PATH.exec(path);
    if (named && opts.has) {
      let item: string | null = null;
      try {
        item = decodeURIComponent(named[1] ?? "");
      } catch {
        item = null;
      }
      if (item !== null && !opts.has(item)) {
        send(res, 404, "text/plain; charset=utf-8", "not found");
        return;
      }
    }
    // A remote instance offers no pairing: its people have no terminal here to join one from.
    if (opts.pairing === false && PAIRING_PATH.test(path)) {
      send(res, 404, "text/plain; charset=utf-8", "not found");
      return;
    }

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
      const foreign = foreignWrite(req, "tick", opts.origins);
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
      const foreign = foreignWrite(req, "refresh", opts.origins);
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
      const foreign = foreignWrite(req, retrying ? "retry" : clearing ? "clear" : "goto", opts.origins);
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
      serveAdmit(opts, req, res, admitting[1] ?? "", admitting[2] ?? "");
      return;
    }

    const panelling = PANEL_PATH.exec(path);
    if (panelling) {
      servePanel(opts, req, res, panelling[1] ?? "", panelling[2] ?? "");
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
      // The page shows only the Integrations tab on this.
      if (unready) {
        send(res, 200, "application/json; charset=utf-8", JSON.stringify({ ready: false }));
        return;
      }
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
