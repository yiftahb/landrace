import { compareIds, isItemNode, isOpenItem, labelsOf } from "#conventions.js";
import { eligibilityOfNode } from "#core/index.js";
import type {
  AdmitRoute, Claims, EditRoute, Graph, ListedWorkflow, Node, Ownership, PreHook, ReadRoute, Workflow, WorkspaceListing,
} from "#namespace.js";
import { andList, claimedBy, claimsOf, listingFailures, reportedBy, turnedAway } from "#runner/tick.js";

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
 * Why an open item one source lists is worked by no workflow: two claim it,
 * or each turned it away, with its reasons. Null for any other item.
 */
export function unownedWhy(claims: Claims, item: string): string | null {
  const conflict = claims.conflicts.get(item);
  if (conflict) return claimedBy(conflict);
  const reasons = claims.unclaimed.get(item);
  return reasons ? `claimed by no workflow: ${turnedAway(reasons)}` : null;
}

/**
 * Whose open `item` is by `claims`, or the sentence refusing to act on it.
 * Never the first of two claimants. Null when no listing showed it open.
 */
function ownership(claims: Claims, item: string): Ownership | null {
  const owner = claims.owner.get(item);
  if (owner !== undefined) return { workflow: owner };
  const clash = claims.clashes.get(item);
  if (clash) return { refused: `#${item} is ${reportedBy(clash)}; act on it after one source alone reports it` };
  const why = unownedWhy(claims, item);
  if (why === null) return null;
  return { refused: claims.conflicts.has(item) ? `#${item} is ${why}; act on it after one workflow alone claims it` : `#${item} is ${why}` };
}

/** The sources, by index, that list `item` as an item: closed in each, when no listing showed it open. */
const listedIn = (graphs: readonly Graph[], item: string): number[] =>
  [...graphs.entries()].filter(([, g]) => g.nodes.some((n) => n.id === item && isItemNode(n))).map(([index]) => index);

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
 * For an operator's edit — a title, a body, labels that are not the
 * workflow's, open or closed: a person's edit, as on the tracker, never a
 * move through any workflow's stages. The owner's operator when one workflow
 * owns `item`. Otherwise the workflows that could be its — those whose source
 * lists it, or every one when no listing shows it — when they all edit
 * through one operator, which is then no pick; refused, naming them, when
 * they do not. Never an id two sources report: which item was meant is
 * not the editor's to pick.
 */
export function editRoute(
  listing: Pick<WorkspaceListing, "graphs" | "claims" | "sourceOf">, item: string, operatorOf: (workflow: string) => unknown,
): EditRoute {
  const owner = listing.claims.owner.get(item);
  if (owner !== undefined) return { workflow: owner };
  const indices = listedIn(listing.graphs, item);
  if (indices.length > 1) {
    return { refused: `#${item} is ${reportedBy(readingAny(listing.sourceOf, indices))}; act on it after one source alone reports it` };
  }
  const candidates = indices.length ? readingAny(listing.sourceOf, indices) : [...listing.sourceOf.keys()].sort(compareIds);
  if (new Set(candidates.map(operatorOf)).size === 1) return { workflows: candidates };
  const why = unownedWhy(listing.claims, item) ?? (indices.length ? "closed" : "listed by no source");
  return { refused: `#${item} is ${why}, and ${andList(candidates)} edit items through different operators; edit it in its tracker` };
}

/**
 * For a read: an owned item through its owner, and any other item through
 * the one source that lists it — claimed twice, turned away, or closed alike,
 * because a read decides nothing. Two sources that list it may be two
 * different items under one id, and which one was meant is not for the
 * reader to pick. An id no listing shows — a closed item past the window a
 * tracker lists — is the one source's when the workspace has one, since it
 * can be nowhere else; null with more, where it could be in any of them.
 */
export function readRoute(listing: Pick<WorkspaceListing, "graphs" | "claims" | "sourceOf">, item: string): ReadRoute | null {
  const owner = listing.claims.owner.get(item);
  if (owner !== undefined) return { workflow: owner };
  const indices = listedIn(listing.graphs, item);
  const [only, ...more] = indices;
  if (more.length > 0) return { refused: `#${item} is ${reportedBy(readingAny(listing.sourceOf, indices))}; read it in its own tracker` };
  if (only !== undefined) return { source: only };
  return listing.graphs.length === 1 ? { source: 0 } : null;
}

/**
 * Whether admitting `item` to `target` would make it `target`'s, and the
 * labels that takes: the workflow's `admit` labels the item lacks. Judged
 * before anything is written, by claiming the item again over every
 * workflow as if it carried them — so an offer on the page and an MCP
 * admission are the same prediction, and neither leaves the item claimed by
 * another workflow, by two, or by none. Never a label taken off to make it
 * work: what keeps an item out of a workflow is a person's to change.
 */
