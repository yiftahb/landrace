import {
  ensureWorktree, keptSlot, prepareWorktree, releaseWorktree, removeWorktree, worktreeHead,
} from "#agent/worktree.js";
import { decide, planEffects, planNodesClose, reconcile, stageBranch } from "#core/index.js";
import { ENTRY_KIND, GOTO_TRIGGER, isEffectRefused, MALFORMED_KIND, mayWriteRepo, RECORD_EFFECT, REFUSED_KIND } from "#conventions.js";
import type {
  AgentActivity, ConvergeDeps, ConvergeResult, Decision, Dispatcher, Effect, Snapshot, StepResult, WorktreeBranch,
} from "#namespace.js";
import { messageOf } from "#runner/errors.js";
import { scrubberOf } from "#runner/events.js";
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

function malformedBody(reason: string, scrub: (text: string) => string, kind: string = MALFORMED_KIND, heading?: string): string {
  // `reason` is not our own text: it can carry the screening executor's own
  // error output verbatim ("agent exited N: <up to 400 chars of stderr>"),
  // and stderr can contain a secret the same way any subprocess output can.
  // This comment is public and durable, and redaction until now was
  // log-sink only — a body composed here goes straight to the tracker,
  // bypassing the logger's own redaction entirely.
  const redacted = scrub(reason);
  // Headed as what it was: a person opening an item stopped by a security
  // check has a different job from one reading an agent's unreadable answer.
  const title = heading ?? (kind === REFUSED_KIND ? "Step refused by a security check" : "Step output rejected");
  const full = `## ${title}\n\n${redacted}. Nothing was retried.`;
  return full.length > MAX_MALFORMED_BODY ? `${full.slice(0, MAX_MALFORMED_BODY)}\n\n…[truncated]` : full;
}

/** How a record body is scrubbed — see `scrubberOf`. */
const scrubberFor = (deps: ConvergeDeps): ((text: string) => string) => scrubberOf(deps.ctx.secrets, deps.scrub);

/**
 * Act on one item until the next move depends on something outside the loop.
 * Doing one thing per poll would put a whole interval between "moved to a
 * stage" and "ran its step", with nothing external happening in between.
 */
export async function converge(item: string, deps: ConvergeDeps): Promise<ConvergeResult> {
  const root = deps.sandbox?.root;
  let entered = false;

  // Created at the first invoke — a converge that never runs a step never pays
  // for a checkout — and removed when this call unwinds, whichever way it
  // unwinds: a return, a halt, a thrown hook, an agent that timed out, a
  // Ctrl-C. A worktree left behind is a slow disk leak and a `git worktree
  // list` nobody can read; it is also *stored state*, which the next tick
  // would silently build on instead of deriving. Re-creating it is this
  // design's ordinary answer — re-derivation, at the price of a checkout. What
  // survives is what a step committed to its stage's branch, which is the
  // repository's own record rather than ours.
  //
  // Asked again at every invoke, because the next step's stage may need the
  // worktree on something else: triage reads origin's default branch, then build writes its
  // branch, then code-review reads that branch detached. Marked entered before
  // the call, so a worktree half-made by a call that threw is removed too.
  //
  // Except a write step's on a branch, which is kept in a slot of its own
  // until the item ends: what `agent.worktree.setup` installed there is what
  // the item's next write step needs, and a review between the two reads the
  // branch in the item's own slot rather than rebuilding this one. Kept is
  // not stored state: it is reset onto the branch whenever it is reused, and
  // rebuilt when it is missing or on anything else. It is detached when this
  // call ends, so the branch is free for a person while the item waits. A
  // write step on no branch is prepared too, in the item's own slot, which
  // goes when this call ends.
  let kept = false;
  const enter = root === undefined
    ? null
    : async (on: WorktreeBranch | undefined, write: boolean): Promise<string> => {
        const keep = on?.write === true;
        if (keep) kept = true;
        else entered = true;
        const path = await ensureWorktree(item, root, on, keep ? keptSlot(item) : item);
        const setup = deps.sandbox?.worktree;
        if (write && setup) await prepareWorktree({ item, path, root, setup, log: deps.log, signal: deps.ctx.signal });
        return path;
      };

  try {
    const result = await converging(item, deps, enter);
    if (result.settled === "terminal" && root !== undefined) await removeWorktree(item, root, keptSlot(item));
    return result;
  } finally {
    if (entered && root !== undefined) await removeWorktree(item, root);
    if (kept && root !== undefined) await releaseWorktree(item, root);
  }
}

