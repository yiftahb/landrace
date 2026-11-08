import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createSealedFiles } from "#people/sealed.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { BoardView, FrontDoorOptions, LandraceEvent, Person, Tools } from "#namespace.js";
import { createMcpEndpoint } from "#front/mcp.js";
import { MCP_CLIENTS_FILE, MCP_TOKENS_FILE } from "#front/mcp-auth.js";
import { frontDoorListener } from "#front/server.js";
import { createTools } from "#mcp/tools.js";
import { loadConfig } from "#config/load.js";
import { admits } from "#people/allow.js";
import { createOidc } from "#people/oidc.js";
import { createRoster } from "#people/roster.js";
import { createSessions } from "#people/session.js";
import { createCredentialStore } from "#people/store.js";
import { createLogger } from "#runner/events.js";
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
/** Signed in at the provider, and on nobody's people.allow. */
const CAROL = { sub: "sub-carol", email: "carol@example.org", email_verified: true };
/** The door's cookies over https: `__Host-`, which a sibling subdomain cannot set. */
const SESSION = "__Host-landrace_session";
const LOGIN = "__Host-landrace_login";
const ITEMS: Record<string, number> = { "sub-alice": 1, "sub-bob": 2 };
const view = (id: string): BoardView => ({
  generatedAt: 1, rows: [], nextTickAt: null, folder: id, workspace: "/repo", workflows: [], needsYou: 0, listed: true,
});

/** A value the start's log redacts, as it would a configured secret. */
const SECRET = "frontdoorsecret0123456789";

/**
 * `files`, when given, are written into the MCP credential folder before the
 * door is built. `signInSays`, when given, is what remembering a person who
 * signed in fails with. `secretFolder` puts SECRET in the folder's own path.
 */
async function door(
  files: Record<string, string> = {}, o: { signInSays?: string; secretFolder?: boolean; allow?: string[]; publicUrl?: string; key?: Uint8Array } = {},
) {
  const idp = fakeOidc();
  // `people.allow`, as `start` hands it to the door: a test that empties it is a restart without them.
  const allow = o.allow ?? [ALICE.email, BOB.email];
  const admitted = (person: Person): boolean => admits(allow, person.email);
  const publicUrl = o.publicUrl ?? `${PUBLIC}/`;
  const sessions = createSessions({ secure: new URL(publicUrl).protocol === "https:", admits: admitted });
  const events: LandraceEvent[] = [];
  const log = createLogger({ redactValues: [SECRET], sink: (e) => { events.push(e); } });
  const signedIn: Person[] = [];
  const store = createCredentialStore(join(await mkdtemp(join(tmpdir(), "lr-remote-store-")), "credentials"));
  const configDir = join(await mkdtemp(join(tmpdir(), "lr-remote-config-")), ".landrace");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "landrace.yaml"), "version: 1\nagent: { adapter: claude }\n");
  await writeFile(join(configDir, ".env"), "");
  const roster = createRoster({
    dir: ".", loaded: await loadConfig(configDir), registry: { connections: new Map() }, store, mode: { remote: true },
    admits: admitted, log, build: async () => null,
  });
  const trackers = { alice: createFakeTracker([{ number: 1 }]), bob: createFakeTracker([{ number: 2 }]) };
  const mcp = createMcpEndpoint({
    workflows: ["main"],
    scrub: log.scrub,
    toolsFor: (caller): Tools => {
      const tracker = caller.id === "sub-bob" ? trackers.bob : trackers.alice;
      return createTools([hooked(tracker.registry, loaded(ANY, new Map(), "main"))], tracker.ctx);
    },
  });
  const authRoot = join(await mkdtemp(join(tmpdir(), o.secretFolder ? `lr-remote-${SECRET}-` : "lr-remote-")), "credentials", "mcp");
  for (const [name, text] of Object.entries(files)) {
    await mkdir(authRoot, { recursive: true });
    await writeFile(join(authRoot, name), text);
  }
  const opts: FrontDoorOptions = {
    host: "0.0.0.0", port: 4545, publicUrl, mcp,
    callerOf: (req) => sessions.personOf(req),
    board: { view: async () => view("nobody's") },
    boardFor: (caller) => ({ view: async () => view(caller.id), has: (item) => item === String(ITEMS[caller.id]) }),
    remote: {
      oidc: createOidc({ oidc: { issuer: idp.issuer, clientId: idp.clientId, clientSecret: "client-secret-value" }, redirectUri: new URL("login/callback", publicUrl).href, fetch: idp.fetch }),
      sessions, authFiles: createSealedFiles(dirname(authRoot), o.key ?? null), log, admits: admitted,
      signIn: async (person) => {
        if (o.signInSays !== undefined) throw new Error(o.signInSays);
        await roster.signIn(person);
        signedIn.push(person);
      },
    },
  };
  const fetch = memoryFetch(frontDoorListener(opts, 4545));
  return { fetch, idp, events, signedIn, authRoot, store, allow };
}
type Door = Awaited<ReturnType<typeof door>>;