export function admitRoute(
  workflows: ReadonlyArray<{ id: string; workflow: Workflow }>,
  listing: Pick<WorkspaceListing, "graphs" | "claims" | "sourceOf">,
  item: string,
  target: string,
): AdmitRoute {
  const named = workflows.find((w) => w.id === target);
  if (!named) return { refused: `no workflow "${target}"; the workspace has ${workflows.map((w) => w.id).join(", ")}` };
  const { claims, graphs, sourceOf } = listing;
  const nodes = graphs.flatMap((g) => g.nodes.filter((n) => n.id === item && isItemNode(n)));
  if (nodes.length === 0) return { refused: `#${item} is not an item any source lists` };
  if (!nodes.some(isOpenItem)) return { refused: `#${item} is closed, so nothing is written to it` };
  const clash = claims.clashes.get(item);
  if (clash) return { refused: `#${item} is ${reportedBy(clash)}; act on it after one source alone reports it` };
  const conflict = claims.conflicts.get(item);
  if (conflict) return { refused: `#${item} is ${claimedBy(conflict)}; act on it after one workflow alone claims it` };
  const owner = claims.owner.get(item);
  if (owner !== undefined) return { refused: `#${item} is already in ${owner}` };
  const index = sourceOf.get(target) ?? -1;
  const node = graphs[index]?.nodes.find((n) => n.id === item && isOpenItem(n));
  if (!node) return { refused: `#${item} is not listed by ${target}'s source` };
  const admit = named.workflow.admit ?? [];
  // The folder to edit, by its id: the display name is not a path.
  if (admit.length === 0) return { refused: `workflow "${target}" admits nothing: add admit: [<labels>] to workflows/${target}/workflow.yaml` };

  const has = labelsOf(node);
  const labels = admit.filter((l) => !has.includes(l));
  const admitted: Node = { ...node, state: { ...node.state, labels: [...has, ...labels] } };
  const after = claimsOf(
    workflows.map((w) => ({ id: w.id, deps: { workflow: w.workflow } })), sourceOf,
    graphs.map((g, i) => (i === index ? { ...g, nodes: g.nodes.map((n) => (n === node ? admitted : n)) } : g)),
  );
  const would = after.owner.get(item);
  if (would === target) return { labels };
  const what = labels.length ? `with ${andList(labels)} added` : "with the labels it has";
  if (would !== undefined) return { refused: `#${item} would be claimed by ${would}, not ${target}, ${what}` };
  const both = after.conflicts.get(item);
  if (both) return { refused: `#${item} would be ${claimedBy(both)}, ${what}` };
  // Its own `else` alone: another workflow turning it away is no reason this one does.
  const verdict = eligibilityOfNode(named.workflow, admitted);
  return { refused: `${target} would still turn #${item} away, ${what}: ${verdict.eligible ? "claimed by no workflow" : verdict.reason}` };
}

/**
 * The pre hooks an item read through its source, rather than through one
 * workflow, is read with: those every workflow on that source loads, so no
 * one workflow's own is picked over another's. Null when they share none
 * while some load any: the read would come back with less than any of them
 * sees — an empty history said as if it were the item's — and nothing
 * compared is not a pass.
 */
export function sharedPre(each: ReadonlyArray<readonly PreHook[]>): PreHook[] | null {
  const shared = [...new Set(each.flat())].filter((hook) => each.every((pre) => pre.includes(hook)));
  return shared.length === 0 && each.some((pre) => pre.length > 0) ? null : shared;
}

/** Why `item` is not read through a source whose `workflows` share no pre hook. */
export const noSharedPre = (item: string, workflows: readonly string[]): string =>
  `#${item} cannot be read here: the workflows reading its source, ${andList([...workflows].sort(compareIds))}, ` +
  "load no pre hook in common, and a read with none would leave out what each of them reads";

/**
 * What the page is shown of each listing. A source that could not list is
 * shown as it last listed: one tracker blip must not empty the board, and
 * `board.list` forgets every id it is not handed. Claims are judged again
 * over what is shown, for the page's reads to route by — never its writes
 * (see `writeOwnerOf`), and never a tick's work, which is only ever judged
 * from the fresh listing. Null while a source that failed has never listed
 * at all: the page keeps the view it has.
 */
export function displayOf(workflows: readonly ListedWorkflow[]): (listing: WorkspaceListing) => WorkspaceListing | null {
  // By source index, which every listing of one runtime shares.
  const lastGood = new Map<number, Graph>();
  return (listing) => {
    for (const [index, graph] of listing.graphs.entries()) if (!listing.failed.has(index)) lastGood.set(index, graph);
    if (listing.failed.size === 0) return listing;
    const graphs: Graph[] = [];
    for (const index of listing.graphs.keys()) {
      const graph = lastGood.get(index);
      if (!graph) return null;
      graphs.push(graph);
    }
    return { ...listing, graphs, claims: claimsOf(workflows, listing.sourceOf, graphs) };
  };
}

/**
 * Whose `item` is for a write from the page: the one owner by the last
 * fresh listing — never by what the page is shown, whose failed source is
 * its last good listing and may be stale. Refused before the first listing,
 * and while any source could not list: an item the others list as one
 * workflow's may be a clash the missing source would report.
 */
export function writeOwnerOf(fresh: WorkspaceListing | undefined, item: string): Ownership {
  if (!fresh) return { refused: `#${item} has not been listed yet; act on it after the first tick` };
  const failures = listingFailures(fresh);
  if (failures.length) return { refused: `#${item} is not written to until every source lists again: ${failures.join("; ")}` };
  return writeRoute(fresh, item) ?? { refused: `#${item} is not an item the last tick listed` };
}
