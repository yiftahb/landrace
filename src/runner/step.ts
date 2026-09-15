import { compile, type Effect, type Snapshot } from "../core/index.js";
import { isReservedId } from "../conventions.js";
import type { Executor } from "../hooks/types.js";
import type { Step } from "../workflow/load.js";
import { screenPrompt } from "../agent/screen.js";
import { extractJsonBlock } from "../agent/json-block.js";
import { messageOf } from "./errors.js";
import type { Logger } from "./events.js";

/**
 * `kind` is CLAUDE.md's own distinction made explicit, in three parts:
 * - "contract": the step ran and produced something the engine cannot act
 *   on — malformed json, an undeclared shape, an ambiguous parse or route.
 *   The hard-fail rule is about exactly this case.
 * - "unavailable": the step never ran at all — the executor itself threw (a
 *   network blip, a timeout, a Ctrl-C). Nothing was produced, so nothing was
 *   rejected; a durable record here would misreport an outage as a broken
 *   contract and permanently poison a stage that never got to try.
 * - "refused": screened out *before* invocation. This looks like
 *   "unavailable" (the executor never ran either), but it is not an outage —
 *   the screener ran fine and returned a verdict. A screening refusal must
 *   be durable and terminal (routed to `blocked`, per spec §15), not a
 *   silent, free-to-repeat retry: treating it as "unavailable" turned a
 *   security refusal into a paid screener call on every single poll,
 *   forever, with nothing ever left on the ticket for anyone to see.
 */
export type StepResult =
  | { ok: true; effects: Effect[]; sessionId: string | null }
  | { ok: false; kind: "contract" | "unavailable" | "refused"; reason: string };

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
export function renderPrompt(template: string, snapshot: Snapshot): string {
  return template.replace(/\{([a-zA-Z0-9_.]+)\}/g, (whole, path: string) => {
    const value = resolve(snapshot, path);
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

export async function runStep(opts: {
  step: Step;
  stageId: string;
  round: number;
  snapshot: Snapshot;
  executor: Executor;
  signal: AbortSignal;
  screen?: { executor: Executor };
  log?: Logger;
}): Promise<StepResult> {
  const { step, stageId, round, snapshot, executor, signal, log } = opts;
  const prompt = renderPrompt(step.prompt, snapshot);

  if (opts.screen) {
    // Screen the rendered prompt, never the template: the template is the
    // workflow author's own words and carries nothing an attacker wrote, but
    // the snapshot substituted into it does (an issue body, a comment).
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
    ({ text, sessionId } = await executor.run(prompt, { round, signal }));
  } catch (e) {
    // The executor itself failed — timeout, quota, an abort signal from a
    // Ctrl-C. Nothing was produced, so this is the "never ran" case, not a
    // rejected contract. `messageOf`, not `(e as Error).message`: an outage
    // is precisely when a library is likely to reject with something that
    // is not an Error, and that access would throw from inside this catch,
    // escaping runStep entirely instead of describing the failure.
    return { ok: false, kind: "unavailable", reason: messageOf(e) };
  }

  // A step with no declared output contributes no effects; the workflow routes
  // it by trigger instead.
  if (!step.output) return { ok: true, effects: [], sessionId };

  // Shared with screen.ts (json-block.ts): recognition (for counting) is
  // permissive — a restatement of the step's own format in one fence style
  // plus a real answer in a style a narrower regex could not see must still
  // count as two, not one, here as much as in screen.ts — but parsing is
  // not: only a *strict* ```json fence is ever obeyed as the sole answer. A
  // bare `{"kind":"spec"}` sitting in prose (with no fence, or the wrong
  // fence) used to be a hard fail (extractJson found nothing to match) and
  // must still be one; a permissive parser that also obeyed whatever it
  // recognised would let stray, unfenced text drive a real route decision.
  // The discriminator itself is the key required of a *bare* candidate for
  // it to count at all — an unrelated `{"code":"ENOENT"}` elsewhere in the
  // prose is not a second candidate, but `{"kind":"spec"}` genuinely is.
  const extracted = extractJsonBlock(text, step.output.discriminator);
  if (extracted.kind === "none") {
    return { ok: false, kind: "contract", reason: "the step produced no json block" };
  }
  if (extracted.kind === "many") {
    return {
      ok: false,
      kind: "contract",
      reason: `the step's output contained ${extracted.count} json blocks; ambiguous, refusing to guess which is authoritative`,
    };
  }
  if (extracted.kind === "not-strict-fence") {
    return {
      ok: false,
      kind: "contract",
      reason: "the step's output has something that looks like an answer, but it is not inside a fenced json block",
    };
  }
  const parsed = extracted.value;
  if (!parsed) {
    return { ok: false, kind: "contract", reason: "the step's json block could not be parsed as json" };
  }

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

  const vars = { round: String(round), stage: stageId, shape };
  // The exact span extractJsonBlock parsed — not a second, independently-run
  // regex — is what gets removed to build the body. Two regexes matching
  // different spans is how a recognised block whose own value happened to
  // contain fence-shaped text could route correctly and still post a body
  // full of leftover fence markers: extraction and stripping must agree
  // because they are now the same operation, not two that can drift apart.
  const [blockStart, blockEnd] = extracted.span;
  const body = (text.slice(0, blockStart) + text.slice(blockEnd)).trim();

  // One route, one effect — deliberately, not a gap. No shipped step needs
  // fan-out (publish the artifact *and* post a comment for the same output)
  // today — recheck `.landrace/steps/*.md` before trusting that claim to
  // still hold — and when one does, the answer is a route schema change to
  // let one route declare `effects:` plural, not two routes matching the
  // same shape to get two effects: two routes matching one output is
  // exactly the ambiguity halted above, so it must stay a way to get
  // halted, not a way to fan out.
  const expanded = Object.fromEntries(
    Object.entries(route.effect).map(([k, v]) => [k, expand(v, vars)]),
  ) as Effect;
  // kind defaults to "output": this effect *is* the step's result, and the
  // engine derives outputs.<stage> from entries of that kind. A route may
  // override it, but forgetting it would leave the stage unable to advance.
  const effect: Effect = { body, stage: stageId, round, kind: "output", ...expanded };

  return { ok: true, effects: [effect], sessionId };
}
