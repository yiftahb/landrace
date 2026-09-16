import type { Effect, Snapshot } from "../namespace.js";
import type { RuntimeConfig } from "../config/schema.js";

/**
 * What a hook is handed. Secrets arrive resolved, so a hook never reads
 * `process.env` itself — that is what makes a hook testable, and what lets log
 * redaction know every value that must never be printed.
 */
export interface HookContext {
  ticket: number;
  snapshot: Snapshot;
  config: RuntimeConfig;
  secrets: ReadonlyMap<string, string>;
  signal: AbortSignal;
  log: (event: string, data?: Record<string, unknown>) => void;
}

/** Observe. Fetch or compute; the engine does not care which. */
export interface PreHook {
  id: string;
  provides?: string[];
  run(ctx: HookContext): Promise<Record<string, unknown>> | Record<string, unknown>;
}

/**
 * Act. `satisfied` is pure and called often during reconcile; `apply` is impure
 * and raced against a deadline. Both live in one hook so nobody adds an effect
 * and forgets its dedup rule.
 */
export interface PostHook {
  id: string;
  handles: string[];
  satisfied(snapshot: Snapshot, effect: Effect): boolean;
  apply(effect: Effect, ctx: HookContext): Promise<void>;
}

/**
 * Something outside the tracker with its own mutable state, which the workflow
 * both writes and reads back. `read` is mandatory: an artifact whose state
 * cannot be read is state that cannot be re-derived, which would break the one
 * guarantee the whole design rests on.
 */
export interface ArtifactHook extends PostHook {
  read(ctx: HookContext): Promise<Record<string, unknown>>;
}

/**
 * The execution plane. Not a hook: invoking an agent produces new information,
 * and an effect hook that produced information would need tracker credentials.
 */
export interface Executor {
  id: string;
  run(
    prompt: string,
    opts: { round: number; resume?: string; cwd?: string; signal: AbortSignal },
  ): Promise<{ text: string; sessionId: string | null }>;
}

/**
 * The ticket-less half of a HookContext, for the two kinds that run before —
 * or without — a ticket to build a snapshot for.
 */
export type RuntimeContext = Omit<HookContext, "ticket" | "snapshot">;

/** A ticket worth looking at, cheaply enough to enumerate every one of them. */
export interface Candidate {
  ticket: number;
  title: string;
  url: string;
  /**
   * Position, eligibility and whose turn it is are all labels, so carrying
   * them here is what lets a tick decide which candidates to work and
   * `landrace status` print a line each, without a snapshot build per ticket.
   */
  labels: string[];
}

/**
 * Where the work comes from. A tick has to enumerate tickets before it has one
 * to build a snapshot for, so this cannot be a pre hook: a pre hook is handed
 * the ticket it is describing.
 */
export interface Source {
  id: string;
  list(ctx: RuntimeContext): Promise<Candidate[]>;
}

/* `| undefined` throughout, because exactOptionalPropertyTypes is on and these
 * are fed straight from Zod, whose optional output includes it. */
export interface NewTicket {
  title: string;
  body?: string | undefined;
  labels?: string[] | undefined;
}

export interface TicketPatch {
  title?: string | undefined;
  body?: string | undefined;
  state?: "open" | "closed" | undefined;
  addLabels?: string[] | undefined;
  removeLabels?: string[] | undefined;
}

/**
 * Writes an operator asks for by hand, from the MCP plane.
 *
 * Creating a ticket is deliberately not an effect, and it must not become one.
 * Every effect needs a `satisfied()` beside its `apply()`, and "this ticket has
 * already been created" has no derived evidence to read — there is no ticket
 * yet to look at. An effect without a meaningful `satisfied()` is re-applied on
 * every tick, which here would mean a duplicate ticket per tick, forever. So
 * creation is something a person asks for, never something the tick plans.
 *
 * Optional: with no operator hook loaded, the create and update tools report
 * that none is configured. They do not crash, and they do not silently no-op.
 */
export interface Operator {
  id: string;
  createTicket(input: NewTicket, ctx: RuntimeContext): Promise<Candidate>;
  updateTicket(ticket: number, input: TicketPatch, ctx: RuntimeContext): Promise<Candidate>;
}

/**
 * Every kind the loader classifies. The list is the loader's vocabulary, and
 * `tests/boundaries.test.ts` checks that each entry has a define* helper — a
 * kind with no helper is a kind nobody can register, which would fail silently
 * at load rather than loudly at build.
 */
export const HOOK_KINDS = ["pre", "post", "artifact", "source", "operator", "executor"] as const;
export type HookKind = (typeof HOOK_KINDS)[number];

/**
 * How the loader tells the kinds apart.
 *
 * Stamped, not sniffed: "it has `handles`, so it is a post hook" is a guess,
 * and a guess that goes wrong registers half an integration and leaves the
 * other half unreachable with nothing said about it. Ambiguity halts here as
 * everywhere else, and a brand is what makes the question answerable at all.
 *
 * Registered globally, because a hook module resolves `landrace/hooks` for
 * itself: if npm ever hands it a second copy of this module, a module-local
 * symbol would make every hook in it read as unbranded — a silent, baffling
 * "your integration did not load". Forgeable, and that is fine: a hook module
 * is arbitrary code we are about to import anyway, so this is a classifier,
 * not a trust boundary.
 */
const KIND = Symbol.for("landrace.hook.kind");

/** Non-enumerable, so a hook stays a plain data object: no brand in Object.keys, in JSON, or in an equality check over its fields. */
const brand = <T extends object>(kind: HookKind, value: T): T =>
  Object.defineProperty(value, KIND, { value: kind, enumerable: false });

/** The kind a define* helper stamped, or null for anything else — a hook module is free to export helpers and constants too. */
export function hookKindOf(value: unknown): HookKind | null {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return null;
  const kind: unknown = (value as Record<symbol, unknown>)[KIND];
  return (HOOK_KINDS as readonly unknown[]).includes(kind) ? (kind as HookKind) : null;
}

export const definePreHook = (hook: PreHook): PreHook => brand("pre", hook);
export const definePostHook = (hook: PostHook): PostHook => brand("post", hook);
export const defineArtifactHook = (hook: ArtifactHook): ArtifactHook => brand("artifact", hook);
export const defineExecutor = (executor: Executor): Executor => brand("executor", executor);
export const defineSource = (source: Source): Source => brand("source", source);
export const defineOperator = (operator: Operator): Operator => brand("operator", operator);
