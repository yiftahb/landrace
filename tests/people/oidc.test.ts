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
    ["absent", { sub: "sub-alice", email: "alice@example.invalid" }],
  ])("refuses an email whose verification is %s, 403", async (_, claims) => {
    const { oidc, idp, callback } = setup();
    const { url, binding } = await oidc.begin("/");
    expect(await oidc.finish(callback(url, idp.approve(url, claims)), binding)).toEqual({ refused: expect.stringMatching(/not verified/), status: 403 });
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
  ])("returns %j as %j: a same-origin path, never an open redirect", async (asked, landed) => {
    const { oidc, idp, callback } = setup();
    const { url, binding } = await oidc.begin(asked);
    expect(await oidc.finish(callback(url, idp.approve(url, ALICE)), binding)).toEqual(expect.objectContaining({ returnTo: landed }));
  });
});
