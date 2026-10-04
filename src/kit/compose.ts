/*
 * `compose`: a project's tracker, forge and docs integration, made into the
 * hooks its hook file exports — `export const { preflight, source, operator,
 * pre, post, spec } = compose({ tracker, forge, docs })`. Published as part of
 * `landrace/kit`; the loader sees six ordinary hooks and knows nothing of it.
 *
 * One source, one operator, one pre and one post hook, all under the id
 * `project`, whatever vendors the roles are: one vendor's tracker beside
 * another's forge is one project, not two sources the loader would halt on. The docs
 * role's effects and state stay on its own artifact hook, `spec`.
 *
 * Every clash between roles halts here, naming both — two roles handling one
 * effect type, giving one briefing key or providing one snapshot path at
 * compose; two reporting one node id at list or read. The one thing two roles
 * share is `nodes.close`, whose ids are split by kind between the role that
 * closes items and the one that closes pull requests.
 */
import { isItemNode, NODES_CLOSE_EFFECT, PULL_REQUEST_KIND } from "#conventions.js";
import {
  defineArtifactHook, defineOperator, definePostHook, definePreflight, definePreHook, defineSource,
} from "#hooks/contracts.js";
import { type BaseDocs, SPEC } from "#kit/docs.js";
import { historyBrief } from "#kit/forge.js";
import type {
  ArtifactHook, BriefTable, ComposedHooks, Effect, EffectHandler, EffectTable, Graph, HookContext, Roles,
  RuntimeContext, Snapshot,
} from "#namespace.js";

/** The one id every item-side hook a composition makes is filed under: `{brief.project.<key>}`. */
export const PROJECT = "project";

const TRACKER = "the tracker";
const FORGE = "the forge";
const DOCS = "the docs";

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Records that `role` claims `key`, or halts naming the role that already did. */
function claim(claims: Map<string, string>, what: string, key: string, role: string): void {
  const had = claims.get(key);
  if (had !== undefined) throw new Error(`${what} "${key}" is claimed by both ${had} and ${role}; one role owns it`);
  claims.set(key, role);
}

/**
 * The keys of a briefing table a prompt names — every key when it names none
 * in particular — read one after another: a step's prompt text. A key it does
 * not name is never read, so a review that names threads never pays for, or
 * fails on, a red build's logs.
 */
async function briefAll(table: BriefTable, ctx: HookContext, keys?: ReadonlySet<string>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, read] of Object.entries(table)) if (keys === undefined || keys.has(key)) out[key] = await read(ctx);
  return out;
}

/**
 * The roles' graphs as one. A node id two roles both report is refused, both
 * named: which of the two is the node is not a guess. One role's own
 * duplicates, and edges that dangle, are the engine's `graphProblem` to refuse.
 */
function merged(parts: Array<[string, Graph]>): Graph {
  const owner = new Map<string, string>();
  for (const [role, graph] of parts) {
    for (const node of graph.nodes) {
      const had = owner.get(node.id);
      if (had !== undefined && had !== role) throw new Error(`node "${node.id}" is reported by both ${had} and ${role}`);
      owner.set(node.id, role);
    }
  }
  return { nodes: parts.flatMap(([, g]) => g.nodes), relationships: parts.flatMap(([, g]) => g.relationships) };
}

const handlerIn = (table: EffectTable, effect: Effect): EffectHandler => {
  const handler = Object.hasOwn(table, effect.type) ? table[effect.type] : undefined;
  if (!handler) throw new Error(`no role handles effect "${effect.type}"`);
  return handler;
};

