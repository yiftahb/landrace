import { compareIds, NODES_CLOSE_EFFECT } from "#conventions.js";
import type { Effect, Graph, Node, Snapshot, Stage } from "#namespace.js";

/**
 * Every node a re-run of `stage` must drop before it creates its own children.
 *
 * Stale: made by this item's own `stage` in a round below `below`. Then
 * everything that belongs to those — reached through *incoming* edges of the
 * followed types, because ownership points up (a child points at its parent,
 * a pull request at its item). Already-closed nodes are walked through but
 * never listed. Post-order, so a pull request is dropped before the item it
 * implements and nothing reads done while something under it is still open.
 *
 * `parent` is never in the answer, even if a malformed graph cycles back to
 * it: the item being worked is not something its own cleanup may close.
 */
export function staleClosure(
  graph: Graph,
  parent: string,
  stage: string,
  below: number,
  follow: readonly string[],
): string[] {
  const byId = new Map<string, Node>(graph.nodes.map((n) => [n.id, n]));
  const owned = new Map<string, string[]>();
  for (const r of graph.relationships) {
    if (!follow.includes(r.type)) continue;
    const list = owned.get(r.to) ?? [];
    list.push(r.from);
    owned.set(r.to, list);
  }

  const roots = graph.nodes
    .filter((n) => n.origin?.parent === parent && n.origin.stage === stage && n.origin.round < below)
    .map((n) => n.id)
    .sort(compareIds);

  const seen = new Set<string>([parent]);
  const out: string[] = [];
  const walk = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const next of [...(owned.get(id) ?? [])].sort(compareIds)) walk(next);
    if ((byId.get(id)?.closed ?? null) === null && byId.has(id)) out.push(id);
  };
  for (const root of roots) walk(root);
  return out;
}

/**
 * The concrete close for each `nodes.close` a stage declares, or [] when it
 * declares none. `below` is the caller's to choose: entering round N drops
 * rounds below N; converge re-plans with N + 1 right before invoking, to catch
 * what a crashed attempt at N left behind.
 */
export function planNodesClose(stage: Stage, s: Snapshot, below: number): Effect[] {
  const declared = (stage.on_enter ?? []).filter((e) => e.type === NODES_CLOSE_EFFECT);
  if (!declared.length) return [];

  const self = (s.node as Node | undefined)?.id;
  if (typeof self !== "string") throw new Error(`stage "${stage.id}" closes nodes, but the snapshot has no node`);
  const graph = s.graph as Graph | undefined;
  if (!graph) throw new Error(`stage "${stage.id}" closes nodes, but the snapshot has no graph`);

  return declared.map((e) => {
    const follow = e.follow;
    if (!Array.isArray(follow) || !follow.length || !follow.every((f) => typeof f === "string")) {
      throw new Error(`stage "${stage.id}": a nodes.close effect needs a non-empty "follow" list of relationship types`);
    }
    return {
      type: NODES_CLOSE_EFFECT,
      ids: staleClosure(graph, self, stage.id, below, follow as string[]),
      stage: stage.id,
      round: below,
    };
  });
}
