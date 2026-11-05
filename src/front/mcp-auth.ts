import { createHash, randomBytes } from "node:crypto";
import { MCP_FOLDER } from "#people/sealed.js";
import { join } from "node:path";
import type { Request, Response } from "express";
import { express } from "#front/express.js";
import { InvalidGrantError, InvalidTargetError, InvalidTokenError, TemporarilyUnavailableError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { messageOf } from "#runner/errors.js";
import { foreignOrigin } from "#ui/server.js";
import type { IssuedAccess, McpAuth, Person, PendingConsent, RedactingLogger, SealedFiles, Sessions, StoredRefresh } from "#namespace.js";

/** A consent page's token, and the code it grants: each spent once, and worthless after this. */
const CONSENT_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 5 * 60_000;
/** An access token lasts an hour; its refresh token, rotated on each use, thirty days from the consent however often it is. */
const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
/** Registered clients kept at most; one older than a day with no live refresh token is pruned first. */
const MAX_CLIENTS = 1000;
const STALE_CLIENT_MS = 24 * 60 * 60_000;

/** The files this keeps, beside each other in the credentials root's `mcp/` folder. */
export const MCP_CLIENTS_FILE = "mcp-clients.json";
export const MCP_TOKENS_FILE = "mcp-tokens.json";

const hashOf = (token: string): string => createHash("sha256").update(token).digest("hex");
const secret = (): string => randomBytes(32).toString("base64url");

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/**
 * Where the consent page says it will send the person: the redirect's origin,
 * or, for a custom scheme such as an editor's `vscode://`, whose origin is the
 * string "null", the URI itself without its query.
 */
function whereTo(redirectUri: string): string {
  const url = new URL(redirectUri);
  if (url.origin !== "null") return url.origin;
  url.search = "";
  url.hash = "";
  return url.href;
}

/**
 * What every consent response carries. Nothing may frame it — a page that
 * overlaid an invisible frame of it would take the person's click on
 * Approve — and nothing it loads comes from anywhere. Its referrer policy is
 * `same-origin`, never `no-referrer`: under that a browser sends the form's
 * POST with `Origin: null`, which the Origin check refuses, so no real
 * browser could ever approve. Off-site it still sends nothing.
 */
const CONSENT_HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  "referrer-policy": "same-origin",
};

/** A JSON file written whole, sealed as the credentials are, 0600 under a 0700 directory: a crash mid-write leaves the old one. */
async function writeJson(files: SealedFiles, name: string, value: unknown): Promise<void> {
  await files.write(`${MCP_FOLDER}/${name}`, `${JSON.stringify(value, null, 2)}\n`);
}

