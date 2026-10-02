import { compareIds } from "#conventions.js";
import { fillTemplate } from "#core/plan.js";
import type { Node, Rel } from "#namespace.js";

const BUCKETS = new Set(["is", "not", "sum", "stage"]);

/**
 * `rel.<type>.<in|out>.<what>` taken apart, or null where it is not one thing
 * a note can show: `open`, `total`, `dropped`, or one field of a bucket
 * (`not.closed`). A bucket itself is a map, and a map has no wording.
 */
function relField(field: string): { type: string; dir: "in" | "out"; what: string; key: string | null } | null {
  const [root, type, dir, what, key, ...more] = field.split(".");
  if (root !== "rel" || !type || (dir !== "in" && dir !== "out") || what === undefined || more.length > 0) return null;
  if (what === "open" || what === "total" || what === "dropped") return key === undefined ? { type, dir, what, key: null } : null;
  return BUCKETS.has(what) && key ? { type, dir, what, key } : null;
}

/**
 * Whether a note can show `field`: the item's own id, or one count or the
 * open list of one relationship type, one way. Nothing a tracker or an agent
 * wrote — a title, a body — since a note is the workflow's own wording of
 * where the item stands, and the row already shows its title beside it.
 */
export const isNoteField = (field: string): boolean => field === "node.id" || relField(field) !== null;

/** Each field a note reads, once, in the order written — what `validate` holds to `isNoteField` and to what hooks provide. */
export function noteFields(template: string): string[] {
  const found = new Set<string>();
  fillTemplate(template, (name) => {
    found.add(name);
    return undefined;
  });
  return [...found];
}

function shown(field: string, rel: Rel, node: Node): string | undefined {
  if (field === "node.id") return node.id;
  const f = relField(field);
  // Own keys only: a type named `constructor` is not the prototype's.
  const agg = f !== null && Object.hasOwn(rel, f.type) ? rel[f.type]?.[f.dir] : undefined;
  if (f === null || agg === undefined) return undefined;
  if (f.what === "open") return [...agg.open].sort(compareIds).map((id) => `#${id}`).join(", ");
  if (f.what === "total" || f.what === "dropped") return String(agg[f.what]);
  const bucket = f.what === "is" ? agg.is : f.what === "not" ? agg.not : f.what === "sum" ? agg.sum : agg.stage;
  // A count over nothing related is 0, where a predicate reading the same
  // absent path matches nothing. A predicate must not read "none merged" as
  // "all merged"; a person reading "0 open" is told the truth.
  return String(f.key !== null && Object.hasOwn(bucket, f.key) ? bucket[f.key] : 0);
}

/**
 * A stage's `note`, filled in for one item: `{node.id}`, and
 * `{rel.<type>.<in|out>.<count|open>}` from the item's `rel` — an open list
 * as `#10, #11`, in id order, and as nothing at all when none is open.
 * Display only: what lane an item is in is decided before this text exists,
 * never from it. A field this cannot answer is left visible, as every
 * template pass leaves a name nobody answers for, so a typo shows on the
 * board rather than vanishing from it.
 */
export const renderNote = (template: string, rel: Rel, node: Node): string =>
  fillTemplate(template, (field) => shown(field, rel, node));
