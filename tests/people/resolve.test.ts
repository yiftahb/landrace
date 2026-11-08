import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configProblems } from "#config/load.js";
import { defineConnection } from "#hooks/contracts.js";
import { createCredentialStore } from "#people/store.js";
import { claudeConnection } from "landrace/integrations/claude";
import { connectionsOf, loadLocalConfig, localCredentials, lookupIdentities, personEnvOf, resolvePerson } from "#people/resolve.js";
import type { ConnectionDef, ConnectionValue, CredentialStore, Person, Registry, RuntimeContext } from "#namespace.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-04T00:00:00.000Z");
const ME: Person = { id: "local" };
const ASSIGNEE = "vars: { assignee: { perPerson: true, env: LP_ASSIGNEE, connection: forge.login } }\n";
const forge = defineConnection({ id: "forge", label: "Forge", kind: "credential", fields: ["login", "token"] });
const defs = new Map<string, ConnectionDef>([["forge", forge]]);

async function workspace(yaml: string, env = ""): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), "landrace-resolve-")), ".landrace");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "landrace.yaml"), `version: 1\nagent: { adapter: claude }\n${yaml}`);
  await writeFile(join(dir, ".env"), env);
  return dir;
}

async function store(connections: Record<string, unknown> | string | null): Promise<CredentialStore> {
  const root = join(await mkdtemp(join(tmpdir(), "landrace-resolve-creds-")), "credentials");
  if (connections !== null) {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "local.json"), typeof connections === "string" ? connections : JSON.stringify({ person: ME, connections }));
  }
  return createCredentialStore(root);
}

const value = (daysAgo: number, fields: Record<string, string> = { login: "stored-login", token: "ghp_storedtoken123" }, extra: Partial<ConnectionValue> = {}): ConnectionValue =>
  ({ fields, source: "paste", connectedAt: new Date(NOW - daysAgo * DAY).toISOString(), ...extra });
const connected = (daysAgo: number, fields?: Record<string, string>) => ({ forge: value(daysAgo, fields) });

/** `resolvePerson` as `start` and `validate` call it: on the configuration before the store, locally unless told. */
async function judged(dir: string, s: CredentialStore, connections: Map<string, ConnectionDef> = defs, remote = false) {
  const local = await loadLocalConfig(dir, s);
  return resolvePerson(local.configured, { connections }, ME, await localCredentials(local, ME, connections, s), { remote }, new Date(NOW));
}

describe("loadLocalConfig", () => {
  it("leaves a configuration with no per-person key exactly as loadConfig read it, and never opens the store", async () => {
    const opened: string[] = [];
    const spy: CredentialStore = { ...createCredentialStore("/nonexistent"), read: async (p) => { opened.push(p); return { person: { id: p }, connections: {} }; } };
    const local = await loadLocalConfig(await workspace("vars: { who: $LP_WHO }\n", "LP_WHO=dev\n"), spy);
    expect(local.loaded.vars).toEqual(new Map([["who", "dev"]]));
    expect(local.loaded).toBe(local.configured);
    expect(local.credentials).toBeNull();
    expect(local.problems).toEqual([]);
    expect(opened).toEqual([]);
  });

  it("lets the env win over a stored connection", async () => {
    const local = await loadLocalConfig(await workspace(ASSIGNEE, "LP_ASSIGNEE=env-login\n"), await store(connected(1)));
    expect(local.loaded.vars.get("assignee")).toBe("env-login");
    expect(local.problems).toEqual([]);
  });

  it("takes the stored connection's field when the env is unset or empty, for a var and a secret alike, and keeps the configuration before it apart", async () => {
    const dir = await workspace(ASSIGNEE + "secrets: { token: { perPerson: true, connection: forge.token } }\n", "LP_ASSIGNEE=\n");
    const local = await loadLocalConfig(dir, await store(connected(1)));
    expect(local.loaded.vars.get("assignee")).toBe("stored-login");
    expect(local.loaded.secretValues.get("token")).toBe("ghp_storedtoken123");
    expect(local.configured.vars.has("assignee")).toBe(false);
    expect(local.configured.secretValues.has("token")).toBe(false);
    expect(local.problems).toEqual([]);
  });

  it("reports connection.missing when neither the env nor a connection answers", async () => {
    for (const s of [await store(null), await store({}), await store(connected(1, { token: "x" }))]) {
      const local = await loadLocalConfig(await workspace(ASSIGNEE), s);
      expect(local.loaded.vars.has("assignee")).toBe(false);
      expect(local.problems).toEqual([{ rule: "connection.missing", message: expect.stringMatching(/vars entry "assignee".*LP_ASSIGNEE.*"forge".*"login"/) }]);
    }
  });

  it("reports connection.failed with the file's reason when the store does not read, and does not throw", async () => {
    const local = await loadLocalConfig(await workspace(ASSIGNEE), await store("{ nope"));
    expect(local.credentials?.problem).toMatch(/not JSON/);
    expect(local.problems).toEqual([{ rule: "connection.failed", message: expect.stringMatching(/local\.json is not JSON/) }]);
  });

  it("needs nothing of a corrupt store when the env answers every key", async () => {
    const local = await loadLocalConfig(await workspace(ASSIGNEE, "LP_ASSIGNEE=env-login\n"), await store("{ nope"));
    expect(local.problems).toEqual([]);
  });
});

