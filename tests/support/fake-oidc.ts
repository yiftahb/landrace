import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";

/**
 * An OpenID Connect provider as a `fetch`: discovery, its keys, and a token
 * endpoint that checks the PKCE verifier and answers an RS256 ID token
 * signed by a key it made. No socket, so a sandbox that cannot bind still
 * drives a whole sign-in. Its authorize page is `approve`: what a person
 * signing in there would have the provider do — hand back a code for the
 * request `begin` built, about the claims given, and what its userinfo
 * endpoint answers for the access token that code buys: claims (with the
 * ID token's `sub` unless they name another), or a bare error status.
 */
/** A userinfo answer: its claims, or the HTTP status of a refusal. */
type UserInfo = Record<string, unknown> | number;

export function fakeOidc(o: { issuer?: string; clientId?: string } = {}) {
  const issuer = o.issuer ?? "https://id.example.invalid/realms/team";
  const clientId = o.clientId ?? "landrace";
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  const codes = new Map<string, { challenge: string; nonce: string | null; redirectUri: string; claims: Record<string, unknown>; userinfo: UserInfo }>();
  const tokenRequests: URLSearchParams[] = [];
  /** What each access token's userinfo answers. */
  const userinfoFor = new Map<string, { sub: unknown; userinfo: UserInfo }>();
  /** The `Authorization` header of each userinfo request. */
  const userinfoRequests: string[] = [];

  const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64url");
  const sign = (claims: Record<string, unknown>): string => {
    const head = `${b64({ alg: "RS256", kid: "k1", typ: "JWT" })}.${b64(claims)}`;
    return `${head}.${createSign("RSA-SHA256").update(head).sign(privateKey).toString("base64url")}`;
  };
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href === `${issuer}/.well-known/openid-configuration`) {
      return json({
        issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/certs`, userinfo_endpoint: `${issuer}/userinfo`,
        response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      });
    }
    if (url.href === `${issuer}/certs`) return json({ keys: [jwk] });
    if (url.href === `${issuer}/token`) {
      const body = new URLSearchParams(typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "");
      tokenRequests.push(body);
      const held = codes.get(body.get("code") ?? "");
      codes.delete(body.get("code") ?? "");
      const verifier = body.get("code_verifier") ?? "";
      if (!held || createHash("sha256").update(verifier).digest("base64url") !== held.challenge || body.get("redirect_uri") !== held.redirectUri) {
        return json({ error: "invalid_grant" }, 400);
      }
      const now = Math.floor(Date.now() / 1000);
      const accessToken = randomBytes(16).toString("hex");
      userinfoFor.set(accessToken, { sub: held.claims["sub"], userinfo: held.userinfo });
      return json({
        access_token: accessToken, token_type: "Bearer", expires_in: 300,
        id_token: sign({ iss: issuer, aud: clientId, iat: now, exp: now + 300, ...(held.nonce ? { nonce: held.nonce } : {}), ...held.claims }),
      });
    }
    if (url.href === `${issuer}/userinfo`) {
      const authorization = new Headers(input instanceof Request ? input.headers : init?.headers).get("authorization") ?? "";
      userinfoRequests.push(authorization);
      const held = userinfoFor.get(authorization.replace(/^Bearer /, ""));
      if (!held) return json({ error: "invalid_token" }, 401);
      if (typeof held.userinfo === "number") return json({ error: "server_error" }, held.userinfo);
      return json({ sub: held.sub, ...held.userinfo });
    }
    return json({ error: "not_found" }, 404);
  };

  /** The code the provider sends back for the request at `authorizeUrl`, the person signed in as `claims`. */
  const approve = (authorizeUrl: string, claims: Record<string, unknown>, userinfo: UserInfo = {}): string => {
    const asked = new URL(authorizeUrl);
    const code = randomBytes(12).toString("hex");
    codes.set(code, {
      challenge: asked.searchParams.get("code_challenge") ?? "", nonce: asked.searchParams.get("nonce"),
      redirectUri: asked.searchParams.get("redirect_uri") ?? "", claims, userinfo,
    });
    return code;
  };

  return { issuer, clientId, fetch, approve, tokenRequests, userinfoRequests };
}
