import type { LoadedWorkflow, Registry, Step, ToolWorkflow, Workflow } from "#namespace.js";

/** A workflow as the tools are handed one: with the id and steps its folder would give it. */
export const loaded = (workflow: Workflow, steps: Map<string, Step> = new Map(), id = "main"): LoadedWorkflow => ({
  id, dir: `/w/workflows/${id}`, workflow, steps,
});

/** Claims every open item and admits nothing: what a test about one tool, and not about claims, runs under. */
export const ANY: Workflow = { version: 1, name: "t", description: "test", stages: [{ id: "spec", entry: true, terminal: true }] };

/** One workflow as the MCP tools are handed it: loaded, with the hooks it loads and what holds its turns. */
export const hooked = (
  registry: Registry,
  workflow: LoadedWorkflow = loaded(ANY),
  more: Partial<Pick<ToolWorkflow, "executor" | "screen" | "server">> = {},
): ToolWorkflow => ({ ...workflow, registry, ...more });
