import type { Executor, ScriptedAnswer } from "../namespace.js";

/**
 * Canned output per stage, so every branch of a workflow is reachable on
 * demand.
 *
 * A stub is required here rather than preferred: no real model produces
 * questions, then a spec, then a rejection, then an approval, in that order,
 * and a workflow's interesting property is the order its stages run in.
 *
 * Keyed by stage, and told which stage is running rather than guessing. The
 * agent contract deliberately carries no step identity — an executor is handed
 * a prompt — so the only honest sources are the caller's own knowledge of
 * where the engine is, which is what `at` supplies, or a substring search of
 * the prompt, which is a guess that goes wrong the first time one step's
 * prompt quotes another's name.
 */
export function scriptedExecutor(
  answers: { [stage: string]: ScriptedAnswer },
  at: () => { stage: string; round: number },
): Executor {
  return {
    id: "scripted",
    run: async (_prompt, opts) => {
      const { stage, round } = at();
      const answer = answers[stage];
      if (answer === undefined) {
        // Loud, and named. A silent default answer is a step that "ran" and
        // produced something nobody wrote, which is the one thing a scripted
        // executor exists to rule out.
        throw new Error(
          `nothing is scripted for stage "${stage}": the workflow invoked it and the script has ` +
          `${Object.keys(answers).length === 0 ? "no stages" : Object.keys(answers).map((s) => `"${s}"`).join(", ")}`,
        );
      }
      return {
        text: typeof answer === "function" ? answer(round) : answer,
        sessionId: `scripted-${stage}-${opts.round}`,
      };
    },
  };
}
