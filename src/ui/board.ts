import { compareWork, isOpenTicket, isTicketId, TICKET_KIND } from "#conventions.js";
import { oneLine, statusRows } from "#runner/status.js";
import { chatFor } from "#ui/chat.js";
import { systemOf } from "#ui/systems.js";
import type {
  Board, BoardRow, BoardView, Graph, Held, LandraceEvent, Lane, Node, Running, StatusRow, Workflow,
} from "#namespace.js";

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

/** How many facts a summary carries after open/done/dropped — a one-liner, not a report. */
const SUMMARY_FACTS = 4;

/**
 * A node's scalar state as one line: open/done/dropped, then each flag that is
 * true and each count that is not zero, in key order so the same node always
 * reads the same. Strings are left out on purpose — they are whatever a remote
 * system called something, and a summary is not the place to print it.
 */
export function summaryOf(node: Node): string {
  const facts: string[] = [];
  for (const key of Object.keys(node.state).sort()) {
    const value = node.state[key];
    if (value === true) facts.push(key);
    else if (typeof value === "number" && Number.isFinite(value) && value !== 0) facts.push(`${key} ${value}`);
  }
  return oneLine([node.closed ?? "open", ...facts.slice(0, SUMMARY_FACTS)].join(" · "));
}

const wantsAttention = (row: BoardRow): boolean => row.badge === "needs-you" || row.badge === "running";

/**
 * Which node each node nests under, if exactly one. Only edges of a type the
 * source declares singular count, and only to a node that is in the graph —
 * a parent outside it leaves the child a root rather than lost.
 *
 * A node whose singular edges name two different parents is a root too,
 * whether the two edges share a type (a graph the engine itself refuses) or
 * not (a pull request that is child-of one ticket and implements another).
 * Picking one would be first-match-wins by another name. Two edges of
 * different types that agree on the parent are one parent.
 */
function parentsOf(graph: Graph, nodes: ReadonlyMap<string, Node>, nest: ReadonlySet<string>): Map<string, string> {
  const targets = new Map<string, Set<string>>();
  for (const r of graph.relationships) {
    if (!nest.has(r.type) || !nodes.has(r.from) || !nodes.has(r.to)) continue;
    const set = targets.get(r.from) ?? new Set<string>();
    set.add(r.to);
    targets.set(r.from, set);
  }
  const parent = new Map<string, string>();
  for (const [id, set] of targets) {
    const [only, ...more] = set;
    if (only !== undefined && more.length === 0) parent.set(id, only);
  }
  return parent;
}

