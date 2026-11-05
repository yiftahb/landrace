import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { LOCAL_PERSON_ID } from "#conventions.js";
import type { McpEndpoint, Person, Tools } from "#namespace.js";
import { createMcpServer } from "#mcp/server.js";
import { messageOf } from "#runner/errors.js";
import { send } from "#ui/server.js";

/** Far past any tool call's arguments; the transport itself caps nothing. */
const MAX_BODY_BYTES = 1024 * 1024;

/** Open MCP sessions one person may hold; opening another closes their oldest. */
const MAX_SESSIONS = 16;

const TEXT = "text/plain; charset=utf-8";

/** The request's JSON body, `null` past MAX_BODY_BYTES, `undefined` when it is not JSON. */
function jsonOf(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      // Read on and dropped, not destroyed: a destroyed socket carries no 413 back.
      if (size > MAX_BODY_BYTES) resolve(null);
      else chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", reject);
  });
}

/**
 * The operator's tools over Streamable HTTP, one MCP server per session.
 *
 * A session's scope is fixed when it initializes, from `?workflow=<id>`, as
 * `--workflow` once fixed a stdio server's: what a later request's query says
 * changes nothing. A workflow the workspace does not have is refused there,
 * with no session made, rather than a session every tool of which refuses.
 * `toolsFor` is asked once per caller and scope; each session gets its own
 * server over them, because one MCP server connects to one transport.
 *
 * A session is its caller's: whoever initialized it. Another caller naming
 * its id is answered as if it did not exist, so one person's session id —
 * seen in a log, say — reaches nobody else's items.
 */
export function createMcpEndpoint(opts: {
  workflows: readonly string[];
  toolsFor: (caller: Person, workflow?: string) => Tools;
  /** Whether the pairing tools are offered. Absent, they are. */
  pairing?: boolean;
  /** The start log's `scrub`: a failed request's line can quote what a tool was handed. */
  scrub: (text: string) => string;
}): McpEndpoint {
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; caller: string }>();
  const tools = new Map<string, Tools>();
  const toolsOf = (caller: Person, scope: string | undefined): Tools => {
    // A person id is a credentials file's name, so it cannot hold a NUL.
    const key = `${caller.id}\0${scope ?? ""}`;
    const found = tools.get(key) ?? opts.toolsFor(caller, scope);
    tools.set(key, found);
    return found;
  };

  const initialize = async (req: IncomingMessage, res: ServerResponse, body: unknown, caller: Person): Promise<void> => {
    const scope = new URL(req.url ?? "/", "http://x").searchParams.get("workflow") ?? undefined;
    if (scope !== undefined && !opts.workflows.includes(scope)) {
      return send(res, 400, TEXT, `no workflow "${scope}"; the workspace has ${opts.workflows.join(", ")}`);
    }
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        // Each session holds a server in memory until its client ends it, so a
        // person keeps MAX_SESSIONS at most: their oldest gives way. The map
        // keeps insertion order, so the first of theirs is the oldest.
        const theirs = [...sessions].filter(([, s]) => s.caller === caller.id);
        for (const [old, s] of theirs.slice(0, Math.max(0, theirs.length - MAX_SESSIONS + 1))) {
          sessions.delete(old);
          s.transport.close().catch(() => {});
        }
        sessions.set(id, { transport, caller: caller.id });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId !== undefined) sessions.delete(transport.sessionId);
    };
    // The SDK types its own transport loosely for exactOptionalPropertyTypes; it is the one `connect` takes.
    const server = createMcpServer(toolsOf(caller, scope), undefined, opts.pairing === undefined ? {} : { pairing: opts.pairing });
    await server.connect(transport as unknown as Transport);
    await transport.handleRequest(req, res, body);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse, caller: Person): Promise<void> => {
    const header = req.headers["mcp-session-id"];
    const id = Array.isArray(header) ? header[0] : header;
    if (id !== undefined) {
      const session = sessions.get(id);
      // The transport answers an unknown session itself, but only one it made.
      // Another person's is unknown to this caller.
      if (session?.caller !== caller.id) return send(res, 404, TEXT, "no such MCP session; initialize a new one");
      const { transport } = session;
      if (req.method !== "POST") return transport.handleRequest(req, res);
      const body = await jsonOf(req);
      if (body === null) return send(res, 413, TEXT, "that request is far larger than a tool call");
      if (body === undefined) return send(res, 400, TEXT, "that request is not JSON");
      return transport.handleRequest(req, res, body);
    }
    if (req.method !== "POST") return send(res, 400, TEXT, "no MCP session; POST an initialize request first");
    const body = await jsonOf(req);
    if (body === null) return send(res, 413, TEXT, "that request is far larger than a tool call");
    if (!isInitializeRequest(body)) return send(res, 400, TEXT, "no MCP session; POST an initialize request first");
    return initialize(req, res, body, caller);
  };

  return {
    handle: (req, res, caller) => {
      handle(req, res, caller ?? { id: LOCAL_PERSON_ID }).catch((e: unknown) => {
        console.error(opts.scrub(`landrace: an MCP request failed: ${messageOf(e)}`));
        if (!res.headersSent) send(res, 500, TEXT, "the MCP request failed; the landrace log says why");
      });
    },
    close: async (personId) => {
      const open = [...sessions].filter(([, s]) => personId === undefined || s.caller === personId);
      for (const [id] of open) sessions.delete(id);
      // Tools built for a person closed out are built again for their next session.
      for (const key of [...tools.keys()]) if (personId === undefined || key.startsWith(`${personId}\0`)) tools.delete(key);
      await Promise.all(open.map(([, s]) => s.transport.close()));
    },
  };
}
