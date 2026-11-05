import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { BoardView, FrontDoorOptions, LandraceEvent, Person, Tools } from "#namespace.js";
import { createMcpEndpoint } from "#front/mcp.js";
import { MCP_TOKENS_FILE } from "#front/mcp-auth.js";
import { frontDoorListener } from "#front/server.js";
import { createTools } from "#mcp/tools.js";
import { createOidc } from "#people/oidc.js";
import { createSessions } from "#people/session.js";
import { Refusal } from "#runner/errors.js";
import { ANY, hooked, loaded } from "#tests/support/loaded.js";
import { createFakeTracker } from "#tests/support/fake-tracker.js";
import { fakeOidc } from "#tests/support/fake-oidc.js";
import { memoryFetch } from "#tests/support/memory-http.js";

/*
 * #187: a remote door. People sign in at a provider — `fakeOidc`, here —
 * and MCP clients get a token from Landrace's own authorization server,
 * consented to by a signed-in person. Alice's board holds #1, bob's #2.
 */
const PUBLIC = "https://landrace.example.org";
const CLIENT_REDIRECT = "http://127.0.0.1:33418/callback";
const ALICE = { sub: "sub-alice", email: "alice@example.invalid", email_verified: true };
const BOB = { sub: "sub-bob", email: "bob@example.invalid", email_verified: true };
const ITEMS: Record<string, number> = { "sub-alice": 1, "sub-bob": 2 };
const view = (id: string): BoardView => ({
  generatedAt: 1, rows: [], nextTickAt: null, folder: id, workspace: "/repo", workflows: [], needsYou: 0, listed: true,
});

async function door() {
  const idp = fakeOidc();
  const sessions = createSessions({ secure: true });
  const events: LandraceEvent[] = [];
  const log = Object.assign((name: LandraceEvent["name"], data?: Record<string, unknown>) => { events.push({ name, ...data }); }, {});
  const signedIn: Person[] = [];
  const trackers = { alice: createFakeTracker([{ number: 1 }]), bob: createFakeTracker([{ number: 2 }]) };
  const mcp = createMcpEndpoint({
    workflows: ["main"],
    toolsFor: (caller): Tools => {
      const tracker = caller.id === "sub-bob" ? trackers.bob : trackers.alice;
      return createTools([hooked(tracker.registry, loaded(ANY, new Map(), "main"))], tracker.ctx);
    },
  });
  const authRoot = join(await mkdtemp(join(tmpdir(), "lr-remote-")), "credentials", "mcp");
  const opts: FrontDoorOptions = {
    host: "0.0.0.0", port: 4545, publicUrl: `${PUBLIC}/`, mcp,
    callerOf: (req) => sessions.personOf(req),
    board: { view: async () => view("nobody's") },
    boardFor: (caller) => ({ view: async () => view(caller.id), has: (item) => item === String(ITEMS[caller.id]) }),
    remote: {
      oidc: createOidc({ oidc: { issuer: idp.issuer, clientId: idp.clientId, clientSecret: "client-secret-value" }, redirectUri: `${PUBLIC}/login/callback`, fetch: idp.fetch }),
      sessions, authRoot, log,
      signIn: async (person) => {
        if (person.id === "local") throw new Refusal('nobody signs in as "local"');
        signedIn.push(person);
      },
    },
  };
  const fetch = memoryFetch(frontDoorListener(opts, 4545));
  return { fetch, idp, events, signedIn, authRoot };
}
type Door = Awaited<ReturnType<typeof door>>;

const cookieIn = (res: Response, name: string): string | undefined =>
  new RegExp(`(?:^|, )${name}=([^;]*)`).exec(res.headers.get("set-cookie") ?? "")?.[1];

