import {
  isEngineLabel,
  LABEL_NAMESPACE,
  LABELS,
  labelsOf,
  neutraliseMarkers,
  recordBodyProblem,
  stageFromLabels,
  isOpenTicket,
} from "#conventions.js";
import type { Node, Snapshot, Source } from "#namespace.js";
import type { Operator, Registry, RuntimeContext, ToolOptions, Tools } from "#namespace.js";
import { createConversation } from "#mcp/conversation.js";
import { createDispatcher } from "#runner/effects.js";
import { buildSnapshot } from "#runner/snapshot.js";

/**
 * Position is a label, so an `lr:` label from the editor is not a label at
 * all — it is a write to workflow state. `lr:stage:done` skipped every stage
 * and `lr:approved` forged a human decision. The engine writes these through
 * effects, which have a satisfied() and can be reconciled; nothing reaches
 * them through here.
 */
function refuseEngineLabels(labels: string[], what: string): void {
  const offending = labels.filter(isEngineLabel);
  if (offending.length) {
    throw new Error(
      `cannot ${what} ${offending.map((l) => `"${l}"`).join(", ")}: ` +
      `"${LABEL_NAMESPACE}" labels are the workflow's own state, written by the engine`,
    );
  }
}

/**
 * An operator hook is optional, so the two tools that need one report its
 * absence — rather than crashing on a null, or quietly succeeding at nothing.
 */
function requireOperator(operator: Operator | null, what: string): Operator {
  if (!operator) {
    throw new Error(
      `cannot ${what}: no operator hook is configured. Add a module exporting ` +
      "defineOperator({ ... }) to the hooks list in workflow.yaml.",
    );
  }
  return operator;
}

/**
 * A source is optional here as an operator is, so what needs one reports its
 * absence when asked — not at startup, where a process with no source can
 * still create a ticket.
 */
const noSource = (): never => {
  throw new Error("no source hook is configured, so there is nothing to enumerate");
};

