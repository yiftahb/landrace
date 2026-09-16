import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, redactionValues } from "../config/load.js";
import { loadHooks } from "../hooks/load.js";
import type { RuntimeContext, Tools } from "../namespace.js";
import { createMcpServer } from "../mcp/server.js";
import { createTools } from "../mcp/tools.js";
import { createLogger } from "../runner/events.js";
import type { EventName } from "../namespace.js";
import { loadWorkflow } from "../workflow/load.js";
import { executorFor } from "./start.js";

/**
 * Everything the MCP plane is, short of a transport.
 *
 * Separate from `runMcp` so the assembly can be driven without stdio: what it
 * puts together — which executor answers, and whether a turn is screened at
 * all — is exactly the part that used to be untestable and therefore unpinned.
 */
export async function buildMcpTools(dir: string): Promise<Tools> {
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

  /*
   * The same executor the loop invokes steps with, resolved the same way and
   * refused at startup for the same reason: `landrace_ask` resumes a session
   * the loop started, so the two processes have to agree about what an agent
   * is. They coordinate through the per-ticket lock, and it is the default one
   * — the same $TMPDIR path the loop takes — because the entire mechanism is
   * two processes finding the same file.
   */
  const executor = executorFor(loaded.config, workflow, registry, events);

  /*
   * And the screener, resolved through the same lookup with `security.model`,
   * exactly as the loop's runtime resolves it. §15 screens every agent
   * invocation before it runs, and a conversation turn is one: a person's
   * message reaching an agent that holds repository capabilities. "It came
   * through the MCP" is not evidence that it is safe — the MCP is where an
   * operator pastes text they were sent, and the client typing into it is
   * itself a model.
   *
   * `landrace_reply` is deliberately not screened here, and that is not the
   * same omission: it invokes no agent. The words it posts do reach one, but
   * through the next step's rendered prompt, where runStep screens them with
   * the frame they will be read in — which is the screening §15 describes and
   * the only kind the screener's own prompt is written to do.
   */
  const screen = loaded.config.security.screen
    ? { screen: { executor: executorFor(loaded.config, workflow, registry, events, loaded.config.security.model) } }
    : {};

  return createTools(registry, ctx, { executor, ...screen });
}

export async function runMcp(dir: string): Promise<void> {
  const server = createMcpServer(await buildMcpTools(dir));
  await server.connect(new StdioServerTransport());
}
