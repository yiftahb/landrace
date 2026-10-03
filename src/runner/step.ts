import { compile, expandEffectFields, fillTemplate } from "#core/index.js";
import type { AgentActivity, Effect, Graph, Logger, RunServer, ServerCommand, Snapshot, Step, StepResult, WorktreeState } from "#namespace.js";
import {
  AGENT_BY,
  CAPABILITIES,
  durationMs,
  isReservedId,
  mayCreateItems,
  mayWriteRepo,
  OUTPUT_KIND,
  outputValueProblem,
  RECORD_EFFECT,
  recordBodyProblem,
  retiredCapabilityPointers,
  unknownCapabilities,
} from "#conventions.js";
import type { Executor, Screener } from "#namespace.js";
import { screenPrompt } from "#agent/screen.js";
import { changedSince, worktreeState } from "#agent/worktree.js";
import { extractJsonBlock } from "#agent/json-block.js";
import { messageOf } from "#runner/errors.js";
import { childServerFor } from "#runner/children.js";
import { DEFAULT_STEP_TIMEOUT_MS } from "#runner/budget.js";

/**
 * `part in obj` walks the prototype chain, so a path like `toString` or
 * `constructor` "resolves" to an inherited function instead of being
 * reported absent. `Object.hasOwn` only ever sees what the snapshot itself
 * put there.
 */
