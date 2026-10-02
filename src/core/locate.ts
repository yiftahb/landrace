import { labelsOf, stageFromLabels } from "#conventions.js";
import { compile, missingPaths, pathsIn } from "#core/predicate.js";
import type { Location, Node, NodeLocation, Run, Snapshot, Stage, Workflow } from "#namespace.js";

/**
 * Default identity: you are here if the tracker says so.
 * Exported so workflow/validate.ts checks the same definition locate() uses
 * to place an item — two copies of this default previously let the
 * validator and the engine silently disagree about where an item is.
 */
export const identityOf = (stage: Stage) => stage.identity ?? { "run.stage": stage.id };

/**
 * Whether an item's own state places it at this stage: a custom identity
 * reading only the item's own fields (`node.*`). An item is there because its
 * labels say so, not because a transition took it there, and it leaves when
 * they stop saying so.
 *
 * Anything the engine writes disqualifies it: a counter or an output is there
 * only once a step ran, and a `run.stage` naming a stage is a position only a
 * transition writes. Read as placement by state, each let a stage nothing can
 * reach or leave validate clean. The one position allowed is
 * `"run.stage": null` at the top — an item nothing has been written to.
 *
 * Its relations (`rel.*`) are the tracker's too, and still do not count: the
 * board, a notification and the MCP place an item from the listed node alone
 * (`locateNode`), which carries no relations, so a stage only they placed an
 * item at showed it nowhere — queued, at no stage, never told — while the
 * engine waited on it there. Such a stage needs an entry stage beside it.
 */
export function placedByState(stage: Stage): boolean {
  const identity = stage.identity;
  if (identity === undefined) return false;
  const paths = pathsIn(identity);
  const own = (path: string): boolean => path.startsWith("node.");
  return paths.some(own) && paths.every((path) => own(path) || (path === "run.stage" && identity["run.stage"] === null));
}

/**
 * Whether a workflow can never write to its tracker: every open stage is
 * placed by the item's own state, and none runs a step, fires a trigger or
 * applies an `on_enter`. Its tracker would refuse every write the board
 * could offer on such an item, so the board offers none.
 */
export const writesNothing = (w: Workflow): boolean =>
  w.stages.every(
    (s) =>
      (s.terminal === true || placedByState(s)) &&
      s.step === undefined && (s.triggers ?? []).length === 0 && (s.on_enter ?? []).length === 0,
  );

/**
 * Why an item several stages match cannot be placed, in the words every
 * surface says it in: decide's halt, a status row, `landrace_status`. Two
 * wordings of one halt is how an operator comes to think they are two.
 */
export const cannotPlace = (ids: readonly string[]): string => `cannot place the item: ${ids.join(", ")} all match`;

/**
 * Why an item no stage places cannot be worked by a workflow with no entry
 * stage to start it at — decide's halt and a status row, in one wording, as
 * `cannotPlace` is for the opposite case.
 */
export const UNPLACED =
  "no stage of this workflow places the item: none of its identities match, and there is no entry stage to start it at";

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
 * `run.stage` is the label's stage, which is what a snapshot derives it from
 * — read again from an identity's stage only where the item has no label and
 * that leaves it where it was (`locatedRun`) — so every default identity
 * places an item exactly as `locate` would; an identity reading the node
 * places it whatever its labels say. Both are asked, and two matches — a
 * label saying one stage while an identity says another — are ambiguous, as
 * they are to `locate`: neither is believed.
 *
 * An identity reading anything else — a step's output, a counter, a
 * relation — cannot be judged here, so it abstains rather than guesses. It
 * gives way to an identity that could be judged and matched. Where none did,
 * the answer is unknown, and the label's stage, when it is one of those that
 * abstained, is the best a node can say: it is what the engine wrote when it
 * last moved the item. A label's stage whose own identity was judged and said
 * no is not fallen back to — that would be believing a label the stage itself
 * refuses.
 *
 * No stage is two answers: `none` when every identity was judged and said
 * no, `abstained` when one could not be judged. Only the first is known.
 */
export function locateNode(w: Workflow, node: Node): NodeLocation {
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
  if (labelled) return { kind: "at", stage: labelled };
  return abstained.length > 0 ? { kind: "abstained" } : { kind: "none" };
}
