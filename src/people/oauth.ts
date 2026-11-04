import { createHash, randomBytes } from "node:crypto";
import { messageOf, Refusal } from "#runner/errors.js";
import { oneLine } from "#runner/status.js";
import type { ConnectCallback, ConnectionDef, ConnectionValue, OAuthSpec, OAuthTokenAnswer as TokenAnswer, PendingConnects, RuntimeContext } from "#namespace.js";

/** How long a begun flow is accepted back: long enough to sign in and consent, short enough that a stolen state is soon worthless. */
const STATE_TTL_MS = 10 * 60_000;

/** How close to its end a token is renewed: past one pass of the 60 s refresher, with room for one that failed. */
const REFRESH_WITHIN_MS = 10 * 60_000;

/** Every pending flow lives as long as `start`: a restart forgets them, and a person begins again. */
export const createPendingConnects = (): PendingConnects => new Map();

/**
 * The connection's OAuth app, or null when it offers none: no `oauth`, a
 * client id or secret left empty — the instance has no app for it — or a
 * connection of more than one field, which one access token cannot fill.
 */
export function oauthOf(def: ConnectionDef, ctx: RuntimeContext): OAuthSpec | null {
  if (def.kind !== "credential" || def.fields.length !== 1 || def.oauth === undefined) return null;
  const spec = def.oauth(ctx);
  return spec.clientId.trim() === "" || spec.clientSecret.trim() === "" ? null : spec;
}

const specOf = (def: ConnectionDef, ctx: RuntimeContext): OAuthSpec => {
  const spec = oauthOf(def, ctx);
  if (spec === null) throw new Refusal(`"${def.id}" cannot be connected with OAuth here: this instance has no ${def.label} OAuth app configured`);
  return spec;
};

/**
 * Where to send the person to consent: the provider's authorize URL with a
 * PKCE S256 challenge and a fresh state, which is held until the provider
 * sends them back — bound to who asked, for which connection, the verifier
 * and the redirect URI the code will be exchanged under.
 */
