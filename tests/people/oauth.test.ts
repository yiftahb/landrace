import { createHash } from "node:crypto";
import { defineConnection } from "#hooks/contracts.js";
import { beginConnect, finishConnect, oauthOf, refreshIfNeeded } from "#people/oauth.js";
import { Refusal } from "#runner/errors.js";
import type { ConnectionDef, ConnectionValue, PendingConnects, RuntimeContext } from "#namespace.js";

const NOW = Date.parse("2026-11-05T12:00:00.000Z");
const REDIRECT = "http://127.0.0.1:4546/connect/forge/callback";
const SECRET = "oauth-client-secret-0123456789";

const ctxWith = (secrets: Record<string, string>): RuntimeContext =>
  ({ config: {}, secrets: new Map(Object.entries(secrets)), signal: new AbortController().signal, log: () => {} }) as unknown as RuntimeContext;
const CTX = ctxWith({ forgeOauthClientId: "client-123", forgeOauthClientSecret: SECRET });

const forge: ConnectionDef = defineConnection({
  id: "forge", label: "Forge", kind: "credential", fields: ["token"], paste: { hint: "a token" },
  oauth: (ctx) => ({
    authorizeUrl: "https://forge.example.invalid/oauth/authorize",
    tokenUrl: "https://forge.example.invalid/oauth/token",
    clientId: ctx.secrets.get("forgeOauthClientId") ?? "",
    clientSecret: ctx.secrets.get("forgeOauthClientSecret") ?? "",
    scope: "api read_user",
  }),
});

interface Posted { url: string; form: URLSearchParams; accept: string | null }

