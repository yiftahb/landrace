import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { expand, parseEnvFile } from "#config/env.js";
import { MIN_SECRET_LENGTH } from "#runner/events.js";
import { runtimeConfigSchema } from "#config/schema.js";
import { TELEMETRY_KEYS } from "#telemetry/otel.js";
import type { LoadedConfig, Problem } from "#namespace.js";

/**
 * The secret values `log.redact` names. A logger redacts by value — a name
 * matches nothing in a log line — so the resolution belongs here, next to the
 * only map that holds the values. An unmatched name is a startup error: a
 * silent no-op here is a secret in the log, which is the cheapest possible
 * catastrophe.
 */
export function redactionValues({ config, secretValues }: LoadedConfig): string[] {
  const unknown = config.log.redact.filter((name) => !secretValues.has(name));
  if (unknown.length) {
    const known = [...secretValues.keys()];
    throw new Error(
      `log.redact names ${unknown.map((n) => `"${n}"`).join(", ")}, which no secret defines` +
      `${known.length ? ` — declared secrets: ${known.join(", ")}` : " — no secrets are declared"}`,
    );
  }
  const values = config.log.redact.map((name) => [name, secretValues.get(name) as string] as const);
  // This is the only place that knows a value's *name*, so it is the only
  // place that can say which secret is misconfigured.
  const tooShort = values.filter(([, v]) => v.trim().length < MIN_SECRET_LENGTH).map(([n]) => n);
  if (tooShort.length) {
    throw new Error(
      `secret(s) ${tooShort.map((n) => `"${n}"`).join(", ")} resolve to fewer than ${MIN_SECRET_LENGTH} ` +
      "characters, which is too short to redact by — the log would be shredded rather than cleaned",
    );
  }
  return values.map(([, v]) => v);
}

/**
 * The vars that are really secrets, by name.
 *
 * Cheap and unambiguous, which is the whole reason it is here: both maps are
 * resolved side by side in `loadConfig`, and equality of two strings is not a
 * judgement call. Compared by *value*, because the mistake worth catching is
 * `vars: { token: $TRACKER_TOKEN }` beside `secrets: { apiToken: $TRACKER_TOKEN }`
 * — two names, one value, and only one of them ever redacted.
 *
 * The asymmetry is the point. A secret is handed to a hook and its value is
 * stripped from every log line and event; a var is substituted into the
 * workflow, so it reaches a tracker comment, an agent's prompt and the events
 * that record both, with nothing suppressing it. Empty values are ignored
 * rather than matched, since every one of them would equal every other.
 */
export function varsHoldingSecrets({ vars, secretValues }: LoadedConfig): string[] {
  const values = new Set([...secretValues.values()].map((v) => v.trim()).filter(Boolean));
  return [...vars].filter(([, value]) => values.has(value.trim())).map(([name]) => name);
}

/**
 * Everything wrong with the configuration itself, worded once.
 *
 * `validate` prints these as problems and the two daemons refuse to start on
 * them, and that is exactly why the wording lives here rather than three
 * times: the CLI and the loop disagreeing about what is fatal is the "a
 * validator that checks less in the daemon than in the CLI" failure, and two
 * copies of a message is how one of them stops being edited.
 */
export function configProblems(dir: string, loaded: LoadedConfig): Problem[] {
  const env = join(dir, ".env");
  return [
    ...loaded.missing.map((name) => ({
      rule: "secret",
      message: `secret "${name}" does not resolve; set it in ${env}`,
    })),
    ...loaded.missingVars.map((name) => ({
      rule: "vars",
      message:
        `vars entry "${name}" does not resolve to a usable value; set it in ${env}. ` +
        "A var is substituted into the workflow before anything validates it, so an unset or empty " +
        "one fills a predicate in with nothing — and a predicate filled in with nothing matches no ticket",
    })),
    ...varsHoldingSecrets(loaded).map((name) => ({
      rule: "vars",
      message:
        `vars entry "${name}" resolves to the same value as a secret. Vars are not secrets: ` +
        "the log redacts by value and knows only what `secrets` declares, while a var reaches a comment " +
        "body, an agent's prompt and the events recording both — keep the value in secrets: and read it in a hook",
    })),
  ];
}

/** The same list, as the refusal a process that is about to run has to make. */
export function assertConfigUsable(dir: string, loaded: LoadedConfig): void {
  const problems = configProblems(dir, loaded);
  if (problems.length) throw new Error(problems.map((p) => `${p.rule}: ${p.message}`).join("\n"));
}

export async function loadConfig(dir: string): Promise<LoadedConfig> {
  const file = join(dir, "landrace.yaml");
  const parsed = runtimeConfigSchema.safeParse(parse(await readFile(file, "utf8")));
  // Zod's own message is a JSON dump of every issue; `validate` prints this
  // as one problem and `start` refuses with it, so it says where, per issue.
  if (!parsed.success) {
    throw new Error(`${file}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const config = parsed.data;

  const fromFile = await readFile(join(dir, ".env"), "utf8")
    .then(parseEnvFile)
    .catch(() => new Map<string, string>());

  // .env wins over the shell: a project's own file should be what runs, not
  // whatever happens to be exported in the terminal.
  const env = new Map<string, string>(Object.entries(process.env).filter(
    (e): e is [string, string] => typeof e[1] === "string"));
  for (const [k, v] of fromFile) env.set(k, v);

  const secretValues = new Map<string, string>();
  const missing: string[] = [];
  for (const [name, reference] of Object.entries(config.secrets)) {
    const value = expand(reference, env);
    if (value === reference && reference.startsWith("$")) missing.push(name);
    else secretValues.set(name, value);
  }

  /*
   * The same expansion, one rule stricter.
   *
   * A secret that does not resolve is reported and its name simply carries no
   * value; a var that does not resolve would be *substituted* — into an
   * eligibility rule, an effect body, a prompt — so "nothing" has to be
   * impossible rather than merely wrong. An empty value is refused for the
   * same reason as an absent one and is the likelier of the two: `export
   * LANDRACE_ASSIGNEE=` resolves perfectly, leaves `$in: [""]` in the graph,
   * and every ticket in the repository is skipped with nobody able to say why.
   */
  const vars = new Map<string, string>();
  const missingVars: string[] = [];
  for (const [name, reference] of Object.entries(config.vars)) {
    const value = expand(reference, env);
    if (value.trim() === "" || (value === reference && reference.startsWith("$"))) missingVars.push(name);
    else vars.set(name, value);
  }

  const telemetry = new Map(TELEMETRY_KEYS.flatMap((key) => {
    const value = env.get(key);
    return value === undefined ? [] : [[key, value] as const];
  }));

  return { config, missing, secretValues, vars, missingVars, telemetry };
}
