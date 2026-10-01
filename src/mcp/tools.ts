import {
  isEngineLabel,
  LABEL_NAMESPACE,
  LABELS,
  labelsOf,
  neutraliseMarkers,
  RECORD_EFFECT,
  recordBodyProblem,
  stageFromLabels,
  isOpenItem,
} from "#conventions.js";
import { checkEligible } from "#core/index.js";
import type { Node, PairDeps, ReplyDeps, Snapshot, Source } from "#namespace.js";
import type { Operator, Registry, RuntimeContext, ToolOptions, Tools } from "#namespace.js";
import { createConversation } from "#mcp/conversation.js";
import { createDispatcher } from "#runner/effects.js";
import { messageOf } from "#runner/errors.js";
import { sendTo } from "#runner/goto.js";
import { finishPair, pairingView, releasePair, startPair } from "#runner/pair.js";
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
 * still create an item.
 */
const noSource = (): never => {
  throw new Error("no source hook is configured, so there is nothing to enumerate");
};

/**
 * A person's reply on an item, posted as the operator: what `landrace_reply`
 * posts. The board's Retry is not a reply: it is a goto, and goes through
 * `sendTo`.
 *
 * Through the same dispatcher every other write goes through, so an
 * operator's reply reaches the tracker by the one path the engine knows how
 * to reason about — and a second tracker gets this for free.
 *
 * No marker, because it genuinely is a human turn: a marker separates our
 * writing from theirs, not who typed the request. Neutralised so a pasted
 * marker cannot forge state.
 *
 * And no lock, unlike `resolve`, which is a decision rather than an
 * oversight. `resolve` reads the item, decides from derived state whether it
 * is already handed back, and writes only if it is not: that
 * read-decide-write is what a per-item lock exists to make atomic. This
 * posts one comment unconditionally, so there is nothing to serialise — and
 * taking the lock would make a person's reply wait on, or fail against, the
 * ten-minute step they are replying to, which is the one moment a reply is
 * most wanted.
 *
 * The size, though, is the step path's rule and applies here too: a body the
 * tracker refuses throws with the API's own 422 instead of a sentence naming
 * the limit.
 */
