import { compareIds, isOpenItem, LABELS, labelsOf, stageFromLabels } from "#conventions.js";
import { cannotPlace, locateNode, UNPLACED } from "#core/index.js";
import type { Lane, ListedWorkflow, Node, NodeLocation, StatusRow, Workflow, WorkspaceListing } from "#namespace.js";
import { messageOf } from "#runner/errors.js";
import { claimedBy, eligibilityOf, reportedBy, turnedAway } from "#runner/tick.js";

/** Stands in for an item that has no position yet, so the column still lines up. */
const NO_STAGE = "—";

/** Wide enough for a real issue title, narrow enough that the note stays on screen. */
const TITLE_WIDTH = 40;

/**
 * One line of text, with nothing in it that could have been meant for the
 * terminal rather than for the reader.
 *
 * A title is whoever opened the item; a reason can carry an agent's own
 * words. Both reach a line a person reads to decide what the loop is doing, so
 * a newline would let them print a row of their own and an escape sequence
 * would let them repaint the ones above it. C0 and C1 controls both go: the
 * eight-bit CSI (U+009B) starts a sequence on its own, without an ESC in front
 * of it.
 */
export function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The two ways a row says an item is stopped for a person, named so the page
 * can tell them apart without reading the labels a second time. Both start
 * "blocked", which is what files either one under Needs you.
 */
export const BLOCKED_NOTE = "blocked: needs a human";
export const SCREENED_NOTE = "blocked by a security check";

/**
 * Where an item belongs, from what `landrace status` already says about it.
 * Reusing statusRows rather than re-reading labels here is deliberate: two
 * readers of the same labels is how a status table and a page come to
 * disagree about one item. Here rather than beside the board because the
 * runner's notify asks the same question, and must get the page's answer.
 */
export function laneOf(row: StatusRow, workflow: Workflow): Lane {
  if (row.note.startsWith("skipped:")) return "not-admitted";
  if (row.note.startsWith("halted:") || row.note.startsWith("blocked") || row.note === "waiting on you") return "needs-you";
  const terminal = workflow.stages.some((s) => s.id === row.stage && s.terminal === true);
  return terminal ? "discharged" : "waiting";
}

const clip = (text: string, width: number): string =>
  text.length > width ? `${text.slice(0, width - 1)}…` : text;

/**
 * An item's id, and its workflow beside it — `12 [fast]` — where the
 * workspace has several to tell apart; with one, `[main]` on every line is
 * noise. What `landrace status` and `landrace start` both print.
 */
export const itemTag = (item: string, workflow: string | undefined, several: boolean): string =>
  `${item}${several && workflow !== undefined ? ` [${workflow}]` : ""}`;

/**
 * One line per listed item, including the ones that were skipped and why.
 * Eligibility being a decision rather than a query filter is what makes a
 * skipped item visible instead of absent. `several`: the workspace has more
 * than one workflow, so each line names its own.
 */
export function statusLines(rows: StatusRow[], opts: { several?: boolean } = {}): string[] {
  const stageOf = (row: StatusRow): string => row.stage ?? NO_STAGE;
  const itemOf = (row: StatusRow): string => itemTag(row.item, row.workflow, opts.several ?? false);
  const titles = rows.map((row) => clip(oneLine(row.title), TITLE_WIDTH));

  const itemWidth = Math.max(0, ...rows.map((row) => itemOf(row).length));
  const stageWidth = Math.max(0, ...rows.map((row) => stageOf(row).length));
  const titleWidth = Math.max(0, ...titles.map((title) => title.length));

  return rows.map(
    (row, i) =>
      `#${itemOf(row).padEnd(itemWidth)}  ${stageOf(row).padEnd(stageWidth)}  ` +
      `${(titles[i] ?? "").padEnd(titleWidth)}  ${oneLine(row.note)}`,
  );
}

/**
 * One row per item node, answered from what the source already carried back
 * — no snapshot per item, which would mean reading every issue in the
 * repository to print a table.
 *
 * The order the questions are asked in is the tick's own: eligibility first,
 * because an item the workflow does not claim is not ours to have an opinion
 * about, and then position — where two stage labels, or a label and an
 * identity naming two stages, means the item cannot be placed at all.
 *
 * Position is the stage `locateNode` finds, not only the label: a stage can
 * place an item by its own state, and whose turn it is is that stage's
 * `waits`, never `lr:awaiting` — a workflow that writes nothing still says an
 * item is waiting on you. Blocked and screened are still read off the
 * `lr:blocked` and `lr:screened` labels — which the engine never writes: the
 * workflow's halts do, in their own `on_enter`, and `validate`'s `halt-labels`
 * rule holds a stage entered on a failed round to writing them.
 *
 * This used to say that naming the first of the two "would print a position
 * the engine itself refuses to believe". The engine believed it and spent
 * money on it: `stageFromLabels` returned `found[0]` whatever its own
 * `ambiguous` flag said, and buildSnapshot — the one caller that acts — read
 * only the stage. The engine now halts on the same fact this row reports, so
 * the sentence is true and the two surfaces finally agree.
 *
 * Lives beside statusLines rather than in cli/status.ts so that ui/board.ts
 * can reuse it without importing the cli layer — cli/start.ts -> ui/board.ts
 * -> cli/status.ts -> cli/start.ts was a real cycle, latent only because
 * nothing used the other end at module top level.
 */
