import { compile } from "../core/index.js";
import type { Effect, Logger, Snapshot, Step, StepResult, WorktreeState } from "../namespace.js";
import {
  CAPABILITIES,
  isReservedId,
  mayWriteRepo,
  OUTPUT_KIND,
  outputValueProblem,
  RECORD_EFFECT,
  unknownCapabilities,
} from "../conventions.js";
import type { Executor } from "../namespace.js";
import { screenPrompt } from "../agent/screen.js";
import { changedSince, worktreeState } from "../agent/worktree.js";
import { extractJsonBlock } from "../agent/json-block.js";
import { messageOf } from "./errors.js";

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
 * fields go through `expand` below instead of this, with a much narrower set
 * of substitutions.
 */
export function renderPrompt(
  template: string,
  snapshot: Snapshot,
  briefing?: Record<string, Record<string, string>>,
): string {
  // The briefing sits beside the snapshot under a name the engine reserves,
  // and it wins: a hook that happened to put its own `brief` in the snapshot
  // would otherwise decide what a step reads under that name, and which of the
  // two won would depend on nothing anybody wrote down.
  const scope: Snapshot = briefing === undefined ? snapshot : { ...snapshot, brief: briefing };
  return template.replace(/\{([a-zA-Z0-9_.]+)\}/g, (whole, path: string) => {
    const value = resolve(scope, path);
    return value === undefined || value === null ? whole : String(value);
  });
}

/**
 * Effect fields may be templated only with what the engine itself knows about
 * this invocation — the round, the stage id, the already-validated output
 * shape — never with raw snapshot content. A route's `marker` or `body` field
 * is structure, not prose: if ticket content could reach it the same way it
 * reaches the prompt, an issue body could forge a marker exactly the way
 * untrusted comment text is barred from doing downstream (neutraliseMarkers).
 * An unrecognised `{name}` is left visible, matching renderPrompt's own
 * "unknown path stays visible" rule rather than silently vanishing.
 *
 * `vars[k] ?? whole` used to read the prototype chain too — `{toString}`
 * resolved to `Object.prototype.toString` and got stringified into the
 * field, which is a live hole in the "only round/stage/shape" claim even
 * though snapshot content genuinely could not reach it. `Object.hasOwn`
 * closes it the same way `resolve` above does.
 */
const expand = (value: unknown, vars: Record<string, string>): unknown =>
  typeof value === "string"
    ? value.replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, k: string) => (Object.hasOwn(vars, k) ? String(vars[k]) : whole))
    : value;

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
 * What the step did to the worktree it was given that it never declared it
 * could, or null if it behaved.
 *
 * `before` is null whenever there is nothing to judge — no sandbox, or a step
 * that declared `repo:write` and is entitled to change things — which keeps
 * the "did we read a before state" decision and the "should we compare" one
 * from being two conditions free to disagree.
 */
async function sandboxTrespass(
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
    return `the step's worktree could not be read, so what it did there cannot be checked: ${messageOf(e)}`;
  }

  const changed = changedSince(before, after);
  if (changed.length === 0) return null;

  const named = changed.slice(0, MAX_NAMED_CHANGES).join(", ");
  const rest = changed.length - MAX_NAMED_CHANGES;
  return (
    "the step changed its worktree without declaring repo:write: " +
    `${named}${rest > 0 ? ` and ${rest} more` : ""}`
  );
}

