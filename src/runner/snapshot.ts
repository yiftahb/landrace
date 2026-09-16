import { createHash } from "node:crypto";
import { deriveRun, hashSnapshot } from "../core/index.js";
import type { Entry, Snapshot } from "../namespace.js";
import { stageFromLabels } from "../conventions.js";
import { messageOf } from "./errors.js";
import type { HookContext, PreHook } from "../hooks/types.js";

/**
 * Pre hooks run in declaration order, each seeing what previous hooks produced.
 * That is why order is declared rather than inferred, and it is what lets a
 * computing hook read a fetching hook's output without a second hook kind.
 */
const sha256 = (input: string): string => createHash("sha256").update(input).digest("hex");

export async function buildSnapshot(opts: {
  ticket: number;
  hooks: PreHook[];
  ctx: Omit<HookContext, "snapshot">;
  now?: number;
  digest?: (input: string) => string;
}): Promise<Snapshot> {
  let snapshot: Snapshot = {};

  for (const hook of opts.hooks) {
    try {
      const fragment = await hook.run({ ...opts.ctx, snapshot });
      snapshot = { ...snapshot, ...fragment };
    } catch (e) {
      // `messageOf`, not `(e as Error).message`: a hook is a plain interface
      // (a tracker's pre hook does real network I/O), and nothing stops one
      // from rejecting with something that is not an Error — that access
      // would throw from inside this very catch, replacing an attributed
      // failure with a raw, unattributed one.
      throw new Error(`pre hook "${hook.id}" failed: ${messageOf(e)}`);
    }
  }

  const labels = ((snapshot.ticket as { labels?: string[] } | undefined)?.labels ?? []);
  const entries = (snapshot.entries as Entry[] | undefined) ?? [];

  // Time enters here and nowhere else: core may not read a clock.
  const withRun: Snapshot = {
    ...snapshot,
    now: opts.now ?? Date.now(),
    run: deriveRun(entries, stageFromLabels(labels).stage),
  };

  // Recorded, not yet used: the decision cache reads it later. Computed after
  // every hook has contributed, over canonicalised input with volatile fields
  // stripped, so it is stable across ticks that changed nothing.
  return { ...withRun, hash: hashSnapshot(withRun, opts.digest ?? sha256) };
}
