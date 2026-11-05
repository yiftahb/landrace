import { compareIds } from "#conventions.js";
import { localPerson } from "#people/person.js";
import { resolvePerson } from "#people/resolve.js";
import { messageOf } from "#runner/errors.js";
import { createSlotPool } from "#runner/pool.js";
import { createRuntimeSlot } from "#runner/slot.js";
import { andList, excludeAmbiguous, listingFailures, listWorkspace, tickWorkspace } from "#runner/tick.js";
import type {
  Board, BoardView, Person, PersonJudged, PersonRuntime, Roster, RosterOptions, WorkspaceListing, WorkspaceRuntime,
} from "#namespace.js";

/**
 * Every item more than one person claims, with who, in id order each. An
 * item two people's runtimes both own — open, or closed and claimed by a
 * `closed: run` stage — is worked by neither: the runner cannot tell which
 * of them it is, and picking one would be the first match by another name.
 */
export function ambiguousClaims(claims: ReadonlyArray<{ personId: string; items: readonly string[] }>): Map<string, string[]> {
  const by = new Map<string, Set<string>>();
  for (const { personId, items } of claims) {
    for (const item of items) by.set(item, (by.get(item) ?? new Set<string>()).add(personId));
  }
  const out = new Map<string, string[]>();
  for (const item of [...by.keys()].sort(compareIds)) {
    const people = [...(by.get(item) ?? [])].sort(compareIds);
    if (people.length > 1) out.set(item, people);
  }
  return out;
}

/** The items a person's listing has them work: every open item one of their workflows owns, and every closed one a `closed: run` stage claims. */
const claimedIn = (listing: WorkspaceListing): string[] => [...listing.claims.owner.keys(), ...listing.claims.closed.keys()];

const NOT_RUNNING = "this person's runtime is not running yet";

/**
 * A board over whichever runtime of a person's is current: what the sink
 * routes their events to and the page reads, without either holding on to a
 * runtime a reload replaced. With none, it shows nothing and refuses.
 */
function currentBoard(current: () => Board | undefined): Board {
  return {
    observe: (e) => current()?.observe(e),
    list: (listing) => current()?.list(listing),
    ownerOf: (item, o) => current()?.ownerOf(item, o) ?? { refused: NOT_RUNNING },
    readerOf: (item) => current()?.readerOf(item) ?? { refused: NOT_RUNNING },
    has: (item) => {
      const board = current();
      return board === undefined ? false : board.has?.(item) ?? true;
    },
    view: (): Promise<BoardView> => current()?.view() ?? Promise.reject(new Error(NOT_RUNNING)),
  };
}

/**
 * The people one runner runs for, each with a runtime of their own.
 *
 * Locally the roster is exactly the local person, and their runtime is the
 * one `start` always built. Remotely it is every person in the store, met
 * again on each `sync`. Each person is judged by their own connections: one
 * not ready has no runtime and their board says so, one whose file does not
 * read or whose build throws is that person failing — logged, and no one
 * else's concern.
 *
 * Per person: the runtime, its runs, what it has told of, its context and
 * logger — all the build's. Shared: the slot pool, and what the build is
 * handed by its caller — the stop, the locks, the schedule, telemetry.
 */
