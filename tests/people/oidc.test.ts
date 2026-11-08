import { createOidc } from "#people/oidc.js";
import { fakeOidc } from "#tests/support/fake-oidc.js";

/*
 * #187: a person signs in at the instance's provider. What is observed is
 * the URL sent to the provider, what the callback answers, and what the
 * token endpoint was asked — never how the library checked the token.
 */
const PUBLIC = "https://landrace.example.org/";
const REDIRECT = `${PUBLIC}login/callback`;

function setup(o: { now?: () => number } = {}) {
  const idp = fakeOidc();
  const oidc = createOidc({
    oidc: { issuer: idp.issuer, clientId: idp.clientId, clientSecret: "client-secret-value" }, redirectUri: REDIRECT, fetch: idp.fetch,
    ...(o.now ? { now: o.now } : {}),
  });
  /** The callback as the provider sends the browser back to it. */
  const callback = (url: string, code: string): URL => {
    const back = new URL(REDIRECT);
    back.searchParams.set("code", code);
    back.searchParams.set("state", new URL(url).searchParams.get("state") ?? "");
    return back;
  };
  return { idp, oidc, callback };
}

const ALICE = { sub: "sub-alice", email: "alice@example.invalid", email_verified: true, name: "Alice" };

describe("signing in with OpenID Connect", () => {
  it("sends the person to the provider with PKCE S256, a state and a nonce, and the instance's own callback", async () => {
    const { oidc, idp } = setup();
    const { url } = await oidc.begin("/");
    const asked = new URL(url);
    expect(`${asked.origin}${asked.pathname}`).toBe(`${idp.issuer}/auth`);
    expect(Object.fromEntries(asked.searchParams)).toEqual(expect.objectContaining({
      response_type: "code", client_id: "landrace", redirect_uri: REDIRECT, code_challenge_method: "S256", scope: "openid email profile",
      state: expect.any(String), nonce: expect.any(String), code_challenge: expect.any(String),
    }));
  });

  it("signs in a verified email: who they are, and where they asked to go", async () => {
    const { oidc, idp, callback } = setup();
    const { url, binding } = await oidc.begin("/#/integrations");
    const done = await oidc.finish(callback(url, idp.approve(url, ALICE)), binding);
    expect(done).toEqual({ person: { id: "sub-alice", email: "alice@example.invalid", name: "Alice" }, returnTo: "/#/integrations" });
    // The verifier went to the token endpoint, under the same redirect URI.
    expect(idp.tokenRequests[0]?.get("redirect_uri")).toBe(REDIRECT);
    expect(idp.tokenRequests[0]?.get("code_verifier")).toEqual(expect.any(String));
  });

  it.each([
    ["false", { ...ALICE, email_verified: false }],
    ["absent, and absent at userinfo too", { sub: "sub-alice", email: "alice@example.invalid" }],
  ])("refuses an email whose verification is %s, 403", async (_, claims) => {
    const { oidc, idp, callback } = setup();
    const { url, binding } = await oidc.begin("/");
    expect(await oidc.finish(callback(url, idp.approve(url, claims, { email: "alice@example.invalid" })), binding)).toEqual({ refused: expect.stringMatching(/not verified/), status: 403 });
  });

  /*
   * #220: a provider that issues a thin ID token — Okta's org server, for
   * one — serves email and email_verified only at userinfo. Asked only when
   * the ID token lacks one, about the ID token's own subject.
   */
  describe("an ID token without email or email_verified", () => {
    const THIN = { sub: "sub-alice", name: "Alice" };

    it("asks userinfo for email_verified, with the access token, and signs the person in", async () => {
      const { oidc, idp, callback } = setup();
      const { url, binding } = await oidc.begin("/");
      const code = idp.approve(url, { ...THIN, email: "alice@example.invalid" }, { email: "alice@example.invalid", email_verified: true });
      expect(await oidc.finish(callback(url, code), binding)).toEqual({ person: { id: "sub-alice", email: "alice@example.invalid", name: "Alice" }, returnTo: "/" });
      expect(idp.userinfoRequests).toEqual([expect.stringMatching(/^Bearer [0-9a-f]{32}$/)]);
    });

    it("takes both from userinfo when the ID token has neither", async () => {
      const { oidc, idp, callback } = setup();
      const { url, binding } = await oidc.begin("/");
      const code = idp.approve(url, THIN, { email: " bob.alice@example.invalid ", email_verified: true });
      expect(await oidc.finish(callback(url, code), binding)).toEqual({ person: { id: "sub-alice", email: "bob.alice@example.invalid", name: "Alice" }, returnTo: "/" });
    });

    it.each([
      ["false", { email: "alice@example.invalid", email_verified: false }],
      ["absent there too", { email: "alice@example.invalid" }],
      ["the string \"true\"", { email: "alice@example.invalid", email_verified: "true" }],
      // Userinfo vouches for its own email only: never for another the ID token named.
      ["true of another email", { email: "mallory@example.invalid", email_verified: true }],
    ])("refuses, 403, when userinfo's email_verified is %s", async (_, userinfo) => {
      const { oidc, idp, callback } = setup();
      const { url, binding } = await oidc.begin("/");
      const code = idp.approve(url, { ...THIN, email: "alice@example.invalid" }, userinfo);
      expect(await oidc.finish(callback(url, code), binding)).toEqual({
        refused: "your email, alice@example.invalid, is not verified at the provider; verify it there and sign in again", status: 403,
      });
    });

    it("refuses, 403, when neither names an email", async () => {
      const { oidc, idp, callback } = setup();
      const { url, binding } = await oidc.begin("/");
      expect(await oidc.finish(callback(url, idp.approve(url, THIN, { email_verified: true })), binding)).toEqual({
        refused: "the provider sent no email for you, and Landrace knows people by theirs", status: 403,
      });
    });

    it("keeps the ID token's own false: userinfo only fills what it lacks", async () => {
      const { oidc, idp, callback } = setup();
      const { url, binding } = await oidc.begin("/");
      const code = idp.approve(url, { ...THIN, email_verified: false }, { email: "alice@example.invalid", email_verified: true });
      expect(await oidc.finish(callback(url, code), binding)).toEqual({ refused: expect.stringMatching(/alice@example\.invalid, is not verified/), status: 403 });
    });

    it("refuses, 502, a userinfo answer about another subject", async () => {
      const { oidc, idp, callback } = setup();
      const { url, binding } = await oidc.begin("/");
      // The same answer under the ID token's own sub signs Alice in, above: the subject alone is refused.
      const code = idp.approve(url, { ...THIN, email: "alice@example.invalid" }, { sub: "sub-mallory", email: "alice@example.invalid", email_verified: true });
      expect(await oidc.finish(callback(url, code), binding)).toEqual({ refused: expect.stringMatching(/^the provider's answer could not be accepted: ./), status: 502 });
      expect(idp.userinfoRequests).toHaveLength(1);
    });

    it.each([401, 500])("refuses, 502, when userinfo answers %i", async (status) => {
      const { oidc, idp, callback } = setup();
      const { url, binding } = await oidc.begin("/");
      const code = idp.approve(url, { ...THIN, email: "alice@example.invalid" }, status);
      expect(await oidc.finish(callback(url, code), binding)).toEqual({ refused: expect.stringMatching(/^the provider's answer could not be accepted: ./), status: 502 });
      expect(idp.userinfoRequests).toHaveLength(1);
    });

    it("never asks userinfo when the ID token has both", async () => {
      const { oidc, idp, callback } = setup();
      const { url, binding } = await oidc.begin("/");
      const code = idp.approve(url, ALICE, { email: "other@example.invalid", email_verified: false });
      expect(await oidc.finish(callback(url, code), binding)).toHaveProperty("person.email", "alice@example.invalid");
      expect(idp.userinfoRequests).toHaveLength(0);
    });
  });

  it("refuses a callback in a browser that did not begin it — login CSRF — and asks nothing of the provider", async () => {
    const { oidc, idp, callback } = setup();
    const { url } = await oidc.begin("/");
    const back = callback(url, idp.approve(url, ALICE));
    expect(await oidc.finish(back, undefined)).toEqual({ refused: expect.stringMatching(/another browser/), status: 400 });
    expect(idp.tokenRequests).toHaveLength(0);
  });

  it("spends a state once, and refuses it past ten minutes", async () => {
    let now = 0;
    const { oidc, idp, callback } = setup({ now: () => now });
    const first = await oidc.begin("/");
    const back = callback(first.url, idp.approve(first.url, ALICE));
    expect(await oidc.finish(back, first.binding)).toHaveProperty("person");
    expect(await oidc.finish(back, first.binding)).toEqual({ refused: expect.stringMatching(/not begun here, or was already used/), status: 400 });
    const late = await oidc.begin("/");
    now += 10 * 60_000 + 1;
    expect(await oidc.finish(callback(late.url, idp.approve(late.url, ALICE)), late.binding)).toEqual({ refused: expect.stringMatching(/ten minutes/), status: 400 });
  });

  it("says the provider's own refusal, and that alone", async () => {
    const { oidc } = setup();
    const { url, binding } = await oidc.begin("/");
    const back = new URL(REDIRECT);
    back.searchParams.set("state", new URL(url).searchParams.get("state") ?? "");
    back.searchParams.set("error", "access_denied");
    expect(await oidc.finish(back, binding)).toEqual({ refused: "the provider did not sign you in: access_denied", status: 403 });
  });

  it.each([
    ["//evil.example", "/"], ["/\\evil.example", "/"], ["https://evil.example/", "/"], ["", "/"], ["board", "/"], ["/#/items/1", "/#/items/1"],
    // Dot segments a URL parser folds into `//host`: checked after parsing, not only before.
    ["/.//evil.example", "/"], ["/a/..//evil.example/x?y", "/"], ["/./\\evil.example", "/"],
  ])("returns %j as %j: a same-origin path, never an open redirect", async (asked, landed) => {
    const { oidc, idp, callback } = setup();
    const { url, binding } = await oidc.begin(asked);
    expect(await oidc.finish(callback(url, idp.approve(url, ALICE)), binding)).toEqual(expect.objectContaining({ returnTo: landed }));
  });
});
