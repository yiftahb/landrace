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
import type { runtimeConfigSchema } from "#config/schema.js";
import type { mcpConfigSchema, mcpServerSchema } from "#config/mcp.js";
import type { stepFrontMatterSchema } from "#workflow/schema.js";
import type { HOOK_KINDS } from "#hooks/contracts.js";

/* ------------------------------------------------------------------ core -- */

/** Anything a hook can put in the snapshot. */
export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export type Closed = null | "done" | "dropped";

export interface Origin { parent: string; stage: string; round: number }

export interface Node {
  id: string;
  kind: string;
  title: string;
  link: string;
  closed: Closed;
  priority: number | null;
  origin: Origin | null;
  state: { [k: string]: Json };
}

export interface Relationship { from: string; to: string; type: string }

export interface Graph { nodes: Node[]; relationships: Relationship[] }

/** A relationship type a source reports, and whether a node may have at most one OUTGOING edge of it. */
export interface RelationDecl { type: string; singular: boolean }

/** The counts over one direction of one relationship type. */
export interface RelAgg {
  total: number;
  is: { [field: string]: number };
  not: { [field: string]: number };
  sum: { [field: string]: number };
  stage: { [stage: string]: number };
}

export type Rel = { [type: string]: { in: RelAgg; out: RelAgg } };

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
  /**
   * The agent session this record was produced under, when it was produced by
   * one. Spec §6.1 derives conversation continuity from it, and it is beside
   * `data` rather than in it for the same reason it is beside `output` on the
   * marker: it is the engine's bookkeeping about how the record was made, not
   * something the step said.
   */
  session?: string;
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
  /**
   * Whether that invalid round was *refused* — screened out, or caught doing
   * what its step never declared — rather than a contract its output broke.
   * Null exactly when `lastOutputValid` is: there is no failure to classify.
   * A field of its own rather than a third value of `lastOutputValid`, so a
   * workflow that routes every failure one way keeps matching on `false`
   * whichever kind it was.
   */
  lastRefused: boolean | null;
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
  /**
   * The branch this stage's step works on, as a template over `{ticket}`,
   * `{stage}` and `{round}`. Absent, the step gets a detached checkout of HEAD
   * and nothing it commits outlives the worktree.
   */
  branch?: string;
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
  /** The one budget the engine reads; every cap lives in the trigger that enforces it. */
  budget?: { stepTimeout?: string | undefined };
  /** Module paths, relative to the workflow directory, in pre-hook declaration order. */
  hooks?: string[];
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
  /**
   * The agent session the record was produced under — a step's own, or the
   * turn that last spoke on it. Beside `output`, never inside it: inside, it
   * was snapshot state (`outputs.<stage>.session`) that a predicate could
   * route on, and a step whose declared shape named a field `session` either
   * collided with it or had to be refused by the validator. Here, the two
   * cannot meet — the step's value is the agent's, and this is ours.
   */
  session?: string;
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
  /**
   * Resolved `vars`, which the workflow loader substitutes into the graph and
   * the step files. Kept apart from the config for the same reason
   * `secretValues` is — `config` is what a hook is handed and what `--debug`
   * prints — though a var is emphatically not a secret: nothing redacts it.
   */
  vars: Map<string, string>;
  /**
   * Variable names that resolved to nothing usable: no such environment
   * variable, or one set to an empty value. Both are reported rather than
   * substituted, because a workflow filled in with "$LANDRACE_ASSIGNEE" or
   * with "" is one that quietly matches no ticket at all.
   */
  missingVars: string[];
}

/** One MCP server as the repository root's `.mcp.json` defines it, passed on whole. */
export type McpServer = z.infer<typeof mcpServerSchema>;

/** `.mcp.json`, parsed. */
export type McpConfig = z.infer<typeof mcpConfigSchema>;

/**
 * The servers `agent.mcp` names, looked up in the repository root's
 * `.mcp.json` — or why they could not be. Problems rather than a throw, so
 * `landrace validate` reports what `landrace start` refuses, in its words.
 */
export interface ResolvedMcp {
  servers: Record<string, McpServer>;
  /** The tools a server's entry listed, by server name; a server named bare has none here and allows every tool. */
  tools: Record<string, string[]>;
  problems: Problem[];
}

/** One `agent.mcp` entry: a server's bare name, or its name and the only tools a step may call on it. */
export type McpEntry = RuntimeConfig["agent"]["mcp"][number];

/**
 * What a declared run is handed beyond its own tools, resolved once at
 * startup: the plugins `agent.plugins` enables and the servers `agent.mcp`
 * allows, by definition — never a path the agent's worktree could shadow.
 */
