import { loadWorkflow } from "../workflow/load.js";
import { validate, type Problem } from "../workflow/validate.js";

export async function runValidate(dir: string): Promise<{ ok: boolean; problems: Problem[] }> {
  const { workflow, steps } = await loadWorkflow(dir);
  const problems = validate(workflow, steps);
  return { ok: problems.length === 0, problems };
}