describe("resolvePerson", () => {
  it("is connected and ready when the env is unset and the connection answers", async () => {
    const r = await judged(await workspace(ASSIGNEE), await store(connected(1)));
    expect(r).toMatchObject({ ready: true, problems: [] });
    expect(r.statuses).toEqual([{ id: "forge", label: "Forge", kind: "credential", state: "connected" }]);
    expect(r.vars.get("assignee")).toBe("stored-login");
  });

  it("puts a secret's value in secretValues and a var's in vars", async () => {
    const r = await judged(await workspace("secrets: { token: { perPerson: true, connection: forge.token } }\n"), await store(connected(1)));
    expect(r.secretValues).toEqual(new Map([["token", "ghp_storedtoken123"]]));
    expect(r.vars).toEqual(new Map());
  });

  it("requires no connection for a key the env answers, locally", async () => {
    const r = await judged(await workspace(ASSIGNEE, "LP_ASSIGNEE=env-login\n"), await store(null));
    expect(r).toMatchObject({ ready: true, statuses: [], problems: [] });
    expect(r.vars.get("assignee")).toBe("env-login");
  });

  it("requires no hook to define the connection of a key the env answers, locally, and still does for one it leaves unset", async () => {
    const none = new Map<string, ConnectionDef>();
    const answered = await judged(await workspace(ASSIGNEE, "LP_ASSIGNEE=env-login\n"), await store(null), none);
    expect(answered).toMatchObject({ ready: true, statuses: [], problems: [] });
    expect(answered.vars.get("assignee")).toBe("env-login");
    const unset = await judged(await workspace(ASSIGNEE), await store(connected(1)), none);
    expect(unset.problems).toEqual([{ rule: "connection.unknown", message: expect.stringMatching(/"forge", which no hook defines/) }]);
    expect(unset.ready).toBe(false);
  });

  it("takes the connection's value when remote, even with the env set, and says the env was ignored", async () => {
    const r = await judged(await workspace(ASSIGNEE, "LP_ASSIGNEE=env-login\n"), await store(connected(1)), defs, true);
    expect(r.vars.get("assignee")).toBe("stored-login");
    expect(r.ready).toBe(true);
    expect(r.problems).toEqual([{ rule: "people.env-ignored", message: expect.stringMatching(/LP_ASSIGNEE/) }]);
  });

  it("still requires a defined connection when remote, even with the env set", async () => {
    const r = await judged(await workspace(ASSIGNEE, "LP_ASSIGNEE=env-login\n"), await store(connected(1)), new Map(), true);
    expect(r.problems.map((p) => p.rule)).toEqual(["connection.unknown"]);
    expect(r.ready).toBe(false);
  });

  it("is expired, and not ready, a day past a connection's lifetime", async () => {
    const lasting = new Map([["forge", { ...forge, lifetimeDays: 365 }]]);
    const r = await judged(await workspace(ASSIGNEE), await store(connected(366)), lasting);
    expect(r.statuses).toEqual([expect.objectContaining({ id: "forge", state: "expired", expiresAt: new Date(NOW - DAY).toISOString() })]);
    expect(r.ready).toBe(false);
    expect(r.problems).toEqual([{ rule: "connection.expired", message: expect.stringMatching(/365 days/) }]);
    expect((await judged(await workspace(ASSIGNEE), await store(connected(364)), lasting)).ready).toBe(true);
  });

  it("is expired past the stored expiresAt, and failed with the stored failure", async () => {
    const past = { forge: value(1, undefined, { expiresAt: new Date(NOW - 1000).toISOString() }) };
    const r = await judged(await workspace(ASSIGNEE), await store(past));
    expect(r.statuses).toEqual([expect.objectContaining({ state: "expired" })]);
    expect(r.problems.map((p) => p.rule)).toEqual(["connection.expired"]);
    const future = { forge: value(1, undefined, { expiresAt: new Date(NOW + DAY).toISOString() }) };
    expect((await judged(await workspace(ASSIGNEE), await store(future))).statuses)
      .toEqual([expect.objectContaining({ state: "connected", expiresAt: new Date(NOW + DAY).toISOString() })]);
    const failing = { forge: value(1, undefined, { failedAt: new Date(NOW).toISOString(), failure: "token revoked" }) };
    const f = await judged(await workspace(ASSIGNEE), await store(failing));
    expect(f.statuses).toEqual([expect.objectContaining({ state: "failed", detail: "token revoked" })]);
    expect(f.problems).toEqual([{ rule: "connection.failed", message: expect.stringMatching(/token revoked/) }]);
  });

  it("marks every required connection failed, with the reason, when the store does not read", async () => {
    const r = await judged(await workspace(ASSIGNEE), await store("{ nope"));
    expect(r.statuses).toEqual([expect.objectContaining({ id: "forge", state: "failed", detail: expect.stringMatching(/not JSON/) })]);
    expect(r.ready).toBe(false);
  });

  it("is missing, and not ready, when no connection was made", async () => {
    const r = await judged(await workspace(ASSIGNEE), await store(null));
    expect(r.statuses).toEqual([expect.objectContaining({ id: "forge", state: "missing" })]);
    expect(r.problems.map((p) => p.rule)).toEqual(["connection.missing"]);
  });

  it("requires a connection no key names when it says always, and one saying remote only on a remote instance", async () => {
    const chat = defineConnection({ id: "chat", label: "Chat", kind: "identity", fields: ["user"], required: "always" });
    const bot = defineConnection({ id: "bot", label: "Bot", kind: "credential", fields: ["token"], required: "remote" });
    const both = new Map<string, ConnectionDef>([["chat", chat], ["bot", bot]]);
    const local = await judged(await workspace(""), await store(null), both);
    expect(local.statuses).toEqual([expect.objectContaining({ id: "chat", state: "missing" })]);
    expect(local.problems).toEqual([{ rule: "connection.missing", message: expect.stringMatching(/"chat" connection \(Chat\) is required/) }]);
    const remote = await judged(await workspace(""), await store(null), both, true);
    expect(remote.statuses.map((s) => s.id)).toEqual(["bot", "chat"]);
    expect(remote.ready).toBe(false);
    const made = await judged(await workspace(""), await store({ chat: value(1, { user: "U1" }) }), both);
    expect(made).toMatchObject({ ready: true, problems: [] });
  });

  it("requires a person's own Claude login on a remote instance, so no step there runs on the operator's, and never locally", async () => {
    const claudeOnly = new Map<string, ConnectionDef>([["claude", claudeConnection]]);
    const remote = await judged(await workspace(""), await store(null), claudeOnly, true);
    expect(remote.ready).toBe(false);
    expect(remote.statuses).toEqual([expect.objectContaining({ id: "claude", state: "missing" })]);
    expect(remote.problems).toEqual([{ rule: "connection.missing", message: expect.stringMatching(/"claude" connection \(Claude\) is required/) }]);
    const local = await judged(await workspace(""), await store(null), claudeOnly);
    expect(local).toMatchObject({ ready: true, problems: [], statuses: [] });
  });

  it("opens the store for a configuration with no per-person key only when a hook defines a connection", async () => {
    const opened: string[] = [];
    const spy: CredentialStore = { ...createCredentialStore("/nonexistent"), read: async (p) => { opened.push(p); return { person: { id: p }, connections: {} }; } };
    const local = await loadLocalConfig(await workspace(""), spy);
    expect(await localCredentials(local, ME, new Map(), spy)).toEqual({ person: ME, connections: {} });
    expect(opened).toEqual([]);
    await localCredentials(local, ME, defs, spy);
    expect(opened).toEqual(["local"]);
  });

  it("judges a stored connection nothing requires, so a failed one is not ready rather than ignored", async () => {
    const failing = { forge: value(1, undefined, { failedAt: new Date(NOW).toISOString(), failure: "OAuth token has expired" }) };
    const r = await judged(await workspace(""), await store(failing));
    expect(r.statuses).toEqual([expect.objectContaining({ id: "forge", state: "failed", detail: "OAuth token has expired" })]);
    expect(r.problems).toEqual([{ rule: "connection.failed", message: expect.stringMatching(/"forge" connection \(Forge\) is failed: OAuth token has expired; connect forge/) }]);
    expect(r.ready).toBe(false);
    const fine = await judged(await workspace(""), await store(connected(1)));
    expect(fine).toMatchObject({ ready: true, problems: [], statuses: [expect.objectContaining({ id: "forge", state: "connected" })] });
  });

  it("gives a missing connection the reason its lookup failed", async () => {
    const chat = defineConnection({ id: "chat", label: "Chat", kind: "identity", fields: ["user"], required: "always" });
    const local = await loadLocalConfig(await workspace(""), await store(null));
    const r = resolvePerson(local.configured, { connections: new Map([["chat", chat]]) }, ME, { person: ME, connections: {} }, { remote: false }, new Date(NOW),
      new Map([["chat", "the chatBotToken secret is not set"]]));
    expect(r.statuses).toEqual([expect.objectContaining({ id: "chat", state: "missing", detail: "the chatBotToken secret is not set" })]);
  });

  it("reports connection.unknown for a connection no hook defines, and for a field it does not declare", async () => {
    const r = await judged(await workspace("vars: { a: { perPerson: true, connection: nope.token } }\n"), await store(null));
    expect(r.problems).toEqual([{ rule: "connection.unknown", message: expect.stringMatching(/"nope".*no hook defines/) }]);
    expect(r.ready).toBe(false);
    expect((await judged(await workspace("vars: { a: { perPerson: true, connection: forge.email } }\n"), await store(connected(1)))).problems)
      .toEqual([{ rule: "connection.unknown", message: expect.stringMatching(/"email".*login, token/) }]);
  });
});

