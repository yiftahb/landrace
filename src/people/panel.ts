import { beginConnect, createPendingConnects, finishConnect, oauthOf } from "#people/oauth.js";
import { connectionStatus, resolvePerson } from "#people/resolve.js";
import { messageOf, Refusal } from "#runner/errors.js";
import type {
  ConnectionDef, ConnectionStatus, ConnectionValue, CredentialStore, LoadedConfig, MeView, PeoplePanel, Person, RedactingLogger, Registry, RuntimeContext,
} from "#namespace.js";

const byId = (a: ConnectionDef, b: ConnectionDef): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The Integrations tab over a person's credentials file.
 *
 * `gate` answers what the latest judging of the caller learned — locally the
 * one person, remotely whoever is asking — the
 * connections its hooks define, the configuration before the store as
 * `resolvePerson` takes it, and the context a check runs in — asked afresh on
 * every call, so after a reload that re-read the hooks lists and
 * `landrace.yaml` the tab lists, gates on and takes a paste for what the
 * runtime gates on, never what the process started with. `onChange` is the
 * reload: a connection stored and a reload that failed leaves the connection
 * stored and rejects with why, since the paste itself was good. `lookups` is
 * why each identity the gate could not look up is missing, for the one
 * person it judged: another caller's rows say nothing of it.
 *
 * `door` is the front door's own URL — `serve.publicUrl`, else the address
 * it bound — which an OAuth provider sends the person back to, at
 * `/connect/<id>/callback`; null while the door is not up, and a Connect
 * link then refuses. A connection made by OAuth is checked, stored and
 * reloaded exactly as a paste is.
 */
