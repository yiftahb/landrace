import type { LoadedWorkflow, Step, Workflow } from "#namespace.js";

/** A workflow as the tools are handed one: with the id and steps its folder would give it. */
export const loaded = (workflow: Workflow, steps: Map<string, Step> = new Map(), id = "main"): LoadedWorkflow => ({
  id, dir: `/w/workflows/${id}`, workflow, steps,
});