/*
 * #229: one identity answering a per-person var and a per-person secret is
 * no secret leaking into a var — the account id has to reach a predicate and
 * a scoped tracker both. A credential shared with a var still is, and only
 * this judging can tell the two apart: the kind is the hook's.
 */
describe("resolvePerson, over a var and a secret of one value", () => {
  const ACCOUNT = "acc-5b10ac8d82e05b22cc7d4ef5";
  const TOKEN = "glpat-person-token-0123456789";
  const jira = defineConnection({ id: "jira", label: "Jira", kind: "identity", fields: ["accountId"] });
  const gitlab = defineConnection({ id: "gitlab", label: "GitLab", kind: "credential", fields: ["token"] });
  const both = new Map<string, ConnectionDef>([["jira", jira], ["gitlab", gitlab]]);
  const stored = {
    jira: value(1, { accountId: ACCOUNT }, { source: "lookup" }),
    gitlab: value(1, { token: TOKEN }),
  };
  const twice = (field: string, env = ""): string =>
    `vars: { me: { perPerson: true, env: LP_ME, connection: ${field} } }\n` +
    `secrets: { shared: { perPerson: true, env: LP_SHARED, connection: ${field} } }\n${env}`;
  const CLASH = /vars entry "me" resolves to the same value as a secret/;

  it.each([false, true])("builds both from one identity field, each carrying the looked-up value (remote: %s)", async (remote) => {
    const dir = await workspace(twice("jira.accountId"));
    const r = await judged(dir, await store(stored), both, remote);
    expect(r).toMatchObject({ ready: true, problems: [] });
    expect(r.vars.get("me")).toBe(ACCOUNT);
    expect(r.secretValues.get("shared")).toBe(ACCOUNT);
    expect(r.statuses.map((s) => [s.id, s.state])).toEqual([["jira", "connected"], ["gitlab", "connected"]]);
  });

  it.each([false, true])("refuses both from one credential field, on that connection's row (remote: %s)", async (remote) => {
    const r = await judged(await workspace(twice("gitlab.token")), await store(stored), both, remote);
    expect(r.problems).toEqual([{ rule: "connection.failed", message: expect.stringMatching(CLASH) }]);
    expect(r.ready).toBe(false);
    expect(r.statuses.find((s) => s.id === "gitlab")).toEqual({ id: "gitlab", label: "GitLab", kind: "credential", state: "failed", detail: expect.stringMatching(CLASH) });
    expect(r.statuses.find((s) => s.id === "jira")?.state).toBe("connected");
  });

  it("refuses an identity var that equals a credential secret, and names both rows", async () => {
    const dir = await workspace(
      "vars: { me: { perPerson: true, connection: jira.accountId } }\nsecrets: { shared: { perPerson: true, connection: gitlab.token } }\n");
    const r = await judged(dir, await store({ ...stored, gitlab: value(1, { token: ACCOUNT }) }), both);
    expect(r.problems).toEqual([{ rule: "connection.failed", message: expect.stringMatching(CLASH) }]);
    expect(r.statuses.map((s) => [s.id, s.state])).toEqual([["gitlab", "failed"], ["jira", "failed"]]);
  });

  it("refuses an identity var that equals a secret `.env` or the file answers", async () => {
    const dir = await workspace(`vars: { me: { perPerson: true, connection: jira.accountId } }\nsecrets: { plain: $LP_PLAIN }\n`, `LP_PLAIN=${ACCOUNT}\n`);
    const r = await judged(dir, await store(stored), both);
    expect(r.problems).toEqual([{ rule: "connection.failed", message: expect.stringMatching(CLASH) }]);
    expect(r.statuses.find((s) => s.id === "jira")?.state).toBe("failed");
    expect(r.statuses.find((s) => s.id === "gitlab")?.state).toBe("connected");
  });

  it("refuses a static var that equals an identity secret", async () => {
    const dir = await workspace(`vars: { plain: $LP_PLAIN }\nsecrets: { shared: { perPerson: true, connection: jira.accountId } }\n`, `LP_PLAIN=${ACCOUNT}\n`);
    const r = await judged(dir, await store(stored), both);
    expect(r.problems).toEqual([{ rule: "connection.failed", message: expect.stringMatching(/vars entry "plain" resolves to the same value as a secret/) }]);
  });

  it("refuses both answered by their variables locally, which no identity answered", async () => {
    const dir = await workspace(twice("jira.accountId"), `LP_ME=${ACCOUNT}\nLP_SHARED=${ACCOUNT}\n`);
    const r = await judged(dir, await store(null), both);
    expect(r.vars.get("me")).toBe(ACCOUNT);
    expect(r.problems).toEqual([{ rule: "connection.failed", message: expect.stringMatching(CLASH) }]);
    expect(r.ready).toBe(false);
    // No connection answered either, so no row is the one to blame.
    expect(r.statuses).toEqual([]);
  });

  it("leaves a configuration whose per-person keys clash to this judging, so the local load does not refuse it first", async () => {
    const dir = await workspace(twice("jira.accountId"));
    const local = await loadLocalConfig(dir, await store(stored));
    expect(local.loaded.vars.get("me")).toBe(ACCOUNT);
    expect(configProblems(dir, local.loaded)).toEqual([]);
  });
});

