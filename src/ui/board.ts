import { oneLine, statusRows } from "#runner/status.js";
import type {
  Board, BoardRow, BoardView, Candidate, Held, LandraceEvent, Lane, Running, StatusRow, Workflow,
} from "#namespace.js";

/** Display order. The page renders lanes in exactly this order. */
const ORDER: readonly Lane[] = ["needs-you", "running", "elsewhere", "waiting", "not-admitted", "discharged"];

/**
 * Where a ticket belongs, from what `landrace status` already says about it.
 * Reusing statusRows rather than re-reading labels here is deliberate: two
 * readers of the same labels is how a status table and a page come to
 * disagree about one ticket.
 */
export function laneOf(row: StatusRow, workflow: Workflow): Lane {
  if (row.note.startsWith("skipped:")) return "not-admitted";
  if (row.note.startsWith("halted:") || row.note.startsWith("blocked") || row.note === "waiting on you") return "needs-you";
  const terminal = workflow.stages.some((s) => s.id === row.stage && s.terminal === true);
  return terminal ? "discharged" : "waiting";
}

const safeUrl = (url: string): string => (/^https?:\/\//i.test(url) ? url : "");

export function boardView(input: {
  workflow: Workflow;
  candidates: Candidate[];
  listedAt: number | null;
  running: ReadonlyMap<number, Running>;
  elsewhere: ReadonlyMap<number, Held>;
  now: number;
  pid: number;
}): BoardView {
  const urls = new Map(input.candidates.map((c) => [c.ticket, c.url]));
  const rows: BoardRow[] = statusRows(input.workflow, input.candidates).map((status): BoardRow => {
    const base = {
      ticket: status.ticket,
      title: oneLine(status.title),
      url: safeUrl(urls.get(status.ticket) ?? ""),
      stage: status.stage,
      note: oneLine(status.note),
      since: null, round: null, model: null,
    };
    const running = input.running.get(status.ticket);
    if (running) {
      return { ...base, lane: "running", stage: running.stage, note: "agent running",
        since: running.since, round: running.round, model: running.model };
    }
    const lock = input.elsewhere.get(status.ticket);
    if (lock && lock.pid !== input.pid) {
      // Held.at is when the holder last said it was still working, not when
      // it started (see the doc comment on Held in src/namespace.ts) —
      // withLock refreshes it every deadlineMs/4, so it sawtooths between 0
      // and that refresh interval rather than answering BoardRow.since
      // ("when the current state began"). Nothing else tells us when a
      // foreign hold began, so this reports null rather than a wrong clock.
      return { ...base, lane: "elsewhere", note: `held by ${lock.kind} (pid ${lock.pid})`, since: null };
    }
    return { ...base, lane: laneOf(status, input.workflow) };
  });
  rows.sort((a, b) => ORDER.indexOf(a.lane) - ORDER.indexOf(b.lane) || a.ticket - b.ticket);
  return { generatedAt: input.now, listedAt: input.listedAt, rows };
}

/**
 * The stateful shell around boardView. Holds only what the process already
 * knew — the last list and which agents are running — so losing it loses
 * nothing: the next tick rebuilds it. Nothing here ever feeds a decision.
 */
export function createBoard(opts: {
  workflow: Workflow;
  held: (ticket: number) => Promise<Held | null>;
  now?: () => number;
  pid?: number;
}): Board {
  const now = opts.now ?? Date.now;
  const pid = opts.pid ?? process.pid;
  let candidates: Candidate[] = [];
  let listedAt: number | null = null;
  const running = new Map<number, Running>();

  return {
    observe(e: LandraceEvent): void {
      if (typeof e.ticket !== "number") return;
      if (e.name === "step.started") {
        running.set(e.ticket, {
          stage: String(e.stage ?? ""),
          round: typeof e.round === "number" ? e.round : 0,
          model: typeof e.model === "string" ? e.model : null,
          since: now(),
        });
      } else if (e.name === "step.finished") {
        running.delete(e.ticket);
      }
    },
    list(next: Candidate[]): void {
      candidates = next;
      listedAt = now();
    },
    async view(): Promise<BoardView> {
      const elsewhere = new Map<number, Held>();
      await Promise.all(candidates.map(async (c) => {
        const h = await opts.held(c.ticket);
        if (h) elsewhere.set(c.ticket, h);
      }));
      return boardView({ workflow: opts.workflow, candidates, listedAt, running, elsewhere, now: now(), pid });
    },
  };
}
