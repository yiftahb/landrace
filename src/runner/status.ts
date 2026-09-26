import { compareIds, LABELS, labelsOf, stageFromLabels } from "#conventions.js";
import type { Node, StatusRow, Workflow } from "#namespace.js";
import { eligibilityOf } from "#runner/tick.js";

/** Stands in for a ticket that has no position yet, so the column still lines up. */
const NO_STAGE = "—";

/** Wide enough for a real issue title, narrow enough that the note stays on screen. */
const TITLE_WIDTH = 40;

/**
 * One line of text, with nothing in it that could have been meant for the
 * terminal rather than for the reader.
 *
 * A title is whoever opened the ticket; a reason can carry an agent's own
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
 * The two ways a row says a ticket is stopped for a person, named so the page
 * can tell them apart without reading the labels a second time. Both start
 * "blocked", which is what files either one under Needs you.
 */
export const BLOCKED_NOTE = "blocked: needs a human";
export const SCREENED_NOTE = "blocked by a security check";

const clip = (text: string, width: number): string =>
  text.length > width ? `${text.slice(0, width - 1)}…` : text;

/**
 * One line per listed ticket, including the ones that were skipped and why.
 * Eligibility being a decision rather than a query filter is what makes a
 * skipped ticket visible instead of absent.
 */
export function statusLines(rows: StatusRow[]): string[] {
  const stageOf = (row: StatusRow): string => row.stage ?? NO_STAGE;
  const titles = rows.map((row) => clip(oneLine(row.title), TITLE_WIDTH));

  const ticketWidth = Math.max(0, ...rows.map((row) => String(row.ticket).length));
  const stageWidth = Math.max(0, ...rows.map((row) => stageOf(row).length));
  const titleWidth = Math.max(0, ...titles.map((title) => title.length));

  return rows.map(
    (row, i) =>
      `#${String(row.ticket).padEnd(ticketWidth)}  ${stageOf(row).padEnd(stageWidth)}  ` +
      `${(titles[i] ?? "").padEnd(titleWidth)}  ${oneLine(row.note)}`,
  );
}

/**
 * One row per ticket node, answered from the labels the source already carried
 * back — no snapshot per ticket, which would mean reading every issue in the
 * repository to print a table.
 *
 * The order the questions are asked in is the tick's own: eligibility first,
 * because a ticket the workflow does not claim is not ours to have an opinion
 * about, and then position — where two stage labels means the ticket cannot be
 * placed at all.
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
export function statusRows(workflow: Workflow, tickets: Node[]): StatusRow[] {
  // In id order, as the tick's own rows are: the same repository in the same
  // state prints the same table, whatever order the source listed it in.
  return [...tickets].sort((a, b) => compareIds(a.id, b.id)).map((node) => {
    const eligibility = eligibilityOf(workflow, node);
    const labels = labelsOf(node);
    const { stage, ambiguous, found } = stageFromLabels(labels);
    const row = { ticket: node.id, title: node.title };

    // The workflow's own `else`, never a label name of this file's choosing:
    // what "eligible" means belongs to the workflow, and a second copy of that
    // rule here is how a status table and an engine come to disagree.
    if (!eligibility.eligible) return { ...row, stage, note: `skipped: ${eligibility.reason}` };
    // Which ones, because taking one of them off is the fix and an operator
    // reading a table cannot see the labels from here.
    if (ambiguous) return { ...row, stage: null, note: `halted: more than one lr:stage:* label (${found.join(", ")})` };

    // Screened before blocked: a screened ticket wears both, and the more
    // specific reason is the one a person can act on.
    const note = labels.includes(LABELS.screened)
      ? SCREENED_NOTE
      : labels.includes(LABELS.blocked)
        ? BLOCKED_NOTE
        : labels.includes(LABELS.awaiting)
          ? "waiting on you"
          : labels.includes(LABELS.working)
            ? "working"
            : "queued";
    return { ...row, stage, note };
  });
}
