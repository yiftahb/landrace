/**
 * The event vocabulary. Deliberately boring and fixed: an OpenTelemetry
 * exporter should later subscribe to this rather than require a rewrite.
 */
export type EventName =
  | "tick.started" | "tick.finished"
  | "ticket.evaluated" | "ticket.skipped"
  | "step.invoked" | "step.completed" | "step.rejected"
  | "agent.event"
  | "snapshot.failed"
  | "effect.planned" | "effect.applied" | "effect.discarded" | "effect.failed"
  | "lock.acquired" | "lock.denied" | "lock.stolen"
  | "screen.passed" | "screen.blocked";

export interface LandraceEvent {
  name: EventName;
  ticket?: number;
  [key: string]: unknown;
}

export type Logger = (name: EventName, data?: Record<string, unknown>) => void;

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
export function redactValue(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") {
    return secrets.reduce((acc, s) => acc.split(s).join("[redacted]"), value);
  }
  // Object.entries skips message and stack, both non-enumerable, so an error
  // logged as a value serialised to {} — and a token inside its message never
  // reached the redactor either.
  if (value instanceof Error) {
    return redactValue(
      { name: value.name, message: value.message, ...(value.stack === undefined ? {} : { stack: value.stack }) },
      secrets,
    );
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactValue(v, secrets)]),
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
} = {}): Logger {
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

  return (name, data = {}) => {
    // Agent output is voluminous and carries attacker-influenced text. It is
    // printed only on request, and it is data — never interpreted.
    if (name === "agent.event" && !opts.debug) return;
    sink({ name, ...(redactValue(data, secrets) as Record<string, unknown>) });
  };
}
