import {
  entriesFromComments,
  LABEL_EFFECT,
  LABELS,
  labelsOf,
  neutraliseMarkers,
  parseMarker,
  PULL_REQUEST_KIND,
  RECORD_EFFECT,
  RELATIONS,
  renderMarker,
  STAGE_LABEL_PREFIX,
  stageFromLabels,
  STATUS_EFFECT,
  TICKET_KIND,
} from "#conventions.js";
import { defineOperator, definePostHook, definePreHook, defineSource } from "#hooks/contracts.js";
import type {
  Effect,
  Entry,
  ExternalPull,
  ExternalState,
  ExternalTicket,
  Graph,
  Marker,
  Node,
  RelationDecl,
  Relationship,
  Snapshot,
  Source,
  TrackerComment,
} from "#namespace.js";

/**
 * The login everything the engine writes is posted under, so what it wrote
 * reads back as its own and what a person wrote does not. Authorship is the
 * whole check on a marker — syntax is not — so a fake that posted everything
 * under one name would make a person's comment able to complete a stage.
 */
const BOT = "landrace";
const PERSON = "a-person";

/** Both relationship types this tracker reports: a sub-ticket's parent, and the ticket a pull request implements. */
const RELATION_DECLS: RelationDecl[] = [
  { type: RELATIONS.childOf, singular: true },
  { type: RELATIONS.implements, singular: true },
];

/**
 * A source that answers every question with one fixed graph, for a test that
 * needs a ticket to exist and nothing to change under it. `read` returns the
 * whole graph whatever it is asked for, which the runner accepts: the ticket
 * is in it, and every edge in it is whole.
 */
export function staticSource(graph: Graph, relations: RelationDecl[] = RELATION_DECLS): Source {
  return defineSource({ id: "static", relations, list: async () => graph, read: async () => graph });
}

const nodeOf = (row: ExternalTicket): Node => ({
  id: row.id,
  kind: TICKET_KIND,
  title: row.title,
  link: `memory://tickets/${row.id}`,
  closed: row.closed ?? null,
  priority: row.priority ?? null,
  origin: null,
  // Always lists, empty when there is nothing: an absent path is one an
  // eligibility rule cannot be answered from, and the tick abstains on those —
  // which would work a ticket belonging to nobody rather than skip it.
  state: { labels: [...row.labels], assignees: [...row.assignees] },
});

const prNodeOf = (p: ExternalPull): Node => ({
  id: p.id,
  kind: PULL_REQUEST_KIND,
  title: `PR #${p.number}`,
  link: `memory://pulls/${p.number}`,
  closed: p.closed,
  priority: null,
  origin: null,
  // An open pull request's threads only, as a tracker integration reports
  // them: a thread left on a merged or abandoned one is nothing a fix round
  // can act on, and counting it would loop the ticket through review for ever.
  state: { merged: p.merged, ...(p.closed === null ? { openThreads: p.openThreads } : {}) },
});

/**
 * Monotonic per ticket, the way a real tracker's timestamps are: a comment
 * posted now is never dated before one already on the ticket. A bare counter
 * is not enough — a test seeding a human reply dated later than the counter
 * (the natural way to write "and then a person spoke") would have every
 * comment written afterwards sort *before* it, so `run.lastEvent.actor` stayed
 * "human" for the rest of the run and every handback trigger kept firing.
 */
function clock(): (existing: TrackerComment[]) => string {
  let tick = 0;
  return (existing) => {
    const next = new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
    const latest = existing.reduce((max, c) => (c.created_at > max ? c.created_at : max), "");
    return latest >= next ? new Date(Date.parse(latest) + 1000).toISOString() : next;
  };
}

/**
 * A tracker in memory, speaking the conventions and nobody's dialect.
 *
 * This is not a second copy of an integration. A real integration is tested
 * over a fake HTTP boundary, which is the only way to test *it* — a
 * hand-written imitation would be free to disagree with the real hook, and the
 * place it disagreed is exactly where a leak across the boundary stopped being
 * visible. What this is for is the workflow: labels, records and human turns,
 * so a graph can be driven and its loops watched before any integration for a
 * given tracker exists at all.
 *
 * It handles exactly the three writes a tracker owns, under the names
 * `src/conventions.ts` gives them — the same three the reference integration
 * declares, from the same constants, because two spellings of one name is how
 * a fake and the thing it stands in for drift apart.
 */
