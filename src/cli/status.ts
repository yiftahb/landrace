import { LABELS, stageFromLabels } from "../conventions.js";
import type { Candidate, StatusRow, Workflow } from "../namespace.js";
import { statusLines } from "../runner/status.js";
import { eligibilityOf } from "../runner/tick.js";
import { buildRuntime } from "./start.js";

/**
 * One row per candidate, answered from the labels the source already carried
 * back — no snapshot per ticket, which would mean reading every issue in the
 * repository to print a table.
 *
 * The order the questions are asked in is the tick's own: eligibility first,
 * because a ticket the workflow does not claim is not ours to have an opinion
 * about, and then position — where two stage labels means the ticket cannot be
 * placed at all. Naming the first of the two here would print a position the
 * engine itself refuses to believe.
 */
export function statusRows(workflow: Workflow, candidates: Candidate[]): StatusRow[] {
  return candidates.map((candidate) => {
    const eligibility = eligibilityOf(workflow, candidate);
    const { stage, ambiguous } = stageFromLabels(candidate.labels);
    const row = { ticket: candidate.ticket, title: candidate.title };

    // The workflow's own `else`, never a label name of this file's choosing:
    // what "eligible" means belongs to the workflow, and a second copy of that
    // rule here is how a status table and an engine come to disagree.
    if (!eligibility.eligible) return { ...row, stage, note: `skipped: ${eligibility.reason}` };
    if (ambiguous) return { ...row, stage: null, note: "halted: more than one lr:stage:* label" };

    const labels = candidate.labels;
    const note = labels.includes(LABELS.blocked)
      ? "blocked: needs a human"
      : labels.includes(LABELS.awaiting)
        ? "waiting on you"
        : labels.includes(LABELS.working)
          ? "working"
          : "queued";
    return { ...row, stage, note };
  });
}

export async function runStatus(dir: string): Promise<string[]> {
  // Events to stderr: stdout is the report, and a hook that logs while
  // enumerating would otherwise interleave json with the table.
  const rt = await buildRuntime(dir, { sink: (event) => process.stderr.write(`${JSON.stringify(event)}\n`) });
  return statusLines(statusRows(rt.deps.workflow, await rt.source.list(rt.deps.ctx)));
}
