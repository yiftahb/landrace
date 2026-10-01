import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ChildTool, Tools } from "#namespace.js";
import { CHILD_TOOL, itemIdProblem } from "#conventions.js";
import { messageOf } from "#runner/errors.js";

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

/**
 * `extra` carries the request's own AbortSignal. The SDK aborts it when the
 * client cancels the call or the transport closes, so a tool that hands it on
 * — `landrace_ask` does — stops the agent and unwinds through the lock's
 * release, instead of leaving that item held for the rest of a turn nobody
 * is listening to any more.
 */
const guard =
  <A>(fn: (args: A, extra: { signal: AbortSignal }) => Promise<unknown>) =>
  async (args: A, extra: { signal: AbortSignal }) => {
    try {
      return text(await fn(args, extra));
    } catch (e) {
      return { content: [{ type: "text" as const, text: `error: ${messageOf(e)}` }], isError: true };
    }
  };

/**
 * An item id as a client sends it. Numbers are still taken, because a
 * client may send `{ item: 42 }`, and every one written before ids were
 * strings did, under the old name `ticket`; both are
 * checked against the one id rule before any tool runs, so a hostile id never
 * reaches a lock file or a worktree path by way of the MCP plane.
 */
const item = z
  .union([z.string(), z.number().int().positive()])
  .transform((v) => String(v))
  .superRefine((id, ctx) => {
    const problem = itemIdProblem(id);
    // zod 3 (package.json pins ^3.24): ZodIssueCode.custom.
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  });

/** A workflow by its folder name, as `landrace_workflows` lists it; left out, every workflow. */
const workflow = z.string().min(1).optional();

