import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { parse } from "yaml";
import type { z } from "zod";
import type { ContainedPath, LoadFailureRule, Step, Workflow } from "#namespace.js";
import { stepFrontMatterSchema, workflowSchema } from "#workflow/schema.js";
import { substituteVars } from "#workflow/vars.js";
import { messageOf } from "#runner/errors.js";

export class WorkflowLoadError extends Error {
  readonly rule: LoadFailureRule;

  constructor(rule: LoadFailureRule, message: string) {
    super(message);
    this.name = "WorkflowLoadError";
    this.rule = rule;
  }
}

// `root + sep` doubles up when root is already the filesystem root ("/" + "/"
// = "//"), which no absolute path starts with — every path was reported as
// escaping "/" regardless of shape. Harmless before now: every caller passed
// a real project directory as root, never "/" itself, until the claude
// executor started reusing this for an already-absolute cwd (see
// src/agent/claude.ts's assertCwd).
const inside = (p: string, root: string): boolean =>
  p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * Shapes that are never a relative path inside a directory, checked before any
 * resolution so each is reported as what it is rather than surfacing later as
 * "that file does not exist" — a misdescription an operator would chase.
 */
function shapeProblem(p: string): string | null {
  if (p.trim() === "") return "is empty";
  if (isAbsolute(p) || p.startsWith("/")) return "is absolute";
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(p)) return "is a URL or a drive path, not a relative path";
  if (p.includes("\\")) return "contains a backslash";
  if (p.includes("%")) return "is percent-encoded";
  const dotted = p.split("/").find((seg) => /^\.{2,}$/.test(seg));
  if (dotted !== undefined) return `contains a "${dotted}" segment`;
  return null;
}

/**
 * A configured path resolved to a real file inside `root`, or the reason it is
 * not one.
 *
 * Path arithmetic alone is containment against a typo, not against a
 * contributor: git tracks symlinks, so the same PR that edits workflow.yaml
 * can add the link a lexically-contained path escapes through — both a
 * symlinked file and a symlinked directory did, and validate reported the
 * workflow as fine. Both ends are therefore compared after fs.realpath, and a
 * path that does not exist is reported as missing rather than as contained.
 *
 * Exported because this applies to every configured path opened out of a repo
 * file, not only a step file — a hook loader needs exactly this.
 */
export async function containedPath(root: string, relative: string): Promise<ContainedPath> {
  const shape = shapeProblem(relative);
  if (shape) return { ok: false, kind: "unsafe", reason: shape };

  // A root that is itself reached through a link is still a legitimate root;
  // what matters is that both sides are compared in the same, real terms.
  const realRoot = await realpath(resolve(root)).catch(() => resolve(root));
  const candidate = resolve(realRoot, relative);
  if (!inside(candidate, realRoot)) return { ok: false, kind: "unsafe", reason: "resolves outside the directory" };

  let real: string;
  try {
    real = await realpath(candidate);
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return { ok: false, kind: "missing", reason: "does not exist" };
    return { ok: false, kind: "unsafe", reason: `cannot be resolved: ${messageOf(e)}` };
  }

  return inside(real, realRoot)
    ? { ok: true, path: real }
    : { ok: false, kind: "unsafe", reason: "is a link to something outside the directory" };
}

/**
 * A schema failure, said in one line an operator can act on.
 *
 * The unrecognised-key case is the one worth spelling out, because both
 * schemas are strict and that is the whole point of them: a key the engine
 * does not read is refused at load rather than parsed and silently dropped.
 * `skills:`, `budget.spec` and `artifacts:` were each written in a real file,
 * ignored, and never mentioned again — and `model: haiku` was ignored exactly
 * the same way, at opus prices, on every human reply. `capabilities:` was
 * always refused when nothing enforced it; this is the same rule, applied to
 * every other field instead of only that one.
 *
 * Zod's own `.message` for a failure is a JSON dump of every issue, which is a
 * stack trace by another name — and CLAUDE.md: errors report, they do not
 * crash.
 */
function sayWhy(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const at = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      if (issue.code !== "unrecognized_keys") return `${at}${issue.message}`;
      const named = issue.keys.map((k) => `"${k}"`).join(", ");
      return (
        `${at}${named} ${issue.keys.length > 1 ? "are" : "is"} not read by this engine; ` +
        "a declaration nothing reads is a promise nothing keeps, so it is refused rather than ignored"
      );
    })
    .join("; ");
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseStep(source: string): Step {
  const m = source.match(FRONT_MATTER);
  if (!m) throw new Error("a step file must begin with YAML front matter");
  const front = stepFrontMatterSchema.safeParse(parse(m[1] as string) ?? {});
  if (!front.success) throw new Error(`front matter is not valid: ${sayWhy(front.error)}`);
  return { ...front.data, prompt: m[2] as string };
}

