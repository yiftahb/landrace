import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConnection } from "#hooks/contracts.js";
import { createCredentialStore } from "#people/store.js";
import { connectionsOf, loadLocalConfig, localCredentials, resolvePerson } from "#people/resolve.js";
import type { ConnectionDef, ConnectionValue, CredentialStore, Person, Registry } from "#namespace.js";

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

  it("opens the store for a configuration with no per-person key only when a hook requires a connection always", async () => {
    const opened: string[] = [];
    const spy: CredentialStore = { ...createCredentialStore("/nonexistent"), read: async (p) => { opened.push(p); return { person: { id: p }, connections: {} }; } };
    const local = await loadLocalConfig(await workspace(""), spy);
    expect(await localCredentials(local, ME, defs, spy)).toEqual({ person: ME, connections: {} });
    expect(opened).toEqual([]);
    const always = new Map([["forge", { ...forge, required: "always" as const }]]);
    await localCredentials(local, ME, always, spy);
    expect(opened).toEqual(["local"]);
  });

  it("reports connection.unknown for a connection no hook defines, and for a field it does not declare", async () => {
    const r = await judged(await workspace("vars: { a: { perPerson: true, connection: nope.token } }\n"), await store(null));
    expect(r.problems).toEqual([{ rule: "connection.unknown", message: expect.stringMatching(/"nope".*no hook defines/) }]);
    expect(r.ready).toBe(false);
    expect((await judged(await workspace("vars: { a: { perPerson: true, connection: forge.email } }\n"), await store(connected(1)))).problems)
      .toEqual([{ rule: "connection.unknown", message: expect.stringMatching(/"email".*login, token/) }]);
  });
});

describe("connectionsOf", () => {
  const registry = (...cs: ConnectionDef[]) => ({ connections: new Map(cs.map((c) => [c.id, c])) }) as unknown as Registry;

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