export function createExternalState(
  seed: { tickets?: Array<Partial<ExternalTicket>> } = {},
): ExternalState {
  const rows = new Map<string, ExternalTicket>();
  const pulls = new Map<string, ExternalPull>();
  const at = clock();
  let nextId = 1000;

  const add = (s: Partial<ExternalTicket>, id: string): ExternalTicket => {
    const row: ExternalTicket = {
      id,
      title: s.title ?? `ticket ${id}`,
      body: s.body ?? "",
      labels: [...(s.labels ?? [])],
      assignees: [...(s.assignees ?? [])],
      comments: [...(s.comments ?? [])],
      priority: s.priority ?? null,
      parent: s.parent ?? null,
      closed: s.closed ?? null,
      author: s.author ?? PERSON,
    };
    rows.set(id, row);
    return row;
  };

  for (const [i, s] of (seed.tickets ?? []).entries()) add(s, s.id ?? String(i + 1));

  const must = (id: string): ExternalTicket => {
    const row = rows.get(id);
    if (!row) throw new Error(`no such ticket #${id}`);
    return row;
  };

  /** Every edge among `ids`: a child to its parent, a pull request to its ticket. */
  const edgesAmong = (ids: Set<string>): Relationship[] => [
    ...[...rows.values()]
      .filter((r) => r.parent !== null && ids.has(r.id) && ids.has(r.parent))
      .map((r) => ({ from: r.id, to: r.parent as string, type: RELATIONS.childOf })),
    ...[...pulls.values()]
      .filter((p) => ids.has(p.id) && ids.has(p.ticket))
      .map((p) => ({ from: p.id, to: p.ticket, type: RELATIONS.implements })),
  ];

  const graphOf = (tickets: ExternalTicket[]): Graph => {
    const inside = new Set(tickets.map((r) => r.id));
    const prs = [...pulls.values()].filter((p) => inside.has(p.ticket));
    const ids = new Set([...inside, ...prs.map((p) => p.id)]);
    return { nodes: [...tickets.map(nodeOf), ...prs.map(prNodeOf)], relationships: edgesAmong(ids) };
  };

  /** The ticket, its parent, and every descendant, breadth-first. */
  const neighbourhood = (id: string): ExternalTicket[] => {
    const row = must(id);
    const found = [row];
    const parent = row.parent === null ? undefined : rows.get(row.parent);
    if (parent) found.push(parent);
    const seen = new Set(found.map((r) => r.id));
    for (let i = 0; i < found.length; i++) {
      const from = found[i];
      // The parent's other children are its business, not this ticket's.
      if (from === undefined || from === parent) continue;
      for (const child of rows.values()) {
        if (child.parent === from.id && !seen.has(child.id)) {
          seen.add(child.id);
          found.push(child);
        }
      }
    }
    return found;
  };

  const post = (id: string, author: string, body: string): void => {
    const row = must(id);
    row.comments.push({ id: nextId++, body, created_at: at(row.comments), user: { login: author } });
  };

  const entriesOf = (id: string): Entry[] => entriesFromComments(must(id).comments, BOT);

  const wroteIt = (c: TrackerComment): boolean => c.user?.login === BOT;

  return {
    ticket: must,
    openPull: (ticket, pr = {}) => {
      must(ticket);
      const number = pulls.size + 1;
      // Merged means closed as done, unless the test says otherwise.
      const closed = pr.closed !== undefined ? pr.closed : pr.merged ? "done" : null;
      const pull: ExternalPull = { id: `pr-${number}`, number, ticket, merged: false, openThreads: 0, ...pr, closed };
      pulls.set(pull.id, pull);
      return pull.id;
    },
    pull: (id) => {
      const pull = pulls.get(id);
      if (!pull) throw new Error(`no such pull request ${id}`);
      return pull;
    },

    source: defineSource({
      id: "memory",
      relations: RELATION_DECLS,
      list: async () => graphOf([...rows.values()]),
      read: async (id) => graphOf(neighbourhood(id)),
    }),

    operator: defineOperator({
      id: "memory",
      createTicket: async ({ title, body, labels }) => {
        let n = rows.size + 1;
        while (rows.has(String(n))) n++;
        return nodeOf(add({ title, body: body ?? "", labels: labels ?? [], author: BOT }, String(n)));
      },
      updateTicket: async (id, patch) => {
        const row = must(id);
        if (patch.title !== undefined) row.title = patch.title;
        if (patch.body !== undefined) row.body = patch.body;
        if (patch.state !== undefined) row.closed = patch.state === "closed" ? "done" : null;
        row.labels = row.labels.filter((l) => !(patch.removeLabels ?? []).includes(l));
        for (const l of patch.addLabels ?? []) if (!row.labels.includes(l)) row.labels.push(l);
        return nodeOf(row);
      },
    }),

    comments: (n) => must(n).comments.map((c) => c.body),
    entriesOf,
    stage: (n) => stageFromLabels(must(n).labels).stage,
    label: (n, label) => {
      const row = must(n);
      if (!row.labels.includes(label)) row.labels.push(label);
    },
    unlabel: (n, label) => {
      const row = must(n);
      row.labels = row.labels.filter((l) => l !== label);
    },
    say: (n, text) => post(n, PERSON, text),

    pre: definePreHook({
      id: "memory",
      /*
       * Exactly what `run` below puts in the snapshot, and nothing else —
       * `landrace validate`'s path-coverage rule is answered from this list,
       * so a path declared and not provided passes a workflow that reads
       * nothing. Only what a graph cannot hold: the title, the labels and
       * the assignees are the node's, and a second copy of them here is how
       * a fake and the integration it stands in for drift apart.
       * tests/hooks/provides.test.ts holds this level with what `run`
       * returns, for this tracker and for the shipped one.
       */
      provides: ["ticket", "ticket.body", "ticket.comments", "entries"],
      run: ({ ticket }) => {
        const row = must(ticket);
        return {
          ticket: { body: row.body, comments: row.comments.map((c) => ({ ...c })) },
          entries: entriesOf(ticket),
        };
      },
    }),

    post: definePostHook({
      id: "memory",
      handles: [LABEL_EFFECT, STATUS_EFFECT, RECORD_EFFECT],

      /*
       * Asked of the snapshot rather than of the map behind it, exactly as a
       * real hook must: `satisfied` is synchronous and answers "does the world
       * already show this", and the world it can see is the one this pass read.
       */
      satisfied: (snapshot: Snapshot, effect: Effect): boolean => {
        const ticket = (snapshot.ticket ?? {}) as { comments?: TrackerComment[] };
        const labels = labelsOf(snapshot.node as Node | undefined);
        switch (effect.type) {
          case LABEL_EFFECT: {
            const add = (effect.add as string[] | undefined) ?? [];
            const remove = (effect.remove as string[] | undefined) ?? [];
            return add.every((l) => labels.includes(l)) && remove.every((l) => !labels.includes(l));
          }
          case STATUS_EFFECT:
            return labels.includes(LABELS.stage(String(effect.value)));
          case RECORD_EFFECT: {
            // The same refusal a real tracker hook makes, for the same reason:
            // nothing on the ticket would record that an unmarked comment had
            // been posted, so reconciling one could only mean posting it again
            // on every tick.
            if (effect.marker === undefined) {
              throw new Error(
                "a tracker.comment effect with no marker cannot be reconciled: nothing would record that " +
                "it had already been posted, so it would be posted again on every tick",
              );
            }
            const marker = String(effect.marker);
            // Ours, and the marker parsed whole — never a substring of the
            // body. A stranger who guessed the token could otherwise suppress
            // the effect for good, because reconcile drops it.
            return (ticket.comments ?? []).some((c) => wroteIt(c) && parseMarker(c.body ?? "")?.marker === marker);
          }
          default:
            return false;
        }
      },

      apply: async (effect: Effect, { ticket }): Promise<void> => {
        const row = must(ticket);
        switch (effect.type) {
          case LABEL_EFFECT: {
            for (const l of (effect.remove as string[] | undefined) ?? []) {
              row.labels = row.labels.filter((x) => x !== l);
            }
            for (const l of (effect.add as string[] | undefined) ?? []) {
              if (!row.labels.includes(l)) row.labels.push(l);
            }
            return;
          }
          case STATUS_EFFECT: {
            // Position is a label here too, and exactly one of them: two
            // stage labels is a ticket the engine cannot place at all.
            row.labels = row.labels.filter((l) => !l.startsWith(STAGE_LABEL_PREFIX));
            row.labels.push(LABELS.stage(String(effect.value)));
            return;
          }
          case RECORD_EFFECT: {
            const body = neutraliseMarkers(String(effect.body ?? ""));
            if (effect.kind === undefined) {
              // An operator's own reply is genuinely a human turn; stamping it
              // would make the engine read a person's words as its own record.
              post(ticket, BOT, body);
              return;
            }
            const marker: Marker = {
              stage: String(effect.stage ?? "-"),
              kind: String(effect.kind),
              round: Number(effect.round ?? 0),
              ...(effect.marker ? { marker: String(effect.marker) } : {}),
              ...(effect.output === undefined ? {} : { output: effect.output }),
            };
            post(ticket, BOT, body + renderMarker(marker));
            return;
          }
          default:
            throw new Error(`the in-memory tracker cannot apply effect "${String(effect.type)}"`);
        }
      },
    }),
  };
}
