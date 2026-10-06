import { compareIds, edgeDirection, isReservedId, labelsOf, stageFromLabels } from "#conventions.js";
import type { Graph, Node, Rel, RelAgg } from "#namespace.js";

const empty = (): RelAgg => ({
  total: 0,
  dropped: 0,
  is: Object.create(null) as RelAgg["is"],
  not: Object.create(null) as RelAgg["not"],
  sum: Object.create(null) as RelAgg["sum"],
  stage: Object.create(null) as RelAgg["stage"],
  open: [],
});

/**
 * The fields a node contributes to the counts: its own `state`, plus `closed`
 * as a boolean meaning "done". Dropped nodes never get here.
 */
const fieldsOf = (node: Node): Array<[string, unknown]> =>
  [...Object.entries(node.state), ["closed", node.closed === "done"]];

/** Made by this item's step in a round its stage has since been entered past. */
const superseded = (node: Node, id: string, entered: { readonly [stage: string]: number }): boolean => {
  const { origin } = node;
  if (origin === null || origin.parent !== id) return false;
  const round = Object.hasOwn(entered, origin.stage) ? entered[origin.stage] : undefined;
  return round !== undefined && origin.round < round;
};

/**
 * What an item's relationships add up to, counted from the graph on every
 * pass and never stored — the same rule `run.counters` follows.
 *
 * Counts, not quantifiers: `$every` over an empty list is true, so a parent
 * whose children are not listed yet would read "all done". A count forces the
 * workflow to write `total > 0` itself.
 *
 * Dropped nodes are left out of every count but their own, `dropped`.
 * Counting them in `total` and `is`/`not` is what would let a breakdown that
 * produced nothing read as "every child is closed". Counting them apart is
 * what lets a workflow see that a pull request was closed unmerged — a
 * person's stop, or not, as the workflow says — rather than leaving the kit
 * that opens pull requests to decide it.
 *
 * So are superseded ones: a node this item's own step created (its origin
 * names this item) in a round of a stage that has since been entered again,
 * per `entered` — the run's `rounds[stage].entered`. Re-entering the stage
 * replaced that round's plan. An open one is dropped by the stage's
 * nodes.close anyway, but one that had already finished stays closed as done
 * and cannot be dropped, and counting it let a re-run that created nothing
 * read as "every child is finished" — closing the parent with the rest of the
 * work never done. A node a person created (origin null) is never superseded.
 * A superseded node is not even `dropped`: the round that made it is over.
 *
 * Beside the counts, `open` names the related nodes `total` counts that are
 * still open — which ones a "waiting on 2" is waiting on, for a note to say.
 *
 * Every declared type is present with zero counts even when nothing relates,
 * because a predicate reading an absent path matches nothing — `sum.x: 0`
 * would never be true of an item that has no related nodes at all.
 */
export function deriveRel(
  graph: Graph,
  id: string,
  types: readonly string[],
  entered: { readonly [stage: string]: number } = {},
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
    const direction = edgeDirection(r, id);
    if (direction === null) continue;
    if (isReservedId(r.type)) return { ok: false, why: `relationship type "${r.type}" is a reserved object key` };

    const other = byId.get(r.from === id ? r.to : r.from);
    // Validation (runner/graph.ts) has already refused a dangling edge.
    if (!other || superseded(other, id, entered)) continue;
    if (other.closed === "dropped") {
      slot(r.type)[direction].dropped += 1;
      continue;
    }
    // `closed` is the engine's own field (fieldsOf appends it from node.closed
    // below); a state field of the same name would either double-count the
    // node — once from state, once from the engine — or, if it isn't a
    // boolean, halt with a type-mismatch message that never names the real
    // cause.
    if (Object.hasOwn(other.state, "closed")) {
      return { ok: false, why: `node "${other.id}" has a state field named "closed", which is the engine's own field and cannot also be a state field` };
    }

    const agg = slot(r.type)[direction];
    agg.total += 1;
    if (other.closed === null) agg.open.push(other.id);

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

    if (other.kind === "item") {
      const { stage, ambiguous, found } = stageFromLabels(labelsOf(other));
      if (ambiguous) {
        return { ok: false, why: `related item "${other.id}" carries more than one position (${found.join(", ")}), so it cannot be counted by stage` };
      }
      if (stage !== null) agg.stage[stage] = (agg.stage[stage] ?? 0) + 1;
    }
  }

  // In the order a person reads ids in, so the same graph lists the same way
  // whatever order the source reported its edges in.
  for (const { in: inward, out } of Object.values(rel)) {
    inward.open.sort(compareIds);
    out.open.sort(compareIds);
  }
  return { ok: true, rel };
}