export async function postReply(deps: ReplyDeps, item: string, message: string): Promise<void> {
  const tooLong = recordBodyProblem(message);
  if (tooLong) throw new Error(`cannot reply: the message ${tooLong}`);

  const snapshot = await buildSnapshot({ item, source: deps.source, hooks: deps.pre, ctx: { ...deps.ctx, item } });
  await deps.dispatcher.apply(
    { type: RECORD_EFFECT, body: neutraliseMarkers(message) },
    { ...deps.ctx, item, snapshot },
  );
}

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
    ...(opts.workflow ? { workflow: opts.workflow.workflow, steps: opts.workflow.steps } : {}),
    ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
    ...(opts.activity ? { activity: opts.activity } : {}),
  });

  const snapshotOf = (item: string): Promise<Snapshot> =>
    buildSnapshot({ item, source: source(), hooks: registry.pre, ctx: { ...ctx, item } });

  const summarise = (n: Node) => ({ item: n.id, title: n.title, url: n.link, labels: labelsOf(n) });

  // Called once a write has succeeded, never after a throw: a throw wrote
  // nothing a pass could pick up. And never at the answer's expense — the
  // write has happened, and a wake that failed only costs the wait for the
  // next scheduled tick.
  const wakeLoop = (): void => {
    try {
      opts.wake?.();
    } catch (e) {
      ctx.log("wake.failed", { reason: messageOf(e) });
    }
  };

  return {
    async waiting() {
      // Filtered here, not in the hook: whose turn it is is the engine's own
      // vocabulary, and a source that had to know it would be a source that
      // had to know the workflow. Labels ride along on an item node precisely
      // so this costs no snapshot per item.
      return (await source().list(ctx)).nodes
        .filter((n) => isOpenItem(n) && labelsOf(n).includes(LABELS.awaiting))
        .map((n) => ({ item: n.id, title: n.title, url: n.link }));
    },

    async status(item) {
      // The same snapshot the tick builds, from the same pre hooks in the same
      // order, so what an operator is shown is what the engine would decide
      // on — not a second derivation free to drift from it.
      const snapshot = await snapshotOf(item);
      const node = snapshot.node as Node;
      const labels = labelsOf(node);
      const { stage, ambiguous, found } = stageFromLabels(labels);
      const run = snapshot.run;

      return {
        item,
        title: node.title,
        url: node.link,
        // The one piece of lifecycle every source reports the same way: open
        // is null, a closed item says whether it was finished or dropped.
        closed: node.closed,
        labels,
        stage,
        // Which ones: taking one of them off is the fix, and the engine now
        // halts on this same fact rather than picking one and paying for it.
        ...(ambiguous
          ? { problem: `more than one lr:stage:* label (${found.join(", ")}) — the item cannot be placed` }
          : {}),
        // The workflow's own rule, asked of the snapshot `decide` would gate
        // on — not a label name: the engine names none. A process not given
        // the workflow cannot say, so it does not.
        ...(opts.workflow ? { eligible: checkEligible(opts.workflow.workflow, snapshot).eligible } : {}),
        waitingOnYou: labels.includes(LABELS.awaiting),
        blocked: labels.includes(LABELS.blocked),
        rounds: run?.counters ?? {},
        lastEvent: run?.lastEvent ?? null,
        lastOutputValid: run?.lastOutputValid ?? null,
      };
    },

    async createItem({ title, body = "", labels = [], start = true }) {
      const operator = requireOperator(registry.operator, "create an item");
      refuseEngineLabels(labels, "set");
      // `start` is the one exception, and it is ours to set, not the caller's:
      // the labels the workflow admits with, which the engine names none of.
      // Refused before anything is written, never filed unstarted instead —
      // the caller asked for it to be worked, and would be told it is.
      const admit = opts.workflow?.workflow.admit ?? [];
      if (start) {
        if (!opts.workflow) throw new Error("cannot start an item: this process was not given the workflow");
        if (admit.length === 0) {
          // The folder to edit, by its id: the display name is not a path.
          throw new Error(
            `workflow "${opts.workflow.id}" admits nothing: add admit: [<labels>] to ` +
            `workflows/${opts.workflow.id}/workflow.yaml, or create with start: false`,
          );
        }
      }
      const wanted = [...new Set([...labels, ...(start ? admit : [])])];
      // A marker pasted into a body would read back as something we wrote.
      const created = await operator.createItem({ title, body: neutraliseMarkers(body), labels: wanted }, ctx);
      wakeLoop();
      return { ...summarise(created), started: admit.length > 0 && admit.every((l) => wanted.includes(l)) };
    },

    async updateItem(item, { title, body, state, addLabels = [], removeLabels = [] }) {
      const operator = requireOperator(registry.operator, "update an item");
      // Both lists are checked before anything is written, so a rejected call
      // leaves the item exactly as it was.
      refuseEngineLabels(addLabels, "add");
      refuseEngineLabels(removeLabels, "remove");

      const updated = await operator.updateItem(
        item,
        {
          ...(title === undefined ? {} : { title }),
          ...(body === undefined ? {} : { body: neutraliseMarkers(body) }),
          ...(state === undefined ? {} : { state }),
          addLabels,
          removeLabels,
        },
        ctx,
      );
      wakeLoop();
      return summarise(updated);
    },

    async reply(item, message) {
      await postReply({ source: source(), pre: registry.pre, dispatcher, ctx }, item, message);
      wakeLoop();
      return { item, posted: true };
    },

    async goto(item, stage) {
      // The workflow is what says where a stage may send an item; guessing
      // it here would be a second answer free to differ from the loop's.
      if (!opts.workflow) throw new Error("cannot send an item back: this process was not given the workflow");
      // And the lock this process was told the tick takes, as the
      // conversation is: a goto has to wait on the tick that would take it.
      const r = await sendTo(
        { source: source(), pre: registry.pre, dispatcher, ctx, workflow: opts.workflow.workflow, ...(opts.lock ? { lock: opts.lock } : {}) },
        item,
        stage,
      );
      if ("refused" in r) throw new Error(r.refused);
      wakeLoop();
      return { item, to: r.to, posted: true };
    },

    async clear(item, stage) {
      if (!opts.workflow) throw new Error("cannot clear a step: this process was not given the workflow");
      const r = await sendTo(
        { source: source(), pre: registry.pre, dispatcher, ctx, workflow: opts.workflow.workflow, ...(opts.lock ? { lock: opts.lock } : {}) },
        item,
        stage ?? null,
        { clear: true },
      );
      if ("refused" in r) throw new Error(r.refused);
      wakeLoop();
      return { item, to: r.to, cleared: true, posted: true };
    },

    async ask(item, message, askOpts) {
      const answered = await conversation.ask(item, message, askOpts);
      wakeLoop();
      return answered;
    },

    async resolve(item, why) {
      const resolved = await conversation.resolve(item, why);
      wakeLoop();
      return resolved;
    },

    async pairing(item) {
      return pairingView(pairDeps(), item);
    },

    async pair(item, stage) {
      const started = await startPair(pairDeps(), item, stage);
      wakeLoop();
      return started;
    },

    async finish(item, note) {
      // Woken whichever way it ends: a refused hand-in has written the
      // rejected round, and the loop is what halts the item on it.
      try {
        return await finishPair(pairDeps(), item, note);
      } finally {
        wakeLoop();
      }
    },

    async release(item) {
      const released = await releasePair(pairDeps(), item);
      wakeLoop();
      return released;
    },
  };

  /**
   * Pairing's needs, from what this process was handed. The workflow says
   * which steps may be paired on and what each declared, so without it a
   * pairing is refused rather than guessed at.
   */
  function pairDeps(): PairDeps {
    if (!opts.workflow) throw new Error("cannot pair: this process was not given the workflow");
    return {
      source: source(), pre: registry.pre, dispatcher, ctx,
      workflow: opts.workflow.workflow, steps: opts.workflow.steps, executor: opts.executor ?? null, artifacts: registry.artifacts,
      ...(opts.screen ? { screen: opts.screen } : {}),
      ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
      ...(opts.lock ? { lock: opts.lock } : {}),
      ...(opts.server ? { server: opts.server, childServer: opts.server } : {}),
    };
  }
}
