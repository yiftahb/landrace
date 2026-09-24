import { isReservedId, ticketIdProblem } from "#conventions.js";
import type { Graph, RelationDecl } from "#namespace.js";
import { problemWith } from "#runner/artifacts.js";

/**
 * How big one ticket's neighbourhood may be. `read` returns the whole
 * descendant subtree, because a cascade close must see every node it closes,
 * and it runs on every converge pass. Past this, the honest answer is a halt
 * naming the size — ponytail: page the subtree when a real epic gets here.
 */
export const MAX_SUBGRAPH_NODES = 200;

const CLOSED = new Set<unknown>([null, "done", "dropped"]);

/**
 * Why nothing may be decided from this graph, or null.
 *
 * A source is a hook, and what it returns is outside input: this runs before
 * any count is taken or any decision made from it, so a half graph halts the
 * ticket with a reason rather than being quietly read as a smaller one.
 */
export function graphProblem(graph: Graph, relations: readonly RelationDecl[], id?: string): string | null {
  if (id !== undefined && graph.nodes.length > MAX_SUBGRAPH_NODES) {
    return `the neighbourhood of "${id}" has ${graph.nodes.length} nodes, more than the ${MAX_SUBGRAPH_NODES} one read may carry`;
  }

  const ids = new Set<string>();
  for (const node of graph.nodes) {
    const bad = ticketIdProblem(node.id);
    if (bad) return bad;
    if (ids.has(node.id)) return `duplicate node id "${node.id}"`;
    ids.add(node.id);
    if (!CLOSED.has(node.closed)) return `node "${node.id}" has closed = ${JSON.stringify(node.closed)}; it is null, "done" or "dropped"`;
    if (node.priority !== null && !(typeof node.priority === "number" && Number.isFinite(node.priority))) {
      return `node "${node.id}" has priority ${String(node.priority)}; it is a finite number or null`;
    }
    if (node.state === null || typeof node.state !== "object" || Array.isArray(node.state)) {
      return `node "${node.id}" has a state that is not an object`;
    }
    const stateProblem = problemWith(node.state, "", 0, { chars: 0 });
    if (stateProblem) return `node "${node.id}": ${stateProblem}`;
  }
  if (id !== undefined && !ids.has(id)) return `the ticket "${id}" is not in the graph its source read for it`;

  const declared = new Map(relations.map((r) => [r.type, r]));
  const singularOut = new Map<string, string>();
  for (const r of graph.relationships) {
    if (isReservedId(r.type)) return `relationship type "${r.type}" is a reserved object key`;
    if (!declared.has(r.type)) return `relationship type "${r.type}" is not one the source declares`;
    for (const end of [r.from, r.to]) if (!ids.has(end)) return `a "${r.type}" relationship names "${end}", which is not in the graph`;
    if (declared.get(r.type)?.singular) {
      const key = `${r.type}\u0000${r.from}`;
      if (singularOut.has(key)) {
        return `"${r.from}" has two ${r.type} relationships (to "${singularOut.get(key)}" and "${r.to}"); it may have one`;
      }
      singularOut.set(key, r.to);
    }
  }

  // A cycle through singular edges: follow each node's one outgoing edge per type.
  for (const decl of relations.filter((r) => r.singular)) {
    for (const start of ids) {
      const seen = new Set<string>();
      let at: string | undefined = start;
      while (at !== undefined) {
        if (seen.has(at)) return `a cycle of ${decl.type} relationships runs through "${at}"`;
        seen.add(at);
        at = singularOut.get(`${decl.type}\u0000${at}`);
      }
    }
  }
  return null;
}
