import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isIPv6 } from "node:net";
import type { Response } from "express";
import { express } from "#front/express.js";
import type { FrontDoorOptions, McpEndpoint, Person, RemoteDoor, UiServer } from "#namespace.js";
import { allowedHosts, frontDoorOrigins } from "#front/hosts.js";
import { createMcpAuth } from "#front/mcp-auth.js";
import { cookie, cookieOf } from "#people/session.js";
import { messageOf, Refusal } from "#runner/errors.js";
import { boardListener, foreignOrigin, knownHost, send } from "#ui/server.js";

const TEXT = "text/plain; charset=utf-8";

/**
 * The front door's request listener for one bound port: the Host check
 * first, for every path — DNS rebinding reaches `/mcp`, whose tools move
 * items, as surely as it reaches the board — then `/mcp`, refused a foreign
 * `Origin` because a page elsewhere in the person's browser could otherwise
 * call its tools, then the board's own routes.
 *
 * With `callerOf`, every request after the Host check is someone's: their
 * board, their MCP sessions, and nobody known is 401. Locally that is
 * always the local person.
 */
export function frontDoorListener(opts: FrontDoorOptions, port: number): (req: IncomingMessage, res: ServerResponse) => void {
  const hosts = allowedHosts(opts, port);
  const { origins } = frontDoorOrigins(opts, port);
  const remote = opts.remote ? remoteApp(opts.remote, opts.publicUrl, origins, opts.mcp) : null;
  const board = boardListener({ ...opts.board, allowedHosts: hosts, origins });
  const boardOf = (caller: Person | undefined): ((req: IncomingMessage, res: ServerResponse) => void) =>
    caller === undefined || !opts.boardFor ? board : boardListener({ ...opts.boardFor(caller), allowedHosts: hosts, origins });
  return (req, res) => {
    if (!knownHost(req, hosts)) return send(res, 421, TEXT, "misdirected request");
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (remote && REMOTE_PATHS.test(path)) {
      if (path === "/mcp" && foreignOrigin(req, origins)) return send(res, 403, TEXT, "refused: this endpoint answers only this machine's own clients");
      return remote(req, res);
    }
    let caller: Person | undefined;
    if (opts.callerOf) {
      const known = opts.callerOf(req);
      if (known === null) return refuseAnonymous(opts.remote, req, res, path);
      caller = known;
    }
    if (path === "/mcp") {
      if (!opts.mcp) return send(res, 404, TEXT, "not found");
      if (foreignOrigin(req, origins)) return send(res, 403, TEXT, "refused: this endpoint answers only this machine's own clients");
      return opts.mcp.handle(req, res, caller);
    }
    return boardOf(caller)(req, res);
  };
}

/**
 * What a remote door answers before anyone is known: signing in, the MCP
 * clients' authorization server and its metadata, and `/mcp` itself,
 * which knows its caller by a bearer token rather than a cookie.
 */
const REMOTE_PATHS = /^\/(login|login\/callback|logout|authorize|authorize\/consent|token|register|revoke|mcp|\.well-known\/oauth-[a-z-]+(\/mcp)?)$/;

/**
 * What /logout answers. Signing in again is a link a person clicks, never a
 * redirect or a refresh: the provider may still remember them, and would
 * hand them a new session without asking.
 */
