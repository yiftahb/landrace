import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Tools } from "#namespace.js";
import { messageOf } from "#runner/errors.js";

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

/**
 * `extra` carries the request's own AbortSignal. The SDK aborts it when the
 * client cancels the call or the transport closes, so a tool that hands it on
 * — `landrace_ask` does — stops the agent and unwinds through the lock's
 * release, instead of leaving that ticket held for the rest of a turn nobody
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

const ticket = z.number().int().positive();

export function createMcpServer(tools: Tools, version = "0.0.0"): McpServer {
  const server = new McpServer({ name: "landrace", version });

  server.tool(
    "landrace_waiting",
    "List the tickets currently waiting on a human.",
    {},
    guard(() => tools.waiting()),
  );

  server.tool(
    "landrace_status",
    "Show a ticket's workflow position, which rounds have run, and whose turn it is.",
    { ticket },
    guard(({ ticket: n }) => tools.status(n)),
  );

  server.tool(
    "landrace_create_ticket",
    "Open a new ticket. By default it is labelled so the orchestrator picks it up on its " +
      "next tick and starts work — pass start: false to file it without starting anything.",
    {
      title: z.string().min(1),
      body: z.string().optional(),
      labels: z.array(z.string()).optional(),
      start: z.boolean().optional(),
    },
    guard((args) => tools.createTicket(args)),
  );

  server.tool(
    "landrace_update_ticket",
    "Change a ticket: its title, body, open/closed state, or its labels. Adding the " +
      "eligibility label starts the orchestrator on it; removing it stops further work.",
    {
      ticket,
      title: z.string().optional(),
      body: z.string().optional(),
      state: z.enum(["open", "closed"]).optional(),
      addLabels: z.array(z.string()).optional(),
      removeLabels: z.array(z.string()).optional(),
    },
    guard(({ ticket: n, ...rest }) => tools.updateTicket(n, rest)),
  );

  server.tool(
    "landrace_reply",
    "Say something on a ticket as yourself — approve the work, or ask for changes. " +
      "Posted as an ordinary comment, exactly as if you had typed it there.",
    { ticket, message: z.string().min(1) },
    guard(({ ticket: n, message }) => tools.reply(n, message)),
  );

  server.tool(
    "landrace_ask",
    "Answer a step's open questions, or ask it something. Resumes the step's own session, so " +
      "it still has its draft, and records both halves on the ticket. Returns its reply and " +
      "whether it now says it has enough to proceed. One turn takes 5-70 seconds. The workflow " +
      "stays where it is until you call landrace_resolve.",
    { ticket, message: z.string().min(1) },
    guard(({ ticket: n, message }, extra) => tools.ask(n, message, { signal: extra.signal })),
  );

  server.tool(
    "landrace_resolve",
    "Hand the ticket back to the orchestrator: it picks the step up again on its next tick, " +
      "with everything said here on the record. Use it once the conversation has answered the " +
      "question — or to move on even though the step still has questions.",
    { ticket, why: z.string().optional() },
    guard(({ ticket: n, why }) => tools.resolve(n, why)),
  );

  return server;
}
