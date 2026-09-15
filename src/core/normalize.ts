import type { Snapshot } from "./types.js";

/** Excluded from the hash: they change every tick and mean nothing to a decision. */
const VOLATILE = new Set(["now"]);

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([k]) => !VOLATILE.has(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries.map(([k, v]) => [k, sortValue(v)]));
}

export function canonicalize(s: Snapshot): string {
  return JSON.stringify(sortValue(s));
}

export function hashSnapshot(s: Snapshot, digest: (input: string) => string): string {
  return digest(canonicalize(s));
}
