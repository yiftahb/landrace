import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { configProblems, loadConfig } from "#config/load.js";
import { resolveStepServers } from "#config/mcp.js";
import { loadHooks } from "#hooks/load.js";
import { messageOf } from "#runner/errors.js";
import { snapshotProvides } from "#runner/snapshot.js";
import { loadWorkflow, WorkflowLoadError } from "#workflow/load.js";
import { validate } from "#workflow/validate.js";
import type { Problem } from "#namespace.js";

const execFileAsync = promisify(execFile);

/**
 * True when `<dir>/.env` is an exposure risk: git can see it and says it is
 * NOT ignored. Gitignore semantics — negation, nesting, precedence across
 * multiple files — are a losing game to reimplement, so this asks git
 * directly via `git check-ignore` rather than pattern-matching a .gitignore
 * file by hand.
 *
 * `cwd` is set to `dir` itself (not the process's cwd) so git discovers the
 * repository that actually contains the workflow folder — required both for
 * a `dir` that sits below the process's cwd in a *different* repository (or
 * no repository) and for one nested several levels below the repo root,
 * where a root-level `**\/.env` pattern must still resolve correctly.
 *
 * Exit 0 means ignored (not exposed), exit 1 means tracked/not-ignored
 * (exposed), and anything else — 128 for "not a git repository", or git
 * missing from PATH entirely — means the question doesn't apply, so this
 * returns "not exposed": neither situation can leak a credential into a
 * git-tracked commit, and flagging one would be a false positive on an
 * otherwise legitimate setup.
 */
async function isEnvExposed(dir: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["check-ignore", "-q", ".env"], { cwd: dir });
    return false;
  } catch (e) {
    const code = (e as { code?: number | string }).code;
    return code === 1;
  }
}

/**
 * §11.8, which is the one rule that cannot be answered from the workflow file
 * alone: every predicate path has to be covered by some hook's `provides`.
 *
 * Dormant until now — `runValidate` never passed `provided`, so the rule
 * compared nothing to nothing and reported everything valid. That is not a
 * hypothetical: the shipped workflow read `artifacts.pr.number` with no hook
 * behind it, `landrace validate` said "valid", and a real ticket waited at
 * `build` forever.
 *
 * A hook module that will not import is itself §11.1's "every referenced hook
 * file resolves", so it is reported as a problem — and coverage then abstains,
 * because calling every path in the workflow uncovered would bury the one
 * problem that is real.
 */
async function coverage(
  dir: string,
  workflow: Awaited<ReturnType<typeof loadWorkflow>>["workflow"],
  steps: Awaited<ReturnType<typeof loadWorkflow>>["steps"],
): Promise<Problem[]> {
  try {
    const registry = await loadHooks({ dir, modules: workflow.hooks ?? [] });
    return validate(workflow, steps, snapshotProvides(registry.pre, registry.source) ?? undefined);
  } catch (e) {
    // One exception: a node too old to read a TypeScript file is not a broken
    // workflow, and the CLI answers it by re-running itself with the flag —
    // which it can only do if the error reaches it.
    if ((e as { code?: unknown } | null)?.code === "ERR_UNKNOWN_FILE_EXTENSION") throw e;
    return [{ rule: "hooks", message: messageOf(e) }];
  }
}

export async function runValidate(dir: string): Promise<{ ok: boolean; problems: Problem[] }> {
  const problems: Problem[] = [];

  /*
   * The configuration first, because the workflow cannot be read without it:
   * `vars` is substituted into the graph and the step files at load, so what
   * `validate` goes on to check is the workflow as it would actually run.
   *
   * Optional, so a workflow can still be checked in isolation — in CI, for
   * instance, where no tracker credentials exist. A `{vars.x}` in the graph
   * then has nothing to resolve against and is reported as exactly that.
   */
  const loaded = await loadConfig(dir).catch(() => null);
  if (loaded) problems.push(...configProblems(dir, loaded));

  /*
   * The servers `agent.mcp` allows, looked up exactly as `start` looks them up
   * and reported in the same words it refuses with. A missing `.mcp.json` is
   * reported too, although it is a fact about this checkout rather than the
   * workflow — agsync generates it and it is gitignored — because the one
   * place skipping it would help is the one command whose "valid" an operator
   * reads as "start will run".
   */
  if (loaded) problems.push(...(await resolveStepServers(dir, loaded.config.agent.mcp)).problems);

  /*
   * A var that did not resolve stops here, and the early return is the point.
   * Loading the workflow without it would report every `{vars.x}` a second
   * time as a name nothing declares — which is a misdescription of the one
   * thing that is wrong, in a file where the entry is right there.
   */
  if (loaded?.missingVars.length) return { ok: false, problems: [...problems, ...(await exposedEnv(dir))] };

  // A workflow that fails to load is itself the thing `validate` exists to
  // report — §11.1-§11.2 — so a load failure must become a Problem here
  // rather than propagate as an unhandled rejection past this function.
  let workflow: Awaited<ReturnType<typeof loadWorkflow>>["workflow"];
  let steps: Awaited<ReturnType<typeof loadWorkflow>>["steps"];
  try {
    ({ workflow, steps } = await loadWorkflow(dir, loaded?.vars));
  } catch (e) {
    const rule = e instanceof WorkflowLoadError ? e.rule : "schema";
    return { ok: false, problems: [...problems, { rule, message: messageOf(e) }, ...(await exposedEnv(dir))] };
  }

  /*
   * Everything answerable from the files alone, first and on its own.
   *
   * §11.8's path coverage is the one rule that needs the hooks — the union of
   * what the integrations declare is its other half — and importing a hook
   * module runs whatever is at its top level. So a workflow that is already
   * unsound never gets that far, the same ordering `buildRuntime` keeps and
   * for the same reason: the engine has already decided not to run this
   * workflow, and running the user's code against it anyway would be a
   * surprise nobody asked for.
   */
  const graph: Problem[] = validate(workflow, steps);
  problems.push(...(graph.length === 0 ? await coverage(dir, workflow, steps) : graph));

  problems.push(...(await exposedEnv(dir)));
  return { ok: problems.length === 0, problems };
}

/**
 * A token in a committed file is the cheapest possible catastrophe, so this is
 * asked on every path out of `runValidate` — including the ones that gave up
 * on the workflow. A broken graph is not a reason to stop looking at the
 * credential sitting next to it.
 */
async function exposedEnv(dir: string): Promise<Problem[]> {
  const envPath = join(dir, ".env");
  const env = await readFile(envPath, "utf8").catch(() => null);
  return env !== null && (await isEnvExposed(dir))
    ? [{ rule: "secret", message: `${envPath} exists but is not gitignored` }]
    : [];
}
