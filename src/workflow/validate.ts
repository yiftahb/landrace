import { identityOf } from "../core/locate.js";
import { assertAllowedOperators, pathsIn } from "../core/predicate.js";
import type { Condition, Stage, Workflow } from "../core/types.js";
import type { Step } from "./load.js";

export interface Problem {
  rule: string;
  message: string;
}

export function validateStructure(w: Workflow): Problem[] {
  const problems: Problem[] = [];

  const entries = w.stages.filter((s) => s.entry);
  if (entries.length !== 1) {
    problems.push({
      rule: "entry",
      message: `expected exactly one stage with entry: true, found ${entries.length}`,
    });
  }

  for (const stage of w.stages) {
    if (!stage.entry && (stage.triggers?.length ?? 0) === 0) {
      problems.push({ rule: "reachability", message: `nothing can reach stage "${stage.id}"` });
    }
  }

  // decide() skips a candidate stage equal to the current stage — a trigger
  // anchored on its own stage can therefore never fire, no matter how it
  // looks on paper. A workflow that relies on one deadlocks silently instead
  // of erroring, so this must be caught here rather than at runtime.
  for (const stage of w.stages) {
    for (const t of stage.triggers ?? []) {
      if (t.when["run.stage"] === stage.id) {
        problems.push({
          rule: "self-loop",
          message: `stage "${stage.id}" has a trigger anchored on its own stage ("run.stage": "${stage.id}"), which can never fire`,
        });
      }
    }
  }

  for (const stage of w.stages) {
    for (const condition of [stage.identity, stage.requires, ...(stage.triggers ?? []).map((t) => t.when)]) {
      if (!condition) continue;
      try {
        assertAllowedOperators(condition);
      } catch (e) {
        problems.push({ rule: "operator", message: `stage "${stage.id}": ${(e as Error).message}` });
      }
    }
  }

  for (const rule of w.eligible ?? []) {
    try {
      assertAllowedOperators(rule.when);
    } catch (e) {
      problems.push({ rule: "operator", message: `eligibility rule: ${(e as Error).message}` });
    }
  }

  return dedupe(problems);
}

