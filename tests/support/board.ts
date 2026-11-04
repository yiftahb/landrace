import type { UiOptions, UiServer } from "#namespace.js";
import { serveFrontDoor } from "#front/server.js";

/**
 * The board alone behind the front door on loopback, as `landrace start`
 * serves it with no MCP endpoint: the hosts and origins it answers are the
 * door's own, computed for the port it bound.
 */
export function serveBoard(opts: Omit<UiOptions, "allowedHosts" | "origins"> & { port: number }): Promise<UiServer> {
  const { port, ...board } = opts;
  return serveFrontDoor({ host: "127.0.0.1", port, board });
}