/** The whole browser sign-in: /login, the provider, the callback. The callback's response. */
async function signIn(d: Door, claims: Record<string, unknown>, returnTo = "/"): Promise<Response> {
  const login = await d.fetch(`${PUBLIC}/login?return=${encodeURIComponent(returnTo)}`);
  expect(login.status).toBe(302);
  const to = login.headers.get("location") ?? "";
  const code = d.idp.approve(to, claims);
  const state = new URL(to).searchParams.get("state") ?? "";
  return d.fetch(`${PUBLIC}/login/callback?code=${code}&state=${encodeURIComponent(state)}`, {
    headers: { cookie: `landrace_login=${cookieIn(login, "landrace_login") ?? ""}` },
  });
}
const sessionOf = async (d: Door, claims: Record<string, unknown>): Promise<string> =>
  `landrace_session=${cookieIn(await signIn(d, claims), "landrace_session") ?? ""}`;

const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");

async function register(d: Door): Promise<string> {
  const res = await d.fetch(`${PUBLIC}/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [CLIENT_REDIRECT], client_name: "Test <Editor>", token_endpoint_auth_method: "none" }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

const authorizeUrl = (clientId: string): string =>
  `${PUBLIC}/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(CLIENT_REDIRECT)}` +
  `&code_challenge=${challenge}&code_challenge_method=S256&state=st-1`;

/** The consent page, and the one-time token its form carries. */
async function consentPage(d: Door, clientId: string, cookie: string): Promise<{ res: Response; token: string }> {
  const res = await d.fetch(authorizeUrl(clientId), { headers: { cookie } });
  const html = await res.clone().text();
  return { res, token: /name="token" value="([^"]+)"/.exec(html)?.[1] ?? "" };
}

/**
 * The Origin a browser sends on a form POST from a page served under
 * `policy` to its own origin — the Fetch standard's "serializing a request
 * origin": `no-referrer` sends `null`, as does a cross-origin request under
 * `same-origin`; every other policy sends the page's origin. Set by hand,
 * the tests would pass against a page no real browser could submit.
 */
function browserOrigin(policy: string | null, pageOrigin: string): string {
  return policy === "no-referrer" ? "null" : pageOrigin;
}

const approve = (d: Door, cookie: string, body: string, origin = PUBLIC): Promise<Response> =>
  d.fetch(`${PUBLIC}/authorize/consent`, {
    method: "POST", headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" }, body,
  });

/** Signed in as `claims`, through consent, to an access token. */
async function tokenFor(d: Door, claims: Record<string, unknown>): Promise<{ access_token: string; refresh_token: string }> {
  const cookie = await sessionOf(d, claims);
  const clientId = await register(d);
  const { token } = await consentPage(d, clientId, cookie);
  const back = new URL((await approve(d, cookie, `token=${token}&decision=approve`)).headers.get("location") ?? "");
  const res = await d.fetch(`${PUBLIC}/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code: back.searchParams.get("code") ?? "", code_verifier: verifier, client_id: clientId, redirect_uri: CLIENT_REDIRECT,
    }).toString(),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { access_token: string; refresh_token: string };
}

