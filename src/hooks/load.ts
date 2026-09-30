import { pathToFileURL } from "node:url";
import { containedPath } from "#workflow/load.js";
import { artifactPreHook } from "#runner/artifacts.js";
import { createDispatcher } from "#runner/effects.js";
import { messageOf } from "#runner/errors.js";
import { hookKindOf } from "#hooks/contracts.js";
import type {
  ArtifactHook,
  Claim,
  Executor,
  ExecutorFactory,
  HookModule,
  Notifier,
  Operator,
  PostHook,
  PreHook,
  Preflight,
  Registry,
  Source,
} from "#namespace.js";

const both = (a: Claim, b: Claim): string =>
  `"${a.id}" from "${a.from}" and "${b.id}" from "${b.from}"`;

/**
 * Sort what a module exported into the registry.
 *
 * Kept apart from the importing so the classification rules — which are where
 * the ambiguity lives — can be tested against plain objects, without a module
 * graph to stand up first.
 */
export function buildRegistry(modules: HookModule[]): Registry {
  const pre: PreHook[] = [];
  const post: PostHook[] = [];
  const artifacts: ArtifactHook[] = [];
  const preflights: Preflight[] = [];
  const executors = new Map<string, Executor | ExecutorFactory>();
  const preIds = new Map<string, Claim>();
  const postIds = new Map<string, Claim>();
  const executorIds = new Map<string, Claim>();
  const preflightIds = new Map<string, Claim>();
  const notifiers = new Map<string, Notifier>();
  const notifierIds = new Map<string, Claim>();
  let source: { hook: Source; claim: Claim } | null = null;
  let operator: { hook: Operator; claim: Claim } | null = null;

  const claimed = (
    seen: Map<string, Claim>,
    what: string,
    claim: Claim,
  ): void => {
    const existing = seen.get(claim.id);
    // An id names a hook within its phase, not across the registry: one
    // integration writes both halves and calls them both by its own name.
    if (existing) throw new Error(`two ${what} share the id "${claim.id}": "${existing.from}" and "${claim.from}"`);
    seen.set(claim.id, claim);
  };

  const addPre = (hook: PreHook, from: string): void => {
    claimed(preIds, "pre hooks", { id: hook.id, from });
    pre.push(hook);
  };

  const addPost = (hook: PostHook, from: string): void => {
    claimed(postIds, "post hooks", { id: hook.id, from });
    post.push(hook);
  };

  for (const module of modules) {
    // Sorted, because there is no declaration order to recover: an ES module
    // namespace object sorts its own keys, and a transform that builds a plain
    // object does not. Sorting here is the same answer under both.
    for (const name of Object.keys(module.exports).sort()) {
      const value = module.exports[name];
      const claim: Claim = { id: "", from: module.specifier };

      switch (hookKindOf(value)) {
        case "pre":
          addPre(value as PreHook, module.specifier);
          break;
        case "post":
          addPost(value as PostHook, module.specifier);
          break;
        case "artifact": {
          // One object, both phases. §5 is explicit that there are still only
          // two, so an artifact is not a third phase — it is a post hook whose
          // observe half the loader files for it, under `artifacts.<id>`.
          const hook = value as ArtifactHook;
          addPre(artifactPreHook(hook), module.specifier);
          addPost(hook, module.specifier);
          // Kept whole beside its two halves: a briefing is neither snapshot
          // state nor an effect, so the runner asks the hook itself for one.
          artifacts.push(hook);
          break;
        }
        case "source": {
          const hook = value as Source;
          claim.id = hook.id;
          if (source) throw new Error(`two sources are loaded: ${both(source.claim, claim)}`);
          source = { hook, claim };
          break;
        }
        case "operator": {
          const hook = value as Operator;
          claim.id = hook.id;
          if (operator) throw new Error(`two operators are loaded: ${both(operator.claim, claim)}`);
          operator = { hook, claim };
          break;
        }
        case "executor": {
          const hook = value as Executor | ExecutorFactory;
          claimed(executorIds, "executors", { id: hook.id, from: module.specifier });
          executors.set(hook.id, hook);
          break;
        }
        case "preflight": {
          const hook = value as Preflight;
          claimed(preflightIds, "preflights", { id: hook.id, from: module.specifier });
          preflights.push(hook);
          break;
        }
        case "notifier": {
          const hook = value as Notifier;
          claimed(notifierIds, "notifiers", { id: hook.id, from: module.specifier });
          notifiers.set(hook.id, hook);
          break;
        }
        // A module is free to export helpers, constants and types.
        case null:
          break;
      }
    }
  }

  // The duplicate-effect-type rule already lives in the dispatcher, and one
  // rule wants one implementation. Building it here also moves the collision
  // from "the first effect that happens to hit it" to load time.
  createDispatcher(post);

  return {
    preflights, pre, post, artifacts, source: source?.hook ?? null, operator: operator?.hook ?? null, executors, notifiers,
  };
}