/**
 * The graph and its steps, with every `{vars.x}` already filled in.
 *
 * `vars` is configuration, not state: it does not vary per ticket, so it is
 * resolved once (config/load.ts) and substituted here, before anything
 * validates anything. Everything downstream — the schema's judgement, the
 * operator allowlist, path-coverage, the predicate itself — then sees a
 * literal exactly as if it had been typed, which is what keeps this out of the
 * snapshot and out of the predicate language: comparing one snapshot path
 * against another would need `$expr`, and `$expr` is outside the allowlist on
 * purpose.
 *
 * Callers with no vars pass none, and a workflow with no references loads
 * exactly as it did before.
 */
export async function loadWorkflow(
  dir: string,
  vars: ReadonlyMap<string, string> = new Map(),
): Promise<{ workflow: Workflow; steps: Map<string, Step> }> {
  const raw = parse(await readFile(join(dir, "workflow.yaml"), "utf8"));
  const parsed = workflowSchema.safeParse(raw);
  if (!parsed.success) throw new WorkflowLoadError("schema", sayWhy(parsed.error));

  /*
   * Every reference in the workflow and in every step file, gathered before
   * any of it is reported.
   *
   * Both halves are load failures. An unresolved `{vars.x}` left in place is a
   * predicate that matches nothing and an effect body with a stray token in
   * it; a declared var nothing references is harmless in itself and almost
   * always the same typo seen from the other end — and this codebase has twice
   * shipped a declaration nobody read (`log.redact` naming no secret, four
   * workflow fields parsed and dropped), which is why "harmless" is not a
   * reason to stay quiet.
   */
  const unresolved: string[] = [];
  const used = new Set<string>();
  const fill = <T>(tree: T, at: string): T => {
    const out = substituteVars(tree, vars, at);
    unresolved.push(...out.unresolved);
    for (const name of out.used) used.add(name);
    return out.value as T;
  };

  const workflow = fill(parsed.data as Workflow, "workflow.yaml");

  const seen = new Set<string>();
  for (const stage of workflow.stages) {
    if (seen.has(stage.id)) throw new WorkflowLoadError("duplicate-id", `duplicate stage id "${stage.id}"`);
    seen.add(stage.id);
  }

  // A step's body goes straight into an agent's prompt, and workflow.yaml is a
  // repo file a contributor's PR can edit: `step: ../../outside-secret.md`, or
  // a symlink to the same place, read that file and prompted with it.
  const steps = new Map<string, Step>();
  for (const stage of workflow.stages) {
    if (!stage.step || steps.has(stage.step)) continue;

    const where = await containedPath(dir, stage.step);
    if (!where.ok) {
      throw new WorkflowLoadError(
        where.kind === "missing" ? "missing-step" : "step-path",
        where.kind === "missing"
          ? `stage "${stage.id}" names a step file that does not exist: ${stage.step}`
          : `stage "${stage.id}" names a step file that ${where.reason}: ${stage.step}`,
      );
    }

    // Existence was decided above, by the same realpath the containment check
    // used; a second "does it exist" guard here would be unreachable.
    const source = await readFile(where.path, "utf8");
    try {
      steps.set(stage.step, fill(parseStep(source), stage.step));
    } catch (e) {
      // Named, because "front matter is not valid" is unactionable when a
      // workflow has five step files and the loader read them in graph order.
      throw new WorkflowLoadError("schema", `step ${stage.step}: ${messageOf(e)}`);
    }
  }

  const declared = [...vars.keys()];
  const idle = declared.filter((name) => !used.has(name));
  if (unresolved.length || idle.length) {
    throw new WorkflowLoadError("vars", [
      ...unresolved.map((where) =>
        `${where}, which no vars entry defines` +
        `${declared.length ? ` — declared vars: ${declared.join(", ")}` : " — no vars are declared"}`),
      ...idle.map((name) =>
        `vars entry "${name}" is declared and nothing references it; ` +
        "a variable nothing reads is usually the same typo as one nothing defines"),
    ].join("; "));
  }

  return { workflow, steps };
}
