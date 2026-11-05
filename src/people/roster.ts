import { compareIds, LOCAL_PERSON_ID } from "#conventions.js";
import { localPerson } from "#people/person.js";
import { resolvePerson } from "#people/resolve.js";
import { messageOf, Refusal } from "#runner/errors.js";
import { createSlotPool } from "#runner/pool.js";
import { createRuntimeSlot } from "#runner/slot.js";
import { excludeAmbiguous, listingFailures, listWorkspace, retireRuntime, tickWorkspace } from "#runner/tick.js";
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

/**
 * The items a person's listing claims for them: every open item one of their
 * workflows owns, every closed one a `closed: run` stage claims, and every one
 * their own board halts because two of their workflows claim it or two of
 * their sources report it. Left out, that last kind ran for the one other
 * person who claims it while this person's board halted it.
 */
const claimedIn = (listing: WorkspaceListing): string[] => {
  const { owner, closed, conflicts, clashes } = listing.claims;
  return [...new Set([...owner.keys(), ...closed.keys(), ...conflicts.keys(), ...clashes.keys()])];
};

/** Whether two connections hold the same fields, whatever order they were written in. */
const sameFields = (a: Record<string, string>, b: Record<string, string>): boolean =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

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
        let { resolution } = await judge(entry.person);
        // A judging can look an identity up and store it, so its clash is
        // checked after every one, not only a sign-in's: a lookup that failed
        // at sign-in and found someone else's account at a later reload is
        // the same mistake. Marked, the person is judged again over it.
        if (opts.mode.remote && await markClashes(entry.person)) ({ resolution } = await judge(entry.person));
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
          if (previous !== null && previous !== next) retireRuntime(previous);
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

  /**
   * Who the roster should hold: the local person, or every person the store
   * has a file for — but the local one's, which is the operator's own and
   * nobody signs in as, and anyone `people.allow` no longer admits. Their
   * file is kept: a person put back on the list finds their connections.
   */
  const wanted = async (): Promise<Person[]> => {
    if (!opts.mode.remote) return [opts.local ?? localPerson(opts.loaded)];
    return (await opts.store.list()).filter((p) => p.id !== LOCAL_PERSON_ID && opts.admits(p));
  };

  // One clash check at a time, each reading every file afresh just before
  // it writes: two run side by side would each read the other's value
  // before it was marked, and both keep the account.
  let clashing: Promise<unknown> = Promise.resolve();
  const markClashes = (person: Person): Promise<boolean> => {
    const next = clashing.then(() => clashesOf(person));
    clashing = next.catch(() => {});
    return next;
  };

  /**
   * Each identity of the person's whose value another person already holds,
   * marked failed. Held means stored, not failed, and stored no later than
   * theirs: one stored at the same moment fails the one checked first, and
   * the other, checked next, finds it failed and keeps the account. Overrides
   * are held to this too — pinning someone else's account is no way round it.
   */
  const clashesOf = async (person: Person): Promise<boolean> => {
    const mine = await opts.store.read(person.id);
    if (mine.problem !== undefined) return false;
    const identities = [...opts.registry.connections.values()].filter((d) => d.kind === "identity");
    const others = [];
    for (const other of await wanted()) {
      if (other.id === person.id) continue;
      const theirs = await opts.store.read(other.id);
      if (theirs.problem === undefined) others.push(theirs);
    }
    let marked = false;
    for (const def of identities) {
      const value = mine.connections[def.id];
      if (value === undefined || value.failure !== undefined) continue;
      const held = others.some((o) => {
        const theirs = o.connections[def.id];
        return theirs !== undefined && theirs.failure === undefined && sameFields(theirs.fields, value.fields)
          && Date.parse(theirs.connectedAt) <= Date.parse(value.connectedAt);
      });
      if (!held) continue;
      const at = new Date().toISOString();
      await opts.store.put(person.id, mine.person, def.id, {
        ...value, failedAt: at, failure: `this ${def.label} account already belongs to another person; ask an admin to set people.overrides for you`,
      });
      marked = true;
    }
    return marked;
  };

  /**
   * What `people.overrides` pins for the person's email, stored as an
   * override where it is not already: an override replaces a lookup, and
   * one already stored keeps its failure. An override naming what no hook
   * defines as an identity of those fields is logged and stored nowhere.
   */
  const applyOverrides = async (person: Person): Promise<void> => {
    const email = person.email?.toLowerCase();
    const pinned = Object.entries(opts.overrides ?? {}).find(([e]) => e.toLowerCase() === email)?.[1];
    if (pinned === undefined) return;
    const creds = await opts.store.read(person.id);
    for (const [id, fields] of Object.entries(pinned).sort(([a], [b]) => compareIds(a, b))) {
      const def = opts.registry.connections.get(id);
      const wantedFields = def === undefined ? [] : [...def.fields].sort();
      const given = Object.keys(fields).sort();
      if (def?.kind !== "identity" || given.length !== wantedFields.length || given.some((f, i) => f !== wantedFields[i])) {
        opts.log("connection.failed", {
          person: person.id,
          error: def?.kind === "identity"
            ? `people.overrides gives "${id}" ${given.join(", ") || "nothing"}, but it holds ${wantedFields.join(", ")}`
            : `people.overrides names "${id}", but no hook defines it as an identity`,
        });
        continue;
      }
      const stored = creds.connections[id];
      if (stored?.source === "override" && sameFields(stored.fields, fields)) continue;
      await opts.store.put(person.id, person, id, { fields: { ...fields }, source: "override", connectedAt: new Date().toISOString() });
    }
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
        const current = entry.slot.current();
        if (current !== null) retireRuntime(current);
        await opts.onSwap?.(entry.person, current, null);
      }
      for (const person of people) {
        const entry = entryFor(person);
        entry.person = { ...entry.person, ...person };
        await reloadQuietly(entry);
      }
    },
    signIn: async (person) => {
      if (person.id === LOCAL_PERSON_ID) throw new Refusal(`nobody signs in as "${LOCAL_PERSON_ID}": that file is the operator's own`);
      // Before anything is written: someone turned away leaves no file behind.
      if (!opts.admits(person)) throw new Refusal(`${person.email ?? `${person.id}, who has no email,`} is not admitted to this instance`);
      await opts.store.remember(person);
      await applyOverrides(person);
      const entry = entryFor(person);
      entry.person = { ...entry.person, ...person };
      // Judged — every identity not stored looked up, then its clash checked — and built.
      await reloadQuietly(entry);
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
        // Nobody to share with, so nothing is claimed twice: a set judged while
        // someone else was here would keep holding items from page writes,
        // Refresh and the MCP tools that this tick works.
        lastAmbiguous = new Map();
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
      // Each person's note is on their own board, so it names only them: an id
      // is the provider's `sub`, nobody else's to see. The operator's log names all.
      const unjudged = failed.length > 0;
      if (unjudged) opts.log("source.failed", { people: failed, reason: "their items could not be listed, so whether another person also claims an item is unknown" });
      const unjudgedFor = (personId: string): string => {
        const others = failed.filter((id) => id !== personId).length;
        const whose = [
          ...(failed.includes(personId) ? [`${personId}'s`] : []),
          ...(others === 0 ? [] : [others === 1 ? "another person's" : "other people's"]),
        ];
        return `whether another person also claims it is unknown: ${whose.join(" and ")} items could not be listed`;
      };
      if (!unjudged) {
        lastAmbiguous = ambiguousClaims(running.map(({ entry }, i) => ({
          personId: entry.person.id, items: listings[i] === undefined ? [] : claimedIn(listings[i]),
        })));
        for (const [item, people] of lastAmbiguous) opts.log("item.ambiguous", { item, people });
      }
      const ambiguous = unjudged ? new Map<string, string[]>() : lastAmbiguous;

      await Promise.all(running.map(async ({ entry, rt }, i) => {
        const own = listings[i];
        if (own === undefined) return;
        const listed = excludeAmbiguous(own, ambiguous);
        said(rt, listed);
        try {
          const rows = await tickWorkspace({
            runtime: rt, listed, ...(opts.lock ? { lock: opts.lock } : {}),
            onList: (listing) => opts.seen?.(entry.person, rt, listing),
            ...(unjudged ? { unjudged: unjudgedFor(entry.person.id) } : {}),
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