const cookieIn = (res: Response, name: string): string | undefined =>
  new RegExp(`(?:^|, )${name}=([^;]*)`).exec(res.headers.get("set-cookie") ?? "")?.[1];

/** The whole browser sign-in: /login, the provider, the callback. The callback's response. */
async function signIn(d: Door, claims: Record<string, unknown>, returnTo = "/", userinfo: Record<string, unknown> | number = {}): Promise<Response> {
  const login = await d.fetch(`${PUBLIC}/login?return=${encodeURIComponent(returnTo)}`);
  expect(login.status).toBe(302);
  const to = login.headers.get("location") ?? "";
  const code = d.idp.approve(to, claims, userinfo);
  const state = new URL(to).searchParams.get("state") ?? "";
  return d.fetch(`${PUBLIC}/login/callback?code=${code}&state=${encodeURIComponent(state)}`, {
    headers: { cookie: `${LOGIN}=${cookieIn(login, LOGIN) ?? ""}` },
  });
}
const sessionOf = async (d: Door, claims: Record<string, unknown>): Promise<string> =>
  `${SESSION}=${cookieIn(await signIn(d, claims), SESSION) ?? ""}`;

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

/** A refresh, by the client its record in the tokens file names. */
async function refreshWith(d: Door, token: string): Promise<Response> {
  const hash = createHash("sha256").update(token).digest("hex");
  const held = (JSON.parse(await readFile(join(d.authRoot, MCP_TOKENS_FILE), "utf8")) as Record<string, { clientId: string }>)[hash];
  return d.fetch(`${PUBLIC}/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: held?.clientId ?? "" }).toString(),
  });
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
    const session = new RegExp(`${SESSION}=[^,]*`).exec(set)?.[0] ?? "";
    expect(session.split("; ")).toEqual(expect.arrayContaining(["HttpOnly", "SameSite=Lax", "Secure", "Path=/"]));
    expect(session).not.toMatch(/Domain=/i);
    expect(d.signedIn).toEqual([{ id: "sub-alice", email: "alice@example.invalid" }]);
    expect(d.events).toEqual(expect.arrayContaining([expect.objectContaining({ name: "signin.ok", person: "sub-alice", personEmail: "alice@example.invalid" })]));
    // And then the board is theirs.
    const board = await d.fetch(`${PUBLIC}/board.json`, { headers: { cookie: `${SESSION}=${cookieIn(res, SESSION) ?? ""}` } });
    expect(((await board.json()) as BoardView).folder).toBe("sub-alice");
  });

  it("refuses an unverified email 403, with no session cookie, and logs signin.refused", async () => {
    const d = await door();
    const res = await signIn(d, { ...ALICE, email_verified: false });
    expect(res.status).toBe(403);
    expect(cookieIn(res, SESSION)).toBeUndefined();
    expect(d.signedIn).toEqual([]);
    expect(d.events).toEqual(expect.arrayContaining([expect.objectContaining({ name: "signin.refused", reason: expect.stringMatching(/not verified/) })]));
  });

  // #220: a thin ID token, as Okta's org server issues, verified at userinfo.
  it("signs in a person whose email is verified only at userinfo", async () => {
    const d = await door();
    const res = await signIn(d, { sub: ALICE.sub }, "/", { email: ALICE.email, email_verified: true });
    expect(res.status).toBe(302);
    expect(cookieIn(res, SESSION)).toEqual(expect.any(String));
    expect(d.signedIn).toEqual([{ id: "sub-alice", email: "alice@example.invalid" }]);
  });

  it("refuses 502, with no session cookie, when userinfo fails", async () => {
    const d = await door();
    const res = await signIn(d, { sub: ALICE.sub, email: ALICE.email }, "/", 500);
    expect(res.status).toBe(502);
    expect(cookieIn(res, SESSION)).toBeUndefined();
    expect(d.signedIn).toEqual([]);
    expect(d.events).toEqual(expect.arrayContaining([expect.objectContaining({ name: "signin.refused", reason: expect.stringMatching(/could not be accepted/) })]));
  });

  it("sends return=//evil.example to / once signed in", async () => {
    const d = await door();
    expect((await signIn(d, ALICE, "//evil.example")).headers.get("location")).toBe("/");
  });

  it("turns away a sign-in the roster refuses, with no session", async () => {
    const d = await door();
    const res = await signIn(d, { ...ALICE, sub: "local" });
    expect(res.status).toBe(403);
    expect(cookieIn(res, SESSION)).toBeUndefined();
  });

  // #204: the door's signIn is a real roster's, over a real store.
  it("turns away an email people.allow does not admit 403, naming it, with no session and nothing stored", async () => {
    const d = await door();
    const res = await signIn(d, CAROL);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("carol@example.org is not admitted to this instance");
    expect(cookieIn(res, SESSION)).toBeUndefined();
    expect(await d.store.list()).toEqual([]);
    expect(d.events).toEqual(expect.arrayContaining([expect.objectContaining({ name: "signin.refused", personEmail: "carol@example.org" })]));
  });

  it("sets both of its cookies under __Host- names, Secure, HttpOnly, SameSite=Lax and Path=/, with no Domain", async () => {
    const d = await door();
    const login = await d.fetch(`${PUBLIC}/login`);
    const set = login.headers.get("set-cookie") ?? "";
    expect(set).toMatch(/^__Host-landrace_login=/);
    expect(set.split("; ")).toEqual(expect.arrayContaining(["Secure", "HttpOnly", "SameSite=Lax", "Path=/"]));
    expect(set).not.toMatch(/Domain=/i);
  });

  it("over loopback http, keeps the old cookie names, with no Secure", async () => {
    const d = await door({}, { publicUrl: "http://127.0.0.1:4545/" });
    const login = await d.fetch("http://127.0.0.1:4545/login");
    const set = login.headers.get("set-cookie") ?? "";
    expect(set).toMatch(/^landrace_login=.*Path=\/login/);
    expect(set.split("; ")).not.toContain("Secure");
  });

  it("answers a request carrying two session cookies as nobody", async () => {
    const d = await door();
    const alice = await sessionOf(d, ALICE);
    const bob = await sessionOf(d, BOB);
    expect((await d.fetch(`${PUBLIC}/board.json`, { headers: { cookie: `${alice}; ${bob}` } })).status).toBe(401);
  });
});

/*
 * #204: removing someone is taking them off people.allow and restarting.
 * Here the list is changed under a door already built — what a restart
 * hands the new one — so each grant they already hold is asked again.
 */
describe("someone people.allow no longer admits", () => {
  it("is sent to sign in by their session, and answered 401 by a script", async () => {
    const d = await door();
    const cookie = await sessionOf(d, ALICE);
    d.allow.splice(0, d.allow.length, BOB.email);
    const page = await d.fetch(`${PUBLIC}/`, { headers: { cookie } });
    expect([page.status, page.headers.get("location")]).toEqual([302, "/login?return=%2F"]);
    expect((await d.fetch(`${PUBLIC}/board.json`, { headers: { cookie } })).status).toBe(401);
  });

  it("is answered 401 at /mcp with an access token issued before", async () => {
    const d = await door();
    const { access_token } = await tokenFor(d, ALICE);
    d.allow.splice(0, d.allow.length, BOB.email);
    const res = await d.fetch(`${PUBLIC}/mcp`, { method: "POST", headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
  });

  it("is refused a refresh as invalid_grant, and the refresh token is gone from the file", async () => {
    const d = await door();
    const issued = await tokenFor(d, ALICE);
    d.allow.splice(0, d.allow.length, BOB.email);
    const res = await refreshWith(d, issued.refresh_token);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
    expect(await readFile(join(d.authRoot, MCP_TOKENS_FILE), "utf8")).toBe("{}\n");
  });

  it("loses their stored refresh tokens when a door is built over the file, and keeps everyone else's", async () => {
    const at = Date.now();
    const tokens = {
      a: { clientId: "c1", person: { id: "sub-alice", email: ALICE.email }, scopes: [], expires: at + 60_000, consentedAt: at },
      b: { clientId: "c2", person: { id: "sub-bob", email: BOB.email }, scopes: [], expires: at + 60_000, consentedAt: at },
      n: { clientId: "c3", person: { id: "sub-nobody" }, scopes: [], expires: at + 60_000, consentedAt: at },
    };
    const d = await door({ [MCP_TOKENS_FILE]: JSON.stringify(tokens) }, { allow: [BOB.email] });
    // Any MCP route waits on the files' reading, which writes the file without them.
    await d.fetch(`${PUBLIC}/.well-known/oauth-authorization-server`);
    await d.fetch(`${PUBLIC}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(Object.keys(JSON.parse(await readFile(join(d.authRoot, MCP_TOKENS_FILE), "utf8")) as object)).toEqual(["b"]);
  });
});

