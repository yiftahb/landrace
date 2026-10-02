import { compareIds, compareWork, GOTO_TRIGGER, isOpenItem, isItemId, ITEM_KIND, labelsOf, stageFromLabels } from "#conventions.js";
import { claimItems, eligibilityOfNode, gotoTargetsOf, writesNothing } from "#core/index.js";
import { BLOCKED_NOTE, laneOf, oneLine, SCREENED_NOTE, statusRows } from "#runner/status.js";
import { haltOf, readRoute, writeRoute } from "#runner/route.js";
import { turnedAway } from "#runner/tick.js";
import { chatFor } from "#ui/chat.js";
import { systemOf } from "#ui/systems.js";
import type {
  Board, BoardRow, BoardView, ConversationLine, Entry, Graph, Held, LandraceEvent, Lane, Node, Ownership, Pairing,
  PanelPaths, ReadRoute, Relationship, Running, Stage, StatusRow, Workflow, WorkspaceListing,
} from "#namespace.js";

/**
 * Every listed graph as one, for the one page: each node once by id, each
 * edge once. An id one source has open and another closed is drawn from the
 * open node: claims are for open items, so that is the node its owner was
 * judged by — the closed one said "closed" over an agent running on it. An
 * id two sources both have open is a clash nobody works; which of its two
 * nodes is drawn is display only, and its row says it is a clash.
 */
function unionOf(graphs: readonly Graph[]): Graph {
  const nodes = new Map<string, Node>();
  const edges = new Map<string, Relationship>();
  for (const graph of graphs) {
    for (const node of graph.nodes) {
      const drawn = nodes.get(node.id);
      if (!drawn || (drawn.closed !== null && node.closed === null)) nodes.set(node.id, node);
    }
    for (const edge of graph.relationships) edges.set(JSON.stringify([edge.from, edge.to, edge.type]), edge);
  }
  return { nodes: [...nodes.values()], relationships: [...edges.values()] };
}

