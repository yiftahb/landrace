import { createHash } from "node:crypto";
import { deriveRel, deriveRun, hashSnapshot, locatedRun } from "#core/index.js";
import type { Entry, Graph, HookContext, Node, PreHook, Snapshot, Source, Workflow } from "#namespace.js";
import { labelsOf, stageFromLabels } from "#conventions.js";
import { messageOf } from "#runner/errors.js";
import { graphProblem } from "#runner/graph.js";

/**
 * Pre hooks run in declaration order, each seeing what previous hooks produced.
 * That is why order is declared rather than inferred, and it is what lets a
 * computing hook read a fetching hook's output without a second hook kind.
 */
const sha256 = (input: string): string => createHash("sha256").update(input).digest("hex");

/**
 * What the engine itself puts in every snapshot, in the vocabulary a hook's
 * `provides` uses.
 *
 * Declared here because this is the function that adds them — `now`, the
 * derived `run`, and the hash over both. Without them §11's path-coverage rule
 * would flag `run.stage`, a path every workflow reads and no hook provides,
 * and a validator that flags healthy workflows gets switched off.
 *
 * Spelled out field by field rather than as a bare `run.*`, because the bug
 * the rule exists to catch is a path that reads *nothing*: `outputs.spec.kind`
 * and `lastEvent.actor` both looked right, matched nothing, and left half the
 * shipped workflow unreachable. A test keeps this list level with what
 * deriveRun actually returns.
 */
export const ENGINE_PROVIDES: readonly string[] = [
  "now",
  "hash",
  "run.stage",
  // Both forms, deliberately. A bare `run.counters*` would also cover
  // `run.countersss`, and a lone `run.counters.*` would not cover the map
  // itself — the point of the rule is that a path off by one letter is caught.
  "run.counters", "run.counters.*",
  "run.rounds", "run.rounds.*",
  "run.next", "run.next.*",
  "run.outputs", "run.outputs.*",
  "run.lastEvent", "run.lastEvent.*",
  "run.lastHuman", "run.lastHuman.*",
  "run.lastOutputValid",
  "run.lastRefused",
  "run.goto", "run.previousStage",
  "run.cleared", "run.cleared.*",
  "run.failedStages", "run.failedStage",
  "run.unblockedAt",
  "run.pairing", "run.pairing.*",
  "run.lastOutputBy",
  "run.heads", "run.heads.*",
  // The source's reading of the item, put in before any pre hook runs.
  "node", "node.id", "node.kind", "node.title", "node.link", "node.closed", "node.priority", "node.origin",
  "node.state", "node.state.*",
  "graph", "graph.*",
];

/** What `rel.<type>` carries per direction, spelled out for the same reason `run.*` is above. */
const REL_AGG: readonly string[] = ["total", "dropped", "is", "is.*", "not", "not.*", "sum", "sum.*", "stage", "stage.*", "open"];

/**
 * Every snapshot path something claims to provide, or null to check none of
 * them.
 *
 * Null is an abstention, and §4 says where it comes from: "Declare nothing and
 * you opt out." The opt-out is for the whole graph rather than for the silent
 * hook's own paths, because nothing can tell which paths a hook that declares
 * nothing contributes — so checking the rest would mean reporting a possibly
 * wrong result about a workflow that is fine. It is the same answer the
 * cycle-bound rule gives for a trigger it cannot analyse.
 */
export function snapshotProvides(pre: PreHook[], source: Source | null): string[] | null {
  if (pre.some((hook) => hook.provides === undefined)) return null;
  if (pre.length === 0 && source === null) return null;
  // Per declared type, so `rel.blocks.in.total` against a source that never
  // reports `blocks` is flagged: it would count zero for ever.
  // And only the side a read draws: a type drawn outward only would count
  // none inward in every read.
  const rel = (source?.relations ?? []).flatMap(({ type, outwardOnly }) => [
    `rel.${type}`,
    ...(outwardOnly ? (["out"] as const) : (["in", "out"] as const))
      .flatMap((side) => [`rel.${type}.${side}`, ...REL_AGG.map((f) => `rel.${type}.${side}.${f}`)]),
  ]);
  return [...ENGINE_PROVIDES, "rel", ...rel, ...pre.flatMap((hook) => hook.provides ?? [])];
}

