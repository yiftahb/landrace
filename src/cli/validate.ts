import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadConfig } from "../config/load.js";
import { loadWorkflow } from "../workflow/load.js";
import { validate, type Problem } from "../workflow/validate.js";

export async function runValidate(dir: string): Promise<{ ok: boolean; problems: Problem[] }> {
  const { workflow, steps } = await loadWorkflow(dir);
  const problems = validate(workflow, steps);

  // The config is optional for `validate`, so a workflow can be checked in
  // isolation — in CI, for instance, where no tracker credentials exist.
  try {
    const { missing } = await loadConfig(dir);
    for (const name of missing) {
      problems.push({ rule: "secret", message: `secret "${name}" does not resolve; set it in ${join(dir, ".env")}` });
    }
  } catch {
    /* no landrace.yaml: workflow-only validation */
  }

  // A token in a committed file is the cheapest possible catastrophe. The
  // .gitignore that governs `dir` lives in its parent (the project root that
  // contains the workflow folder), not necessarily in the process's cwd.
  const env = await readFile(join(dir, ".env"), "utf8").catch(() => null);
  if (env !== null) {
    const ignored = await readFile(join(dirname(dir), ".gitignore"), "utf8").catch(() => "");
    if (!/(^|\n)\s*(\.landrace\/\.env|\.env|\*\*\/\.env)\s*(\n|$)/.test(ignored)) {
      problems.push({ rule: "secret", message: `${join(dir, ".env")} exists but is not gitignored` });
    }
  }

  return { ok: problems.length === 0, problems };
}
