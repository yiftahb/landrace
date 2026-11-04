import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpEndpoint, Tools } from "#namespace.js";
import { createMcpServer } from "#mcp/server.js";
import { messageOf } from "#runner/errors.js";
import { send } from "#ui/server.js";

/** Far past any tool call's arguments; the transport itself caps nothing. */
const MAX_BODY_BYTES = 1024 * 1024;

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
 * `toolsFor` is asked once per scope; each session gets its own server over
 * them, because one MCP server connects to one transport.
 */
export function createMcpEndpoint(opts: { workflows: readonly string[]; toolsFor: (scope?: string) => Tools }): McpEndpoint {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const tools = new Map<string, Tools>();
  const toolsOf = (scope: string | undefined): Tools => {
    const key = scope ?? "";
    const found = tools.get(key) ?? opts.toolsFor(scope);
    tools.set(key, found);
    return found;
  };

  const initialize = async (req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> => {
    const scope = new URL(req.url ?? "/", "http://x").searchParams.get("workflow") ?? undefined;
    if (scope !== undefined && !opts.workflows.includes(scope)) {
      return send(res, 400, TEXT, `no workflow "${scope}"; the workspace has ${opts.workflows.join(", ")}`);
    }
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId !== undefined) sessions.delete(transport.sessionId);
    };
    // The SDK types its own transport loosely for exactOptionalPropertyTypes; it is the one `connect` takes.
    await createMcpServer(toolsOf(scope)).connect(transport as unknown as Transport);
    await transport.handleRequest(req, res, body);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const header = req.headers["mcp-session-id"];
    const id = Array.isArray(header) ? header[0] : header;
    if (id !== undefined) {
      const transport = sessions.get(id);
      // The transport answers an unknown session itself, but only one it made.
      if (!transport) return send(res, 404, TEXT, "no such MCP session; initialize a new one");
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
    return initialize(req, res, body);
  };

  return {
    handle: (req, res) => {
      handle(req, res).catch((e: unknown) => {
        console.error(`landrace: an MCP request failed: ${messageOf(e)}`);
        if (!res.headersSent) send(res, 500, TEXT, "the MCP request failed; the landrace log says why");
      });
    },
    close: async () => {
      const open = [...sessions.values()];
      sessions.clear();
      await Promise.all(open.map((t) => t.close()));
    },
  };
}
