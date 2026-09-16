export interface StatusRow {
  ticket: number;
  title: string;
  stage: string | null;
  note: string;
}

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

const clip = (text: string, width: number): string =>
  text.length > width ? `${text.slice(0, width - 1)}…` : text;

/**
 * One line per candidate ticket, including the ones that were skipped and why.
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
