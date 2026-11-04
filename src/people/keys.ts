import type { PerPersonKey, RuntimeConfig } from "#namespace.js";

/**
 * Every `secrets` and `vars` entry written in the per-person form, secrets
 * first and each map by name. The schema has already held `connection` to
 * `<id>.<field>`, so the split is on its one dot.
 */
export function perPersonKeys(config: RuntimeConfig): PerPersonKey[] {
  const keys: PerPersonKey[] = [];
  for (const [section, kind] of [["secrets", "secret"], ["vars", "var"]] as const) {
    for (const [name, value] of Object.entries(config[section]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (typeof value === "string") continue;
      const [id = "", field = ""] = value.connection.split(".");
      keys.push({ kind, name, ...(value.env === undefined ? {} : { env: value.env }), connection: { id, field } });
    }
  }
  return keys;
}
