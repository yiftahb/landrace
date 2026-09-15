import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import type { Workflow } from "../core/types.js";
import { stepFrontMatterSchema, workflowSchema, type StepFrontMatter } from "./schema.js";

export interface Step extends StepFrontMatter {
  prompt: string;
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
  const workflow = workflowSchema.parse(raw) as Workflow;

  const seen = new Set<string>();
  for (const stage of workflow.stages) {
    if (seen.has(stage.id)) throw new Error(`duplicate stage id "${stage.id}"`);
    seen.add(stage.id);
  }

  const steps = new Map<string, Step>();
  for (const stage of workflow.stages) {
    if (!stage.step || steps.has(stage.step)) continue;
    let source: string;
    try {
      source = await readFile(join(dir, stage.step), "utf8");
    } catch {
      throw new Error(`stage "${stage.id}" names a step file that does not exist: ${stage.step}`);
    }
    steps.set(stage.step, parseStep(source));
  }

  return { workflow, steps };
}
