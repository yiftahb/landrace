import { join } from "node:path";
import { loadConfig } from "#config/load.js";
import { LOCAL_PERSON_ID } from "#conventions.js";
import { perPersonKeys } from "#people/keys.js";
import { createCredentialStore } from "#people/store.js";
import type {
  ConnectionDef, ConnectionStatus, CredentialStore, LoadedConfig, LocalConfig, PerPersonKey, PersonCredentialsRead, PersonResolution, Problem, Registry,
} from "#namespace.js";

const DAY_MS = 86_400_000;

const keyId = (key: PerPersonKey): string => `${key.section}.${key.name}`;
const entry = (key: PerPersonKey): string => `${key.section} entry "${key.name}"`;
const mapOf = (loaded: LoadedConfig, key: PerPersonKey): Map<string, string> => (key.section === "vars" ? loaded.vars : loaded.secretValues);

/**
 * Why a key has no value, in the words `validate` reports and `start`
 * refuses with: the variable is unset (or there is none), and the store
 * could not be read, or holds no such field.
 */
function unanswered(dir: string, key: PerPersonKey, person: string, credentials: PersonCredentialsRead): Problem {
  const env = key.env === undefined ? "it names no env variable" : `${key.env} is unset or empty`;
  if (!credentials.ok) {
    return { rule: "connection.failed", message: `${entry(key)} has no value: ${env}, and ${person}'s credentials cannot be read: ${credentials.reason}` };
  }
  const remedy = key.env === undefined ? `connect ${key.connection}` : `set ${key.env} in ${join(dir, ".env")} or connect ${key.connection}`;
  return {
    rule: "connection.missing",
    message: `${entry(key)} has no value: ${env}, and ${person} has no "${key.connection}" connection holding "${key.field}"; ${remedy}`,
  };
}

/**
 * Every per-person key its variable left unanswered, answered from the
 * person's stored connection — the store alone, since the connections the
 * hooks define are not known until the workflow loads, and the workflow
 * cannot load until its vars are filled in. A key nothing answers is
 * reported, and left out rather than filled with nothing.
 */
export function personValues(
  dir: string, loaded: LoadedConfig, credentials: PersonCredentialsRead, person: string = LOCAL_PERSON_ID,
): { loaded: LoadedConfig; problems: Problem[] } {
  const vars = new Map(loaded.vars);
  const secretValues = new Map(loaded.secretValues);
  const problems: Problem[] = [];
  for (const key of perPersonKeys(loaded.config)) {
    const into = key.section === "vars" ? vars : secretValues;
    if (into.has(key.name)) continue;
    const value = credentials.ok ? credentials.credentials.connections[key.connection]?.values[key.field] : undefined;
    if (value !== undefined && value.trim() !== "") into.set(key.name, value);
    else problems.push(unanswered(dir, key, person, credentials));
  }
  return { loaded: { ...loaded, vars, secretValues }, problems };
}

/**
 * `landrace.yaml` as the one local person runs it: `loadConfig`, then their
 * store for each per-person key their variable left unanswered. A
 * configuration with no per-person key never opens the store.
 */
export async function loadLocalConfig(dir: string, store: CredentialStore = createCredentialStore()): Promise<LocalConfig> {
  const loaded = await loadConfig(dir);
  const keys = perPersonKeys(loaded.config);
  if (keys.length === 0) return { dir, loaded, credentials: null, fromEnv: new Set(), problems: [] };
  const fromEnv = new Set(keys.filter((k) => mapOf(loaded, k).has(k.name)).map(keyId));
  const credentials = await store.read(LOCAL_PERSON_ID);
  return { dir, ...personValues(dir, loaded, credentials), credentials, fromEnv };
}

/**
 * The connections every workflow's hooks define, by id. Two workflows that
 * load one hook module share its objects; two different objects under one
 * id are an ambiguity, and halt naming both workflows.
 */