/** A token endpoint: each call answers the next of `answers`, and records what was posted. */
function tokenEndpoint(...answers: Array<{ status?: number; body: unknown } | Error>) {
  const posted: Posted[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    posted.push({ url: String(url), form: new URLSearchParams(String(init?.body ?? "")), accept: headers.get("accept") });
    const next = answers.shift();
    if (next === undefined) throw new Error("no more answers");
    if (next instanceof Error) throw next;
    const text = typeof next.body === "string" ? next.body : JSON.stringify(next.body);
    return new Response(text, { status: next.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, posted };
}

const begin = (pending: PendingConnects, person = "local"): URL =>
  new URL(beginConnect(forge, CTX, { person, redirectUri: REDIRECT, pending, now: () => NOW }));

describe("beginConnect", () => {
  it("sends the person to consent with PKCE S256, a state, the redirect URI and the scope", () => {
    const pending: PendingConnects = new Map();
    const url = begin(pending);
    expect(url.origin + url.pathname).toBe("https://forge.example.invalid/oauth/authorize");
    const q = url.searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe("client-123");
    expect(q.get("redirect_uri")).toBe(REDIRECT);
    expect(q.get("scope")).toBe("api read_user");
    expect(q.get("code_challenge_method")).toBe("S256");
    const state = q.get("state") ?? "";
    // 32 bytes, base64url: 43 characters, no padding.
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const held = pending.get(state);
    expect(held).toMatchObject({ person: "local", connection: "forge", redirectUri: REDIRECT, expires: NOW + 10 * 60_000 });
    expect(q.get("code_challenge")).toBe(createHash("sha256").update(held?.verifier ?? "").digest("base64url"));
    expect(url.toString()).not.toContain(SECRET);
  });

  it("is offered only when both the client id and secret are non-empty, and for a credential of one field", () => {
    expect(oauthOf(forge, CTX)).not.toBeNull();
    expect(oauthOf(forge, ctxWith({ forgeOauthClientId: "client-123" }))).toBeNull();
    expect(oauthOf(forge, ctxWith({ forgeOauthClientId: "client-123", forgeOauthClientSecret: "  " }))).toBeNull();
    expect(oauthOf({ ...forge, oauth: undefined } as unknown as ConnectionDef, CTX)).toBeNull();
    expect(oauthOf({ ...forge, fields: ["user", "token"] }, CTX)).toBeNull();
    expect(() => beginConnect(forge, ctxWith({}), { person: "local", redirectUri: REDIRECT, pending: new Map() })).toThrow(Refusal);
  });
});

describe("finishConnect", () => {
  it("exchanges the code with the verifier and stores the token, its expiry and its refresh token", async () => {
    const pending: PendingConnects = new Map();
    const state = begin(pending).searchParams.get("state") ?? "";
    const verifier = pending.get(state)?.verifier;
    const endpoint = tokenEndpoint({ body: { access_token: "glo-access-1", refresh_token: "glr-refresh-1", expires_in: 7200, token_type: "Bearer" } });
    const value = await finishConnect(forge, CTX, { person: "local", connection: "forge", callback: { state, code: "the-code" }, pending, now: () => NOW, fetch: endpoint.impl });
    expect(value).toEqual({
      fields: { token: "glo-access-1" }, source: "oauth", connectedAt: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW + 7200_000).toISOString(), refresh: { token: "glr-refresh-1" },
    });
    expect(endpoint.posted).toHaveLength(1);
    const [post] = endpoint.posted;
    expect(post?.url).toBe("https://forge.example.invalid/oauth/token");
    expect(post?.accept).toBe("application/json");
    expect(Object.fromEntries(post?.form ?? [])).toEqual({
      grant_type: "authorization_code", code: "the-code", redirect_uri: REDIRECT, code_verifier: verifier,
      client_id: "client-123", client_secret: SECRET,
    });
  });

  it("stores no expiry and no refresh token when the provider sends none", async () => {
    const pending: PendingConnects = new Map();
    const state = begin(pending).searchParams.get("state") ?? "";
    const endpoint = tokenEndpoint({ body: { access_token: "gho_access", token_type: "bearer", scope: "repo" } });
    const value = await finishConnect(forge, CTX, { person: "local", connection: "forge", callback: { state, code: "c" }, pending, now: () => NOW, fetch: endpoint.impl });
    expect(value).toEqual({ fields: { token: "gho_access" }, source: "oauth", connectedAt: new Date(NOW).toISOString() });
  });

  it.each([
    ["unknown", () => ({ state: "not-a-state-we-issued", person: "local", at: NOW })],
    ["expired", (s: string) => ({ state: s, person: "local", at: NOW + 10 * 60_000 + 1 })],
    ["another person's", (s: string) => ({ state: s, person: "someone-else", at: NOW })],
  ])("refuses an %s state and asks no token endpoint", async (_what, pick) => {
    const pending: PendingConnects = new Map();
    const issued = begin(pending).searchParams.get("state") ?? "";
    const { state, person, at } = pick(issued);
    const endpoint = tokenEndpoint({ body: { access_token: "never" } });
    await expect(finishConnect(forge, CTX, { person, connection: "forge", callback: { state, code: "c" }, pending, now: () => at, fetch: endpoint.impl }))
      .rejects.toThrow(Refusal);
    expect(endpoint.posted).toHaveLength(0);
  });

  it("refuses a state for another connection, and one used once already, since a lookup spends it", async () => {
    const pending: PendingConnects = new Map();
    const state = begin(pending).searchParams.get("state") ?? "";
    const endpoint = tokenEndpoint({ body: { access_token: "glo-access-1" } });
    await expect(finishConnect(forge, CTX, { person: "local", connection: "other", callback: { state, code: "c" }, pending, now: () => NOW, fetch: endpoint.impl }))
      .rejects.toThrow(/does not match/);
    // Spent by the refused lookup: the right connection cannot use it either.
    await expect(finishConnect(forge, CTX, { person: "local", connection: "forge", callback: { state, code: "c" }, pending, now: () => NOW, fetch: endpoint.impl }))
      .rejects.toThrow(Refusal);

    const again = begin(pending).searchParams.get("state") ?? "";
    await finishConnect(forge, CTX, { person: "local", connection: "forge", callback: { state: again, code: "c" }, pending, now: () => NOW, fetch: endpoint.impl });
    await expect(finishConnect(forge, CTX, { person: "local", connection: "forge", callback: { state: again, code: "c" }, pending, now: () => NOW, fetch: endpoint.impl }))
      .rejects.toThrow(Refusal);
    expect(endpoint.posted).toHaveLength(1);
  });

  it("refuses the provider's own error, spending the state, and names it", async () => {
    const pending: PendingConnects = new Map();
    const state = begin(pending).searchParams.get("state") ?? "";
    await expect(finishConnect(forge, CTX, { person: "local", connection: "forge", callback: { state, error: "access_denied", errorDescription: "The resource owner denied the request." }, pending, now: () => NOW }))
      .rejects.toThrow(/access_denied: The resource owner denied the request\./);
    expect(pending.size).toBe(0);
  });

  it("refuses an answer with no access_token by its error alone, never quoting the body", async () => {
    const pending: PendingConnects = new Map();
    const state = begin(pending).searchParams.get("state") ?? "";
    const endpoint = tokenEndpoint({ body: { error: "bad_verification_code", error_description: "The code passed is incorrect or expired.", echoed: "SENSITIVE-BODY-TEXT" } });
    const finished = finishConnect(forge, CTX, { person: "local", connection: "forge", callback: { state, code: "c" }, pending, now: () => NOW, fetch: endpoint.impl });
    await expect(finished).rejects.toThrow(Refusal);
    await expect(finished).rejects.toThrow(/bad_verification_code: The code passed is incorrect or expired\./);
    await expect(finished).rejects.not.toThrow(/SENSITIVE-BODY-TEXT/);
  });

  it("refuses a 4xx with no JSON by its status, and fails a 5xx as the provider's own trouble, not a refusal", async () => {
    for (const [status, refused] of [[401, true], [503, false]] as const) {
      const pending: PendingConnects = new Map();
      const state = begin(pending).searchParams.get("state") ?? "";
      const endpoint = tokenEndpoint({ status, body: "<html>SENSITIVE-BODY-TEXT</html>" });
      const error = await finishConnect(forge, CTX, { person: "local", connection: "forge", callback: { state, code: "c" }, pending, now: () => NOW, fetch: endpoint.impl })
        .then(() => null, (e: unknown) => e as Error);
      expect(error).toBeInstanceOf(Error);
      expect(error instanceof Refusal).toBe(refused);
      expect(error?.message).toContain(String(status));
      expect(error?.message).not.toContain("SENSITIVE-BODY-TEXT");
    }
  });
});

describe("refreshIfNeeded", () => {
  const stored = (minutesLeft: number | null): ConnectionValue => ({
    fields: { token: "glo-access-1" }, source: "oauth", connectedAt: "2026-11-01T00:00:00.000Z",
    ...(minutesLeft === null ? {} : { expiresAt: new Date(NOW + minutesLeft * 60_000).toISOString() }),
    refresh: { token: "glr-refresh-1" },
  });

  it("posts grant_type=refresh_token 9 minutes before the end, and keeps connectedAt", async () => {
    const endpoint = tokenEndpoint({ body: { access_token: "glo-access-2", refresh_token: "glr-refresh-2", expires_in: 7200 } });
    const next = await refreshIfNeeded(forge, CTX, stored(9), { now: () => NOW, fetch: endpoint.impl });
    expect(next).toEqual({
      fields: { token: "glo-access-2" }, source: "oauth", connectedAt: "2026-11-01T00:00:00.000Z",
      expiresAt: new Date(NOW + 7200_000).toISOString(), refresh: { token: "glr-refresh-2" },
    });
    expect(Object.fromEntries(endpoint.posted[0]?.form ?? [])).toEqual({
      grant_type: "refresh_token", refresh_token: "glr-refresh-1", client_id: "client-123", client_secret: SECRET,
    });
  });

  it("keeps the old refresh token when none comes back, and drops a failure the new token mends", async () => {
    const endpoint = tokenEndpoint({ body: { access_token: "glo-access-2", expires_in: 60 } });
    const next = await refreshIfNeeded(forge, CTX, { ...stored(-5), failure: "old", failedAt: "2026-11-05T00:00:00.000Z" }, { now: () => NOW, fetch: endpoint.impl });
    expect(next?.refresh).toEqual({ token: "glr-refresh-1" });
    expect(next).not.toHaveProperty("failure");
    expect(next).not.toHaveProperty("failedAt");
  });

  it("is null at 11 minutes left, with no expiry, with no refresh token, and with no app configured", async () => {
    const endpoint = tokenEndpoint();
    expect(await refreshIfNeeded(forge, CTX, stored(11), { now: () => NOW, fetch: endpoint.impl })).toBeNull();
    expect(await refreshIfNeeded(forge, CTX, stored(null), { now: () => NOW, fetch: endpoint.impl })).toBeNull();
    const noRefresh = { ...stored(5) };
    delete noRefresh.refresh;
    expect(await refreshIfNeeded(forge, CTX, noRefresh, { now: () => NOW, fetch: endpoint.impl })).toBeNull();
    expect(await refreshIfNeeded(forge, ctxWith({}), stored(5), { now: () => NOW, fetch: endpoint.impl })).toBeNull();
    expect(endpoint.posted).toHaveLength(0);
  });

  it("refuses a 400 or an error answer, and fails a network error or a 5xx without refusing", async () => {
    const outcomes: Array<[Parameters<typeof tokenEndpoint>[0], boolean]> = [
      [{ status: 400, body: { error: "invalid_grant", error_description: "The provided authorization grant is invalid" } }, true],
      [{ body: { error: "invalid_grant" } }, true],
      [{ status: 502, body: "bad gateway" }, false],
      [new TypeError("fetch failed"), false],
    ];
    for (const [answer, refused] of outcomes) {
      const endpoint = tokenEndpoint(answer);
      const error = await refreshIfNeeded(forge, CTX, stored(5), { now: () => NOW, fetch: endpoint.impl }).then(() => null, (e: unknown) => e as Error);
      expect(error).toBeInstanceOf(Error);
      expect(error instanceof Refusal).toBe(refused);
    }
  });
});
