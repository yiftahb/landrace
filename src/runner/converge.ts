import { decide, planEffects, reconcile, type Workflow } from "../core/index.js";
import type { Executor, HookContext, PreHook } from "../hooks/types.js";
import type { Step } from "../workflow/load.js";
import type { Dispatcher } from "./effects.js";
import type { Logger } from "./events.js";
import { buildSnapshot } from "./snapshot.js";
import { runStep } from "./step.js";

export interface ConvergeDeps {
  workflow: Workflow;
  steps: Map<string, Step>;
  pre: PreHook[];
  dispatcher: Dispatcher;
  executor: Executor;
  screen?: { executor: Executor };
  ctx: Omit<HookContext, "snapshot">;
  log: Logger;
  maxPasses?: number;
}

export interface ConvergeResult {
  passes: number;
  settled: "wait" | "halt" | "terminal" | "cap";
}

/** Generous. The real bound on a run is the workflow's iteration budget. */
const DEFAULT_MAX_PASSES = 30;

/**
 * Act on one ticket until the next move depends on something outside the loop.
 * Doing one thing per poll would put a whole interval between "moved to a
 * stage" and "ran its step", with nothing external happening in between.
 */
export async function converge(ticket: number, deps: ConvergeDeps): Promise<ConvergeResult> {
  const maxPasses = deps.maxPasses ?? DEFAULT_MAX_PASSES;

  for (let pass = 1; pass <= maxPasses; pass++) {
    // Re-read rather than simulate what our own writes did: one model of what
    // an effect means, not two that can disagree.
    const snapshot = await buildSnapshot({ ticket, hooks: deps.pre, ctx: deps.ctx });
    const decision = decide(deps.workflow, snapshot);

    deps.log("ticket.evaluated", {
      ticket, pass,
      stage: decision.stage?.id ?? null,
      subState: decision.subState ?? null,
      decision: decision.action,
      why: decision.why ?? decision.trigger ?? null,
    });

    if (decision.action === "skip") {
      deps.log("ticket.skipped", { ticket, reason: decision.why ?? "not eligible" });
      return { passes: pass, settled: "wait" };
    }
    if (decision.action === "wait") return { passes: pass, settled: "wait" };

    if (decision.action === "invoke") {
      const stage = decision.stage;
      const step = stage?.step ? deps.steps.get(stage.step) : undefined;
      if (!stage || !step) {
        deps.log("step.rejected", { ticket, reason: `stage "${stage?.id}" names a step that is not loaded` });
        return { passes: pass, settled: "halt" };
      }

      const round = decision.round ?? 1;
      const result = await runStep({
        step, stageId: stage.id, round, snapshot,
        executor: deps.executor, signal: deps.ctx.signal,
        ...(deps.screen ? { screen: deps.screen } : {}),
        log: deps.log,
      });

      if (!result.ok) {
        // A step that broke its contract records the fact and stops. The engine
        // routes it on the next pass; this path never decides anything, and it
        // never invokes the step again in this same call — that is the whole
        // point of a hard fail: a rejected round looks nothing like a round
        // that never ran, so nothing here will retry it.
        deps.log("step.rejected", { ticket, stage: stage.id, round, reason: result.reason });
        await applyAll(
          [{ type: "tracker.comment", kind: "malformed", stage: stage.id, round, marker: `malformed:${stage.id}:${round}`, body: `## Step output rejected\n\n${result.reason}. Nothing was retried.` }],
          ticket, snapshot, deps,
        );
        return { passes: pass, settled: "halt" };
      }

      await applyAll(result.effects, ticket, snapshot, deps);
      continue;
    }

    // transition or halt: the effects of the state being entered.
    const planned = planEffects(decision);
    const surviving = reconcile(snapshot, planned, deps.dispatcher.satisfied);
    for (const dropped of planned.filter((e) => !surviving.includes(e))) {
      deps.log("effect.discarded", { ticket, type: dropped.type });
    }
    await applyAll(surviving, ticket, snapshot, deps);

    if (decision.action === "halt") return { passes: pass, settled: "halt" };
    if (decision.to?.terminal) return { passes: pass, settled: "terminal" };
    if (surviving.length === 0 && decision.action === "transition") {
      // Nothing left to do and nothing changed: a fixed point.
      return { passes: pass, settled: "wait" };
    }
  }

  deps.log("ticket.evaluated", { ticket, decision: "cap", why: `hit ${maxPasses} passes without settling` });
  return { passes: maxPasses, settled: "cap" };
}

async function applyAll(
  effects: Parameters<Dispatcher["apply"]>[0][],
  ticket: number,
  snapshot: Awaited<ReturnType<typeof buildSnapshot>>,
  deps: ConvergeDeps,
): Promise<void> {
  for (const effect of effects) {
    deps.log("effect.planned", { ticket, type: effect.type });
    await deps.dispatcher.apply(effect, { ...deps.ctx, ticket, snapshot });
    deps.log("effect.applied", { ticket, type: effect.type });
  }
}
