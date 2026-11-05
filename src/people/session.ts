import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Person, Sessions } from "#namespace.js";

/**
 * The cookie a signed-in browser carries, by whether the door is reached
 * over https. `__Host-` there: a browser keeps such a cookie only when it is
 * Secure, `Path=/` and names no Domain, so a sibling subdomain cannot set one
 * for this host and toss the person into a session of its choosing. Plain on
 * loopback http, where a browser refuses a `__Host-` cookie, which must be Secure.
 */
export const sessionCookie = (secure: boolean): string => (secure ? "__Host-landrace_session" : "landrace_session");

/** How long a sign-in lasts: a working day and then some. */
const SESSION_TTL_MS = 12 * 60 * 60_000;

/**
 * One cookie of the request's, by name, or undefined; a value that does not
 * decode is taken as written. A name sent twice is undefined too: a browser
 * sends two when a cookie another host set shadows this one's, and picking
 * either would be the first match by another name.
 */
export function cookieOf(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (header === undefined) return undefined;
  let found: string | undefined;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at === -1 || part.slice(0, at).trim() !== name) continue;
    if (found !== undefined) return undefined;
    const raw = part.slice(at + 1).trim();
    try {
      found = decodeURIComponent(raw);
    } catch {
      found = raw;
    }
  }
  return found;
}

/**
 * A `Set-Cookie` value. HttpOnly, so no script on the page — nor one an item's
 * text smuggled in — reads it; SameSite=Lax, so another site's form posts
 * carry none of it; Secure where the instance is reached over https.
 */
export function cookie(name: string, value: string, o: { secure: boolean; maxAgeSeconds: number; path?: string }): string {
  return [
    `${name}=${encodeURIComponent(value)}`, `Path=${o.path ?? "/"}`, "HttpOnly", "SameSite=Lax", `Max-Age=${o.maxAgeSeconds}`,
    ...(o.secure ? ["Secure"] : []),
  ].join("; ");
}

/**
 * Who is signed in, by a random id the cookie carries and this process
 * alone knows: nothing in the cookie says who anyone is, so none can be
 * forged, and a restart signs everyone out. A session whose person `admits`
 * no longer admits is nobody's, asked on every request.
 */
export function createSessions(opts: { secure: boolean; admits: (person: Person) => boolean; ttlMs?: number; now?: () => number }): Sessions {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? SESSION_TTL_MS;
  const name = sessionCookie(opts.secure);
  const held = new Map<string, { person: Person; expires: number }>();

  const idOf = (req: IncomingMessage): string | null => {
    const id = cookieOf(req, name);
    if (id === undefined) return null;
    const session = held.get(id);
    if (session === undefined) return null;
    if (session.expires < now() || !opts.admits(session.person)) {
      held.delete(id);
      return null;
    }
    return id;
  };

  return {
    issue: (person) => {
      const at = now();
      for (const [id, s] of held) if (s.expires < at) held.delete(id);
      const id = randomBytes(32).toString("base64url");
      held.set(id, { person, expires: at + ttl });
      return cookie(name, id, { secure: opts.secure, maxAgeSeconds: Math.floor(ttl / 1000) });
    },
    personOf: (req) => {
      const id = idOf(req);
      return id === null ? null : held.get(id)?.person ?? null;
    },
    idOf,
    end: (req) => {
      const id = cookieOf(req, name);
      if (id !== undefined) held.delete(id);
      return cookie(name, "", { secure: opts.secure, maxAgeSeconds: 0 });
    },
  };
}
