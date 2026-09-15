/** A deliberately small .env reader: KEY=value, comments, optional quotes. */
export function parseEnvFile(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1);
    const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
    value = quoted ? (quoted[2] as string) : value.trim();
    if (key) out.set(key, value);
  }
  return out;
}

const REFERENCE = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;

/** `$VAR` / `${VAR}` resolve from the env map. Unresolved returns unchanged. */
export function expand(value: string, env: Map<string, string>): string {
  const m = REFERENCE.exec(value);
  if (!m) return value;
  return env.get(m[1] as string) ?? value;
}
