import { ensureWorktree, removeWorktree } from "#agent/worktree.js";
import { decide, planEffects, reconcile } from "#core/index.js";
import { RECORD_EFFECT } from "#conventions.js";
import type { ConvergeDeps, ConvergeResult, Dispatcher, Effect, Snapshot } from "#namespace.js";
import { messageOf } from "#runner/errors.js";
import { MIN_SECRET_LENGTH, redactValue } from "#runner/events.js";
import { buildBriefing } from "#runner/artifacts.js";
import { buildSnapshot, positionProblem } from "#runner/snapshot.js";
import { runStep } from "#runner/step.js";

/** Generous. The real bound on a run is the workflow's iteration budget. */
const DEFAULT_MAX_PASSES = 30;

/**
 * Trackers cap a comment body somewhere in the tens of thousands of
 * characters. This is far below any of them on purpose: the reason embedded
 * here can carry a workflow-declared shape name of arbitrary length (step.ts
 * only bounds the *unvalidated* discriminator value, not a validated shape's
 * own name), and whatever survives here still gets a trailing marker appended
 * after it.
 */
const MAX_MALFORMED_BODY = 4000;

function malformedBody(reason: string, redactValues: string[]): string {
  // `reason` is not our own text: it can carry the screening executor's own
  // error output verbatim ("agent exited N: <up to 400 chars of stderr>"),
  // and stderr can contain a secret the same way any subprocess output can.
  // This comment is public and durable, and redaction until now was
  // log-sink only — a body composed here goes straight to the tracker,
  // bypassing the logger's own redaction entirely.
  const redacted = redactValue(reason, redactValues) as string;
  const full = `## Step output rejected\n\n${redacted}. Nothing was retried.`;
  return full.length > MAX_MALFORMED_BODY ? `${full.slice(0, MAX_MALFORMED_BODY)}\n\n…[truncated]` : full;
}

/**
 * The same secret *values* `createLogger` redacts with — `ctx.secrets` is
 * the resolved name -> value map every hook already receives, so this reuses
 * it rather than threading a second, separately-constructed list through
 * `ConvergeDeps`. Values shorter than `MIN_SECRET_LENGTH` are skipped rather
 * than rejected: `createLogger` throws on one at construction time, but this
 * is an independent consumer of the same raw map, not the list's owner, and
 * a value that short would redact everywhere in this text too.
 */
function redactValuesFrom(secrets: ReadonlyMap<string, string>): string[] {
  // Trimmed once, and that trimmed form is what is both measured *and*
  // returned for actual redaction — checking the trimmed length while
  // filtering the untrimmed value let a secret sourced with surrounding
  // whitespace (a quoted .env line) pass the length check and then never
  // match its own bare form anywhere it actually appeared in posted text.
  return [...secrets.values()].map((v) => v.trim()).filter((v) => v.length >= MIN_SECRET_LENGTH);
}

/**
 * Act on one ticket until the next move depends on something outside the loop.
 * Doing one thing per poll would put a whole interval between "moved to a
 * stage" and "ran its step", with nothing external happening in between.
 */
export async function converge(ticket: number, deps: ConvergeDeps): Promise<ConvergeResult> {
  const root = deps.sandbox?.root;
  let path: string | null = null;

  // Created on the first invoke — a converge that never runs a step never pays
  // for a checkout — and removed when this call unwinds, whichever way it
  // unwinds: a return, a halt, a thrown hook, an agent that timed out, a
  // Ctrl-C. A worktree left behind is a slow disk leak and a `git worktree
  // list` nobody can read; it is also *stored state*, which the next tick
  // would silently build on instead of deriving. Re-creating it from HEAD is
  // this design's ordinary answer — re-derivation, at the price of a checkout.
  const enter = root === undefined
    ? null
    : async (): Promise<string> => (path ??= await ensureWorktree(ticket, root));

  try {
    return await converging(ticket, deps, enter);
  } finally {
    if (path !== null && root !== undefined) await removeWorktree(ticket, root);
  }
}