export async function runStep(opts: {
  step: Step;
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
  screen?: { executor: Executor };
  /**
   * The worktree this step runs in, when the runtime made one. Its presence is
   * what turns a step's declared capabilities into something checkable: we
   * built this directory, so what changed in it is the step's doing and
   * nobody else's. With isolation off there is no sandbox, the agent runs in
   * the operator's own checkout, and there is nothing here to judge.
   */
  sandbox?: { path: string };
  log?: Logger;
}): Promise<StepResult> {
  const { step, stageId, round, snapshot, executor, signal, log } = opts;
  const prompt = renderPrompt(step.prompt, snapshot, opts.briefing);

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
        `this engine enforces ${CAPABILITIES.join(", ")}`,
    };
  }

  // Read before the agent runs, not compared against "clean": a worktree a
  // crashed run left dirty is not this step's doing, and failing an innocent
  // step forever is how a guard gets switched off. Unreadable here means the
  // step is refused *before* it is paid for — the check would have to be
  // skipped otherwise, and a skipped capability check is the capability not
  // existing.
  let before: WorktreeState | null = null;
  if (opts.sandbox && !mayWriteRepo(step.capabilities)) {
    try {
      before = await worktreeState(opts.sandbox.path);
    } catch (e) {
      return {
        ok: false,
        kind: "refused",
        reason: `the step's worktree could not be read, so its capabilities cannot be enforced: ${messageOf(e)}`,
      };
    }
  }

  if (opts.screen) {
    // Screen the rendered prompt, never the template: the template is the
    // workflow author's own words and carries nothing an attacker wrote, but
    // the snapshot substituted into it does (an issue body, a comment) — and
    // so does the briefing, which is the least trusted text of the three.
    // Screening the template would approve text nobody is ever sent, and
    // never look at the one part that is actually untrusted.
    const verdict = await screenPrompt(prompt, {
      executor: opts.screen.executor,
      signal,
      ...(log ? { log } : {}),
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

  log?.("step.invoked", { stage: stageId, round });

  let text: string;
  let sessionId: string | null;
  try {
    ({ text, sessionId } = await executor.run(prompt, {
      round,
      signal,
      // Always present, never undefined: a step that declares no capabilities
      // is the most restricted one there is, and an executor reading
      // `undefined` would fall back to its own operator-wide default instead.
      capabilities: step.capabilities ?? [],
      ...(opts.sandbox ? { cwd: opts.sandbox.path } : {}),
    }));
  } catch (e) {
    // The executor itself failed — timeout, quota, an abort signal from a
    // Ctrl-C. Nothing was produced, so this is the "never ran" case, not a
    // rejected contract. `messageOf`, not `(e as Error).message`: an outage
    // is precisely when a library is likely to reject with something that
    // is not an Error, and that access would throw from inside this catch,
    // escaping runStep entirely instead of describing the failure.
    return { ok: false, kind: "unavailable", reason: messageOf(e) };
  }

  // Asked of the file system, not of the flags we passed. An executor is free
  // to ignore `capabilities` — one registered by a hook module never saw our
  // CLI flags in the first place — so this is the half of the capability that
  // is actually enforced by the engine rather than delegated to the agent.
  // A verdict, not an outage: durable and terminal, like a screening refusal.
  const trespass = await sandboxTrespass(opts.sandbox, before);
  if (trespass) return { ok: false, kind: "refused", reason: trespass };

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
  // `{ticket.body}` straight into the prompt, so a candidate that could be
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
   * on the ticket, so the next tick re-derives "pending" and pays for the
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

  const vars = { round: String(round), stage: stageId, shape };
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
  const expanded = Object.fromEntries(
    Object.entries(route.effect).map(([k, v]) => [k, expand(v, vars)]),
  ) as Effect;
  const destination: Effect = { body, stage: stageId, round, ...expanded };

  /*
   * The record of what the step produced, which is the engine's own
   * bookkeeping rather than the workflow's: core counts these entries to
   * derive the stage's round and its outputs, so a stage whose output is
   * never recorded stays pending forever — it is re-derived, re-invoked and
   * paid for on every poll, whatever it actually accomplished.
   *
   * A route that writes to the tracker carries the record itself; one that
   * sends the content somewhere else — an artifact, a page — needs its own,
   * because nothing it wrote is on the ticket to read back. `kind` defaults to
   * OUTPUT_KIND and a route may override it, but `output` goes on last: it is
   * the one field the workflow does not get to write, being what the step
   * actually produced, already cut to the declared shape.
   */
  if (destination.type === RECORD_EFFECT) {
    return {
      ok: true,
      effects: [{ ...destination, kind: OUTPUT_KIND, ...expanded, output: value, ...session }],
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
  };

  // The destination first, and the order is the recovery property. Recorded
  // first, a crash before the content is written leaves a stage that reads as
  // complete with nothing published — and a step's effects are never replanned,
  // so the document is lost for good. This way round, a crash costs one more
  // invocation: the stage is still pending, the republish of identical content
  // is a no-op, and the record follows.
  return { ok: true, effects: [destination, record], sessionId };
}
