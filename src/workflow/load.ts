import { readFile } from "node:fs/promises";
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
  // repo file a contributor's PR can edit: `step: ../../outside-secret.md`
  // read that file and prompted with it. Containment is checked on the
  // resolved path, before anything is read.
  const root = resolve(dir);

  const steps = new Map<string, Step>();
  for (const stage of workflow.stages) {
    if (!stage.step || steps.has(stage.step)) continue;

    const resolved = resolve(root, stage.step);
    if (isAbsolute(stage.step) || !(resolved === root || resolved.startsWith(root + sep))) {
      throw new WorkflowLoadError(
        "step-path",
        `stage "${stage.id}" names a step file outside the workflow directory: ${stage.step}`,
      );
    }

    let source: string;
    try {
      source = await readFile(resolved, "utf8");
    } catch {
      throw new WorkflowLoadError(
        "missing-step",
        `stage "${stage.id}" names a step file that does not exist: ${stage.step}`,
      );
    }
    steps.set(stage.step, parseStep(source));
  }

  return { workflow, steps };
}
