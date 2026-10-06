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
import type { stepFrontMatterSchema } from "#workflow/schema.js";
import type { HOOK_KINDS } from "#hooks/contracts.js";
import type { CHAT_TARGET_KEYS } from "#ui/chat.js";
import type { BaseDocs } from "#kit/docs.js";
import type { BaseForge } from "#kit/forge.js";
import type { BaseTracker } from "#kit/tracker.js";

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
  /**
   * When the tracker says it was opened, epoch ms; absent where the source
   * cannot tell cheaply. Display only: it is not among the paths the snapshot
   * provides, so a workflow that routes on it fails validation.
   */
  createdAt?: number;
  /**
   * When the tracker says it last changed — a comment, a label, a close —
   * epoch ms; absent where the source cannot tell cheaply. Display only, as
   * `createdAt` is: the board orders its lanes by it, and no workflow may.
   */
  updatedAt?: number;
  /**
   * True on a node reported only as the other end of a relationship, built
   * from what the relationship said of it. It is never an item of the source
   * that reports it: no workflow claims it, no row shows it, and two sources
   * reporting one are no clash. It counts in `rel` and is named on the
   * panel, as the other end of an edge. Absent on every other node.
   */
  placeholder?: true;
  /**
   * True on a placeholder whose source knew which item it is but could not
   * read what state it is in: its `closed` is null, never a guess, and the
   * panel says it is unreadable. Absent on every other node.
   */
  unreadable?: true;
}

export interface Relationship { from: string; to: string; type: string }

export interface Graph { nodes: Node[]; relationships: Relationship[] }

/** A relationship type a source reports, and whether a node may have at most one OUTGOING edge of it. */
export interface RelationDecl {
  type: string;
  singular: boolean;
  /**
   * True where a read draws this type only from its item outward — the
   * edges other items have toward it are not read — so `rel.<type>.in`
   * would count none in every read. The snapshot provides only its `out`
   * side, and `validate` refuses a workflow reading the other.
   */
  outwardOnly?: true;
}

/** The counts over one direction of one relationship type. */
export interface RelAgg {
  total: number;
  /**
   * The related nodes closed without being done — a pull request closed
   * unmerged, a child dropped — which `total` and every other count leave
   * out. Counted apart, so a workflow can route on one: whether a person
   * closing a pull request is their stop is the workflow's to say.
   */
  dropped: number;
  is: { [field: string]: number };
  not: { [field: string]: number };
  sum: { [field: string]: number };
  stage: { [stage: string]: number };
  /**
   * The ids of the related nodes still open — counted in `total` and not
   * closed — in id order: which ones a count is of, for a person reading
   * "waiting on #10, #11". Empty, never absent, like every count here.
   */
  open: string[];
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
  /**
   * The commit the step's worktree started at, for a step on a branch — on
   * its output record, or its rejection's. The engine's, beside `data` and
   * never in it: an agent's answer naming a `head` is its value's, and a
   * merge guarded by `reviewedBy` holds the head it merges to the one on
   * the stage's latest output — a rejection's says where a round that
   * judged nothing started, and is never read for it.
   */
  head?: string;
  /**
   * Where a goto record asks the item to go: a stage id, written by
   * Landrace alone — beside a judge's output, or on the record the board's
   * "Go to step…" or `landrace_goto` writes. `run.goto` reads it.
   */
  goto?: string;
  /** On an entry record, the stage the item left to enter this one. `run.previousStage` reads it. */
  from?: string;
  /**
   * Who produced an output record: "pair" for one a person handed in from a
   * pairing. Absent reads as "agent", so every record written before pairing
   * existed routes exactly as it did.
   */
  by?: string;
  /** ISO 8601. Ordering is by this field, not array position. */
  at: string;
  /** True when we wrote it. False means a person did. */
  byAgent: boolean;
  /**
   * What a person reads on the item — ours with the marker taken off.
   * Display only, for the item panel's conversation: it is not among the
   * paths the snapshot provides, and nothing routes on it.
   */
  text?: string;
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
  /**
   * The round each stage with a record would be entered or run at now — read
   * through `nextRound`, which answers 1 for a stage with none. Round numbers,
   * not the count `counters` keeps: a stage with no step settles a round only
   * when its way in is refused, so its rounds and its counter part ways.
   */
  next: { [stage: string]: number };
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
  /**
   * Where a goto record written since the item last entered a stage asks
   * it to go; null when there is none. Entering any stage writes an entry
   * record, and that is what consumes it — nothing is ever cleared.
   */
  goto: string | null;
  /**
   * The round a person cleared of the security check, and its stage: the
   * latest clearance record, while nobody has written since — anything
   * written after it would reach that round's prompt unscreened. Null
   * otherwise. The round it names is the only one it covers.
   */
  cleared: { stage: string; round: number } | null;
  /**
   * The stage the item left to enter the current one, read off the current
   * stage's own entry record. Null when the current stage records no entry,
   * or was entered as a fresh item: an older stage's answer would be a
   * wrong one, not an approximate one.
   */
  previousStage: string | null;
  /** Every stage with a rejected round, independent of which stage `lastOutputValid` answers for. */
  failedStages: string[];
  /**
   * The failure that put the item where it is: the stage of the latest
   * entry record of any stage but the current one — walking past a settled
   * round trip from the current visit, such as a question the judge sent home —
   * when that stage is still in `failedStages`; otherwise null. What Retry
   * re-runs and what the judge is told failed — never an older failure the
   * item has since been sent around, which `failedStages` still lists.
   */
  failedStage: string | null;
  unblockedAt: number;
  /**
   * The pairing open on this item, or null. Read off the records alone: a
   * pair record opens one, and an output record for its stage at its round or
   * later, or a release record, closes it. While one is open its stage never
   * runs alone.
   */
  pairing: Pairing | null;
  /**
   * Who produced the latest output record — "agent", or "pair" for one a
   * person handed in from a pairing — or null before any output exists. A
   * record that names nobody reads as "agent".
   */
  lastOutputBy: string | null;
  /**
   * Per stage, the commit its latest valid output started at, when that
   * record carries one: `run.heads.<stage>`. Never a rejection's: a round
   * whose answer was rejected or refused judged nothing.
   * What `pull.merge`'s `reviewedBy` holds the head it merges to, so code no
   * review saw is never merged. Null-prototype, as `counters` is.
   */
  heads: { [stage: string]: string };
}

/** An open pairing: its stage and round, which pairing at that round it is, and when it began (ISO 8601). */
export interface Pairing {
  stage: string;
  round: number;
  n: number;
  at: string;
}

/** A MongoDB-style condition document over snapshot dot-paths. */
export type Condition = { [path: string]: unknown };

export interface Trigger {
  name?: string;
  when: Condition;
}

/** An entry in a stage's `goto`: a stage it may always send an item to, or one it may while `when` holds. */
/**
 * `retry: only` declares a target Retry's alone: taken only while it is what
 * failed, `run.failedStage`, and never offered under "Go to step…".
 */
export type GotoEntry = string | { stage: string; when?: Condition | undefined; retry?: "only" | undefined };

/** A `goto` entry as the engine reads it. `when` null means always. */
export interface GotoTarget {
  stage: string;
  when: Condition | null;
  /** Declared `retry: only`: taken only as the Retry of a failed `stage`. */
  retryOnly: boolean;
}

export interface Effect {
  type: string;
  [key: string]: unknown;
}

export interface Stage {
  id: string;
  step?: string;
  /**
   * The branch this stage's step works on, as a template over `{item}`,
   * `{stage}` and `{round}`. Absent, the step gets a detached checkout of
   * origin's default branch, freshly fetched, and nothing it commits outlives the worktree.
   */
  branch?: string;
  entry?: boolean;
  terminal?: boolean;
  /**
   * Whose turn it is while an item rests here: `person` files it under Needs
   * you — on the board, in a notification, in `landrace status` and in
   * `landrace_waiting`. Read off the stage the item is located at, never off a
   * label, so a workflow that writes nothing to its tracker can still say an
   * item waits on someone. `| undefined`: fed from Zod.
   */
  waits?: "person" | undefined;
  identity?: Condition;
  requires?: Condition;
  triggers?: Trigger[];
  on_enter?: Effect[];
  /**
   * The stages a person may send an item at this stage back to — by a judge
   * step's route, the board's "Go to step…" or `landrace_goto`. A bare id
   * always; `{ stage, when }` only while `when` holds, which is where a
   * loop's round cap goes, since a goto takes no trigger; `retry: only` only
   * while the target is what failed. A goto to a stage not listed here
   * halts; one declined is left to the stage's triggers.
   */
  goto?: GotoEntry[] | undefined;
  /**
   * What the item's row says while it rests here, in place of "queued" —
   * on the board, in `landrace status` and `landrace_status` — as a template
   * over `{node.id}` and `{rel.<type>.<in|out>.<count|open>}`. Display only:
   * any other note (working, waiting on you, a halt, an agent running) is
   * said over it, and the lane is never read from it. `| undefined`: fed
   * from Zod.
   */
  note?: string | undefined;
  /**
   * `run`: a closed item may enter this stage by one trigger, and its step
   * runs there once; nothing leaves it while the item stays closed. Absent,
   * a closed item is never moved to it and no step runs on one. `| undefined`:
   * fed from Zod.
   */
  closed?: "run" | undefined;
}

export interface EligibilityRule {
  when: Condition;
  else: string;
}

export interface Workflow {
  version: number;
  /** The display title. */
  name: string;
  /** What a person or agent choosing a workflow reads. */
  description: string;
  /** Labels a started item is given; the engine names none itself. */
  admit?: string[] | undefined;
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
  /** On a wait: the pairing that holds this stage's owed step, so the board can say so. */
  paired?: Pairing;
}

export type Location =
  | { kind: "at"; stage: Stage }
  | { kind: "none" }
  | { kind: "ambiguous"; ids: string[] };

/**
 * Where a listed node is (`locateNode`). `none` there means every identity
 * was judged and none matched — a fact a status row halts on, as decide
 * does; `abstained` means none matched because one could not be judged from
 * the node alone, which is not knowing, and is never halted on.
 */
export type NodeLocation = Location | { kind: "abstained" };

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
  /**
   * Where a goto record asks the item to go: a stage id, written by
   * Landrace alone — beside a judge's output, or on the record the board's
   * "Go to step…" or `landrace_goto` writes. `run.goto` reads it.
   */
  goto?: string;
  /** On an entry record, the stage the item left to enter this one. `run.previousStage` reads it. */
  from?: string;
  /** On an output record, who produced it — see `Entry.by`. */
  by?: string;
  /** On a step's record, the commit its worktree started at — see `Entry.head`. */
  head?: string;
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
 * a tracker's own type, because a comment on an issue, a note on an item and
 * a message on a thread are the same three facts under different names — the
 * spellings here are the ones every tracker API that has them already uses.
 */
export interface TrackerComment {
  id?: number | string | undefined;
  body: string;
  created_at: string;
  user?: { login?: string } | null;
}

/** Who a comment is for: one of `COMMENT_VISIBILITIES`. */
export type CommentVisibility = "internal" | "public";

