import { randomBytes } from "node:crypto";
import * as client from "openid-client";
import { isLoopback } from "#kit/http.js";
import { messageOf } from "#runner/errors.js";
import { oneLine } from "#runner/status.js";
import type { Oidc, OidcConfig, OidcFinished, PendingSignIn } from "#namespace.js";

/** How long a begun sign-in is taken back: long enough to sign in at the provider, short enough that a stolen state is soon worthless. */
const STATE_TTL_MS = 10 * 60_000;

/** Past this many sign-ins begun in ten minutes, the oldest is dropped: a flood of /login cannot grow the map without end. */
const MAX_PENDING = 10_000;

/**
 * Where a person goes once signed in: a path on this instance, or `/`. A
 * `//host` or `/\host` path is another site to a browser, so it is never
 * one — anything that would let a link sign someone in and send them away.
 */
export function returnPath(asked: string | null | undefined): string {
  const offSite = (path: string): boolean => !path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\");
  if (asked === null || asked === undefined || offSite(asked)) return "/";
  // Parsed against a stand-in origin: whatever survives must stay on it. And
  // checked again once parsed, since folding dot segments can turn
  // `/.//evil.example` into `//evil.example`, another site to a browser.
  const url = new URL(asked, "https://landrace.invalid");
  const path = `${url.pathname}${url.search}${url.hash}`;
  return url.origin === "https://landrace.invalid" && !offSite(path) ? path : "/";
}

/**
 * The instance's OpenID Connect client: `begin` sends a person to the
 * provider with PKCE S256, a state and a nonce, each held until the
 * provider sends them back, and bound to `binding` — the `landrace_login`
 * cookie the browser that began it carries. `finish` spends the state,
 * whatever comes of it, and refuses a callback in another browser before
 * asking the provider anything: a link that carried someone else's code
 * would otherwise sign the clicker in as them. Then the code is exchanged,
 * the ID token checked by the library, and an email the provider does not
 * say is verified refused — who a person is on every system is looked up
 * by it. An ID token without `email` or `email_verified` has userinfo asked
 * for what it lacks.
 *
 * Discovery is asked once, on the first sign-in; one that fails is asked
 * again on the next.
 */
export function createOidc(opts: { oidc: OidcConfig; redirectUri: string; fetch?: typeof fetch; now?: () => number }): Oidc {
  const now = opts.now ?? Date.now;
  const pending = new Map<string, PendingSignIn>();
  let discovered: Promise<client.Configuration> | null = null;

  const configuration = (): Promise<client.Configuration> => {
    if (discovered) return discovered;
    const issuer = new URL(opts.oidc.issuer);
    const found = client.discovery(issuer, opts.oidc.clientId, undefined, client.ClientSecretPost(opts.oidc.clientSecret), {
      ...(opts.fetch ? { [client.customFetch]: opts.fetch as client.CustomFetch } : {}),
      // The schema takes http only on loopback: a provider on this machine, for a trial.
      ...(issuer.protocol === "http:" && isLoopback(issuer.hostname) ? { execute: [client.allowInsecureRequests] } : {}),
    });
    discovered = found;
    found.catch(() => { discovered = null; });
    return found;
  };

  return {
    begin: async (asked) => {
      const config = await configuration();
      const at = now();
      for (const [state, held] of pending) if (held.expires < at) pending.delete(state);
      while (pending.size >= MAX_PENDING) {
        const oldest = pending.keys().next().value;
        if (oldest === undefined) break;
        pending.delete(oldest);
      }
      const state = client.randomState();
      const nonce = client.randomNonce();
      const verifier = client.randomPKCECodeVerifier();
      const binding = randomBytes(32).toString("base64url");
      pending.set(state, { binding, verifier, nonce, returnTo: returnPath(asked), expires: at + STATE_TTL_MS });
      const url = client.buildAuthorizationUrl(config, {
        redirect_uri: opts.redirectUri, scope: "openid email profile", state, nonce,
        code_challenge: await client.calculatePKCECodeChallenge(verifier), code_challenge_method: "S256",
      });
      return { url: url.href, binding };
    },

    finish: async (callback, binding): Promise<OidcFinished> => {
      const state = callback.searchParams.get("state") ?? "";
      const held = pending.get(state);
      pending.delete(state);
      if (held === undefined) return { refused: "that sign-in was not begun here, or was already used; sign in again", status: 400 };
      if (now() > held.expires) return { refused: "that sign-in took longer than ten minutes; sign in again", status: 400 };
      if (binding !== held.binding) return { refused: "that sign-in was begun in another browser; sign in again from this one", status: 400 };
      const error = callback.searchParams.get("error");
      if (error !== null) return { refused: `the provider did not sign you in: ${oneLine(error).slice(0, 200)}`, status: 403 };
      let claims: client.IDToken | undefined;
      let userinfo: client.UserInfoResponse | undefined;
      try {
        // Rebuilt on the instance's own callback URL: behind a proxy, the
        // request's URL is the proxy's view of it, not what the provider was told.
        const current = new URL(opts.redirectUri);
        current.search = callback.search;
        const config = await configuration();
        const tokens = await client.authorizationCodeGrant(config, current, {
          pkceCodeVerifier: held.verifier, expectedState: state, expectedNonce: held.nonce, idTokenExpected: true,
        });
        claims = tokens.claims();
        // #220: a thin ID token — Okta's org server issues one for this flow,
        // with no setting to change it — leaves email and email_verified to
        // userinfo. The expected subject refuses an answer about anyone else.
        if (claims !== undefined && (claims["email"] === undefined || claims["email_verified"] === undefined)) {
          userinfo = await client.fetchUserInfo(config, tokens.access_token, claims.sub);
        }
      } catch (e) {
        return { refused: `the provider's answer could not be accepted: ${oneLine(messageOf(e)).slice(0, 300)}`, status: 502 };
      }
      if (claims === undefined) return { refused: "the provider sent no email for you, and Landrace knows people by theirs", status: 403 };
      const trimmed = (v: unknown): string => typeof v === "string" ? v.trim() : "";
      // The ID token's values win; userinfo fills only what it lacks.
      const email = trimmed(claims["email"] ?? userinfo?.email);
      if (email === "") return { refused: "the provider sent no email for you, and Landrace knows people by theirs", status: 403 };
      // Userinfo's email_verified is about userinfo's email: it vouches for
      // no other address the ID token named.
      const verified = claims["email_verified"] ?? (trimmed(userinfo?.email).toLowerCase() === email.toLowerCase() ? userinfo?.email_verified : undefined);
      if (verified !== true) {
        return { refused: `your email, ${email}, is not verified at the provider; verify it there and sign in again`, status: 403 };
      }
      const name = typeof claims["name"] === "string" && claims["name"].trim() !== "" ? claims["name"].trim() : undefined;
      return { person: { id: claims.sub, email, ...(name === undefined ? {} : { name }) }, returnTo: held.returnTo };
    },
  };
}