/** One of this door's maps, empty when the file is not there yet; anything but a JSON object, or a file that does not open, is refused, naming the file. */
async function readMap<T>(files: SealedFiles, name: string): Promise<Map<string, T>> {
  const file = join(files.root, MCP_FOLDER, name);
  // Its own refusal names the file, and quotes none of it.
  const text = await files.read(`${MCP_FOLDER}/${name}`);
  if (text === null) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Never the parser's message: it quotes the text around the fault, which can be part of a secret.
    throw new Error(`${file} is not JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const held = parsed === null ? "null" : Array.isArray(parsed) ? "an array" : typeof parsed;
    throw new Error(`${file} cannot be read: it holds ${held}, not a JSON object`);
  }
  return new Map(Object.entries(parsed as Record<string, T>));
}

/**
 * Landrace as its own OAuth authorization server for MCP clients, over the
 * person's browser session: a client registers itself, sends the person to
 * `/authorize`, and gets a token for whoever signed in and consented. So an
 * MCP client needs no app at the identity provider, and a token is one
 * person's: `/mcp` serves their tools, never anyone else's.
 *
 * Registration is open, which is why consent is asked every time: a link to
 * `/authorize` with a stranger's client must not hand that client a token
 * just because the person clicking it is signed in. The consent page cannot
 * be framed, and its Approve is refused from another origin, or without the
 * one-time token the page carried — bound to this browser session and this
 * one authorization request — so neither an overlay nor a form on another
 * site can approve for them, whatever a browser does with SameSite.
 *
 * Registered clients and the hash of each refresh token are kept under the
 * credentials root's `mcp/`, 0600 and sealed as each person's file is, so a restart does not make every editor sign in again; a refresh
 * token is rotated on use, and the file never holds a token itself. Codes,
 * access tokens and consent tokens live in memory.
 *
 * Every grant is one `people.allow` still admits: a code, a refresh and each
 * request's access token are refused for anyone it no longer does, and
 * their refresh tokens are dropped from the file as it is read.
 */
export function createMcpAuth(opts: {
  publicUrl: string;
  sessions: Sessions;
  /** The credentials root's files, under whose `mcp/` folder the two maps are kept. */
  files: SealedFiles;
  /** The door's own origins: an approve from any other is refused. */
  origins: readonly string[];
  log: RedactingLogger;
  /** Whether `people.allow` admits the person: asked of every stored grant, code, refresh and access token. */
  admits: (person: Person) => boolean;
  now?: () => number;
}): McpAuth {
  const now = opts.now ?? Date.now;
  const issuer = new URL(opts.publicUrl);
  const resource = new URL("mcp", opts.publicUrl.endsWith("/") ? opts.publicUrl : `${opts.publicUrl}/`);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resource);

  // One write at a time: each writes the whole map, so two at once would race to rename.
  let writing: Promise<void> = Promise.resolve();
  const persist = (name: string, value: () => unknown): Promise<void> => {
    const next = writing.then(() => writeJson(opts.files, name, value()));
    writing = next.catch(() => {});
    return next;
  };

  // A refresh token of someone `people.allow` no longer admits is dropped as
  // the files are read, and the file written without it: removing a person
  // and restarting is the whole of revoking what their editors hold.
  const loaded = (async () => {
    const clients = await readMap<OAuthClientInformationFull>(opts.files, MCP_CLIENTS_FILE);
    const refresh = await readMap<StoredRefresh>(opts.files, MCP_TOKENS_FILE);
    const before = refresh.size;
    for (const [hash, r] of refresh) if (!opts.admits(r.person)) refresh.delete(hash);
    if (refresh.size !== before) await writeJson(opts.files, MCP_TOKENS_FILE, Object.fromEntries(refresh));
    return { clients, refresh };
  })();
  // Read as the door is built, and awaited only by the first MCP request: left
  // unhandled, a corrupt file would end `landrace start` in a stack trace just
  // after it binds. Said once here, and every MCP route answers with it.
  let unreadable: string | null = null;
  loaded.catch((e: unknown) => {
    // Scrubbed once, for the line and for every 503 that repeats it.
    unreadable = opts.log.scrub(messageOf(e));
    console.error(`landrace: MCP sign-in is off: ${unreadable}`);
  });
  const ready = (_req: Request, res: Response, next: () => void): void => {
    loaded.then(() => { next(); }, () => {
      res.status(503).type("text/plain").send(`MCP sign-in is off: ${unreadable ?? "its files cannot be read"}`);
    });
  };
  const saveClients = async (): Promise<void> => {
    const { clients } = await loaded;
    await persist(MCP_CLIENTS_FILE, () => Object.fromEntries(clients));
  };
  const saveRefresh = async (): Promise<void> => {
    const { refresh } = await loaded;
    const at = now();
    for (const [hash, r] of refresh) if (r.expires < at) refresh.delete(hash);
    await persist(MCP_TOKENS_FILE, () => Object.fromEntries(refresh));
  };

  const consents = new Map<string, PendingConsent>();
  const codes = new Map<string, { clientId: string; person: Person; challenge: string; redirectUri: string; resource?: string; expires: number; consentedAt: number }>();
  const access = new Map<string, IssuedAccess>();

  const prune = (): void => {
    const at = now();
    for (const [k, v] of consents) if (v.expires < at) consents.delete(k);
    for (const [k, v] of codes) if (v.expires < at) codes.delete(k);
    for (const [k, v] of access) if (v.expiresAt * 1000 < at) access.delete(k);
  };

  /** The resource a token is asked for must be this one: a token minted for `/mcp` is not one for another server. */
  const ownResource = (asked: URL | string | undefined): void => {
    if (asked === undefined) return;
    if (new URL(asked).href !== resource.href) throw new InvalidTargetError(`this server issues tokens for ${resource.href} alone`);
  };

  /**
   * A pair of tokens for a consent given at `consentedAt`. The refresh token
   * lasts thirty days from the consent, never from its last rotation: an
   * editor refreshing daily would otherwise hold its grant forever.
   */
  const issue = async (clientId: string, person: Person, scopes: string[], consentedAt: number): Promise<OAuthTokens> => {
    prune();
    const token = secret();
    const refreshToken = secret();
    access.set(token, { clientId, person, scopes, expiresAt: Math.floor(now() / 1000) + ACCESS_TTL_S });
    (await loaded).refresh.set(hashOf(refreshToken), { clientId, person, scopes, expires: consentedAt + REFRESH_TTL_MS, consentedAt });
    await saveRefresh();
    return { access_token: token, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refreshToken, ...(scopes.length ? { scope: scopes.join(" ") } : {}) };
  };

  const consentPage = (client: OAuthClientInformationFull, params: AuthorizationParams, person: Person, token: string): string => {
    const name = escapeHtml(client.client_name ?? "An unnamed MCP client");
    const to = escapeHtml(whereTo(params.redirectUri));
    const who = escapeHtml(person.email ?? person.id);
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Allow access to Landrace?</title>
<style>body{font:15px system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem}button{font:inherit;padding:.4rem 1rem;margin-right:.5rem}</style></head>
<body><h1>Allow ${name} to act as you?</h1>
<p>${name} asks to use Landrace's tools as <strong>${who}</strong>: to read your items and move them through your workflows.</p>
<p>It will be sent back to <code>${to}</code>. Approve only if you just asked your editor or agent to connect to Landrace.</p>
<form method="post" action="/authorize/consent"><input type="hidden" name="token" value="${escapeHtml(token)}">
<button type="submit" name="decision" value="approve">Approve</button><button type="submit" name="decision" value="deny">Deny</button></form>
</body></html>`;
  };

  const provider: OAuthServerProvider = {
    clientsStore: {
      getClient: async (id) => (await loaded).clients.get(id),
      // Open to anyone who reaches it, so bounded: a client that registered a
      // day ago and holds no refresh token never finished signing in, or was
      // let go, and gives way to a new one; past the cap, nobody new.
      registerClient: async (client) => {
        const full = client as OAuthClientInformationFull;
        const { clients, refresh } = await loaded;
        const at = now();
        const holding = new Set([...refresh.values()].filter((r) => r.expires >= at).map((r) => r.clientId));
        for (const [id, c] of clients) {
          const issued = c.client_id_issued_at;
          if (issued !== undefined && issued * 1000 < at - STALE_CLIENT_MS && !holding.has(id)) clients.delete(id);
        }
        if (clients.size >= MAX_CLIENTS) {
          throw new TemporarilyUnavailableError(`this instance holds too many registered clients (${MAX_CLIENTS}); ask its operator to clear ${MCP_CLIENTS_FILE}`);
        }
        clients.set(full.client_id, full);
        await saveClients();
        return full;
      },
    },
    authorize: async (client, params, res) => {
      const req = res.req;
      const person = opts.sessions.personOf(req);
      const session = opts.sessions.idOf(req);
      if (person === null || session === null) {
        // Back here once signed in, with the same request.
        res.redirect(302, `/login?return=${encodeURIComponent(req.originalUrl)}`);
        return;
      }
      prune();
      ownResource(params.resource);
      const token = secret();
      consents.set(token, { session, clientId: client.client_id, params: { state: params.state, codeChallenge: params.codeChallenge, redirectUri: params.redirectUri, resource: params.resource?.href }, expires: now() + CONSENT_TTL_MS });
      res.status(200).set({ ...CONSENT_HEADERS, "content-type": "text/html; charset=utf-8" }).send(consentPage(client, params, person, token));
    },
    challengeForAuthorizationCode: async (client, code) => {
      const held = codes.get(code);
      if (held === undefined || held.clientId !== client.client_id || held.expires < now()) throw new InvalidGrantError("that code is not valid");
      return held.challenge;
    },
    exchangeAuthorizationCode: async (client, code, _verifier, redirectUri, asked) => {
      const held = codes.get(code);
      codes.delete(code);
      if (held === undefined || held.clientId !== client.client_id || held.expires < now()) throw new InvalidGrantError("that code is not valid");
      if (redirectUri !== undefined && redirectUri !== held.redirectUri) throw new InvalidGrantError("that code was issued to another redirect URI");
      if (!opts.admits(held.person)) throw new InvalidGrantError("that code is not valid");
      ownResource(asked ?? held.resource);
      return issue(client.client_id, held.person, [], held.consentedAt);
    },
    exchangeRefreshToken: async (client, refreshToken, _scopes, asked) => {
      ownResource(asked);
      const { refresh } = await loaded;
      const hash = hashOf(refreshToken);
      const held = refresh.get(hash);
      if (held === undefined || held.clientId !== client.client_id || held.expires < now()) throw new InvalidGrantError("that refresh token is not valid");
      // Rotated: the one just used is spent, whatever comes next.
      refresh.delete(hash);
      if (!opts.admits(held.person)) {
        await saveRefresh();
        throw new InvalidGrantError("that refresh token is not valid");
      }
      // A record from before `consentedAt` was kept lasts until its own end:
      // the consent it implies is the one thirty days before that.
      return issue(client.client_id, held.person, held.scopes, held.consentedAt ?? held.expires - REFRESH_TTL_MS);
    },
    verifyAccessToken: async (token) => {
      const held = access.get(token);
      if (held !== undefined && !opts.admits(held.person)) access.delete(token);
      if (held === undefined || held.expiresAt * 1000 < now() || !opts.admits(held.person)) throw new InvalidTokenError("that token is not valid; sign in again");
      return { token, clientId: held.clientId, scopes: held.scopes, expiresAt: held.expiresAt, extra: { person: held.person } };
    },
    revokeToken: async (client, { token }) => {
      if (access.get(token)?.clientId === client.client_id) access.delete(token);
      const { refresh } = await loaded;
      if (refresh.get(hashOf(token))?.clientId === client.client_id) {
        refresh.delete(hashOf(token));
        await saveRefresh();
      }
    },
  };

  /** The approve: one consent page's token, from this origin and this session, spent whatever its answer. */
  const consent = async (req: Request, res: Response): Promise<void> => {
    const refuse = (status: number, reason: string): void => {
      opts.log("request.refused", { person: opts.sessions.personOf(req)?.id ?? "anonymous", path: "/authorize/consent", status, reason });
      res.status(status).set(CONSENT_HEADERS).type("text/plain").send(reason);
    };
    if (foreignOrigin(req, opts.origins)) return refuse(403, "refused: this can be approved only from Landrace's own consent page");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const token = typeof body["token"] === "string" ? body["token"] : "";
    const held = consents.get(token);
    consents.delete(token);
    if (held === undefined) return refuse(400, "that approval was not asked here, or was already answered; connect again");
    if (held.expires < now()) return refuse(400, "that approval took longer than ten minutes; connect again");
    const session = opts.sessions.idOf(req);
    const person = opts.sessions.personOf(req);
    if (session === null || person === null || session !== held.session) return refuse(403, "that approval was asked of another sign-in; connect again");
    const back = new URL(held.params.redirectUri);
    if (held.params.state !== undefined) back.searchParams.set("state", held.params.state);
    if (body["decision"] !== "approve") {
      back.searchParams.set("error", "access_denied");
      res.redirect(302, back.href);
      return;
    }
    const code = secret();
    codes.set(code, {
      clientId: held.clientId, person, challenge: held.params.codeChallenge, redirectUri: held.params.redirectUri,
      ...(held.params.resource === undefined ? {} : { resource: held.params.resource }), expires: now() + CODE_TTL_MS, consentedAt: now(),
    });
    back.searchParams.set("code", code);
    res.set({ "cache-control": "no-store", "referrer-policy": "no-referrer" }).redirect(302, back.href);
  };

  const router = express.Router();
  router.post("/authorize/consent", ready, express.urlencoded({ extended: false, limit: "8kb" }), (req, res) => {
    consent(req, res).catch((e: unknown) => {
      console.error(opts.log.scrub(`landrace: an approval failed: ${messageOf(e)}`));
      if (!res.headersSent) res.status(500).type("text/plain").send("the approval failed; the landrace log says why");
    });
  });
  // The SDK's rate limits stand, counted by the client's address. A request
  // with none — over a socket that is no TCP connection — shares one count
  // rather than logging an error on every request.
  const limits = { rateLimit: { validate: { ip: false } } };
  // Every route that reads the files waits on them. The board's routes pass
  // through this router too, and never do.
  router.use(["/authorize", "/token", "/register", "/revoke"], ready);
  router.use(mcpAuthRouter({
    provider, issuerUrl: issuer, resourceServerUrl: resource, resourceName: "Landrace",
    authorizationOptions: limits, tokenOptions: limits, clientRegistrationOptions: limits, revocationOptions: limits,
  }));

  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl });
  return {
    router,
    bearer: (req, res, next) => { ready(req, res, () => { void bearer(req, res, next); }); },
    personOf: (req) => {
      const person = (req.auth?.extra as { person?: Person } | undefined)?.person;
      return person ?? null;
    },
  };
}
