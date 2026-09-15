import { compile, type Effect, type Snapshot } from "../core/index.js";
import type { Executor } from "../hooks/types.js";
import type { Step } from "../workflow/load.js";
import { screenPrompt } from "../agent/screen.js";
import type { Logger } from "./events.js";

export type StepResult =
  | { ok: true; effects: Effect[]; sessionId: string | null }
  | { ok: false; reason: string };

function resolve(snapshot: unknown, path: string): unknown {
  let cur: unknown = snapshot;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !(part in (cur as object))) return undefined;
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
 */
const expand = (value: unknown, vars: Record<string, string>): unknown =>
  typeof value === "string"
    ? value.replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, k: string) => vars[k] ?? whole)
    : value;

function extractJson(text: string): Record<string, unknown> | null {
  const fence = /```json\s*(\{[\s\S]*?\})\s*```/.exec(text);
  if (!fence?.[1]) return null;
  try {
    return JSON.parse(fence[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const stripFences = (text: string): string => text.replace(/```json[\s\S]*?```/g, "").trim();

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
      return { ok: false, reason: `prompt screening blocked this step: ${verdict.reason}` };
    }
    log?.("screen.passed", { stage: stageId, round });
  }

  log?.("step.invoked", { stage: stageId, round });

  let text: string;
  let sessionId: string | null;
  try {
    ({ text, sessionId } = await executor.run(prompt, { round, signal }));
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }

  // A step with no declared output contributes no effects; the workflow routes
  // it by trigger instead.
  if (!step.output) return { ok: true, effects: [], sessionId };

  const parsed = extractJson(text);
  if (!parsed) return { ok: false, reason: "the step produced no json block" };

  const shape = parsed[step.output.discriminator];
  if (typeof shape !== "string" || !(shape in step.output.shapes)) {
    return {
      ok: false,
      reason: `"${String(shape)}" is not a declared output shape of this step`,
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
      reason: `output shape "${shape}" matches ${matches.length} routes; ambiguous, refusing to guess which is authoritative`,
    };
  }
  const [route] = matches;
  if (!route) {
    return { ok: false, reason: `output shape "${shape}" is declared but no route claims it` };
  }

  const vars = { round: String(round), stage: stageId, shape };
  const body = stripFences(text);

  const expanded = Object.fromEntries(
    Object.entries(route.effect).map(([k, v]) => [k, expand(v, vars)]),
  ) as Effect;
  // kind defaults to "output": this effect *is* the step's result, and the
  // engine derives outputs.<stage> from entries of that kind. A route may
  // override it, but forgetting it would leave the stage unable to advance.
  const effect: Effect = { body, stage: stageId, round, kind: "output", ...expanded };

  return { ok: true, effects: [effect], sessionId };
}
