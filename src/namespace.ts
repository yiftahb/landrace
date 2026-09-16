/**
 * Every type in the system, and nothing else.
 *
 * One file declares every interface and type alias; modules import their types
 * from here and export only values. Two properties pay for the indirection:
 *
 *  - **It exports no runtime value.** That is what lets `src/core/**` import it
 *    without importing a sibling layer — an `import type` is erased before a
 *    module graph exists, so a core file that names a type declared next to a
 *    hook's still has no edge to `src/hooks/`. `tests/namespace.test.ts`
 *    enforces both halves: no type declared outside this file, and no value
 *    declared inside it. Add a `const` here and core's purity boundary quietly
 *    becomes a lie.
 *  - **It is the whole vocabulary in one place.** A type inferred from a
 *    runtime value — a Zod schema, the hook-kind list — is still declared here,
 *    against a type-position import of the value it is inferred from. Those
 *    imports are erased too, so the cycle they look like they create (this file
 *    names `runtimeConfigSchema`, `src/config/schema.ts` names `RuntimeConfig`)
 *    never exists at runtime.
 */

import type { z } from "zod";
import type { runtimeConfigSchema } from "./config/schema.js";
import type { stepFrontMatterSchema } from "./workflow/schema.js";
import type { HOOK_KINDS } from "./hooks/contracts.js";

/* ------------------------------------------------------------------ core -- */

/** Anything a hook can put in the snapshot. */
export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/**
 * The tracker-agnostic record of something the workflow has written or a human
 * has said. A tracker hook decides how these are stored — the shipped one uses
 * a trailing marker in a comment — and core never learns that format.
 */
export interface Entry {
  stage: string;
  /** "output" for a step result, "human" for a person, otherwise hook-defined. */
  kind: string;
  round: number;
  data?: unknown;
  /** ISO 8601. Ordering is by this field, not array position. */
  at: string;
  /** True when we wrote it. False means a person did. */
  byAgent: boolean;
}

/** Open by design: hooks contribute whatever they contribute. */
export interface Snapshot {
  [key: string]: unknown;
  entries?: Entry[];
  now?: number;
  run?: Run;
}

/**
 * One stage's two derived round numbers. Both are counted from external
 * records on every run, never incremented and never stored: `entered` from
 * the records a stage's on_enter writes, `output` from the records its step
 * writes. A stage owes work exactly when `output < entered`.
 */
export interface StageRounds {
  /** Highest round an entry record names. 1 for a stage that records no entry, so a stage that never loops is unaffected. */
  entered: number;
  /** Highest round an output record names. 0 for a stage that has produced none. */
  output: number;
}

export interface Run {
  stage: string | null;
  /** Distinct output rounds per stage. Derived, never stored. */
  counters: { [stage: string]: number };
  /**
   * Per stage, how far entry and output have got. Required, not optional, for
   * the same reason failedStages is: assess() answers "does this stage owe
   * work" from here, and a Run that could omit it would silently fall back to
   * the one-shot rule this replaced — a looping stage would quietly stop
   * looping instead of failing loudly.
   */
  rounds: { [stage: string]: StageRounds };
  outputs: { [stage: string]: unknown };
  lastEvent: { actor: "agent" | "human" | null; at: string | null };
  lastHuman: Entry | null;
  /** Never true: a step is either invalid (false) or has no verdict (null), never affirmatively "valid". */
  lastOutputValid: false | null;
  /** Every stage with a rejected round, independent of which stage `lastOutputValid` answers for. */
  failedStages: string[];
  unblockedAt: number;
}

/** A MongoDB-style condition document over snapshot dot-paths. */
export type Condition = { [path: string]: unknown };

export interface Trigger {
  name?: string;
  when: Condition;
}

export interface Effect {
  type: string;
  [key: string]: unknown;
}

export interface Stage {
  id: string;
  step?: string;
  entry?: boolean;
  terminal?: boolean;
  identity?: Condition;
  requires?: Condition;
  triggers?: Trigger[];
  on_enter?: Effect[];
}

export interface EligibilityRule {
  when: Condition;
  else: string;
}

export interface Workflow {
  version: number;
  name: string;
  stages: Stage[];
  eligible?: EligibilityRule[];
  budget?: { [key: string]: unknown };
  /** Module paths, relative to the workflow directory, in pre-hook declaration order. */
  hooks?: string[];
  artifacts?: { [name: string]: { hook: string; ref: string } };
}