export function createMcpServer(tools: Tools, version = "0.0.0"): McpServer {
  const server = new McpServer({ name: "landrace", version });

  server.tool(
    "landrace_workflows",
    "List the workspace's workflows: each one's id, name and description, how many open items it claims, " +
      "and how many of those need you.",
    {},
    guard(() => tools.workflows()),
  );

  server.tool(
    "landrace_items",
    "List every open item a workflow claims, with its workflow, stage and lane. With `workflow`, that " +
      "workflow's alone; without it, also every item no one workflow may work — claimed by two, or " +
      "reported by two trackers — with why.",
    { workflow },
    guard(({ workflow: w }) => tools.items({ workflow: w })),
  );

  server.tool(
    "landrace_waiting",
    "List the items currently waiting on a human, each with the workflow that claims it; with `workflow`, that workflow's alone.",
    { workflow },
    guard(({ workflow: w }) => tools.waiting({ workflow: w })),
  );

  server.tool(
    "landrace_status",
    "Show an item's workflow and position in it, which rounds have run, and whose turn it is.",
    { item },
    guard(({ item: n }) => tools.status(n)),
  );

  server.tool(
    "landrace_create_item",
    "Open a new item in a workflow. By default it is given the labels that workflow admits, so the orchestrator " +
      "picks it up on its next tick and starts work — pass start: false to file it without starting anything. " +
      "Name the workflow (landrace_workflows lists them) when more than one can create items.",
    {
      workflow,
      title: z.string().min(1),
      body: z.string().optional(),
      labels: z.array(z.string()).optional(),
      start: z.boolean().optional(),
    },
    guard((args) => tools.createItem(args)),
  );

  server.tool(
    "landrace_update_item",
    "Change an item a workflow claims: its title, body, open/closed state, or its labels. Removing the " +
      "label its workflow admits it with stops further work.",
    {
      item,
      title: z.string().optional(),
      body: z.string().optional(),
      state: z.enum(["open", "closed"]).optional(),
      addLabels: z.array(z.string()).optional(),
      removeLabels: z.array(z.string()).optional(),
    },
    guard(({ item: n, ...rest }) => tools.updateItem(n, rest)),
  );

  server.tool(
    "landrace_reply",
    "Say something on an item as yourself — approve the work, or ask for changes. " +
      "Posted as an ordinary comment, exactly as if you had typed it there.",
    { item, message: z.string().min(1) },
    guard(({ item: n, message }) => tools.reply(n, message)),
  );

  server.tool(
    "landrace_goto",
    "Send an item back to an earlier step — spec or build, say — from a stage where it is your turn. " +
      "The workflow says which steps each stage may send an item to, and how many rounds each may run; " +
      "anything else is refused with the reason. The step re-runs on the next tick.",
    { item, stage: z.string().min(1).max(64) },
    guard(({ item: n, stage }) => tools.goto(n, stage)),
  );

  server.tool(
    "landrace_clear",
    "Overrule the security check on an item it stopped: the refused step — or the stage named, where the " +
      "workflow lets the item go — runs its next round once without prompt screening, then every later round " +
      "is screened as ever. Only after reading what was refused. Anything written on the item after the " +
      "clearance voids it. Refused where no security check stopped the item.",
    { item, stage: z.string().min(1).max(64).optional() },
    guard(({ item: n, stage }) => tools.clear(n, stage)),
  );

  server.tool(
    "landrace_ask",
    "Answer a step's open questions, or ask it something. Resumes the step's own session, so " +
      "it still has its draft, and records both halves on the item. Returns its reply and " +
      "whether it now says it has enough to proceed. One turn takes 5-70 seconds. The workflow " +
      "stays where it is until you call landrace_resolve.",
    { item, message: z.string().min(1) },
    guard(({ item: n, message }, extra) => tools.ask(n, message, { signal: extra.signal })),
  );

  server.tool(
    "landrace_resolve",
    "Hand the item back to the orchestrator: `why` (by default, that the questions are answered) " +
      "is posted as your reply, with everything said here on the record, and the workflow's next " +
      "step reads it on the next tick. Use it once the conversation has answered the question — " +
      "or to move on even though the step still has questions.",
    { item, why: z.string().optional() },
    guard(({ item: n, why }) => tools.resolve(n, why)),
  );

  server.tool(
    "landrace_pair",
    "Work a step together with the agent, in your own terminal. Without `stage`, lists what may be paired " +
      "on now and any pairing already open. With it, starts pairing on that step — its round is held for " +
      "you, the agent never runs it alone meanwhile — and returns the command to run; asked again for the " +
      "open pairing, returns the same command. End it with landrace_finish or landrace_release.",
    { item, stage: z.string().min(1).max(64).optional() },
    guard(({ item: n, stage }) => (stage === undefined ? tools.pairing(n) : tools.pair(n, stage))),
  );

  server.tool(
    "landrace_finish",
    "Hand the pairing's work in: the session you paired in is asked for the step's answer, which is " +
      "recorded as yours and moves the item on. `note` is passed to that closing turn. Anything left " +
      "uncommitted in the pairing's checkout is listed and discarded. One turn takes a minute or more.",
    { item, note: z.string().optional() },
    guard(({ item: n, note }) => tools.finish(n, note)),
  );

  server.tool(
    "landrace_release",
    "Give a paired step back to the agent: the pairing ends, its checkout is removed, and the agent runs " +
      "the step alone on the next tick.",
    { item },
    guard(({ item: n }) => tools.release(n)),
  );

  return server;
}

/**
 * The server an agent is started with when its step may create children.
 *
 * One tool, and deliberately none of the operator ones: an agent that could
 * reach landrace_update_item could move its own item. The schema has no
 * parent, stage or round — those were fixed on this process's command line
 * before the agent existed, and zod drops any key the schema does not name.
 */
export function createChildMcpServer(tool: ChildTool, version = "0.0.0"): McpServer {
  const server = new McpServer({ name: "landrace", version });
  server.tool(
    CHILD_TOOL,
    "Create one sub-item of the item you are working on. Call once per sub-item. " +
      "Each is worked through the workflow on its own, starting at implementation.",
    {
      title: z.string().min(1),
      body: z.string().optional(),
      priority: z.number().int().min(0).max(9).optional()
        .describe("0 (most urgent) to 9; leave it out when the sub-items are equally urgent"),
    },
    guard(({ title, body, priority }) =>
      tool.createChild({ title, ...(body === undefined ? {} : { body }), ...(priority === undefined ? {} : { priority }) })),
  );
  return server;
}