export interface StepTools {
  plugins: readonly string[];
  mcpServers: Readonly<Record<string, McpServer>>;
  /** Per server, the only tools a step may call; a server absent here allows every tool it has. */
  mcpTools: Readonly<Record<string, readonly string[]>>;
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
export type LoadFailureRule = "schema" | "duplicate-id" | "missing-step" | "step-path" | "vars" | "branch";

/** One tree with every `{vars.x}` filled in, what it took to fill it, and what it could not. */
export interface VarSubstitution {
  value: unknown;
  /** The names actually referenced, so the caller can report one that never was. */
  used: string[];
  /** One line per reference no var defines, saying where it was written. */
  unresolved: string[];
}

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
  ticket: string;
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
  /**
   * The prose half: text for a step's prompt, and never state the engine
   * decides from.
   *
   * `read` answers what the workflow routes on, which is why it is bounded to
   * a handful of scalars — `artifacts.*` is hashed into the snapshot and
   * addressed by every predicate, so a remote document's own text has no
   * business there. But a step can be asked to act on that text: `fix-review`
   * is told to address the open review threads on a pull request, and a count
   * of them is not something it can act on.
   *
   * So this is fetched only when a step is about to run, filed under
   * `brief.<id>.<key>` for the prompt to interpolate, escaped and bounded on
   * the way in, and merged into no snapshot at all. What a briefing carries is
   * the most attacker-reachable text in the system; what it cannot do is
   * decide anything.
   */
  brief?(ctx: HookContext): Promise<Record<string, string>> | Record<string, string>;
}

/**
 * The execution plane. Not a hook: invoking an agent produces new information,
 * and an effect hook that produced information would need tracker credentials.
 */
export interface Executor {
  id: string;
  run(
    prompt: string,
    opts: {
      round: number;
      resume?: string;
      cwd?: string;
      /**
       * The model the *step* asked for, which wins over whatever default the
       * executor was built with — the same way a step's capabilities win over
       * the operator's permission mode. Absent means "the operator decides":
       * a step that names no model must not be quietly pinned to one here.
       *
       * An executor that cannot honour a named model must refuse the run.
       * Dropping it silently is how `triage.md`'s `model: haiku` came to be
       * billed at opus on every human reply.
       *
       * And this one is trust, with no backstop under it, which is worth
       * saying plainly rather than leaving to be discovered. `capabilities`
       * below is checked a second time by the engine, against the worktree
       * the step was given — the filesystem remembers what an executor did
       * whatever it says about it. A model leaves nothing behind: once a run
       * has returned there is nothing observable to ask, and anything the
       * executor volunteers (a model on the return, a flag saying it honours
       * this) is a claim by the party whose compliance is the question. So
       * the engine records the request instead — `step.invoked` carries the
       * model and the executor's id — and an operator reads that against
       * whatever the executor reports of its own accord.
       */
      model?: string;
      /**
       * What the step declared it may do — the vocabulary is in
       * `src/conventions.ts`. An executor that cannot enforce one of these
       * must refuse the run rather than drop it: the engine's own check on the
       * worktree afterwards is a backstop, not a licence to ignore this.
       */
      capabilities?: readonly string[];
      /**
       * Present only for a step that declared `tickets:create`, and only on a
       * step's own invocation — a conversation turn is never handed one, so a
       * turn cannot create children however it is asked to. An executor that
       * cannot expose a bound create_child tool must refuse a run that carries
       * this, never drop it: the step would report children it had no way to make.
       */
      child?: ChildBinding;
      signal: AbortSignal;
    },
  ): Promise<{ text: string; sessionId: string | null }>;
}

/**
 * The ticket-less half of a HookContext, for the two kinds that run before —
 * or without — a ticket to build a snapshot for.
 */
export type RuntimeContext = Omit<HookContext, "ticket" | "snapshot">;

/**
 * The engine's *when* for a permission problem, tracker-agnostic by
 * construction: run once at startup, before any tick, page or MCP connection,
 * so a token missing something a workflow needs stops the process before the
 * first paid agent runs rather than after a mid-run write fails with nothing
 * durable recorded to show for it. What actually needs checking is entirely
 * the hook's business — the engine only runs each one in order and reports
 * which one failed, by id.
 */
export interface Preflight {
  id: string;
  check(ctx: RuntimeContext): Promise<void>;
}

/**
 * Where the work comes from. A tick has to enumerate tickets before it has one
 * to build a snapshot for, so this cannot be a pre hook: a pre hook is handed
 * the ticket it is describing.
 */
