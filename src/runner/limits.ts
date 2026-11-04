import type { LimitKind } from "#namespace.js";

/*
 * The most specific reading first, and that is a reading of one message, not
 * a choice between two: a plan's usage limit is answered with a 429 too, and
 * "rate" would hide that it lasts hours rather than a minute.
 */
const USAGE = /usage limit|insufficient_quota|exceeded your (current )?quota|credit balance is too low/i;
const OVERLOADED = /overloaded|\b529\b/i;
const RATE = /rate.?limit|too many requests|\b429\b/i;

/**
 * Which limit an executor's failure says it hit, or null when its text names
 * none. Only for the log: the step is the same "unavailable" either way, and
 * nothing routes on this.
 */
export function limitKindOf(text: string): LimitKind | null {
  if (USAGE.test(text)) return "usage";
  if (OVERLOADED.test(text)) return "overloaded";
  if (RATE.test(text)) return "rate";
  return null;
}

/*
 * Each agent's own words for a login it will not take: an API key or bearer
 * token it calls invalid, Anthropic's `authentication_error`, an expired
 * OAuth token, and a bare 401 — a whole word, so "7401" in a path or an id
 * is never a token refused.
 */
const AUTH = /invalid (api key|bearer token)|authentication_error|OAuth token (has )?expired|\b401\b/i;

/**
 * Whether an executor's failure says the agent refused the login it was
 * handed. Only where that login is a person's stored connection does
 * anything follow: the connection is marked failed, so nothing runs on it
 * until it is made again.
 */
export function isAuthFailure(text: string): boolean {
  return AUTH.test(text);
}
