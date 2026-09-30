/*
 * What every docs integration shares: the spec artifact's name and effect,
 * telling a publish that has landed from one that has not by the page's own
 * content hash, and the page as a document node beside its ticket. Published
 * as part of `landrace/kit`.
 *
 * Where the page lives, how it is read and written, and the link a person
 * opens stay with the integration.
 */
import { createHash } from "node:crypto";
import { DOCUMENT_KIND } from "#conventions.js";
import type { Effect, Node, Snapshot } from "#namespace.js";

/**
 * The artifact a docs hook owns, and the effect type it answers. One name,
 * used for the snapshot path, the effect's `artifact` field and the hook's id:
 * the engine nests an artifact's state under the hook's own id, so a second
 * spelling would be a path no workflow could read.
 */
export const SPEC = "spec";
export const PUBLISH = "artifact.publish";

/** What a step is told when there is no page to hand it — said, so the prompt never shows a bare placeholder. */
export const NO_SPEC = "No spec has been published for this ticket.";

export const hashOf = (content: string): string => createHash("sha256").update(content).digest("hex");

/**
 * What this publish puts on the page.
 *
 * An empty body is refused rather than published: an empty document would
 * hash, satisfy and read back perfectly well, so the stage would complete and
 * the reviewer would be sent to a blank page with nothing saying why.
 */
export function contentOf(effect: Effect): string {
  const body = typeof effect.body === "string" ? effect.body : "";
  if (!body.trim()) throw new Error(`a "${PUBLISH}" effect for "${SPEC}" carried no content to publish`);
  return body;
}

/** Refuses a publish addressed to an artifact this hook does not own, rather than writing it to the spec's path. */
export function mine(effect: Effect): void {
  if (effect.artifact !== SPEC) {
    throw new Error(`this hook publishes the "${SPEC}" artifact, not "${String(effect.artifact)}"`);
  }
}

/**
 * The page's own text, for a step to work from — the prose half of the
 * artifact, beside its read state — or null when there is no page.
 *
 * Handed over as text rather than as a link. A link sends the agent off to
 * fetch something, which a prompt screener rightly reads as an injection
 * vector and which, in a private repository, it could not have opened in the
 * first place. Escaping and the size bound are the engine's, applied to every
 * briefing on the way in; a failed read is the integration's to throw,
 * because "the spec could not be read" and "there is no spec" are different
 * things to tell a build.
 */
export const briefPage = (content: string | null): Record<string, string> => ({ content: content ?? NO_SPEC });

/**
 * Idempotence, without a ledger: the page's own content hash, as this tick
 * read it, against the hash of what we are about to publish.
 *
 * Absent state is neither yes nor no. "Satisfied" would silently drop the
 * publish and complete a stage with nothing published; "not satisfied" would
 * republish on every tick. Halting is the third option, exactly as for a
 * missing bot login.
 */
export function publishSatisfied(snapshot: Snapshot, effect: Effect): boolean {
  mine(effect);
  const state = (snapshot.artifacts as Record<string, { hash?: unknown }> | undefined)?.[SPEC];
  if (state === undefined || state === null) {
    throw new Error(`the snapshot has no artifacts.${SPEC} state, so no publish of it can be checked`);
  }
  return state.hash === hashOf(contentOf(effect));
}

/**
 * The page as the graph reports it: a document beside its ticket, so the
 * board can draw it. Derived from the ticket like the page's path and link,
 * so there is nothing to remember about it — and nothing routes on it: what
 * the workflow reads is `artifacts.spec`.
 */
export const specNode = (ticket: string, link: string): Node => ({
  id: `spec-${ticket}`,
  kind: DOCUMENT_KIND,
  title: "Spec",
  link,
  closed: null,
  priority: null,
  origin: null,
  state: {},
});
