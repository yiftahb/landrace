import { isReservedId, labelsOf, stageFromLabels } from "#conventions.js";
import type { Graph, Node, Rel, RelAgg } from "#namespace.js";

const empty = (): RelAgg => ({
  total: 0,
  is: Object.create(null) as RelAgg["is"],
  not: Object.create(null) as RelAgg["not"],
  sum: Object.create(null) as RelAgg["sum"],
  stage: Object.create(null) as RelAgg["stage"],
});

/**
 * The fields a node contributes to the counts: its own `state`, plus `closed`
 * as a boolean meaning "done". Dropped nodes never get here.
 */
const fieldsOf = (node: Node): Array<[string, unknown]> =>
  [...Object.entries(node.state), ["closed", node.closed === "done"]];

/**
 * What a ticket's relationships add up to, counted from the graph on every
 * pass and never stored — the same rule `run.counters` follows.
 *
 * Counts, not quantifiers: `$every` over an empty list is true, so a parent
 * whose children are not listed yet would read "all done". A count forces the
 * workflow to write `total > 0` itself.
 *
 * Dropped nodes are left out entirely: they are gone from the workflow's point
 * of view. Counting them is what would let a breakdown that produced nothing
 * read as "every child is closed".
 *
 * Every declared type is present with zero counts even when nothing relates,
 * because a predicate reading an absent path matches nothing — `sum.x: 0`
 * would never be true of a ticket that has no related nodes at all.
 */
export function deriveRel(
  graph: Graph,
  id: string,
  types: readonly string[],
): { ok: true; rel: Rel } | { ok: false; why: string } {
  const rel = Object.create(null) as Rel;
  const slot = (type: string): Rel[string] => (rel[type] ??= { in: empty(), out: empty() });

  for (const type of types) {
    if (isReservedId(type)) return { ok: false, why: `relationship type "${type}" is a reserved object key` };
    slot(type);
  }

  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  // Which kind of value a field has held so far, per direction and type, so a
  // hook reporting `merged: true` on one PR and `"yes"` on another is caught
  // rather than counted as a smaller number.
  const kinds = new Map<string, string>();

  for (const r of graph.relationships) {
    const direction = r.to === id ? "in" : r.from === id ? "out" : null;
    if (direction === null) continue;
    if (isReservedId(r.type)) return { ok: false, why: `relationship type "${r.type}" is a reserved object key` };

    const other = byId.get(direction === "in" ? r.from : r.to);
    // Validation (runner/graph.ts) has already refused a dangling edge.
    if (!other || other.closed === "dropped") continue;

    const agg = slot(r.type)[direction];
    agg.total += 1;

    for (const [field, value] of fieldsOf(other)) {
      if (isReservedId(field)) return { ok: false, why: `node "${other.id}" has a state field named "${field}", a reserved object key` };
      const kind = typeof value === "boolean" ? "boolean" : typeof value === "number" && Number.isFinite(value) ? "number" : "other";
      const key = `${r.type}.${direction}.${field}`;
      const seen = kinds.get(key);
      if (seen !== undefined && seen !== kind && (seen !== "other" || kind !== "other")) {
        return {
          ok: false,
          why: `"${field}" is a ${seen} on one ${r.type} node and a ${kind === "other" ? typeof value : kind} on "${other.id}"; ` +
            "a field has one type or it cannot be counted",
        };
      }
      kinds.set(key, kind);
      if (kind === "boolean") {
        const bucket = value === true ? agg.is : agg.not;
        bucket[field] = (bucket[field] ?? 0) + 1;
        const opposite = value === true ? agg.not : agg.is;
        opposite[field] ??= 0;
      } else if (kind === "number") {
        agg.sum[field] = (agg.sum[field] ?? 0) + (value as number);
      }
    }

    if (other.kind === "ticket") {
      const { stage, ambiguous, found } = stageFromLabels(labelsOf(other));
      if (ambiguous) {
        return { ok: false, why: `related ticket "${other.id}" carries more than one position (${found.join(", ")}), so it cannot be counted by stage` };
      }
      if (stage !== null) agg.stage[stage] = (agg.stage[stage] ?? 0) + 1;
    }
  }

  return { ok: true, rel };
}