export function beginConnect(
  def: ConnectionDef, ctx: RuntimeContext,
  opts: { person: string; redirectUri: string; pending: PendingConnects; now?: () => number },
): string {
  const spec = specOf(def, ctx);
  const now = (opts.now ?? Date.now)();
  // Expired flows are dropped as new ones begin, so the map never outgrows the flows of the last ten minutes.
  for (const [state, held] of opts.pending) if (held.expires < now) opts.pending.delete(state);
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  opts.pending.set(state, { person: opts.person, connection: def.id, verifier, redirectUri: opts.redirectUri, expires: now + STATE_TTL_MS });
  const url = new URL(spec.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", spec.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("scope", spec.scope);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/**
 * The provider sent the person back: their state is looked up — and spent,
 * whatever comes of it — then the code is exchanged for a token. A state
 * this process never issued, one past its ten minutes, another person's or
 * another connection's, and the provider's own refusal are each a `Refusal`,
 * and nothing is asked of the token endpoint. What it answers is
 * `connectionValue`'s.
 */
export async function finishConnect(
  def: ConnectionDef, ctx: RuntimeContext,
  opts: { person: string; connection: string; callback: ConnectCallback; pending: PendingConnects; now?: () => number; fetch?: typeof fetch },
): Promise<ConnectionValue> {
  const now = (opts.now ?? Date.now)();
  const { state, code, error } = opts.callback;
  const held = state === undefined ? undefined : opts.pending.get(state);
  if (state !== undefined) opts.pending.delete(state);
  if (held === undefined) throw new Refusal(`that ${def.label} sign-in was not begun here, or was already used; connect ${def.id} again`);
  if (now > held.expires) throw new Refusal(`that ${def.label} sign-in took longer than ten minutes; connect ${def.id} again`);
  if (held.person !== opts.person || held.connection !== opts.connection) {
    throw new Refusal(`that ${def.label} sign-in does not match who began it, or for what; connect ${def.id} again`);
  }
  if (error !== undefined) throw new Refusal(`${def.label} did not connect: ${said(error, opts.callback.errorDescription)}`);
  if (code === undefined || code === "") throw new Refusal(`${def.label} sent no code back; connect ${def.id} again`);
  const spec = specOf(def, ctx);
  const answer = await tokenRequest(def, spec, {
    grant_type: "authorization_code", code, redirect_uri: held.redirectUri, code_verifier: held.verifier,
  }, ctx.signal, opts.fetch);
  return valueOf(def, answer, { connectedAt: new Date(now).toISOString(), now });
}

/**
 * A renewed value for a stored OAuth one within ten minutes of its end —
 * or past it — or null: no end, no refresh token, or no app to renew it
 * with. The new value keeps `connectedAt`, and the old refresh token when
 * the provider sends none. A 4xx or an `error` answer is a `Refusal`, the
 * refresh token no longer good; a network error or a 5xx is a plain error,
 * worth asking again.
 */
export async function refreshIfNeeded(
  def: ConnectionDef, ctx: RuntimeContext, value: ConnectionValue,
  opts: { now?: () => number; fetch?: typeof fetch } = {},
): Promise<ConnectionValue | null> {
  const now = (opts.now ?? Date.now)();
  if (value.expiresAt === undefined || value.refresh === undefined) return null;
  if (Date.parse(value.expiresAt) - now > REFRESH_WITHIN_MS) return null;
  const spec = oauthOf(def, ctx);
  if (spec === null) return null;
  const answer = await tokenRequest(def, spec, { grant_type: "refresh_token", refresh_token: value.refresh.token }, ctx.signal, opts.fetch);
  return valueOf(def, answer, { connectedAt: value.connectedAt, now, refresh: value.refresh.token });
}

/** A provider's error said in its own two fields, on one line and capped: never anything else it sent. */
function said(error: string, description: unknown): string {
  const text = typeof description === "string" && description.trim() !== "" ? `${error}: ${description}` : error;
  return oneLine(text).slice(0, 300);
}

/**
 * One form POST to the token endpoint, the app's id and secret in the body
 * — where OAuth 2.0 lets a confidential client send them — answered as
 * JSON. The body is never quoted: a provider's error page can echo what it
 * was sent.
 */
async function tokenRequest(
  def: ConnectionDef, spec: OAuthSpec, form: Record<string, string>, signal: AbortSignal, impl: typeof fetch = fetch,
): Promise<TokenAnswer> {
  let res: Response;
  try {
    res = await impl(spec.tokenUrl, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": "landrace" },
      body: new URLSearchParams({ ...form, client_id: spec.clientId, client_secret: spec.clientSecret }).toString(),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
  } catch (e) {
    throw new Error(`could not reach ${def.label}'s token endpoint: ${messageOf(e)}`);
  }
  if (res.status >= 500) throw new Error(`${def.label}'s token endpoint answered ${res.status}`);
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Not JSON: judged by its status alone, below.
  }
  const answer = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (typeof answer["access_token"] === "string" && answer["access_token"] !== "" && res.ok) return answer as unknown as TokenAnswer;
  const error = typeof answer["error"] === "string" && answer["error"] !== "" ? answer["error"] : null;
  throw new Refusal(`${def.label} refused the token request${error === null ? ` (${res.status})` : `: ${said(error, answer["error_description"])}`}`);
}

function valueOf(def: ConnectionDef, answer: TokenAnswer, opts: { connectedAt: string; now: number; refresh?: string }): ConnectionValue {
  const field = def.fields[0] ?? "token";
  const seconds = typeof answer.expires_in === "number" && Number.isFinite(answer.expires_in) && answer.expires_in > 0 ? answer.expires_in : undefined;
  const refresh = typeof answer.refresh_token === "string" && answer.refresh_token !== "" ? answer.refresh_token : opts.refresh;
  return {
    fields: { [field]: answer.access_token },
    source: "oauth",
    connectedAt: opts.connectedAt,
    ...(seconds === undefined ? {} : { expiresAt: new Date(opts.now + seconds * 1000).toISOString() }),
    ...(refresh === undefined ? {} : { refresh: { token: refresh } }),
  };
}
