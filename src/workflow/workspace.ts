import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { LoadedWorkflow, Workspace } from "#namespace.js";
import { loadWorkflow, WorkflowLoadError } from "#workflow/load.js";

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Not localeCompare: the order must not depend on the machine's locale.
const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const exists = (p: string) => stat(p).then(() => true, () => false);

/**
 * Every workflow under `<dir>/workflows/<id>/`, loaded and ordered. One layout
 * only: a `workflow.yaml` at the root is the layout before workspaces, and
 * loading it beside the new one would be two answers to "what runs here".
 */
export async function loadWorkspace(dir: string, vars: ReadonlyMap<string, string> = new Map(), order?: readonly string[]): Promise<Workspace> {
  if (await exists(join(dir, "workflow.yaml"))) {
    throw new WorkflowLoadError("layout",
      `${join(dir, "workflow.yaml")} is the layout before workspaces; move it to ${join(dir, "workflows", "main", "workflow.yaml")}, with its steps/ beside it`);
  }
  const root = join(dir, "workflows");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const ids: string[] = [];
  for (const e of entries) {
    // Dirent does not follow links, so without this a linked workflow is
    // skipped and reported as "no workflows" or a missing folder.
    if (e.isSymbolicLink()) throw new WorkflowLoadError("layout", `workflows/${e.name} is a symbolic link; a workflow must be a real folder inside the workspace`);
    if (!e.isDirectory() || !(await exists(join(root, e.name, "workflow.yaml")))) continue;
    if (!ID.test(e.name)) throw new WorkflowLoadError("layout", `workflows/"${e.name}" is not a usable workflow id: lowercase letters, digits and "-", starting with a letter or digit`);
    ids.push(e.name);
  }
  if (ids.length === 0) throw new WorkflowLoadError("layout", `${dir} has no workflows: create ${join(dir, "workflows", "<id>", "workflow.yaml")}`);

  const workflows: LoadedWorkflow[] = [];
  for (const id of ids) {
    const wdir = join(root, id);
    workflows.push({ id, dir: wdir, ...(await loadWorkflow(wdir, vars, { workspace: dir })) });
  }

  if (order) {
    // indexOf would silently take the first of two; ambiguity halts.
    const twice = order.find((id, i) => order.indexOf(id) !== i);
    if (twice !== undefined) throw new WorkflowLoadError("layout", `landrace.yaml workflows: names "${twice}" twice`);
    const missing = ids.filter((id) => !order.includes(id));
    const extra = order.filter((id) => !ids.includes(id));
    if (missing.length || extra.length) {
      throw new WorkflowLoadError("layout", [
        missing.length ? `landrace.yaml workflows: does not name ${missing.map((m) => `"${m}"`).join(", ")}` : "",
        extra.length ? `landrace.yaml workflows: names ${extra.map((x) => `"${x}"`).join(", ")}, which has no folder under workflows/` : "",
      ].filter(Boolean).join("; "));
    }
    workflows.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  } else {
    workflows.sort((a, b) => byCodePoint(a.workflow.name, b.workflow.name) || byCodePoint(a.id, b.id));
  }
  return { dir, workflows };
}

/**
 * The workspace's one workflow, for a command that runs one. Two are refused
 * rather than one of them taken: whichever sorted first is not a choice
 * anybody made, and an item worked by it is worked by a workflow nobody chose.
 */
export function onlyWorkflow(ws: Workspace, command: string): LoadedWorkflow {
  const [only, ...more] = ws.workflows;
  if (!only || more.length) {
    throw new Error(
      `landrace ${command} runs one workflow at a time; ${ws.dir}/workflows has ${ws.workflows.length} (${ws.workflows.map((w) => w.id).join(", ")})`,
    );
  }
  return only;
}
