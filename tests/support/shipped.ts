import type { LoadedWorkflow, Workspace } from "#namespace.js";
import { loadWorkspace } from "#workflow/workspace.js";

/**
 * This repository's own workflow, `main`, loaded the way the commands load
 * it: as one workflow of the `.landrace` workspace, its hook and step paths
 * resolved inside it.
 */
export async function loadShipped(vars?: ReadonlyMap<string, string>): Promise<LoadedWorkflow & { workspace: Workspace }> {
  const workspace = await loadWorkspace(".landrace", vars);
  const main = workspace.workflows.find((w) => w.id === "main");
  if (!main) throw new Error(`.landrace has no workflows/main; it has ${workspace.workflows.map((w) => w.id).join(", ")}`);
  return { ...main, workspace };
}
