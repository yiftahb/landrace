import { deriveRun } from "../core/derive.js";
import { labelNames, type Issue, type TrackerAdapter } from "../adapters/index.js";
import { isEngineLabel, LABEL_NAMESPACE, LABELS, neutraliseMarkers, stageFromLabels } from "../conventions.js";

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

export function createTools(adapter: TrackerAdapter): Tools {
  const gh = adapter.tracker;
  const summarise = (issue: Issue) => ({
    ticket: issue.number,
    title: issue.title,
    url: issue.html_url,
    state: issue.state,
    labels: labelNames(issue),
  });

  return {
    async waiting() {
      const issues = await gh.listIssues({ labels: [LABELS.awaiting] });
      return issues.map((i: Issue) => ({ ticket: i.number, title: i.title, url: i.html_url }));
    },

    async status(ticket) {
      const issue = await gh.getIssue(ticket);
      const labels = labelNames(issue);
      const { stage, ambiguous } = stageFromLabels(labels);
      const run = deriveRun(await adapter.entriesOf(ticket), stage);

      return {
        ...summarise(issue),
        stage,
        ...(ambiguous ? { problem: "more than one lr:stage:* label — the ticket cannot be placed" } : {}),
        eligible: labels.includes(LABELS.eligible),
        waitingOnYou: labels.includes(LABELS.awaiting),
        blocked: labels.includes(LABELS.blocked),
        rounds: run.counters,
        lastEvent: run.lastEvent,
        lastOutputValid: run.lastOutputValid,
      };
    },

    async createTicket({ title, body = "", labels = [], start = true }) {
      refuseEngineLabels(labels, "set");
      // `start` is the one exception, and it is ours to set, not the caller's.
      const wanted = [...new Set([...labels, ...(start ? [LABELS.eligible] : [])])];
      // A marker pasted into a body would read back as something we wrote.
      const issue = await gh.createIssue({ title, body: neutraliseMarkers(body), labels: wanted });
      return { ...summarise(issue), started: wanted.includes(LABELS.eligible) };
    },

    async updateTicket(ticket, { title, body, state, addLabels = [], removeLabels = [] }) {
      // Both lists are checked before anything is written, so a rejected call
      // leaves the ticket exactly as it was.
      refuseEngineLabels(addLabels, "add");
      refuseEngineLabels(removeLabels, "remove");

      const fields: { title?: string; body?: string; state?: string } = {};
      if (title !== undefined) fields.title = title;
      if (body !== undefined) fields.body = neutraliseMarkers(body);
      if (state !== undefined) fields.state = state;

      for (const name of removeLabels) await gh.removeLabel(ticket, name);
      await gh.addLabels(ticket, addLabels);

      const issue = Object.keys(fields).length
        ? await gh.updateIssue(ticket, fields)
        : await gh.getIssue(ticket);
      return summarise(issue);
    },

    async reply(ticket, message) {
      // Posted without a marker, because it genuinely is a human turn — the
      // marker distinguishes our writing from theirs, not who typed the
      // request. Neutralised so a pasted marker cannot forge state.
      const comment = await gh.createComment(ticket, neutraliseMarkers(message));
      return { ticket, commentId: comment.id, posted: true };
    },
  };
}