export function createTools(registry: Registry, ctx: RuntimeContext, opts: ToolOptions = {}): Tools {
  const dispatcher = createDispatcher(registry.post);
  const source = (): Source => registry.source ?? noSource();

  // The tick's own pre hooks and the tick's own dispatcher, handed over rather
  // than rebuilt beside them: a conversation that read or wrote through a
  // second path would be writing state the tick cannot re-derive.
  const conversation = createConversation({
    source: registry.source ?? { id: "none", relations: [], list: async () => noSource(), read: async () => noSource() },
    pre: registry.pre,
    dispatcher,
    ctx,
    executor: opts.executor ?? null,
    // A turn is an agent invocation, so §15's screening reaches it the same
    // way it reaches a step — through the same option, carried rather than
    // accepted and dropped.
    ...(opts.screen ? { screen: opts.screen } : {}),
    ...(opts.lock ? { lock: opts.lock } : {}),
    // And for the same reason, the step's own declaration: a turn is held to
    // the capabilities and the model of the step it continues, which the
    // conversation can only read if the workflow reaches it. Carried rather
    // than loaded again here — a second read of the same directory is a second
    // answer, free to differ from the one the loop is actually running.
    ...(opts.workflow ? { workflow: opts.workflow } : {}),
    ...(opts.steps ? { steps: opts.steps } : {}),
    ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
  });

  const snapshotOf = (ticket: string): Promise<Snapshot> =>
    buildSnapshot({ ticket, source: source(), hooks: registry.pre, ctx: { ...ctx, ticket } });

  const summarise = (n: Node) => ({ ticket: n.id, title: n.title, url: n.link, labels: labelsOf(n) });

  return {
    async waiting() {
      // Filtered here, not in the hook: whose turn it is is the engine's own
      // vocabulary, and a source that had to know it would be a source that
      // had to know the workflow. Labels ride along on a ticket node precisely
      // so this costs no snapshot per ticket.
      return (await source().list(ctx)).nodes
        .filter((n) => isOpenTicket(n) && labelsOf(n).includes(LABELS.awaiting))
        .map((n) => ({ ticket: n.id, title: n.title, url: n.link }));
    },

    async status(ticket) {
      // The same snapshot the tick builds, from the same pre hooks in the same
      // order, so what an operator is shown is what the engine would decide
      // on — not a second derivation free to drift from it.
      const snapshot = await snapshotOf(ticket);
      const node = snapshot.node as Node;
      const labels = labelsOf(node);
      const { stage, ambiguous, found } = stageFromLabels(labels);
      const run = snapshot.run;

      return {
        ticket,
        title: node.title,
        url: node.link,
        // The one piece of lifecycle every source reports the same way: open
        // is null, a closed ticket says whether it was finished or dropped.
        closed: node.closed,
        labels,
        stage,
        // Which ones: taking one of them off is the fix, and the engine now
        // halts on this same fact rather than picking one and paying for it.
        ...(ambiguous
          ? { problem: `more than one lr:stage:* label (${found.join(", ")}) — the ticket cannot be placed` }
          : {}),
        eligible: labels.includes(LABELS.eligible),
        waitingOnYou: labels.includes(LABELS.awaiting),
        blocked: labels.includes(LABELS.blocked),
        rounds: run?.counters ?? {},
        lastEvent: run?.lastEvent ?? null,
        lastOutputValid: run?.lastOutputValid ?? null,
      };
    },

    async createTicket({ title, body = "", labels = [], start = true }) {
      const operator = requireOperator(registry.operator, "create a ticket");
      refuseEngineLabels(labels, "set");
      // `start` is the one exception, and it is ours to set, not the caller's.
      const wanted = [...new Set([...labels, ...(start ? [LABELS.eligible] : [])])];
      // A marker pasted into a body would read back as something we wrote.
      const created = await operator.createTicket({ title, body: neutraliseMarkers(body), labels: wanted }, ctx);
      return { ...summarise(created), started: wanted.includes(LABELS.eligible) };
    },

    async updateTicket(ticket, { title, body, state, addLabels = [], removeLabels = [] }) {
      const operator = requireOperator(registry.operator, "update a ticket");
      // Both lists are checked before anything is written, so a rejected call
      // leaves the ticket exactly as it was.
      refuseEngineLabels(addLabels, "add");
      refuseEngineLabels(removeLabels, "remove");

      return summarise(
        await operator.updateTicket(
          ticket,
          {
            ...(title === undefined ? {} : { title }),
            ...(body === undefined ? {} : { body: neutraliseMarkers(body) }),
            ...(state === undefined ? {} : { state }),
            addLabels,
            removeLabels,
          },
          ctx,
        ),
      );
    },

    async reply(ticket, message) {
      // Through the same dispatcher every other write goes through, so an
      // operator's reply reaches the tracker by the one path the engine knows
      // how to reason about — and a second tracker gets this tool for free.
      //
      // No marker, because it genuinely is a human turn: a marker separates
      // our writing from theirs, not who typed the request. Neutralised so a
      // pasted marker cannot forge state.
      //
      // And no lock, unlike `resolve` beside it, which is a decision rather
      // than an oversight. `resolve` reads the ticket, decides from derived
      // state whether it is already handed back, and writes only if it is
      // not: that read-decide-write is what a per-ticket lock exists to make
      // atomic. This posts one comment unconditionally, so there is nothing
      // to serialise — and taking the lock would make a person's reply wait
      // on, or fail against, the ten-minute step they are replying to, which
      // is the one moment a reply is most wanted.
      //
      // The size, though, is the step path's rule and applies here too: a
      // body the tracker refuses throws with the API's own 422 instead of a
      // sentence naming the limit.
      const tooLong = recordBodyProblem(message);
      if (tooLong) throw new Error(`cannot reply: the message ${tooLong}`);

      const snapshot = await snapshotOf(ticket);
      await dispatcher.apply(
        { type: "tracker.comment", body: neutraliseMarkers(message) },
        { ...ctx, ticket, snapshot },
      );
      return { ticket, posted: true };
    },

    ask: (ticket, message, askOpts) => conversation.ask(ticket, message, askOpts),

    resolve: (ticket, why) => conversation.resolve(ticket, why),
  };
}
