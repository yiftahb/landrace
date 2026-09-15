import { decide, planEffects, reconcile, type Effect, type Snapshot, type Workflow } from "../core/index.js";
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
  /** Set on "wait" and "halt": which of several possible causes this was, so a caller does not have to re-derive it from the log stream. */
  why?: string;
}

/** Generous. The real bound on a run is the workflow's iteration budget. */
const DEFAULT_MAX_PASSES = 30;

/**
 * GitHub's real comment cap is 65,536 characters. This is far below it on
 * purpose: the reason embedded here can carry a workflow-declared shape name
 * of arbitrary length (step.ts only bounds the *unvalidated* discriminator
 * value, not a validated shape's own name), and whatever survives here still
 * gets a trailing marker appended after it.
 */
const MAX_MALFORMED_BODY = 4000;

function malformedBody(reason: string): string {
  const full = `## Step output rejected\n\n${reason}. Nothing was retried.`;
  return full.length > MAX_MALFORMED_BODY ? `${full.slice(0, MAX_MALFORMED_BODY)}\n\n…[truncated]` : full;
}

/**
 * Act on one ticket until the next move depends on something outside the loop.
 * Doing one thing per poll would put a whole interval between "moved to a
 * stage" and "ran its step", with nothing external happening in between.
 */
export async function converge(ticket: number, deps: ConvergeDeps): Promise<ConvergeResult> {
  const maxPasses = deps.maxPasses ?? DEFAULT_MAX_PASSES;

  // A fixed-point check scoped to this one call, not a ledger: "state is
  // derived, never stored" still holds because nothing here survives past
  // the return. Its job is narrower than validate.ts's step-output-required
  // rule (which only catches a step declaring no output at all, and only
  // before the workflow ever runs) — this also catches the general case, a
  // hook whose apply() "succeeds" but leaves nothing readable back, at
  // runtime, for any reason. Without it that case invokes (and pays for) the
  // same round on every single pass up to maxPasses, which is exactly what
  // happened against the shipped workflow: 30 opus invocations in one call.
  const invoked = new Set<string>();

  for (let pass = 1; pass <= maxPasses; pass++) {
    // Checked before doing any work this pass: a Ctrl-C between two passes
    // was previously invisible until whatever ran next happened to touch the
    // signal itself (deep inside runStep's executor call). A pass that has
    // not started yet should simply not start.
    if (deps.ctx.signal.aborted) {
      return { passes: pass - 1, settled: "halt", why: "the run was aborted" };
    }

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
      const why = decision.why ?? "not eligible";
      deps.log("ticket.skipped", { ticket, reason: why });
      return { passes: pass, settled: "wait", why };
    }
    if (decision.action === "wait") return { passes: pass, settled: "wait", why: decision.why ?? "no trigger matched" };

    if (decision.action === "invoke") {
      const stage = decision.stage;
      const round = decision.round ?? 1;
      const step = stage?.step ? deps.steps.get(stage.step) : undefined;

      if (!stage || !step) {
        const reason = `stage "${stage?.id}" names a step that is not loaded`;
        deps.log("step.rejected", { ticket, reason });
        // M2: the malformed path posts a durable record; a workflow naming a
        // step that never loaded is just as much a reason a ticket is stuck,
        // and an operator watching the ticket deserves the same trace.
        if (stage) {
          const posted = await tryApply(
            [malformedEffect(stage.id, round, reason)],
            ticket, snapshot, deps,
          );
          if (!posted.ok) deps.log("effect.failed", { ticket, reason: posted.reason });
        }
        return { passes: pass, settled: "halt", why: reason };
      }

      // Scoped to (stage, round): decide() computes round from
      // run.counters, which only advances on a genuine "output" entry. A
      // step that ran and left nothing readable gets asked again next pass
      // with the *same* round — this is what catches that the second time,
      // rather than paying for a third, a fourth, a thirtieth attempt.
      const key = `${stage.id}:${round}`;
      if (invoked.has(key)) {
        const reason = `stage "${stage.id}" round ${round} was already invoked this call and left nothing readable; not retrying`;
        deps.log("step.rejected", { ticket, stage: stage.id, round, reason });
        return { passes: pass, settled: "halt", why: reason };
      }
      invoked.add(key);

      const result = await runStep({
        step, stageId: stage.id, round, snapshot,
        executor: deps.executor, signal: deps.ctx.signal,
        ...(deps.screen ? { screen: deps.screen } : {}),
        log: deps.log,
      });

      if (!result.ok) {
        deps.log("step.rejected", { ticket, stage: stage.id, round, kind: result.kind, reason: result.reason });

        if (result.kind === "unavailable") {
          // The step never ran at all — screened out, or the executor threw
          // (a network blip, a timeout, a Ctrl-C). Nothing was produced, so
          // there is nothing to reject: no durable record, so the next tick
          // re-derives "pending" from the tracker and legitimately retries.
          // A record here would be CLAUDE.md's hard-fail rule pointed the
          // wrong way — that rule is about a step whose *output* was
          // rejected, and this step has no output to reject.
          return { passes: pass, settled: "halt", why: result.reason };
        }

        // "contract": the step ran and broke it. Recorded and stopped; the
        // engine routes it on the next pass by whatever trigger reads
        // run.lastOutputValid, but this path never decides anything, and it
        // never invokes the step again in this same call — that is the
        // whole point of a hard fail: a rejected round looks nothing like a
        // round that never ran, so nothing here retries it.
        const posted = await tryApply(
          [malformedEffect(stage.id, round, result.reason)],
          ticket, snapshot, deps,
        );
        if (!posted.ok) deps.log("effect.failed", { ticket, reason: posted.reason });
        return { passes: pass, settled: "halt", why: result.reason };
      }

      // No reconcile-before-apply here, on purpose. `satisfied` asks whether
      // the *world* already shows an effect as landed; after a crash between
      // "the step succeeded" and "the effect posted", the world shows
      // nothing, because the crash happened before the post ever went out —
      // so the check would find "not satisfied" and apply anyway, having
      // spent an extra read for a check that could never have said otherwise.
      // A guard downstream of the invocation cannot prevent the invocation:
      // the money for this round is already spent by the time control
      // reaches this line. Closing that window needs a marker written
      // *before* the agent runs, which is its own brief.
      const applied = await tryApply(result.effects, ticket, snapshot, deps);
      if (!applied.ok) {
        deps.log("effect.failed", { ticket, reason: applied.reason });
        return { passes: pass, settled: "halt", why: applied.reason };
      }
      continue;
    }

    // transition or halt: the effects of the state being entered.
    const planned = planEffects(decision);
    const reconciled = tryReconcile(snapshot, planned, deps.dispatcher.satisfied);
    if (!reconciled.ok) {
      deps.log("effect.failed", { ticket, reason: reconciled.reason });
      return { passes: pass, settled: "halt", why: reconciled.reason };
    }
    const surviving = reconciled.surviving;
    for (const dropped of planned.filter((e) => !surviving.includes(e))) {
      deps.log("effect.discarded", { ticket, type: dropped.type });
    }
    const applied = await tryApply(surviving, ticket, snapshot, deps);
    if (!applied.ok) {
      deps.log("effect.failed", { ticket, reason: applied.reason });
      return { passes: pass, settled: "halt", why: applied.reason };
    }

    if (decision.action === "halt") return { passes: pass, settled: "halt", why: decision.why ?? "the workflow halted" };
    if (decision.to?.terminal) return { passes: pass, settled: "terminal" };
    if (surviving.length === 0 && decision.action === "transition") {
      // Nothing left to do and nothing changed: a fixed point, not the same
      // thing as a genuine wait on a human or an external trigger — those
      // report their own `why` above, via decision.why.
      return {
        passes: pass, settled: "wait",
        why: `transitioned to stage "${decision.to?.id}" with nothing left to apply (fixed point)`,
      };
    }
  }

  deps.log("ticket.evaluated", { ticket, decision: "cap", why: `hit ${maxPasses} passes without settling` });
  return { passes: maxPasses, settled: "cap" };
}