function dedupe(problems: Problem[]): Problem[] {
  const seen = new Set<string>();
  return problems.filter((p) => {
    const key = `${p.rule}:${p.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Edges implied by pull triggers: a trigger naming run.stage X is an edge X -> this. */
function edges(w: Workflow): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const stage of w.stages) {
    for (const t of stage.triggers ?? []) {
      const from = t.when["run.stage"];
      if (typeof from === "string") out.push([from, stage.id]);
    }
  }
  return out;
}

/** True when a trigger's run.stage mention is a plain top-level string edges() can use. */
function isPlainAnchor(when: Condition): boolean {
  return typeof when["run.stage"] === "string";
}

/**
 * True when the graph edges() derives can be trusted. A trigger mentioning
 * run.stage anywhere in its condition — top-level or nested under an operator
 * like $or — that is not a plain top-level string is invisible to edges(), so
 * the derived graph is silently missing edges around it. dead-end and
 * cycle-bound both reason over that derived graph, so both must abstain for
 * the whole graph in that case rather than report on a graph they cannot see
 * all of: a false positive (or false confidence) on a legitimate workflow is
 * worse than a missed problem the runtime will surface anyway.
 */
function graphIsAnalysable(w: Workflow): boolean {
  return !w.stages.some((stage) =>
    (stage.triggers ?? []).some((t) => pathsIn(t.when).includes("run.stage") && !isPlainAnchor(t.when)));
}

function cycles(w: Workflow): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const [from, to] of edges(w)) adjacency.set(from, [...(adjacency.get(from) ?? []), to]);

  const found: string[][] = [];
  const walk = (node: string, path: string[]): void => {
    const seenAt = path.indexOf(node);
    if (seenAt !== -1) {
      found.push(path.slice(seenAt));
      return;
    }
    for (const next of adjacency.get(node) ?? []) walk(next, [...path, node]);
  };
  for (const stage of w.stages) walk(stage.id, []);
  return found;
}

/**
 * Rotate a cycle to start at its lexicographically smallest stage id, so every
 * rotation of the same logical cycle (the DFS in cycles() reports one per
 * starting stage) canonicalises to the same sequence and the same message,
 * and dedupe() collapses them into a single problem.
 */
function canonicalizeCycle(cycle: string[]): string[] {
  let min = cycle[0] ?? "";
  for (const id of cycle) if (id < min) min = id;
  const minIndex = cycle.indexOf(min);
  return [...cycle.slice(minIndex), ...cycle.slice(0, minIndex)];
}

const boundsACounter = (c: Condition): boolean =>
  Object.entries(c).some(([path, value]) =>
    path.startsWith("run.counters.") &&
    typeof value === "object" && value !== null &&
    ("$lt" in value || "$lte" in value));

/** Two conditions can hold together unless they demand different values for one path. */
function disjoint(a: Condition, b: Condition): boolean {
  return Object.entries(a).some(([path, value]) => {
    if (!(path in b)) return false;
    const other = b[path];
    const comparable = (v: unknown) => typeof v !== "object" || v === null;
    return comparable(value) && comparable(other) && value !== other;
  });
}

export function validateSemantics(w: Workflow, steps: Map<string, Step>, provided?: string[]): Problem[] {
  const problems: Problem[] = [];

  // A non-terminal stage nothing leads away from is a trap, and an unbounded
  // cycle is a stuck workflow. Both are only decidable when the run.stage
  // graph edges() derives is trustworthy in full — see graphIsAnalysable.
  const analysable = graphIsAnalysable(w);

  if (analysable) {
    const anchored = edges(w);
    for (const stage of w.stages) {
      if (stage.terminal) continue;
      if (!anchored.some(([from]) => from === stage.id)) {
        problems.push({ rule: "dead-end", message: `stage "${stage.id}" has no way out and is not terminal` });
      }
    }

    for (const cycle of cycles(w)) {
      const canonical = canonicalizeCycle(cycle);
      const conditions = w.stages
        .filter((s) => canonical.includes(s.id))
        .flatMap((s) => (s.triggers ?? []).map((t) => t.when));
      if (!conditions.some(boundsACounter)) {
        problems.push({
          rule: "cycle-bound",
          message: `the cycle ${canonical.join(" -> ")} is not bounded by a run.counters.* comparison`,
        });
      }
    }
  }

  for (const stage of w.stages) {
    const step = stage.step ? steps.get(stage.step) : undefined;
    const output = step?.output;
    if (!output) continue;
    for (const shape of Object.keys(output.shapes)) {
      const routed = output.routes.some((r) => r.when[output.discriminator] === shape);
      if (!routed) {
        problems.push({
          rule: "totality",
          message: `step ${stage.step} declares output shape "${shape}" with no route`,
        });
      }
    }
  }

  for (let i = 0; i < w.stages.length; i++) {
    for (let j = i + 1; j < w.stages.length; j++) {
      const a = w.stages[i] as Stage;
      const b = w.stages[j] as Stage;
      if (!disjoint(identityOf(a), identityOf(b))) {
        problems.push({
          rule: "identity",
          message: `stages "${a.id}" and "${b.id}" can both be the current position`,
        });
      }
    }
  }

  if (provided) {
    const known = new Set(provided);
    const covered = (path: string) =>
      known.has(path) || [...known].some((k) => k.endsWith("*") && path.startsWith(k.slice(0, -1)));
    for (const stage of w.stages) {
      const conditions = [stage.identity, stage.requires, ...(stage.triggers ?? []).map((t) => t.when)];
      for (const c of conditions) {
        if (!c) continue;
        for (const path of pathsIn(c)) {
          if (!covered(path)) {
            problems.push({
              rule: "path-coverage",
              message: `stage "${stage.id}" reads ${path}, which no hook provides`,
            });
          }
        }
      }
    }
  }

  return dedupe(problems);
}

export function validate(w: Workflow, steps: Map<string, Step>, provided?: string[]): Problem[] {
  return dedupe([...validateStructure(w), ...validateSemantics(w, steps, provided)]);
}
