import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { parse } from "yaml";
import type { Workflow } from "../core/types.js";
import { stepFrontMatterSchema, workflowSchema, type StepFrontMatter } from "./schema.js";

export interface Step extends StepFrontMatter {
  prompt: string;
}

/**
 * `runValidate` must report a broken workflow as a `Problem`, not let an
 * exception escape past it (spec §11.1-§11.2: `validate`'s entire job is
 * reporting). Tagging the failure with a `rule` here — at the point each kind
 * of failure is actually detected — is what lets the CLI turn it into the
 * same shape as every other problem, instead of pattern-matching an error
 * message after the fact.
 */
export type LoadFailureRule = "schema" | "duplicate-id" | "missing-step" | "step-path";

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

export type ContainedPath =
  | { ok: true; path: string }
  | { ok: false; kind: "unsafe" | "missing"; reason: string };

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
    return { ok: false, kind: "unsafe", reason: `cannot be resolved: ${(e as Error).message}` };
  }

  return inside(real, realRoot)
    ? { ok: true, path: real }
    : { ok: false, kind: "unsafe", reason: "is a link to something outside the directory" };
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseStep(source: string): Step {
  const m = source.match(FRONT_MATTER);
  if (!m) throw new Error("a step file must begin with YAML front matter");
  const front = stepFrontMatterSchema.parse(parse(m[1] as string) ?? {});
  return { ...front, prompt: m[2] as string };
}

export async function loadWorkflow(dir: string): Promise<{ workflow: Workflow; steps: Map<string, Step> }> {
  const raw = parse(await readFile(join(dir, "workflow.yaml"), "utf8"));
  let workflow: Workflow;
  try {
    workflow = workflowSchema.parse(raw) as Workflow;
  } catch (e) {
    throw new WorkflowLoadError("schema", (e as Error).message);
  }

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
    steps.set(stage.step, parseStep(source));
  }

  return { workflow, steps };
}
