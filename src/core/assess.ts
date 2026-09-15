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
 * function must answer for the stage it was actually asked about.
 * failedStages is required on Run precisely so there is no fallback path
 * back to the whole-run lastOutputValid check that caused that bug: every
 * Run — hand-built in a test or produced by deriveRun — must say so.
 */
export function assess(s: Snapshot, stage: Stage): SubState {
  const run = (s.run ?? { counters: {}, outputs: {}, failedStages: [] }) as Run;
  if (run.failedStages.includes(stage.id)) return "failed";
  if (!stage.step) return "complete";
  return run.outputs[stage.id] === undefined ? "pending" : "complete";
}
