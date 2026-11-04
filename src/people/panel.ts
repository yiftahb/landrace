import { connectionStatus, resolvePerson } from "#people/resolve.js";
import { messageOf, Refusal } from "#runner/errors.js";
import type {
  ConnectionDef, ConnectionStatus, ConnectionValue, CredentialStore, LoadedConfig, MeView, PeoplePanel, Person, RedactingLogger, Registry, RuntimeContext,
} from "#namespace.js";

const byId = (a: ConnectionDef, b: ConnectionDef): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The Integrations tab over a person's credentials file.
 *
 * `loaded` is the configuration before the store, as `resolvePerson` takes
 * it, so `ready` here is the same answer `start` gates on. `onChange` is the
 * reload: a connection stored and a reload that failed leaves the connection
 * stored and rejects with why, since the paste itself was good.
 */
export function createPeoplePanel(opts: {
  store: CredentialStore;
  registry: Pick<Registry, "connections">;
  loaded: LoadedConfig;
  mode: { remote: boolean };
  ctx: RuntimeContext;
  onChange: (personId: string) => Promise<void>;
  log: RedactingLogger;
  now?: () => Date;
}): PeoplePanel {
  const now = opts.now ?? (() => new Date());
  const defOf = (id: string): ConnectionDef => {
    const def = opts.registry.connections.get(id);
    if (def === undefined) {
      const known = [...opts.registry.connections.keys()].sort();
      throw new Refusal(`no connection "${id}" is defined${known.length ? ` — defined: ${known.join(", ")}` : ""}`);
    }
    return def;
  };

  return {
    me: async (caller): Promise<MeView> => {
      const creds = await opts.store.read(caller.id);
      const at = now();
      const defs = [...opts.registry.connections.values()].sort(byId);
      const hints: Record<string, string> = {};
      const fields: Record<string, string[]> = {};
      for (const def of defs) {
        if (def.kind !== "credential") continue;
        fields[def.id] = [...def.fields];
        if (def.paste) hints[def.id] = def.paste.hint;
      }
      return {
        person: caller,
        connections: defs.map((def) => connectionStatus(def, creds, at.getTime())),
        ready: resolvePerson(opts.loaded, opts.registry, caller, creds, opts.mode, at).ready,
        hints,
        fields,
      };
    },

    connect: async (caller: Person, id: string, fields: Record<string, string>): Promise<ConnectionStatus> => {
      const def = defOf(id);
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
      const values = wanted.map((f) => fields[f] ?? "");
      // Before check runs: a hook that logs what it was handed, or a vendor
      // whose error quotes the token, must not put it on a line.
      opts.log.redact(values);
      const value: ConnectionValue = { fields: Object.fromEntries(wanted.map((f) => [f, fields[f] ?? ""])), source: "paste", connectedAt: now().toISOString() };
      let problem: string | null = null;
      try {
        problem = def.check ? await def.check(value, opts.ctx) : null;
      } catch (e) {
        throw new Error(opts.log.scrub(`checking "${id}" failed: ${messageOf(e)}`, values));
      }
      if (problem !== null) throw new Refusal(opts.log.scrub(`"${id}" does not work: ${problem}`, values));
      await opts.store.put(caller.id, caller, id, value);
      opts.log("person.connected", { connection: id });
      await reload(caller.id, `"${id}" is connected`, values);
      return connectionStatus(def, await opts.store.read(caller.id), now().getTime());
    },

    disconnect: async (caller, id) => {
      defOf(id);
      await opts.store.remove(caller.id, id);
      opts.log("person.disconnected", { connection: id });
      await reload(caller.id, `"${id}" is disconnected`);
    },
  };

  /** The reload after a change, its failure said with what was changed and every secret taken out. */
  async function reload(personId: string, done: string, values: readonly string[] = []): Promise<void> {
    try {
      await opts.onChange(personId);
    } catch (e) {
      throw new Error(opts.log.scrub(`${done}, but Landrace could not reload with it: ${messageOf(e)}`, values));
    }
  }
}
