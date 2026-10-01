/*
 * What every docs integration shares: the spec artifact's name and effect,
 * telling a publish that has landed from one that has not by the page's own
 * content hash, and the page as a document node beside its item. Published
 * as part of `landrace/kit`.
 *
 * Where the page lives, how it is read and written, and the link a person
 * opens stay with the integration.
 */
import { createHash } from "node:crypto";
import { DOCUMENT_KIND, RELATIONS } from "#conventions.js";
import type {
  BriefTable, Effect, EffectTable, Graph, HookContext, Node, RelationDecl, RuntimeContext, Snapshot,
} from "#namespace.js";

/**
 * The artifact a docs hook owns, and the effect type it answers. One name,
 * used for the snapshot path, the effect's `artifact` field and the hook's id:
 * the engine nests an artifact's state under the hook's own id, so a second
 * spelling would be a path no workflow could read.
 */
export const SPEC = "spec";
export const PUBLISH = "artifact.publish";

/** What a step is told when there is no page to hand it — said, so the prompt never shows a bare placeholder. */
export const NO_SPEC = "No spec has been published for this item.";

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
 * The page as the graph reports it: a document beside its item, so the
 * board can draw it. Derived from the item like the page's path and link,
 * so there is nothing to remember about it — and nothing routes on it: what
 * the workflow reads is `artifacts.spec`.
 */
export const specNode = (item: string, link: string): Node => ({
  id: `spec-${item}`,
  kind: DOCUMENT_KIND,
  title: "Spec",
  link,
  closed: null,
  priority: null,
  origin: null,
  state: {},
});

/**
 * A docs integration: its vendor's calls, and nothing else.
 *
 * An integration extends this and writes where an item's spec page lives,
 * how it is read and written, and the link a person opens. What is here is
 * the rest: the artifact's state (`artifacts.spec`, `{ exists, hash, url }`),
 * the publish that is a no-op when the page already says it, the page's text
 * for a step's prompt, and the page as a document beside its item.
 * `compose` makes the `spec` artifact hook out of it.
 */
export abstract class BaseDocs {
  /** An item's spec page, or null when there is none. A failed read throws: "no spec" and "unreadable" are different things to a build. */
  abstract page(item: string, ctx: RuntimeContext): Promise<string | null>;
  abstract publish(item: string, content: string, ctx: RuntimeContext): Promise<void>;
  /** Where a person opens the item's page. */
  abstract link(item: string, ctx: RuntimeContext): Promise<string>;
  /** Which items have a page, from one listing — or a throw when the listing cannot be had whole. */
  abstract published(ctx: RuntimeContext): Promise<Set<string>>;

  /** Run once at startup, before anything is paid for. */
  check?(ctx: RuntimeContext): Promise<void>;

  relations(): RelationDecl[] {
    return [{ type: RELATIONS.documents, singular: true }];
  }

  /** `artifacts.spec`: presence is what a precondition reads, and the hash is what makes a republish a no-op. */
  async observe(ctx: HookContext): Promise<Record<string, unknown>> {
    const content = await this.page(ctx.item, ctx);
    return { exists: content !== null, hash: content === null ? null : hashOf(content), url: await this.link(ctx.item, ctx) };
  }

  effects(): EffectTable {
    return {
      [PUBLISH]: {
        satisfied: publishSatisfied,
        apply: async (effect, ctx) => {
          mine(effect);
          const content = contentOf(effect);
          // Read before writing, not from the snapshot: the step that
          // produced this ran minutes ago. Identical content is then a no-op
          // at the cost of one read, rather than a write per tick.
          if ((await this.page(ctx.item, ctx)) === content) return;
          await this.publish(ctx.item, content, ctx);
        },
      },
    };
  }

  /** `{brief.spec.content}`: the page's own text, never a link to fetch. */
  briefs(): BriefTable {
    return { content: async (ctx) => (await this.page(ctx.item, ctx)) ?? NO_SPEC };
  }

  /**
   * Each listed item's page, as a document beside it. Display only, so
   * nothing about it may fail the tick: a listing that cannot be had costs
   * this tick its documents and a log line saying why.
   */
  async list(items: ReadonlySet<string>, ctx: RuntimeContext): Promise<Graph> {
    try {
      const paged = await this.published(ctx);
      return await this.documents([...items].filter((t) => paged.has(t)), ctx);
    } catch (e) {
      ctx.log("docs.skipped", {
        reason: `the pages could not be listed, so none is reported this tick: ${e instanceof Error ? e.message : String(e)}`,
      });
      return { nodes: [], relationships: [] };
    }
  }

  /** The item's own page, by one read: that is all `rel.documents` counts. */
  async read(item: string, ctx: RuntimeContext): Promise<Graph> {
    return this.documents((await this.page(item, ctx)) === null ? [] : [item], ctx);
  }

  private async documents(items: string[], ctx: RuntimeContext): Promise<Graph> {
    const nodes: Node[] = [];
    for (const item of items) nodes.push(specNode(item, await this.link(item, ctx)));
    return { nodes, relationships: items.map((t) => ({ from: `spec-${t}`, to: t, type: RELATIONS.documents })) };
  }
}
