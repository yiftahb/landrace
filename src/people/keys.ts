import type { PerPersonKey, RuntimeConfig } from "#namespace.js";

/**
 * Every `secrets` and `vars` entry written in the per-person form, secrets
 * first and each map by name. The schema has already held `connection` to
 * `<id>.<field>`, so the split is on its one dot.
 */
export function perPersonKeys(config: RuntimeConfig): PerPersonKey[] {
  const keys: PerPersonKey[] = [];
  for (const section of ["secrets", "vars"] as const) {
    for (const [name, value] of Object.entries(config[section]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (typeof value === "string") continue;
      const [connection = "", field = ""] = value.connection.split(".");
      keys.push({ section, name, ...(value.env === undefined ? {} : { env: value.env }), connection, field });
    }
  }
  return keys;
}