function resolve(snapshot: unknown, path: string): unknown {
  let cur: unknown = snapshot;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * `{path}` is replaced from the snapshot; an unknown path is left visible
 * rather than printed as "undefined". The snapshot is attacker-controlled —
 * an issue body, a comment — so this function's only job is filling in
 * prompt text for the model to read. It must never be the thing that decides
 * which branch runs or what shape an effect takes; that is why route effect
 * fields go through core's `expandEffectFields` instead of this, with a much
 * narrower set of substitutions — the same one an on_enter effect gets.
 */
export function renderPrompt(
  template: string,
  snapshot: Snapshot,
  briefing?: Record<string, Record<string, string>>,
  // Wraps each value filled in — the screener's fence; the agent gets them bare.
  quote: (text: string) => string = (text) => text,
): string {
  // The briefing sits beside the snapshot under a name the engine reserves,
  // and it wins: a hook that happened to put its own `brief` in the snapshot
  // would otherwise decide what a step reads under that name, and which of the
  // two won would depend on nothing anybody wrote down.
  const scope: Snapshot = briefing === undefined ? snapshot : { ...snapshot, brief: briefing };
  // The same template syntax every other pass fills in, from core, so a name
  // this one recognises is a name they all do.
  return fillTemplate(template, (path) => {
    const value = resolve(scope, path);
    if (value === undefined) return undefined;
    // A path that is there and null is an answer — nothing failed, no stage
    // before this one — and left as a bare `{run.failedStage}` it read to the
    // judge as a hole in its prompt. Only a path that is not there at all
    // stays visible.
    if (value === null) return "none";
    // String() runs a list together — "code-review,build" — and a model
    // reading which steps failed has to be able to tell them apart.
    return quote(Array.isArray(value) ? value.join(", ") : String(value));
  });
}

/**
 * An agent-chosen value is unbounded — a 200,000-character discriminator
 * produces a reason of the same size, which converge embeds verbatim into a
 * tracker comment. `JSON.stringify` (not `String`) also fixes a separate
 * misreport: `String(["spec"])` reads as the bare string "spec", hiding that
 * the real problem is the wrong type.
 */
const MAX_REPORTED_VALUE = 200;
const describeValue = (value: unknown): string => {
  const json = JSON.stringify(value) ?? String(value);
  return json.length > MAX_REPORTED_VALUE ? `${json.slice(0, MAX_REPORTED_VALUE)}…` : json;
};

/**
 * How many changed paths a refusal names before it stops counting. An agent
 * that reformatted the repository would otherwise put every path it touched
 * into a tracker comment.
 */
const MAX_NAMED_CHANGES = 10;

/**
 * The worktree as it stood before an agent was let loose in it, or the reason
 * it cannot be judged at all.
 *
 * Read *before* the agent runs, and not compared against "clean": a worktree a
 * crashed run left dirty is not this agent's doing, and failing an innocent
 * run forever is how a guard gets switched off. Unreadable is a refusal rather
 * than a skip, and it is a refusal *before* anything is paid for — a skipped
 * capability check is the capability not existing.
 *
 * `null` whenever there is nothing to judge — no sandbox, or a declaration
 * that includes `repo:write` and is entitled to change things — so "did we
 * read a before state" and "should we compare" cannot become two conditions
 * free to disagree.
 *
 * Exported because a conversation turn is an agent invocation on the same
 * session under the same declaration, and two copies of this reasoning is how
 * one of them comes to be weaker than the other.
 */
export async function sandboxBefore(
  sandbox: { path: string } | undefined,
  capabilities: readonly string[] | undefined,
): Promise<{ ok: true; before: WorktreeState | null } | { ok: false; reason: string }> {
  if (!sandbox || mayWriteRepo(capabilities)) return { ok: true, before: null };
  try {
    return { ok: true, before: await worktreeState(sandbox.path) };
  } catch (e) {
    return { ok: false, reason: `the worktree could not be read, so the declared capabilities cannot be enforced: ${messageOf(e)}` };
  }
}

/**
 * What the agent did to the worktree it was given that it never declared it
 * could, or null if it behaved.
 *
 * Asked of the file system, not of any flags. An executor is free to ignore
 * `capabilities` — the flags that honour them are its own, never the
 * engine's — so this is the half of the capability that the engine actually
 * enforces rather than delegating to the agent.
 */
export async function sandboxTrespass(
  sandbox: { path: string } | undefined,
  before: WorktreeState | null,
): Promise<string | null> {
  if (!sandbox || before === null) return null;

  // A check that could not run has verified nothing — the screener's own rule,
  // applied to the other half of the same control. Refusing is harsh on a
  // transient git failure and still right: the alternative is accepting a
  // step's output while unable to say what it did to get there.
  let after: WorktreeState;
  try {
    after = await worktreeState(sandbox.path);
  } catch (e) {
    return `the worktree could not be read, so what the agent did there cannot be checked: ${messageOf(e)}`;
  }

  const changed = changedSince(before, after);
  if (changed.length === 0) return null;

  const named = changed.slice(0, MAX_NAMED_CHANGES).join(", ");
  const rest = changed.length - MAX_NAMED_CHANGES;
  return (
    "the agent changed the worktree it was given without declaring repo:write: " +
    `${named}${rest > 0 ? ` and ${rest} more` : ""}`
  );
}

export async function runStep(opts: {
  step: Step;
  /** The item this step runs for: the parent any child it creates is bound to. */
  item: string;
  stageId: string;
  round: number;
  snapshot: Snapshot;
  /**
   * What the artifacts had to say about this invocation, as prompt text under
   * `brief.<artifact>.<key>`. Never merged into `snapshot`: it is unbounded,
   * attacker-written text that no predicate may route on and no hash covers.
   */
  briefing?: Record<string, Record<string, string>>;
  executor: Executor;
  signal: AbortSignal;
  screen?: Screener;
  /**
   * The worktree this step runs in, when the runtime made one. Its presence is
   * what turns a step's declared capabilities into something checkable: we
   * built this directory, so what changed in it is the step's doing and
   * nobody else's. With isolation off there is no sandbox, the agent runs in
   * the operator's own checkout, and there is nothing here to judge.
   */
  sandbox?: { path: string };
  /**
   * The item's graph as it stands after the step, for the items:create
   * backstop. Absent, nothing is checked — like `sandbox`, it is what makes
   * the check possible, and a caller with no tracker to ask has none.
   */
  readGraph?: () => Promise<Graph>;
  log?: Logger;
  /** For a step that names no `timeout`: the workflow's budget. */
  defaultTimeoutMs?: number;
  /** How to start the engine's item server; see ConvergeDeps.childServer. */
  childServer?: ServerCommand;
  /** Where the agent's tool calls and messages go as they happen — the item panel's live lines. */
  onActivity?: (e: AgentActivity) => void;
  /**
   * The commit the step's worktree started at, for a stage on a branch:
   * stamped on the record that settles the round, beside the value, where a
   * merge guarded by `reviewedBy` reads it. The runner's, never the agent's.
   */
  head?: string;
}): Promise<StepResult> {
  const { step, stageId, round, snapshot, executor, signal, log } = opts;
  const prompt = renderPrompt(step.prompt, snapshot, opts.briefing);

  // The workflow's own budget (or the engine's, absent one), read once so the
  // screener and the step itself are held to the same fallback.
  const fallbackMs = opts.defaultTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;

  // Before screening and before spending anything: a capability nothing
  // enforces is not a smaller problem than a violation. It is the operator
  // reading the step file, seeing the word, and believing they are covered —
  // so it stops the step rather than being carried along unremarked.
  const unenforceable = unknownCapabilities(step.capabilities);
  if (unenforceable.length) {
    return {
      ok: false,
      kind: "refused",
      reason:
        `step declares ${unenforceable.map((c) => `"${c}"`).join(", ")}, which nothing enforces; ` +
        `this engine enforces ${CAPABILITIES.join(", ")}${retiredCapabilityPointers(unenforceable)}`,
    };
  }

  // Derived here, from what this call already names, rather than accepted
  // from the caller: the step's own declaration is the one thing that may put
  // a binding on the wire, so no caller can hand one to a step that never
  // asked for it. Computed before anything else is spent — before the
  // sandbox is read, before screening runs, before `step.invoked` is even
  // logged — and its own verdict rather than an outage: `childServerFor`
  // throws when the binding is not a shape the server's own command line
  // could carry as meant, and a binding the engine cannot carry is a fact
  // about this step and this round, not a transient failure worth retrying,
  // let alone one worth paying a screening call to discover.
  let childOpt: { child: { parent: string; stage: string; round: number; server?: RunServer } } | Record<string, never> = {};
  if (mayCreateItems(step.capabilities)) {
    try {
      childOpt = {
        child: {
          parent: opts.item, stage: stageId, round,
          ...(opts.childServer ? { server: childServerFor(opts.childServer, { parent: opts.item, stage: stageId, round }) } : {}),
        },
      };
    } catch (e) {
      return { ok: false, kind: "refused", reason: messageOf(e) };
    }
  }

  const start = await sandboxBefore(opts.sandbox, step.capabilities);
  if (!start.ok) return { ok: false, kind: "refused", reason: start.reason };
  const before = start.before;

  // The screener guards an agent that can act. One declaring no capability
  // is a judge answering from a closed set — still at the read tier, in a
  // worktree, with the operator's MCP servers — and screening it only refused
  // people's approvals for the judge template's own wording (#39, #41). A person cleared exactly this round of
  // this stage after reading what the screener refused (`run.cleared`, void
  // once anyone wrote since); any other round is screened as ever.
  const cleared = snapshot.run?.cleared;
  const acts = (step.capabilities?.length ?? 0) > 0;
  if (opts.screen && !acts) {
    log?.("screen.skipped", { stage: stageId, round });
  } else if (opts.screen && cleared?.stage === stageId && cleared.round === round) {
    log?.("screen.cleared", { stage: stageId, round });
  } else if (opts.screen) {
    // Screen the rendered prompt, never the template: the template is the
    // workflow author's own words and carries nothing an attacker wrote, but
    // the snapshot substituted into it does (an issue body, a comment) — and
    // so does the briefing, which is the least trusted text of the three.
    // Screening the template would approve text nobody is ever sent, and
    // never look at the one part that is actually untrusted. Rendered again
    // with each substituted value fenced, so the screener can tell which.
    const verdict = await screenPrompt((quote) => renderPrompt(step.prompt, snapshot, opts.briefing, quote), {
      executor: opts.screen.executor,
      model: opts.screen.model,
      // Screening is quick, so it gets the workflow's budget, not a
      // two-hour build's.
      timeoutMs: fallbackMs,
      signal,
      // With whose screening it was: items are screened side by side, and
      // a reply that failed closed is only evidence once it can be placed.
      ...(log ? { log: (name, data) => log(name, { item: opts.item, stage: stageId, round, ...data }) } : {}),
    });
    if (!verdict.ok) {
      log?.("screen.blocked", { stage: stageId, round, reason: verdict.reason });
      // A verdict, not an outage: the screener ran and said no. "refused",
      // not "unavailable" — this must be durable and terminal (see the
      // StepResult doc comment), never a silent, free-to-repeat retry.
      return { ok: false, kind: "refused", reason: `prompt screening blocked this step: ${verdict.reason}` };
    }
    log?.("screen.passed", { stage: stageId, round });
  }

  /*
   * What was asked for, and who was asked.
   *
   * `capabilities` has an engine-side backstop — the worktree is diffed
   * afterwards, so an executor that ignored the flags is caught by what it
   * left behind. `model` has none, and cannot: which model a subprocess used
   * is not observable from anything the engine holds once the run returns,
   * and every way of asking after the fact (a `model` on the return value, a
   * flag declaring "I honour this") is a claim by the same party that would
   * have dropped the field — an executor that silently ignores `model:` is
   * precisely one that would silently report whatever looks compliant.
   *
   * So nothing here pretends to enforce it. This records the request instead,
   * naming the executor because that is the party whose compliance is in
   * question, and `null` rather than an omission when the step named no model
   * — "the operator's default decides" is a different fact from "haiku", and
   * a reader should not have to infer it from a missing key. An executor that
   * reports the model it actually put on its command line (an `agent.event`
   * or `step.completed` payload, say — that report is the hook's own to make)
   * lets an operator read the two against each other; one that reports
   * neither is visible by the silence.
   */
  log?.("step.invoked", {
    stage: stageId, round, executor: executor.id, model: step.model ?? null, effort: step.effort ?? null,
  });

  // Every run gets a limit. The step's own, when it names one (checked at
  // load, so `durationMs` answers), else the workflow's, else the engine's.
  const timeoutMs = (step.timeout === undefined ? null : durationMs(step.timeout)) ?? fallbackMs;
  // And signals it: an executor may never read `timeoutMs`, so the run's
  // signal aborts at the limit too. Nothing races the run itself — one that
  // honours neither holds its item until it returns.
  const limit = AbortSignal.timeout(timeoutMs);
  const runSignal = AbortSignal.any([signal, limit]);

  let text: string;
  let sessionId: string | null;
  try {
    ({ text, sessionId } = await executor.run(prompt, {
      round,
      signal: runSignal,
      // Always present, never undefined: a step that declares no capabilities
      // is the most restricted one there is, and an executor reading
      // `undefined` would fall back to its own operator-wide default instead.
      capabilities: step.capabilities ?? [],
      // Only when the step named one: absent is "the operator's default
      // decides", and `model: undefined` is a different claim under
      // exactOptionalPropertyTypes than no key at all.
      ...(step.model === undefined ? {} : { model: step.model }),
      ...(step.effort === undefined ? {} : { effort: step.effort }),
      timeoutMs,
      ...(opts.sandbox ? { cwd: opts.sandbox.path } : {}),
      ...childOpt,
      ...(opts.onActivity ? { onActivity: opts.onActivity } : {}),
    }));
  } catch (e) {
    // The executor itself failed — a limit, quota, an abort signal from a
    // Ctrl-C. Nothing was produced, so this is the "never ran" case, not a
    // rejected contract. Said as the limit, not as whatever the executor said
    // when the abort reached it: "aborted" reads like a Ctrl-C, and this was
    // the cap. `messageOf`, not `(e as Error).message`, for anything else: an
    // outage is precisely when a library is likely to reject with something
    // that is not an Error, and that access would throw from inside this
    // catch, escaping runStep entirely instead of describing the failure.
    const reason = limit.aborted && !signal.aborted ? `the agent ran past its ${timeoutMs}ms limit` : messageOf(e);
    return { ok: false, kind: "unavailable", reason };
  }

  // A verdict, not an outage: durable and terminal, like a screening refusal.
  const trespass = await sandboxTrespass(opts.sandbox, before);
  if (trespass) return { ok: false, kind: "refused", reason: trespass };

  // The engine's half of items:create, like the worktree diff is repo:write's:
  // a child carrying this very round's origin, made by a step that never
  // declared the word, is a step that found a way around its executor.
  //
  // A re-read that fails keeps the step. The backstop is defence in depth —
  // the executor is never handed the tool without the word — and discarding
  // a finished, paid step over a rate limit on the check is the costlier
  // mistake; the skipped check is logged instead, naming the item.
  let graph: Graph | null = null;
  if (!mayCreateItems(step.capabilities) && opts.readGraph) {
    try {
      graph = await opts.readGraph();
    } catch (e) {
      log?.("step.unchecked", {
        item: opts.item, stage: stageId, round,
        reason: `the item could not be re-read to check what the step created: ${messageOf(e)}`,
      });
    }
  }
  if (graph) {
    const made = graph.nodes.filter((n) =>
      n.origin?.parent === opts.item && n.origin.stage === stageId && n.origin.round === round);
    if (made.length) {
      return {
        ok: false,
        kind: "refused",
        reason: `the step created children (${made.map((n) => n.id).join(", ")}) without declaring items:create`,
      };
    }
  }

  return settleOutput({ step, item: opts.item, stageId, round, text, sessionId, by: AGENT_BY, ...(opts.head === undefined ? {} : { head: opts.head }) });
}

/**
 * What an agent's answer amounts to: the step's output contract applied to
 * the text, and the effects that record it — or the reason it is refused.
 *
 * The output half of `runStep`, apart from the run, because a pairing's
 * hand-in is the same answer to the same step by another route: a person
 * worked the round with the agent, and the closing turn's text is held to
 * exactly this contract. `by` is who produced it, stamped on the output
 * record beside the session — "agent" is left off, so the agent's records
 * read exactly as they did before anybody could pair.
 */
export function settleOutput(opts: {
  step: Step;
  item: string;
  stageId: string;
  round: number;
  text: string;
  sessionId: string | null;
  by: string;
  /** See `runStep`'s: absent where no worktree was cut, and then no record carries one. */
  head?: string;
}): StepResult {
  const { step, stageId, round, text, sessionId } = opts;
  const by = opts.by === AGENT_BY ? {} : { by: opts.by };
  // The engine's alone: whatever a route's effect names `head` is dropped below, so it cannot stand in for this.
  const started = opts.head === undefined ? {} : { head: opts.head };

  // A step with no declared output contributes no effects; the workflow routes
  // it by trigger instead.
  if (!step.output) return { ok: true, effects: [], sessionId };

  // The trailing-marker rule (conventions.ts), applied to a fenced json
  // block instead of an HTML comment: the answer is the *last* strict
  // ```json fence with nothing but whitespace after it. No cross-reply
  // ambiguity count — a restatement of the step's format earlier in the
  // reply, a worked example, or prose that happens to mention
  // `{"kind":"spec"}` are all inert, not a second candidate to be ambiguous
  // with. See json-block.ts for why counting candidates was the wrong tool
  // for deciding which text is the answer at all — `spec.md` interpolates
  // `{item.body}` straight into the prompt, so a candidate that could be
  // planted by whoever opened the issue must never compete with the real
  // answer for "ambiguous, refusing to guess".
  const extracted = extractJsonBlock(text);
  if (extracted.kind === "none") {
    return { ok: false, kind: "contract", reason: "the step produced no json block as its final line" };
  }
  if (extracted.kind === "unparseable") {
    return { ok: false, kind: "contract", reason: "the step's json block could not be parsed as json" };
  }
  const parsed = extracted.value;

  const shape = parsed[step.output.discriminator];
  // `shape in step.output.shapes` would walk the prototype chain too —
  // "toString", "constructor", "hasOwnProperty" and "valueOf" all pass a
  // plain `in` check despite never being declared, and `{ when: {} }` (the
  // natural way to write a single-shape step's route) then matches for
  // real. `isReservedId` is the same boundary conventions.ts already draws
  // for a stage id used as an object key; a shape name is used the same way
  // downstream (`vars.shape`, marker/comment templates) and deserves it too.
  if (typeof shape !== "string" || !Object.hasOwn(step.output.shapes, shape) || isReservedId(shape)) {
    return {
      ok: false,
      kind: "contract",
      reason: `${describeValue(shape)} is not a declared output shape of this step`,
    };
  }

  // Route only on the value the schema just admitted. Two routes matching one
  // output is the same ambiguity the rest of this engine refuses to resolve
  // by picking the first — it halts instead of silently choosing a
  // destination for the model's output. A route's `when` may name fields
  // beyond the discriminator, so a validated shape can also fail to match any
  // route at all; there is then nothing to route on, and guessing one would
  // be exactly the kind of first-match this codebase has none of.
  const matches = step.output.routes.filter((route) => compile(route.when)(parsed as unknown as Snapshot));
  if (matches.length > 1) {
    return {
      ok: false,
      kind: "contract",
      reason: `output shape "${shape}" matches ${matches.length} routes; ambiguous, refusing to guess which is authoritative`,
    };
  }
  const [route] = matches;
  if (!route) {
    return { ok: false, kind: "contract", reason: `output shape "${shape}" is declared but no route claims it` };
  }

  /*
   * What the agent said, cut down to what the step declared it may say.
   *
   * The discriminator plus the fields of *this* shape — not the parsed object,
   * and not the union of every shape's fields. Whatever survives here becomes
   * snapshot state on the next tick (outputs.<stage>.<field>), which
   * predicates route on, so the schema's judgement about what is admissible is
   * the boundary: the raw object would let an agent write any key it liked
   * into the state the engine decides from. A reserved id is not a field name
   * but a reachable key on a plain object, refused here the same way a shape
   * name and a stage id already are.
   *
   * A declared field the output omits simply does not travel. This bounds what
   * an output may carry; it does not yet assert that it carries it — the
   * spec's `assert` is not implemented, so a missing or wrongly-typed field
   * shows up as a trigger that does not match, not as a rejection.
   */
  const declared = step.output.shapes[shape];
  const named = declared !== null && typeof declared === "object" && !Array.isArray(declared)
    ? Object.keys(declared)
    : [];
  // Null-prototype: the second half of the reserved-id guard, exactly as in
  // deriveRun. Neither is a substitute for the other.
  const value = Object.create(null) as Record<string, unknown>;
  value[step.output.discriminator] = shape;
  for (const field of named) {
    if (isReservedId(field) || !Object.hasOwn(parsed, field)) continue;
    value[field] = parsed[field];
  }

  /*
   * The session this round ran under, so a person can join it later
   * (spec §6.1: conversation continuity is derived from the session id in the
   * step's output marker). Beside the value, not in it: this is the engine's
   * bookkeeping about how the record was produced, not something the step
   * said, and inside it was snapshot state a predicate could route on. Absent
   * rather than null when there is none — an id that resumes nothing is worse
   * than no id, because a later turn would hand it to the executor.
   */
  const session = sessionId === null ? {} : { session: sessionId };

  /*
   * An output value is agent-chosen and unbounded, and it has to fit in a
   * record we can read back. Rejected here, as a broken contract, rather than
   * left to throw at apply time: an apply that throws leaves nothing durable
   * on the item, so the next tick re-derives "pending" and pays for the
   * step all over again — the money-burning shape of failure this codebase
   * keeps closing. A hard fail records the reason and never retries.
   */
  const problem = outputValueProblem(value);
  if (problem) {
    return {
      ok: false,
      kind: "contract",
      reason: `stage "${stageId}" shape "${shape}": the output value ${problem}`,
    };
  }

  const vars = { round: String(round), stage: stageId, item: opts.item, shape };
  // The exact span extractJsonBlock parsed — not a second, independently-run
  // regex — is what gets removed to build the body. Two regexes matching
  // different spans is how a recognised block whose own value happened to
  // contain fence-shaped text could route correctly and still post a body
  // full of leftover fence markers: extraction and stripping must agree
  // because they are now the same operation, not two that can drift apart.
  const [blockStart, blockEnd] = extracted.span;
  const body = (text.slice(0, blockStart) + text.slice(blockEnd)).trim();

  // One route, one destination — deliberately, not a gap. A route says where
  // the step's *content* goes; it never gets to say whether the result is
  // recorded, which is why the record below is not fan-out a workflow can ask
  // for. Two routes matching one output stays exactly the ambiguity halted
  // above, and a step that genuinely needs two destinations wants a route
  // schema change (`effects:` plural), not a second matching route.
  // The same rule, and the same code, as an on_enter effect's fields: a route
  // is a workflow-authored template and an effect is structure, not prose.
  const { head: _named, ...expanded } = expandEffectFields(route.effect, vars) as Effect;
  void _named;
  // `output` last, as on the record below: the value the step produced, already
  // cut to its shape, which a hook posting structured content (a review's
  // findings) needs and a route must not be able to write over.
  const destination: Effect = { body, stage: stageId, round, ...expanded, output: value };

  // Where the answer sends the item, on the record that settles this round
  // — never a record of its own, which could land without the other and
  // leave either a judge that re-runs or a goto nobody asked for.
  const sent = route.goto === undefined ? {} : { goto: route.goto };

  /*
   * The output value's rule, applied to the other half of what a step
   * produces, and only where that half lands on the tracker.
   *
   * A route that sends the content off the tracker is publishing a document,
   * and a document is not a comment: it carries no tracker's comment limit,
   * and the record that follows it has the engine's own one-line body, which
   * is bounded by being ours. Bounding a published spec here would impose a
   * limit it does not have.
   */
  const oversize = destination.type === RECORD_EFFECT ? recordBodyProblem(body) : null;
  if (oversize) {
    return {
      ok: false,
      kind: "contract",
      reason: `stage "${stageId}" shape "${shape}": the prose the step wrote ${oversize}`,
    };
  }

  /*
   * The record of what the step produced, which is the engine's own
   * bookkeeping rather than the workflow's: core counts these entries to
   * derive the stage's round and its outputs, so a stage whose output is
   * never recorded stays pending forever — it is re-derived, re-invoked and
   * paid for on every poll, whatever it actually accomplished.
   *
   * A route that writes to the tracker carries the record itself; one that
   * sends the content somewhere else — an artifact, a page — needs its own,
   * because nothing it wrote is on the item to read back. `kind` defaults to
   * OUTPUT_KIND and a route may override it, but `output` goes on last: it is
   * the one field the workflow does not get to write, being what the step
   * actually produced, already cut to the declared shape.
   */
  if (destination.type === RECORD_EFFECT) {
    return {
      ok: true,
      effects: [{ ...destination, kind: OUTPUT_KIND, ...expanded, output: value, ...session, ...sent, ...by, ...started }],
      sessionId,
    };
  }

  const record: Effect = {
    type: RECORD_EFFECT,
    kind: OUTPUT_KIND,
    stage: stageId,
    round,
    // Its own marker namespace, so it cannot collide with one a route named.
    marker: `${OUTPUT_KIND}:${stageId}:${round}`,
    body: `Recorded the output of "${stageId}", round ${round}.`,
    output: value,
    ...session,
    ...sent,
    ...by,
    ...started,
  };

  // The destination first, and the order is the recovery property. Recorded
  // first, a crash before the content is written leaves a stage that reads as
  // complete with nothing published — and a step's effects are never replanned,
  // so the document is lost for good. This way round, a crash costs one more
  // invocation: the stage is still pending, the republish of identical content
  // is a no-op, and the record follows.
  return { ok: true, effects: [destination, record], sessionId };
}
