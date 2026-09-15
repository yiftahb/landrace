import { deriveRun } from "../core/derive.js";
import type { GitHubClient } from "../github/client.js";
import { labelNames } from "../github/client.js";
import { LABELS, stageFromLabels } from "../github/labels.js";
import { entriesFromComments, neutraliseMarkers } from "../github/markers.js";

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

export function createTools(gh: GitHubClient): Tools {
  const summarise = (issue: Parameters<typeof labelNames>[0]) => ({
    ticket: issue.number,
    title: issue.title,
    url: issue.html_url,
    state: issue.state,
    labels: labelNames(issue),
  });

  return {
    async waiting() {
      const issues = await gh.listIssues({ labels: [LABELS.awaiting] });
      return issues.map((i) => ({ ticket: i.number, title: i.title, url: i.html_url }));
    },

    async status(ticket) {
      const issue = await gh.getIssue(ticket);
      const labels = labelNames(issue);
      const { stage, ambiguous } = stageFromLabels(labels);
      const run = deriveRun(entriesFromComments(await gh.listComments(ticket)), stage);

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
      const wanted = [...new Set([...labels, ...(start ? [LABELS.eligible] : [])])];
      const issue = await gh.createIssue({ title, body, labels: wanted });
      return { ...summarise(issue), started: wanted.includes(LABELS.eligible) };
    },

    async updateTicket(ticket, { title, body, state, addLabels = [], removeLabels = [] }) {
      const fields: { title?: string; body?: string; state?: string } = {};
      if (title !== undefined) fields.title = title;
      if (body !== undefined) fields.body = body;
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
