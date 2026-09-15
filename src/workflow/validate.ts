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

const identityOf = (s: Stage): Condition => s.identity ?? { "run.stage": s.id };

export function validateSemantics(w: Workflow, steps: Map<string, Step>, provided?: string[]): Problem[] {
  const problems: Problem[] = [];

  // A non-terminal stage nothing leads away from is a trap. Only decidable for
  // triggers anchored on run.stage; an unanchored trigger could fire anywhere,
  // so its presence makes the graph un-analysable and the rule abstains.
  const anchored = edges(w);
  const unanchored = w.stages.some((st) =>
    (st.triggers ?? []).some((t) => typeof t.when["run.stage"] !== "string"));
  if (!unanchored) {
    for (const stage of w.stages) {
      if (stage.terminal) continue;
      if (!anchored.some(([from]) => from === stage.id)) {
        problems.push({ rule: "dead-end", message: `stage "${stage.id}" has no way out and is not terminal` });
      }
    }
  }

  for (const cycle of cycles(w)) {
    const conditions = w.stages
      .filter((s) => cycle.includes(s.id))
      .flatMap((s) => (s.triggers ?? []).map((t) => t.when));
    if (!conditions.some(boundsACounter)) {
      problems.push({
        rule: "cycle-bound",
        message: `the cycle ${cycle.join(" -> ")} is not bounded by a run.counters.* comparison`,
      });
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
