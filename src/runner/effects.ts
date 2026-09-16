import type { Dispatcher, PostHook } from "#namespace.js";
import { messageOf } from "#runner/errors.js";

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
    // But a handler that throws is attributed and rethrown, not swallowed as
    // false: treating a check failure as "not satisfied" would re-apply an
    // effect that may already have landed, silently duplicating it. Rethrowing
    // aborts just this ticket's tick (tick() catches per ticket) and names the
    // broken hook, mirroring apply()'s wording. `messageOf`, not
    // `(err as Error).message`: a hook is a plain interface, and nothing
    // stops one from throwing a non-Error — that raw access does not
    // crash this dispatcher (the caller's own try/catch still stops it going
    // further), but it does lose the attribution this function exists to
    // add, surfacing a bare "Cannot read properties of null" instead of
    // naming which hook and effect actually failed.
    satisfied(s, e) {
      const hook = handlerFor(e.type);
      if (!hook) return false;
      try {
        return hook.satisfied(s, e);
      } catch (err) {
        throw new Error(`post hook "${hook.id}" failed checking "${e.type}": ${messageOf(err)}`);
      }
    },

    async apply(e, ctx) {
      const hook = handlerFor(e.type);
      if (!hook) throw new Error(`no post hook handles "${e.type}"`);
      try {
        await hook.apply(e, ctx);
      } catch (err) {
        throw new Error(`post hook "${hook.id}" failed applying "${e.type}": ${messageOf(err)}`);
      }
    },
  };
}