async function converging(
  item: string,
  deps: ConvergeDeps,
  enterSandbox: ((on: WorktreeBranch | undefined, write: boolean) => Promise<string>) | null,
): Promise<ConvergeResult> {
  const maxPasses = deps.maxPasses ?? DEFAULT_MAX_PASSES;
  const scrub = scrubberFor(deps);

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
  // ever runs) — this also catches the general case, for a step's own round:
  // a hook whose apply() "succeeds" but leaves that round's output unreadable
  // back, at runtime, for any reason. It does not cover a stage's
  // `nodes.close` the same way — that has its own key and its own set,
  // `residueApplied` below, because a close and a step output fail this way
  // for different reasons and at a different cadence (once per round versus
  // once per pass) and conflating their keys would let one silently mask
  // the other's retry budget.
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

  // Twin of `invoked`, scoped to a stage's `nodes.close` rather than a
  // step's output: the residue re-plan below applies at most once per
  // (stage, round) per call, and a close that still has not taken effect
  // the *next* time it is re-planned — apply() resolved, but satisfied()
  // still says no — halts naming what is still open rather than spending
  // the rest of this call's passes re-applying the same no-op.
  const residueApplied = new Set<string>();

  // Whether the pass before this one applied a transition. An item that
  // waits on the pass after one has just come to rest, which is the one
  // moment a person is told; one found waiting with no move behind it was
  // already waiting, and was told then. Bounded by this call like `pass`,
  // never stored: an item that leaves and comes back moves again.
  let moved = false;

  for (let pass = 1; pass <= maxPasses; pass++) {
    const arrived = moved;
    moved = false;
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
      snapshot = await buildSnapshot({ item, source: deps.source, hooks: deps.pre, workflow: deps.workflow, ctx: deps.ctx });
    } catch (e) {
      const reason = messageOf(e);
      deps.log("snapshot.failed", { item, reason });
      return { passes: pass, settled: "halt", why: reason };
    }
    // §14's per-pass dump. The logger drops it unless --debug is on, so the
    // decision below is always reported alongside the thing it was decided
    // from, and never at the price of a whole snapshot per pass in a quiet log.
    deps.log("snapshot.built", { item, pass, snapshot });

    // Before anything is decided, because acting on an unplaceable item is
    // what this closes: two `lr:stage:*` labels used to run a paid step at
    // whichever one came first in the array, and the same item with them
    // the other way round ran a different stage. Ambiguity halts here like
    // every other ambiguity in this engine, and like both operator surfaces
    // were already reporting for exactly this item.
    const unplaceable = positionProblem(snapshot);
    if (unplaceable) {
      deps.log("item.evaluated", { item, pass, stage: null, decision: "halt", why: unplaceable });
      return { passes: pass, settled: "halt", why: unplaceable };
    }

    const decision = decide(deps.workflow, snapshot);

    deps.log("item.evaluated", {
      item, pass,
      stage: decision.stage?.id ?? null,
      // Where it is going, beside where it is. The last transition of a run is
      // never evaluated from its destination — nothing evaluates a terminal
      // item — so without this the stage an item ended in appears nowhere
      // in the stream, and the only other place to read it is the tracker's
      // own idea of a position, which the engine deliberately does not know.
      to: decision.to?.id ?? null,
      subState: decision.subState ?? null,
      decision: decision.action,
      why: decision.why ?? decision.trigger ?? null,
      // Who holds the stage's step, when a person is pairing on it: the
      // board learns of a pairing from this, re-derived every tick, and
      // needs no label or lock of its own to show it.
      paired: decision.paired ?? null,
    });

    if (decision.action === "skip") {
      const why = decision.why ?? "not eligible";
      deps.log("item.skipped", { item, reason: why });
      return { passes: pass, settled: "wait", why };
    }
    if (decision.action === "wait") {
      // Which waits are a person's is the notify's own rule, the board's; a
      // throw from it is logged like a send that failed, and changes nothing.
      if (arrived) {
        try {
          deps.notify?.(snapshot);
        } catch (e) {
          deps.log("notify.failed", { item, reason: messageOf(e) });
        }
      }
      return { passes: pass, settled: "wait", why: decision.why ?? "no trigger matched" };
    }

    if (decision.action === "invoke") {
      const stage = decision.stage;
      const round = decision.round ?? 1;
      const step = stage?.step ? deps.steps.get(stage.step) : undefined;

      if (!stage || !step) {
        const reason = `stage "${stage?.id}" names a step that is not loaded`;
        deps.log("step.rejected", { item, reason });
        // M2: the malformed path posts a durable record; a workflow naming a
        // step that never loaded is just as much a reason an item is stuck,
        // and an operator watching the item deserves the same trace.
        if (stage) {
          const posted = await tryApply(
            [malformedEffect(stage.id, round, reason, scrub)],
            item, snapshot, deps,
          );
          if (!posted.ok) deps.log("effect.failed", { item, reason: posted.reason });
        }
        return { passes: pass, settled: "halt", why: reason };
      }

      // What a crashed attempt at this round created, dropped before the step
      // runs again. On entry the close drops rounds below this one; here it
      // also takes this round, because an attempt that left no verdict left
      // its children, and the transition that planned the first close is not
      // coming back — a pending stage is invoked, never re-entered. Nothing to
      // drop reconciles away and the step runs on this same pass.
      let closePlanned: Effect[];
      try {
        closePlanned = planNodesClose(stage, snapshot, round + 1);
      } catch (e) {
        const reason = messageOf(e);
        deps.log("effect.failed", { item, reason });
        return { passes: pass, settled: "halt", why: reason };
      }
      if (closePlanned.length) {
        // Same reconcile path and the same "dropped as already satisfied"
        // logging as the transition below: an operator reading the log
        // should not be able to tell which of the two planned this effect.
        const reconciled = reconcileLogged(closePlanned, item, snapshot, deps);
        if (!reconciled.ok) {
          deps.log("effect.failed", { item, reason: reconciled.reason });
          return { passes: pass, settled: "halt", why: reconciled.reason };
        }
        const surviving = reconciled.surviving;
        if (surviving.length) {
          const key = `${stage.id}:${round}`;
          if (residueApplied.has(key)) {
            const ids = surviving.flatMap((e) => (Array.isArray(e.ids) ? (e.ids as string[]) : []));
            const reason = `stage "${stage.id}" round ${round}: nodes.close was applied but is still not satisfied; still open: ` +
              (ids.length ? ids.join(", ") : "(no ids named)");
            deps.log("effect.failed", { item, reason });
            return { passes: pass, settled: "halt", why: reason };
          }
          residueApplied.add(key);
          const cleaned = await tryApply(surviving, item, snapshot, deps);
          if (!cleaned.ok) {
            deps.log("effect.failed", { item, reason: cleaned.reason });
            return { passes: pass, settled: "halt", why: cleaned.reason };
          }
          continue;
        }
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
        deps.log("step.rejected", { item, stage: stage.id, round, reason });
        // The malformed path posts a durable record; a stage stuck here is
        // just as much a reason an operator needs to see something on the
        // item, not just a line in a log they may never open.
        const posted = await tryApply([malformedEffect(stage.id, round, reason, scrub)], item, snapshot, deps);
        if (!posted.ok) deps.log("effect.failed", { item, reason: posted.reason });
        return { passes: pass, settled: "halt", why: reason };
      }
      invoked.add(key);

      /*
       * The artifacts' and the source's prose, fetched here and nowhere else: a briefing is an
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
        briefing = await buildBriefing([...(deps.artifacts ?? []), deps.source], { ...deps.ctx, item, snapshot }, step.prompt);
      } catch (e) {
        const reason = messageOf(e);
        deps.log("step.rejected", { item, stage: stage.id, round, reason });
        return { passes: pass, settled: "halt", why: reason };
      }

      // Before the step, and reported rather than thrown: "this is not a git
      // repository" is an operator's mistake, and a stack trace out of
      // converge would tell them nothing about which item or stage it was.
      //
      // On the stage's branch when it names one: the step's own if it may
      // write, a detached look at it otherwise. Checked for this item before
      // anything is checked out — a template that was fine for the example
      // item at load is not always fine for this one.
      //
      // And for a stage on a branch, the commit the step starts at, once the
      // worktree has caught the branch up to origin's: stamped on the record
      // that settles the round, as engine data no answer can reach. A merge
      // guarded by `reviewedBy` merges only a head that record names.
      //
      // Origin's copy of the branch is asked for first, through the source:
      // the worktree catches up only to what this checkout has heard, and
      // without a fetch a person's push or the forge's "Update branch" never
      // reached it — a review recorded the commit it was not shown, and the
      // merge held to it answered "unreviewed" until the item was stuck
      // (re-review N2). A fetch that fails is an outage, said here like a
      // worktree that could not be made: nothing is recorded, and the step
      // waits for the next tick.
      let sandbox: { path: string } | null = null;
      let head: string | undefined;
      if (enterSandbox || (deps.startedAt && stage.branch !== undefined)) {
        const branch = stageBranch(stage, item, round);
        if (!branch.ok) {
          deps.log("step.rejected", { item, stage: stage.id, round, reason: branch.reason });
          return { passes: pass, settled: "halt", why: branch.reason };
        }
        try {
          if (branch.branch !== null) await deps.source.remoteHead?.(branch.branch, deps.ctx);
          if (enterSandbox) {
            const write = mayWriteRepo(step.capabilities);
            const path = await enterSandbox(branch.branch === null ? undefined : { branch: branch.branch, write }, write);
            sandbox = { path };
            if (branch.branch !== null) head = await worktreeHead(path);
          } else if (branch.branch !== null) {
            head = (await deps.startedAt?.(branch.branch)) ?? undefined;
          }
        } catch (e) {
          const reason = messageOf(e);
          deps.log("step.rejected", { item, stage: stage.id, round, reason });
          return { passes: pass, settled: "halt", why: reason };
        }
      }
      const started = head === undefined ? {} : { head };

      // The engine's own record that an agent is in the room, bracketing the
      // one call that runs it. Not left to the executor: `step.completed`
      // is an executor's own event, which an executor need never emit, so
      // anything watching for "running" would wait on it for ever.
      // The finally is the point — a throw or an abort must not leave a step
      // looking as if it is still going.
      deps.log("step.started", { item, stage: stage.id, round, model: step.model ?? null, effort: step.effort ?? null });
      // The panel's lines for this run start here: a step that never
      // finished is run again at the same round, and its lines are not these.
      deps.activity?.begin(item, stage.id, round);
      let finishedOk = false;
      let result: StepResult;
      try {
        result = await runStep({
          step, item, stageId: stage.id, round, snapshot, briefing,
          executor: deps.executor, signal: deps.ctx.signal,
          readGraph: () => deps.source.read(item, deps.ctx),
          ...(deps.screen ? { screen: deps.screen } : {}),
          ...(sandbox ? { sandbox } : {}),
          ...(deps.stepTimeoutMs === undefined ? {} : { defaultTimeoutMs: deps.stepTimeoutMs }),
          ...(deps.childServer ? { childServer: deps.childServer } : {}),
          ...(deps.activity ? { onActivity: (e: AgentActivity) => deps.activity?.record(item, stage.id, round, e) } : {}),
          ...started,
          log: deps.log,
        });
        finishedOk = result.ok;
      } finally {
        deps.log("step.finished", { item, stage: stage.id, round, ok: finishedOk });
      }

      // A run stopped while its step ran — Ctrl-C, or the item closed or
      // taken off the loop (see tick) — writes nothing, whatever the step
      // returned: an answer the agent got out as it was killed is not one
      // anybody still wants, and a screener killed mid-verdict refused
      // nothing. Nothing written leaves the round owed, so it runs again if
      // the item comes back.
      if (deps.ctx.signal.aborted) return { passes: pass, settled: "halt", why: "the run was aborted" };

      if (!result.ok) {
        deps.log("step.rejected", { item, stage: stage.id, round, kind: result.kind, reason: result.reason });

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
        //
        // Recorded under different kinds, though, and that is not a second
        // decision taken here: core reads both as the same failure, and a
        // workflow that wants a person to see a security refusal as one —
        // rather than as an agent that could not follow a format — routes on
        // run.lastRefused, which is read back from this kind.
        const posted = await tryApply(
          [{ ...malformedEffect(stage.id, round, result.reason, scrub, result.kind === "refused" ? REFUSED_KIND : MALFORMED_KIND), ...started }],
          item, snapshot, deps,
        );
        if (!posted.ok) deps.log("effect.failed", { item, reason: posted.reason });
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
      const applied = await tryApply(result.effects, item, snapshot, deps);
      if (!applied.ok) {
        deps.log("effect.failed", { item, reason: applied.reason, refused: applied.refused });
        // An answer the forge or the tracker refuses to take is this round
        // failed, as a broken answer is: recorded, and routed by the halts.
        // Left unrecorded, the round reads as owed, and the paid step would
        // run again on every tick to be refused again. An outage is not one:
        // the round runs again, as for an agent that never answered.
        if (applied.refused) {
          const posted = await tryApply(
            [{ ...malformedEffect(stage.id, round, applied.reason, scrub, MALFORMED_KIND, `Could not record ${stage.id}'s answer`), ...started }],
            item, snapshot, deps,
          );
          if (!posted.ok) deps.log("effect.failed", { item, reason: posted.reason });
          else continue;
        }
        return { passes: pass, settled: "halt", why: applied.reason };
      }
      continue;
    }

    // transition or halt: the effects of the state being entered. Planning
    // reads the graph now, for a stage that closes nodes, and a graph it
    // cannot read is a halt with the stage named — never a throw out of
    // converge, and never a guess at an empty cascade.
    let planned: Effect[];
    try {
      planned = planEffects(decision, snapshot, item);
    } catch (e) {
      const reason = messageOf(e);
      deps.log("effect.failed", { item, reason });
      return { passes: pass, settled: "halt", why: reason };
    }
    const reconciled = reconcileLogged(planned, item, snapshot, deps);
    if (!reconciled.ok) {
      deps.log("effect.failed", { item, reason: reconciled.reason });
      return { passes: pass, settled: "halt", why: reconciled.reason };
    }
    const surviving = reconciled.surviving;
    const applied = await tryApply(surviving, item, snapshot, deps);
    if (!applied.ok) {
      const recorded = refusedEntry(decision, planned, surviving, applied, snapshot);
      deps.log("effect.failed", {
        item, reason: applied.reason, refused: applied.refused,
        ...(recorded ? { recorded: { stage: recorded.stage, round: recorded.round } } : {}),
      });
      if (recorded === null) return { passes: pass, settled: "halt", why: applied.reason };
      // The refusal is this stage's round, rejected, read where the item
      // stands: the next pass routes it as a broken output is routed.
      const posted = await tryApply(
        [{ ...malformedEffect(recorded.stage, recorded.round, applied.reason, scrub, MALFORMED_KIND, `Could not enter ${recorded.stage}`), from: recorded.from }],
        item, snapshot, deps,
      );
      if (!posted.ok) {
        deps.log("effect.failed", { item, reason: posted.reason });
        return { passes: pass, settled: "halt", why: applied.reason };
      }
      continue;
    }

    if (decision.action === "halt") return { passes: pass, settled: "halt", why: decision.why ?? "the workflow halted" };
    if (decision.to?.terminal) return { passes: pass, settled: "terminal" };
    moved = surviving.length > 0;
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

  deps.log("item.evaluated", { item, decision: "cap", why: `hit ${maxPasses} passes without settling` });
  return { passes: maxPasses, settled: "cap" };
}

/**
 * The durable record of a rejected round; `kind` says whether it was a broken
 * contract or a refusal. Exported for a pairing's hand-in, rejected the same way.
 */
export function malformedEffect(
  stage: string, round: number, reason: string, scrub: (text: string) => string, kind: string = MALFORMED_KIND, heading?: string,
): Effect {
  return {
    type: RECORD_EFFECT, kind, stage, round,
    marker: `${kind}:${stage}:${round}`,
    body: malformedBody(reason, scrub, kind, heading),
  };
}

/**
 * The stage, round and position a refused entry is recorded against, or null
 * when it is left as an outage is — a halt this tick, and the same
 * transition planned again on the next.
 *
 * Recorded only where it can be read back, and read back only once:
 *
 * - **A refusal**, marked by the integration. A 5xx or a network error may
 *   well clear by the next tick, and a person asked to Retry it is a person
 *   asked for nothing.
 * - **From a position.** An item with none yet would read the rejected round
 *   as history it has no place for, and halt where no board shows it.
 * - **After the stage's own entry record landed.** That record is what the
 *   rejection is read beside where the item stands, what Retry finds, and
 *   what a later entry supersedes. One planned after the refused effect, or
 *   none at all, leaves nothing to read it by: the stage would stay failed
 *   for life, and the trigger that sent the item would fire again.
 * - **Not where the item's last verdict already failed**, unless a person
 *   sent it: that transition is the halt the failure routes to, and a second
 *   record would route it there again on every pass. A person's goto is
 *   recorded every time — one record per click.
 */
function refusedEntry(
  decision: Decision,
  planned: Effect[],
  surviving: Effect[],
  applied: { refused: boolean; failedAt: number },
  snapshot: Snapshot,
): { stage: string; round: number; from: string } | null {
  const { to, stage: from } = decision;
  if (!applied.refused || decision.action !== "transition" || to === undefined || from === undefined) return null;
  if (decision.trigger !== GOTO_TRIGGER && snapshot.run?.lastOutputValid === false) return null;
  const entry = planned.find((e) => e.type === RECORD_EFFECT && e.kind === ENTRY_KIND && e.stage === to.id);
  if (entry === undefined) return null;
  const at = surviving.indexOf(entry);
  // Not among the survivors is already landed: reconcile dropped it as satisfied.
  if (at !== -1 && at >= applied.failedAt) return null;
  return { stage: to.id, round: decision.round ?? 1, from: from.id };
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

/**
 * `tryReconcile`, plus the "dropped as already satisfied" log line for
 * whatever it drops — shared by the transition path and the residue
 * re-plan before an invocation, so the two report an effect reconcile
 * discarded the same way rather than one of them quietly going without
 * §14's "which hook said it already had" trail.
 */
function reconcileLogged(
  planned: Effect[],
  item: string,
  snapshot: Snapshot,
  deps: ConvergeDeps,
): { ok: true; surviving: Effect[] } | { ok: false; reason: string } {
  const reconciled = tryReconcile(snapshot, planned, deps.dispatcher.satisfied);
  if (!reconciled.ok) return reconciled;
  const surviving = reconciled.surviving;
  for (const dropped of planned.filter((e) => !surviving.includes(e))) {
    // With the hook that dropped it (§14): "discarded" on its own reads as a
    // bug to whoever is looking at an effect that did not happen, and the
    // answer they need is which hook said it already had.
    deps.log("effect.discarded", {
      item,
      type: dropped.type,
      satisfiedBy: deps.dispatcher.handlerFor(dropped.type)?.id ?? null,
    });
  }
  return { ok: true, surviving };
}

/** Same reasoning as tryReconcile, for the apply side: apply() can reject too (a rate limit, a broken hook), from both the invoke path and the transition path. */
async function tryApply(
  effects: Effect[],
  item: string,
  snapshot: Snapshot,
  deps: ConvergeDeps,
): Promise<{ ok: true } | { ok: false; reason: string; refused: boolean; failedAt: number }> {
  // A stopped run writes nothing, whichever write it had reached: a
  // transition decided from a snapshot read as the item closed is as
  // unwanted as a step's answer. See the check after runStep.
  if (deps.ctx.signal.aborted) return { ok: false, reason: "the run was aborted", refused: false, failedAt: 0 };
  // Which effect failed, and whether it was refused on purpose: a refused
  // entry is recorded only once the stage's own entry record is in.
  let at = 0;
  try {
    for (const effect of effects) {
      deps.log("effect.planned", { item, type: effect.type });
      await deps.dispatcher.apply(effect, { ...deps.ctx, item, snapshot });
      deps.log("effect.applied", { item, type: effect.type });
      at++;
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: messageOf(e), refused: isEffectRefused(e), failedAt: at };
  }
}