export function connectionsOf(registries: ReadonlyArray<{ id: string; registry: Registry }>): { connections: Map<string, ConnectionDef>; problems: Problem[] } {
  const connections = new Map<string, ConnectionDef>();
  const from = new Map<string, string>();
  const problems: Problem[] = [];
  for (const { id, registry } of registries) {
    for (const [cid, def] of registry.connections) {
      const seen = connections.get(cid);
      if (seen === undefined) {
        connections.set(cid, def);
        from.set(cid, id);
      } else if (seen !== def) {
        problems.push({
          rule: "connection.duplicate",
          message: `connection "${cid}" is defined twice, by the hooks of workflows/${from.get(cid) ?? ""} and of workflows/${id}`,
        });
      }
    }
  }
  return { connections, problems };
}

/**
 * A person judged against the connections the hooks define.
 *
 * Locally a key its variable answered needs no connection: every setup from
 * before connections existed runs as it did. Remotely — never yet, until
 * `people.oidc` exists — the variable belongs to the machine and not the
 * person, so it is ignored, and said to be. Each required connection is
 * judged once, whatever number of keys need it.
 */
export function resolvePerson(
  local: LocalConfig,
  connections: ReadonlyMap<string, ConnectionDef>,
  opts: { remote?: boolean; now: number; person?: string },
): PersonResolution {
  const remote = opts.remote ?? false;
  const person = opts.person ?? LOCAL_PERSON_ID;
  const credentials: PersonCredentialsRead = local.credentials ?? { ok: true, credentials: { person, connections: {} } };
  const vars = new Map<string, string>();
  const secrets = new Map<string, string>();
  const problems: Problem[] = [];
  const statuses = new Map<string, ConnectionStatus>();

  const statusOf = (def: ConnectionDef): ConnectionStatus => {
    const known = statuses.get(def.id);
    if (known) return known;
    let status: ConnectionStatus;
    const stored = credentials.ok ? credentials.credentials.connections[def.id] : undefined;
    if (!credentials.ok) status = { connection: def.id, state: "failed", reason: credentials.reason };
    else if (stored === undefined) status = { connection: def.id, state: "missing" };
    else if (def.lifetimeDays !== undefined && opts.now - Date.parse(stored.connectedAt) > def.lifetimeDays * DAY_MS) {
      status = { connection: def.id, state: "expired", connectedAt: stored.connectedAt };
    } else status = { connection: def.id, state: "connected", connectedAt: stored.connectedAt };
    statuses.set(def.id, status);
    return status;
  };

  for (const key of perPersonKeys(local.loaded.config)) {
    const into = key.section === "vars" ? vars : secrets;
    const def = connections.get(key.connection);
    if (def === undefined) {
      const known = [...connections.keys()].sort();
      problems.push({
        rule: "connection.unknown",
        message: `${entry(key)} names connection "${key.connection}", which no hook defines` +
          (known.length ? ` — defined: ${known.join(", ")}` : " — no hook defines a connection"),
      });
      continue;
    }
    if (!def.fields.includes(key.field)) {
      problems.push({
        rule: "connection.unknown",
        message: `${entry(key)} names field "${key.field}" of connection "${def.id}", which holds only ${def.fields.join(", ")}`,
      });
      continue;
    }
    const answered = local.fromEnv.has(keyId(key));
    if (answered && !remote) {
      const value = mapOf(local.loaded, key).get(key.name);
      if (value !== undefined) into.set(key.name, value);
      continue;
    }
    if (answered) {
      problems.push({
        rule: "people.env-ignored",
        message: `${entry(key)}: ${key.env ?? ""} is set and ignored — a remote instance takes each person's value from their own "${def.id}" connection`,
      });
    }
    const status = statusOf(def);
    const value = status.state === "connected" && credentials.ok ? credentials.credentials.connections[def.id]?.values[key.field] : undefined;
    if (status.state === "connected" && value !== undefined && value.trim() !== "") {
      into.set(key.name, value);
    } else if (status.state === "expired") {
      problems.push({
        rule: "connection.expired",
        message: `${entry(key)}: ${person}'s "${def.id}" connection was made ${status.connectedAt ?? ""} and lasts ${def.lifetimeDays ?? 0} days; connect ${def.id} again`,
      });
    } else {
      problems.push(unanswered(local.dir, key, person, credentials));
    }
  }

  return {
    person, remote, statuses: [...statuses.values()], vars, secrets, problems,
    ready: !problems.some((p) => p.rule.startsWith("connection.")),
  };
}
