import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { screenerFor, stepExecutorFor } from "#cli/start.js";
import { configProblems, loadConfig } from "#config/load.js";
import { ITEM_BRANCH } from "#conventions.js";
import { loadHooks } from "#hooks/load.js";
import { messageOf } from "#runner/errors.js";
import { notifyProblems } from "#runner/notify.js";
import { snapshotProvides } from "#runner/snapshot.js";
import { WorkflowLoadError } from "#workflow/load.js";
import { admitProblems, branchIsolationProblems, claimProblems, createProblems, pairingIsolationProblems, pairingStages, validate } from "#workflow/validate.js";
import { readWorkspace } from "#workflow/workspace.js";
import type { ExecutorContext, LoadedConfig, LoadedWorkflow, Problem, Registry, Source, Step, Workflow, Workspace, WorkspaceRead } from "#namespace.js";

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
 * behind it, `landrace validate` said "valid", and a real item waited at
 * `build` forever.
 *
 * A hook module that will not import is itself §11.1's "every referenced hook
 * file resolves", so it is reported as a problem — and coverage then abstains,
 * because calling every path in the workflow uncovered would bury the one
 * problem that is real.
 */
async function coverage(ws: Workspace, { dir, workflow, steps }: LoadedWorkflow, branch: string): Promise<{ problems: Problem[]; registry: Registry | null }> {
  try {
    const registry = await loadHooks({ dir, modules: workflow.hooks ?? [], workspace: ws.dir });
    return {
      problems: [
        ...validate(workflow, steps, snapshotProvides(registry.pre, registry.source) ?? undefined, branch),
        // Where the loaded tracker files issues: `start` refuses the same.
        ...createProblems(workflow, steps, registry.post),
      ],
      registry,
    };
  } catch (e) {
    // One exception: a node too old to read a TypeScript file is not a broken
    // workflow, and the CLI answers it by re-running itself with the flag —
    // which it can only do if the error reaches it.
    if ((e as { code?: unknown } | null)?.code === "ERR_UNKNOWN_FILE_EXTENSION") throw e;
    return { problems: [{ rule: "hooks", message: messageOf(e) }], registry: null };
  }
}

/**
 * `executor "<id>" could not start: <reason>`, `executorFor`'s own wrapping —
 * undone and reapplied per line. A factory can refuse for several reasons at
 * once (several bad `agent.*` keys, several unresolvable `agent.mcp`
 * entries), joined by `\n` into the one message it throws; left whole, that
 * printed as a single multi-line entry (`src/cli/index.ts`'s one-line-per-
 * problem report ran the lines together under one `  executor: `) and counted
 * as one problem when it was several. A message this does not recognise —
 * `unknownExecutor`'s, say, which names no id to prefix with — is returned
 * as the one problem it already is.
 */
const START_REFUSAL = /^executor "([^"]+)" could not start: ([\s\S]*)$/;

function startRefusalProblems(message: string): Problem[] {
  const m = START_REFUSAL.exec(message);
  if (!m) return [{ rule: "executor", message }];
  const id = m[1] ?? "";
  const reason = m[2] ?? "";
  return reason.split("\n").map((line) => ({ rule: "executor", message: `executor "${id}" could not start: ${line}` }));
}

/**
 * The executors the configuration names, built exactly as `start` builds them
 * and reported in the words it refuses with. The executor's setup can read
 * files outside the workflow itself, so a missing one is reported here too,
 * as `start` would refuse over it.
 */
