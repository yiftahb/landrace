import { filter as mongoFilter } from "@ucast/mongo2js";
import type { Condition, Snapshot } from "../namespace.js";

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

/**
 * Every snapshot path a condition reads. Used by validate for coverage.
 *
 * Unlike walk() (which descends into every nested object indiscriminately —
 * right for an operator scan, since $where can hide anywhere), this only
 * collects keys in *operand position*: a condition document's own keys, and
 * those of a sub-condition nested under $and/$or/$not. A key's own value is
 * never descended into for further paths, because it is either a literal
 * (`{ "outputs.spec": { title: "x" } }` demands the field equal that whole
 * object — "title" is not itself a snapshot path) or an operator object like
 * `{ $lt: 3 }` (whose keys are operators, not paths).
 */
export function pathsIn(c: Condition): string[] {
  const out = new Set<string>();
  const visit = (node: Condition): void => {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$and" || key === "$or") {
        if (Array.isArray(value)) {
          for (const sub of value) {
            if (sub !== null && typeof sub === "object" && !Array.isArray(sub)) visit(sub as Condition);
          }
        }
        continue;
      }
      if (key === "$not") {
        if (value !== null && typeof value === "object" && !Array.isArray(value)) visit(value as Condition);
        continue;
      }
      if (key.startsWith("$") || /^\d+$/.test(key)) continue;
      out.add(key);
    }
  };
  visit(c);
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
