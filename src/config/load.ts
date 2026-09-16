import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { expand, parseEnvFile } from "#config/env.js";
import { MIN_SECRET_LENGTH } from "#runner/events.js";
import { runtimeConfigSchema } from "#config/schema.js";
import type { LoadedConfig } from "#namespace.js";

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

export async function loadConfig(dir: string): Promise<LoadedConfig> {
  const config = runtimeConfigSchema.parse(parse(await readFile(join(dir, "landrace.yaml"), "utf8")));

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

  return { config, missing, secretValues };
}
