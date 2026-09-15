import { filter as mongoFilter } from "@ucast/mongo2js";
import type { Condition, Snapshot } from "./types.js";

export const ALLOWED_OPERATORS = [
  "$eq", "$ne", "$in", "$nin", "$lt", "$lte", "$gt", "$gte",
  "$exists", "$all", "$size", "$and", "$or", "$not",
] as const;

const allowed = new Set<string>(ALLOWED_OPERATORS);

function walk(node: unknown, visit: (key: string, value: unknown) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (node === null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    visit(key, value);
    walk(value, visit);
  }
}

/**
 * The allowlist is enforced before the condition reaches the evaluator, and it
 * recurses: `$where` nested under `$or` is the documented way past a
 * single-level check. `.landrace/workflow.yaml` is a repo file, so a
 * contributor's PR can edit it.
 */
export function assertAllowedOperators(c: Condition): void {
  walk(c, (key) => {
    if (key.startsWith("$") && !allowed.has(key)) {
      throw new Error(`operator ${key} is not allowed in a predicate`);
    }
  });
}

export function compile(c: Condition): (s: Snapshot) => boolean {
  assertAllowedOperators(c);
  const test = mongoFilter(c as never);
  return (s: Snapshot) => test(s as never);
}

/** Every snapshot path a condition reads. Used by validate for coverage. */
export function pathsIn(c: Condition): string[] {
  const out = new Set<string>();
  walk(c, (key) => {
    if (!key.startsWith("$") && !/^\d+$/.test(key)) out.add(key);
  });
  return [...out];
}

function resolve(s: unknown, path: string): { found: boolean } {
  let cur: unknown = s;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !(part in (cur as object))) {
      return { found: false };
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  return { found: true };
}

/**
 * Paths the condition reads that the snapshot does not contain at all. Absent is
 * not the same as falsy: a renamed field makes a predicate silently stop
 * matching, which is the hardest failure this system has.
 */
export function missingPaths(c: Condition, s: Snapshot): string[] {
  return pathsIn(c).filter((p) => !resolve(s, p).found);
}
