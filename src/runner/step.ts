import { compile, type Effect, type Snapshot } from "../core/index.js";
import { isReservedId } from "../conventions.js";
import type { Executor } from "../hooks/types.js";
import type { Step } from "../workflow/load.js";
import { screenPrompt } from "../agent/screen.js";
import type { Logger } from "./events.js";

/**
 * `kind` is CLAUDE.md's own distinction made explicit: "contract" is a step
 * that ran and produced something the engine cannot act on — malformed json,
 * an undeclared shape, an ambiguous parse or route — the case the hard-fail
 * rule is about. "unavailable" is a step that never ran at all — screened
 * out before invocation, or the executor itself threw (a network blip, a
 * timeout, a Ctrl-C) — the opposite case the same rule exists to keep
 * distinct. Collapsing the two meant an aborted run was recorded exactly
 * like a rejected one, permanently poisoning a stage that had produced
 * nothing to reject.
 */
export type StepResult =
  | { ok: true; effects: Effect[]; sessionId: string | null }
  | { ok: false; kind: "contract" | "unavailable"; reason: string };

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

type Extracted = { kind: "none" } | { kind: "many"; count: number } | { kind: "one"; value: Record<string, unknown> | null };

/**
 * Exactly one fenced json object, never the first and never the last:
 * ambiguity halts here exactly as it does in screen.ts (screenPrompt), which
 * fixed this same defect one commit before this file was first written.
 * Every shipped step prompt shows the agent the json shape it should reply
 * with, so a model that restates the format before giving its real answer
 * produces two fenced blocks with no attacker required — `matchAll` sees
 * both instead of a single `.exec()` silently taking the first.
 */
function extractJson(text: string): Extracted {
  const matches = [...text.matchAll(/```json\s*(\{[\s\S]*?\})\s*```/g)];
  const [only, ...rest] = matches;
  if (!only) return { kind: "none" };
  if (rest.length > 0) return { kind: "many", count: matches.length };
  const raw = only[1];
  if (!raw) return { kind: "one", value: null };
  try {
    return { kind: "one", value: JSON.parse(raw) as Record<string, unknown> };
  } catch {
    return { kind: "one", value: null };
  }
}

const stripFences = (text: string): string => text.replace(/```json[\s\S]*?```/g, "").trim();

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
      // Screened out before invocation: the executor never ran, so nothing
      // was produced to reject. This is "unavailable", not "contract" — a
      // permanent record here would misreport a refusal-to-invoke as a
      // broken output.
      return { ok: false, kind: "unavailable", reason: `prompt screening blocked this step: ${verdict.reason}` };
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
    // rejected contract.
    return { ok: false, kind: "unavailable", reason: (e as Error).message };
  }

  // A step with no declared output contributes no effects; the workflow routes
  // it by trigger instead.
  if (!step.output) return { ok: true, effects: [], sessionId };

  const extracted = extractJson(text);
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
  const body = stripFences(text);

  // One route, one effect — deliberately, not a gap. No shipped step needs
  // fan-out (publish the artifact *and* post a comment for the same output),
  // and when one does, the answer is a route schema change to let one route
  // declare `effects:` plural, not two routes matching the same shape to get
  // two effects — two routes matching one output is exactly the ambiguity
  // halted above, so it must stay a way to get halted, not a way to fan out.
  const expanded = Object.fromEntries(
    Object.entries(route.effect).map(([k, v]) => [k, expand(v, vars)]),
  ) as Effect;
  // kind defaults to "output": this effect *is* the step's result, and the
  // engine derives outputs.<stage> from entries of that kind. A route may
  // override it, but forgetting it would leave the stage unable to advance.
  const effect: Effect = { body, stage: stageId, round, kind: "output", ...expanded };

  return { ok: true, effects: [effect], sessionId };
}