function malformedEffect(stage: string, round: number, reason: string): Effect {
  return {
    type: "tracker.comment", kind: "malformed", stage, round,
    marker: `malformed:${stage}:${round}`,
    body: malformedBody(reason),
  };
}

/**
 * `reconcile` is synchronous but calls `dispatcher.satisfied`, which the
 * dispatcher itself documents as attributing and rethrowing a throwing
 * hook's error rather than swallowing it as "not satisfied" (effects.ts).
 * Nothing previously caught that throw here, so a broken hook escaped
 * converge entirely as an unhandled rejection — the caller got a crash
 * instead of the ConvergeResult its own return type promises. CLAUDE.md:
 * errors report, they do not crash.
 */
function tryReconcile(
  snapshot: Snapshot,
  planned: Effect[],
  satisfied: Dispatcher["satisfied"],
): { ok: true; surviving: Effect[] } | { ok: false; reason: string } {
  try {
    return { ok: true, surviving: reconcile(snapshot, planned, satisfied) };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

/** Same reasoning as tryReconcile, for the apply side: apply() can reject too (a rate limit, a broken hook), from both the invoke path and the transition path. */
async function tryApply(
  effects: Effect[],
  ticket: number,
  snapshot: Snapshot,
  deps: ConvergeDeps,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await applyAll(effects, ticket, snapshot, deps);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

async function applyAll(
  effects: Effect[],
  ticket: number,
  snapshot: Snapshot,
  deps: ConvergeDeps,
): Promise<void> {
  for (const effect of effects) {
    deps.log("effect.planned", { ticket, type: effect.type });
    await deps.dispatcher.apply(effect, { ...deps.ctx, ticket, snapshot });
    deps.log("effect.applied", { ticket, type: effect.type });
  }
}
