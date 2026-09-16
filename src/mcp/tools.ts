import { isEngineLabel, LABEL_NAMESPACE, LABELS, neutraliseMarkers, stageFromLabels } from "../conventions.js";
import type { Snapshot } from "../namespace.js";
import type { Candidate, Operator, Registry, RuntimeContext } from "../namespace.js";
import { createDispatcher } from "../runner/effects.js";
import { buildSnapshot } from "../runner/snapshot.js";

export interface Tools {
  waiting(): Promise<Array<{ ticket: number; title: string; url: string }>>;
  status(ticket: number): Promise<unknown>;
  // `| undefined` is explicit because exactOptionalPropertyTypes is on and these
  // are fed straight from Zod, whose optional output includes it.
  createTicket(input: {
    title: string;
    body?: string | undefined;
    labels?: string[] | undefined;
    start?: boolean | undefined;
  }): Promise<unknown>;
  updateTicket(
    ticket: number,
    input: {
      title?: string | undefined;
      body?: string | undefined;
      state?: "open" | "closed" | undefined;
      addLabels?: string[] | undefined;
      removeLabels?: string[] | undefined;
    },
  ): Promise<unknown>;
  reply(ticket: number, message: string): Promise<unknown>;
}

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

export function createTools(registry: Registry, ctx: RuntimeContext): Tools {
  const dispatcher = createDispatcher(registry.post);

  const snapshotOf = (ticket: number): Promise<Snapshot> =>
    buildSnapshot({ ticket, hooks: registry.pre, ctx: { ...ctx, ticket } });

  const source = (): NonNullable<Registry["source"]> => {
    if (!registry.source) {
      throw new Error("no source hook is configured, so there is nothing to enumerate");
    }
    return registry.source;
  };

  const summarise = (c: Candidate) => ({ ticket: c.ticket, title: c.title, url: c.url, labels: c.labels });

  return {
    async waiting() {
      // Filtered here, not in the hook: whose turn it is is the engine's own
      // vocabulary, and a source that had to know it would be a source that
      // had to know the workflow. Labels ride along on a Candidate precisely
      // so this costs no snapshot per ticket.
      return (await source().list(ctx))
        .filter((c) => c.labels.includes(LABELS.awaiting))
        .map((c) => ({ ticket: c.ticket, title: c.title, url: c.url }));
    },

    async status(ticket) {
      // The same snapshot the tick builds, from the same pre hooks in the same
      // order, so what an operator is shown is what the engine would decide
      // on — not a second derivation free to drift from it.
      const snapshot = await snapshotOf(ticket);
      const issue = (snapshot.ticket ?? {}) as { title?: string; url?: string; state?: string; labels?: string[] };
      const labels = issue.labels ?? [];
      const { stage, ambiguous } = stageFromLabels(labels);
      const run = snapshot.run;

      return {
        ticket,
        title: issue.title ?? null,
        url: issue.url ?? null,
        state: issue.state ?? null,
        labels,
        stage,
        ...(ambiguous ? { problem: "more than one lr:stage:* label — the ticket cannot be placed" } : {}),
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
      const snapshot = await snapshotOf(ticket);
      await dispatcher.apply(
        { type: "tracker.comment", body: neutraliseMarkers(message) },
        { ...ctx, ticket, snapshot },
      );
      return { ticket, posted: true };
    },
  };
}
