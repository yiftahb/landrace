import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeConfigSchema } from "#config/schema.js";
import { defineConnection } from "#hooks/contracts.js";
import { createPeoplePanel } from "#people/panel.js";
import { createCredentialStore } from "#people/store.js";
import { createLogger } from "#runner/events.js";
import { Refusal } from "#runner/errors.js";
import type { ConnectionDef, ConnectionValue, LandraceEvent, LoadedConfig, Person, RuntimeContext } from "#namespace.js";

const ME: Person = { id: "local", email: "dev1@example.invalid" };
const TOKEN = "ghp_pasted_token_long_enough";
const NOW = new Date("2026-11-04T00:00:00.000Z");

const config = runtimeConfigSchema.parse({
  version: 1, agent: { adapter: "claude" },
  secrets: { forgeToken: { perPerson: true, connection: "forge.token" } },
});
const loaded: LoadedConfig = {
  config, missing: [], secretValues: new Map(), vars: new Map(), telemetry: new Map(), missingVars: [], missingGit: [], missingPerson: [],
};

async function panelOf(defs: ConnectionDef[], opts: { onChange?: (id: string) => Promise<void> } = {}) {
  const root = join(await mkdtemp(join(tmpdir(), "lr-panel-")), "credentials");
  const store = createCredentialStore(root);
  const events: LandraceEvent[] = [];
  const printed: string[] = [];
  const log = createLogger({ sink: (e) => { events.push(e); printed.push(JSON.stringify(e)); } });
  const changes: string[] = [];
  const checked: ConnectionValue[] = [];
  const ctx = { config, secrets: new Map(), signal: new AbortController().signal, log: () => {} } as unknown as RuntimeContext;
  const panel = createPeoplePanel({
    store, registry: { connections: new Map(defs.map((d) => [d.id, d])) }, loaded, mode: { remote: false }, ctx, log,
    onChange: opts.onChange ?? (async (id) => { changes.push(id); }),
    now: () => NOW,
  });
  return { panel, store, events, printed, changes, checked, root, log };
}

const forge = (check?: ConnectionDef["check"]): ConnectionDef => defineConnection({
  id: "forge", label: "Forge", kind: "credential", fields: ["token"], paste: { hint: "a personal access token, repo scope" },
  ...(check ? { check } : {}),
});
const login = defineConnection({ id: "chat", label: "Chat", kind: "identity", fields: ["user"] });

describe("the people panel", () => {
  it("lists every defined connection, a required one missing and the person not ready, with each pasted one's hint", async () => {
    const { panel } = await panelOf([forge(), login]);
    const me = await panel.me(ME);
    expect(me.person).toEqual(ME);
    expect(me.ready).toBe(false);
    expect(me.connections.map((c) => [c.id, c.kind, c.state])).toEqual([["chat", "identity", "missing"], ["forge", "credential", "missing"]]);
    expect(me.hints).toEqual({ forge: "a personal access token, repo scope" });
  });

  it("connects a pasted credential: stored as paste, logged by id alone, reloaded, and then ready", async () => {
    const { panel, root, events, printed, changes } = await panelOf([forge()]);
    const status = await panel.connect(ME, "forge", { token: TOKEN });
    expect(status).toMatchObject({ id: "forge", state: "connected" });
    const file = JSON.parse(await readFile(join(root, "local.json"), "utf8")) as { connections: Record<string, ConnectionValue> };
    expect(file.connections["forge"]).toMatchObject({ fields: { token: TOKEN }, source: "paste", connectedAt: NOW.toISOString() });
    expect(events.filter((e) => e.name === "person.connected")).toEqual([{ name: "person.connected", connection: "forge" }]);
    expect(printed.join("\n")).not.toContain(TOKEN);
    expect(changes).toEqual(["local"]);
    expect((await panel.me(ME)).ready).toBe(true);
  });

  it("redacts the values before check runs, so whatever check logs or answers is clean", async () => {
    let seen: ConnectionValue | null = null;
    const { panel, printed, log } = await panelOf([forge(async (value) => {
      seen = value;
      log("step.invoked", { said: `checking ${value.fields["token"] ?? ""}` });
      return `the forge refused ${value.fields["token"] ?? ""}`;
    })]);
    const refused = panel.connect(ME, "forge", { token: TOKEN });
    await expect(refused).rejects.toBeInstanceOf(Refusal);
    await expect(refused).rejects.toThrow("the forge refused [redacted]");
    expect(seen).toMatchObject({ fields: { token: TOKEN }, source: "paste" });
    expect(printed.join("\n")).not.toContain(TOKEN);
  });

  it("stores nothing and reloads nothing when check fails", async () => {
    const { panel, store, changes, events } = await panelOf([forge(async () => "that token is revoked")]);
    await expect(panel.connect(ME, "forge", { token: TOKEN })).rejects.toThrow(/that token is revoked/);
    expect((await store.read("local")).connections).toEqual({});
    expect(changes).toEqual([]);
    expect(events.some((e) => e.name === "person.connected")).toBe(false);
  });

  it.each([
    ["an unknown id", "nope", { token: TOKEN }, /no connection "nope"/],
    ["an identity, which is looked up", "chat", { user: "dev1" }, /identity.*looked up/],
    ["a field the connection does not hold", "forge", { token: TOKEN, extra: "x" }, /takes exactly token/],
    ["a field left out", "forge", {}, /takes exactly token/],
    ["an empty field", "forge", { token: "  " }, /token is empty/],
  ])("refuses %s, storing nothing", async (_what, id, fields, why) => {
    const { panel, store, changes } = await panelOf([forge(), login]);
    const connecting = panel.connect(ME, id, fields as Record<string, string>);
    await expect(connecting).rejects.toBeInstanceOf(Refusal);
    await expect(connecting).rejects.toThrow(why);
    expect((await store.read("local")).connections).toEqual({});
    expect(changes).toEqual([]);
  });

  it("keeps the connection stored when the reload after it fails, and says why", async () => {
    const { panel, store } = await panelOf([forge()], { onChange: async () => { throw new Error("hooks would not load"); } });
    await expect(panel.connect(ME, "forge", { token: TOKEN })).rejects.toThrow("hooks would not load");
    expect((await store.read("local")).connections["forge"]?.fields).toEqual({ token: TOKEN });
  });

  it("disconnects: removed, logged by id, reloaded, and no longer ready", async () => {
    const { panel, store, events, changes } = await panelOf([forge()]);
    await panel.connect(ME, "forge", { token: TOKEN });
    await panel.disconnect(ME, "forge");
    expect((await store.read("local")).connections).toEqual({});
    expect(events.filter((e) => e.name === "person.disconnected")).toEqual([{ name: "person.disconnected", connection: "forge" }]);
    expect(changes).toEqual(["local", "local"]);
    expect((await panel.me(ME)).ready).toBe(false);
    await expect(panel.disconnect(ME, "nope")).rejects.toBeInstanceOf(Refusal);
  });
});