/**
 * One worklog on an item, as a tracker reads it before logging: who logged it, how
 * long, and the marker Landrace stamped on one it wrote — null on a person's.
 */
export interface WorklogRecord {
  id: string;
  author: string | null;
  seconds: number;
  marker: string | null;
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
   * `LANDRACE_ENABLE_TELEMETRY` and the `OTEL_*` settings telemetry reads,
   * `.env` over the shell exactly as a secret resolves. `--otel` goes over
   * both, in `telemetrySettings`.
   */
  telemetry: Map<string, string>;
  /**
   * Variable names that resolved to nothing usable: no such environment
   * variable, or one set to an empty value. Both are reported rather than
   * substituted, because a workflow filled in with "$LANDRACE_ASSIGNEE" or
   * with "" is one that quietly matches no item at all.
   */
  missingVars: string[];
}

/* -------------------------------------------------------------- workflow -- */

export type StepFrontMatter = z.infer<typeof stepFrontMatterSchema>;

/** A step file read but not yet validated: the raw front matter, so an `extends` chain merges before zod sees it. */
export interface ParsedStep {
  front: Record<string, unknown>;
  body: string;
}

export interface Step extends StepFrontMatter {
  prompt: string;
}

/** One route of a step's output: `effect` or `effects`, never both (the schema refuses either other way). */
export type Route = NonNullable<StepFrontMatter["output"]>["routes"][number];

/**
 * `runValidate` must report a broken workflow as a `Problem`, not let an
 * exception escape past it (spec §11.1-§11.2: `validate`'s entire job is
 * reporting). Tagging the failure with a `rule` — at the point each kind of
 * failure is actually detected — is what lets the CLI turn it into the same
 * shape as every other problem, instead of pattern-matching an error message
 * after the fact.
 */
export type LoadFailureRule = "schema" | "duplicate-id" | "missing-step" | "step-path" | "vars" | "branch" | "layout";

/** One workflow of a workspace: its folder name is its id. */
export interface LoadedWorkflow {
  id: string;
  dir: string;
  workflow: Workflow;
  steps: Map<string, Step>;
}

/** Every workflow under `<dir>/workflows/`, in the order they are shown and run. */
export interface Workspace {
  dir: string;
  workflows: LoadedWorkflow[];
}

/** Why a workflow, or the workspace's vars, would not load: a load error's rule and its sentence. */
export interface LoadFailure {
  rule: LoadFailureRule;
  message: string;
}

/**
 * A workspace as far as it would load: the workflows that did, and a failure
 * for each that did not. `ids` is every workflow folder, loaded or not.
 * `validate` reads this to report every failure and still check the rest;
 * every command that runs a workflow refuses on any failure instead.
 */
export interface WorkspaceRead extends Workspace {
  ids: string[];
  failures: LoadFailure[];
}

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
  item: string;
  snapshot: Snapshot;
  config: RuntimeConfig;
  secrets: ReadonlyMap<string, string>;
  signal: AbortSignal;
  log: (event: string, data?: Record<string, unknown>) => void;
  /**
   * The field ids the loaded workflows' `tracker.field` effects set, for a
   * tracker's `list` and `read` to fetch into `node.state.fields`, where
   * `satisfied` reads them. Absent when the caller cannot say.
   */
  trackerFields?: ReadonlySet<string> | undefined;
}

/** What a `tracker.field` sets one field to, from the workflow file: text, a number, or a list of strings. */
export type TrackerFieldValue = string | number | string[];

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
  /**
   * The projects its `tracker.create` files issues in. `validate` refuses a
   * workflow filing one anywhere else; absent or empty, nowhere.
   */
  creates?: string[] | undefined;
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
   *
   * `keys` are the ones the prompt names, and a hook reads no other: a key
   * read and then dropped is a remote read paid for, and one that can fail
   * the step. Absent, every key is read.
   */
  brief?(ctx: HookContext, keys?: ReadonlySet<string>): Promise<Record<string, string>> | Record<string, string>;
}

/**
 * What screens a prompt before an agent sees it: the executor
 * `security.adapter` (or else `agent.adapter`) names, and the model
 * `security.model` names, or none — the executor's own default then decides.
 */
export interface Screener {
  executor: Executor;
  model: string | undefined;
}

/**
 * One line of what an agent is doing while it runs — a tool it called, or
 * something it said — for the item panel. Display only: nothing routes on
 * it, and the engine keeps only the last round of it per stage.
 */
export interface AgentActivity {
  kind: "tool" | "message";
  text: string;
  /** Epoch ms. */
  at: number;
}

/** One line of an activity file: the line, and the round of the run it belongs to. */
export type ActivityRecord = AgentActivity & { round: number };

/**
 * What the panel reads of an item's activity: the stage and round of the
 * run it last recorded, and that run's lines from `after` on. `total` is how
 * many lines the run has, so the next read can ask for only what is new.
 */
export interface ActivityPage {
  stage: string | null;
  round: number | null;
  lines: AgentActivity[];
  total: number;
}

/**
 * Where agent activity is kept, on disk rather than in memory: a turn asked
 * through `landrace mcp` runs in another process, and the page must show it too.
 */
export interface ActivityLog {
  /**
   * A step is about to run: its stage's lines start afresh, even at the
   * round they already hold — a step that never finished is run again at
   * the same round, and its dead attempt's lines are not this run's. Never
   * throws.
   */
  begin(item: string, stage: string, round: number): void;
  /** Never throws: a display must never be able to stop the work it displays. */
  record(item: string, stage: string, round: number, e: AgentActivity): void;
  read(item: string, after: number): Promise<ActivityPage>;
}

/**
 * The execution plane. Not a hook: invoking an agent produces new information,
 * and an effect hook that produced information would need tracker credentials.
 *
 * What every executor owes the engine, beside what each option below asks:
 * - never hand a step or a turn the operator's own `landrace` MCP server: its
 *   tools create, update and move items, and a step holding them could move
 *   its own;
 * - run in `cwd` when given: the engine's read-only check inspects that
 *   directory, and a run anywhere else defeats it;
 * - never pass the engine's process environment through to the agent: a
 *   secret can come from the shell the engine was started in, and the agent
 *   must not hold tracker credentials;
 * - stop when `signal` aborts.
 */
export interface Executor {
  id: string;
  run(
    prompt: string,
    opts: {
      round: number;
      resume?: string;
      /** Where to run — a step's worktree, when steps are isolated. See the contract above. */
      cwd?: string;
      /**
       * The model the *step* asked for — or, on the screener's run,
       * `security.model` — which wins over whatever default the executor was
       * built with, the same way a step's capabilities win over the
       * operator's permission mode. Absent means "the operator decides": a
       * step that names no model must not be quietly pinned to one here.
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
       * The effort the step asked for, read exactly as `model` above: the
       * step's value wins over the executor's default, absent means the
       * operator decides, and an executor that cannot honour a named level
       * must refuse the run. The level names are the provider's words, so
       * the engine passes this on unread. The screener's run never has one.
       */
      effort?: string;
      /**
       * The step's own `mcp`, `skills` and `plugins`, each only when it named
       * it: absent is "what the workspace gives every step". `mcp` narrows
       * the operator's `agent.mcp` and never widens it; an executor that
       * cannot enforce `skills` or `plugins` must refuse a run that carries
       * it. The screener's run never has one.
       */
      mcp?: readonly McpEntry[];
      skills?: readonly string[];
      plugins?: readonly string[];
      /**
       * How long this run may take, in milliseconds. Always present: the
       * step's own `timeout`, else the workflow's `budget.stepTimeout`, else
       * the engine's default, and the screening run gets the workflow's. The
       * engine also aborts `signal` when it passes, and that is all it does:
       * it does not stop waiting for the run. An executor that honours neither
       * this nor `signal` holds its item until the process dies.
       */
      timeoutMs?: number;
      /**
       * What the step declared it may do — the vocabulary is in
       * `src/conventions.ts`. An executor that cannot enforce one of these
       * must refuse the run rather than drop it: the engine's own check on the
       * worktree afterwards is a backstop, not a licence to ignore this.
       *
       * Absent altogether only on the screener's run, which reads
       * attacker-reachable text for a living: it gets no tool at all, less
       * than any step. Any executor that screens — `security.adapter`'s, or
       * `agent.adapter`'s when that is unset — must honour that, or refuse.
       */
      capabilities?: readonly string[];
      /**
       * Present only for a step that declared `items:create`, and only on a
       * step's own invocation — a conversation turn is never handed one, so a
       * turn cannot create children however it is asked to. An executor that
       * cannot expose a bound create_child tool must refuse a run that carries
       * this, never drop it: the step would report children it had no way to make.
       *
       * `server` is the engine's own item server for this binding, ready to
       * start: an executor loads it under `server.name` and allows exactly
       * `server.tools`. Absent, the engine could not say how to start one, and
       * the run must be refused.
       */
      child?: ChildBinding & { server?: RunServer };
      /**
       * Told each tool call and each thing the agent says as it happens, for
       * the item panel. Optional to honour: an executor that never calls it
       * runs exactly as before, and the panel says it has no live activity.
       * The engine's callback never throws.
       */
      onActivity?: (e: AgentActivity) => void;
      /**
       * Continue `resume` as a new session of its own, leaving the one resumed
       * untouched: a pairing's closing turn, asked for the step's answer on
       * the person's session without adding a turn to it. An executor that
       * cannot fork must refuse a run that asks, never resume in place.
       */
      fork?: boolean;
      signal: AbortSignal;
    },
  ): Promise<{ text: string; sessionId: string | null }>;
  /**
   * The command a person runs in their own terminal to work a step with the
   * agent: a session under `session`, in `cwd`, seeded with the prompt the
   * engine wrote to `promptFile` — or, given `resume`, the agent's own
   * session continued as a fork under `session`, leaving it untouched.
   * `server` is the engine's own, for the tools a person's session may reach
   * Landrace with.
   *
   * The prompt carries item text anyone can write, so it is handed over as
   * a file and goes into `argv` as `{ file: promptFile }`: what a person
   * pastes holds paths and ids, never that text.
   *
   * Optional: an executor without it offers no pairing, and asking for one
   * is refused. Nothing is run here — the person runs what this returns.
   */
  handoff?(opts: { cwd: string; session: string; promptFile: string; resume?: string; server?: RunServer }): Promise<Handoff>;
}

/** A command line for a person to run: each argument its own element, and where to run it. */
export interface Handoff {
  argv: HandoffArg[];
  cwd: string;
}

/** An argument as written, or `{ file }`: that file's contents, read by the person's shell when the command runs. */
export type HandoffArg = string | { file: string };

/**
 * The item-less half of a HookContext, for the two kinds that run before —
 * or without — an item to build a snapshot for.
 */
export type RuntimeContext = Omit<HookContext, "item" | "snapshot">;

/**
 * What an executor factory is built with: the context every hook gets, plus
 * the two things only an executor needs. `dir` is the workspace directory the
 * runtime was built from, which is where a factory finds its repository.
 * `redact` keeps values out of every log line from now on — an executor's
 * setup can hold credentials the configuration never named, such as an MCP
 * server's env, and the log must not print them. A value shorter than the
 * logger will redact by is skipped, never refused: it would match everywhere.
 */