const SIGNED_OUT = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Signed out — Landrace</title></head>
<body><h1>You are signed out of Landrace</h1>
<p>Your identity provider may still have you signed in. On a shared computer, sign out there too.</p>
<p><a href="/login">Sign in again</a></p></body></html>
`;

/** The cookie that binds a sign-in to the browser that began it, sent back only to the callback. */
const LOGIN_COOKIE = "landrace_login";

/**
 * Nobody known asked for something of someone's. A page — what a browser
 * navigates to — is sent to sign in and brought back; anything else, a
 * script's fetch, is 401, since a redirect to a sign-in page is no answer
 * to it. Locally `callerOf` always names someone, and this is never reached.
 */
function refuseAnonymous(remote: RemoteDoor | undefined, req: IncomingMessage, res: ServerResponse, path: string): void {
  const page = req.method === "GET" && (path === "/" || req.headers["sec-fetch-mode"] === "navigate");
  const status = page ? 302 : 401;
  remote?.log("request.refused", { person: "anonymous", path, status });
  if (!page) return send(res, 401, TEXT, "who is asking is not known; sign in first");
  res.writeHead(302, { location: `/login?return=${encodeURIComponent(req.url ?? "/")}`, "cache-control": "no-store" });
  res.end();
}

/**
 * The remote door's own routes, on Express because the MCP SDK's
 * authorization server is built on it. Behind the operator's TLS proxy on
 * this machine, the client's address is the one it forwards: what the
 * authorization server's rate limits count by.
 */
function remoteApp(
  door: RemoteDoor, publicUrl: string | undefined, origins: readonly string[], mcp: McpEndpoint | undefined,
): (req: IncomingMessage, res: ServerResponse) => void {
  if (publicUrl === undefined) throw new Error("a remote door needs serve.publicUrl: its sign-in callback and its authorization server are built from it");
  const secure = new URL(publicUrl).protocol === "https:";
  const auth = createMcpAuth({ publicUrl, sessions: door.sessions, root: door.authRoot, origins, log: door.log });
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  const text = (res: Response, status: number, body: string): void => {
    res.status(status).set({ "cache-control": "no-store", "x-content-type-options": "nosniff" }).type("text/plain").send(body);
  };
  const failed = (res: Response, what: string) => (e: unknown): void => {
    console.error(door.log.scrub(`landrace: ${what} failed: ${messageOf(e)}`));
    if (!res.headersSent) text(res, 502, `${what} failed; the landrace log says why`);
  };

  app.get("/login", (req, res) => {
    const asked = typeof req.query["return"] === "string" ? req.query["return"] : null;
    door.oidc.begin(asked).then(({ url, binding }) => {
      res.set({
        "set-cookie": cookie(LOGIN_COOKIE, binding, { secure, maxAgeSeconds: 600, path: "/login" }), "cache-control": "no-store", "referrer-policy": "no-referrer",
      }).redirect(302, url);
    }, failed(res, "starting the sign-in"));
  });

  app.get("/login/callback", (req, res) => {
    const callback = new URL(req.originalUrl, publicUrl);
    const cleared = cookie(LOGIN_COOKIE, "", { secure, maxAgeSeconds: 0, path: "/login" });
    const refused = (status: number, reason: string, email?: string): void => {
      door.log("signin.refused", { person: "anonymous", ...(email === undefined ? {} : { personEmail: email }), reason });
      res.set("set-cookie", cleared);
      text(res, status, reason);
    };
    door.oidc.finish(callback, cookieOf(req, LOGIN_COOKIE)).then(async (done) => {
      if ("refused" in done) return refused(done.status, done.refused);
      try {
        await door.signIn(done.person);
      } catch (e) {
        if (e instanceof Refusal) return refused(403, e.message, done.person.email);
        throw e;
      }
      door.log("signin.ok", { person: done.person.id, ...(done.person.email === undefined ? {} : { personEmail: done.person.email }) });
      res.set({ "set-cookie": [cleared, door.sessions.issue(done.person)], "cache-control": "no-store", "referrer-policy": "no-referrer" }).redirect(302, done.returnTo);
    }).catch(failed(res, "signing in"));
  });

  // A GET too: signing someone out from another site is a nuisance, never a way in.
  // It lands on a page of its own: sent on to /login, the provider's own live
  // session signed the person straight back in, and signing out never took effect.
  app.all("/logout", (req, res) => {
    res.status(200).set({
      "set-cookie": door.sessions.end(req), "cache-control": "no-store", "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'", "x-frame-options": "DENY",
    }).type("html").send(SIGNED_OUT);
  });

  app.use(auth.router);

  app.all("/mcp", auth.bearer, (req, res) => {
    const caller = auth.personOf(req);
    if (caller === null || !mcp) return text(res, caller === null ? 401 : 404, caller === null ? "who is asking is not known" : "not found");
    mcp.handle(req, res, caller);
  });

  return (req, res) => app(req, res);
}

/**
 * The board and the operator's MCP endpoint on one port, bound to
 * `opts.host`. Its URL is `publicUrl` when one is configured — where a person
 * reaches it — else the address it bound.
 */
export function serveFrontDoor(opts: FrontDoorOptions): Promise<UiServer> {
  let listener: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;
  // Built once the port is known, since every name it answers carries it.
  const server = createServer((req, res) => (listener ? listener(req, res) : send(res, 503, TEXT, "starting")));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      server.off("error", reject);
      const port = (server.address() as AddressInfo).port;
      listener = frontDoorListener(opts, port);
      const scrub = opts.scrub ?? opts.remote?.log.scrub ?? ((text: string) => text);
      server.on("error", (e) => console.error(scrub(`landrace: front door error: ${messageOf(e)}`)));
      const bound = isIPv6(opts.host) ? `[${opts.host}]` : opts.host;
      resolve({
        url: opts.publicUrl ?? `http://${bound}:${port}/`,
        port,
        host: opts.host,
        close: async () => {
          await opts.mcp?.close();
          await new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          });
        },
      });
    });
  });
}