export interface Source {
  id: string;
  /**
   * The relationship types this source reports, and which of them a node may
   * have at most one outgoing edge of. The runner refuses an edge of any other
   * type, and `rel` carries exactly these — zero-counted when nothing relates,
   * so a predicate on a type the source never reports is caught by validate
   * rather than reading zero for ever.
   */
  relations: RelationDecl[];
  /**
   * Everything, once per tick: eligibility, scheduling and the board are all
   * answered from this, without a read per ticket. Each ticket node carries
   * its labels and assignees in `state`, because that is what those three ask.
   */
  list(ctx: RuntimeContext): Promise<Graph>;
  /** One ticket's neighbourhood — itself, its ancestors, its descendants and every related node — on every converge pass. */
  read(id: string, ctx: RuntimeContext): Promise<Graph>;
  /** Prompt text about this ticket, asked for only when a step's prompt names `{brief.<source id>.<key>}`. */
  brief?(ctx: HookContext): Promise<Record<string, string>> | Record<string, string>;
}

/* `| undefined` throughout, because exactOptionalPropertyTypes is on and these
 * are fed straight from Zod, whose optional output includes it. */
export interface NewTicket {
  title: string;
  body?: string | undefined;
  labels?: string[] | undefined;
  /** The ticket this one is a child of. The hook links it with its tracker's own parent relation. */
  parent?: string | undefined;
  /**
   * Set only by the runner, for a child a step created. The hook appends it as
   * a trailing marker under its own login, which is what lets a later round of
   * the same stage find — and drop — what this round made.
   */
  origin?: Origin | undefined;
  priority?: number | undefined;
}

/**
 * Who a created child belongs to, fixed by the runner before the agent starts.
 * The agent names a title and a body; it never names these, so it cannot file
 * a child under another ticket, stage or round.
 */
export interface ChildBinding {
  parent: string;
  stage: string;
  round: number;
}

