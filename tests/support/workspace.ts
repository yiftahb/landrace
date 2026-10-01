import { cp, mkdir, mkdtemp, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Where a workspace keeps the workflow with this id. */
export const workflowIn = (workspace: string, id = "main"): string => join(workspace, "workflows", id);

/**
 * A fresh workspace holding a copy of each fixture folder as `workflows/<id>/`.
 *
 * The fixtures under tests/fixtures are single workflows, loaded on their own
 * by most tests; a command loads a workspace, so it is handed one of these. A
 * fixture's `landrace.yaml` and `.env` belong to the workspace rather than to
 * any one workflow in it, so they move to its root.
 */
export async function workspaceOf(workflows: Record<string, string>, root?: string): Promise<string> {
  const ws = root ?? (await mkdtemp(join(tmpdir(), "lr-workspace-")));
  for (const [id, fixture] of Object.entries(workflows)) {
    const dir = workflowIn(ws, id);
    await mkdir(join(ws, "workflows"), { recursive: true });
    await cp(fixture, dir, { recursive: true });
    for (const name of ["landrace.yaml", ".env"]) {
      await rename(join(dir, name), join(ws, name)).catch((e: unknown) => {
        if ((e as { code?: unknown }).code !== "ENOENT") throw e;
      });
    }
  }
  return ws;
}