const safeUrl = (url: string): string => (/^https?:\/\//i.test(url) ? url : "");

/**
 * Whether this row offers a Retry: the item is blocked or screened right
 * now. A Retry is a goto with no step named — the step whose failure put
 * the item there — and this is only the board's own offer; `sendTo`
 * re-reads the item and is the one authority on whether a given send is
 * actually taken.
 */
const stopped = (row: StatusRow): boolean => row.note === BLOCKED_NOTE || row.note === SCREENED_NOTE;

/** The path the page posts a Retry to — built here, from an id already checked, never by the page. */
const retryPath = (id: string): string | null => (isItemId(id) ? `/items/${id}/retry` : null);

/** And a Clear & retry, which only a screened item is offered: `sendTo` refuses it anywhere else. */
const clearPath = (id: string): string | null => (isItemId(id) ? `/items/${id}/clear` : null);

/**
 * Where the page posts a "Go to step…" — one path per step the item's
 * stage may send it to, built here from an id already checked and a stage
 * the workflow names, never by the page.
 *
 * Offered whether or not the stage runs a step: the board only has labels,
 * not records, so it cannot tell a judge whose round is settled from one
 * whose step is still owed the way `sendTo` can — restricting this to a
 * stepless stage would hide "Go to step…" from exactly the settled judge a
 * person needs it for, and from the item a crash stranded between a
 * target's entry comment and its status label. `sendTo` stays the one
 * authority: it re-reads the item and refuses an owed step in a sentence.
 */
const gotoPaths = (id: string, stage: Stage | undefined): BoardRow["goto"] =>
  stage !== undefined && isItemId(id)
    ? gotoTargetsOf(stage).map((g) => ({ stage: g.stage, path: `/items/${id}/goto/${encodeURIComponent(g.stage)}` }))
    : [];

/**
 * Where an item's panel reads and writes — built here, from an id already
 * checked, never by the page. Only an item one workflow owns is written to,
 * so only its panel names the writes; every other item's only reads — and an
 * id two trackers report not even that: its reads refuse it, in the sentence
 * the page shows.
 */
const panelPaths = (id: string, writes: boolean): PanelPaths | null => {
  if (!isItemId(id)) return null;
  const write = (what: string): string | null => (writes ? `/items/${id}/${what}` : null);
  return {
    activity: `/items/${id}/activity`, conversation: `/items/${id}/conversation`, pairing: `/items/${id}/pairing`,
    reply: write("reply"), ask: write("ask"), resolve: write("resolve"),
    pair: write("pair"), finish: write("finish"), release: write("release"),
  };
};

/**
 * An item's records as the panel's conversation: oldest first, only what
 * has something to read, ours as landrace's and a person's as whoever the
 * source says wrote it. Plain text — the page never renders it as markup.
 */
export function conversationOf(entries: readonly Entry[]): ConversationLine[] {
  return entries
    .filter((e) => typeof e.text === "string" && e.text.trim() !== "")
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .map((e) => {
      const author = (e.data as { author?: unknown } | undefined)?.author;
      return {
        at: e.at,
        by: e.byAgent ? "landrace" : typeof author === "string" && author !== "" ? author : "someone",
        byAgent: e.byAgent, stage: e.stage, kind: e.kind, round: e.round, text: e.text ?? "",
      };
    });
}

/** Most urgent first — the order a branch's lane cascades in. */
const URGENCY: readonly Lane[] = ["needs-you", "running", "elsewhere", "waiting", "not-admitted", "discharged"];

/** Whether `a` is more urgent than `b`; anything outranks no badge at all. */
const outranks = (a: Lane, b: Lane | null): boolean => b === null || URGENCY.indexOf(a) < URGENCY.indexOf(b);

const moreUrgent = (a: Lane | null, b: Lane | null): Lane | null => (a !== null && outranks(a, b) ? a : b);

/** Where a root row's lane is drawn: most urgent first. */
const rank = (row: BoardRow): number => (row.lane === null ? URGENCY.length : URGENCY.indexOf(row.lane));

/** Nulls last, whichever way the numbers run. */
const nullsLast = (a: number | null, b: number | null, dir: 1 | -1): number =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : dir * (a - b);

/**
 * How a lane reads, root rows and branches alike. Needs you is a queue:
 * priority, unprioritised last as in work order, then whoever has waited
 * longest. Every other lane is a feed: whatever moved last on top, priority
 * ignored. A row with no update time has no place in time, so it goes last;
 * the id settles the rest, as ids read.
 */
const laneOrder = (lane: Lane | null) => (a: BoardRow, b: BoardRow): number =>
  (lane === "needs-you"
    ? nullsLast(a.priority, b.priority, 1) || nullsLast(a.updatedAt, b.updatedAt, 1)
    : nullsLast(a.updatedAt, b.updatedAt, -1)) || compareIds(a.id, b.id);

/** A branch in its lane's order, at every depth. */
const inOrder = (row: BoardRow, order: (a: BoardRow, b: BoardRow) => number): BoardRow =>
  ({ ...row, children: row.children.map((k) => inOrder(k, order)).sort(order) });

/**
 * Which node each node nests under, if exactly one. Only edges of a type the
 * source declares singular count, and only to a node that is in the graph —
 * a parent outside it leaves the child a root rather than lost.
 *
 * A node whose singular edges name two different parents is a root too,
 * whether the two edges share a type (a graph the engine itself refuses) or
 * not (a pull request that is child-of one item and implements another).
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
  workflows: ReadonlyArray<{ id: string; workflow: Workflow }>;
  listing: Pick<WorkspaceListing, "graphs" | "claims" | "sourceOf">;
  /** Relation types the source declares singular — the only edges that nest. */
  nest: ReadonlySet<string>;
  running: ReadonlyMap<string, Running>;
  elsewhere: ReadonlyMap<string, Held>;
  now: number;
  pid: number;
  nextTickAt: number | null;
  folder: string;
  workspace: string;
  /**
   * Which stage a goto last sent each item to, per the tick's own events —
   * the same source `running` is read from, never re-derived from labels.
   * Read only to word the note while that item's agent is running now.
   */
  sent?: ReadonlyMap<string, string>;
  /** The pairing each item's latest evaluation said holds its step, per the tick's own events. */
  paired?: ReadonlyMap<string, Pairing>;
  /** Items whose labels in `graph` predate a step this process ran on them — each row's `stale`. */
  stale?: ReadonlySet<string>;
}): BoardView {
  const graph = unionOf(input.listing.graphs);
  // Duplicate ids are a graph the engine halts on elsewhere; here the page
  // only has to stay drawable, so a repeat is skipped rather than drawn twice.
  const nodes = new Map<string, Node>();
  for (const node of graph.nodes) if (!nodes.has(node.id)) nodes.set(node.id, node);
  const workflows = new Map(input.workflows.map((w) => [w.id, w.workflow]));

  const { claims, graphs, sourceOf } = input.listing;
  const listedBy = (id: string): string[] =>
    input.workflows.filter((w) => graphs[sourceOf.get(w.id) ?? -1]?.nodes.some((n) => n.id === id) ?? false).map((w) => w.id);
  const pagesOfNode = (node: Node): string[] => {
    if (node.kind !== ITEM_KIND) return listedBy(node.id);
    if (node.closed !== null) {
      // Claims judge open items only, so a closed one is placed by eligibility.
      const listing = listedBy(node.id);
      const admits = listing.filter((id) => {
        const w = workflows.get(id);
        return w !== undefined && eligibilityOfNode(w, node).eligible;
      });
      return admits.length > 0 ? admits : listing;
    }
    const owner = claims.owner.get(node.id);
    if (owner !== undefined) return [owner];
    return claims.conflicts.get(node.id) ?? claims.clashes.get(node.id) ?? listedBy(node.id);
  };

  const rowOf = (node: Node): BoardRow => {
    const link = safeUrl(node.link);
    const base: BoardRow = {
      id: node.id, kind: node.kind, title: oneLine(node.title), link,
      system: link ? systemOf(link) : null, workflow: null, tag: null,
      badge: null, lane: null, stage: null, priority: node.priority, closed: node.closed,
      note: "", since: null, createdAt: node.createdAt ?? null, updatedAt: node.updatedAt ?? null,
      round: null, model: null, effort: null,
      pages: [], chat: null, screened: false, stale: false, retry: null, clear: null, goto: [], panel: null, children: [],
    };
    if (node.kind !== ITEM_KIND) return base;

    // Built from the item id and the workspace path alone — never title or
    // note — so nothing a tracker comment injected can ride along into a
    // link the browser is about to open.
    // An id chatFor refuses costs that row its Chat menu, not the page: one
    // throw here blanked every row of the board.
    const item: BoardRow = {
      ...base, stage: stageFromLabels(labelsOf(node)).stage, panel: panelPaths(node.id, false), stale: input.stale?.has(node.id) ?? false,
      chat: isItemId(node.id) ? chatFor(node.id, input.workspace) : null,
    };
    // A closed item is out of the loop whatever its labels still say or a
    // stale event claims: it never asks for you, and never opens a parent —
    // and its note says it is closed, not "blocked: needs a human" from a
    // label nobody took off.
    if (node.closed !== null) return { ...item, badge: "discharged", note: node.closed === "done" ? "closed" : "dropped" };

    // Two workflows claiming it, or two trackers reporting its id, is the
    // news, said over whatever it is doing: the tick stops a run for exactly
    // this, and a pairing under one of the two is no longer that one's alone.
    const halt = haltOf(claims, node.id);
    // A clash's reads answer 409 (`readRoute` cannot tell which source to
    // ask), so its panel is withheld; a conflict has one source and keeps it.
    if (halt) return { ...item, badge: "needs-you", stage: null, note: oneLine(halt), panel: claims.clashes.has(node.id) ? null : item.panel };

    // Placed by the stages of the one workflow that owns it. An item no
    // workflow owns is placed by none: its note says why, and its row offers
    // nothing to act on — the page's writes would refuse it anyway, and an
    // offer here would be a guess at whose stages its labels mean.
    const owner = claims.owner.get(node.id);
    const workflow = owner === undefined ? undefined : workflows.get(owner);
    const [s] = workflow ? statusRows(workflow, [node]) : [];
    const placed: BoardRow = s && workflow
      ? {
          ...item, workflow: owner ?? null, tag: workflows.size > 1 ? workflow.name : null,
          stage: s.stage, note: oneLine(s.note), panel: panelPaths(node.id, !writesNothing(workflow)),
        }
      : { ...item, badge: "not-admitted", note: oneLine(`skipped: ${turnedAway(claims.unclaimed.get(node.id) ?? [])}`) };

    const running = input.running.get(node.id);
    if (running) {
      // A goto's target is only worth naming while the agent it sent is
      // still the one running — once the item moves on, "sent back to
      // spec" would be talking about a stage the item has already left.
      const note = input.sent?.get(node.id) === running.stage ? `agent running — sent back to ${running.stage}` : "agent running";
      return { ...placed, badge: "running", stage: running.stage, note,
        since: running.since, round: running.round, model: running.model, effort: running.effort };
    }
    const pairing = input.paired?.get(node.id);
    if (pairing) {
      // Held by a person, in their own session: since the pair record, which
      // — unlike a lock's heartbeat — is when the hold began.
      const began = Date.parse(pairing.at);
      return {
        ...placed, badge: "elsewhere", stage: pairing.stage, round: pairing.round,
        note: `Pairing — ${pairing.stage}, round ${pairing.round}`, since: Number.isNaN(began) ? null : began,
      };
    }
    const lock = input.elsewhere.get(node.id);
    if (lock && lock.pid !== input.pid) {
      // Held.at is when the holder last said it was still working, not when
      // it started (see the doc comment on Held in src/namespace.ts) —
      // withLock refreshes it every deadlineMs/4, so it sawtooths rather than
      // answering BoardRow.since ("when the current state began"). Nothing
      // else tells us when a foreign hold began, so this reports null rather
      // than a wrong clock.
      return { ...placed, badge: "elsewhere", note: `held by ${lock.kind} (pid ${lock.pid})` };
    }
    if (!s || !workflow) return placed;
    // A workflow that writes nothing has a tracker that refuses every write
    // a Retry, Clear or Go to would make, so the page must not offer one.
    if (writesNothing(workflow)) return { ...placed, badge: laneOf(s, workflow), retry: null, clear: null, goto: [] };
    const retry = stopped(s) ? retryPath(node.id) : null;
    const goto = gotoPaths(node.id, workflow.stages.find((x) => x.id === s.stage));
    // The status row's own verdict, not the labels read a second time; the
    // note is the page's wording of the same fact.
    if (s.note === SCREENED_NOTE) {
      return {
        ...placed, badge: laneOf(s, workflow), screened: true, note: SCREENED_NOTE, retry, clear: clearPath(node.id), goto,
      };
    }
    return { ...placed, badge: laneOf(s, workflow), retry, goto };
  };

  const parent = parentsOf(graph, nodes, input.nest);
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
  // The most urgent item badge in each drawn subtree, null where the subtree
  // holds no item. Only badges count: a closed item's is already
  // `discharged` whatever its labels say, and an artifact has none, so neither
  // can raise a branch.
  const below = new Map<string, Lane | null>();
  const pagesOf = new Map<string, string[]>();
  const build = (node: Node): BoardRow | null => {
    if (seen.has(node.id)) return null;
    seen.add(node.id);
    const kids = [...(children.get(node.id) ?? [])].sort(compareWork)
      .map(build).filter((r): r is BoardRow => r !== null);
    const row = rowOf(node);
    pagesOf.set(node.id, pagesOfNode(node));
    below.set(node.id, kids.map((k) => below.get(k.id) ?? null).reduce(moreUrgent, row.badge));
    return { ...row, children: kids };
  };

  const rows: BoardRow[] = [];
  // Roots first; then whatever a cycle left unreached — every member of a
  // cycle has a parent, so none of them was a root — at the top level rather
  // than lost. Both walked in work order, so the same graph always nests the
  // same; what the page reads is the lane's order, applied once each branch
  // knows its lane.
  for (const node of [...roots.sort(compareWork), ...[...nodes.values()].sort(compareWork)]) {
    const row = build(node);
    // A branch with no item — a pull request whose item is not listed —
    // is still drawn rather than lost, and nothing in it is anyone's to act
    // on: it waits while open and is done once closed.
    if (!row) continue;
    const lane = below.get(row.id) ?? (row.closed === null ? "waiting" : "discharged");
    const pages = new Set<string>();
    const gather = (r: BoardRow): void => {
      for (const p of pagesOf.get(r.id) ?? []) pages.add(p);
      r.children.forEach(gather);
    };
    gather(row);
    rows.push(inOrder({ ...row, lane, pages: [...pages].sort() }, laneOrder(lane)));
  }
  rows.sort((a, b) => rank(a) - rank(b) || laneOrder(a.lane)(a, b));

  const needing = rows.filter((r) => r.lane === "needs-you");
  const sidebar = input.workflows
    .map((w) => ({ id: w.id, name: w.workflow.name, needsYou: needing.filter((r) => r.pages.includes(w.id)).length }))
    .sort((a, b) => {
      const x = a.name.toLowerCase(), y = b.name.toLowerCase();
      return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  return {
    generatedAt: input.now, rows, nextTickAt: input.nextTickAt,
    folder: input.folder, workspace: input.workspace, workflows: sidebar, needsYou: needing.length,
  };
}

const unlisted = (item: string): Ownership => ({ refused: `#${item} has not been listed yet; act on it after the first tick` });

/**
 * The stateful shell around boardView. Holds only what the process already
 * knew — the last listing and which agents are running — so losing it loses
 * nothing: the next tick rebuilds it. Nothing here ever feeds a decision:
 * whose an item is was settled by the claims that listing came with. Only
 * some of what the page routes by it is judged again where it lands: a
 * Retry, a Clear or a Go to, and a pairing's start and hand-in, re-read the
 * item through `gotoOrigin`, which refuses one closed, turned away by the
 * workflow it was routed to, or unplaceable. A reply, an Ask, a Resolve and
 * a release go to that workflow on the listing's word alone.
 */
export function createBoard(opts: {
  workflows: ReadonlyArray<{ id: string; workflow: Workflow }>;
  held: (item: string) => Promise<Held | null>;
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
  // Null until the first listing: before it, nothing is anyone's.
  let listing: Pick<WorkspaceListing, "graphs" | "claims" | "sourceOf"> | null = null;
  let graph: Graph = { nodes: [], relationships: [] };
  const running = new Map<string, Running>();
  const sent = new Map<string, string>();
  const paired = new Map<string, Pairing>();
  // Each item a step ran on, and whether its tick has let it go since: the
  // step is about to change its labels, and the graph still holds the ones
  // from before. Only a list after the release vouches for them again.
  const stepped = new Map<string, boolean>();

  return {
    observe(e: LandraceEvent): void {
      if (typeof e.item !== "string") return;
      // Every evaluation says whether a pairing holds the item's step, so
      // the latest one is the answer — and one that does not name a pairing
      // is one that has ended.
      if (e.name === "item.evaluated") {
        const p = e.paired as Partial<Pairing> | null | undefined;
        if (p && typeof p.stage === "string" && typeof p.round === "number" && typeof p.at === "string") {
          paired.set(e.item, { stage: p.stage, round: p.round, n: typeof p.n === "number" ? p.n : 1, at: p.at });
        } else {
          paired.delete(e.item);
        }
      }
      // The tick's own record of a transition: a goto's is logged under the
      // trigger name no workflow may use, so the board can say so.
      if (e.name === "item.evaluated" && e.decision === "transition") {
        if (e.why === GOTO_TRIGGER && typeof e.to === "string") sent.set(e.item, e.to);
        else sent.delete(e.item);
      }
      if (e.name === "step.started") {
        stepped.set(e.item, false);
        running.set(e.item, {
          stage: String(e.stage ?? ""),
          round: typeof e.round === "number" ? e.round : 0,
          model: typeof e.model === "string" ? e.model : null,
          effort: typeof e.effort === "string" ? e.effort : null,
          since: now(),
        });
      } else if (e.name === "step.finished") {
        running.delete(e.item);
      } else if (e.name === "lock.released" && stepped.has(e.item)) {
        stepped.set(e.item, true);
      }
    },
    list(next): void {
      listing = next;
      graph = unionOf(next.graphs);
      // An item that has left the graph — closed and eventually not
      // relisted, or never eligible again — never fires another
      // item.evaluated for `sent` to clear; without this it would sit
      // there forever, on the very ids `sent` no longer has an opinion worth
      // keeping about.
      const ids = new Set(graph.nodes.map((n) => n.id));
      for (const id of sent.keys()) if (!ids.has(id)) sent.delete(id);
      for (const id of paired.keys()) if (!ids.has(id)) paired.delete(id);
      for (const [id, released] of stepped) if (released) stepped.delete(id);
    },
    ownerOf(item): Ownership {
      if (!listing) return unlisted(item);
      return writeRoute(listing, item) ?? { refused: `#${item} is not an item the last tick listed` };
    },
    readerOf(item): ReadRoute {
      if (!listing) return unlisted(item);
      return readRoute(listing, item) ?? { refused: `#${item} is not an item the last tick listed` };
    },
    async view(): Promise<BoardView> {
      // Open items only: nothing else can be held, and a closed item's
      // badge ignores the lock anyway.
      const elsewhere = new Map<string, Held>();
      await Promise.all(graph.nodes.filter(isOpenItem).map(async (n) => {
        const h = await opts.held(n.id);
        if (h) elsewhere.set(n.id, h);
      }));
      return boardView({
        workflows: opts.workflows, listing: listing ?? { graphs: [], claims: claimItems([], []), sourceOf: new Map() }, nest, running, elsewhere, now: now(), pid, sent, paired,
        stale: new Set(stepped.keys()), nextTickAt: nextTickAt(), folder: opts.folder, workspace: opts.workspace,
      });
    },
  };
}
