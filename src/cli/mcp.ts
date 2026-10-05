import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { assertConfigUsable, loadConfig, redactionValues } from "#config/load.js";
import { mayCreateItems, itemIdProblem } from "#conventions.js";
import { loadHooks } from "#hooks/load.js";
import type { ChildBinding, ChildTool, ExecutorContext, LoadedWorkflow, Registry, RuntimeContext, Tools, ToolWorkflow } from "#namespace.js";
import { createChildMcpServer, createMcpServer } from "#mcp/server.js";
import { createTools } from "#mcp/tools.js";
import { createActivityLog } from "#runner/activity.js";
import { createChild } from "#runner/children.js";
import { createLogger, scrubberOf } from "#runner/events.js";
import { declaredOf, runPreflights } from "#runner/preflight.js";
import type { EventName } from "#namespace.js";
import { createOtelSink, telemetrySettings } from "#telemetry/otel.js";
import { loadWorkspace, workflowById } from "#workflow/workspace.js";
import { sandboxRoot } from "#sandbox.js";
import { touchWake, wakePath } from "#wake.js";
import { childServerCommand, executorFor, sandboxFor, screenerFor } from "#cli/start.js";

/**
 * Everything the MCP plane is, short of a transport.
 *
 * Separate from `runMcp` so the assembly can be driven without stdio: what it
 * puts together — which executor answers, and whether a turn is screened at
 * all — is exactly the part that used to be untestable and therefore unpinned.
 *
 * Every workflow of the workspace, as `landrace start` runs every one: an item
 * is acted on through the workflow that claims it, which only judging every
 * workflow's claim can say. `scope` is `--workflow`, the server a pairing hands
 * the person's session, which acts for that one workflow alone.
 */
