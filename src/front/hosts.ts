import { isIPv6 } from "node:net";
import { isLoopback } from "#kit/http.js";
import type { FrontDoor, OidcConfig, Problem, ServeConfig } from "#namespace.js";

export { isLoopback };

const bare = (host: string): string => host.replace(/^\[(.*)\]$/, "$1").toLowerCase();

/** `host:port` as a Host header carries it: an IPv6 address bracketed. */
const hostHeader = (host: string, port: number): string => {
  const h = bare(host);
  return `${isIPv6(h) ? `[${h}]` : h}:${port}`;
};

/**
 * Every Host header the door answers on `port`, the one it bound: both
 * loopback names, the name it bound, and the public URL's own host. DNS
 * rebinding points a stranger's name at 127.0.0.1, and its Host is what
 * gives it away, so a name not here is answered 421.
 */
export function allowedHosts(serve: Pick<ServeConfig, "host" | "publicUrl">, port: number): string[] {
  const hosts = [hostHeader("127.0.0.1", port), hostHeader("localhost", port), hostHeader(serve.host, port)];
  if (serve.publicUrl !== undefined) hosts.push(new URL(serve.publicUrl).host.toLowerCase());
  return [...new Set(hosts)];
}

/**
 * The door as a step must not reach it: its host names — those a sandbox's
 * allowed hosts or an agent's fetch rule can hold, so no IPv6 address — and
 * its origins, the loopback ones on `port` and the public URL's.
 */
export function frontDoorOrigins(serve: Pick<ServeConfig, "host" | "publicUrl">, port: number): FrontDoor {
  const local = allowedHosts({ host: serve.host }, port);
  const origins = local.map((h) => `http://${h}`);
  const names = ["127.0.0.1", "localhost", bare(serve.host)];
  if (serve.publicUrl !== undefined) {
    const url = new URL(serve.publicUrl);
    origins.push(url.origin.toLowerCase());
    names.push(bare(url.hostname));
  }
  return { hosts: [...new Set(names.filter((n) => !n.includes(":")))], origins: [...new Set(origins)] };
}

/**
 * Why the door may not be served as configured.
 *
 * Without `oidc` nothing asks who a caller is, so a door any other machine
 * can reach hands it every item and the loop's controls. With it, everyone
 * signs in, and the bind is the operator's choice — but the sign-in's
 * callback and the MCP clients' authorization server are both built from
 * `publicUrl`, so it must be set, and `https` off loopback: the session
 * cookie and every token would otherwise cross the network in the clear.
 */
export function serveProblems(serve: Pick<ServeConfig, "host" | "publicUrl">, oidc?: OidcConfig): Problem[] {
  if (oidc !== undefined) {
    if (serve.publicUrl === undefined) {
      return [{
        rule: "serve.public-url",
        message:
          "people.oidc is set and serve.publicUrl is not: the sign-in callback and the MCP clients' authorization server " +
          "are built from it. Set it to the https:// URL people reach this instance at",
      }];
    }
    const url = new URL(serve.publicUrl);
    if (url.protocol !== "https:" && !isLoopback(url.hostname)) {
      return [{
        rule: "serve.public-url",
        message:
          `serve.publicUrl is "${serve.publicUrl}", which is not https: with people.oidc set, every session cookie and token ` +
          "would cross the network in the clear. Put a TLS proxy in front and name its https:// URL",
      }];
    }
    return [];
  }
  if (isLoopback(serve.host)) return [];
  return [{
    rule: "serve.unauthenticated",
    message:
      `serve.host is "${serve.host}", which is not loopback: anyone who can reach it could read every item and drive the loop, ` +
      "and nothing asks who they are. Bind 127.0.0.1, the default, and reach it from elsewhere through a proxy of your own, " +
      "named in serve.publicUrl",
  }];
}