export type ExecutorContext = RuntimeContext & {
  dir: string;
  redact(values: readonly string[]): void;
  /**
   * The workflow's steps, by path, when the runtime has loaded them — so a
   * factory can refuse at startup what a step asks of it and it cannot do,
   * an effort it has no level for, rather than at that step's first run.
   */
  steps?: ReadonlyMap<string, Step>;
};

/**
 * An executor a hook builds from the runtime's context rather than at import.
 * `id` is readable before anything is built, so the loader's duplicate rule
 * and the adapter lookup still work at load. `create` runs once per runtime,
 * at startup, so a setting it cannot use stops the process before the first
 * paid step rather than at it.
 */
export interface ExecutorFactory {
  id: string;
  create(ctx: ExecutorContext): Promise<Pick<Executor, "run" | "handoff">>;
}

/* ------------------------------------------------------------------- kit -- */

/**
 * One MCP server as `.mcp.json` defines it, passed on whole: only what the
 * kit's checks read is named.
 */
export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

/** One `agent.mcp` entry: a server's bare name, or its name and the only tools a step may call on it. */
export type McpEntry = string | { name: string; tools: string[] };

/** `agent.mcp`'s servers, looked up in `.mcp.json`, or why they cannot be. */
export interface ResolvedMcp {
  servers: Record<string, McpServerConfig>;
  tools: Record<string, string[]>;
  problems: Problem[];
}

/** What a write step's commands may reach: the only hosts on the network, and the paths under HOME they may not read. */
export interface SandboxSettings {
  hosts: string[];
  deny: string[];
}

/** `agent:` as the kit and one integration read it: the kit's keys, `mcp` not yet resolved, beside the integration's own `E`. */
export type AgentSettings<E = unknown> = {
  model?: string;
  effort?: string;
  mcp: McpEntry[];
  sandbox: SandboxSettings;
} & E;

/** An executor's own event log, as a hook is handed it. */
export type HookLog = (event: string, data?: Record<string, unknown>) => void;

/**
 * What a kit integration's executor is built from: the `agent:` keys every
 * integration reads, with `agent.mcp` already resolved to the servers
 * `.mcp.json` defines. An integration's own keys ride beside these.
 */
export interface KitSettings {
  /** The operator's model for every run that names none. */
  model?: string | undefined;
  /** The operator's effort for every step and turn; the screener never gets one. */
  effort?: string | undefined;
  /** The servers a declared run may use, by name, as `.mcp.json` defines them. */
  servers: Readonly<Record<string, McpServerConfig>>;
  /** Per server, the only tools a run may call on it; a server absent here allows every tool it has. */
  tools: Readonly<Record<string, readonly string[]>>;
  sandbox: SandboxSettings;
  log?: HookLog | undefined;
  /** A backstop only: the engine gives every run a limit. */
  timeoutMs?: number | undefined;
}

/**
 * What a run may do, from what it declared. `screen` declared nothing, and is
 * the screener's: no tool at all. `read` may not change the repository, and
 * `write` may.
 */
export type Tier = "screen" | "read" | "write";

/** Per MCP server, the tools a run may call on it, or null for every tool it has. */
export type AllowedTools = Record<string, readonly string[] | null>;

/** The step front-matter keys an integration enforces itself, and declares it can; the kit enforces a step's `mcp`. */
export type StepKey = "skills" | "plugins";

/**
 * The three ways a person can pair with an integration's agent. `take`: a
 * session of their own under the id the engine gives, seeded with the step.
 * `continue`: the agent's own session on the stage, carried on under that id.
 * `fork`: Finish's closing turn, asked of the person's session without adding
 * to it. An integration declares the ones it can do, and is refused the rest.
 */
export type PairingKind = "take" | "continue" | "fork";

/**
 * One run, decided and checked by the kit, for an integration to turn into
 * its command line — and nothing it could still get wrong: every value that
 * reaches argv is shaped, the model and effort are chosen, the servers are
 * the ones this run may load.
 */
export interface RunPlan<E = unknown> {
  tier: Tier;
  model?: string;
  effort?: string;
  resume?: string;
  /** Continue `resume` as a session of its own, leaving it untouched. */
  fork: boolean;
  /** Where the run happens, resolved; absent, the engine's own directory. */
  cwd?: string;
  /** The servers the run loads, by name: the allowlisted ones for a step or turn, then the engine's bound one. */
  servers: Record<string, McpServerConfig>;
  /** Per server in `servers`, the tools the run may call on it, or null for every tool it has. */
  allowed: AllowedTools;
  /** The only project skills the run may load, by name; absent, every one. */
  skills?: readonly string[];
  /** The step's own plugins, in place of the integration's default; absent, that default. */
  plugins?: readonly string[];
  sandbox: SandboxSettings;
  /** The integration's own settings. */
  extras: E;
  /** Where `prepare` says what it changed on the way, such as a key it dropped. */
  log?: HookLog;
}

/** A pairing's command, decided and checked by the kit, for an integration to write out. */
export interface HandoffPlan {
  /** `take` when there is no agent session to continue, else `continue`. */
  kind: Exclude<PairingKind, "fork">;
  /** Resolved. */
  cwd: string;
  session: string;
  promptFile: string;
  resume?: string;
  server?: RunServer;
}

/**
 * What one line of an agent's output said, as the integration reads it. Every
 * field is optional: most lines say nothing the run needs.
 */
export interface EventReading {
  /** For the item panel. */
  activity?: Array<Pick<AgentActivity, "kind" | "text">>;
  /** The run's session, as the agent names it. Checked by the kit: a string, or the run is refused. */
  session?: unknown;
  /** The run's answer: the last one read is the run's text. */
  text?: string;
  /** The agent said the run is over, and answered. */
  done?: boolean;
  /** The agent said the run failed, and why: the run is refused with this. */
  error?: string;
  /** Kept out of the log — a tool's result is the files the agent read. */
  quiet?: boolean;
}

/* ---------------------------------------------- kit: tracker, forge, docs -- */

/**
 * Runs git with these arguments and this extra environment, in one checkout,
 * and answers its stdout — stopped when `signal` aborts or `timeoutMs` passes.
 */
export type Git = (
  args: string[],
  env?: Record<string, string>,
  opts?: { signal?: AbortSignal | undefined; timeoutMs?: number | undefined },
) => Promise<string>;

/** Every local branch head, and every head origin had when the checkout last heard from it, by branch name. */
export interface BranchHeads {
  local: Record<string, string>;
  remote: Record<string, string>;
}

/** A comment as a pre hook put it in the snapshot: only what telling ours from a stranger's needs. */
export interface SnapshotComment {
  body?: string;
  user?: { login?: string } | null;
}

/** One comment on a review thread. `author` is null for an account since deleted. */
export interface ThreadComment {
  body: string;
  author: string | null;
}

/** A review thread on a pull request, as a forge integration maps its own answer into it. */
export interface ReviewThread {
  id: string;
  resolved: boolean;
  /** Where in the diff, when the forge can place it at all. */
  path: string | null;
  line: number | null;
  /** The opening comment: the finding itself. */
  first: ThreadComment | null;
  /** The last word, which says whose turn the thread is. */
  last: ThreadComment | null;
  /** How many comments the thread has: more than one means somebody replied. */
  comments: number;
  /** When it was opened, ISO 8601: where it sits in the item's history. Absent where the forge does not say. */
  at?: string | undefined;
}

/**
 * One relationship of an item, as its tracker reports it: of `type`, to the
 * item `to`, with that item's own title, link and state as the same answer
 * gave them — so naming every blocker costs no read per blocker. `to` is an
 * item id the integration chooses for an item elsewhere (another
 * repository): a usable one, never all digits, one per item, and never in
 * another role's node-id form (`pr-<n>`, `spec-<id>`) — that is two roles
 * reporting one id, which halts the whole listing.
 */
export interface RelatedRecord {
  type: string;
  to: string;
  title: string;
  link: string;
  closed: Closed;
  /**
   * True where the tracker said which item it is but not what state it is
   * in — closed for a reason its integration does not map, say. Its
   * `closed` is null, never a guess: drawn as open, and the item's
   * relationships read as not all read.
   */
  unreadable?: true;
  /**
   * Which way it points from the item: `out`, the item relates to `to`, as
   * the edge `item → to`; `in`, `to` relates to the item, as `to → item`.
   * Absent is `out`. Only a type the tracker reads both ways (`readBothWays`)
   * carries `in`.
   */
  direction?: "in" | "out" | undefined;
  /** The related item's status, by name, and its category, where its tracker keeps one: `node.state.status` and `statusCategory` on its placeholder. */
  status?: string | undefined;
  statusCategory?: string | undefined;
}

/**
 * Every open item's relationships of one type, as the blocker walk reads
 * them: which items are open, each one's edges to items it relates to that
 * are still open by its own record, and the open items whose relationships
 * could not all be read. A tracker answers it from its full list unless it
 * has a cheaper way to ask; one it could not finish is a refusal, never a
 * shorter answer.
 */
export interface OpenRelations {
  open: string[];
  edges: Array<{ from: string; to: string }>;
  /** Open items whose relationships of the type were cut short or held one that could not be read. */
  partial: string[];
}

/**
 * An item as a tracker integration reads it: `itemNode`'s fields, and the
 * item it is a child of. `priority` is set by a tracker with a priority
 * field of its own (the in-memory one's, say), and then wins over any
 * `P0`..`P9` label; absent, the labels say.
 */
export interface ItemRecord {
  id: string;
  title: string;
  link: string;
  closed: Closed;
  labels: string[];
  assignees: string[];
  body: string;
  author: string | undefined;
  /** Who last edited the body, or undefined if nobody has since it was opened. */
  editor: string | undefined;
  createdAt: string | undefined;
  /** Optional, so an integration whose tracker cannot say still compiles. */
  updatedAt?: string | undefined;
  parent: string | null;
  priority?: number | null | undefined;
  /** Its relationships beside the parent, each outgoing unless it says `in`: absent from a tracker that reads none. */
  related?: RelatedRecord[] | undefined;
  /**
   * Its status by name, and the status's category, where its tracker keeps a
   * status beside the stage label: `node.state.status` and
   * `node.state.statusCategory`. Absent where it keeps none, or did not say.
   */
  status?: string | undefined;
  statusCategory?: string | undefined;
  /**
   * False when `related` is not the whole of them: the tracker's list stopped
   * before its end, or held one it could not read. Absent is whole.
   */
  relatedComplete?: boolean | undefined;
  /**
   * The issue fields asked for in `trackerFields`, by id, as `node.state.fields`
   * carries them: an option as its value, a multi-select as a list of values,
   * a user as an account id, text as text, a number as a number, empty as
   * null. A field not read is left out, never null: not read is not empty.
   */
  fields?: Record<string, Json> | undefined;
}

/**
 * A pull request as a forge integration reads it: `pullNode`'s fields, and
 * the items it is tied to beside the one its head on the item branch is for —
 * none, for the forges landrace ships: what a pull request's own text says it
 * closes ties nothing, since anybody can write that, from a fork too.
 * `branch` is undefined for a fork's.
 */