export function compose(roles: Roles & { docs: BaseDocs }): ComposedHooks & { spec: ArtifactHook };
export function compose(roles: Roles): ComposedHooks;
export function compose({ tracker, forge, docs }: Roles): ComposedHooks {
  const present = [
    [TRACKER, tracker] as const,
    ...(forge ? [[FORGE, forge] as const] : []),
    ...(docs ? [[DOCS, docs] as const] : []),
  ];

  // Effects: the tracker's and the forge's on `post`, the docs' on `spec`,
  // and one owner each across all three — but for nodes.close.
  const tracked = tracker.effects();
  const forged = forge?.effects() ?? {};
  const documented = docs?.effects() ?? {};
  const types = new Map<string, string>();
  for (const [role, table] of [[TRACKER, tracked], [FORGE, forged]] as const) {
    for (const type of Object.keys(table)) if (type !== NODES_CLOSE_EFFECT) claim(types, "effect type", type, role);
  }
  const closers = [...(tracked[NODES_CLOSE_EFFECT] ? [TRACKER] : []), ...(forged[NODES_CLOSE_EFFECT] ? [FORGE] : [])];
  if (closers.length > 0) claim(types, "effect type", NODES_CLOSE_EFFECT, closers.join(" and "));
  for (const type of Object.keys(documented)) claim(types, "effect type", type, DOCS);
  const acts: EffectTable = { ...tracked, ...forged };

  /*
   * nodes.close, split by what each id is in the snapshot's graph: an item
   * is the tracker's to close and a pull request the forge's. Anything else —
   * an id the graph does not hold, a document, a placeholder that is only the
   * other end of a relationship — is a kind no role closes, and closing it
   * some other way would be a guess.
   *
   * In the order planned, one run of consecutive ids per role: core orders a
   * close so a pull request is dropped before the item it implements, and
   * grouping by role would undo that.
   */
  const split = (snapshot: Snapshot | undefined, effect: Effect): Array<[EffectHandler, Effect]> => {
    const graph = snapshot?.graph as Graph | undefined;
    if (!graph) throw new Error("a nodes.close effect cannot be checked: the snapshot has no graph");
    const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
    const runs: Array<[EffectHandler, string[]]> = [];
    for (const id of (effect.ids as string[] | undefined) ?? []) {
      const node = nodes.get(id);
      const handler = node === undefined ? undefined
        : isItemNode(node) ? tracked[NODES_CLOSE_EFFECT]
          : node.kind === PULL_REQUEST_KIND ? forged[NODES_CLOSE_EFFECT] : undefined;
      if (!handler) {
        const what = node === undefined ? "which is not in the snapshot's graph"
          : node.placeholder === true ? "the other end of a relationship" : `a ${node.kind}`;
        throw new Error(`nodes.close names "${id}", ${what}, and no role closes it`);
      }
      const last = runs.at(-1);
      if (last?.[0] === handler) last[1].push(id);
      else runs.push([handler, [id]]);
    }
    return runs.map(([handler, ids]) => [handler, { ...effect, ids }]);
  };

  // Briefings: the tracker's and the forge's under `project`, beside the one
  // history both give entries to; the docs' under `spec`.
  const keys = new Map<string, string>([["history", "the history the tracker and the forge share"]]);
  const briefs: BriefTable = {};
  for (const [role, table] of [[TRACKER, tracker.briefs()], [FORGE, forge?.briefs() ?? {}]] as const) {
    for (const [key, read] of Object.entries(table)) {
      claim(keys, "briefing key", key, role);
      briefs[key] = read;
    }
  }
  briefs.history = async (ctx) => historyBrief([...(await tracker.history(ctx)), ...(forge ? await forge.history(ctx) : [])]);

  // Snapshot paths, by their top-level key: the fragments merge one level
  // deep, so a role providing `item.pulls` beside the tracker's `item`
  // would replace the tracker's whole reading of the item with its own.
  const tops = new Map<string, string>();
  const trackerPaths = tracker.provides();
  const forgePaths = forge?.provides() ?? [];
  for (const [role, paths] of [[TRACKER, trackerPaths], [FORGE, forgePaths]] as const) {
    for (const top of new Set(paths.map((path) => path.split(".")[0] ?? path))) claim(tops, "snapshot path", top, role);
  }

  const relations = [...tracker.relations(), ...(forge?.relations() ?? []), ...(docs?.relations() ?? [])];
  // The tracker's own items, never a placeholder: a related item it holds
  // only as an edge's far end has no neighbourhood here, so no other role is
  // asked about it — and none can then report its id beside the tracker.
  const itemsIn = (graph: Graph): string[] =>
    graph.nodes.filter(isItemNode).map((n) => n.id);
  const none: Graph = { nodes: [], relationships: [] };

  const hooks: ComposedHooks = {
    preflight: definePreflight({
      id: PROJECT,
      check: async (ctx) => {
        for (const [role, integration] of present) {
          try {
            // The forge base's own options first: nothing the vendor's check
            // proves helps a template that cannot be read.
            if (integration === forge) await forge.checkOptions(ctx);
            await integration.check?.(ctx);
          } catch (e) {
            throw new Error(`${role}: ${messageOf(e)}`);
          }
        }
      },
    }),

    source: defineSource({
      id: PROJECT,
      relations,
      list: async (ctx) => {
        const items = await tracker.list(ctx);
        const listed = new Set(itemsIn(items));
        return merged([
          [TRACKER, items],
          [FORGE, forge ? await forge.list(listed, ctx) : none],
          [DOCS, docs ? await docs.list(listed, ctx) : none],
        ]);
      },
      read: async (id, ctx) => {
        const items = await tracker.read(id, ctx);
        // ponytail: `item` throwing reads as "no such item", a failed call
        // too — asked only of a landrace/ head outside the neighbourhood, which
        // is rare; a tracker-side `exists` if an outage there ever misroutes.
        const isItem = (item: string): Promise<boolean> => tracker.item(item, ctx).then(() => true, () => false);
        return merged([
          [TRACKER, items],
          [FORGE, forge ? await forge.read(itemsIn(items), ctx, isItem) : none],
          [DOCS, docs ? await docs.read(id, ctx) : none],
        ]);
      },
      brief: (ctx, keys) => briefAll(briefs, ctx, keys),
      // The checkout's remote is the forge's: with none, nothing is fetched.
      ...(forge ? { remoteHead: (branch: string, ctx: RuntimeContext) => forge.remoteHead(branch, ctx) } : {}),
    }),

    operator: defineOperator({
      id: PROJECT,
      createItem: (input, ctx) => tracker.createItem(input, ctx),
      updateItem: (id, patch, ctx) => tracker.updateItem(id, patch, ctx),
      relates: () => tracker.relates(),
      relate: (item, type, other, ctx) => tracker.relate(item, type, other, ctx),
      unrelate: (item, type, other, ctx) => tracker.unrelate(item, type, other, ctx),
      checkRelate: (item, type, other, ctx) => tracker.checkRelate(item, type, other, ctx),
    }),

    pre: definePreHook({
      id: PROJECT,
      provides: [...trackerPaths, ...forgePaths],
      run: async (ctx) => ({ ...(await tracker.observe(ctx)), ...(forge ? await forge.observe(ctx) : {}) }),
    }),

    post: definePostHook({
      id: PROJECT,
      handles: Object.keys(acts),
      // Where the tracker's `tracker.create` files issues, for `validate` to hold a workflow to.
      creates: tracker.createsIn(),
      satisfied: (snapshot, effect) =>
        effect.type === NODES_CLOSE_EFFECT
          ? split(snapshot, effect).every(([handler, part]) => handler.satisfied(snapshot, part))
          : handlerIn(acts, effect).satisfied(snapshot, effect),
      apply: async (effect, ctx) => {
        if (effect.type !== NODES_CLOSE_EFFECT) return handlerIn(acts, effect).apply(effect, ctx);
        for (const [handler, part] of split(ctx.snapshot, effect)) await handler.apply(part, ctx);
      },
    }),
  };

  if (!docs) return hooks;
  const docBriefs = docs.briefs();
  return {
    ...hooks,
    spec: defineArtifactHook({
      id: SPEC,
      handles: Object.keys(documented),
      read: (ctx) => docs.observe(ctx),
      brief: (ctx, keys) => briefAll(docBriefs, ctx, keys),
      satisfied: (snapshot, effect) => handlerIn(documented, effect).satisfied(snapshot, effect),
      apply: (effect, ctx) => handlerIn(documented, effect).apply(effect, ctx),
    }),
  };
}
