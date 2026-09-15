import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { expand, parseEnvFile } from "./env.js";
import { runtimeConfigSchema, type RuntimeConfig } from "./schema.js";

export interface LoadedConfig {
  config: RuntimeConfig;
  /** Secret names whose reference did not resolve. */
  missing: string[];
  /** Resolved values, kept apart from the config so they cannot be logged by accident. */
  secretValues: Map<string, string>;
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
