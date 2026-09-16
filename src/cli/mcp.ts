import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, redactionValues } from "../config/load.js";
import { loadHooks } from "../hooks/load.js";
import type { RuntimeContext } from "../hooks/types.js";
import { createMcpServer } from "../mcp/server.js";
import { createTools } from "../mcp/tools.js";
import { createLogger, type EventName } from "../runner/events.js";
import { loadWorkflow } from "../workflow/load.js";

export async function runMcp(dir: string): Promise<void> {
  const loaded = await loadConfig(dir);
  if (loaded.missing.length) {
    throw new Error(`secret(s) do not resolve: ${loaded.missing.join(", ")}. Set them in ${dir}/.env`);
  }

  // The hooks list lives in the workflow, not in landrace.yaml: which
  // integrations are needed is part of the workflow that needs them.
  const { workflow } = await loadWorkflow(dir);
  const registry = await loadHooks({ dir, modules: workflow.hooks ?? [] });

  // stdout carries the MCP protocol, so anything we have to say goes to
  // stderr — which is what the client that spawned us shows.
  const events = createLogger({
    redactValues: redactionValues(loaded),
    sink: (event) => process.stderr.write(`${JSON.stringify(event)}\n`),
  });

  const ctx: RuntimeContext = {
    config: loaded.config,
    secrets: loaded.secretValues,
    signal: new AbortController().signal,
    // A hook names its own events, so its log is wider than the engine's own
    // vocabulary — otherwise adding an event to a hook would mean editing the
    // engine's EventName union.
    log: (event, data) => events(event as EventName, data),
  };

  /*
   * Prove the integration works before telling a client we are ready.
   *
   * This used to be `await tracker.botLogin()`, back when the engine knew what
   * a login was; it does not any more, and it must not learn again. What is
   * still the engine's to ask is "can you enumerate work at all", and a hook
   * that cannot authenticate cannot — the shipped tracker hook resolves the
   * account it posts as before any request goes out, so an unresolvable login
   * stops the process here, with the hook's own message, instead of surfacing
   * one failed tool call at a time. That fail-closed is not caution for its
   * own sake: a login we cannot resolve makes our own markers read as a
   * stranger's, the engine believes no step has ever run, and every paid step
   * is invoked again on every tick.
   */
  if (registry.source) await registry.source.list(ctx);

  const server = createMcpServer(createTools(registry, ctx));
  await server.connect(new StdioServerTransport());
}
