import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConnection } from "#hooks/contracts.js";
import { createCredentialStore } from "#people/store.js";
import { connectionsOf, loadLocalConfig, resolvePerson } from "#people/resolve.js";
import type { ConnectionDef, CredentialStore, Registry } from "#namespace.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-04T00:00:00.000Z");
const ASSIGNEE = "vars: { assignee: { perPerson: true, env: LP_ASSIGNEE, connection: forge.login } }\n";
const forge = defineConnection({ id: "forge", fields: ["login", "token"], resolve: async () => ({}) });
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
    await writeFile(join(root, "local.json"), typeof connections === "string" ? connections : JSON.stringify({ person: "local", connections }));
  }
  return createCredentialStore(root);
}

const connected = (daysAgo: number, values: Record<string, string> = { login: "stored-login", token: "ghp_storedtoken123" }) =>
  ({ forge: { values, connectedAt: new Date(NOW - daysAgo * DAY).toISOString() } });

describe("loadLocalConfig", () => {
  it("leaves a configuration with no per-person key exactly as loadConfig read it, and never opens the store", async () => {
    const opened: string[] = [];
    const spy: CredentialStore = { ...createCredentialStore("/nonexistent"), read: async (p) => { opened.push(p); return { ok: true, credentials: { person: p, connections: {} } }; } };
    const local = await loadLocalConfig(await workspace("vars: { who: $LP_WHO }\n", "LP_WHO=dev\n"), spy);
    expect(local.loaded.vars).toEqual(new Map([["who", "dev"]]));
    expect(local.credentials).toBeNull();
    expect(local.problems).toEqual([]);
    expect(opened).toEqual([]);
  });

  it("lets the env win over a stored connection", async () => {
    const local = await loadLocalConfig(await workspace(ASSIGNEE, "LP_ASSIGNEE=env-login\n"), await store(connected(1)));
    expect(local.loaded.vars.get("assignee")).toBe("env-login");
    expect(local.problems).toEqual([]);
  });

  it("takes the stored connection's field when the env is unset or empty, for a var and a secret alike", async () => {
    const dir = await workspace(ASSIGNEE + "secrets: { token: { perPerson: true, connection: forge.token } }\n", "LP_ASSIGNEE=\n");
    const local = await loadLocalConfig(dir, await store(connected(1)));
    expect(local.loaded.vars.get("assignee")).toBe("stored-login");
    expect(local.loaded.secretValues.get("token")).toBe("ghp_storedtoken123");
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
    expect(local.credentials?.ok).toBe(false);
    expect(local.problems).toEqual([{ rule: "connection.failed", message: expect.stringMatching(/local\.json is not JSON/) }]);
  });

  it("needs nothing of a corrupt store when the env answers every key", async () => {
    const local = await loadLocalConfig(await workspace(ASSIGNEE, "LP_ASSIGNEE=env-login\n"), await store("{ nope"));
    expect(local.problems).toEqual([]);
  });
});

describe("resolvePerson", () => {
  it("is connected and ready when the env is unset and the connection answers", async () => {
    const r = resolvePerson(await loadLocalConfig(await workspace(ASSIGNEE), await store(connected(1))), defs, { now: NOW });
    expect(r).toMatchObject({ person: "local", remote: false, ready: true, problems: [] });
    expect(r.statuses).toEqual([{ connection: "forge", state: "connected", connectedAt: new Date(NOW - DAY).toISOString() }]);
    expect(r.vars.get("assignee")).toBe("stored-login");
  });

  it("requires no connection for a key the env answers, locally", async () => {
    const r = resolvePerson(await loadLocalConfig(await workspace(ASSIGNEE, "LP_ASSIGNEE=env-login\n"), await store(null)), defs, { now: NOW });
    expect(r).toMatchObject({ ready: true, statuses: [], problems: [] });
    expect(r.vars.get("assignee")).toBe("env-login");
  });

  it("takes the connection's value when remote, even with the env set, and says the env was ignored", async () => {
    const r = resolvePerson(await loadLocalConfig(await workspace(ASSIGNEE, "LP_ASSIGNEE=env-login\n"), await store(connected(1))), defs, { now: NOW, remote: true });
    expect(r.vars.get("assignee")).toBe("stored-login");
    expect(r.ready).toBe(true);
    expect(r.problems).toEqual([{ rule: "people.env-ignored", message: expect.stringMatching(/LP_ASSIGNEE/) }]);
  });

  it("is expired, and not ready, a day past a connection's lifetime", async () => {
    const lasting = new Map([["forge", { ...forge, lifetimeDays: 365 }]]);
    const local = await loadLocalConfig(await workspace(ASSIGNEE), await store(connected(366)));
    const r = resolvePerson(local, lasting, { now: NOW });
    expect(r.statuses).toEqual([expect.objectContaining({ connection: "forge", state: "expired" })]);
    expect(r.ready).toBe(false);
    expect(r.problems).toEqual([{ rule: "connection.expired", message: expect.stringMatching(/365 days/) }]);
    expect(resolvePerson(await loadLocalConfig(await workspace(ASSIGNEE), await store(connected(364))), lasting, { now: NOW }).ready).toBe(true);
  });

  it("marks every required connection failed, with the reason, when the store does not read", async () => {
    const local = await loadLocalConfig(await workspace(ASSIGNEE), await store("{ nope"));
    const r = resolvePerson(local, defs, { now: NOW });
    expect(r.statuses).toEqual([{ connection: "forge", state: "failed", reason: expect.stringMatching(/not JSON/) }]);
    expect(r.ready).toBe(false);
  });

  it("is missing, and not ready, when no connection was made", async () => {
    const r = resolvePerson(await loadLocalConfig(await workspace(ASSIGNEE), await store(null)), defs, { now: NOW });
    expect(r.statuses).toEqual([{ connection: "forge", state: "missing" }]);
    expect(r.problems.map((p) => p.rule)).toEqual(["connection.missing"]);
  });

  it("reports connection.unknown for a connection no hook defines, and for a field it does not declare", async () => {
    const nope = await workspace("vars: { a: { perPerson: true, connection: nope.token } }\n");
    const r = resolvePerson(await loadLocalConfig(nope, await store(null)), defs, { now: NOW });
    expect(r.problems).toEqual([{ rule: "connection.unknown", message: expect.stringMatching(/"nope".*no hook defines/) }]);
    expect(r.ready).toBe(false);
    const field = await workspace("vars: { a: { perPerson: true, connection: forge.email } }\n");
    expect(resolvePerson(await loadLocalConfig(field, await store(connected(1))), defs, { now: NOW }).problems)
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
    const other = defineConnection({ id: "forge", fields: ["login"], resolve: async () => ({}) });
    expect(connectionsOf([{ id: "a", registry: registry(forge) }, { id: "b", registry: registry(other) }]).problems)
      .toEqual([{ rule: "connection.duplicate", message: expect.stringMatching(/"forge".*workflows\/a.*workflows\/b/) }]);
  });
});
