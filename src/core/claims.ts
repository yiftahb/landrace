import { compareIds, isItemNode, isOpenItem } from "#conventions.js";
import { eligibilityOfNode } from "#core/eligible.js";
import type { ClaimInput, Claims, Graph, Node } from "#namespace.js";

const byId = (a: string, b: string): number => compareIds(a, b);

/**
 * Decide which workflow owns each open item, and each closed one a workflow
 * with a `closed: run` stage claims. Never picks between claimants:
 * two eligible workflows is a conflict, and an id two different sources both
 * report is a clash, judged before eligibility because the two nodes may not
 * even be the same item.
 */
export function claimItems(workflows: ClaimInput[], graphs: Graph[]): Claims {
  const claims: Claims = { owner: new Map(), closed: new Map(), conflicts: new Map(), clashes: new Map(), unclaimed: new Map() };

  // id -> source index -> the node that source listed. The one place open items
  // are chosen and the one place a workflow's source is looked up.
  const listed = new Map<string, Map<number, Node>>();
  for (const [index, graph] of graphs.entries()) {
    for (const node of graph.nodes) {
      if (!isOpenItem(node)) continue;
      const bySource = listed.get(node.id) ?? new Map<number, Node>();
      bySource.set(index, node);
      listed.set(node.id, bySource);
    }
  }

  for (const id of [...listed.keys()].sort(byId)) {
    const bySource = listed.get(id) ?? new Map<number, Node>();
    const seen: { w: ClaimInput; node: Node }[] = [];
    for (const w of workflows) {
      const node = bySource.get(w.source);
      if (node) seen.push({ w, node });
    }
    if (bySource.size > 1) {
      claims.clashes.set(id, seen.map((s) => s.w.id).sort(byId));
      continue;
    }
    const eligible: string[] = [];
    const reasons: string[] = [];
    for (const { w, node } of seen) {
      const verdict = eligibilityOfNode(w.workflow, node);
      if (verdict.eligible) eligible.push(w.id);
      else reasons.push(verdict.reason);
    }
    const [only] = eligible;
    if (eligible.length === 1 && only !== undefined) claims.owner.set(id, only);
    else if (eligible.length > 1) claims.conflicts.set(id, eligible.sort(byId));
    else if (reasons.length > 0) claims.unclaimed.set(id, reasons);
  }

  /*
   * A closed item, by the workflows with a `closed: run` stage alone — every
   * other workflow leaves a closed item be, as all of them always did. Judged
   * the same way, two claimants or two sources halting; one nobody claims is
   * simply not admitted, said nowhere: a tracker lists every recently closed
   * item, and a row for each would bury the ones that are work.
   */
  const closedListed = new Map<string, Map<number, Node>>();
  for (const [index, graph] of graphs.entries()) {
    for (const node of graph.nodes) {
      if (!isItemNode(node) || node.closed === null || listed.has(node.id)) continue;
      const bySource = closedListed.get(node.id) ?? new Map<number, Node>();
      bySource.set(index, node);
      closedListed.set(node.id, bySource);
    }
  }
  const running = workflows.filter((w) => w.closedRun === true);
  for (const id of [...closedListed.keys()].sort(byId)) {
    const bySource = closedListed.get(id) ?? new Map<number, Node>();
    const seen = running.flatMap((w) => {
      const node = bySource.get(w.source);
      return node ? [{ w, node }] : [];
    });
    if (seen.length === 0) continue;
    if (bySource.size > 1) {
      claims.clashes.set(id, seen.map((s) => s.w.id).sort(byId));
      continue;
    }
    const eligible = seen.filter(({ w, node }) => eligibilityOfNode(w.workflow, node).eligible).map(({ w }) => w.id);
    const [only] = eligible;
    if (eligible.length === 1 && only !== undefined) claims.closed.set(id, only);
    else if (eligible.length > 1) claims.conflicts.set(id, eligible.sort(byId));
  }
  return claims;
}
