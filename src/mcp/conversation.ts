import { extractJsonBlock } from "../agent/json-block.js";
import { screenPrompt } from "../agent/screen.js";
import { CONVERSATION_KIND, neutraliseMarkers } from "../conventions.js";
import type {
  Conversation,
  ConversationDeps,
  Entry,
  JoinedSession,
  Snapshot,
} from "../namespace.js";
import { withLock } from "../runner/lock.js";
import { buildSnapshot } from "../runner/snapshot.js";

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
  const snapshotOf = (ticket: number): Promise<Snapshot> =>
    buildSnapshot({ ticket, hooks: deps.pre, ctx: { ...deps.ctx, ticket } });

  const say = (ticket: number, snapshot: Snapshot, body: string, marked?: Record<string, unknown>): Promise<void> =>
    deps.dispatcher.apply(
      { type: "tracker.comment", body, ...(marked ?? {}) },
      { ...deps.ctx, ticket, snapshot },
    );

  /**
   * The most recent session on the ticket: a conversation turn's if there has
   * been one, otherwise the step's own. Derived from the records rather than
   * remembered, so two MCP processes and a tick all read the same answer.
   */
  const join = (ticket: number, snapshot: Snapshot): JoinedSession => {
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

  return {
    async ask(ticket, message, opts) {
      // The tick can resume the same session, and two agent runs resuming one
      // session is the race §7 names. Waiting a few seconds beats failing a
      // person's request over a 200ms label write.
      return withLock(
        ticket,
        "conversation",
        async () => {
          const snapshot = await snapshotOf(ticket);
          const { session, stage, round } = join(ticket, snapshot);
          if (!deps.executor) {
            throw new Error(
              "cannot ask: no agent executor is configured, so there is nothing to resume the session with",
            );
          }

          const turn = TURN(message);

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
              signal: opts?.signal ?? deps.ctx.signal,
              log: deps.ctx.log,
            });
            if (!verdict.ok) throw new Error(`screening blocked this turn: ${verdict.reason}`);
          }

          // The person's words, first and unmarked: they are a human turn —
          // the same rule `landrace_reply` follows — so the ticket shows who
          // actually said what, and the record survives an agent that never
          // answers. Neutralised, because a marker pasted into a question
          // would otherwise read back as control state we wrote.
          await say(ticket, snapshot, neutraliseMarkers(message));

          const { text, sessionId } = await deps.executor.run(turn, {
            round,
            resume: session,
            // The caller's own signal when there is one: an MCP client that
            // disconnects mid-turn aborts the request, which kills the agent
            // and unwinds through the lock's release rather than holding that
            // ticket for the rest of the run.
            signal: opts?.signal ?? deps.ctx.signal,
          });

          const reply = prose(text);
          const resolved = isResolved(text);
          await say(ticket, snapshot, neutraliseMarkers(reply), {
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
