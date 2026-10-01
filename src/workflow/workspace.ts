import { lstat, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { LoadFailure, LoadedWorkflow, Workspace, WorkspaceRead } from "#namespace.js";
import { messageOf } from "#runner/errors.js";
import { idleVars, loadWorkflow, WorkflowLoadError } from "#workflow/load.js";

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Not localeCompare: the order must not depend on the machine's locale.
const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const exists = (p: string) => stat(p).then(() => true, () => false);

/**
 * Every workflow under `<dir>/workflows/<id>/`, loaded and ordered. One layout
 * only: a `workflow.yaml` at the root is the layout before workspaces, and
 * loading it beside the new one would be two answers to "what runs here".
 *
 * Refused if any workflow will not load, with every failure named by its
 * folder: a command that runs a workflow must not run beside one it could
 * not read.
 */
export async function loadWorkspace(dir: string, vars: ReadonlyMap<string, string> = new Map(), order?: readonly string[]): Promise<Workspace> {
  const { workflows, failures } = await readWorkspace(dir, vars, order);
  const [first] = failures;
  if (first) throw new WorkflowLoadError(first.rule, failures.map((f) => f.message).join("; "));
  return { dir, workflows };
}

/**
 * The workspace as far as it will load: what is wrong with the layout is
 * thrown, since nothing in it can be read; what is wrong with one workflow is
 * a failure beside the ones that loaded, so `validate` can report it and still
 * check the rest. Every workflow is tried, in id order, whatever came before.
 */
export async function readWorkspace(dir: string, vars: ReadonlyMap<string, string> = new Map(), order?: readonly string[]): Promise<WorkspaceRead> {
  if (await exists(join(dir, "workflow.yaml"))) {
    // Pointed at a workflow folder, as `--workflow <dir>` once was, the fix is
    // the flag; the move advice would nest the folder inside itself.
    if (basename(dirname(dir)) === "workflows") {
      const workspace = dirname(dirname(dir));
      throw new WorkflowLoadError("layout", `${dir} is one workflow of the workspace ${workspace}; run with --workspace ${workspace}`);
    }
    throw new WorkflowLoadError("layout",
      `${join(dir, "workflow.yaml")} is the layout before workspaces; move it to ${join(dir, "workflows", "main", "workflow.yaml")}, with its steps/ beside it, ` +
      "then give each hook path a leading ../../ (../../hooks/<module>.ts), add the required description:, and add admit: with the labels a started item gets");
  }
  const root = join(dir, "workflows");
  // readdir follows a linked workflows/ silently, and its steps then fail a
  // containment check with a message about a step path nobody wrote.
  if ((await lstat(root).catch(() => null))?.isSymbolicLink()) {
    throw new WorkflowLoadError("layout", "workflows is a symbolic link; workflows must be a real folder inside the workspace");
  }
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
  ids.sort(byCodePoint);

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
  }

  const workflows: LoadedWorkflow[] = [];
  const failures: LoadFailure[] = [];
  const used = new Set<string>();
  for (const id of ids) {
    const wdir = join(root, id);
    try {
      workflows.push({ id, dir: wdir, ...(await loadWorkflow(wdir, vars, { workspace: dir, used })) });
    } catch (e) {
      failures.push({ rule: e instanceof WorkflowLoadError ? e.rule : "schema", message: `workflows/${id}: ${messageOf(e)}` });
    }
  }
  // `vars` is the workspace's, so whether anything reads one is asked of
  // every workflow at once — and not at all while one would not load, since
  // what that one reads is unknown and calling its var unread would be a guess.
  const idle = failures.length ? [] : idleVars(vars, used);
  if (idle.length) failures.push({ rule: "vars", message: idle.join("; ") });

  if (order) {
    workflows.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  } else {
    workflows.sort((a, b) => byCodePoint(a.workflow.name, b.workflow.name) || byCodePoint(a.id, b.id));
  }
  return { dir, workflows, ids, failures };
}

/** The workflow with this id, or the reason there is none by that id. */
export function workflowById(ws: Workspace, id: string): LoadedWorkflow {
  const found = ws.workflows.find((w) => w.id === id);
  if (!found) throw new Error(`no workflow "${id}" in ${ws.dir}; it has ${ws.workflows.map((w) => w.id).join(", ")}`);
  return found;
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