export async function buildMcpTools(dir: string, scope?: string): Promise<Tools> {
  const loaded = await loadConfig(dir);
  // The same refusal the loop makes, from the same place: a conversation turn
  // runs the same workflow under the same configuration.
  assertConfigUsable(dir, loaded);

  const ws = await loadWorkspace(dir, loaded.vars, loaded.config.workflows);
  // By name, before any hook module is imported: a server bound to a workflow
  // the workspace does not have is one nobody can use.
  if (scope !== undefined) workflowById(ws, scope);

  // stdout carries the MCP protocol, so anything we have to say goes to
  // stderr — which is what the client that spawned us shows. What an
  // executor's own setup turns up — an allowlisted server's env and header
  // values, say — is not known yet; it joins the redaction set later,
  // through `ectx.redact`, once the executor factory that found it has run.
  //
  // Telemetry from `.env` and the shell alone: an MCP client starts this with
  // whatever arguments it was configured with, and nothing more.
  const otel = telemetrySettings(loaded.telemetry);
  if (otel?.exporter === "console") {
    throw new Error("OTEL_LOGS_EXPORTER=console would write into the MCP protocol on stdout; use otlp, or turn telemetry off");
  }

  // The hooks list lives in the workflow, not in landrace.yaml: which
  // integrations are needed is part of the workflow that needs them. Two
  // workflows loading one module are handed the same objects, and share them.
  const hooked: Array<{ w: LoadedWorkflow; registry: Registry }> = [];
  for (const w of ws.workflows) {
    hooked.push({ w, registry: await loadHooks({ dir: w.dir, modules: w.workflow.hooks ?? [], workspace: ws.dir }) });
  }

  const telemetry = otel ? await createOtelSink(otel) : undefined;
  const events = createLogger({
    redactValues: redactionValues(loaded),
    sink: (event) => process.stderr.write(`${JSON.stringify(event)}\n`),
    ...(telemetry ? { exporter: telemetry.sink } : {}),
  });
  // This server runs until its client closes stdin, with no `finally` of its
  // own to flush from; the event loop draining is the one moment it has.
  if (telemetry) process.once("beforeExit", () => void telemetry.shutdown());

  const ctx: RuntimeContext = {
    config: loaded.config,
    secrets: loaded.secretValues,
    signal: new AbortController().signal,
    // A hook names its own events, so its log is wider than the engine's own
    // vocabulary — otherwise adding an event to a hook would mean editing the
    // engine's EventName union.
    log: (event, data) => events(event as EventName, data),
  };

  // Before anything else the hooks might do, including the very next check
  // below: a permission problem has to stop this process before it proves the
  // source works, connects over stdio, or lets an agent run — not after the
  // first paid step 403s with nothing durable recorded to show for it. Each
  // once, by identity, as `landrace start` runs them.
  await runPreflights(
    [...new Set(hooked.flatMap(({ registry }) => registry.preflights))],
    { ...ctx, ...declaredOf(hooked.map(({ w }) => w.steps)) },
  );

  /*
   * Prove the integration works before telling a client we are ready — each
   * distinct source, once.
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
  for (const source of new Set(hooked.flatMap(({ registry }) => (registry.source ? [registry.source] : [])))) await source.list(ctx);

  /*
   * And where a turn runs, resolved exactly as the loop resolves it.
   *
   * A conversation turn is an agent invocation on the session a step started,
   * under that step's own declared capabilities — and the engine's half of a
   * capability is reading the worktree afterwards, which needs there to be a
   * worktree. Without this the turn ran in the operator's own checkout, so the
   * only thing between a `repo:read` step and a person asking its agent to
   * edit the repository was the executor's own good manners.
   *
   * The workflow and its steps go over for the same reason: they are what says
   * what the step declared, and a conversation that cannot read them refuses
   * the turn rather than running one nobody is holding to anything.
   */
  const sandbox = await sandboxFor(loaded.config, dir);

  const workflows: ToolWorkflow[] = [];
  for (const { w, registry } of hooked) {
    // An executor factory's own members, beyond what every hook gets — and
    // this workflow's steps, against which it is built: see the same
    // construction in `buildWorkspaceRuntime`.
    const ectx: ExecutorContext = { ...ctx, dir, redact: events.redact, steps: w.steps };
    /*
     * The same executor the loop invokes steps with, resolved the same way and
     * refused at startup for the same reason: `landrace_ask` resumes a session
     * the loop started, so the two processes have to agree about what an agent
     * is. They coordinate through the per-item lock, and it is the default one
     * — the same $TMPDIR path the loop takes — because the entire mechanism is
     * two processes finding the same file.
     *
     * Built from the same configuration the loop's own step invocation is, so a
     * turn carries the same plugins and the same allowlisted servers without
     * this process ever naming them: that resolution belongs to the executor
     * factory itself, which this call reaches exactly as `start` does.
     */
    const executor = await executorFor(loaded.config, registry, ectx);
    /*
     * And the screener, resolved exactly as the loop's runtime resolves it. §15 screens every agent
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
    const screener = await screenerFor(loaded.config, registry, ectx);
    workflows.push({
      ...w, registry, executor,
      ...(screener ? { screen: screener } : {}),
      // This same server bound to this workflow, for a pairing's session to reach Landrace by.
      server: childServerCommand(dir, w.id),
    });
  }

  return createTools(workflows, ctx, {
    ...(sandbox === null ? {} : { sandbox }),
    // A turn asked here runs in this process, and the loop's page reads its
    // progress from the same directory the loop's own steps write to.
    activity: createActivityLog(sandboxRoot(dir), scrubberOf(ctx.secrets, events.scrub)),
    // This process is not the loop, so a person's write reaches it through
    // the file `landrace start` watches. Here only: the child server an agent
    // is handed gets no wake, so an agent cannot drive the loop.
    wake: () => touchWake(wakePath(dir)),
    ...(scope === undefined ? {} : { scope }),
  });
}

export async function runMcp(dir: string, scope?: string): Promise<void> {
  const server = createMcpServer(await buildMcpTools(dir, scope));
  await server.connect(new StdioServerTransport());
}

/**
 * The child server's assembly. Checked here, before a transport exists, so a
 * binding that could never be honoured is a startup failure the executor
 * surfaces — not a tool that fails on every call while the agent retries.
 *
 * No preflight and no source probe: the loop that started this agent ran both
 * already, moments ago, against the same configuration.
 */
export async function buildChildTool(dir: string, binding: ChildBinding, workflowId: string): Promise<ChildTool> {
  const parentProblem = itemIdProblem(binding.parent);
  if (parentProblem) throw new Error(parentProblem);
  if (!Number.isInteger(binding.round) || binding.round < 1) {
    throw new Error(`round must be a positive integer, got ${binding.round}`);
  }

  const loaded = await loadConfig(dir);
  assertConfigUsable(dir, loaded);
  // The workflow whose step this server was started for, named on its command
  // line by the loop that started it. It is also what says how a child is
  // labelled, so a workspace of several workflows labels each one's children
  // its own way.
  const ws = await loadWorkspace(dir, loaded.vars, loaded.config.workflows);
  const { dir: workflowDir, workflow, steps } = workflowById(ws, workflowId);
  const stage = workflow.stages.find((s) => s.id === binding.stage);
  if (!stage) throw new Error(`the workflow has no stage "${binding.stage}"`);
  const step = stage.step ? steps.get(stage.step) : undefined;
  if (!mayCreateItems(step?.capabilities)) {
    throw new Error(`stage "${binding.stage}"'s step does not declare items:create, so it may not create children`);
  }

  const registry = await loadHooks({ dir: workflowDir, modules: workflow.hooks ?? [], workspace: ws.dir });
  const events = createLogger({
    redactValues: redactionValues(loaded),
    sink: (event) => process.stderr.write(`${JSON.stringify(event)}\n`),
  });
  const ctx: RuntimeContext = {
    config: loaded.config, secrets: loaded.secretValues, signal: new AbortController().signal,
    log: (event, data) => events(event as EventName, data),
  };

  return {
    async createChild(input) {
      const node = await createChild(registry.operator, binding, input, ctx, workflow.admit);
      return { item: node.id, title: node.title, link: node.link };
    },
  };
}

export async function runChildMcp(dir: string, binding: ChildBinding, workflowId: string): Promise<void> {
  const server = createChildMcpServer(await buildChildTool(dir, binding, workflowId));
  await server.connect(new StdioServerTransport());
}
