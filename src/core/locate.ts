import { compile } from "./predicate.js";
import type { Snapshot, Stage, Workflow } from "./types.js";

export type Location =
  | { kind: "at"; stage: Stage }
  | { kind: "none" }
  | { kind: "ambiguous"; ids: string[] }
  | { kind: "unknown"; id: string };

/**
 * Default identity: you are here if the tracker says so.
 * Exported so workflow/validate.ts checks the same definition locate() uses
 * to place a ticket — two copies of this default previously let the
 * validator and the engine silently disagree about where a ticket is.
 */
export const identityOf = (stage: Stage) => stage.identity ?? { "run.stage": stage.id };

export function locate(w: Workflow, s: Snapshot): Location {
  const matches = w.stages.filter((stage) => compile(identityOf(stage))(s));
  if (matches.length > 1) return { kind: "ambiguous", ids: matches.map((m) => m.id) };
  const only = matches[0];
  return only ? { kind: "at", stage: only } : { kind: "none" };
}
