import { readFile } from "node:fs/promises";
import { loadConfig } from "#config/load.js";
import { decide, deriveRun, planEffects } from "#core/index.js";
import type { Decision, Effect, Snapshot } from "#namespace.js";
import { loadWorkspace, onlyWorkflow, workflowById } from "#workflow/workspace.js";

export async function runNext(
  dir: string,
  snapshotPath: string,
  workflowId?: string,
): Promise<{ decision: Decision; effects: Effect[] }> {
  // The vars the workflow is substituted with, when there is a configuration
  // to read them from — `next` explains what the engine would do, and a
  // workflow whose predicates it read unsubstituted is a different workflow.
  // Optional, like validate's: this command is otherwise I/O-free by design.
  const loaded = await loadConfig(dir).catch(() => undefined);
  const ws = await loadWorkspace(dir, loaded?.vars, loaded?.config.workflows);
  const { workflow } = workflowId === undefined ? onlyWorkflow(ws, "next") : workflowById(ws, workflowId);
  const raw = JSON.parse(await readFile(snapshotPath, "utf8")) as Snapshot;

  const stage = (raw.run?.stage ?? null) as string | null;
  const snapshot: Snapshot = { ...raw, run: deriveRun(raw.entries ?? [], stage) };

  const decision = decide(workflow, snapshot);
  // Reconcile needs post hooks to answer "already satisfied", and there are
  // none in this plan, so `next` prints the unreconciled plan.
  // The item the snapshot is of, when it says: `{item}` in an effect is
  // that id, and a snapshot with no node leaves it visible rather than blank.
  const id = (snapshot.node as { id?: unknown } | undefined)?.id;
  return { decision, effects: planEffects(decision, snapshot, typeof id === "string" ? id : null) };
}
