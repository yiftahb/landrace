import { join } from "node:path";
import { configProblems, loadConfig } from "#config/load.js";
import { LOCAL_PERSON_ID } from "#conventions.js";
import { perPersonKeys } from "#people/keys.js";
import { createCredentialStore } from "#people/store.js";
import type {
  ConnectionDef, ConnectionStatus, CredentialStore, LoadedConfig, LocalConfig, PerPersonKey, Person, PersonCredentials, PersonResolution, Problem, Registry,
} from "#namespace.js";

const DAY_MS = 86_400_000;

const entry = (key: PerPersonKey): string => `${key.kind === "var" ? "vars" : "secrets"} entry "${key.name}"`;
const mapOf = (loaded: LoadedConfig, key: PerPersonKey): Map<string, string> => (key.kind === "var" ? loaded.vars : loaded.secretValues);
const filled = (value: string | undefined): value is string => value !== undefined && value.trim() !== "";

/**
 * Why a key has no value, in the words `validate` reports and `start`
 * refuses with: the variable is unset (or there is none), and the store
 * could not be read, or holds no such field. `envFile` is where to set it.
 */
function unanswered(envFile: string, key: PerPersonKey, person: string, credentials: PersonCredentials): Problem {
  const env = key.env === undefined ? "it names no env variable" : `${key.env} is unset or empty`;
  const { id, field } = key.connection;
  if (credentials.problem !== undefined) {
    return { rule: "connection.failed", message: `${entry(key)} has no value: ${env}, and ${person}'s credentials cannot be read: ${credentials.problem}` };
  }
  const remedy = key.env === undefined ? `connect ${id}` : `set ${key.env} in ${envFile} or connect ${id}`;
  return {
    rule: "connection.missing",
    message: `${entry(key)} has no value: ${env}, and ${person} has no "${id}" connection holding "${field}"; ${remedy}`,
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
  dir: string, loaded: LoadedConfig, credentials: PersonCredentials, personId: string = LOCAL_PERSON_ID,
): { loaded: LoadedConfig; problems: Problem[] } {
  const vars = new Map(loaded.vars);
  const secretValues = new Map(loaded.secretValues);
  const problems: Problem[] = [];
  for (const key of perPersonKeys(loaded.config)) {
    const into = key.kind === "var" ? vars : secretValues;
    if (into.has(key.name)) continue;
    const value = credentials.connections[key.connection.id]?.fields[key.connection.field];
    if (filled(value)) into.set(key.name, value);
    else problems.push(unanswered(join(dir, ".env"), key, personId, credentials));
  }
  return { loaded: { ...loaded, vars, secretValues }, problems };
}

/**
 * `landrace.yaml` as the one local person runs it: `loadConfig`, then their
 * store for each per-person key their variable left unanswered. A
 * configuration with no per-person key never opens the store.
 */
export async function loadLocalConfig(dir: string, store: CredentialStore = createCredentialStore()): Promise<LocalConfig> {
  const configured = await loadConfig(dir);
  if (perPersonKeys(configured.config).length === 0) return { dir, configured, loaded: configured, credentials: null, problems: [] };
  const credentials = await store.read(LOCAL_PERSON_ID);
  return { dir, configured, ...personValues(dir, configured, credentials), credentials };
}

/** One refusal of every problem, each line `rule: message`, as `validate` prints them. */
const refusal = (problems: readonly Problem[]): Error => new Error(problems.map((p) => `${p.rule}: ${p.message}`).join("\n"));

/**
 * The refusal a process about to run makes over its configuration: what
 * `assertConfigUsable` refuses, and each per-person key nothing answered.
 */
export function assertLocalUsable(local: LocalConfig): void {
  const problems = [...configProblems(local.dir, local.loaded), ...local.problems];
  if (problems.length) throw refusal(problems);
}

/**
 * The refusal `start` makes once the hooks are loaded: a local instance has
 * one person, so nothing runs while their connections are not ready. A
 * notice — `people.env-ignored` — is not a refusal.
 */
export function assertPersonReady(resolution: PersonResolution, duplicates: readonly Problem[] = []): void {
  const problems = [...duplicates, ...resolution.problems.filter((p) => p.rule.startsWith("connection."))];
  if (problems.length) throw refusal(problems);
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
 * The local person's file, for `resolvePerson`: what `loadLocalConfig` read,
 * or, when it read nothing because no key is per-person, the store again if
 * a hook requires a connection whatever the keys say — otherwise nothing,
 * and the store stays unopened.
 */
export async function localCredentials(
  local: LocalConfig, person: Person, connections: ReadonlyMap<string, ConnectionDef>, store: CredentialStore = createCredentialStore(),
): Promise<PersonCredentials> {
  if (local.credentials !== null) return local.credentials;
  const required = [...connections.values()].some((def) => def.required === "always");
  return required ? store.read(person.id) : { person, connections: {} };
}

/** A connection's status for one person, out of what their file holds: the Integrations tab's row, and what `resolvePerson` judges. */
export function connectionStatus(def: ConnectionDef, credentials: PersonCredentials, now: number): ConnectionStatus {
  const base = { id: def.id, label: def.label, kind: def.kind };
  if (credentials.problem !== undefined) return { ...base, state: "failed", detail: credentials.problem };
  const stored = credentials.connections[def.id];
  if (stored === undefined) return { ...base, state: "missing" };
  const lasts = def.lifetimeDays === undefined ? undefined : Date.parse(stored.connectedAt) + def.lifetimeDays * DAY_MS;
  const ends = [lasts, stored.expiresAt === undefined ? undefined : Date.parse(stored.expiresAt)].filter((t): t is number => t !== undefined);
  const end = ends.length ? Math.min(...ends) : undefined;
  const expiresAt = end === undefined ? {} : { expiresAt: new Date(end).toISOString() };
  if (stored.failure !== undefined) return { ...base, state: "failed", detail: stored.failure, ...expiresAt };
  if (end !== undefined && now > end) {
    const why = end === lasts ? `made ${stored.connectedAt}, it lasts ${def.lifetimeDays ?? 0} days` : `it expired ${stored.expiresAt ?? ""}`;
    return { ...base, state: "expired", detail: why, ...expiresAt };
  }
  return { ...base, state: "connected", ...expiresAt };
}

/**
 * A person judged against the connections the hooks define.
 *
 * `loaded` is the configuration before the store: a per-person key in its
 * map is one its variable answered. Locally such a key needs no connection,
 * nor a hook defining one: every setup from before connections existed runs
 * as it did. Remotely — never yet, until `people.oidc` exists — the variable
 * belongs to the machine and not the person, so it is ignored, and said to
 * be. A connection is required when a key needs it, or when its `required`
 * says so; each is judged once, whatever number of keys need it.
 */
export function resolvePerson(
  loaded: LoadedConfig,
  registry: Pick<Registry, "connections">,
  person: Person,
  creds: PersonCredentials,
  mode: { remote: boolean },
  now: Date = new Date(),
): PersonResolution {
  const { remote } = mode;
  const at = now.getTime();
  const vars = new Map<string, string>();
  const secretValues = new Map<string, string>();
  const problems: Problem[] = [];
  const statuses = new Map<string, ConnectionStatus>();
  const judge = (def: ConnectionDef): ConnectionStatus => {
    const known = statuses.get(def.id) ?? connectionStatus(def, creds, at);
    statuses.set(def.id, known);
    return known;
  };
  const whose = `${person.id}'s "`;

  for (const key of perPersonKeys(loaded.config)) {
    const into = key.kind === "var" ? vars : secretValues;
    const fromEnv = mapOf(loaded, key).get(key.name);
    if (fromEnv !== undefined && !remote) {
      into.set(key.name, fromEnv);
      continue;
    }
    const { id, field } = key.connection;
    const def = registry.connections.get(id);
    if (def === undefined) {
      const known = [...registry.connections.keys()].sort();
      problems.push({
        rule: "connection.unknown",
        message: `${entry(key)} names connection "${id}", which no hook defines` +
          (known.length ? ` — defined: ${known.join(", ")}` : " — no hook defines a connection"),
      });
      continue;
    }
    if (!def.fields.includes(field)) {
      problems.push({
        rule: "connection.unknown",
        message: `${entry(key)} names field "${field}" of connection "${def.id}", which holds only ${def.fields.join(", ")}`,
      });
      continue;
    }
    if (fromEnv !== undefined) {
      problems.push({
        rule: "people.env-ignored",
        message: `${entry(key)}: ${key.env ?? ""} is set and ignored — a remote instance takes each person's value from their own "${def.id}" connection`,
      });
    }
    const status = judge(def);
    const value = status.state === "connected" ? creds.connections[def.id]?.fields[field] : undefined;
    if (filled(value)) {
      into.set(key.name, value);
    } else if (status.state === "expired" || (status.state === "failed" && creds.problem === undefined)) {
      problems.push({ rule: `connection.${status.state}`, message: `${entry(key)}: ${whose}${def.id}" connection is ${status.state}: ${status.detail ?? ""}; connect ${def.id} again` });
    } else {
      problems.push(unanswered(".env", key, person.id, creds));
    }
  }

  // A connection required whatever the keys say, and not yet judged for one.
  for (const def of [...registry.connections.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (statuses.has(def.id) || !(def.required === "always" || (def.required === "remote" && remote))) continue;
    const status = judge(def);
    if (status.state === "connected") continue;
    const why = status.state === "missing" ? "was never made" : `is ${status.state}: ${status.detail ?? ""}`;
    problems.push({ rule: `connection.${status.state}`, message: `${whose}${def.id}" connection (${def.label}) is required and ${why}; connect ${def.id}` });
  }

  return {
    secretValues, vars, statuses: [...statuses.values()], problems,
    ready: !problems.some((p) => p.rule.startsWith("connection.")),
  };
}