describe("connectionsOf", () => {
  const registry =(...cs: ConnectionDef[]) => ({ connections: new Map(cs.map((c) => [c.id, c])) }) as unknown as Registry;

  it("merges every workflow's connections, one object shared by two being one", () => {
    const { connections, problems } = connectionsOf([{ id: "a", registry: registry(forge) }, { id: "b", registry: registry(forge) }]);
    expect([...connections.keys()]).toEqual(["forge"]);
    expect(problems).toEqual([]);
  });

  it("halts on two objects with one id, naming both workflows", () => {
    const other = defineConnection({ id: "forge", label: "Other", kind: "identity", fields: ["login"] });
    expect(connectionsOf([{ id: "a", registry: registry(forge) }, { id: "b", registry: registry(other) }]).problems)
      .toEqual([{ rule: "connection.duplicate", message: expect.stringMatching(/"forge".*workflows\/a.*workflows\/b/) }]);
  });
});

describe("lookupIdentities", () => {
  const ctx = { config: {}, secrets: new Map(), signal: new AbortController().signal, log: () => {} } as unknown as RuntimeContext;
  const MAILED: Person = { id: "local", email: "dev1@example.invalid" };
  const chatWith = (resolve: ConnectionDef["resolve"]) => defineConnection({ id: "chat", label: "Chat", kind: "identity", fields: ["user"], ...(resolve ? { resolve } : {}) });

  it("stores an identity it looks up by the person's email as a lookup, which is then connected", async () => {
    const asked: string[] = [];
    const chat = chatWith(async (email) => { asked.push(email); return { user: "U0123ABCD" }; });
    const s = await store(null);
    const { credentials, lookups } = await lookupIdentities(s, MAILED, new Map([["chat", chat]]), { person: MAILED, connections: {} }, ctx, new Date(NOW));
    expect(asked).toEqual(["dev1@example.invalid"]);
    expect(lookups).toEqual(new Map());
    expect(credentials.connections.chat).toEqual({ fields: { user: "U0123ABCD" }, source: "lookup", connectedAt: new Date(NOW).toISOString() });
    expect((await s.read("local")).connections.chat?.source).toBe("lookup");
    const local = await loadLocalConfig(await workspace(""), s);
    const r = resolvePerson(local.configured, { connections: new Map([["chat", chat]]) }, MAILED, credentials, { remote: false }, new Date(NOW));
    expect(r.statuses).toEqual([expect.objectContaining({ id: "chat", state: "connected" })]);
  });

  it("asks nothing without an email, nor for an identity already stored, nor for a credential", async () => {
    let calls = 0;
    const chat = chatWith(async () => { calls += 1; return { user: "U0123ABCD" }; });
    const token = defineConnection({ id: "tok", label: "Tok", kind: "credential", fields: ["token"], resolve: async () => { calls += 1; return { token: "x".repeat(10) }; } });
    const both = new Map<string, ConnectionDef>([["chat", chat], ["tok", token]]);
    const none = await lookupIdentities(await store(null), ME, both, { person: ME, connections: {} }, ctx, new Date(NOW));
    expect(none.lookups.get("chat")).toMatch(/no email/);
    await lookupIdentities(await store(null), MAILED, both, { person: MAILED, connections: { chat: value(1, { user: "U9" }) } }, ctx, new Date(NOW));
    expect(calls).toBe(0);
  });

  it("keeps why a lookup threw, and says when it found nobody, storing nothing", async () => {
    const s = await store(null);
    const threw = chatWith(async () => { throw new Error("the chatBotToken secret is not set"); });
    const a = await lookupIdentities(s, MAILED, new Map([["chat", threw]]), { person: MAILED, connections: {} }, ctx, new Date(NOW));
    expect(a.lookups).toEqual(new Map([["chat", "the chatBotToken secret is not set"]]));
    const nobody = chatWith(async () => null);
    const b = await lookupIdentities(s, MAILED, new Map([["chat", nobody]]), { person: MAILED, connections: {} }, ctx, new Date(NOW));
    expect(b.lookups.get("chat")).toMatch(/Chat found nobody with your email/);
    expect((await s.read("local")).connections).toEqual({});
  });

  it("refuses an answer that is not exactly the connection's fields, storing nothing", async () => {
    const odd = chatWith(async () => ({ login: "U1" }));
    const s = await store(null);
    const r = await lookupIdentities(s, MAILED, new Map([["chat", odd]]), { person: MAILED, connections: {} }, ctx, new Date(NOW));
    expect(r.lookups.get("chat")).toMatch(/user/);
    expect((await s.read("local")).connections).toEqual({});
  });
});

describe("personEnvOf", () => {
  const claude = defineConnection({ id: "claude", label: "Claude", kind: "credential", fields: ["token"] });
  const conn = { id: "claude", env: { CLAUDE_CODE_OAUTH_TOKEN: "token" } };

  it("maps the stored connection's fields onto the variables the executor names", () => {
    const creds = { person: ME, connections: { claude: value(1, { token: "sk-ant-oat01-abc" }) } };
    expect(personEnvOf(conn, new Map([["claude", claude]]), creds)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-abc" });
  });

  it("is nothing with no stored connection, or one no hook defines", () => {
    expect(personEnvOf(conn, new Map([["claude", claude]]), { person: ME, connections: {} })).toBeUndefined();
    expect(personEnvOf(conn, new Map(), { person: ME, connections: { claude: value(1, { token: "sk-ant-oat01-abc" }) } })).toBeUndefined();
  });
});