export async function buildSnapshot(opts: {
  item: string;
  source: Source;
  hooks: PreHook[];
  /**
   * The workflow the item is read for, whose stages say where it is; null
   * for a read that decides nothing and is no one workflow's — its records,
   * an open pairing — which the label alone places, as it always did. Not
   * optional: a caller that acts and forgot it would read an item a custom
   * identity places as though it were nowhere.
   */
  workflow: Workflow | null;
  ctx: Omit<HookContext, "snapshot">;
  now?: number;
  digest?: (input: string) => string;
}): Promise<Snapshot> {
  // The graph first, so every pre hook — and every post hook's satisfied(),
  // which reads the snapshot this built — sees the item as the engine does.
  let graph: Graph;
  try {
    graph = await opts.source.read(opts.item, opts.ctx);
  } catch (e) {
    throw new Error(`source "${opts.source.id}" could not read "${opts.item}": ${messageOf(e)}`);
  }
  const problem = graphProblem(graph, opts.source.relations, opts.item);
  if (problem) throw new Error(`source "${opts.source.id}" returned a graph nothing can be decided from: ${problem}`);
  const node = graph.nodes.find((n) => n.id === opts.item) as Node; // graphProblem proved it is there

  // Graph and node only: rel is counted after the hooks, because which
  // children still count depends on the run's rounds, and the run is derived
  // from the entries a pre hook reads.
  let snapshot: Snapshot = { graph, node };

  for (const hook of opts.hooks) {
    try {
      const fragment = await hook.run({ ...opts.ctx, snapshot });
      snapshot = { ...snapshot, ...fragment };
    } catch (e) {
      // `messageOf`, not `(e as Error).message`: a hook is a plain interface
      // (a tracker's pre hook does real network I/O), and nothing stops one
      // from rejecting with something that is not an Error — that access
      // would throw from inside this very catch, replacing an attributed
      // failure with a raw, unattributed one.
      throw new Error(`pre hook "${hook.id}" failed: ${messageOf(e)}`);
    }
  }

  const entries = (snapshot.entries as Entry[] | undefined) ?? [];
  const labelled = deriveRun(entries, stageFromLabels(labelsOf(node)).stage);
  // A child an earlier round of its stage created no longer counts once the
  // stage is entered again (core/rel.ts). Rounds are every stage's, never
  // scoped to the one the item is at, so they are the same however the run
  // is read below.
  const entered = Object.fromEntries(Object.entries(labelled.rounds).map(([stage, r]) => [stage, r.entered]));
  const rel = deriveRel(graph, opts.item, opts.source.relations.map((r) => r.type), entered);
  if (!rel.ok) throw new Error(`source "${opts.source.id}": ${rel.why}`);

  // Time enters here and nowhere else: core may not read a clock.
  const read: Snapshot = {
    ...snapshot,
    // Set after the hooks: position is the engine's reading of the source's
    // node, and the counts are the engine's reading of its graph, so a pre
    // hook returning its own `node` or `rel` must not move either.
    graph, node, rel: rel.rel,
    now: opts.now ?? Date.now(),
    run: labelled,
  };
  const withRun: Snapshot = opts.workflow === null ? read : { ...read, run: locatedRun(opts.workflow, read) };

  // Recorded, not yet used: the decision cache reads it later. Computed after
  // every hook has contributed, over canonicalised input with volatile fields
  // stripped, so it is stable across ticks that changed nothing.
  return { ...withRun, hash: hashSnapshot(withRun, opts.digest ?? sha256) };
}

/**
 * Why this item cannot be placed at all, or null.
 *
 * Asked here rather than inside `decide`, because "how many positions is this
 * item carrying" is a question about the tracker's own labels, and this is
 * the layer that turns labels into `run.stage`. Asked by converge before it
 * decides anything, because an item with two positions used to run a paid
 * step at whichever one came first in the array — the engine acting on an
 * ambiguity both operator surfaces were already refusing to resolve.
 *
 * A reason rather than a boolean: an operator reading a halted item needs
 * to know which labels to take off it.
 */
export function positionProblem(snapshot: Snapshot): string | null {
  const { ambiguous, found } = stageFromLabels(labelsOf(snapshot.node as Node | undefined));
  if (!ambiguous) return null;
  return `cannot place the item: it carries ${found.length} stage labels (${found.join(", ")}), and position is one`;
}