export type SubState = "pending" | "complete" | "failed";

export interface Decision {
  action: "invoke" | "wait" | "transition" | "halt" | "skip";
  stage?: Stage;
  subState?: SubState;
  to?: Stage;
  step?: string;
  round?: number;
  trigger?: string;
  why?: string;
}

export type Location =
  | { kind: "at"; stage: Stage }
  | { kind: "none" }
  | { kind: "ambiguous"; ids: string[] };

/* ----------------------------------------------------------- conventions -- */

export interface Marker {
  stage: string;
  kind: string;
  round: number;
  /**
   * On an OUTPUT_KIND marker, the step's own parsed value — the discriminator
   * and the fields its declared shape names, and nothing else (runner/step.ts
   * bounds it). This is what `outputs.<stage>.<field>` reads on the next tick;
   * without it a step's result decided which effect was emitted and then
   * vanished, so every trigger routing on an output field was dead.
   */
  output?: unknown;
  [key: string]: unknown;
}

/** A marker at the very end of a body: where it starts, and its payload. */
export interface Trailing {
  index: number;
  json: string;
}

/**
 * One record as a tracker hands it over, and no more of it than marker parsing
 * needs: a body, when it was written, and who wrote it. Structural rather than
 * a tracker's own type, because a comment on an issue, a note on a ticket and
 * a message on a thread are the same three facts under different names — the
 * spellings here are the ones every tracker API that has them already uses.
 */
export interface TrackerComment {
  id?: number | string | undefined;
  body: string;
  created_at: string;
  user?: { login?: string } | null;
}

/* ---------------------------------------------------------------- config -- */

/**
 * `landrace.yaml`, parsed. Inferred from the schema rather than written twice:
 * a hand-written copy is a second source of truth that only disagrees with the
 * parser once something has already gone wrong.
 */
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

export interface LoadedConfig {
  config: RuntimeConfig;
  /** Secret names whose reference did not resolve. */
  missing: string[];
  /** Resolved values, kept apart from the config so they cannot be logged by accident. */
  secretValues: Map<string, string>;
}

/* -------------------------------------------------------------- workflow -- */

export type StepFrontMatter = z.infer<typeof stepFrontMatterSchema>;

export interface Step extends StepFrontMatter {
  prompt: string;
}

/**
 * `runValidate` must report a broken workflow as a `Problem`, not let an
 * exception escape past it (spec §11.1-§11.2: `validate`'s entire job is
 * reporting). Tagging the failure with a `rule` — at the point each kind of
 * failure is actually detected — is what lets the CLI turn it into the same
 * shape as every other problem, instead of pattern-matching an error message
 * after the fact.
 */
export type LoadFailureRule = "schema" | "duplicate-id" | "missing-step" | "step-path";

export type ContainedPath =
  | { ok: true; path: string }
  | { ok: false; kind: "unsafe" | "missing"; reason: string };

export interface Problem {
  rule: string;
  message: string;
}

/* ----------------------------------------------------------------- hooks -- */

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
 * Inferred from the loader's own vocabulary rather than written out again: a
 * kind the loader can classify and a kind a define* helper can stamp must be
 * the same list, and two spellings of it drift in one direction only.
 */
export type HookKind = (typeof HOOK_KINDS)[number];

/**
 * Everything an integration contributes, in the shape the engine consumes it.
 *
 * There is no tracker id here and no registry of implementations to choose
 * from: a workflow names module paths, the loader imports them, and what they
 * export is what the engine has. Replacing a tracker is a different file in
 * `.landrace/hooks/`, not a different string in a config.
 */
export interface Registry {
  /** Declaration order: a pre hook sees what the ones before it produced. */
  pre: PreHook[];
  post: PostHook[];
  source: Source | null;
  /** Optional. With none loaded, the MCP create and update tools say so rather than crashing or silently doing nothing. */
  operator: Operator | null;
  executors: Map<string, Executor>;
}

/** One imported module: what the workflow called it, and what it exported. */
export interface HookModule {
  /** The path as `workflow.yaml` spells it, so a collision names a line a person can go and edit. */
  specifier: string;
  exports: Record<string, unknown>;
}

/** Where a claim came from, for the message when a second one collides with it. */
export interface Claim {
  id: string;
  from: string;
}