describe("a remote door, before anyone signs in", () => {
  it("sends a browser asking for / to sign in and back, and answers a script 401, logging each as anonymous", async () => {
    const d = await door();
    const page = await d.fetch(`${PUBLIC}/`);
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe("/login?return=%2F");
    expect((await d.fetch(`${PUBLIC}/board.json`)).status).toBe(401);
    expect(d.events.filter((e) => e.name === "request.refused")).toEqual([
      expect.objectContaining({ person: "anonymous", path: "/", status: 302 }),
      expect.objectContaining({ person: "anonymous", path: "/board.json", status: 401 }),
    ]);
  });

  it("answers /mcp with no bearer 401, naming where its resource metadata is", async () => {
    const d = await door();
    const res = await d.fetch(`${PUBLIC}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp"`);
    const meta = (await (await d.fetch(`${PUBLIC}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
    expect(meta).toEqual(expect.objectContaining({ resource: `${PUBLIC}/mcp`, authorization_servers: [`${PUBLIC}/`] }));
  });

  it("sends /authorize to sign in first, and back to the same request", async () => {
    const d = await door();
    const clientId = await register(d);
    const res = await d.fetch(authorizeUrl(clientId));
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location") ?? "", PUBLIC);
    expect(to.pathname).toBe("/login");
    expect(to.searchParams.get("return")).toBe(new URL(authorizeUrl(clientId)).pathname + new URL(authorizeUrl(clientId)).search);
  });
});

describe("signing in at the door", () => {
  it("sets an HttpOnly, SameSite=Lax, Secure session cookie, signs the person in, and logs signin.ok", async () => {
    const d = await door();
    const res = await signIn(d, ALICE, "/#/integrations");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/#/integrations");
    const set = res.headers.get("set-cookie") ?? "";
    const session = /landrace_session=[^,]*/.exec(set)?.[0] ?? "";
    expect(session.split("; ")).toEqual(expect.arrayContaining(["HttpOnly", "SameSite=Lax", "Secure"]));
    expect(d.signedIn).toEqual([{ id: "sub-alice", email: "alice@example.invalid" }]);
    expect(d.events).toEqual(expect.arrayContaining([expect.objectContaining({ name: "signin.ok", person: "sub-alice", personEmail: "alice@example.invalid" })]));
    // And then the board is theirs.
    const board = await d.fetch(`${PUBLIC}/board.json`, { headers: { cookie: `landrace_session=${cookieIn(res, "landrace_session") ?? ""}` } });
    expect(((await board.json()) as BoardView).folder).toBe("sub-alice");
  });

  it("refuses an unverified email 403, with no session cookie, and logs signin.refused", async () => {
    const d = await door();
    const res = await signIn(d, { ...ALICE, email_verified: false });
    expect(res.status).toBe(403);
    expect(cookieIn(res, "landrace_session")).toBeUndefined();
    expect(d.signedIn).toEqual([]);
    expect(d.events).toEqual(expect.arrayContaining([expect.objectContaining({ name: "signin.refused", reason: expect.stringMatching(/not verified/) })]));
  });

  it("sends return=//evil.example to / once signed in", async () => {
    const d = await door();
    expect((await signIn(d, ALICE, "//evil.example")).headers.get("location")).toBe("/");
  });

  it("turns away a sign-in the roster refuses, with no session", async () => {
    const d = await door();
    const res = await signIn(d, { ...ALICE, sub: "local" });
    expect(res.status).toBe(403);
    expect(cookieIn(res, "landrace_session")).toBeUndefined();
  });
});

describe("consenting to an MCP client", () => {
  it("serves the consent page unframeable, the client's own name escaped", async () => {
    const d = await door();
    const cookie = await sessionOf(d, ALICE);
    const { res, token } = await consentPage(d, await register(d), cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    const html = await res.text();
    expect(html).toContain("Test &lt;Editor&gt;");
    expect(html).not.toContain("<Editor>");
    expect(token).not.toBe("");
  });

  it("issues a code for an approve from the page itself, back to the client with its state", async () => {
    const d = await door();
    const cookie = await sessionOf(d, ALICE);
    const { token } = await consentPage(d, await register(d), cookie);
    const res = await approve(d, cookie, `token=${token}&decision=approve`);
    expect(res.status).toBe(302);
    const back = new URL(res.headers.get("location") ?? "");
    expect(`${back.origin}${back.pathname}`).toBe(CLIENT_REDIRECT);
    expect(back.searchParams.get("state")).toBe("st-1");
    expect(back.searchParams.get("code")).toEqual(expect.any(String));
  });

  it("issues a code and a deny for the Origin a browser sends from the page under its own Referrer-Policy", async () => {
    const d = await door();
    const cookie = await sessionOf(d, ALICE);
    const clientId = await register(d);
    const shown = await consentPage(d, clientId, cookie);
    const origin = browserOrigin(shown.res.headers.get("referrer-policy"), PUBLIC);
    expect(origin).toBe(PUBLIC);
    const approved = await approve(d, cookie, `token=${shown.token}&decision=approve`, origin);
    expect(approved.status).toBe(302);
    expect(new URL(approved.headers.get("location") ?? "").searchParams.get("code")).toEqual(expect.any(String));

    const again = await consentPage(d, clientId, cookie);
    const denied = await approve(d, cookie, `token=${again.token}&decision=deny`, browserOrigin(again.res.headers.get("referrer-policy"), PUBLIC));
    expect(new URL(denied.headers.get("location") ?? "").searchParams.get("error")).toBe("access_denied");
  });

  it("refuses an approve whose Origin is null — a sandboxed frame or a no-referrer page elsewhere — and issues no code", async () => {
    const d = await door();
    const cookie = await sessionOf(d, ALICE);
    const { token } = await consentPage(d, await register(d), cookie);
    const res = await approve(d, cookie, `token=${token}&decision=approve`, "null");
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
  });

  it("refuses an approve from another origin, and issues no code", async () => {
    const d = await door();
    const cookie = await sessionOf(d, ALICE);
    const { token } = await consentPage(d, await register(d), cookie);
    const res = await approve(d, cookie, `token=${token}&decision=approve`, "https://evil.example");
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
  });

  it("refuses an approve with no token, a token already spent, and another session's token", async () => {
    const d = await door();
    const alice = await sessionOf(d, ALICE);
    const bob = await sessionOf(d, BOB);
    const clientId = await register(d);
    expect((await approve(d, alice, "decision=approve")).status).toBe(400);

    const { token } = await consentPage(d, clientId, alice);
    expect((await approve(d, alice, `token=${token}&decision=approve`)).status).toBe(302);
    const reused = await approve(d, alice, `token=${token}&decision=approve`);
    expect(reused.status).toBe(400);
    expect(reused.headers.get("location")).toBeNull();

    const shown = await consentPage(d, clientId, alice);
    const crossed = await approve(d, bob, `token=${shown.token}&decision=approve`);
    expect(crossed.status).toBe(403);
    expect(crossed.headers.get("location")).toBeNull();
  });

  it("sends a deny back to the client as access_denied, with no code", async () => {
    const d = await door();
    const cookie = await sessionOf(d, ALICE);
    const { token } = await consentPage(d, await register(d), cookie);
    const back = new URL((await approve(d, cookie, `token=${token}&decision=deny`)).headers.get("location") ?? "");
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("code")).toBeNull();
  });
});

describe("an MCP client with a person's token", () => {
  const client = async (d: Door, bearer: string) => {
    const c = new Client({ name: "test", version: "0" });
    const fetch: typeof globalThis.fetch = (input, init) =>
      d.fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), authorization: `Bearer ${bearer}` } });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${PUBLIC}/mcp`), { fetch }) as unknown as Transport);
    return c;
  };
  const textOf = (r: unknown): string => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

  it("lists alice's items only with alice's token, and bob's with bob's", async () => {
    const d = await door();
    const alice = await client(d, (await tokenFor(d, ALICE)).access_token);
    const listed = textOf(await alice.callTool({ name: "landrace_items", arguments: {} }));
    expect(listed).toContain('"1"');
    expect(listed).not.toContain('"2"');
    const bob = await client(d, (await tokenFor(d, BOB)).access_token);
    expect(textOf(await bob.callTool({ name: "landrace_items", arguments: {} }))).toContain('"2"');
  });

  it("keeps refresh tokens hashed in a 0600 file that holds no token issued, and rotates them on use", async () => {
    const d = await door();
    const issued = await tokenFor(d, ALICE);
    const file = join(d.authRoot, MCP_TOKENS_FILE);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const text = await readFile(file, "utf8");
    expect(text).not.toContain(issued.refresh_token);
    expect(text).not.toContain(issued.access_token);
    expect(text).toContain(createHash("sha256").update(issued.refresh_token).digest("hex"));

    const clientId = Object.values(JSON.parse(text) as Record<string, { clientId: string }>)[0]?.clientId ?? "";
    const refresh = (token: string): Promise<Response> => d.fetch(`${PUBLIC}/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: clientId }).toString(),
    });
    expect((await refresh(issued.refresh_token)).status).toBe(200);
    expect((await refresh(issued.refresh_token)).status).toBe(400);
  });

  it("answers a token it never issued 401", async () => {
    const d = await door();
    const res = await d.fetch(`${PUBLIC}/mcp`, { method: "POST", headers: { authorization: "Bearer forged", "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
  });
});
