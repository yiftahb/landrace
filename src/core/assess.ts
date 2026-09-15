import type { Run, Snapshot, Stage, SubState } from "./types.js";

/**
 * Invalid output is a property of the step, not of the position, and must be
 * read before completeness — otherwise a rejected result looks like work that
 * never happened and the step is retried, which the contract forbids.
 */
export function assess(s: Snapshot, stage: Stage): SubState {
  const run = (s.run ?? { counters: {}, outputs: {} }) as Run;
  if (run.lastOutputValid === false) return "failed";
  if (!stage.step) return "complete";
  return run.outputs[stage.id] === undefined ? "pending" : "complete";
}
