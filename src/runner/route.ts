import { compareIds, ITEM_KIND } from "#conventions.js";
import type { Claims, Graph, Ownership, PreHook, ReadRoute, WorkspaceListing } from "#namespace.js";
import { claimedBy, reportedBy, turnedAway } from "#runner/tick.js";

/*
 * Which workflow an action on an item by id goes through, judged from a
 * listing's claims: the board's from the last tick's, `landrace mcp`'s from
 * one it makes on demand. One set of rules and one set of sentences, so the
 * page and an agent are never told two different things about one item.
 */

/**
 * Why an open item is worked by neither of the workflows that want it: two
 * claiming it, or two trackers reporting its id. A halt a person has to
 * settle, in the tick's own words; null for any other item.
 */
export function haltOf(claims: Claims, item: string): string | null {
  const conflict = claims.conflicts.get(item);
  if (conflict) return claimedBy(conflict);
  const clash = claims.clashes.get(item);
  return clash ? reportedBy(clash) : null;
}

/**
 * Whose open `item` is by `claims`, or the sentence refusing to act on it.
 * Never the first of two claimants. Null when no listing showed it open.
 */
function ownership(claims: Claims, item: string): Ownership | null {
  const owner = claims.owner.get(item);
  if (owner !== undefined) return { workflow: owner };
  const conflict = claims.conflicts.get(item);
  if (conflict) return { refused: `#${item} is ${claimedBy(conflict)}; act on it after one workflow alone claims it` };
  const clash = claims.clashes.get(item);
  if (clash) return { refused: `#${item} is ${reportedBy(clash)}; act on it after one source alone reports it` };
  const reasons = claims.unclaimed.get(item);
  if (reasons) return { refused: `#${item} is claimed by no workflow: ${turnedAway(reasons)}` };
  return null;
}

/** The sources, by index, that list `item` as an item: closed in each, when no listing showed it open. */
const listedIn = (graphs: readonly Graph[], item: string): number[] =>
  [...graphs.entries()].filter(([, g]) => g.nodes.some((n) => n.id === item && n.kind === ITEM_KIND)).map(([index]) => index);

/** The workflows reading the sources at `indices`, in id order. */
const readingAny = (sourceOf: ReadonlyMap<string, number>, indices: readonly number[]): string[] =>
  [...sourceOf].filter(([, index]) => indices.includes(index)).map(([id]) => id).sort(compareIds);

/**
 * For a write: the one workflow that owns `item`, or why nothing is written
 * to it. Null when the listing does not show it at all, which each caller
 * words by what its listing was.
 */
export function writeRoute(listing: Pick<WorkspaceListing, "graphs" | "claims">, item: string): Ownership | null {
  const open = ownership(listing.claims, item);
  if (open) return open;
  return listedIn(listing.graphs, item).length ? { refused: `#${item} is closed, so nothing is written to it` } : null;
}

/**
 * For a read: as `writeRoute`, and a closed item through the one source that
 * lists it. Two that do may be two different items under one id, and which
 * one was meant is not for the reader to pick. Null when unlisted.
 */
export function readRoute(listing: Pick<WorkspaceListing, "graphs" | "claims" | "sourceOf">, item: string): ReadRoute | null {
  const open = ownership(listing.claims, item);
  if (open) return open;
  const [only, ...more] = listedIn(listing.graphs, item);
  if (only === undefined) return null;
  if (more.length === 0) return { source: only };
  return { refused: `#${item} is ${reportedBy(readingAny(listing.sourceOf, [only, ...more]))}; read it in its own tracker` };
}

/**
 * The pre hooks a closed item is read with: those every workflow on its
 * source loads, so no one workflow's own is picked over another's.
 */
export function sharedPre(each: ReadonlyArray<readonly PreHook[]>): PreHook[] {
  return [...new Set(each.flat())].filter((hook) => each.every((pre) => pre.includes(hook)));
}
