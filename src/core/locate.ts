import { labelsOf, stageFromLabels } from "#conventions.js";
import { compile, missingPaths } from "#core/predicate.js";
import type { Location, Node, Run, Snapshot, Stage, Workflow } from "#namespace.js";

/**
 * Default identity: you are here if the tracker says so.
 * Exported so workflow/validate.ts checks the same definition locate() uses
 * to place an item — two copies of this default previously let the
 * validator and the engine silently disagree about where an item is.
 */
export const identityOf = (stage: Stage) => stage.identity ?? { "run.stage": stage.id };

/**
 * Why an item several stages match cannot be placed, in the words every
 * surface says it in: decide's halt, a status row, `landrace_status`. Two
 * wordings of one halt is how an operator comes to think they are two.
 */
export const cannotPlace = (ids: readonly string[]): string => `cannot place the item: ${ids.join(", ")} all match`;

export function locate(w: Workflow, s: Snapshot): Location {
  const matches = w.stages.filter((stage) => compile(identityOf(stage))(s));
  if (matches.length > 1) return { kind: "ambiguous", ids: matches.map((m) => m.id) };
  const only = matches[0];
  return only ? { kind: "at", stage: only } : { kind: "none" };
}

/**
 * Where a listed node is, asked of the node alone — what a status row, the
 * board and a notification can know without building a snapshot per item.
 *
 * `run.stage` is the label's stage, which is what a snapshot derives it from,
 * so every default identity places an item exactly as `locate` would; an
 * identity reading the node places it whatever its labels say. Both are
 * asked, and two matches — a label saying one stage while an identity says
 * another — are ambiguous, as they are to `locate`: neither is believed.
 *
 * An identity reading anything else — a step's output, a counter, a
 * relation — cannot be judged here, so it abstains rather than guesses. It
 * gives way to an identity that could be judged and matched. Where none did,
 * the answer is unknown, and the label's stage, when it is one of those that
 * abstained, is the best a node can say: it is what the engine wrote when it
 * last moved the item. A label's stage whose own identity was judged and said
 * no is not fallen back to — that would be believing a label the stage itself
 * refuses.
 */
export function locateNode(w: Workflow, node: Node): Location {
  const { stage, ambiguous, found } = stageFromLabels(labelsOf(node));
  // Two positions, which the engine halts on before it locates anything.
  if (ambiguous) return { kind: "ambiguous", ids: found };
  // The node and run.stage, and nothing else: so a path it lacks is one a
  // node cannot answer — anything outside both, or a field this node does not
  // carry — and the identity reading it abstains before it is evaluated.
  const snapshot: Snapshot = { node, run: { stage } as Run };

  const matched: Stage[] = [];
  const abstained: Stage[] = [];
  for (const candidate of w.stages) {
    const identity = identityOf(candidate);
    if (missingPaths(identity, snapshot).length > 0) abstained.push(candidate);
    else if (compile(identity)(snapshot)) matched.push(candidate);
  }
  if (matched.length > 1) return { kind: "ambiguous", ids: matched.map((m) => m.id) };
  const [only] = matched;
  if (only) return { kind: "at", stage: only };
  const labelled = abstained.find((candidate) => candidate.id === stage);
  return labelled ? { kind: "at", stage: labelled } : { kind: "none" };
}
