import { durationMs } from "#conventions.js";
import type { Workflow } from "#namespace.js";

/**
 * The limit for a run nobody set one for. The engine's, not an executor's:
 * every run is handed a limit, so an executor's own default is never what
 * decides.
 */
export const DEFAULT_STEP_TIMEOUT_MS = 10 * 60_000;

/**
 * How long one step may run when it names no `timeout` of its own, taken from
 * the workflow that owns the process.
 *
 * A value that cannot be read throws rather than falling back —
 * `stepTimeout: 600` looks like it says something, and quietly meaning ten
 * minutes instead is how a cap nobody applied goes on reading as applied.
 */
export function stepTimeoutMs(workflow: Workflow): number {
  const declared = workflow.budget?.["stepTimeout"];
  if (declared === undefined) return DEFAULT_STEP_TIMEOUT_MS;
  if (typeof declared !== "string") {
    throw new Error(`budget.stepTimeout must be a duration like "10m", got ${JSON.stringify(declared)}`);
  }
  const ms = durationMs(declared);
  if (ms === null) throw new Error(`budget.stepTimeout must look like "60s", "2m" or "1h", got "${declared}"`);
  return ms;
}
