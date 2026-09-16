import type { Snapshot } from "../namespace.js";

/**
 * Excluded from the hash: it changes every tick and means nothing to a
 * decision. Only the snapshot's own top-level `now` is volatile in this
 * sense — a hook-defined field that happens to be named `now` somewhere
 * inside the snapshot (e.g. `ticket.now`) is ordinary data and must still
 * affect the hash like any other field.
 */
const VOLATILE_TOP_LEVEL_KEY = "now";

/**
 * Deeper than anything a hook legitimately contributes, and shallow enough
 * that the recursion below cannot exhaust the stack. A comment carrying
 * ~5000-deep JSON used to reach here and throw a bare RangeError from
 * somewhere inside the hashing path, which named nothing and could not be
 * attributed; the ticket then failed the same way on every tick. Markers are
 * capped at their own boundary too — this is the guard for any *other* path
 * to deep data, so the same crash cannot come back through a different door.
 */
const MAX_DEPTH = 64;

function sortValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) {
    throw new Error(`snapshot is nested deeper than ${MAX_DEPTH} levels and cannot be canonicalized`);
  }
  if (Array.isArray(value)) return value.map((v) => sortValue(v, depth + 1));
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries.map(([k, v]) => [k, sortValue(v, depth + 1)]));
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
