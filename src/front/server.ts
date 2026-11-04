import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isIPv6 } from "node:net";
import type { FrontDoorOptions, UiServer } from "#namespace.js";
import { allowedHosts, frontDoorOrigins } from "#front/hosts.js";
import { messageOf } from "#runner/errors.js";
import { boardListener, foreignOrigin, knownHost, send } from "#ui/server.js";

const TEXT = "text/plain; charset=utf-8";

/**
 * The front door's request listener for one bound port: the Host check
 * first, for every path — DNS rebinding reaches `/mcp`, whose tools move
 * items, as surely as it reaches the board — then `/mcp`, refused a foreign
 * `Origin` because a page elsewhere in the person's browser could otherwise
 * call its tools, then the board's own routes.
 */
export function frontDoorListener(opts: FrontDoorOptions, port: number): (req: IncomingMessage, res: ServerResponse) => void {
  const hosts = allowedHosts(opts, port);
  const { origins } = frontDoorOrigins(opts, port);
  const board = boardListener({ ...opts.board, allowedHosts: hosts, origins });
  return (req, res) => {
    if (!knownHost(req, hosts)) return send(res, 421, TEXT, "misdirected request");
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path === "/mcp") {
      if (!opts.mcp) return send(res, 404, TEXT, "not found");
      if (foreignOrigin(req, origins)) return send(res, 403, TEXT, "refused: this endpoint answers only this machine's own clients");
      return opts.mcp.handle(req, res);
    }
    return board(req, res);
  };
}

/**
 * The board and the operator's MCP endpoint on one port, bound to
 * `opts.host`. Its URL is `publicUrl` when one is configured — where a person
 * reaches it — else the address it bound.
 */
export function serveFrontDoor(opts: FrontDoorOptions): Promise<UiServer> {
  let listener: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;
  // Built once the port is known, since every name it answers carries it.
  const server = createServer((req, res) => (listener ? listener(req, res) : send(res, 503, TEXT, "starting")));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      server.off("error", reject);
      const port = (server.address() as AddressInfo).port;
      listener = frontDoorListener(opts, port);
      server.on("error", (e) => console.error(`landrace: front door error: ${messageOf(e)}`));
      const bound = isIPv6(opts.host) ? `[${opts.host}]` : opts.host;
      resolve({
        url: opts.publicUrl ?? `http://${bound}:${port}/`,
        port,
        host: opts.host,
        close: async () => {
          await opts.mcp?.close();
          await new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          });
        },
      });
    });
  });
}
