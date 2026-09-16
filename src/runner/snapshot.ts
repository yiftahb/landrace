import { createHash } from "node:crypto";
import { deriveRun, hashSnapshot } from "../core/index.js";
import type { Entry, Snapshot } from "../namespace.js";
import { stageFromLabels } from "../conventions.js";
import { messageOf } from "./errors.js";
import type { HookContext, PreHook } from "../namespace.js";

/**
 * Pre hooks run in declaration order, each seeing what previous hooks produced.
 * That is why order is declared rather than inferred, and it is what lets a
 * computing hook read a fetching hook's output without a second hook kind.
 */
const sha256 = (input: string): string => createHash("sha256").update(input).digest("hex");

/**
 * What the engine itself puts in every snapshot, in the vocabulary a hook's
 * `provides` uses.
 *
 * Declared here because this is the function that adds them — `now`, the
 * derived `run`, and the hash over both. Without them §11's path-coverage rule
 * would flag `run.stage`, a path every workflow reads and no hook provides,
 * and a validator that flags healthy workflows gets switched off.
 *
 * Spelled out field by field rather than as a bare `run.*`, because the bug
 * the rule exists to catch is a path that reads *nothing*: `outputs.spec.kind`
 * and `lastEvent.actor` both looked right, matched nothing, and left half the
 * shipped workflow unreachable. A test keeps this list level with what
 * deriveRun actually returns.
 */
export const ENGINE_PROVIDES: readonly string[] = [
  "now",
  "hash",
  "run.stage",
  // Both forms, deliberately. A bare `run.counters*` would also cover
  // `run.countersss`, and a lone `run.counters.*` would not cover the map
  // itself — the point of the rule is that a path off by one letter is caught.
  "run.counters", "run.counters.*",
  "run.rounds", "run.rounds.*",
  "run.outputs", "run.outputs.*",
  "run.lastEvent", "run.lastEvent.*",
  "run.lastHuman", "run.lastHuman.*",
  "run.lastOutputValid",
  "run.failedStages",
  "run.unblockedAt",
];

/**
 * Every snapshot path something claims to provide, or null to check none of
 * them.
 *
 * Null is an abstention, and §4 says where it comes from: "Declare nothing and
 * you opt out." The opt-out is for the whole graph rather than for the silent
 * hook's own paths, because nothing can tell which paths a hook that declares
 * nothing contributes — so checking the rest would mean reporting a possibly
 * wrong result about a workflow that is fine. It is the same answer the
 * cycle-bound rule gives for a trigger it cannot analyse.
 */
export function snapshotProvides(pre: PreHook[]): string[] | null {
  if (pre.length === 0) return null;
  if (pre.some((hook) => hook.provides === undefined)) return null;
  return [...ENGINE_PROVIDES, ...pre.flatMap((hook) => hook.provides ?? [])];
}

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