async function converging(
  ticket: number,
  deps: ConvergeDeps,
  enterSandbox: (() => Promise<string>) | null,
): Promise<ConvergeResult> {
  const maxPasses = deps.maxPasses ?? DEFAULT_MAX_PASSES;
  const redactValues = redactValuesFrom(deps.ctx.secrets);

  // A termination bound, exactly like the `pass` counter above it — not a
  // ledger, and the honest reason it does not violate "state is derived,
  // never stored" is not that "nothing survives past the return" (a real
  // ledger with a short TTL would satisfy that same description and still be
  // exactly the ledger this design forbids). The reason is narrower: this
  // set only ever bounds how many times *this call* repeats a decision it
  // has already acted on, the same way the `pass` loop bounds how many
  // times this call runs at all — it is never consulted to answer "what is
  // true", only "have I already spent this call's budget on this". Its job
  // is narrower than validate.ts's step-output-required rule (which only
  // catches a step declaring no output at all, and only before the workflow
  // ever runs) — this also catches the general case, a hook whose apply()
  // "succeeds" but leaves nothing readable back, at runtime, for any reason.
  //
  // Measured effect against the shipped workflow: 30 paid opus invocations
  // per converge() call, down to 1. That is 30x better, not solved — a
  // crash mid-call loses this set along with everything else about the
  // call, and the next poll starts a fresh one and pays for one invocation
  // again before hitting the same bound. Closing that the rest of the way is
  // exactly the "state is derived, never stored" constraint working as
  // intended: the durable fix is validate.ts rejecting the workflow that
  // produces this shape at all, and giving the step a real output contract,
  // not a bigger or longer-lived set here.
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
    // an effect means, not two that can disagree. Wrapped: a tracker's pre
    // hook does real network I/O, so a pre hook failing here (already
    // attributed by buildSnapshot itself) is the *likely* shape of a broken
    // dependency, not an exotic one, and nothing previously caught it —
    // CLAUDE.md says errors report, they do not crash.
    let snapshot: Snapshot;
    try {
      snapshot = await buildSnapshot({ ticket, hooks: deps.pre, ctx: deps.ctx });
    } catch (e) {
      const reason = messageOf(e);
      deps.log("snapshot.failed", { ticket, reason });
      return { passes: pass, settled: "halt", why: reason };
    }
    // §14's per-pass dump. The logger drops it unless --debug is on, so the
    // decision below is always reported alongside the thing it was decided
    // from, and never at the price of a whole snapshot per pass in a quiet log.
    deps.log("snapshot.built", { ticket, pass, snapshot });

    // Before anything is decided, because acting on an unplaceable ticket is
    // what this closes: two `lr:stage:*` labels used to run a paid step at
    // whichever one came first in the array, and the same ticket with them
    // the other way round ran a different stage. Ambiguity halts here like
    // every other ambiguity in this engine, and like both operator surfaces
    // were already reporting for exactly this ticket.
    const unplaceable = positionProblem(snapshot);
    if (unplaceable) {
      deps.log("ticket.evaluated", { ticket, pass, stage: null, decision: "halt", why: unplaceable });
      return { passes: pass, settled: "halt", why: unplaceable };
    }

    const decision = decide(deps.workflow, snapshot);

    deps.log("ticket.evaluated", {
      ticket, pass,
      stage: decision.stage?.id ?? null,
      // Where it is going, beside where it is. The last transition of a run is
      // never evaluated from its destination — nothing evaluates a terminal
      // ticket — so without this the stage a ticket ended in appears nowhere
      // in the stream, and the only other place to read it is the tracker's
      // own idea of a position, which the engine deliberately does not know.
      to: decision.to?.id ?? null,
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
            [malformedEffect(stage.id, round, reason, redactValues)],
            ticket, snapshot, deps,
          );
          if (!posted.ok) deps.log("effect.failed", { ticket, reason: posted.reason });
        }
        return { passes: pass, settled: "halt", why: reason };
      }

      // Scoped to (stage, round): decide() computes round from
      // run.counters, which only advances on a round that reached a verdict —
      // an output, or a recorded rejection. A step that ran and left neither
      // gets asked again next pass with the *same* round — this is what
      // catches that the second time, rather than paying for a third, a
      // fourth, a thirtieth attempt.
      const key = `${stage.id}:${round}`;
      if (invoked.has(key)) {
        const reason = `stage "${stage.id}" round ${round} was already invoked this call and left nothing readable; not retrying`;
        deps.log("step.rejected", { ticket, stage: stage.id, round, reason });
        // The malformed path posts a durable record; a stage stuck here is
        // just as much a reason an operator needs to see something on the
        // ticket, not just a line in a log they may never open.
        const posted = await tryApply([malformedEffect(stage.id, round, reason, redactValues)], ticket, snapshot, deps);
        if (!posted.ok) deps.log("effect.failed", { ticket, reason: posted.reason });
        return { passes: pass, settled: "halt", why: reason };
      }
      invoked.add(key);

      /*
       * The artifacts' prose, fetched here and nowhere else: a briefing is an
       * unbounded read of a remote document, so it is paid for once per
       * invocation rather than on every one of up to thirty passes, most of
       * which run no step at all.
       *
       * Before the invocation, and a failure halts rather than proceeding. A
       * step asked to address findings it was not shown is the exact defect
       * this closes, and from inside the agent "the briefing failed" is
       * indistinguishable from "there is nothing to address".
       */
      let briefing: Record<string, Record<string, string>>;
      try {
        briefing = await buildBriefing(deps.artifacts ?? [], { ...deps.ctx, ticket, snapshot }, step.prompt);
      } catch (e) {
        const reason = messageOf(e);
        deps.log("step.rejected", { ticket, stage: stage.id, round, reason });
        return { passes: pass, settled: "halt", why: reason };
      }

      // Before the step, and reported rather than thrown: "this is not a git
      // repository" is an operator's mistake, and a stack trace out of
      // converge would tell them nothing about which ticket or stage it was.
      let sandbox: { path: string } | null = null;
      if (enterSandbox) {
        try {
          sandbox = { path: await enterSandbox() };
        } catch (e) {
          const reason = messageOf(e);
          deps.log("step.rejected", { ticket, stage: stage.id, round, reason });
          return { passes: pass, settled: "halt", why: reason };
        }
      }

      const result = await runStep({
        step, stageId: stage.id, round, snapshot, briefing,
        executor: deps.executor, signal: deps.ctx.signal,
        ...(deps.screen ? { screen: deps.screen } : {}),
        ...(sandbox ? { sandbox } : {}),
        log: deps.log,
      });

      if (!result.ok) {
        deps.log("step.rejected", { ticket, stage: stage.id, round, kind: result.kind, reason: result.reason });

        if (result.kind === "unavailable") {
          // The step never ran at all — the executor itself threw (a
          // network blip, a timeout, a Ctrl-C). Nothing was produced, so
          // there is nothing to reject: no durable record, so the next tick
          // re-derives "pending" from the tracker and legitimately retries.
          // A record here would be CLAUDE.md's hard-fail rule pointed the
          // wrong way — that rule is about a step whose *output* was
          // rejected, and this step has no output to reject.
          return { passes: pass, settled: "halt", why: result.reason };
        }

        // "contract" (the step ran and broke it) and "refused" (screened out
        // before it ever ran) both land here, and deliberately so: a
        // screening refusal is a verdict, not an outage — durable and
        // terminal, the same as a broken contract, never a silent retry (see
        // the "refused" case in step.ts's StepResult doc comment for why).
        // Recorded and stopped either way; the engine routes it on the next
        // pass by whatever trigger reads run.lastOutputValid, but this path
        // never decides anything, and it never invokes the step again in
        // this same call — that is the whole point of a hard fail: a
        // rejected round looks nothing like a round that never ran, so
        // nothing here retries it.
        const posted = await tryApply(
          [malformedEffect(stage.id, round, result.reason, redactValues)],
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
      //
      // This reasoning holds only because the sole effect on this path is
      // the step's own fresh output for *this* round — something that, by
      // construction, cannot have already landed (assess() would not have
      // said "pending" otherwise). It does not generalise to "never
      // reconcile before applying": a route whose effect is something
      // legitimately already satisfied elsewhere — an idempotent artifact
      // publish, say — would need reconciling here, because for that effect
      // "already satisfied" is a real, checkable fact about the world, not
      // a question this same round's own output could ever have answered.
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
      // With the hook that dropped it (§14): "discarded" on its own reads as a
      // bug to whoever is looking at an effect that did not happen, and the
      // answer they need is which hook said it already had.
      deps.log("effect.discarded", {
        ticket,
        type: dropped.type,
        satisfiedBy: deps.dispatcher.handlerFor(dropped.type)?.id ?? null,
      });
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

function malformedEffect(stage: string, round: number, reason: string, redactValues: string[]): Effect {
  return {
    type: RECORD_EFFECT, kind: "malformed", stage, round,
    marker: `malformed:${stage}:${round}`,
    body: malformedBody(reason, redactValues),
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
    return { ok: false, reason: messageOf(e) };
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
    return { ok: false, reason: messageOf(e) };
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
