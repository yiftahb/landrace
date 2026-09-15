import type { Snapshot } from "./types.js";

/**
 * Excluded from the hash: it changes every tick and means nothing to a
 * decision. Only the snapshot's own top-level `now` is volatile in this
 * sense — a hook-defined field that happens to be named `now` somewhere
 * inside the snapshot (e.g. `ticket.now`) is ordinary data and must still
 * affect the hash like any other field.
 */
const VOLATILE_TOP_LEVEL_KEY = "now";

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries.map(([k, v]) => [k, sortValue(v)]));
}

export function canonicalize(s: Snapshot): string {
  const top = Object.fromEntries(
    Object.entries(s).filter(([k]) => k !== VOLATILE_TOP_LEVEL_KEY),
  );
  return JSON.stringify(sortValue(top));
}

export function hashSnapshot(s: Snapshot, digest: (input: string) => string): string {
  return digest(canonicalize(s));
}
