import { extractJsonBlock } from "#agent/json-block.js";
import { screenPrompt } from "#agent/screen.js";
import { ensureWorktree, removeWorktree } from "#agent/worktree.js";
import {
  CAPABILITIES,
  CONVERSATION_KIND,
  durationMs,
  fitRecordBody,
  mayWriteRepo,
  neutraliseMarkers,
  recordBodyProblem,
  unknownCapabilities,
} from "#conventions.js";
import { stageBranch } from "#core/index.js";
import type {
  Conversation,
  ConversationDeps,
  Entry,
  JoinedSession,
  Snapshot,
  Stage,
  Step,
  Workflow,
} from "#namespace.js";
import { withLock } from "#runner/lock.js";
import { buildSnapshot } from "#runner/snapshot.js";
import { sandboxBefore, sandboxTrespass } from "#runner/step.js";
import { stepTimeoutMs } from "#runner/budget.js";

/**
 * What a turn asks for beyond an answer: one bit, and the engine routes on it.
 *
 * The step's own output contract does the same thing for a step. Asking the
 * agent to *decide* whether the conversation is over would be a model picking
 * a transition; asking it whether it is still missing something is a value a
 * deterministic rule reads.
 */
const TURN = (message: string): string => `The person who owns this ticket replied:

${message}

Answer them directly, in prose, using the draft you already have. Then, as the
very last thing you write with nothing after it, add a fenced json block saying
whether you are still missing something you cannot proceed without:

\`\`\`json
{ "blocking": false }
\`\`\``;

/** A conversation turn takes the same few minutes a step does, and the lock has to outlast it. */
const TURN_DEADLINE_MS = 15 * 60_000;

/** Long enough to lose a race to a 200ms label write, short enough that a person is not left waiting on a step. */
const WAIT_FOR_LOOP_MS = 3_000;

/**
 * Fail closed, exactly as the screener does: an answer that cannot be read has
 * answered nothing. Reporting "it has what it needs" off unreadable output is
 * how a person comes to hand the loop back a step that is still confused.
 */
function isResolved(text: string): boolean {
  const block = extractJsonBlock(text);
  return block.kind === "found" && block.value["blocking"] === false;
}

/** The reply with its verdict block removed — the exact span that was parsed, never a second regex. */
function prose(text: string): string {
  const block = extractJsonBlock(text);
  if (block.kind !== "found") return text.trim();
  const [start, end] = block.span;
  return (text.slice(0, start) + text.slice(end)).trim();
}

/**
 * Talking to a step, without holding a process.
 *
 * Each turn is a fresh agent run resumed onto the session the step started, so
 * a crash costs a turn rather than the conversation — and the session id is
 * read back off the ticket (spec §6.1), which is what lets an MCP process that
 * never ran the step join the conversation at all.
 *
 * Every write here goes through the same dispatcher and the same effect types
 * the tick uses, and every read through the same snapshot the tick builds.
 * That is the point rather than tidiness: a private path that wrote state the
 * tick could not re-derive would make the answer invisible to the workflow,
 * and the person would have talked to nobody.
 */
