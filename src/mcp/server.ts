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

/** An entry's shape only: which types exist, and whether the item is a usable id, the tool judges before it writes. */
const relation = z.object({ type: z.string().min(1).max(64), item: z.string().min(1).max(64) });
const relations = (what: string) => z.array(relation).max(50).optional().describe(what);

export function createMcpServer(tools: Tools, version = "0.0.0"): McpServer {
  const server = new McpServer({ name: "landrace", version });
  // Bound to one workflow, every tool says so: an agent holding this server
  // is told before its first call, not by the first refusal.
  const said = (description: string): string =>
    tools.scope === null ? description : `${description} This server acts for workflow ${tools.scope} alone.`;

  server.tool(
    "landrace_workflows",
    said(
      "List the workspace's workflows: each one's id, name and description, whether it can create items, " +
        "how many open items it claims, and how many of those need you.",
    ),
    {},
    guard(() => tools.workflows()),
  );

  server.tool(
    "landrace_items",
    said(
      "List every open item a workflow claims, with its workflow, stage and lane, and every item no one " +
        "workflow may work — claimed by two, or reported by two trackers — with why. With `workflow`, that " +
        "workflow's items and the halts it is party to.",
    ),
    { workflow },
    guard(({ workflow: w }) => tools.items({ workflow: w })),
  );

  server.tool(
    "landrace_waiting",
    said(
      "List the items currently waiting on a human — the board's Needs you: at a stage that waits on a person or for a pairing, " +
        "blocked, or halted — each with the workflow that claims it; with `workflow`, that workflow's and the " +
        "halts it is party to.",
    ),
    { workflow },
    guard(({ workflow: w }) => tools.waiting({ workflow: w })),
  );

  server.tool(
    "landrace_status",
    said(
      "Show an item's workflow and position in it, which rounds have run, and whose turn it is. An item no one " +
        "workflow claims is shown too, with workflow null and why.",
    ),
    { item },
    guard(({ item: n }) => tools.status(n)),
  );

  server.tool(
    "landrace_create_item",
    said(
      "Open a new item in a workflow. By default it is given the labels that workflow admits, so the orchestrator " +
        "picks it up on its next tick and starts work — pass start: false to file it without starting anything. " +
        "Name the workflow (landrace_workflows lists them) when more than one can create items.",
    ),
    {
      workflow,
      title: z.string().min(1),
      body: z.string().optional(),
      labels: z.array(z.string()).optional(),
      start: z.boolean().optional(),
      relate: relations('Relationships to make from the new item, e.g. [{ "type": "blocked-by", "item": "10" }]; the types are those its tracker writes. One refused entry files nothing.'),
    },
    guard((args) => tools.createItem(args)),
  );

  server.tool(
    "landrace_update_item",
    said(
      "Change an item's title, body, open/closed state, or its labels, as you would on the tracker — through " +
        "the operator of the workflow that claims it, or, for an item no one workflow claims, the one operator " +
        "every workflow that could claim it shares. Removing the label its workflow admits it with stops further work.",
    ),
    {
      item,
      title: z.string().optional(),
      body: z.string().optional(),
      state: z.enum(["open", "closed"]).optional(),
      addLabels: z.array(z.string()).optional(),
      removeLabels: z.array(z.string()).optional(),
      relate: relations(
        'Relationships to make from this item, e.g. [{ "type": "blocked-by", "item": "10" }]; the types are those its tracker writes. ' +
          "Every entry of this list and of unrelate is checked with the tracker before anything is written, labels included, so one " +
          "refused entry changes nothing. They are written after the label changes, one by one: should a write still fail partway " +
          "— an outage, say — the error says which were written, which failed and which were not tried.",
      ),
      unrelate: relations("Relationships to remove from this item, in the same shape, checked and written as relate's are."),
    },
    guard(({ item: n, ...rest }) => tools.updateItem(n, rest)),
  );

  server.tool(
    "landrace_reply",
    said(
      "Say something on an item as yourself — approve the work, or ask for changes. " +
        "Posted as an ordinary comment, exactly as if you had typed it there.",
    ),
    { item, message: z.string().min(1) },
    guard(({ item: n, message }) => tools.reply(n, message)),
  );

  server.tool(
    "landrace_goto",
    said(
      "Send an item back to an earlier step — spec or build, say — from a stage where it is your turn. " +
        "The workflow says which steps each stage may send an item to, and how many rounds each may run; " +
        "anything else is refused with the reason. The step re-runs on the next tick.",
    ),
    { item, stage: z.string().min(1).max(64) },
    guard(({ item: n, stage }) => tools.goto(n, stage)),
  );

  server.tool(
    "landrace_clear",
    said(
      "Overrule the security check on an item it stopped: the refused step — or the stage named, where the " +
        "workflow lets the item go — runs its next round once without prompt screening, then every later round " +
        "is screened as ever. Only after reading what was refused. Anything written on the item after the " +
        "clearance voids it. Refused where no security check stopped the item.",
    ),
    { item, stage: z.string().min(1).max(64).optional() },
    guard(({ item: n, stage }) => tools.clear(n, stage)),
  );

  server.tool(
    "landrace_ask",
    said(
      "Answer a step's open questions, or ask it something. Resumes the step's own session, so " +
        "it still has its draft, and records both halves on the item. Returns its reply and " +
        "whether it now says it has enough to proceed. One turn takes 5-70 seconds. The workflow " +
        "stays where it is until you call landrace_resolve.",
    ),
    { item, message: z.string().min(1) },
    guard(({ item: n, message }, extra) => tools.ask(n, message, { signal: extra.signal })),
  );

  server.tool(
    "landrace_resolve",
    said(
      "Hand the item back to the orchestrator: `why` (by default, that the questions are answered) " +
        "is posted as your reply, with everything said here on the record, and the workflow's next " +
        "step reads it on the next tick. Use it once the conversation has answered the question — " +
        "or to move on even though the step still has questions.",
    ),
    { item, why: z.string().optional() },
    guard(({ item: n, why }) => tools.resolve(n, why)),
  );

  server.tool(
    "landrace_pair",
    said(
      "Work a step together with the agent, in your own terminal. Without `stage`, lists what may be paired " +
        "on now and any pairing already open. With it, starts pairing on that step — its round is held for " +
        "you, the agent never runs it alone meanwhile — and returns the command to run; asked again for the " +
        "open pairing, returns the same command. End it with landrace_finish or landrace_release.",
    ),
    { item, stage: z.string().min(1).max(64).optional() },
    guard(({ item: n, stage }) => (stage === undefined ? tools.pairing(n) : tools.pair(n, stage))),
  );

  server.tool(
    "landrace_finish",
    said(
      "Hand the pairing's work in: the session you paired in is asked for the step's answer, which is " +
        "recorded as yours and moves the item on. `note` is passed to that closing turn. Anything left " +
        "uncommitted in the pairing's checkout is listed and discarded. One turn takes a minute or more.",
    ),
    { item, note: z.string().optional() },
    guard(({ item: n, note }) => tools.finish(n, note)),
  );

  server.tool(
    "landrace_release",
    said(
      "Give a paired step back to the agent: the pairing ends, its checkout is removed, and the agent runs " +
        "the step alone on the next tick — unless its stage waits for a pairing, where the item waits for the next one.",
    ),
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
      "Each is worked through the workflow on its own, starting at implementation. " +
      "To order sub-items, relate a later one to an earlier sibling you created, " +
      "e.g. relate: [{ type: \"blocked-by\", item: \"<sibling id>\" }].",
    {
      title: z.string().min(1),
      body: z.string().optional(),
      priority: z.number().int().min(0).max(9).optional()
        .describe("0 (most urgent) to 9; leave it out when the sub-items are equally urgent"),
      relate: relations('Relationships to make from this sub-item, e.g. [{ "type": "blocked-by", "item": "<sibling id>" }]'),
    },
    guard(({ title, body, priority, relate }) =>
      tool.createChild({
        title,
        ...(body === undefined ? {} : { body }),
        ...(priority === undefined ? {} : { priority }),
        ...(relate === undefined ? {} : { relate }),
      })),
  );
  return server;
}
