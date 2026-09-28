import { mkdirSync, unwatchFile, watchFile, writeFileSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import { sandboxRoot } from "#sandbox.js";

/**
 * How `landrace mcp` tells a running `landrace start` that a person just
 * wrote: a file both find under the per-repository root their locks already
 * share, so nothing has to be configured and a second repository's loop is
 * never the one woken. The file says nothing; its mtime is the message.
 */
export const wakePath = (dir: string): string => join(sandboxRoot(dir), "wake");

export function touchWake(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
}

/**
 * `fs.watchFile` rather than `fs.watch`: it polls with `stat`, which behaves
 * the same on every platform and copes with a file that does not exist yet —
 * a missing file reads as mtime 0, so creating it counts as a touch. Several
 * touches inside one interval are one wake, which is all the loop needs.
 *
 * Not persistent: a watcher must never be what keeps a stopping daemon alive.
 */
export function watchWake(path: string, wake: () => void, intervalMs = 1000): () => void {
  const listener = (curr: Stats, prev: Stats): void => {
    if (curr.mtimeMs > prev.mtimeMs) wake();
  };
  watchFile(path, { interval: intervalMs, persistent: false }, listener);
  return () => unwatchFile(path, listener);
}
