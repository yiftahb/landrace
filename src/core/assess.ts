import type { Run, Snapshot, Stage, SubState } from "#namespace.js";

/**
 * Invalid output is a property of the step, not of the position, and must be
 * read before completeness — otherwise a rejected result looks like work that
 * never happened and the step is retried, which the contract forbids.
 *
 * Failure is scoped to the stage being assessed, via failedStages, not to
 * whichever stage the run happens to carry as `lastOutputValid` — deriveRun
 * scopes that field to the `stage` it was given, but locate() can place this
 * item at a *different* stage (a custom identity predicate), and this
 * function must answer for the stage it was actually asked about.
 * failedStages is required on Run precisely so there is no fallback path
 * back to the whole-run lastOutputValid check that caused that bug: every
 * Run — hand-built in a test or produced by deriveRun — must say so.
 */
export function assess(s: Snapshot, stage: Stage): SubState {
  const run = (s.run ?? { counters: {}, outputs: {}, failedStages: [], rounds: {} }) as Run;
  if (run.failedStages.includes(stage.id)) return "failed";
  if (!stage.step) return "complete";

  /*
   * Completeness is per round, not per lifetime. `run.outputs[stage.id] !==
   * undefined` said a stage was done forever the first time it produced
   * anything, which made every stage one-shot: §10 routes back into
   * code-review after fix-review, and code-review — "complete" — simply did
   * not run, so the item ping-ponged between two finished stages until the
   * pass cap and run.counters."code-review" stayed at 1, leaving the
   * workflow's own { $lt: 4 } bound unreachable.
   *
   * A stage that records no entry reads as entered once, so `output >=
   * entered` is exactly the old rule for it: any output at all completes it.
   */
  const { entered, output } = run.rounds[stage.id] ?? { entered: 1, output: 0 };
  return output >= entered ? "complete" : "pending";
}
