/**
 * The event vocabulary. Deliberately boring and fixed: an OpenTelemetry
 * exporter should later subscribe to this rather than require a rewrite.
 */
export type EventName =
  | "tick.started" | "tick.finished"
  | "ticket.evaluated" | "ticket.skipped"
  | "step.invoked" | "step.completed" | "step.rejected"
  | "agent.event"
  | "effect.planned" | "effect.applied" | "effect.discarded"
  | "lock.acquired" | "lock.denied" | "lock.stolen"
  | "screen.passed" | "screen.blocked";

export interface LandraceEvent {
  name: EventName;
  ticket?: number;
  [key: string]: unknown;
}

export type Logger = (name: EventName, data?: Record<string, unknown>) => void;

/** Values, never names: splitting a log line on "githubToken" redacts nothing. */
function redactValue(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") {
    return secrets.reduce((acc, s) => acc.split(s).join("[redacted]"), value);
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
   * shipped config lists secret *names* (`log.redact: [githubToken]`), and an
   * earlier signature called this `redact`, so the names were passed straight
   * through and a logged `Authorization: Bearer ghp_…` came out intact.
   * Resolve names against loadConfig's secretValues — see redactionValues —
   * before calling this.
   */
  redactValues?: string[];
  sink?: (e: LandraceEvent) => void;
} = {}): Logger {
  // An empty string would match everywhere and redact the whole log.
  const secrets = (opts.redactValues ?? []).filter((s) => s.length > 0);
  const sink = opts.sink ?? ((e: LandraceEvent) => console.log(JSON.stringify(e)));

  return (name, data = {}) => {
    // Agent output is voluminous and carries attacker-influenced text. It is
    // printed only on request, and it is data — never interpreted.
    if (name === "agent.event" && !opts.debug) return;
    sink({ name, ...(redactValue(data, secrets) as Record<string, unknown>) });
  };
}