export function statusRows(workflow: Workflow, items: Node[]): StatusRow[] {
  // In id order, as the tick's own rows are: the same repository in the same
  // state prints the same table, whatever order the source listed it in.
  return [...items].sort((a, b) => compareIds(a.id, b.id)).map((node) => {
    const eligibility = eligibilityOf(workflow, node);
    const labels = labelsOf(node);
    const { stage: labelled, ambiguous, found } = stageFromLabels(labels);
    const row = { item: node.id, title: node.title };

    // The workflow's own `else`, never a label name of this file's choosing:
    // what "eligible" means belongs to the workflow, and a second copy of that
    // rule here is how a status table and an engine come to disagree.
    if (!eligibility.eligible) return { ...row, stage: labelled, note: `skipped: ${eligibility.reason}` };
    // Which ones, because taking one of them off is the fix and an operator
    // reading a table cannot see the labels from here.
    if (ambiguous) return { ...row, stage: null, note: `halted: more than one lr:stage:* label (${found.join(", ")})` };
    let where: NodeLocation;
    try {
      where = locateNode(workflow, node);
    } catch (e) {
      // An identity that throws — an operator the allowlist refuses — is this
      // row's error, as it is this item's in the tick: thrown, it blanked the
      // whole board.
      return { ...row, stage: null, note: `error: ${messageOf(e)}` };
    }
    // In decide's own words, since it halts on the same fact.
    if (where.kind === "ambiguous") return { ...row, stage: null, note: `halted: ${cannotPlace(where.ids)}` };
    // Every identity judged and none placing it, no label, and no entry stage
    // to start it at: decide halts it on every tick. Read as queued, it sat
    // under Waiting at no stage for good, and only the log said why.
    if (where.kind === "none" && found.length === 0 && !workflow.stages.some((s) => s.entry)) {
      return { ...row, stage: null, note: `halted: ${UNPLACED}` };
    }
    const stage = where.kind === "at" ? where.stage : null;

    // Screened before blocked: a screened item wears both, and the more
    // specific reason is the one a person can act on. A stage that waits on a
    // person is asked about before lr:working, because a crash between a
    // stage's status and its label effect can leave the previous stage's
    // lr:working on an item that is now waiting on you.
    const note = labels.includes(LABELS.screened)
      ? SCREENED_NOTE
      : labels.includes(LABELS.blocked)
        ? BLOCKED_NOTE
        : stage?.waits === "person"
          ? "waiting on you"
          : labels.includes(LABELS.working)
            ? "working"
            : "queued";
    return { ...row, stage: stage?.id ?? null, note };
  });
}

/**
 * One row per open item every workflow's source listed: an owned item as its
 * owner's `statusRows` places it, with the workflow beside it; one two
 * workflows claim, or two sources report, halted and naming them; one every
 * workflow turned away skipped, with each reason once.
 */
export function workspaceStatusRows(workflows: readonly ListedWorkflow[], listing: Pick<WorkspaceListing, "graphs" | "claims">): StatusRow[] {
  const listed = new Map<string, Node[]>();
  for (const node of listing.graphs.flatMap((g) => g.nodes)) {
    if (isOpenItem(node)) listed.set(node.id, [...(listed.get(node.id) ?? []), node]);
  }
  const { claims } = listing;
  return [...listed].sort(([a], [b]) => compareIds(a, b)).flatMap(([item, nodes]): StatusRow[] => {
    const [node] = nodes;
    if (!node) return [];
    const owner = claims.owner.get(item);
    const workflow = owner === undefined ? undefined : workflows.find((w) => w.id === owner);
    if (owner !== undefined && workflow) return statusRows(workflow.deps.workflow, [node]).map((row) => ({ ...row, workflow: owner }));
    // Two sources' nodes may be two different items: each title, once.
    const title = [...new Set(nodes.map((n) => n.title))].join(" | ");
    const clash = claims.clashes.get(item);
    if (clash) return [{ item, title, stage: null, note: `halted: ${reportedBy(clash)}` }];
    const conflict = claims.conflicts.get(item);
    if (conflict) return [{ item, title, stage: null, note: `halted: ${claimedBy(conflict)}` }];
    const reasons = claims.unclaimed.get(item) ?? [];
    return [{ item, title, stage: stageFromLabels(labelsOf(node)).stage, note: `skipped: ${turnedAway(reasons)}` }];
  });
}