async function executorProblems(dir: string, loaded: LoadedConfig, registry: Registry, workflow: Workflow, steps: ReadonlyMap<string, Step>): Promise<Problem[]> {
  const ctx: ExecutorContext = {
    config: loaded.config, secrets: loaded.secretValues, signal: new AbortController().signal,
    log: () => {}, dir, redact: () => {}, steps, pairingStages: pairingStages(workflow),
  };
  try {
    // Screener before executor, the same order `start` builds them in:
    // `buildWorkspaceRuntime` resolves its screener before it ever reaches the object
    // literal that awaits `stepExecutorFor` for the step — so a configuration
    // broken both ways is reported over the same one `start` would actually
    // meet first.
    await screenerFor(loaded.config, registry, ctx);
    await stepExecutorFor(loaded.config, registry, ctx);
    return [];
  } catch (e) {
    return startRefusalProblems(messageOf(e));
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
  const loaded = await loadConfig(dir).catch((e: unknown) => {
    // Absent is the CI case above; present and unreadable is what `start`
    // refuses, and reading it as absent would pass what start will not.
    if ((e as { code?: unknown } | null)?.code !== "ENOENT") problems.push({ rule: "config", message: messageOf(e) });
    return null;
  });
  if (loaded) problems.push(...configProblems(dir, loaded));

  /*
   * A var that did not resolve stops here, and the early return is the point.
   * Loading the workflow without it would report every `{vars.x}` a second
   * time as a name nothing declares — which is a misdescription of the one
   * thing that is wrong, in a file where the entry is right there.
   */
  if (loaded?.missingVars.length) return { ok: false, problems: [...problems, ...(await exposedEnv(dir))] };

  // A workspace whose layout cannot be read is itself the thing `validate`
  // exists to report — §11.1-§11.2 — so a load failure must become a Problem
  // here rather than propagate as an unhandled rejection past this function.
  let ws: WorkspaceRead;
  try {
    ws = await readWorkspace(dir, loaded?.vars, loaded?.config.workflows);
  } catch (e) {
    const rule = e instanceof WorkflowLoadError ? e.rule : "schema";
    return { ok: false, problems: [...problems, { rule, message: messageOf(e) }, ...(await exposedEnv(dir))] };
  }
  // A workflow that would not load is reported in its folder's name, and the
  // others are still checked: one broken file does not hide the rest.
  problems.push(...ws.failures);

  // Every workflow that loaded, each as it would run. With more than one, a
  // problem that did not say which it is in would send the reader through
  // every folder.
  const named = ws.ids.length > 1;
  // What the workflows share — the configuration, the executors it names,
  // the notifiers — is one problem however many of them meet it, said once
  // and attributed only when not every workflow does.
  const shared = new Map<string, { problem: Problem; ids: string[] }>();
  const sourceKeys = new Map<string, string>();
  const sources: unknown[] = [];
  for (const wf of ws.workflows) {
    const found = await workflowProblems(ws, wf, loaded);
    // Sameness is the identity of the loaded source object, as the tick's own
    // claims go by it. A workflow whose hooks did not load, or that has no
    // source, has no key, and the claim check abstains for it.
    if (found.source) {
      const at = sources.indexOf(found.source);
      sourceKeys.set(wf.id, `source-${at === -1 ? sources.push(found.source) - 1 : at}`);
    }
    problems.push(...(named ? found.own.map((p) => ({ ...p, message: `${wf.id}: ${p.message}` })) : found.own));
    for (const p of found.shared) {
      const key = `${p.rule}\n${p.message}`;
      const seen = shared.get(key);
      if (seen) seen.ids.push(wf.id);
      else shared.set(key, { problem: p, ids: [wf.id] });
    }
  }
  // Between workflows, so named by neither's prefix.
  problems.push(...claimProblems(ws, (id) => sourceKeys.get(id) ?? ""));
  for (const { problem, ids } of shared.values()) {
    problems.push(named && ids.length < ws.ids.length ? { ...problem, message: `${ids.join(", ")}: ${problem.message}` } : problem);
  }

  problems.push(...(await exposedEnv(dir)));
  return { ok: problems.length === 0, problems };
}

/**
 * One workflow's problems: its `own`, about its graph, its steps and its
 * hooks' coverage of it; and those `shared` with every workflow built against
 * the same configuration — the executors and the notifiers it names.
 */
async function workflowProblems(ws: Workspace, wf: LoadedWorkflow, loaded: LoadedConfig | null): Promise<{ own: Problem[]; shared: Problem[]; source: Source | null }> {
  const { workflow, steps } = wf;
  const own: Problem[] = [];

  /*
   * Everything answerable from the files alone, first and on its own.
   *
   * §11.8's path coverage is the one rule that needs the hooks — the union of
   * what the integrations declare is its other half — and importing a hook
   * module runs whatever is at its top level. So a workflow that is already
   * unsound never gets that far, the same ordering `buildWorkspaceRuntime` keeps and
   * for the same reason: the engine has already decided not to run this
   * workflow, and running the user's code against it anyway would be a
   * surprise nobody asked for.
   */
  // With no landrace.yaml to read — a workflow checked alone, in CI — the
  // branch is the default one, as it is for a landrace.yaml that sets none.
  const branch = loaded?.config.branch ?? ITEM_BRANCH;
  const graph: Problem[] = validate(workflow, steps, undefined, branch);
  let registry: Registry | null = null;
  if (graph.length === 0) {
    const result = await coverage(ws, wf, branch);
    own.push(...result.problems);
    registry = result.registry;
  } else {
    own.push(...graph);
  }
  // What `start` refuses about the workflow against its runtime, said here
  // too: validate passing what start will refuse is the two disagreeing.
  if (loaded) {
    own.push(...branchIsolationProblems(workflow, loaded.config.agent.isolation));
    own.push(...pairingIsolationProblems(workflow, loaded.config.agent.isolation));
  }
  own.push(...admitProblems(wf.id, workflow));

  // The executors the configuration names, built exactly as `start` builds
  // them: an executor's own setup can read files outside the workflow, so a
  // configuration mistake there is `validate`'s business too. Only once the
  // hooks are known to have loaded — a workflow already found unsound, or
  // whose hooks would not import, has no registry to build one against.
  const shared = loaded && registry
    ? [...(await executorProblems(ws.dir, loaded, registry, workflow, steps)), ...notifyProblems(loaded.config, registry)]
    : [];
  return { own, shared, source: registry?.source ?? null };
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