export interface PullRecord {
  number: number;
  title: string;
  link: string;
  merged: boolean;
  closed: boolean;
  headSha: string;
  /**
   * Whether it conflicts with the branch it merges into; null while the forge
   * is still working that out, which `pullNode` leaves off the node.
   */
  conflicts: boolean | null;
  branch: string | undefined;
  createdAt: string | undefined;
  /** Optional, as `ItemRecord`'s is. */
  updatedAt?: string | undefined;
  items: string[];
}

/**
 * One entry in an item's history, rendered by the role it came from: a
 * comment by the tracker, a review thread by the forge. `at` is ISO 8601 and
 * orders the one timeline; an entry whose time is unknown carries "" and
 * sorts first.
 */
export interface HistoryItem {
  at: string;
  text: string;
}

/**
 * What a `tracker.create` asks a tracker to file: an issue in another of its
 * projects, linked to the item it is filed for. The title, body and fields
 * are already escaped; `marker` is the effect's, stamped on the issue as who
 * created it, so a crash between filing it and recording it never files two.
 */
export interface CreateRequest {
  project: string;
  title: string;
  body: string;
  /** Field id → text, from a route's `fieldsFrom`: written in the same request. Absent when nothing is mapped, or every mapped answer was empty. */
  fields?: Record<string, string> | undefined;
  item: string;
  marker: string;
}

/** One effect type's two halves, side by side, as a role's `effects()` table carries them. */
export interface EffectHandler {
  satisfied(snapshot: Snapshot, effect: Effect): boolean;
  apply(effect: Effect, ctx: HookContext): Promise<void>;
}

/** Effect type → its handler. A role's own, which a subclass extends by spreading `super.effects()`. */
export type EffectTable = Record<string, EffectHandler>;

/** Briefing key → what reads it: `{brief.project.<key>}`, or `{brief.spec.<key>}` for docs. */
export type BriefTable = Record<string, (ctx: HookContext) => Promise<string>>;

/** What `compose` builds a project's hooks from: a tracker always, and a forge and a docs integration when the project has them. */
export interface Roles {
  tracker: BaseTracker;
  forge?: BaseForge | undefined;
  docs?: BaseDocs | undefined;
}

/**
 * What `compose` hands back, for a hook file to export as it stands: one of
 * each item-side kind under the id `project`, and the docs role's artifact
 * as `spec` — which also sorts it after `pre`, and the loader files a
 * module's exports in name order.
 */
export interface ComposedHooks {
  preflight: Preflight;
  source: Source;
  operator: Operator;
  pre: PreHook;
  post: PostHook;
  spec?: ArtifactHook;
}

/**
 * What a pull request node says of its threads: how many are unresolved, how
 * many of those await a fix, and how many of those are not the reviewer's own
 * wording findings — a person's, or a finding that changes behaviour (#71).
 */
export interface ThreadCounts {
  openThreads: number;
  awaitingFix: number;
  awaitingBehaviourFix: number;
}

/** A pull request's checks on its head commit. `none`: nothing is configured to check it — or nothing has started yet. */
export type CheckState = "pending" | "success" | "failure" | "none";

/** One failed check: its name, and the tail of its log — null when the forge would not give it. */
export interface FailedCheck {
  name: string;
  log: string | null;
}

/**
 * A pull-request node's CI state: the state for reading, and the two counts
 * relationships sum — and, read beside them on the same head, whether a named
 * external reviewer has still to finish.
 */
export interface CheckCounts {
  checks: CheckState;
  ciPending: number;
  ciFailed: number;
  reviewPending?: number;
}

/**
 * What every forge on the kit's base takes, beside its vendor's own options.
 *
 * `reviewers`: the external reviewers a workflow waits on, each by the
 * status it posts on the head — a commit status's name, or a check run's.
 * Each is left out of `checks`, and the pull request node's `reviewPending`
 * is 1 while any of them is missing or still running on the head.
 *
 * `pull`: the text a pull request opens with. `title` formats `{item}` and
 * `{title}`; `description` is a template file under `.landrace/`, filled with
 * `{item}`, `{link}` and `{spec}`. Set on open only, never rewritten.
 */
export interface ForgeOptions {
  reviewers?: Array<{ status: string }> | undefined;
  pull?: { title?: string | undefined; description?: string | undefined } | undefined;
}

/** What a merge guarded by a head SHA answered: merged (now or already), or refused because the head moved. */
export type MergeAnswer = "merged" | "moved";

/** One finding a review step reported, on a file and a line. */
export interface Finding {
  file: string;
  line: number;
  body: string;
  /** True when fixing it changes only docs or code comments: the finding's marker says so, and fastlane's review budget reads it. */
  wording?: boolean;
}

/** One reply a step posts on a review thread, by the thread's id. */
export interface Reply {
  thread: string;
  body: string;
}

/** One file of a pull request's diff. `patch` is absent for a binary file, or one too large for the forge to show. */
export interface ChangedFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string | undefined;
  /** The path it had before, for a rename: a protected path renamed away is a protected path changed. */
  previous?: string | undefined;
}

/**
 * What a pull request changes, and whether that is all of it: `complete` is
 * false when the forge's list stopped before its end — its own cap, or a
 * page bound — so a check over the list knows there was more it never saw.
 */
export interface ChangedFiles {
  files: ChangedFile[];
  complete: boolean;
  /**
   * True when the list is not whole only because the forge is still working
   * it out — a count not computed yet on a pull request just opened — which
   * asking again settles. A list cut at a cap or a page bound is not that:
   * asking again cuts it the same way.
   */
  settling?: boolean | undefined;
}

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
  check(ctx: PreflightContext): Promise<void>;
}

/**
 * A preflight's context: the runtime's, and what the loaded workflows' steps
 * declare, so a check can skip what nothing asks for — a child's issue type
 * where no step may create one. Absent when the caller cannot say, which a
 * check reads as anything declared.
 */
export type PreflightContext = RuntimeContext & {
  /** Every capability any step of a loaded workflow declares. */
  capabilities?: ReadonlySet<string> | undefined;
  /** Project → the field ids a loaded route's `tracker.create` there fills from its answer (`fieldsFrom`). */
  createFields?: ReadonlyMap<string, ReadonlySet<string>> | undefined;
  /** Field id → every value a `tracker.field` of a workflow loading this preflight, in an on_enter or a route, sets it to. */
  fieldValues?: ReadonlyMap<string, readonly TrackerFieldValue[]> | undefined;
};

/**
 * Where the work comes from. A tick has to enumerate items before it has one
 * to build a snapshot for, so this cannot be a pre hook: a pre hook is handed
 * the item it is describing.
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
   * answered from this, without a read per item. Each item node carries
   * its labels and assignees in `state`, because that is what those three ask.
   */
  list(ctx: RuntimeContext): Promise<Graph>;
  /** One item's neighbourhood — itself, its ancestors, its descendants and every related node — on every converge pass. */
  read(id: string, ctx: RuntimeContext): Promise<Graph>;
  /**
   * Prompt text about this item, asked for only when a step's prompt names
   * `{brief.<source id>.<key>}` — and only the `keys` it names, or every key
   * when absent.
   */
  brief?(ctx: HookContext, keys?: ReadonlySet<string>): Promise<Record<string, string>> | Record<string, string>;
  /**
   * The remote branch's head: origin's commit on `branch`, brought into this
   * checkout first — its remote-tracking ref — or null when origin has no
   * such branch. Asked before every step on a branch, so the step's worktree
   * starts from what origin has — a person's push, the forge's "Update
   * branch" — and the head its record carries is the one it was shown. A
   * throw is an outage: said, and the step waits for the next tick. Absent,
   * on a source with no remote behind it, nothing is asked.
   */
  remoteHead?(branch: string, ctx: RuntimeContext): Promise<string | null>;
}

/* `| undefined` throughout, because exactOptionalPropertyTypes is on and these
 * are fed straight from Zod, whose optional output includes it. */
export interface NewItem {
  title: string;
  body?: string | undefined;
  labels?: string[] | undefined;
  /** The item this one is a child of. The hook links it with its tracker's own parent relation. */
  parent?: string | undefined;
  /**
   * Set only by the runner, for a child a step created. The hook appends it as
   * a trailing marker under its own login, which is what lets a later round of
   * the same stage find — and drop — what this round made.
   */
  origin?: Origin | undefined;
  priority?: number | undefined;
  /** Relationships to make from it once it exists: `{ type: "blocked-by", item: "10" }`. */
  relate?: ItemRelation[] | undefined;
}

/**
 * Who a created child belongs to, fixed by the runner before the agent starts.
 * The agent names a title and a body; it never names these, so it cannot file
 * a child under another item, stage or round.
 */
export interface ChildBinding {
  parent: string;
  stage: string;
  round: number;
}

/** How to start a process the engine owns: a binary and its arguments, each its own argv element. */
export interface ServerCommand {
  command: string;
  args: string[];
}

/**
 * An MCP server the engine hands an executor to start for one run, described
 * in full so the executor hands it over without knowing what it is: the
 * command, the name to load it under, and the only tools a run may call on it.
 */
export interface RunServer extends ServerCommand {
  name: string;
  tools: string[];
}

/** What the agent may say about a child it creates, and nothing more. */
export interface NewChild {
  title: string;
  body?: string | undefined;
  priority?: number | undefined;
  /** Sibling sub-items it waits on, say: `{ type: "blocked-by", item: "<sibling id>" }`. Shape-checked, then the hook's. */
  relate?: ItemRelation[] | undefined;
}

/** One relationship asked for by hand: its type, and the item at the other end. */
export interface ItemRelation {
  type: string;
  item: string;
}

/** One relationship to make or remove, as the operator tool writes its two lists in turn. */
export interface RelationWrite extends ItemRelation {
  verb: "relate" | "unrelate";
}

export interface ItemPatch {
  title?: string | undefined;
  body?: string | undefined;
  state?: "open" | "closed" | undefined;
  addLabels?: string[] | undefined;
  removeLabels?: string[] | undefined;
}

/**
 * Writes an operator asks for by hand, from the MCP plane.
 *
 * Creating an item is deliberately not an effect, and it must not become one.
 * Every effect needs a `satisfied()` beside its `apply()`, and "this item has
 * already been created" has no derived evidence to read — there is no item
 * yet to look at. An effect without a meaningful `satisfied()` is re-applied on
 * every tick, which here would mean a duplicate item per tick, forever. So
 * creation is something a person asks for, never something the tick plans.
 *
 * Optional: with no operator hook loaded, the create and update tools report
 * that none is configured. They do not crash, and they do not silently no-op.
 */
export interface Operator {
  id: string;
  createItem(input: NewItem, ctx: RuntimeContext): Promise<Node>;
  updateItem(item: string, input: ItemPatch, ctx: RuntimeContext): Promise<Node>;
  /** The relationship types it can write: what `relate` and `unrelate` take. */
  relates(): string[];
  /** Relate `item` to `other` as `type` — `#12` blocked by `#10` is `relate("12", "blocked-by", "10")`. */
  relate(item: string, type: string, other: string, ctx: RuntimeContext): Promise<void>;
  unrelate(item: string, type: string, other: string, ctx: RuntimeContext): Promise<void>;
  /**
   * Why `relate` or `unrelate` of these would be refused — a type it does not
   * write, the other end no item of its own it can read, whatever its tracker
   * refuses — or null. Asked of every entry before the first write, so a list
   * with one refused entry is refused having written none of it. The reason
   * alone: the caller says what it asked.
   */
  checkRelate(item: string, type: string, other: string, ctx: RuntimeContext): Promise<string | null>;
}