// #209: the door's own error lines once skipped the redactor every other line goes through.
describe("the door's error lines", () => {
  const printedDuring = async (run: () => Promise<void>): Promise<string> => {
    const errors = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await run();
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      return errors.mock.calls.map(([m]) => String(m)).join("\n");
    } finally {
      errors.mockRestore();
    }
  };

  it("prints a failed sign-in through the start log's redaction", async () => {
    let status = 0;
    const printed = await printedDuring(async () => {
      const d = await door({}, { signInSays: `the tracker echoed ${SECRET}` });
      status = (await signIn(d, ALICE)).status;
    });
    expect(status).toBe(502);
    expect(printed).toContain("signing in failed: the tracker echoed");
    expect(printed).not.toContain(SECRET);
  });

  it("prints, and answers, a credential file that cannot be read through the start log's redaction", async () => {
    let said = "";
    const printed = await printedDuring(async () => {
      const d = await door({ [MCP_CLIENTS_FILE]: "[]" }, { secretFolder: true });
      said = await (await d.fetch(`${PUBLIC}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).text();
    });
    expect(printed).toContain(MCP_CLIENTS_FILE);
    expect(said).toContain(MCP_CLIENTS_FILE);
    expect(printed).not.toContain(SECRET);
    expect(said).not.toContain(SECRET);
  });
});

describe("signing out at the door", () => {
  /*
   * /logout once sent the browser on to /login, which sends it straight to
   * the provider: with the provider's own session alive, that signed the
   * person back in with a fresh cookie, and signing out never took effect.
   */
  it.each(["GET", "POST"])("on a %s, ends the session on a signed-out page, never sending the browser back to the provider", async (method) => {
    const d = await door();
    const cookie = await sessionOf(d, ALICE);
    const res = await d.fetch(`${PUBLIC}/logout`, { method, headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(cookieIn(res, SESSION)).toBe("");
    const html = await res.text();
    expect(html).not.toContain(new URL(d.idp.issuer).host);
    expect(html).not.toMatch(/http-equiv="refresh"|<script/i);
    // Signing in again is a click on a link, never something the page does by itself.
    expect(html).toMatch(/<a href="\/login">/);
    expect((await d.fetch(`${PUBLIC}/board.json`, { headers: { cookie } })).status).toBe(401);
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

  /*
   * #209: a custom scheme has no origin — `new URL("vscode://…").origin` is
   * the string "null" — so the page once said it would send you to `null`.
   */
  it("says where a custom-scheme redirect sends the person: the URI without its query, escaped", async () => {
    const d = await door();
    const cookie = await sessionOf(d, ALICE);
    const redirect = "vscode://anysphere.landrace/call&back?windowId=1";
    const reg = await d.fetch(`${PUBLIC}/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: "none" }),
    });
    const clientId = ((await reg.json()) as { client_id: string }).client_id;
    const res = await d.fetch(
      `${PUBLIC}/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirect)}&code_challenge=${challenge}&code_challenge_method=S256`,
      { headers: { cookie } },
    );
    const html = await res.text();
    expect(html).toContain("sent back to <code>vscode://anysphere.landrace/call&amp;back</code>");
    expect(html).not.toContain("<code>null</code>");
    expect(html).not.toContain("windowId");
  });

  it("names an http redirect by its origin alone", async () => {
    const d = await door();
    const html = await (await consentPage(d, await register(d), await sessionOf(d, ALICE))).res.text();
    expect(html).toContain(`sent back to <code>${new URL(CLIENT_REDIRECT).origin}</code>`);
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

describe("registering MCP clients", () => {
  /*
   * #209: /register is open and unauthenticated, so without a bound anyone
   * who reaches it grows mcp-clients.json and the map behind it forever.
   */
  const HOUR_S = 60 * 60;
  const clientsOf = (count: number, issuedAt: number, prefix = "c"): Record<string, unknown> => Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`${prefix}${i}`, {
      client_id: `${prefix}${i}`, client_id_issued_at: issuedAt, redirect_uris: [CLIENT_REDIRECT], token_endpoint_auth_method: "none",
    }]),
  );
  const registration = (d: Door): Promise<Response> => d.fetch(`${PUBLIC}/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [CLIENT_REDIRECT], token_endpoint_auth_method: "none" }),
  });
  const nowS = (): number => Math.floor(Date.now() / 1000);

  it("refuses the 1,001st registration, saying the instance holds too many, and stores nothing", async () => {
    const d = await door({ [MCP_CLIENTS_FILE]: JSON.stringify(clientsOf(1000, nowS() - HOUR_S)) });
    const res = await registration(d);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error_description: string }).error_description).toMatch(/holds too many registered clients/);
    expect(Object.keys(JSON.parse(await readFile(join(d.authRoot, MCP_CLIENTS_FILE), "utf8")) as object)).toHaveLength(1000);
  });

  // #205: the door's grants are sealed as each person's file is, and a plain file under a key is refused.
  it("keeps its registrations sealed under the credentials key, and refuses a plain file", async () => {
    const key = new Uint8Array(randomBytes(32));
    const d = await door({}, { key });
    expect((await registration(d)).status).toBe(201);
    const disk = await readFile(join(d.authRoot, MCP_CLIENTS_FILE), "utf8");
    expect((JSON.parse(disk) as { landrace: string }).landrace).toBe("sealed");
    expect(disk).not.toContain(CLIENT_REDIRECT);
    const opened = await createSealedFiles(dirname(d.authRoot), key).read(`mcp/${MCP_CLIENTS_FILE}`);
    expect(Object.keys(JSON.parse(opened ?? "") as object)).toHaveLength(1);
    const plain = await door({ [MCP_CLIENTS_FILE]: JSON.stringify(clientsOf(1, nowS())) }, { key });
    const res = await registration(plain);
    expect(res.status).toBe(503);
    expect(await res.text()).toMatch(/mcp-clients\.json is not sealed/);
  });

  it("registers the 1,000th", async () => {
    const d = await door({ [MCP_CLIENTS_FILE]: JSON.stringify(clientsOf(999, nowS() - HOUR_S)) });
    expect((await registration(d)).status).toBe(201);
    expect(Object.keys(JSON.parse(await readFile(join(d.authRoot, MCP_CLIENTS_FILE), "utf8")) as object)).toHaveLength(1000);
  });

  it("first prunes clients older than 24 hours that hold no refresh token, keeping one that does", async () => {
    const old = nowS() - 25 * HOUR_S;
    const tokens = { hash: { clientId: "old1", person: { id: "sub-alice", email: ALICE.email }, scopes: [], expires: Date.now() + 60_000 } };
    const d = await door({
      [MCP_CLIENTS_FILE]: JSON.stringify({ ...clientsOf(998, nowS() - 23 * HOUR_S), ...clientsOf(2, old, "old") }),
      [MCP_TOKENS_FILE]: JSON.stringify(tokens),
    });
    const res = await registration(d);
    expect(res.status).toBe(201);
    const kept = JSON.parse(await readFile(join(d.authRoot, MCP_CLIENTS_FILE), "utf8")) as Record<string, unknown>;
    expect(Object.keys(kept)).toHaveLength(1000);
    expect(kept["old0"]).toBeUndefined();
    expect(kept["old1"]).toBeDefined();
    expect(kept["c0"]).toBeDefined();
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

  // #204: rotation once renewed the thirty days, so an editor refreshing daily held its grant forever.
  describe("a refresh token's thirty days", () => {
    const DAY = 24 * 60 * 60_000;
    let clock = 0;
    beforeEach(() => {
      clock = Date.UTC(2026, 0, 1);
      jest.spyOn(Date, "now").mockImplementation(() => clock);
    });
    afterEach(() => { jest.restoreAllMocks(); });

    it("rotated daily, fails thirty days after the consent", async () => {
      const d = await door();
      let { refresh_token: token } = await tokenFor(d, ALICE);
      for (let day = 1; day <= 30; day++) {
        clock += DAY;
        const res = await refreshWith(d, token);
        expect([day, res.status]).toEqual([day, 200]);
        token = ((await res.json()) as { refresh_token: string }).refresh_token;
      }
      clock += 60_000;
      const late = await refreshWith(d, token);
      expect(late.status).toBe(400);
      expect(((await late.json()) as { error: string }).error).toBe("invalid_grant");
    });

    it("from a record kept before consentedAt was, fails at the record's own end", async () => {
      const token = "legacy-refresh-token-0123456789";
      const client = { client_id: "c1", client_id_issued_at: Math.floor(clock / 1000), redirect_uris: [CLIENT_REDIRECT], token_endpoint_auth_method: "none" };
      const record = { clientId: "c1", person: { id: "sub-alice", email: ALICE.email }, scopes: [], expires: clock + 5 * DAY };
      const d = await door({
        [MCP_CLIENTS_FILE]: JSON.stringify({ c1: client }),
        [MCP_TOKENS_FILE]: JSON.stringify({ [createHash("sha256").update(token).digest("hex")]: record }),
      });
      clock += 4 * DAY;
      const res = await refreshWith(d, token);
      expect(res.status).toBe(200);
      const next = ((await res.json()) as { refresh_token: string }).refresh_token;
      clock += DAY + 60_000;
      expect((await refreshWith(d, next)).status).toBe(400);
    });
  });

  it("answers a token it never issued 401", async () => {
    const d = await door();
    const res = await d.fetch(`${PUBLIC}/mcp`, { method: "POST", headers: { authorization: "Bearer forged", "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
  });
});

describe("a remote door whose MCP credential files cannot be read", () => {
  /** Collects what rejects with no handler while `run` runs, and a few turns after. */
  async function unhandledDuring(run: () => Promise<void>): Promise<unknown[]> {
    const seen: unknown[] = [];
    const listener = (reason: unknown): void => { seen.push(reason); };
    process.on("unhandledRejection", listener);
    try {
      await run();
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    } finally {
      process.off("unhandledRejection", listener);
    }
    return seen;
  }

  it.each([
    ["clients file not JSON", { [MCP_CLIENTS_FILE]: "{ not json" }, MCP_CLIENTS_FILE],
    ["tokens file null", { [MCP_TOKENS_FILE]: "null" }, MCP_TOKENS_FILE],
    ["tokens file an array", { [MCP_TOKENS_FILE]: "[]" }, MCP_TOKENS_FILE],
  ])("%s: the door stays up, refuses the MCP routes with the reason, and serves the rest", async (_, files, bad) => {
    const errors = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      let d: Door | undefined;
      const unhandled = await unhandledDuring(async () => { d = await door(files); });
      expect(unhandled).toEqual([]);
      if (d === undefined) throw new Error("no door");
      const reg = await d.fetch(`${PUBLIC}/register`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [CLIENT_REDIRECT], token_endpoint_auth_method: "none" }),
      });
      expect(reg.status).toBe(503);
      expect(await reg.text()).toContain(bad);
      const mcp = await d.fetch(`${PUBLIC}/mcp`, { method: "POST", headers: { authorization: "Bearer x", "content-type": "application/json" }, body: "{}" });
      expect(mcp.status).toBe(503);
      expect(await mcp.text()).toContain(bad);
      // The board's own routes are not the MCP ones: an anonymous / still goes to sign-in.
      expect((await d.fetch(`${PUBLIC}/`)).status).toBe(302);
      expect(errors.mock.calls.filter(([m]) => String(m).includes(bad))).toHaveLength(1);
    } finally {
      errors.mockRestore();
    }
  });

  // #209: Node's parse message quotes the text around the fault, which can be part of a token.
  it("says the clients file is not JSON, never quoting the text it holds, on the line and the 503", async () => {
    const errors = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const d = await door({ [MCP_CLIENTS_FILE]: '{"a":{"client_secret":"TOKENLIKE0123456789" oops}}' });
      const reg = await d.fetch(`${PUBLIC}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const said = await reg.text();
      expect(said).toMatch(new RegExp(`${MCP_CLIENTS_FILE} is not JSON$`));
      const printed = errors.mock.calls.map(([m]) => String(m)).join("\n");
      expect(printed).toContain(`${MCP_CLIENTS_FILE} is not JSON`);
      for (const text of [said, printed]) {
        expect(text).not.toContain("TOKENLIKE");
        expect(text).not.toContain("oops");
      }
    } finally {
      errors.mockRestore();
    }
  });
});
