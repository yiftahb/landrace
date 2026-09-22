import {
  entriesFromComments,
  LABEL_EFFECT,
  LABELS,
  neutraliseMarkers,
  parseMarker,
  RECORD_EFFECT,
  renderMarker,
  STAGE_LABEL_PREFIX,
  stageFromLabels,
  STATUS_EFFECT,
} from "#conventions.js";
import { definePostHook, definePreHook } from "#hooks/contracts.js";
import type { Effect, Entry, ExternalState, ExternalTicket, Marker, Snapshot, TrackerComment } from "#namespace.js";

/**
 * The login everything the engine writes is posted under, so what it wrote
 * reads back as its own and what a person wrote does not. Authorship is the
 * whole check on a marker — syntax is not — so a fake that posted everything
 * under one name would make a person's comment able to complete a stage.
 */
const BOT = "landrace";
const PERSON = "a-person";

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
  const rows = new Map<number, ExternalTicket>();
  const at = clock();
  let nextId = 1000;

  for (const [i, s] of (seed.tickets ?? []).entries()) {
    const number = s.number ?? i + 1;
    rows.set(number, {
      number,
      title: s.title ?? `ticket ${number}`,
      body: s.body ?? "",
      labels: [...(s.labels ?? [])],
      assignees: [...(s.assignees ?? [])],
      comments: [...(s.comments ?? [])],
    });
  }

  const must = (n: number): ExternalTicket => {
    const row = rows.get(n);
    if (!row) throw new Error(`no such ticket #${n}`);
    return row;
  };

  const post = (n: number, author: string, body: string): void => {
    const row = must(n);
    row.comments.push({ id: nextId++, body, created_at: at(row.comments), user: { login: author } });
  };

  const entriesOf = (n: number): Entry[] => entriesFromComments(must(n).comments, BOT);

  const wroteIt = (c: TrackerComment): boolean => c.user?.login === BOT;

  return {
    ticket: must,
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
       * nothing. `ticket.stage` was declared and provided and read by nobody:
       * a second spelling of `run.stage`, derived from these same labels, and
       * a second spelling of one fact is how a fake and the integration it
       * stands in for drift apart. tests/hooks/provides.test.ts holds this
       * level with what `run` returns, for this tracker and for the shipped
       * one, so neither can grow a field without saying so.
       */
      provides: [
        "ticket", "ticket.number", "ticket.title", "ticket.body", "ticket.labels",
        "ticket.assignees", "ticket.comments", "entries",
      ],
      run: ({ ticket }) => {
        const row = must(ticket);
        return {
          ticket: {
            number: row.number,
            title: row.title,
            body: row.body,
            labels: [...row.labels],
            // Always a list, empty when nobody is assigned: an absent path is
            // one an eligibility rule cannot be answered from, and the tick
            // abstains on those — which would work a ticket belonging to
            // nobody rather than skip it.
            assignees: [...row.assignees],
            comments: row.comments.map((c) => ({ ...c })),
          },
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
        const ticket = (snapshot.ticket ?? {}) as { labels?: string[]; comments?: TrackerComment[] };
        const labels = ticket.labels ?? [];
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