export function boardView(input: {
  workflow: Workflow;
  graph: Graph;
  /** Relation types the source declares singular — the only edges that nest. */
  nest: ReadonlySet<string>;
  listedAt: number | null;
  running: ReadonlyMap<string, Running>;
  elsewhere: ReadonlyMap<string, Held>;
  now: number;
  pid: number;
  nextTickAt: number | null;
  folder: string;
  workspace: string;
}): BoardView {
  // Duplicate ids are a graph the engine halts on elsewhere; here the page
  // only has to stay drawable, so a repeat is skipped rather than drawn twice.
  const nodes = new Map<string, Node>();
  for (const node of input.graph.nodes) if (!nodes.has(node.id)) nodes.set(node.id, node);

  const tickets = [...nodes.values()].filter((n) => n.kind === TICKET_KIND);
  const status = new Map<string, StatusRow>(statusRows(input.workflow, tickets).map((s) => [s.ticket, s]));

  const rowOf = (node: Node): BoardRow => {
    const link = safeUrl(node.link);
    const base: BoardRow = {
      id: node.id, kind: node.kind, title: oneLine(node.title), link,
      system: link ? systemOf(link) : null,
      badge: null, stage: null, priority: node.priority, closed: node.closed,
      summary: summaryOf(node), note: "", since: null, round: null, model: null,
      chat: null, expanded: false, children: [],
    };
    const s = status.get(node.id);
    if (node.kind !== TICKET_KIND || !s) return base;

    // Built from the ticket id and the workspace path alone — never title or
    // note — so nothing a tracker comment injected can ride along into a
    // link the browser is about to open.
    // An id chatFor refuses costs that row its Chat menu, not the page: one
    // throw here blanked every row of the board.
    const ticket: BoardRow = { ...base, stage: s.stage, note: oneLine(s.note), chat: isTicketId(node.id) ? chatFor(node.id, input.workspace) : null };
    // A closed ticket is out of the loop whatever its labels still say or a
    // stale event claims: it never asks for you, and never opens a parent —
    // and its note says it is closed, not "blocked: needs a human" from a
    // label nobody took off.
    if (node.closed !== null) return { ...ticket, badge: "discharged", note: node.closed === "done" ? "closed" : "dropped" };
    const running = input.running.get(node.id);
    if (running) {
      return { ...ticket, badge: "running", stage: running.stage, note: "agent running",
        since: running.since, round: running.round, model: running.model };
    }
    const lock = input.elsewhere.get(node.id);
    if (lock && lock.pid !== input.pid) {
      // Held.at is when the holder last said it was still working, not when
      // it started (see the doc comment on Held in src/namespace.ts) —
      // withLock refreshes it every deadlineMs/4, so it sawtooths rather than
      // answering BoardRow.since ("when the current state began"). Nothing
      // else tells us when a foreign hold began, so this reports null rather
      // than a wrong clock.
      return { ...ticket, badge: "elsewhere", note: `held by ${lock.kind} (pid ${lock.pid})` };
    }
    return { ...ticket, badge: laneOf(s, input.workflow) };
  };

  const parent = parentsOf(input.graph, nodes, input.nest);
  const children = new Map<string, Node[]>();
  const roots: Node[] = [];
  for (const node of nodes.values()) {
    const up = parent.get(node.id);
    if (up === undefined) roots.push(node);
    else children.set(up, [...(children.get(up) ?? []), node]);
  }

  // `seen` is the cycle guard: a node is drawn once, under the first path that
  // reaches it, and a cycle stops instead of recursing forever.
  const seen = new Set<string>();
  const build = (node: Node): BoardRow | null => {
    if (seen.has(node.id)) return null;
    seen.add(node.id);
    const kids = [...(children.get(node.id) ?? [])].sort(compareWork)
      .map(build).filter((r): r is BoardRow => r !== null);
    return { ...rowOf(node), children: kids, expanded: kids.some((k) => wantsAttention(k) || k.expanded) };
  };

  const rows: BoardRow[] = [];
  // Roots first; then whatever a cycle left unreached — every member of a
  // cycle has a parent, so none of them was a root — at the top level rather
  // than lost. Both in work order, so the same graph always draws the same.
  for (const node of [...roots.sort(compareWork), ...[...nodes.values()].sort(compareWork)]) {
    const row = build(node);
    if (row) rows.push(row);
  }

  return {
    generatedAt: input.now, listedAt: input.listedAt, rows, nextTickAt: input.nextTickAt,
    folder: input.folder, workspace: input.workspace,
  };
}

/**
 * The stateful shell around boardView. Holds only what the process already
 * knew — the last graph and which agents are running — so losing it loses
 * nothing: the next tick rebuilds it. Nothing here ever feeds a decision.
 */
export function createBoard(opts: {
  workflow: Workflow;
  held: (ticket: string) => Promise<Held | null>;
  now?: () => number;
  pid?: number;
  /** When the next scheduled tick is due — the schedule's own `nextAt`. */
  nextTickAt?: () => number | null;
  /** The repository checkout's own name — the header chip. */
  folder: string;
  /** The absolute path of the repository checkout landrace is running in. */
  workspace: string;
  /** The relation types the source declares singular — what the tree nests along. */
  nest: readonly string[];
}): Board {
  const now = opts.now ?? Date.now;
  const pid = opts.pid ?? process.pid;
  const nextTickAt = opts.nextTickAt ?? (() => null);
  const nest = new Set(opts.nest);
  let graph: Graph = { nodes: [], relationships: [] };
  let listedAt: number | null = null;
  const running = new Map<string, Running>();

  return {
    observe(e: LandraceEvent): void {
      if (typeof e.ticket !== "string") return;
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
    list(next: Graph): void {
      graph = next;
      listedAt = now();
    },
    async view(): Promise<BoardView> {
      // Open tickets only: nothing else can be held, and a closed ticket's
      // badge ignores the lock anyway.
      const elsewhere = new Map<string, Held>();
      await Promise.all(graph.nodes.filter(isOpenTicket).map(async (n) => {
        const h = await opts.held(n.id);
        if (h) elsewhere.set(n.id, h);
      }));
      return boardView({
        workflow: opts.workflow, graph, nest, listedAt, running, elsewhere, now: now(), pid,
        nextTickAt: nextTickAt(), folder: opts.folder, workspace: opts.workspace,
      });
    },
  };
}
