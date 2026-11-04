import { isIPv4, isIPv6 } from "node:net";
import type { HttpLimit } from "#namespace.js";

/**
 * A name only this machine reaches: `localhost`, `127.0.0.0/8`, or `::1`,
 * bracketed or not. Here, in the kit, because the kit refuses a step's way to
 * the operator's front door on loopback, and the engine binds that door.
 */
export function isLoopback(host: string): boolean {
  const h = host.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (h === "localhost") return true;
  if (isIPv4(h)) return h.startsWith("127.");
  return isIPv6(h) && /^(0{0,4}:){1,7}0{0,3}1$|^::1$/.test(h);
}

/*
 * What a vendor API's refusal says, short enough to log. A gateway's 504 once
 * reached `landrace start`'s output as its whole error page — styles, markup
 * and base64 images, 40 KB on one line — for one fact. The message carries a
 * reason; the body rides on the error whole, for a caller that reads it.
 */

/** The most of a reason a message carries, before its ellipsis. */
const REASON_CHARS = 200;

const cut = (text: string): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > REASON_CHARS ? `${line.slice(0, REASON_CHARS).trimEnd()}…` : line;
};

/** The strings of a string or a list: a list's entry may be an object, and then only its `message` counts. */
function said(value: unknown): string[] {
  if (typeof value === "string") return value.trim() === "" ? [] : [value];
  if (Array.isArray(value)) return value.flatMap((v) => said(v));
  if (typeof value === "object" && value !== null) {
    const message = (value as { message?: unknown }).message;
    return typeof message === "string" ? said(message) : [];
  }
  return [];
}

/** Strings by field, `{ title: ["can't be blank"] }`, each read with its field's name before it. */
const byField = (value: unknown, join: string): string[] =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.entries(value).flatMap(([field, v]) => said(v).map((s) => `${field}${join}${s}`))
    : said(value);

function fromJson(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const { message, error, errorMessages, errors } = parsed as Record<string, unknown>;
  const head = [...byField(message, " "), ...said(error), ...said(errorMessages)];
  const listed = byField(errors, ": ");
  if (head.length === 0 && listed.length === 0) return null;
  if (head.length === 0) return listed.join("; ");
  return listed.length === 0 ? head.join("; ") : `${head.join("; ")}: ${listed.join("; ")}`;
}

const ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", nbsp: " ", middot: "·", ndash: "–", mdash: "—" };

/*
 * `&lt;` and `&gt;` stay as they are: decoded, they would put back the
 * markup this is here to keep out of a log.
 */
const decode = (text: string): string => text.replace(/&([a-z]+);/gi, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole);

function fromMarkup(text: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1];
  if (title !== undefined && decode(title).trim() !== "") return decode(title);
  return decode(
    text
      .replace(/<!--[\s\S]*?(-->|$)/g, " ")
      .replace(/<(script|style|head)\b[\s\S]*?(<\/\1\s*>|$)/gi, " ")
      // The last alternative takes a tag the response cut off before its `>`.
      .replace(/<[!/?a-z][^>]*(>|$)/gi, " "),
  );
}

/**
 * A short reason out of a refusal's body: a JSON body's own message fields
 * (`message`, `error`, `errorMessages`, `errors`), else the JSON itself; an
 * HTML page's `<title>`, else its text with no markup; plain text as it came.
 * One line, at most a couple of hundred characters, with an ellipsis where it
 * was cut. Empty for an empty body.
 */
export function httpReason(body: string): string {
  const text = body.trim();
  if (text === "") return "";
  try {
    const parsed: unknown = JSON.parse(text);
    return cut(fromJson(parsed) ?? text);
  } catch {
    return cut(fromMarkup(text));
  }
}

/**
 * A response refused for a rate limit — a 429 — with its `Retry-After` as the
 * vendor sent it, or null for any other response. Pure, so it logs nothing:
 * an integration hands it to whatever logs for it, under its own name, and
 * adds a vendor's own rule beside it — a 403 that says no requests are left.
 */
export function httpLimit(status: number, headers: Pick<Headers, "get">): HttpLimit | null {
  if (status !== 429) return null;
  const retryAfter = headers.get("retry-after");
  return retryAfter === null ? { status } : { status, retryAfter };
}

/**
 * The error a client throws for a response that was not ok: `method where →
 * status reason` as its message, the status beside it so a caller asks "is
 * this a 404?" of a number rather than of text that may quote a path, and the
 * body whole beside that, for a caller that reads more of it than the reason.
 */
export function httpError(method: string, where: string, status: number, body: string): Error & { status: number; body: string } {
  const reason = httpReason(body);
  return Object.assign(new Error(`${method} ${where} → ${status}${reason === "" ? "" : ` ${reason}`}`), { status, body });
}
