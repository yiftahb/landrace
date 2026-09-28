import type { EventName, LandraceEvent, RedactingLogger } from "#namespace.js";
import { messageOf } from "#runner/errors.js";

/**
 * Printed only under `--debug` (spec §14).
 *
 * `agent.event` is every chunk a subprocess wrote; `snapshot.built` is the
 * whole assembled snapshot, once per pass. Both are the answer to "why did it
 * do that" and both would bury every other line if they were on by default.
 * Gated by name here rather than at each call site, so there is one place that
 * decides and no caller has to be handed the debug flag to make the choice.
 */
const DEBUG_ONLY: ReadonlySet<EventName> = new Set<EventName>(["agent.event", "snapshot.built"]);

/**
 * Shorter than any real credential, and long enough that a value this short is
 * a configuration mistake rather than a secret: a quoted or shell-exported
 * `.env` value of " " or "\n" got through the old empty-string filter and
 * redacted between every character of every log line.
 */
export const MIN_SECRET_LENGTH = 8;

/**
 * Values, never names: splitting a log line on a secret's *name* redacts
 * nothing. Exported so the same redaction the logger applies to every event
 * can also be applied to text composed *outside* the logger — a tracker
 * comment body built from an executor's error message, say, which reaches a
 * public, durable record the log's own redaction never touches.
 */
export function redactValue(value: unknown, secrets: readonly string[]): unknown {
  // Longest first. In list order, a shorter value that is part of a longer one
  // — a server's base URL registered before a webhook secret under it — split
  // the longer one before it could match whole, and its tail printed.
  return redactOrdered(value, [...secrets].sort((a, b) => b.length - a.length));
}

/**
 * How text written outside the logger is scrubbed — a record body, a line of
 * agent activity: the runtime logger's live set when there is one, and every
 * secret value in `secrets`, in one pass over both — two passes let a logger
 * value that is part of a declared secret split it before the second pass
 * could match it whole. Both sets, because neither holds the other.
 * `secrets` is every declared secret, where the log redacts the ones
 * `log.redact` names plus what an executor registered through `redact` after
 * startup — an MCP server's env, which no secret names. Values shorter than
 * `MIN_SECRET_LENGTH` are skipped rather than rejected: `createLogger` throws
 * on one at construction time, but this is an independent consumer of the
 * same raw map, not the list's owner, and a value that short would redact
 * everywhere in this text too.
 */
export function scrubberOf(
  secrets: ReadonlyMap<string, string>,
  scrub?: (text: string, extra?: readonly string[]) => string,
): (text: string) => string {
  // Trimmed once, and that trimmed form is what is both measured *and*
  // returned for actual redaction — checking the trimmed length while
  // filtering the untrimmed value let a secret sourced with surrounding
  // whitespace (a quoted .env line) pass the length check and then never
  // match its own bare form anywhere it actually appeared in posted text.
  const values = [...secrets.values()].map((v) => v.trim()).filter((v) => v.length >= MIN_SECRET_LENGTH);
  return scrub === undefined ? (text) => redactValue(text, values) as string : (text) => scrub(text, values);
}

function redactOrdered(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    return secrets.reduce((acc, s) => acc.split(s).join("[redacted]"), value);
  }
  // Object.entries skips message and stack, both non-enumerable, so an error
  // logged as a value serialised to {} — and a token inside its message never
  // reached the redactor either.
  if (value instanceof Error) {
    return redactOrdered(
      { name: value.name, message: value.message, ...(value.stack === undefined ? {} : { stack: value.stack }) },
      secrets,
    );
  }
  if (Array.isArray(value)) return value.map((v) => redactOrdered(v, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactOrdered(v, secrets)]),
    );
  }
  return value;
}

export function createLogger(opts: {
  debug?: boolean;
  /**
   * The secret *values* to keep out of the log. Named for what they are: the
   * config lists secret *names* under `log.redact`, and an earlier signature
   * called this `redact`, so the names were passed straight through and a
   * logged `Authorization: Bearer <the token itself>` came out intact.
   * Resolve names against loadConfig's secretValues — see redactionValues —
   * before calling this.
   */
  redactValues?: string[];
  sink?: (e: LandraceEvent) => void;
  /**
   * Telemetry's sink. It gets every event, the debug-only ones included —
   * a collector is where agent output is worth keeping, and the terminal is
   * where it buries everything else — redacted exactly as `sink`'s are.
   */
  exporter?: (e: LandraceEvent) => void;
} = {}): RedactingLogger {
  // Refused, not skipped: skipping would leave a real secret unredacted, and
  // accepting would shred the log. The value itself is never named in the
  // error, only its position. Trimmed once, here, and that trimmed form is
  // what both the length check *and* the actual redaction use from this
  // point on — checking the trimmed length and then redacting with the
  // untrimmed value let a secret sourced from a quoted .env line (padded
  // with whitespace) pass validation and then never match its own bare form
  // anywhere it actually appeared in a log line.
  const secrets = (opts.redactValues ?? []).map((v) => v.trim());
  secrets.forEach((value, i) => {
    if (value.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `redactValues[${i}] is ${value.length} characters after trimming; ` +
        `a redaction value shorter than ${MIN_SECRET_LENGTH} characters would match everywhere`,
      );
    }
  });
  const sink = opts.sink ?? ((e: LandraceEvent) => console.log(JSON.stringify(e)));

  const log = ((name, data = {}) => {
    // Agent output is voluminous and carries attacker-influenced text. It is
    // printed only on request, and it is data — never interpreted. The same
    // goes for the per-pass snapshot, which quotes the issue body verbatim.
    const printed = !DEBUG_ONLY.has(name) || opts.debug === true;
    if (!printed && !opts.exporter) return;
    const event = { name, ...(redactValue(data, secrets) as Record<string, unknown>) };
    // Telemetry must never abort a step, for the same reason a display must
    // not (see boardSink): this is called from inside runStep outside any try.
    try {
      opts.exporter?.(event);
    } catch (e) {
      console.error(`landrace: telemetry failed to export an event: ${messageOf(e)}`);
    }
    if (printed) sink(event);
  }) as RedactingLogger;
  // After construction, for what an executor's setup turns up. Skipped rather
  // than refused below the minimum: a server env of "1" is a setting, not a
  // secret, and refusing it would stop the process over nothing.
  log.redact = (values) => {
    for (const value of values) {
      const trimmed = value.trim();
      if (trimmed.length >= MIN_SECRET_LENGTH && !secrets.includes(trimmed)) secrets.push(trimmed);
    }
  };
  log.scrub = (text, extra = []) => redactValue(text, [...secrets, ...extra]) as string;
  return log;
}