export function createConversation(deps: ConversationDeps): Conversation {
  const snapshotOf = (ticket: string): Promise<Snapshot> =>
    buildSnapshot({ ticket, source: deps.source, hooks: deps.pre, ctx: { ...deps.ctx, ticket } });

  const say = (ticket: string, snapshot: Snapshot, body: string, marked?: Record<string, unknown>): Promise<void> =>
    deps.dispatcher.apply(
      { type: "tracker.comment", body, ...(marked ?? {}) },
      { ...deps.ctx, ticket, snapshot },
    );

  /**
   * The most recent session on the ticket: a conversation turn's if there has
   * been one, otherwise the step's own. Derived from the records rather than
   * remembered, so two MCP processes and a tick all read the same answer.
   */
  const join = (ticket: string, snapshot: Snapshot): JoinedSession => {
    const entries = [...((snapshot.entries as Entry[] | undefined) ?? [])].sort((a, b) =>
      a.at < b.at ? -1 : a.at > b.at ? 1 : 0,
    );
    for (const entry of [...entries].reverse()) {
      // The record's own session field, never anything inside its payload: on
      // an output record the payload is the agent's value, and a step whose
      // shape declares a field called `session` would otherwise be choosing
      // which conversation the next paid turn resumes.
      if (entry.session !== undefined) {
        return { session: entry.session, stage: entry.stage, round: entry.round };
      }
    }
    throw new Error(
      `#${ticket} has no session to join yet: no step on it has produced a draft to talk about`,
    );
  };

  /**
   * Whether the ticket is already back in the loop's hands.
   *
   * Not a flag of its own: "a person spoke last" is what the workflow's
   * human-handback triggers already read, so resolving *is* posting a human
   * turn, and a second one would be noise claiming to be news. A reply typed
   * into the tracker's own UI resolves the conversation for the same reason —
   * it genuinely did.
   */
  const handedBack = (snapshot: Snapshot): boolean => snapshot.run?.lastEvent.actor === "human";

  /**
   * What the step behind this conversation declared.
   *
   * A turn is an agent invocation resumed onto the step's own session, so it
   * inherits the step's limits — anything less would be a way to ask, through
   * conversation, for exactly what the workflow forbade the step. Resolved the
   * way converge resolves it (the stage names a step, the step names its
   * capabilities and its model) rather than remembered on the record, because
   * a record written by yesterday's workflow would otherwise pin today's turn
   * to yesterday's declaration.
   *
   * Refused rather than defaulted when it cannot be resolved: a turn nobody
   * can say the limits of is a turn nobody is holding to them, and this
   * process has already proved it can run one.
   */
  const stepBehind = (ticket: string, stage: string): { workflow: Workflow; declared: Stage; step: Step } => {
    // Narrowed here rather than read off `deps.workflow` again below: `declared`
    // and `step` can only be truthy when `deps.workflow` is, but nothing
    // downstream of a second `deps.workflow?.` can see that for itself — a
    // local the throw actually guards is what lets `stepTimeoutMs` take it
    // without an assertion.
    const workflow = deps.workflow;
    const declared = workflow?.stages.find((s) => s.id === stage);
    const step = declared?.step === undefined ? undefined : deps.steps?.get(declared.step);
    if (!workflow || !declared || !step) {
      throw new Error(
        `cannot ask: #${ticket}'s conversation belongs to stage "${stage}", and this process cannot see what ` +
        "that step declared — a turn that is not held to the step's own capabilities is a way around them",
      );
    }
    // Before anything is paid for, and for the reason runStep gives: a
    // capability nothing enforces is the operator reading the step file,
    // seeing the word, and believing they are covered.
    const unenforceable = unknownCapabilities(step.capabilities);
    if (unenforceable.length) {
      throw new Error(
        `cannot ask: stage "${stage}" declares ${unenforceable.map((c) => `"${c}"`).join(", ")}, ` +
        `which nothing enforces; this engine enforces ${CAPABILITIES.join(", ")}`,
      );
    }
    return { workflow, declared, step };
  };

  return {
    async ask(ticket, message, opts) {
      // The tick can resume the same session, and two agent runs resuming one
      // session is the race §7 names. Waiting a few seconds beats failing a
      // person's request over a 200ms label write.
      return withLock(
        ticket,
        "conversation",
        async () => {
          /*
           * The step path's own bound, applied to the turn — the same reason
           * sandboxBefore/sandboxTrespass are shared rather than copied. A
           * question the tracker will refuse used to be discovered by the
           * tracker refusing it, after the screener had run and been paid
           * for; asked here, it costs nothing and the person is told the
           * number rather than handed a 422.
           */
          const tooLong = recordBodyProblem(message);
          if (tooLong) throw new Error(`cannot ask: the question ${tooLong}`);

          const snapshot = await snapshotOf(ticket);
          const { session, stage, round } = join(ticket, snapshot);
          if (!deps.executor) {
            throw new Error(
              "cannot ask: no agent executor is configured, so there is nothing to resume the session with",
            );
          }

          // Before anything is screened, posted or paid for: what the step
          // declared is the frame this whole turn runs inside, and a turn
          // that cannot be held to it must not start.
          const { workflow, declared, step } = stepBehind(ticket, stage);
          const root = deps.sandbox?.root;
          // Where the step worked, which is where its session continues: the
          // stage's branch when it names one — converge's own rule, so a turn
          // on a build commits where the build did rather than onto a
          // detached HEAD that is deleted with the worktree.
          const branch = stageBranch(declared, ticket, round);
          if (!branch.ok) throw new Error(`cannot ask: ${branch.reason}`);

          const turn = TURN(message);

          // The step's own limit, else the workflow's: a turn is held to
          // what the step is held to, and every run is given one.
          const fallbackMs = stepTimeoutMs(workflow);
          const turnTimeoutMs = (step.timeout === undefined ? null : durationMs(step.timeout)) ?? fallbackMs;
          const turnLimit = AbortSignal.timeout(turnTimeoutMs);
          const callerSignal = opts?.signal ?? deps.ctx.signal;
          const turnSignal = AbortSignal.any([callerSignal, turnLimit]);

          /*
           * §15: every agent invocation is screened before it runs, and this
           * is one — the only one the MCP plane makes. "It came through the
           * MCP" is not evidence the words are safe: the MCP is precisely
           * where an operator pastes something they were sent, and the client
           * typing into it is itself a model.
           *
           * The rendered turn, not the bare message and not the template:
           * runStep's own rule, and here it also gives the screener the frame
           * the words will actually be read in.
           *
           * Before the question is posted, not just before the run. A blocked
           * turn that had already left the person's words on the ticket would
           * hand the loop a human turn — the thing that resolves a
           * conversation — off text we refused to act on.
           */
          if (deps.screen) {
            const verdict = await screenPrompt(turn, {
              executor: deps.screen.executor,
              model: deps.screen.model,
              // Screening is quick, so it gets the workflow's budget, not a
              // two-hour build's.
              timeoutMs: fallbackMs,
              signal: callerSignal,
              log: deps.ctx.log,
            });
            if (!verdict.ok) throw new Error(`screening blocked this turn: ${verdict.reason}`);
          }

          /*
           * The turn's own worktree, cut and removed here the way converge
           * cuts and removes a step's — because "the agent runs in a sandbox"
           * is the only reason the check after the run means anything. Without
           * one the turn ran in the operator's own checkout, which is both the
           * blast radius and the reason nothing could be judged: what changed
           * there was not necessarily the agent's doing.
           *
           * Removed however this unwinds, so a refused turn, a thrown hook or
           * a client that disconnected leaves no directory behind — and with
           * it, whatever the agent wrote that it was not entitled to.
           */
          let sandbox: { path: string } | undefined;
          try {
            if (root !== undefined) {
              const on = branch.branch === null
                ? undefined
                : { branch: branch.branch, write: mayWriteRepo(step.capabilities) };
              sandbox = { path: await ensureWorktree(ticket, root, on) };
            }

            // Read before the agent runs, and a failure refuses the turn
            // rather than skipping the check: a check that could not run has
            // verified nothing.
            const start = await sandboxBefore(sandbox, step.capabilities);
            if (!start.ok) throw new Error(`cannot ask: ${start.reason}`);

            // The person's words, first and unmarked: they are a human turn —
            // the same rule `landrace_reply` follows — so the ticket shows who
            // actually said what, and the record survives an agent that never
            // answers. Neutralised, because a marker pasted into a question
            // would otherwise read back as control state we wrote.
            await say(ticket, snapshot, neutraliseMarkers(message));

            let text: string;
            let sessionId: string | null;
            try {
              ({ text, sessionId } = await deps.executor.run(turn, {
                round,
                resume: session,
                // The step's own declaration, both halves of it. A turn is an
                // agent invocation on the same session, and one that were less
                // constrained than the step it continues would let a person ask
                // through conversation for exactly what the workflow forbade —
                // and bill a `model: haiku` step at the operator's default.
                // Always present, never undefined: a step that declares no
                // capabilities is the most restricted there is, and an executor
                // reading `undefined` falls back to its own operator-wide
                // default instead.
                capabilities: step.capabilities ?? [],
                ...(step.model === undefined ? {} : { model: step.model }),
                // And its time limit: a turn on a two-hour build's session, held
                // to the operator's default, is killed long before the build
                // would have been. Every run gets one — the step's own, else
                // the workflow's — and the engine enforces it the same way
                // runStep does: the signal aborts too, so an executor that
                // never reads timeoutMs still stops.
                timeoutMs: turnTimeoutMs,
                ...(sandbox ? { cwd: sandbox.path } : {}),
                // The caller's own signal when there is one, joined with the
                // limit above: an MCP client that disconnects mid-turn aborts
                // the request, which kills the agent and unwinds through the
                // lock's release rather than holding that ticket for the rest
                // of the run.
                signal: turnSignal,
              }));
            } catch (e) {
              // Said as the limit, not as whatever the executor said when the
              // abort reached it — the same reason runStep does this: "aborted"
              // reads like a disconnect, and this was the cap.
              if (turnLimit.aborted && !callerSignal.aborted) {
                throw new Error(`the agent ran past its ${turnTimeoutMs}ms limit`);
              }
              throw e;
            }

            // Asked of the file system, not of the flags we passed — the same
            // check, for the same reason, as the one after a step. A refused
            // turn answers nothing, so its reply is never posted: leaving it
            // on the ticket would publish the work of a run we just refused.
            const trespass = await sandboxTrespass(sandbox, start.before);
            if (trespass) throw new Error(`this conversation turn was refused: ${trespass}`);

            const reply = prose(text);
            const resolved = isResolved(text);
            // Cut to fit rather than refused, and this is the one place in the
            // engine where that is the right answer: the turn is already paid
            // for, nothing routes on this prose — `resolved` and the session
            // ride in the marker beside it — and the caller below receives the
            // whole reply either way. Throwing here lost the answer *and* the
            // session the next turn would have resumed from.
            await say(ticket, snapshot, neutraliseMarkers(fitRecordBody(reply)), {
              kind: CONVERSATION_KIND,
              stage,
              round,
              // Where the next turn resumes from, beside the record rather than
              // inside its payload — the same place a step's own session sits. A
              // run that returned no session id leaves the one we joined, so the
              // conversation continues rather than silently starting over.
              session: sessionId ?? session,
              output: { resolved },
            });

            return { reply, resolved };
          } finally {
            if (sandbox !== undefined && root !== undefined) await removeWorktree(ticket, root);
          }
        },
        { holder: `mcp:ask:${process.pid}`, waitMs: WAIT_FOR_LOOP_MS, deadlineMs: TURN_DEADLINE_MS, ...deps.lock },
      );
    },

    async resolve(ticket, why = "Carry on — this is answered.") {
      return withLock(
        ticket,
        "conversation",
        async () => {
          const snapshot = await snapshotOf(ticket);
          // Asked before anything is written: resolving a ticket no step has
          // spoken on is a wrong ticket number, not a no-op.
          join(ticket, snapshot);
          if (handedBack(snapshot)) return { alreadyResolved: true };

          // Unmarked, so it reads as the human turn it is. That is the whole
          // mechanism: the loop's own trigger sees a person spoke last and
          // picks the ticket up on its next tick.
          await say(ticket, snapshot, neutraliseMarkers(why));
          return { alreadyResolved: false };
        },
        { holder: `mcp:resolve:${process.pid}`, waitMs: WAIT_FOR_LOOP_MS, ...deps.lock },
      );
    },
  };
}