/**
 * What a notifier is told when an item has come to rest waiting on a person.
 * No kind beyond `event`: the stage and why say which stop it is. `why` is the
 * board's own note for the item, and `board` the page's URL when one runs.
 */
export interface NotifyEvent {
  event: "needs-you";
  item: string;
  /** The workflow whose item it is: its folder under `workflows/`, and its `name`. */
  workflow: string;
  workflowName: string;
  title: string;
  link: string;
  stage: string | null;
  why: string;
  board: string | null;
}

/**
 * Tells a person somewhere else — a chat, a pager. Fire-and-forget: a send
 * that fails is logged and nothing else, so a notifier can never stop an
 * item, and nothing about what was sent is kept.
 */
export interface Notifier {
  id: string;
  send(event: NotifyEvent, ctx: RuntimeContext): Promise<void>;
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
  executors: Map<string, Executor | ExecutorFactory>;
  /** By id: `notify.via` names them. */
  notifiers: Map<string, Notifier>;
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
  | "item.evaluated" | "item.skipped" | "item.aborted"
  | "step.invoked" | "step.started" | "step.finished" | "step.completed" | "step.rejected" | "step.unchecked"
  | "agent.event"
  | "worktree.setup.started" | "worktree.setup.finished" | "worktree.setup.failed"
  | "snapshot.built" | "snapshot.failed"
  | "effect.planned" | "effect.applied" | "effect.discarded" | "effect.failed"
  | "lock.acquired" | "lock.released" | "lock.denied" | "lock.stolen"
  | "screen.passed" | "screen.blocked" | "screen.cleared" | "screen.skipped"
  | "display.failed"
  | "source.failed"
  | "wake.failed"
  | "notify.sent" | "notify.failed";

export interface LandraceEvent {
  name: EventName;
  item?: string;
  [key: string]: unknown;
}

export type Logger = (name: EventName, data?: Record<string, unknown>) => void;

/** What `telemetrySettings` resolves `LANDRACE_ENABLE_TELEMETRY` and the `OTEL_*` settings to. */
export interface TelemetrySettings {
  exporter: "otlp" | "console";
  protocol: "http/protobuf" | "http/json";
  /** The collector's base URL; `/v1/logs` is appended to it. */
  endpoint: string;
  headers: Record<string, string>;
  /** `OTEL_RESOURCE_ATTRIBUTES`, with `service.name` always set. */
  resource: Record<string, string>;
  intervalMs: number;
}

/** A logger's `exporter`, shipping each event to a collector as an OTel log record. */
export interface OtelSink {
  sink(e: LandraceEvent): void;
  /** Flushes what is queued. Never rejects: it runs in a `finally`. */
  shutdown(): Promise<void>;
}

/**
 * The engine's logger, which can be told about more secrets after it was made.
 * `scrub` applies that same live set to text that leaves the process outside
 * the logger — a tick row on stdout, a record body on the tracker — so there
 * is one redaction set, not one per exit. `extra` joins the set for that one
 * call, in the same pass: redacting a second set after the first lets a value
 * in one split a longer value in the other before it can match whole.
 */
export type RedactingLogger = Logger & {
  redact(values: readonly string[]): void;
  scrub(text: string, extra?: readonly string[]): string;
};

export type LockKind = "tick" | "conversation" | "execution" | "goto" | "pair";

export interface Held {
  item: string;
  holder: string;
  kind: LockKind;
  pid: number;
  /** When the holder last said it was still working, not when it started. */
  at: number;
  deadlineMs: number;
  /**
   * One acquisition, told apart from every other. A pid and a holder string
   * are both shared by two converges of the same item in the same process —
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
   * this bounds how long a holder that has gone silent keeps an item.
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
 *   forever, with nothing ever left on the item for anyone to see. It is
 *   recorded under REFUSED_KIND rather than the contract's MALFORMED_KIND,
 *   which is what `run.lastRefused` reads back.
 */
export type StepResult =
  | { ok: true; effects: Effect[]; sessionId: string | null }
  | { ok: false; kind: "contract" | "unavailable" | "refused"; reason: string };

export interface ConvergeDeps {
  workflow: Workflow;
  /** Read first on every pass: the item's node, its graph and its `rel` counts are what everything after it decides from. */
  source: Source;
  /**
   * Where the repository is, when steps are to run in a per-item worktree of
   * it (`agent.isolation: worktree`). Absent means the agent runs wherever the
   * loop runs — the operator's own checkout — and the capability check has
   * nothing it may judge, because what changed there is not the step's doing.
   */
  sandbox?: Sandbox;
  steps: Map<string, Step>;
  /**
   * The workflow's `budget.stepTimeout`, for a step that names no `timeout` of
   * its own. Absent, the engine's own default applies: every run is given a
   * limit.
   */
  stepTimeoutMs?: number;
  pre: PreHook[];
  /**
   * Asked for a briefing when — and only when — a step is about to be
   * invoked. Optional, and an absent list simply leaves a `{brief.…}`
   * placeholder visible in the prompt, the same as any other unknown path.
   */
  artifacts?: ArtifactHook[];
  dispatcher: Dispatcher;
  executor: Executor;
  screen?: Screener;
  ctx: Omit<HookContext, "snapshot">;
  log: Logger;
  /**
   * The runtime logger's `scrub`, for a record body composed outside the
   * logger and posted where anyone reading the item sees it: it carries
   * what an executor registered through `redact` after startup, which the
   * secrets on `ctx` never named. Converge hands it those secrets as `extra`,
   * so both sets are redacted in one pass — never one instead of the other.
   */
  scrub?: (text: string, extra?: readonly string[]) => string;
  maxPasses?: number;
  /**
   * How to start this process as `landrace mcp` on the workflow directory,
   * for an `items:create` step's item server. Absent, such a step is handed
   * no server and its executor refuses it.
   */
  childServer?: ServerCommand;
  /** Where a step's activity is kept for the item panel. Absent, none is. */
  activity?: ActivityLog;
  /**
   * Handed the snapshot an item came to rest on after a transition. Injected
   * rather than imported: the rule reads the status rows, which import the
   * tick, which imports converge.
   */
  notify?: (snapshot: Snapshot) => void;
  /**
   * The commit a step on `branch` starts at, for a world with no repository
   * to cut a worktree from — the harness's, where a branch is a pull
   * request's head. Never asked when there is a `sandbox`: then the
   * worktree's own commit is what a step's record carries.
   */
  startedAt?: (branch: string) => Promise<string | null>;
}

export interface ConvergeResult {
  passes: number;
  settled: "wait" | "halt" | "terminal" | "cap";
  /** Set on "wait" and "halt": which of several possible causes this was, so a caller does not have to re-derive it from the log stream. */
  why?: string;
}

export interface StatusRow {
  item: string;
  /** The workflow that owns it; absent for an item no one workflow owns. */
  workflow?: string;
  title: string;
  stage: string | null;
  note: string;
  /**
   * The engine's own note, where `note` is the stage's `note` rendered over
   * it: what the lane, a Retry and a shield are decided from. A workflow
   * writes its note for a person to read, and "blocked by #10" begins as a
   * halt's own note does.
   */
  engineNote?: string;
}

/**
 * One converge in flight, by item id. Shared across ticks, which overlap: the
 * tick that lists an item closed, turned away, or claimed by some other
 * workflow stops the run an earlier tick started.
 */
export interface RunningItem {
  controller: AbortController;
  /** The workflow it runs under, so the next listing can tell whether that is still the item's owner. */
  workflow: string;
  /** Whether it started on a closed item: a close stops a run, unless the item was closed when it started. */
  closed?: boolean | undefined;
  /**
   * Settles once the converge has unwound and let go of the item's lock. A
   * tick that moved the item to another workflow waits on it, so the new
   * owner works it in that same tick and never beside the old one.
   */
  done: Promise<void>;
}

/** Where the workspace tick last knew an item to be: under which workflow, at which stage. */
export interface SeenAt {
  workflow: string;
  stage: string;
}

/** Every distinct source, listed once per tick, and who owns what it listed. */
export interface WorkspaceListing {
  /** One per distinct source, by identity; a source whose `list` failed has an empty graph here and an entry in `failed`. */
  graphs: Graph[];
  /** Workflow id → the index of its source's graph. */
  sourceOf: Map<string, number>;
  claims: Claims;
  /** Source index → why its `list` failed. Its items are neither worked nor stopped that tick: nothing is known about them. */
  failed: Map<number, string>;
}

export interface WorkspaceTickOptions {
  runtime: WorkspaceRuntime;
  lock?: LockOptions;
  /**
   * Everything the tick listed, eligible or not, and the claims made of it.
   * For a display: handing over what the tick already fetched costs nothing,
   * and asking the sources again would double the tracker traffic of every tick.
   */
  onList?: (listing: WorkspaceListing) => void;
}

export interface TickRow {
  item: string;
  /** The workflow that worked it; absent for an item no one workflow owns. */
  workflow?: string;
  outcome: string;
}

export type Eligibility = { eligible: true } | { eligible: false; reason: string };

/** One workflow of a workspace, and which of the listed graphs is its source's. */
export interface ClaimInput {
  id: string;
  workflow: Workflow;
  source: number;
  /** Whether it has a `closed: run` stage: only such a workflow claims a closed item. */
  closedRun?: boolean | undefined;
}

/** Which workflow owns each open item; every other outcome is named, never picked. */
export interface Claims {
  owner: Map<string, string>;
  /**
   * Which workflow owns each closed item one claims — one with a `closed: run`
   * stage, by its eligibility. Two halt in `conflicts`, as an open item's do;
   * one no such workflow claims is in no map at all.
   */
  closed: Map<string, string>;
  conflicts: Map<string, string[]>;
  clashes: Map<string, string[]>;
  unclaimed: Map<string, string[]>;
}

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
  /** What the item's node, graph and `rel` counts are read from on every pass. */
  source: Source;
  pre: PreHook[];
  post: PostHook[];
  artifacts?: ArtifactHook[];
  /** What each stage's step answers. A stage that is invoked with nothing scripted is a gap, and says so. */
  answers?: { [stage: string]: ScriptedAnswer };
  /**
   * What the prompt screener answers for each stage's step — a fenced json
   * verdict, as the real one writes, given the screening's nonce unless it
   * names one of its own. Absent, nothing is screened. Present, a
   * stage with no answer here is a screener that could not run, which is a
   * refusal: the same fail-closed reading the engine gives a real one.
   */
  screen?: { [stage: string]: ScriptedAnswer };
  item?: string;
  /**
   * The context's configuration, as landrace.yaml would give it — `branch`,
   * say, for a workflow on `lr-{item}`. Absent, none: every default holds.
   */
  config?: Partial<RuntimeConfig>;
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
  /** Handed to converge as-is — see `ConvergeDeps.notify`. */
  notify?: (snapshot: Snapshot) => void;
  /**
   * The commit a step on `branch` starts at, as a worktree cut now would
   * start: there is no repository here, so a test says — the pull request's
   * head, usually. Absent, no step's record carries one. See `ConvergeDeps.startedAt`.
   */
  startedAt?: (branch: string) => string | null;
}

export interface Harness {
  /** One converge, as the daemon would run it. */
  converge(): Promise<HarnessRun>;
  /** Every position the item has passed through, across every call, repeats collapsed. */
  trail(): string[];
  /** Every invocation, across every call. */
  calls(): StepCall[];
  /** How many times each stage's step has run. */
  counts(): { [stage: string]: number };
}

/** An item as the in-memory tracker holds it. */
export interface ExternalItem {
  id: string;
  title: string;
  body: string;
  labels: string[];
  /**
   * Who the item belongs to, as logins. A list, because a tracker's is a
   * list — and because that is what lets several instances share one
   * repository, each taking only what is assigned to it.
   */
  assignees: string[];
  comments: TrackerComment[];
  /** Lower is more urgent; null is unprioritised, never zero. */
  priority: number | null;
  /** The item this one is a child of, by id. */
  parent: string | null;
  closed: Closed;
  /** Who opened it, as a login. */
  author: string;
  /**
   * What it relates to, by id. The related item's title, link and state are
   * read from its own row when there is one, so closing it shows; otherwise
   * from here — an item this tracker does not hold.
   */
  related: ExternalRelation[];
  /** False to read its relationships as cut short, the way a tracker's paged list can stop. */
  relatedComplete: boolean;
}

/** One relationship an in-memory item has, as a test seeds it. */
export interface ExternalRelation { type: string; to: string; title?: string; link?: string; closed?: Closed; unreadable?: true }

/** A pull request as the in-memory tracker holds it: live and mutable, so a test moves it the way a person on the tracker would. */
export interface ExternalPull {
  /** The node id, `pr-<number>`. */
  id: string;
  number: number;
  /** The item it implements. */
  item: string;
  merged: boolean;
  openThreads: number;
  /** Of `openThreads`, how many await a fix: every one whose last word is not the fixer's answer. */
  awaitingFix: number;
  /** Of `awaitingFix`, how many are the reviewer's wording findings; the rest it reports as `awaitingBehaviourFix`. */
  awaitingWordingFix: number;
  closed: Closed;
  /**
   * The branch it was opened from: what `pull.open` looks a pull request up
   * by, and — on the item branch the context configures — what ties it to an
   * item. The item branch of the item it was added for, unless the test says:
   * `config.branch` as `createExternalState` was given it, or `landrace/{item}`.
   */
  branch?: string;
  /**
   * The items it names beside its head, as a forge that tied by text would
   * report them. A test's seed only: the shipped forges name none, since
   * anyone can write `Closes #7` — from a fork too.
   */
  items?: string[];
  /** Of `openThreads`, how many a review step raised: the only ones its `resolved` may close. */
  raised?: number;
  /** The markers of the reviews `pull.review` posted, so a round is posted once. */
  reviews?: string[];
  /** The head commit, `sha-<number>` unless a test says: what a merge is guarded by, and what a push moves. */
  headSha: string;
  /** Its checks on that head, `none` unless a test says. */
  checks: CheckState;
  /** The checks that failed, with their logs: what `failedChecks` answers. */
  failed: FailedCheck[];
  /** False: the forge will not merge it — a conflict, or a rule of its own — and `merge` refuses, as a real one does. */
  mergeable?: false;
  /** Whether it conflicts with the default branch, false unless a test says; null is the forge still working it out. */
  conflicts?: boolean | null;
  /**
   * What it changes, file by file: none unless the test says. Once a test
   * says, a review's findings are placed on it as `placeFindings` places them;
   * until then, every well-formed finding opens a thread.
   */
  files?: ChangedFile[];
  /** False: the forge's list of `files` stopped before its end, as a vendor's cap stops one. */
  filesComplete?: false;
  /** The named reviewers' statuses on the head, by name: absent is not posted yet. */
  reviewerStatuses?: Record<string, "running" | "finished">;
  /** The title and description `pull.open` opened it with, when it did. */
  opened?: { title: string; description: string | undefined };
}

/** What a test may set on a pull request it opens in memory; everything else is defaulted. */
export type ExternalPullSeed = Partial<Pick<
  ExternalPull,
  "merged" | "openThreads" | "awaitingFix" | "awaitingWordingFix" | "closed" | "branch" | "items" | "headSha" | "checks" | "failed" | "mergeable" | "conflicts" |
  "files" | "filesComplete" | "reviewerStatuses" | "opened"
>>;

/**
 * An in-memory stand-in for a tracker, speaking the conventions and no
 * vendor's dialect at all.
 *
 * It is not a second copy of any integration — a real one's hooks are tested
 * over a fake HTTP boundary, which is the only honest way to test *them*. This is what a workflow author has before any integration exists: a
 * place for the labels, the records and the human turns to live, so the graph
 * can be driven and its loops watched.
 *
 * Its hooks are `compose`'s, over the in-memory tracker, forge and docs.
 */
export interface ExternalState extends ComposedHooks {
  /** The in-memory docs role's spec page: published, read back and briefed like any docs integration's. */
  spec: ArtifactHook;
  /**
   * Open a pull request for `item`, from its item branch — `config.branch`, or `landrace/{item}` — unless the test names another; returns
   * its node id, `pr-<n>`, numbered from 1 in creation order. `awaitingFix` defaults to `openThreads`: a
   * thread nobody has answered awaits a fix. Its head is `sha-<n>` and its checks `none`, unless the test says.
   */
  openPull(item: string, pr?: ExternalPullSeed): string;
  /** Every branch a `branch.push` was applied for, in order: there is no repository here to push to. */
  pushes(): string[];
  /** The live record behind a pull request node, for a test to merge, close or comment on. */
  pull(id: string): ExternalPull;
  item(id: string): ExternalItem;
  /** Every row whose `parent` is this id, a test helper for asserting on what a step created. */
  children(parent: string): ExternalItem[];
  comments(id: string): string[];
  entriesOf(id: string): Entry[];
  /** Where the item sits, as the engine would read it: out of a label. */
  stage(id: string): string | null;
  label(id: string, label: string): void;
  unlabel(id: string, label: string): void;
  /** A person says something, under their own name, so it reads as a human turn. */
  say(id: string, text: string): void;
  /**
   * Every write the tracker was asked for, in order, as `<operation> #<id>` —
   * refused ones too, when it is read-only. A person's moves through the
   * helpers above are the world changing, and are not in it.
   */
  writes(): string[];
  /** Every issue a `tracker.create` filed in another project, in order. */
  filed(): FiledIssue[];
}

/** An issue the in-memory tracker filed in another project: never one of its items, and unlabelled. */
export interface FiledIssue extends CreateRequest {
  key: string;
  labels: string[];
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
export type Verdict = { verdict?: unknown; nonce?: unknown; reason?: unknown };

/* ------------------------------------------------------------------- mcp -- */

/** One workflow of the workspace, as `landrace_workflows` says it. */
export interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
  /** Whether it loads an operator, so `landrace_create_item` can start an item in it. */
  creates: boolean;
  /** The open items it alone claims. */
  claimed: number;
  /** Of those, the ones in the Needs you lane. */
  needsYou: number;
}

/**
 * One open item as `landrace_items` lists it: the workflow that claims it, or
 * null with why for one no single workflow may work — claimed by two, or
 * reported by two sources — in `landrace status`'s words. A list of one
 * workflow's items carries the halts that workflow is party to.
 */
export interface ItemSummary {
  item: string;
  title: string;
  workflow: string | null;
  stage: string | null;
  lane: Lane;
  why?: string;
}

/** An item waiting on a person, with the workflow that claims it — or null, and why. */
export interface WaitingItem {
  item: string;
  title: string;
  url: string;
  workflow: string | null;
  why?: string;
}

export interface Tools {
  /** The one workflow this server acts for (`--workflow`), or null for every workflow. */
  readonly scope: string | null;
  workflows(): Promise<WorkflowSummary[]>;
  // `| undefined` is explicit because exactOptionalPropertyTypes is on and these
  // are fed straight from Zod, whose optional output includes it.
  items(input?: { workflow?: string | undefined }): Promise<ItemSummary[]>;
  waiting(input?: { workflow?: string | undefined }): Promise<WaitingItem[]>;
  status(item: string): Promise<unknown>;
  createItem(input: {
    /** Which workflow to start it in; needed when more than one can create items. */
    workflow?: string | undefined;
    title: string;
    body?: string | undefined;
    labels?: string[] | undefined;
    start?: boolean | undefined;
    /** Relationships to make from it once it exists; all refused, and nothing written, when any is. */
    relate?: ItemRelation[] | undefined;
  }): Promise<unknown>;
  updateItem(
    item: string,
    input: {
      title?: string | undefined;
      body?: string | undefined;
      state?: "open" | "closed" | undefined;
      addLabels?: string[] | undefined;
      removeLabels?: string[] | undefined;
      relate?: ItemRelation[] | undefined;
      unrelate?: ItemRelation[] | undefined;
    },
  ): Promise<unknown>;
  reply(item: string, message: string): Promise<unknown>;
  goto(item: string, stage: string): Promise<unknown>;
  /** A goto that also clears the step it sends to of the security check, for that round alone. Absent a stage, the one refused. */
  clear(item: string, stage?: string | undefined): Promise<unknown>;
  ask(item: string, message: string, opts?: { signal?: AbortSignal }): Promise<unknown>;
  resolve(item: string, why?: string | undefined): Promise<unknown>;
  /** What may be paired on now, and the pairing open, if any. */
  pairing(item: string): Promise<unknown>;
  pair(item: string, stage: string): Promise<unknown>;
  finish(item: string, note?: string | undefined): Promise<unknown>;
  release(item: string): Promise<unknown>;
}

/** The one tool a step that may create children is handed, already bound. */
export interface ChildTool {
  createChild(input: NewChild): Promise<{ item: string; title: string; link: string }>;
}

/**
 * One workflow of the workspace as the MCP tools are handed it: its folder,
 * its definition, the hooks it loads, and what holds a turn on its steps.
 *
 * The executor and the screener are its own because a factory is built
 * against the steps of the workflow it serves (see `executorFor`). Both are
 * optional — without an executor the conversation tools report that none is
 * configured rather than crashing, exactly as the operator hook's absence is
 * reported, and screening is the operator's `security.screen` to switch off.
 */
export interface ToolWorkflow extends LoadedWorkflow {
  registry: Registry;
  executor?: Executor;
  screen?: Screener;
  /**
   * How to start `landrace mcp` bound to this workflow: a pairing hands it to
   * the person's session, and a hand-in on an `items:create` step binds its
   * item server from it. Absent, a pairing's session gets no server.
   */
  server?: ServerCommand;
}

/**
 * One workflow's own hands in `landrace mcp`: what an action on an item it
 * claims goes through — its source, pre hooks and dispatcher, the stages and
 * steps a goto or a pairing is held to, and the conversation a turn is.
 */
export interface ToolHands {
  workflow: ToolWorkflow;
  deps: PairDeps;
  conversation: Conversation;
}

/** What the MCP plane shares across every workflow it serves. */
export interface ToolOptions {
  /** Where the per-item locks live: the loop's, so the two processes find the same file. */
  lock?: LockOptions;
  sandbox?: { root: string };
  /** Where a turn's activity goes, so the loop's page shows an Ask asked here too. */
  activity?: ActivityLog;
  /**
   * Told after each write a person makes through the tools succeeds, so a
   * running loop picks it up now rather than on its next scheduled tick.
   * Absent where nothing should drive the loop — the child server an agent
   * is handed gets none.
   */
  wake?: () => void;
  /**
   * `landrace mcp --workflow <id>`: the one workflow this server acts for —
   * the server a pairing hands the person's session. Claims are still judged
   * over every workflow; an item another workflow claims is refused, and a
   * create names this workflow unasked.
   */
  scope?: string;
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

/** One workflow of the workspace, assembled: what a converge of an item it owns is handed. */
export interface WorkflowRuntime {
  /** Its folder under `workflows/`. */
  id: string;
  name: string;
  description: string;
  /** Where its items come from. Two workflows loading one hook module share this object, and the tick lists it once. */
  source: Source;
  /** `scrub` required here: the rows `landrace start` prints go through it too. */
  deps: Omit<ConvergeDeps, "ctx" | "scrub"> & { ctx: RuntimeContext; scrub: (text: string, extra?: readonly string[]) => string };
}

/**
 * What listing a workspace, and judging who owns what it lists, asks of each
 * workflow: its id, its source and its rules. `landrace mcp` lists through the
 * same functions the loop does with no more than this.
 */
export type ListedWorkflow = Pick<WorkflowRuntime, "id" | "source"> & { deps: Pick<WorkflowRuntime["deps"], "workflow"> };

/** Everything the loop needs, assembled once, so a tick is only a call. */
export interface WorkspaceRuntime {
  dir: string;
  /** In the workspace's order. */
  workflows: WorkflowRuntime[];
  /**
   * Assembled by `buildWorkspaceRuntime` but deliberately not run by it:
   * `landrace status` builds a runtime the same way to enumerate items, and
   * must never make the one write a preflight can make while only trying to
   * read. Only `runStart` runs these, before the first tick. One each, by
   * identity: two workflows loading one module share its preflight, which is
   * handed the `tracker.field` values of the workflows that load it.
   */
  preflights: Preflight[];
  intervalMs: number;
  /**
   * How many converges may be in flight at once across the workspace: every
   * workflow's, and every tick's still running, since ticks overlap.
   */
  concurrency: number;
  /** Converges in flight now, over every tick and workflow: what `concurrency` bounds. Starts at 0. */
  converging: number;
  /**
   * How many ticks have listed. Only the latest listing hands out slots: a
   * tick a later one has listed since takes none, so a freed slot goes to the
   * most urgent item as it is now, not to an older tick's queue. Starts at 0.
   */
  listed: number;
  /**
   * Ctrl-C. The same signal every hook and executor is handed, so aborting it
   * stops the agent subprocess, stops the next pass from starting, and lets
   * each item unwind through the lock it holds.
   */
  stop: AbortController;
  /** One map for the life of the loop, so every tick sees every run, whichever workflow it is under. */
  running: Map<string, RunningItem>;
  /**
   * Where each item its workflow owns was when the last tick listed it, or
   * where converge last told a person it came to rest: what tells that an
   * item placed by its own state has just come to wait on someone, since it
   * makes no transition to say so. In this process only, like `running` —
   * nothing about it is stored, so a restart tells once more of every item
   * already waiting (see `noteArrivals`).
   */
  seen: Map<string, SeenAt>;
  /** The one logger every workflow logs through; its `scrub` is the one redaction set. */
  log: RedactingLogger;
  ctx: RuntimeContext;
  /**
   * What each step's agent is doing, for the page's item panel: one log for
   * the workspace, keyed by item, and the one every workflow's deps carry.
   * Absent for a runtime built only to read, which writes nothing.
   */
  activity?: ActivityLog;
  /** Present when telemetry is on. `runStart` shuts it down on the way out, flushing what is queued. */
  telemetry?: { shutdown(): Promise<void> };
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
   * A person acted: run a tick now and restart the countdown from now. With any tick of this
   * schedule's still in flight it runs nothing and queues one follow-up for when they have all
   * settled, however many wakes arrive meanwhile. After stop(), nothing. A wake never runs beside
   * another tick; scheduled ticks are unaffected and may still overlap, as before.
   */
  wake(): WakeResult;
}

/** What a wake did: ran a tick now, queued one behind the tick in flight, or nothing, the schedule having stopped. */
export type WakeResult = "started" | "queued" | "stopped";

export interface StartOptions {
  once?: boolean;
  debug?: boolean;
  /** Serve the triage page. Default true; `--no-ui` turns it off. */
  ui?: boolean;
  uiPort?: number;
  /** See BuildOptions.otel. */
  otel?: readonly string[];
}

export interface BuildOptions {
  debug?: boolean;
  /**
   * `--otel KEY=VALUE`, and `--telemetry` as `LANDRACE_ENABLE_TELEMETRY=1`:
   * telemetry settings that win over `.env` and the shell.
   */
  otel?: readonly string[];
  /** Where events go. `landrace status` sends them to stderr, because stdout is its report. */
  sink?: (event: LandraceEvent) => void;
  /**
   * `landrace status`: it enumerates and never runs a step, so the plugins and
   * servers a step would be handed are neither resolved nor refused over — and
   * the step executor it gets refuses every run rather than running one
   * without them.
   */
  readOnly?: boolean;
  /** The board's URL once the page is up, for a notification to link to. Absent, or null, there is none. */
  board?: () => string | null;
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

/** What stops a worktree's call to origin: the run's abort, and a limit of its own. */
export interface RemoteGuard {
  signal?: AbortSignal | undefined;
  timeoutMs: number;
}

/**
 * `agent.worktree`, resolved: what a write step's worktree is given before its
 * agent runs. Operator configuration, trusted like the rest of
 * `landrace.yaml`, which is why `setup` runs outside the agent's sandbox.
 */
export interface WorktreeSetup {
  /** Globs, from the repository root, of untracked or ignored files copied in from the checkout. */
  copy: string[];
  /** Commands run in the worktree, in order, when the lockfiles or the commands have changed since they last passed. */
  setup: string[];
  timeoutMs: number;
  /** Globs, from the repository root, of the lockfiles whose change runs `setup` again. */
  lockfiles: string[];
}

/** Where steps' worktrees are cut from, and what a write step's is given. */
export interface Sandbox {
  root: string;
  worktree?: WorktreeSetup;
}

/** What `prepareWorktree` is handed: the worktree, the checkout it copies from, and where its events go. */
export interface WorktreePreparation {
  item: string;
  path: string;
  root: string;
  setup: WorktreeSetup;
  log: (event: EventName, data?: Record<string, unknown>) => void;
  signal?: AbortSignal;
}

/* ------------------------------------------------ conversation (§12, §7) -- */

/**
 * What a turn joins: the session to resume, and the stage and round whose
 * record carried it, so the turn is recorded against the same round the step
 * produced. All three are derived from the item, never remembered.
 */
export interface JoinedSession {
  session: string;
  stage: string;
  round: number;
}

export interface ConversationDeps {
  /** The tick's own source and pre hooks: a turn reads the snapshot the tick would read, not a second view of the item. */
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
   * workflow forbade it in the step. Optional on the type, so a conversation
   * assembled without it is possible; `ask` then refuses rather than running
   * a turn it cannot constrain.
   */
  workflow?: Workflow;
  steps?: Map<string, Step>;
  /**
   * Where the repository is, when a turn is to run in a per-item worktree of
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
  screen?: Screener;
  lock?: LockOptions;
  /**
   * Where a turn's activity is kept, filed under the stage and round it
   * joined — the panel's progress on an Ask. Absent, none is.
   */
  activity?: ActivityLog;
}

export interface Conversation {
  /**
   * Relay a person's message to the step that is waiting, and record both
   * halves. `resolved` is the agent's own answer to "are you still missing
   * something", read fail-closed: unreadable means unresolved.
   */
  ask(
    item: string,
    message: string,
    opts?: { signal?: AbortSignal },
  ): Promise<{ reply: string; resolved: boolean }>;
  /** Hand the item back to the loop as a human turn. Already handed back is reported, not repeated. */
  resolve(item: string, why?: string): Promise<{ alreadyResolved: boolean }>;
}

/* -------------------------------------------------------------------- ui -- */

/**
 * Where an item stands, drawn as its badge — and, for a whole branch, the
 * lane it is drawn in. The cascade's order, most urgent first, is `URGENCY`
 * in src/ui/board.ts; nothing reads it from this union.
 */
export type Lane = "needs-you" | "running" | "elsewhere" | "waiting" | "not-admitted" | "discharged";

/** An agent this process has in the room right now. */
export interface Running {
  stage: string;
  round: number;
  model: string | null;
  effort: string | null;
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
 * The Chat menu's contents for one item, built server-side in
 * `src/ui/chat.ts` from nothing but the item number and the workspace
 * path — the page script only ever assigns these to `href`/clipboard text,
 * never concatenates a URL of its own.
 */
export interface Chat {
  prompt: string;
  links: Record<ChatTarget, string>;
}

/** A key `Chat.links` is indexed by — one of the board's own deep-link targets. */
export type ChatTarget = (typeof CHAT_TARGET_KEYS)[number];

/**
 * One node on the triage page's tree. An allowlist, not a pass-through:
 * nothing reaches the page that was not named here, so a secret cannot ride
 * along in an event payload and a remote document's body never does.
 */
export interface BoardRow {
  id: string;
  /** "item", or whatever kind the source gave an artifact ("pull-request", "document"). */
  kind: string;
  title: string;
  /** http(s) only, else empty — it becomes an href. */
  link: string;
  /** Null only when there is no usable link to name a system from. */
  system: BoardSystem | null;
  /**
   * The workflow that owns this open item, by the last listing; null on an
   * artifact, a closed item, and an item no one workflow owns — the note says
   * which of those an open one is.
   */
  workflow: string | null;
  /**
   * The owning workflow's name, drawn beside the title; null wherever
   * `workflow` is, and in a workspace of one workflow, where it would say
   * nothing. Display only: nothing routes by it.
   */
  tag: string | null;
  /** Items only: where this item itself stands. Null on an artifact row. */
  badge: Lane | null;
  /**
   * Root rows only: the lane the whole branch is drawn in — the most urgent
   * badge of any item in it, so a sub-item that needs you is never filed
   * under a parent that merely waits. A branch with no item in it waits
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
  /** When the source says the node was opened, epoch ms, or null where it gave none. */
  createdAt: number | null;
  /** When the source says the node last changed, epoch ms, or null where it gave none — what its lane orders by. */
  updatedAt: number | null;
  round: number | null;
  model: string | null;
  /** The running step's own `effort`, as `model` is its own `model`; null where it named none. */
  effort: string | null;
  /**
   * Root rows only: the workflow pages that draw this branch, sorted by id —
   * every page any row in the branch belongs to. Empty on a nested row.
   */
  pages: string[];
  /** Items only. */
  chat: Chat | null;
  /** Stopped by a security check rather than for any other reason — the page draws a shield. */
  screened: boolean;
  /**
   * The labels the badge was read from predate a step this process ran on
   * the item: from the step's start until a list read after its tick let
   * the item go. Meanwhile a needs-you badge may be the stage it is
   * leaving, so the page's bell never counts it as an arrival.
   */
  stale: boolean;
  /**
   * Where the page's Retry posts, for an item that is blocked or screened
   * right now; null everywhere else. Built by the server from a checked id,
   * so the page never puts a URL together itself. A Retry is now a goto with
   * no step named — the stage that last failed.
   */
  retry: string | null;
  /**
   * Where the page's Clear & retry posts, for an item a security check
   * stopped, where a Retry is offered too; null everywhere else. The server
   * re-reads the item, so this is an offer, never a clearance.
   */
  clear: string | null;
  /**
   * The steps this item's stage may send it back to, each with the path
   * the page posts to — built by the server. Empty unless the item is
   * open, its agent is not running, and its stage lists a goto target; the
   * server's `sendTo` stays the one authority on whether a given send is
   * actually accepted (a stage's step still owed, a cap not holding, and so
   * on), so an entry here is an offer, not a promise.
   */
  goto: Array<{ stage: string; path: string }>;
  /**
   * Where the item panel reads and writes, built by the server from a
   * checked id like `retry`. Null on an artifact: only an item opens a panel.
   */
  panel: PanelPaths | null;
  /**
   * Every relationship the node has to an item, of any type and either way,
   * as the listing's edges say — the panel lists them; a pull request or a
   * page about it is an artifact, listed as one. Empty, never absent.
   */
  related: BoardRelated[];
  /**
   * What the item's source reports of its relationships on its own node —
   * not all of them read, on a dependency cycle — in a person's words, for
   * the panel to say why. Empty, never absent.
   */
  facts: string[];
  children: BoardRow[];
}

/** One relationship of a board row's node: the node at its other end, as the listing has it. */
export interface BoardRelated {
  type: string;
  /** `out` where the row's node is the edge's `from`, `in` where it is its `to` — `rel`'s own two ways. */
  dir: "in" | "out";
  id: string;
  /** One line. */
  title: string;
  /** http(s) only, else empty — it becomes an href. */
  link: string;
  /** `unreadable` where its source knew which item it is but not what state it is in. */
  state: "open" | "done" | "dropped" | "unreadable";
}

/** The item panel's routes for one item. */
export interface PanelPaths {
  activity: string;
  conversation: string;
  /**
   * The writes are null on an item no one workflow owns, or that is closed:
   * the page's routes refuse every write to one, so the page offers none.
   */
  reply: string | null;
  ask: string | null;
  resolve: string | null;
  /** The Pairing section's read, and its three writes. */
  pairing: string;
  pair: string | null;
  finish: string | null;
  release: string | null;
}

/** One record of an item's conversation, as the panel shows it: plain text, oldest first. */
export interface ConversationLine {
  at: string;
  /** "landrace" for our own records, the author the source named for a person's. */
  by: string;
  byAgent: boolean;
  kind: string;
  stage: string;
  round: number;
  text: string;
}

/**
 * What the item panel reads and writes. The top of the panel reads the
 * BoardRow already in /board.json; everything here is the bottom half.
 */
/** The item panel's two reads that spend a tracker read: what a closed item's source answers, as a workflow's panel does. */
export type ItemReads = Pick<ItemPanel, "conversation" | "pairing">;

export interface ItemPanel {
  activity(item: string, after: number): Promise<ActivityPage>;
  conversation(item: string): Promise<ConversationLine[]>;
  reply(item: string, message: string): Promise<void>;
  ask(item: string, message: string): Promise<{ reply: string; resolved: boolean }>;
  resolve(item: string): Promise<{ alreadyResolved: boolean }>;
  pairing(item: string): Promise<PairingView>;
  pair(item: string, stage: string): Promise<PairStarted>;
  finish(item: string, note: string): Promise<PairFinished>;
  release(item: string): Promise<{ stage: string; round: number }>;
}

/** One sidebar entry: a workflow and how many root branches on its page need the person. */
export interface BoardWorkflow {
  id: string;
  name: string;
  /** Root rows on this workflow's page whose lane is "needs-you" — the sidebar's dot when above zero. */
  needsYou: number;
}

export interface BoardView {
  generatedAt: number;
  /**
   * The root rows in display order, which the page draws as given: lane by
   * lane, most urgent first; within Needs you by priority, then least
   * recently updated; within any other lane most recently updated first.
   * Each branch's children follow its lane's order, at every depth.
   */
  rows: BoardRow[];
  /** When the next scheduled tick is due, epoch ms; null when nothing is scheduled. */
  nextTickAt: number | null;
  /** The repository checkout's own name — the header chip. `basename(workspace)`. */
  folder: string;
  /** The absolute path of the repository checkout landrace is running in. */
  workspace: string;
  /** The sidebar, by name case-folded, then id. */
  workflows: BoardWorkflow[];
  /** Root rows whose lane is "needs-you", across every workflow — the home page's count, the tab title's. */
  needsYou: number;
  /**
   * Whether a listing has been taken yet. Before it, `rows` is empty because
   * nothing was read, not because nothing needs anyone: the page must not say
   * "all set" on no data.
   */
  listed: boolean;
}

/** Which workflow an item belongs to, or the sentence refusing to act on it. */
export type Ownership = { workflow: string } | { refused: string };

/**
 * Where a read of an item goes: the workflow that owns it, or — for an item
 * no one workflow owns: closed, claimed twice, or turned away — the one
 * source that lists it, by its index in the listing; or the sentence
 * refusing the read.
 */
export type ReadRoute = Ownership | { source: number };

/**
 * Where an operator's edit of an item goes: the workflow that owns it, or —
 * for an item no one workflow owns — the workflows that could be its, which
 * all edit through one operator; or the sentence refusing the edit.
 */
export type EditRoute = Ownership | { workflows: string[] };

export interface Board {
  observe(e: LandraceEvent): void;
  /** What the page is shown of a listing: every source's graph, which workflows read each, and who owns what in them. */
  list(listing: Pick<WorkspaceListing, "graphs" | "claims" | "sourceOf">): void;
  /** For a write, by the last listing: never a guess at an item two workflows claim, two sources report, or none claims. */
  ownerOf(item: string): Ownership;
  /**
   * For a read, by the last listing: an owned item through its owner, any
   * other item through the one source that lists it, and an id no listing
   * showed through the workspace's one source when it has one. Refused for
   * an id two sources report.
   */
  readerOf(item: string): ReadRoute;
  view(): Promise<BoardView>;
}

export interface UiOptions {
  port: number;
  view: () => Promise<BoardView>;
  /**
   * The schedule's own `wake`, for "Tick now" and after a Retry or goto has
   * written. Absent, POST /tick is 404: the page's tick exists only when
   * something is actually there to run it against.
   */
  tick?: () => WakeResult;
  /**
   * The page's Retry and "Go to step…": both send the item back through
   * `sendTo`, read afresh when the request arrives — the page is never taken
   * at its word. Absent, both routes are 404, as /tick is without a tick.
   */
  goto?: GotoPath;
  /**
   * The page's fourth write, POST /refresh: re-read the tracker and reload
   * the board from it, with no converge, no step and no agent. Absent, the
   * route is 404, as /tick is without a tick. It still spends a tracker
   * read, so it is guarded exactly like the other three.
   */
  refresh?: () => Promise<void>;
  /**
   * The item panel's reads and its three writes — Reply, Ask, Resolve.
   * Absent, every panel route is 404.
   */
  panel?: ItemPanel;
}

/**
 * What posting a person's reply on an item needs: the snapshot a post hook
 * is handed, read the way the tick reads it, and the dispatcher every other
 * write goes through.
 */
export interface ReplyDeps {
  source: Source;
  pre: PreHook[];
  dispatcher: Dispatcher;
  ctx: RuntimeContext;
}

/** What sending an item back to a step answers: the step it was sent to, or a sentence saying why not. */
export type GotoResult = { refused: string } | { to: string };

/**
 * A reply's needs, the workflow, which is what says where a stage may send an
 * item, and where the per-item locks live — the tick's own, by default,
 * since a goto has to be serialised against the tick that would take it.
 */
export interface GotoDeps extends ReplyDeps {
  workflow: Workflow;
  lock?: LockOptions;
}

/**
 * What pairing needs beyond a goto's: the steps, the agent that hands a
 * session over and closes it, the screener, and where worktrees are cut.
 */
export interface PairDeps extends GotoDeps {
  steps: Map<string, Step>;
  /** Null, or one with no `handoff`: nothing is offered, and a pairing asked for is refused. */
  executor: Executor | null;
  screen?: Screener;
  /** Absent, nothing is offered: a pairing's session needs a checkout of its own. */
  sandbox?: { root: string };
  /** `landrace mcp` on this workflow, for the person's session: their way back to Landrace. */
  server?: ServerCommand;
  /** How to start the engine's item server, for a hand-in on an `items:create` step. */
  childServer?: ServerCommand;
  /** Asked for the seeded prompt's briefing, as a step's invocation asks them. */
  artifacts?: ArtifactHook[];
  scrub?: (text: string, extra?: readonly string[]) => string;
}

/**
 * A step a person may pair on now: the stage, the round it would be, and
 * whether it continues the agent's own session there (a fork of it) or
 * starts one seeded with the step's prompt.
 */
export interface PairOffer {
  stage: string;
  round: number;
  continue: boolean;
}

/** What the panel's Pairing section shows: the pairing open now, or what may be paired on. */
export interface PairingView {
  open: Pairing | null;
  offers: PairOffer[];
}

/** A pairing started — or an open one asked for again — and the command that joins it. */
export interface PairStarted {
  stage: string;
  round: number;
  session: string;
  cwd: string;
  /** One line for a POSIX shell: into the worktree, then the agent. */
  command: string;
}

/** A hand-in taken: where its output was recorded, and what was left uncommitted and discarded. */
export interface PairFinished {
  stage: string;
  round: number;
  discarded: string[];
}

/** How the page's writes reach an item. `target` null is a Retry: `run.failedStage`, the failure that put the item where it is. */
export interface GotoPath {
  send(item: string, target: string | null, opts?: { clear?: boolean }): Promise<GotoResult>;
}

export interface UiServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** How `landrace update` updates: the project's own dependency, or the global install. */
export interface UpdateCommand {
  command: string;
  args: string[];
  where: "project" | "global";
  cwd: string;
}

/** What `landrace version` reads and writes, injected so a test asks npm nothing. */
export interface VersionDeps {
  env: Record<string, string | undefined>;
  current: string;
  latest: () => Promise<string | null>;
  log: (line: string) => void;
}

/** What `landrace update` reads and runs, injected for the same reason. */
export interface UpdateDeps {
  current: string;
  latest: () => Promise<string | null>;
  plan: () => UpdateCommand;
  /** Runs the command with the terminal attached; its exit status. */
  run: (plan: UpdateCommand) => number;
  log: (line: string) => void;
}