export function createPeoplePanel(opts: {
  store: CredentialStore;
  gate: (personId: string) => {
    registry: Pick<Registry, "connections">; loaded: LoadedConfig; ctx: RuntimeContext;
    lookups?: { person: string; reasons: ReadonlyMap<string, string> };
  };
  mode: { remote: boolean };
  onChange: (personId: string) => Promise<void>;
  log: RedactingLogger;
  now?: () => Date;
  door?: () => string | null;
  fetch?: typeof fetch;
}): PeoplePanel {
  const now = opts.now ?? (() => new Date());
  const pending = createPendingConnects();
  const defOf = (registry: Pick<Registry, "connections">, id: string): ConnectionDef => {
    const def = registry.connections.get(id);
    if (def === undefined) {
      const known = [...registry.connections.keys()].sort();
      throw new Refusal(`no connection "${id}" is defined${known.length ? ` — defined: ${known.join(", ")}` : ""}`);
    }
    return def;
  };

  return {
    me: async (caller): Promise<MeView> => {
      const { registry, loaded, lookups, ctx } = opts.gate(caller.id);
      const creds = await opts.store.read(caller.id);
      const at = now();
      const reasons = lookups?.person === caller.id ? lookups.reasons : new Map<string, string>();
      const defs = [...registry.connections.values()].sort(byId);
      const hints: Record<string, string> = {};
      const fields: Record<string, string[]> = {};
      const identities: Record<string, Record<string, string>> = {};
      const oauth: Record<string, string> = {};
      const connections = defs.map((def) => connectionStatus(def, creds, at.getTime(), reasons));
      for (const def of defs) {
        // Who a lookup matched, shown to that person alone — this read is
        // their own file — so they can tell it matched someone else. Never
        // a credential's value: that is what they hold, not who they are.
        const stored = creds.connections[def.id];
        if (def.kind === "identity" && stored !== undefined && connections.some((c) => c.id === def.id && c.state === "connected")) {
          identities[def.id] = Object.fromEntries(def.fields.flatMap((f) => (stored.fields[f] === undefined ? [] : [[f, stored.fields[f]]])));
        }
        if (def.kind !== "credential") continue;
        fields[def.id] = [...def.fields];
        if (def.paste) hints[def.id] = def.paste.hint;
        if (oauthOf(def, ctx) !== null) oauth[def.id] = `/connect/${encodeURIComponent(def.id)}/start`;
      }
      return {
        person: caller,
        connections,
        ready: resolvePerson(loaded, registry, caller, creds, opts.mode, at, reasons).ready,
        hints,
        fields,
        identities,
        oauth,
      };
    },

    connect: async (caller: Person, id: string, fields: Record<string, string>): Promise<ConnectionStatus> => {
      const { registry, ctx } = opts.gate(caller.id);
      const def = defOf(registry, id);
      // Who a person is on a system is looked up from their email, never
      // taken from them: pasting one would let anyone claim to be anyone.
      if (def.kind === "identity") throw new Refusal(`"${id}" is an identity, which is looked up rather than pasted`);
      const given = Object.keys(fields).sort();
      const wanted = [...def.fields].sort();
      if (given.length !== wanted.length || given.some((f, i) => f !== wanted[i])) {
        throw new Refusal(`"${id}" takes exactly ${wanted.join(", ")}; got ${given.length ? given.join(", ") : "nothing"}`);
      }
      const empty = wanted.filter((f) => typeof fields[f] !== "string" || (fields[f] ?? "").trim() === "");
      if (empty.length) throw new Refusal(`"${id}": ${empty.join(", ")} ${empty.length === 1 ? "is" : "are"} empty`);
      const value: ConnectionValue = { fields: Object.fromEntries(wanted.map((f) => [f, fields[f] ?? ""])), source: "paste", connectedAt: now().toISOString() };
      return keep(caller, def, value, ctx);
    },

    begin: async (caller, id) => {
      const { registry, ctx } = opts.gate(caller.id);
      const def = defOf(registry, id);
      const door = opts.door?.() ?? null;
      if (door === null) throw new Refusal(`"${id}" cannot be connected yet: Landrace does not know its own address until the board is up`);
      const redirectUri = new URL(`connect/${encodeURIComponent(id)}/callback`, door.endsWith("/") ? door : `${door}/`).toString();
      return beginConnect(def, ctx, { person: caller.id, redirectUri, pending, now: () => now().getTime() });
    },

    finish: async (caller, id, callback) => {
      const { registry, ctx } = opts.gate(caller.id);
      const def = defOf(registry, id);
      let value: ConnectionValue;
      try {
        value = await finishConnect(def, ctx, {
          person: caller.id, connection: id, callback, pending, now: () => now().getTime(), ...(opts.fetch ? { fetch: opts.fetch } : {}),
        });
      } catch (e) {
        // A provider's error text can quote what it was sent, the app's secret among it.
        const message = opts.log.scrub(messageOf(e));
        throw e instanceof Refusal ? new Refusal(message) : new Error(`connecting "${id}" failed: ${message}`);
      }
      return keep(caller, def, value, ctx);
    },

    disconnect: async (caller, id) => {
      defOf(opts.gate(caller.id).registry, id);
      await opts.store.remove(caller.id, id);
      opts.log("person.disconnected", { connection: id });
      await reload(caller.id, `"${id}" is disconnected`);
    },
  };

  /**
   * A value made — pasted, or by OAuth — checked, stored and reloaded with.
   * Its secrets are redacted before check runs: a hook that logs what it was
   * handed, or a vendor whose error quotes the token, must not put it on a line.
   */
  async function keep(caller: Person, def: ConnectionDef, value: ConnectionValue, ctx: RuntimeContext): Promise<ConnectionStatus> {
    const { id } = def;
    const values = [...Object.values(value.fields), ...(value.refresh === undefined ? [] : [value.refresh.token])];
    opts.log.redact(values);
    let problem: string | null = null;
    try {
      problem = def.check ? await def.check(value, ctx) : null;
    } catch (e) {
      throw new Error(opts.log.scrub(`checking "${id}" failed: ${messageOf(e)}`, values));
    }
    if (problem !== null) throw new Refusal(opts.log.scrub(`"${id}" does not work: ${problem}`, values));
    await opts.store.put(caller.id, caller, id, value);
    opts.log("person.connected", { connection: id });
    await reload(caller.id, `"${id}" is connected`, values);
    return connectionStatus(def, await opts.store.read(caller.id), now().getTime());
  }

  /** The reload after a change, its failure said with what was changed and every secret taken out. */
  async function reload(personId: string, done: string, values: readonly string[] = []): Promise<void> {
    try {
      await opts.onChange(personId);
    } catch (e) {
      throw new Error(opts.log.scrub(`${done}, but Landrace could not reload with it: ${messageOf(e)}`, values));
    }
  }
}
