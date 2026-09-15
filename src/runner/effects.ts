import type { Effect, Snapshot } from "../core/index.js";
import type { HookContext, PostHook } from "../hooks/types.js";

export interface Dispatcher {
  satisfied(s: Snapshot, e: Effect): boolean;
  apply(e: Effect, ctx: HookContext): Promise<void>;
  handlerFor(type: string): PostHook | null;
}

export function createDispatcher(hooks: PostHook[]): Dispatcher {
  const byType = new Map<string, PostHook>();

  for (const hook of hooks) {
    for (const type of hook.handles) {
      const existing = byType.get(type);
      // Ambiguity halts here as everywhere else: two hooks claiming one effect
      // type is a configuration error, not a race to resolve by order.
      if (existing) {
        throw new Error(`two post hooks handle "${type}": "${existing.id}" and "${hook.id}"`);
      }
      byType.set(type, hook);
    }
  }

  const handlerFor = (type: string): PostHook | null => byType.get(type) ?? null;

  return {
    handlerFor,

    // An effect nobody handles is not satisfied. Reporting it as satisfied
    // would silently drop the work; apply() then reports it loudly instead.
    satisfied: (s, e) => handlerFor(e.type)?.satisfied(s, e) ?? false,

    async apply(e, ctx) {
      const hook = handlerFor(e.type);
      if (!hook) throw new Error(`no post hook handles "${e.type}"`);
      try {
        await hook.apply(e, ctx);
      } catch (err) {
        throw new Error(`post hook "${hook.id}" failed applying "${e.type}": ${(err as Error).message}`);
      }
    },
  };
}