/**
 * Why an import failed, in terms of what to do about it.
 *
 * `.landrace/hooks/*.ts` is imported at runtime with nothing compiling it
 * first, so the single likeliest failure on a given machine is a Node too old
 * to read a TypeScript file — and the raw "Unknown file extension .ts" tells
 * an operator nothing about which of their two problems it is.
 */
export function importFailure(specifier: string, error: unknown): Error {
  if ((error as { code?: unknown } | null)?.code === "ERR_UNKNOWN_FILE_EXTENSION") {
    // The code rides along on the wrapper. `landrace start` and `landrace mcp`
    // re-run themselves with --experimental-strip-types on exactly this
    // failure, and a CLI that decided that by matching the sentence below
    // would stop deciding it the first time someone improves the wording.
    return Object.assign(
      new Error(
        `cannot import hook module "${specifier}": this Node cannot read a TypeScript file. ` +
        "Node 22.18 and newer strip types with no flag; on an older 22.x, run node with " +
        "--experimental-strip-types. Not tsx, jiti or ts-node — a loader that rewrites the module " +
        "graph is exactly what should not sit under a hook.",
      ),
      { code: "ERR_UNKNOWN_FILE_EXTENSION" },
    );
  }
  const reason = messageOf(error);
  // A hook written against a newer landrace than the one loading it — in this
  // repository, a dist/ not rebuilt since a pull — fails on its first import
  // line, and Node names only the export it could not find, which reads as a
  // bug in the hook rather than a build to run. Only when the module Node
  // quotes is landrace's own — the package, `landrace/hooks`, `landrace/kit`
  // or one `landrace/integrations/<vendor>`: a sibling of the hook lacking an
  // export is the hook's bug, and a rebuild would fix nothing.
  const stale = (error as { name?: unknown } | null)?.name === "SyntaxError" &&
    /^The requested module 'landrace(?:\/(?:hooks|kit|integrations\/[a-z0-9-]+))?' does not provide an export named /.test(reason);
  return new Error(
    `cannot import hook module "${specifier}": ${reason}` +
    (stale ? "; the landrace this hook was loaded against may be older than the hook expects: rebuild or update it" : ""),
  );
}

/**
 * Import every module a workflow names, and sort what they export.
 *
 * `dir` is the workflow directory; `modules` are paths relative to it, and
 * they must stay inside it. `workflow.yaml` is a repo file a contributor can
 * edit in a PR and `import()` runs whatever it names, so this is the same
 * containment the step files get — the same helper, both ends compared after
 * `fs.realpath`, because git tracks symlinks and a lexical check does not
 * survive one.
 */
export async function loadHooks(opts: { dir: string; modules: string[] }): Promise<Registry> {
  // Every path is resolved before any module is imported. Importing as we go
  // would have already run the first module's top-level code by the time the
  // second one turns out to point outside the directory — and the whole reason
  // to check a path is that importing it is the thing we cannot take back.
  const listed = new Map<string, string>();
  const resolved: Array<{ specifier: string; path: string }> = [];

  for (const specifier of opts.modules) {
    const where = await containedPath(opts.dir, specifier);
    if (!where.ok) throw new Error(`hook module "${specifier}" ${where.reason}`);

    // Caught here rather than left to surface as "two pre hooks share the id":
    // a path listed twice is a typo in the list, and saying so beats reporting
    // it as the ambiguity it eventually causes.
    const first = listed.get(where.path);
    if (first !== undefined) {
      throw new Error(`hook module "${specifier}" is listed twice${first === specifier ? "" : ` (also as "${first}")`}`);
    }
    listed.set(where.path, specifier);
    resolved.push({ specifier, path: where.path });
  }

  const loaded: HookModule[] = [];
  for (const { specifier, path } of resolved) {
    try {
      loaded.push({ specifier, exports: (await import(pathToFileURL(path).href)) as Record<string, unknown> });
    } catch (e) {
      throw importFailure(specifier, e);
    }
  }

  return buildRegistry(loaded);
}
