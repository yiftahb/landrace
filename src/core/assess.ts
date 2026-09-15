import type { Run, Snapshot, Stage, SubState } from "./types.js";

/**
 * Invalid output is a property of the step, not of the position, and must be
 * read before completeness — otherwise a rejected result looks like work that
 * never happened and the step is retried, which the contract forbids.
 *
 * Failure is scoped to the stage being assessed, via failedStages, not to
 * whichever stage the run happens to carry as `lastOutputValid` — deriveRun
 * scopes that field to the `stage` it was given, but locate() can place this
 * ticket at a *different* stage (a custom identity predicate), and this
 * function must answer for the stage it was actually asked about. A run
 * built by hand without failedStages (as plenty of tests do) falls back to
 * the single-stage lastOutputValid field, matching the old behaviour.
 */
export function assess(s: Snapshot, stage: Stage): SubState {
  const run = (s.run ?? { counters: {}, outputs: {} }) as Run;
  const failed = run.failedStages ? run.failedStages.includes(stage.id) : run.lastOutputValid === false;
  if (failed) return "failed";
  if (!stage.step) return "complete";
  return run.outputs[stage.id] === undefined ? "pending" : "complete";
}
