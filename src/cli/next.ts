import { readFile } from "node:fs/promises";
import { decide, deriveRun, planEffects } from "../core/index.js";
import type { Decision, Effect, Snapshot } from "../namespace.js";
import { loadWorkflow } from "../workflow/load.js";

export async function runNext(
  dir: string,
  snapshotPath: string,
): Promise<{ decision: Decision; effects: Effect[] }> {
  const { workflow } = await loadWorkflow(dir);
  const raw = JSON.parse(await readFile(snapshotPath, "utf8")) as Snapshot;

  const stage = (raw.run?.stage ?? null) as string | null;
  const snapshot: Snapshot = { ...raw, run: deriveRun(raw.entries ?? [], stage) };

  const decision = decide(workflow, snapshot);
  // Reconcile needs post hooks to answer "already satisfied", and there are
  // none in this plan, so `next` prints the unreconciled plan.
  return { decision, effects: planEffects(decision) };
}
