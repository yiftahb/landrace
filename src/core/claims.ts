import { compareIds, isOpenItem } from "#conventions.js";
import { eligibilityOfNode } from "#core/eligible.js";
import type { ClaimInput, Claims, Graph } from "#namespace.js";

const byId = (a: string, b: string): number => compareIds(a, b);

/**
 * Decide which workflow owns each open item. Never picks between claimants:
 * two eligible workflows is a conflict, and an id two different sources both
 * report is a clash, judged before eligibility because the two nodes may not
 * even be the same item.
 */
export function claimItems(workflows: ClaimInput[], graphs: Graph[]): Claims {
  const claims: Claims = { owner: new Map(), conflicts: new Map(), clashes: new Map(), unclaimed: new Map() };

  const sourcesOf = new Map<string, Set<number>>();
  for (const [index, graph] of graphs.entries()) {
    for (const node of graph.nodes) {
      if (!isOpenItem(node)) continue;
      const set = sourcesOf.get(node.id) ?? new Set<number>();
      set.add(index);
      sourcesOf.set(node.id, set);
    }
  }

  for (const id of [...sourcesOf.keys()].sort(byId)) {
    const sources = sourcesOf.get(id) ?? new Set<number>();
    const listing = workflows.filter((w) => sources.has(w.source));
    if (sources.size > 1) {
      claims.clashes.set(id, listing.map((w) => w.id).sort(byId));
      continue;
    }
    const eligible: string[] = [];
    const reasons: string[] = [];
    for (const w of listing) {
      const node = graphs[w.source]?.nodes.find((n) => n.id === id && isOpenItem(n));
      if (!node) continue;
      const verdict = eligibilityOfNode(w.workflow, node);
      if (verdict.eligible) eligible.push(w.id);
      else reasons.push(verdict.reason);
    }
    const [only] = eligible;
    if (eligible.length === 1 && only !== undefined) claims.owner.set(id, only);
    else if (eligible.length > 1) claims.conflicts.set(id, eligible.sort(byId));
    else if (reasons.length > 0) claims.unclaimed.set(id, reasons);
  }
  return claims;
}