export function createRoster(opts: RosterOptions): Roster {
  const pool = opts.pool ?? createSlotPool(opts.loaded.config.tick.concurrency);
  const entries = new Map<string, PersonRuntime>();
  let lastAmbiguous = new Map<string, string[]>();

  const judge = opts.judge ?? (async (person: Person): Promise<PersonJudged> => {
    const creds = await opts.store.read(person.id);
    return { resolution: resolvePerson(opts.loaded, opts.registry, person, creds, opts.mode) };
  });

  const entryFor = (person: Person): PersonRuntime => {
    const known = entries.get(person.id);
    if (known) return known;
    const boards: { current?: Board } = {};
    const entry: PersonRuntime = {
      person,
      statuses: [],
      board: currentBoard(() => boards.current),
      slot: createRuntimeSlot<WorkspaceRuntime>(async () => {
        const { resolution } = await judge(entry.person);
        entry.statuses = resolution.statuses;
        if (!resolution.ready) {
          // A file that does not read is this person's to mend, said once per judging.
          for (const p of resolution.problems.filter((x) => x.rule === "connection.failed")) {
            opts.log("connection.failed", { person: entry.person.id, error: opts.log.scrub(p.message) });
          }
          return null;
        }
        return opts.build(entry.person, resolution);
      }, {
        onSwap: async (previous, next) => {
          const board = next === null ? undefined : opts.boardOf?.(next);
          if (board) boards.current = board;
          else delete boards.current;
          await opts.onSwap?.(entry.person, previous, next);
        },
      }),
    };
    entries.set(person.id, entry);
    return entry;
  };

  /** Who the roster should hold: the local person, or every person the store has a file for. */
  const wanted = async (): Promise<Person[]> => {
    if (!opts.mode.remote) return [opts.local ?? localPerson(opts.loaded)];
    return opts.store.list();
  };

  /** One person's reload, its failure theirs alone: logged, and the roster goes on. */
  const reloadQuietly = async (entry: PersonRuntime): Promise<void> => {
    try {
      await entry.slot.reload();
    } catch (e) {
      opts.log("connection.failed", { person: entry.person.id, error: `could not build their runtime: ${opts.log.scrub(messageOf(e))}` });
    }
  };

  const ready = (): Array<{ entry: PersonRuntime; rt: WorkspaceRuntime }> =>
    [...entries.values()].flatMap((entry) => {
      const rt = entry.slot.current();
      return rt === null ? [] : [{ entry, rt }];
    });

  return {
    people: () => [...entries.values()],
    get: (personId) => entries.get(personId),
    ambiguous: () => lastAmbiguous,
    // Unlike `sync`, a build that throws rejects: a local start whose first
    // build fails is refused, as it always was, and a connect says why.
    reload: async (personId) => {
      const local = opts.mode.remote ? undefined : opts.local ?? localPerson(opts.loaded);
      const entry = entries.get(personId) ?? (local?.id === personId ? entryFor(local) : undefined);
      if (!entry) throw new Error(`no person "${personId}" in this runner`);
      await entry.slot.reload();
    },
    sync: async () => {
      const people = await wanted();
      const ids = new Set(people.map((p) => p.id));
      for (const [id, entry] of entries) {
        if (ids.has(id)) continue;
        entries.delete(id);
        // Gone from the store: their runtime is let go of, its runs left to unwind under their own locks.
        await opts.onSwap?.(entry.person, entry.slot.current(), null);
      }
      for (const person of people) {
        const entry = entryFor(person);
        entry.person = { ...entry.person, ...person };
        await reloadQuietly(entry);
      }
    },
    tick: async () => {
      const order = pool.order(ready().map((r) => r.entry.person.id));
      const running = ready().sort((a, b) => order.indexOf(a.entry.person.id) - order.indexOf(b.entry.person.id));
      const failures: string[] = [];
      const said = (rt: WorkspaceRuntime, listing: WorkspaceListing): void => {
        for (const f of listingFailures(listing)) failures.push(rt.log.scrub(f));
      };

      // One person has no one to share an item with: their runtime lists for
      // itself, exactly as a runner of one always did.
      const [only, ...more] = running;
      if (only !== undefined && more.length === 0) {
        const rows = await tickWorkspace({
          runtime: only.rt, ...(opts.lock ? { lock: opts.lock } : {}),
          onList: (listing) => {
            said(only.rt, listing);
            opts.seen?.(only.entry.person, only.rt, listing);
          },
        });
        opts.rows?.(only.entry.person, only.rt, rows);
        if (failures.length) throw new Error(failures.join("; "));
        return;
      }

      // Judged fresh, over everyone's listing at once: this is the only place a run starts.
      const listings = await Promise.all(running.map(({ rt }) => listWorkspace(rt)));
      const failed = running.filter((_, i) => (listings[i]?.failed.size ?? 0) > 0).map((r) => r.entry.person.id);
      // One person's tracker down leaves who else claims what unknown: the
      // same rule as two sources, one level up. Runs go on; nothing new starts.
      const unjudged = failed.length
        ? `whether another person also claims it is unknown: ${andList(failed)}'s items could not be listed`
        : undefined;
      if (unjudged === undefined) {
        lastAmbiguous = ambiguousClaims(running.map(({ entry }, i) => ({
          personId: entry.person.id, items: listings[i] === undefined ? [] : claimedIn(listings[i]),
        })));
        for (const [item, people] of lastAmbiguous) opts.log("item.ambiguous", { item, people });
      }
      const ambiguous = unjudged === undefined ? lastAmbiguous : new Map<string, string[]>();

      await Promise.all(running.map(async ({ entry, rt }, i) => {
        const own = listings[i];
        if (own === undefined) return;
        const listed = excludeAmbiguous(own, ambiguous);
        said(rt, listed);
        try {
          const rows = await tickWorkspace({
            runtime: rt, listed, ...(opts.lock ? { lock: opts.lock } : {}),
            onList: (listing) => opts.seen?.(entry.person, rt, listing),
            ...(unjudged === undefined ? {} : { unjudged }),
          });
          opts.rows?.(entry.person, rt, rows);
        } catch (e) {
          failures.push(`${entry.person.id}'s tick failed: ${rt.log.scrub(messageOf(e))}`);
        }
      }));
      if (failures.length) throw new Error(failures.join("; "));
    },
  };
}
