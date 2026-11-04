import type { RuntimeSlot } from "#namespace.js";

/**
 * The runtime the loop and the front door use now. Empty until the first
 * `reload`. A build that throws leaves the previous runtime in place: a
 * paste that broke the hooks' load must not take down a board that was
 * running. `onSwap` is handed what was replaced, so its owner can let go of
 * what only that runtime held — its MCP sessions, say.
 *
 * Reloads are chained, so two connects at once build one after the other
 * and the later one's build is the one left standing.
 */
export function createRuntimeSlot<T>(
  build: () => Promise<T | null>,
  opts: { onSwap?: (previous: T | null, next: T | null) => void | Promise<void> } = {},
): RuntimeSlot<T> {
  let current: T | null = null;
  let chain: Promise<void> = Promise.resolve();
  return {
    current: () => current,
    reload: () => {
      const next = chain.then(async () => {
        const built = await build();
        const previous = current;
        current = built;
        await opts.onSwap?.(previous, built);
      });
      // The chain itself never rejects, so one failed build does not fail every later reload.
      chain = next.catch(() => {});
      return next;
    },
  };
}
