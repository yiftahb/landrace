import { compile } from "#core/predicate.js";
import type { Location, Snapshot, Stage, Workflow } from "#namespace.js";

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