/** What the agent may say about a child it creates, and nothing more. */
export interface NewChild {
  title: string;
  body?: string | undefined;
  priority?: number | undefined;
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
  createTicket(input: NewTicket, ctx: RuntimeContext): Promise<Node>;
  updateTicket(ticket: string, input: TicketPatch, ctx: RuntimeContext): Promise<Node>;
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
  /**
   * Run once at startup, in load order, before pre, post, source, operator or
   * executors are ever asked to do anything — see `Preflight`. Plural, because
   * several modules may each ship one.
   */
  preflights: Preflight[];
  /** Declaration order: a pre hook sees what the ones before it produced. */
  pre: PreHook[];
  post: PostHook[];
  /**
   * The artifact hooks themselves, kept whole beside the two phases they were
   * filed into. Their observe half is already a pre hook and their act half a
   * post hook; this is what the runner asks for a *briefing*, which belongs to
   * neither phase because it is not snapshot state and not an effect.
   */
  artifacts: ArtifactHook[];
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

/* ---------------------------------------------------------------- runner -- */

export interface Dispatcher {
  satisfied(s: Snapshot, e: Effect): boolean;
  apply(e: Effect, ctx: HookContext): Promise<void>;
  handlerFor(type: string): PostHook | null;
}

/**
 * The event vocabulary. Deliberately boring and fixed: an OpenTelemetry
 * exporter should later subscribe to this rather than require a rewrite.
 */
export type EventName =
  | "tick.started" | "tick.finished"
  | "ticket.evaluated" | "ticket.skipped"
  | "step.invoked" | "step.started" | "step.finished" | "step.completed" | "step.rejected" | "step.unchecked"
  | "agent.event"
  | "snapshot.built" | "snapshot.failed"
  | "effect.planned" | "effect.applied" | "effect.discarded" | "effect.failed"
  | "lock.acquired" | "lock.denied" | "lock.stolen"
  | "screen.passed" | "screen.blocked"
  | "display.failed";

export interface LandraceEvent {
  name: EventName;
  ticket?: string;
  [key: string]: unknown;
}

export type Logger = (name: EventName, data?: Record<string, unknown>) => void;

export type LockKind = "tick" | "conversation" | "execution";

export interface Held {
  ticket: string;
  holder: string;
  kind: LockKind;
  pid: number;
  /** When the holder last said it was still working, not when it started. */
  at: number;
  deadlineMs: number;
  /**
   * One acquisition, told apart from every other. A pid and a holder string
   * are both shared by two converges of the same ticket in the same process —
   * the loop lets ticks overlap on purpose — so neither can answer "is the
   * lock on disk still the one I took", which is the question release() has
   * to get right before it unlinks anything.
   */
  token: string;
}

/** Whether a single-writer critical section ran at all, kept apart from what it answered. */
export type Gated<T> = { ran: true; value: T } | { ran: false };

export interface LockOptions {
  holder?: string;
  /**
   * How long this lock may go unrefreshed before another process may take it.
   * Not a budget for the work: `withLock` refreshes while its body runs, so
   * this bounds how long a holder that has gone silent keeps a ticket.
   */
  deadlineMs?: number;
  /** Wait this long for a holder to finish before giving up. */
  waitMs?: number;
  root?: string;
}

/**
 * `kind` is CLAUDE.md's own distinction made explicit, in three parts:
 * - "contract": the step ran and produced something the engine cannot act
 *   on — malformed json, an undeclared shape, an ambiguous parse or route.
 *   The hard-fail rule is about exactly this case.
 * - "unavailable": the step never ran at all — the executor itself threw (a
 *   network blip, a timeout, a Ctrl-C). Nothing was produced, so nothing was
 *   rejected; a durable record here would misreport an outage as a broken
 *   contract and permanently poison a stage that never got to try.
 * - "refused": screened out *before* invocation, or caught afterwards doing
 *   what the step never declared. This looks like "unavailable" (the
 *   executor never ran either), but it is not an outage — the screener ran
 *   fine and returned a verdict. A refusal must be durable and terminal, not
 *   a silent, free-to-repeat retry: treating it as "unavailable" turned a
 *   security refusal into a paid screener call on every single poll,
 *   forever, with nothing ever left on the ticket for anyone to see. It is
 *   recorded under REFUSED_KIND rather than the contract's MALFORMED_KIND,
 *   which is what `run.lastRefused` reads back.
 */
export type StepResult =
  | { ok: true; effects: Effect[]; sessionId: string | null }
  | { ok: false; kind: "contract" | "unavailable" | "refused"; reason: string };

export interface ConvergeDeps {
  workflow: Workflow;
  /** Read first on every pass: the ticket's node, its graph and its `rel` counts are what everything after it decides from. */
  source: Source;
  /**
   * Where the repository is, when steps are to run in a per-ticket worktree of
   * it (`agent.isolation: worktree`). Absent means the agent runs wherever the
   * loop runs — the operator's own checkout — and the capability check has
   * nothing it may judge, because what changed there is not the step's doing.
   */
  sandbox?: { root: string };
  steps: Map<string, Step>;
  pre: PreHook[];
  /**
   * Asked for a briefing when — and only when — a step is about to be
   * invoked. Optional, and an absent list simply leaves a `{brief.…}`
   * placeholder visible in the prompt, the same as any other unknown path.
   */
  artifacts?: ArtifactHook[];
  dispatcher: Dispatcher;
  executor: Executor;
  screen?: { executor: Executor };
  ctx: Omit<HookContext, "snapshot">;
  log: Logger;
  maxPasses?: number;
}

export interface ConvergeResult {
  passes: number;
  settled: "wait" | "halt" | "terminal" | "cap";
  /** Set on "wait" and "halt": which of several possible causes this was, so a caller does not have to re-derive it from the log stream. */
  why?: string;
}

export interface StatusRow {
  ticket: string;
  title: string;
  stage: string | null;
  note: string;
}

export interface TickOptions {
  /**
   * Where the work comes from. Not a pre hook: a pre hook is handed the ticket
   * it describes, and a tick has to enumerate tickets before it has one.
   */
  source: Source;
  /** Without a source of its own: converge reads the tick's, so one tick cannot enumerate from one source and decide from another. */
  deps: Omit<ConvergeDeps, "ctx" | "source"> & { ctx: RuntimeContext };
  concurrency?: number;
  lock?: LockOptions;
  /**
   * Every node the source returned this tick, eligible or not. For a
   * display: handing over what the tick already fetched costs nothing, and
   * asking the source again would double the tracker traffic of every tick.
   */
  onList?: (graph: Graph) => void;
}

export interface TickRow {
  ticket: string;
  outcome: string;
}

export type Eligibility = { eligible: true } | { eligible: false; reason: string };

/* --------------------------------------------------------------- testing -- */

/**
 * What a scripted step answers. A function is handed the round, because the
 * whole reason a stage loops is that it answers differently the second time —
 * a fixed answer per stage could never drive `spec`'s questions-then-spec.
 */
export type ScriptedAnswer = string | ((round: number) => string);

/** One invocation, as the harness saw it go out. */
export interface StepCall {
  stage: string;
  round: number;
  prompt: string;
}

export interface HarnessRun {
  result: ConvergeResult;
  /** The invocations this call made, in order. */
  calls: StepCall[];
  /** The positions this call passed through, with repeats collapsed. */
  trail: string[];
}

export interface HarnessOptions {
  workflow: Workflow;
  steps: Map<string, Step>;
  /** What the ticket's node, graph and `rel` counts are read from on every pass. */
  source: Source;
  pre: PreHook[];
  post: PostHook[];
  artifacts?: ArtifactHook[];
  /** What each stage's step answers. A stage that is invoked with nothing scripted is a gap, and says so. */
  answers?: { [stage: string]: ScriptedAnswer };
  /**
   * What the prompt screener answers for each stage's step — a fenced json
   * verdict, as the real one writes. Absent, nothing is screened. Present, a
   * stage with no answer here is a screener that could not run, which is a
   * refusal: the same fail-closed reading the engine gives a real one.
   */
  screen?: { [stage: string]: ScriptedAnswer };
  ticket?: string;
  /**
   * What the world does while a step runs — a push, a pull request appearing,
   * a person resolving a thread. Called after the invocation is decided and
   * before the answer comes back, which is where those things actually happen.
   *
   * This is also the seam for anything the engine cannot do yet: nothing in
   * `src/` pushes a branch or opens a pull request, so a test that needs one
   * stands the push in here rather than pretending the build did it.
   */
  during?(call: { stage: string; round: number }): void | Promise<void>;
  /**
   * Kill the run at an effect, to prove a crash costs nothing. Handed each
   * effect and how many have been applied in this call so far; true means the
   * process died here.
   */
  interrupt?(effect: Effect, applied: number): boolean;
  /** Somewhere for the events to go. The harness reads its own trail off them either way. */
  log?: Logger;
  maxPasses?: number;
}

export interface Harness {
  /** One converge, as the daemon would run it. */
  converge(): Promise<HarnessRun>;
  /** Every position the ticket has passed through, across every call, repeats collapsed. */
  trail(): string[];
  /** Every invocation, across every call. */
  calls(): StepCall[];
  /** How many times each stage's step has run. */
  counts(): { [stage: string]: number };
}

/** A ticket as the in-memory tracker holds it. */
export interface ExternalTicket {
  id: string;
  title: string;
  body: string;
  labels: string[];
  /**
   * Who the ticket belongs to, as logins. A list, because a tracker's is a
   * list — and because that is what lets several instances share one
   * repository, each taking only what is assigned to it.
   */
  assignees: string[];
  comments: TrackerComment[];
  /** Lower is more urgent; null is unprioritised, never zero. */
  priority: number | null;
  /** The ticket this one is a child of, by id. */
  parent: string | null;
  closed: Closed;
  /** Who opened it, as a login. */
  author: string;
}

/** A pull request as the in-memory tracker holds it: live and mutable, so a test moves it the way a person on the tracker would. */
export interface ExternalPull {
  /** The node id, `pr-<number>`. */
  id: string;
  number: number;
  /** The ticket it implements. */
  ticket: string;
  merged: boolean;
  openThreads: number;
  closed: Closed;
  /** The branch it was opened from, when it says: what `pull.open` looks a pull request up by. */
  branch?: string;
}

/**
 * An in-memory stand-in for a tracker, speaking the conventions and no
 * vendor's dialect at all.
 *
 * It is not a second copy of any integration — a real one's hooks are tested
 * over a fake HTTP boundary, which is the only honest way to test *them*. This is what a workflow author has before any integration exists: a
 * place for the labels, the records and the human turns to live, so the graph
 * can be driven and its loops watched.
 */
export interface ExternalState {
  pre: PreHook;
  post: PostHook;
  source: Source;
  operator: Operator;
  /** Open a pull request implementing `ticket`; returns its node id, `pr-<n>`, numbered from 1 in creation order. */
  openPull(ticket: string, pr?: { merged?: boolean; openThreads?: number; closed?: Closed; branch?: string }): string;
  /** Every branch a `branch.push` was applied for, in order: there is no repository here to push to. */
  pushes(): string[];
  /** The live record behind a pull request node, for a test to merge, close or comment on. */
  pull(id: string): ExternalPull;
  ticket(id: string): ExternalTicket;
  /** Every row whose `parent` is this id, a test helper for asserting on what a step created. */
  children(parent: string): ExternalTicket[];
  comments(id: string): string[];
  entriesOf(id: string): Entry[];
  /** Where the ticket sits, as the engine would read it: out of a label. */
  stage(id: string): string | null;
  label(id: string, label: string): void;
  unlabel(id: string, label: string): void;
  /** A person says something, under their own name, so it reads as a human turn. */
  say(id: string, text: string): void;
}

/* ----------------------------------------------------------------- agent -- */

export type JsonBlockResult =
  | { kind: "none" }
  | { kind: "unparseable" }
  | { kind: "found"; value: Record<string, unknown>; span: [number, number] };

/**
 * One level of the scanner's own nesting. Declared here rather than inside the
 * function it belongs to, because every type in the system is declared here —
 * see the note at the top of `src/agent/json-block.ts` about what that costs.
 */
export type JsonFrame =
  | { kind: "object"; seen: Set<string>; state: "key-or-close" | "colon" | "value" | "comma-or-close" }
  | { kind: "array"; state: "value-or-close" | "comma-or-close" };

/** What the screener's own json block is read as before its fields are checked. */
export type Verdict = { verdict?: unknown; reason?: unknown };

/* ------------------------------------------------------------------- mcp -- */

export interface Tools {
  waiting(): Promise<Array<{ ticket: string; title: string; url: string }>>;
  status(ticket: string): Promise<unknown>;
  // `| undefined` is explicit because exactOptionalPropertyTypes is on and these
  // are fed straight from Zod, whose optional output includes it.
  createTicket(input: {
    title: string;
    body?: string | undefined;
    labels?: string[] | undefined;
    start?: boolean | undefined;
  }): Promise<unknown>;
  updateTicket(
    ticket: string,
    input: {
      title?: string | undefined;
      body?: string | undefined;
      state?: "open" | "closed" | undefined;
      addLabels?: string[] | undefined;
      removeLabels?: string[] | undefined;
    },
  ): Promise<unknown>;
  reply(ticket: string, message: string): Promise<unknown>;
  ask(ticket: string, message: string, opts?: { signal?: AbortSignal }): Promise<unknown>;
  resolve(ticket: string, why?: string | undefined): Promise<unknown>;
}

/** The one tool a step that may create children is handed, already bound. */
export interface ChildTool {
  createChild(input: NewChild): Promise<{ ticket: string; title: string; link: string }>;
}

/**
 * What the MCP plane needs beyond the registry to hold a conversation: an
 * executor to resume a step's session with, a screener to judge the turn
 * before it runs, and where the per-ticket locks live. All optional — without
 * an executor the conversation tools report that none is configured rather
 * than crashing, exactly as the operator hook's absence is reported, and
 * screening is the operator's `security.screen` to switch off.
 */
export interface ToolOptions {
  executor?: Executor;
  screen?: { executor: Executor };
  lock?: LockOptions;
  /**
   * Carried straight through to the conversation, which needs all three to
   * hold a turn to what its step declared. Optional for the same reason they
   * are optional there: a process that assembles tools without an executor
   * holds no turn, and one that has an executor and not these refuses the
   * turn rather than running it unconstrained.
   */
  workflow?: Workflow;
  steps?: Map<string, Step>;
  sandbox?: { root: string };
}

/* ------------------------------------------------------------------- cli -- */

/** Where the decision is made from, so it can be tested without being this process. */
export interface Where {
  execArgv: readonly string[];
  env: NodeJS.ProcessEnv;
}

export interface Reexec {
  execPath: string;
  /** This process's own node options, carried over: dropping `--import` or `--inspect` would silently change how the retry runs. */
  execArgv: readonly string[];
  /** The command line after the node options — `process.argv.slice(1)`. */
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
}

/** Everything the loop needs, assembled once, so a tick is only a call. */
export interface Runtime {
  /** Where the work comes from. Required: a loop with nothing to enumerate can never do anything. */
  source: Source;
  /**
   * Assembled by `buildRuntime` but deliberately not run by it: `landrace
   * status` builds a Runtime the same way to enumerate tickets, and must
   * never make the one write a preflight can make while only trying to read.
   * Only `runStart` runs these, before the first tick.
   */
  preflights: Preflight[];
  deps: Omit<ConvergeDeps, "ctx"> & { ctx: RuntimeContext };
  intervalMs: number;
  concurrency: number;
  /**
   * Ctrl-C. The same signal every hook and executor is handed, so aborting it
   * stops the agent subprocess, stops the next pass from starting, and lets
   * each ticket unwind through the lock it holds.
   */
  stop: AbortController;
}

/**
 * A self-rescheduling timer, owned rather than a bare `setInterval`, so a
 * manual tick can restart the countdown and the page can read when the next
 * one is due.
 */
export interface Schedule {
  /** Start: run once immediately, then every intervalMs. */
  start(): void;
  /** Stop scheduling. In-flight ticks are not cancelled here — the stop signal does that. */
  stop(): void;
  /** When the next scheduled tick will fire, epoch ms; null when stopped. */
  nextAt(): number | null;
  /**
   * Run a tick now and restart the countdown from now. Returns false, running nothing, if a tick
   * started by trigger() is still in flight — at most one manual tick at a time. Scheduled ticks are
   * unaffected and may still overlap, as today.
   */
  trigger(): boolean;
}

export interface StartOptions {
  once?: boolean;
  debug?: boolean;
  /** Serve the triage page. Default true; `--no-ui` turns it off. */
  ui?: boolean;
  uiPort?: number;
}

export interface BuildOptions {
  debug?: boolean;
  /** Where events go. `landrace status` sends them to stderr, because stdout is its report. */
  sink?: (event: LandraceEvent) => void;
  /**
   * `landrace status`: it enumerates and never runs a step, so the plugins and
   * servers a step would be handed are neither resolved nor refused over — and
   * the step executor it gets refuses every run rather than running one
   * without them.
   */
  readOnly?: boolean;
}

/* ------------------------------------------------------- sandbox (§15) -- */

/**
 * A worktree as it stands at one moment: the commit it is on, and every path
 * git reports as changed. Compared before and after a step to decide whether
 * it did anything it did not declare a capability for — the commit is half of
 * it, because committing leaves the status clean.
 */
export interface WorktreeState {
  head: string;
  changes: string[];
}

/**
 * The branch a step's worktree is checked out on, from its stage's `branch`,
 * and whether the step may commit to it — the branch itself if it may, its
 * commit detached if it may not.
 */
export interface WorktreeBranch {
  branch: string;
  write: boolean;
}

/* ------------------------------------------------ conversation (§12, §7) -- */

/**
 * What a turn joins: the session to resume, and the stage and round whose
 * record carried it, so the turn is recorded against the same round the step
 * produced. All three are derived from the ticket, never remembered.
 */
export interface JoinedSession {
  session: string;
  stage: string;
  round: number;
}

export interface ConversationDeps {
  /** The tick's own source and pre hooks: a turn reads the snapshot the tick would read, not a second view of the ticket. */
  source: Source;
  pre: PreHook[];
  /** And the tick's own effect dispatcher, so a turn writes records the tick can re-derive. */
  dispatcher: Dispatcher;
  ctx: RuntimeContext;
  /** Null when no executor is configured: `ask` reports that rather than crashing. */
  executor: Executor | null;
  /**
   * What the step behind this conversation declared, resolved the way converge
   * resolves it: the stage the joined record came from names a step, and the
   * step names its capabilities and its model.
   *
   * A turn is an agent invocation on the same session, so it is held to the
   * same limits — a turn that were less constrained than the step it continues
   * is a way to ask an agent through conversation for exactly what the
   * workflow forbade it in the step. Optional on the type because `createTools`
   * assembles a conversation for processes that may never hold one; `ask`
   * refuses rather than running a turn it cannot constrain.
   */
  workflow?: Workflow;
  steps?: Map<string, Step>;
  /**
   * Where the repository is, when a turn is to run in a per-ticket worktree of
   * it — the loop's own `agent.isolation: worktree`, read the same way. Its
   * presence is what makes the step's capabilities checkable rather than
   * delegated: we built the directory, so what changed in it is the turn's
   * doing. Absent, the agent runs where the MCP process runs and there is
   * nothing to judge, exactly as in a tick with isolation off.
   */
  sandbox?: { root: string };
  /**
   * The screener, when the operator configured one — the same shape runStep
   * takes, because a turn is an agent invocation like any other and §15 knows
   * of no exemption for one that arrived through the MCP.
   */
  screen?: { executor: Executor };
  lock?: LockOptions;
}

export interface Conversation {
  /**
   * Relay a person's message to the step that is waiting, and record both
   * halves. `resolved` is the agent's own answer to "are you still missing
   * something", read fail-closed: unreadable means unresolved.
   */
  ask(
    ticket: string,
    message: string,
    opts?: { signal?: AbortSignal },
  ): Promise<{ reply: string; resolved: boolean }>;
  /** Hand the ticket back to the loop as a human turn. Already handed back is reported, not repeated. */
  resolve(ticket: string, why?: string): Promise<{ alreadyResolved: boolean }>;
}

/* -------------------------------------------------------------------- ui -- */

/**
 * Where a ticket stands, drawn as its badge — and, for a whole branch, the
 * lane it is drawn in. The cascade's order, most urgent first, is `URGENCY`
 * in src/ui/board.ts; nothing reads it from this union.
 */
export type Lane = "needs-you" | "running" | "elsewhere" | "waiting" | "not-admitted" | "discharged";

/** An agent this process has in the room right now. */
export interface Running {
  stage: string;
  round: number;
  model: string | null;
  since: number;
}

/** A known system's display name and the coloured letter mark the page draws for it. */
export interface SystemMark {
  name: string;
  /** `#rrggbb` — the mark's background. */
  bg: string;
  /** One or two capital letters, drawn in white on `bg`. */
  glyph: string;
}

/**
 * Which external system a link points into, for a person scanning the tree.
 * `icon` is null for a host we do not know, whose name is then the bare
 * hostname — an unrecognised system is still named, never guessed.
 */
export interface BoardSystem {
  name: string;
  icon: { bg: string; glyph: string } | null;
}

/**
 * The Chat menu's contents for one ticket, built server-side in
 * `src/ui/chat.ts` from nothing but the ticket number and the workspace
 * path — the page script only ever assigns these to `href`/clipboard text,
 * never concatenates a URL of its own.
 */
export interface Chat {
  prompt: string;
  links: { claude: string; claudeCli: string; cursor: string; codex: string };
}

/**
 * One node on the triage page's tree. An allowlist, not a pass-through:
 * nothing reaches the page that was not named here, so a secret cannot ride
 * along in an event payload and a remote document's body never does.
 */
export interface BoardRow {
  id: string;
  /** "ticket", or whatever kind the source gave an artifact ("pull-request", "document"). */
  kind: string;
  title: string;
  /** http(s) only, else empty — it becomes an href. */
  link: string;
  /** Null only when there is no usable link to name a system from. */
  system: BoardSystem | null;
  /** Tickets only: where this ticket itself stands. Null on an artifact row. */
  badge: Lane | null;
  /**
   * Root rows only: the lane the whole branch is drawn in — the most urgent
   * badge of any ticket in it, so a sub-ticket that needs you is never filed
   * under a parent that merely waits. A branch with no ticket in it waits
   * while its root is open and is discharged once it is closed. Null on a
   * nested row, which is drawn in its root's lane.
   */
  lane: Lane | null;
  stage: string | null;
  priority: number | null;
  closed: Closed;
  note: string;
  /** When the current state began, if this process knows. Epoch ms. */
  since: number | null;
  round: number | null;
  model: string | null;
  /** Tickets only. */
  chat: Chat | null;
  /** Stopped by a security check rather than for any other reason — the page draws a shield. */
  screened: boolean;
  /**
   * Where the page's Retry posts, for a ticket that is blocked or screened
   * right now; null everywhere else. Built by the server from a checked id,
   * so the page never puts a URL together itself.
   */
  retry: string | null;
  children: BoardRow[];
}

export interface BoardView {
  generatedAt: number;
  rows: BoardRow[];
  /** When the next scheduled tick is due, epoch ms; null when nothing is scheduled. */
  nextTickAt: number | null;
  /** The repository checkout's own name — the header chip. `basename(workspace)`. */
  folder: string;
  /** The absolute path of the repository checkout landrace is running in. */
  workspace: string;
}

export interface Board {
  observe(e: LandraceEvent): void;
  list(graph: Graph): void;
  view(): Promise<BoardView>;
  /**
   * Why a Retry may not be posted on this node, read just now, or null when it
   * may: it must be an open ticket, blocked or screened, whose agent is not
   * running in this process.
   */
  retryRefusal(node: Node): string | null;
}

export interface UiOptions {
  port: number;
  view: () => Promise<BoardView>;
  /**
   * The schedule's own `trigger`. Absent, POST /tick is 404: the page's only
   * write exists only when something is actually there to run it against.
   */
  tick?: () => boolean;
  /**
   * The Retry on a blocked or screened ticket: `refusal` reads the ticket
   * afresh and says why it may not be retried — the page is never taken at
   * its word — and `post` hands it back with a human turn.
   * Absent, POST /tickets/<id>/retry is 404, as /tick is without a tick.
   */
  retry?: RetryPath;
}

/**
 * What posting a person's reply on a ticket needs: the snapshot a post hook
 * is handed, read the way the tick reads it, and the dispatcher every other
 * write goes through.
 */
export interface ReplyDeps {
  source: Source;
  pre: PreHook[];
  dispatcher: Dispatcher;
  ctx: RuntimeContext;
}

/** How the page's Retry reaches a ticket: the one check, and the one write. */
export interface RetryPath {
  /** A sentence saying why this ticket may not be retried right now, or null. */
  refusal(ticket: string): Promise<string | null>;
  post(ticket: string): Promise<void>;
}

export interface UiServer {
  url: string;
  port: number;
  close(): Promise<void>;
}
