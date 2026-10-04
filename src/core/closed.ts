import { labelsOf, stageFromLabels } from "#conventions.js";
import { locateNode } from "#core/locate.js";
import { compile, missingPaths } from "#core/predicate.js";
import type { Condition, Node, Run, Snapshot, Workflow } from "#namespace.js";

/** Why a closed item is left where it is, said once for every way it is. */
export const CLOSED_WHY = "the item is closed";

/**
 * Whether a trigger could hold, judged from what a listed node answers: its
 * own fields and its position. A top-level condition the node answers and
 * fails rules it out; anything it cannot answer leaves it possible.
 */
function mayHold(when: Condition, snapshot: Snapshot): boolean {
  for (const [path, demand] of Object.entries(when)) {
    const part: Condition = { [path]: demand };
    if (missingPaths(part, snapshot).length > 0) continue;
    if (!compile(part)(snapshot)) return false;
  }
  return true;
}

/**
 * A closed item there is nothing to do for, told from its listed node alone:
 * not at a `closed: run` stage, where its step may still be owed, and no
 * trigger into one could take it. The tick converges none of these — a
 * tracker lists every recently closed item, and building a snapshot of each
 * on every tick to find it resting would be most of the tick's reads.
 *
 * Never idle where it cannot tell: an item it cannot place, a trigger it
 * cannot read. Two triggers that both hold into stages a closed item does not
 * run at halt in `decide`, but move nothing, so are left idle here.
 */
export function closedIdle(workflow: Workflow, node: Node): boolean {
  if (node.closed === null) return false;
  let where;
  try {
    where = locateNode(workflow, node);
  } catch {
    return false;
  }
  if (where.kind === "none") return true;
  if (where.kind !== "at" || where.stage.closed === "run") return false;
  const current = where.stage.id;
  const snapshot: Snapshot = { node, run: { stage: stageFromLabels(labelsOf(node)).stage } as Run };
  try {
    return !workflow.stages.some((stage) =>
      stage.id !== current && stage.closed === "run" && (stage.triggers ?? []).some((t) => mayHold(t.when, snapshot)));
  } catch {
    return false;
  }
}
