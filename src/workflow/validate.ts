import { identityOf } from "../core/locate.js";
import { assertAllowedOperators, pathsIn } from "../core/predicate.js";
import type { Condition, Stage, Workflow } from "../core/types.js";
import type { Step } from "./load.js";

export interface Problem {
  rule: string;
  message: string;
}

export function validateStructure(w: Workflow, steps: Map<string, Step> = new Map()): Problem[] {
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

  // A trigger can name a stage id that was mistyped or renamed; nothing else
  // in the schema would catch that, since `when` is an open condition
  // document, not a reference the schema can resolve.
  const ids = new Set(w.stages.map((s) => s.id));
  for (const stage of w.stages) {
    for (const t of stage.triggers ?? []) {
      const from = t.when["run.stage"];
      if (typeof from === "string" && !ids.has(from)) {
        problems.push({
          rule: "unknown-stage",
          message: `stage "${stage.id}" has a trigger naming stage "${from}", which is not in the workflow`,
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

  // The allowlist is structural, so it must cover every condition a workflow
  // author can write — including a step's route conditions, not just stage
  // and eligibility conditions. Routes are not compiled/executed in this
  // plan, so this is not yet exploitable, but the next plan does compile
  // them, and the allowlist should not have a documented gap by then.
  for (const stage of w.stages) {
    const step = stage.step ? steps.get(stage.step) : undefined;
    for (const route of step?.output?.routes ?? []) {
      try {
        assertAllowedOperators(route.when);
      } catch (e) {
        problems.push({ rule: "operator", message: `step ${stage.step}, route: ${(e as Error).message}` });
      }
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

function adjacencyOf(w: Workflow): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const [from, to] of edges(w)) adjacency.set(from, [...(adjacency.get(from) ?? []), to]);
  return adjacency;
}

/** Every stage id reachable from `start`, following edges(), start included. */
function reachableFrom(start: string, w: Workflow): Set<string> {
  const adjacency = adjacencyOf(w);
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const node = queue.shift() as string;
    for (const next of adjacency.get(node) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/** True when a trigger's run.stage mention is a plain top-level string edges() can use. */
function isPlainAnchor(when: Condition): boolean {
  return typeof when["run.stage"] === "string";
}

/**
 * True when the graph edges() derives can be trusted. A trigger mentioning
 * run.stage anywhere in its condition — top-level or nested under an operator
 * like $or — that is not a plain top-level string is invisible to edges(), so
 * the derived graph is silently missing edges around it. dead-end,
 * cycle-bound and the reachability BFS all reason over that derived graph, so
 * all three must abstain for the whole graph in that case rather than report
 * on a graph they cannot see all of: a false positive (or false confidence)
 * on a legitimate workflow is worse than a missed problem the runtime will
 * surface anyway.
 */
function graphIsAnalysable(w: Workflow): boolean {
  return !w.stages.some((stage) =>
    (stage.triggers ?? []).some((t) => pathsIn(t.when).includes("run.stage") && !isPlainAnchor(t.when)));
}

/**
 * Strongly connected components of a graph given as an adjacency map, via
 * Tarjan's algorithm — linear in nodes + edges. The naive predecessor to
 * this whole approach enumerated every simple path and let a dedupe pass
 * afterwards collapse the results; on a densely connected graph the number
 * of simple paths is combinatorial (measured: 24 stages with 3 inbound
 * triggers each recorded 4.4M paths in 1.4s, and 10 densely connected
 * stages exhausted memory and crashed), so the dedupe was papering over an
 * exponential blowup rather than eliminating one. Generic over the
 * adjacency map (rather than hardcoded to the full run.stage graph) so it
 * can also run over just the *unbounded* edges — see unboundedCycles.
 */
function stronglyConnectedComponents(nodes: Set<string>, adjacency: Map<string, string[]>): string[][] {
  let counter = 0;
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  const strongconnect = (v: string): void => {
    index.set(v, counter);
    lowlink.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);

    for (const next of adjacency.get(v) ?? []) {
      if (!index.has(next)) {
        strongconnect(next);
        lowlink.set(v, Math.min(lowlink.get(v) as number, lowlink.get(next) as number));
      } else if (onStack.has(next)) {
        lowlink.set(v, Math.min(lowlink.get(v) as number, index.get(next) as number));
      }
    }

    if (lowlink.get(v) === index.get(v)) {
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop() as string;
        onStack.delete(member);
        component.push(member);
      } while (member !== v);
      components.push(component);
    }
  };

  for (const node of nodes) {
    if (!index.has(node)) strongconnect(node);
  }
  return components;
}

/**
 * Adjacency built from only the edges whose own trigger does *not* bound a
 * run.counters.* path — the "unbounded" edges. A cycle counts as bounded
 * when at least one of its edges is bounded (the existing rule), so
 * dropping every bounded edge can only break a cycle that relied on one of
 * them, never manufacture a new one: a cycle that survives in this reduced
 * graph is, exactly, an unbounded cycle in the real graph.
 *
 * This is also what fixes the SCC-merging regression: computing boundedness
 * once per whole strongly-connected component let one bounded loop silence
 * an unbounded loop sharing a hub stage with it (hub -> a -> b -> hub
 * bounded, hub -> c -> d -> hub not, both merge into one SCC through hub,
 * and "any trigger anywhere in the component bounds a counter" cleared the
 * whole thing). Filtering by edge first means the SCC computed below can
 * only still contain hub, c, d — the bounded b -> hub edge is gone, so a
 * and b are no longer part of any cycle in this graph at all.
 */
function unboundedAdjacencyOf(w: Workflow): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const stage of w.stages) {
    for (const t of stage.triggers ?? []) {
      const from = t.when["run.stage"];
      if (typeof from === "string" && !boundsACounter(t.when)) {
        adjacency.set(from, [...(adjacency.get(from) ?? []), stage.id]);
      }
    }
  }
  return adjacency;
}

/**
 * The workflow's unbounded cycles: strongly connected components of the
 * unbounded-edges-only graph, each of which is, by construction, a cycle
 * none of whose edges bound a counter — precisely the set that must be
 * reported. A component is a real cycle when it has more than one stage, or
 * when its single stage has a (still-unbounded) self-edge; every other
 * size-1 component is not a cycle at all.
 */
function unboundedCycles(w: Workflow): string[][] {
  const adjacency = unboundedAdjacencyOf(w);
  const nodes = new Set<string>(w.stages.map((s) => s.id));
  for (const [from, tos] of adjacency) {
    nodes.add(from);
    for (const to of tos) nodes.add(to);
  }
  return stronglyConnectedComponents(nodes, adjacency)
    .filter((c) => c.length > 1 || (adjacency.get(c[0] as string) ?? []).includes(c[0] as string))
    .map((c) => [...c].sort());
}

function cycleMessage(members: string[]): string {
  if (members.length === 1) {
    return `stage "${members[0]}" is only bounded by looping onto itself, with no run.counters.* comparison`;
  }
  return `the cycle among stages ${members.join(", ")} is not bounded by a run.counters.* comparison`;
}

/**
 * True when some condition bounds a run.counters.* path with an upper bound.
 * Recurses into every level of the condition — including nested under $and,
 * $or and $not — consistently with graphIsAnalysable and
 * assertAllowedOperators, which both look at a condition in full rather than
 * only its top-level keys. A bound written as
 * `{ $and: [{ "run.counters.a": { $lt: 3 } }] }` is exactly as real a bound
 * as a top-level one, and a top-level-only scan would false-flag it as
 * unbounded.
 */
function boundsACounter(c: Condition): boolean {
  let found = false;
  const visit = (node: unknown): void => {
    if (found) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [path, value] of Object.entries(node as Record<string, unknown>)) {
      if (
        path.startsWith("run.counters.") &&
        typeof value === "object" && value !== null &&
        ("$lt" in value || "$lte" in value)
      ) {
        found = true;
        return;
      }
      visit(value);
    }
  };
  visit(c);
  return found;
}

/**
 * Two conditions are treated as compatible unless they demand different
 * *literal scalar* values for the same path. This is an over-approximation,
 * not a definition of disjointness: it has no notion of numeric ranges, so
 * two conditions with mutually exclusive $lt/$gt bounds on the same path
 * (e.g. one requiring { $lt: 5 } and the other { $gt: 10 }) still come back
 * "not disjoint" and get flagged below, even though no value can satisfy
 * both. That is a known, deliberate limitation — interval reasoning is out
 * of scope — not a bug to chase; the "identity" problem message says so.
 */
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

    for (const members of unboundedCycles(w)) {
      problems.push({ rule: "cycle-bound", message: cycleMessage(members) });
    }

    // Reachability from the entry stage, over the same edges() graph
    // dead-end and cycle-bound above already trust. Only meaningful with
    // exactly one entry stage — a missing/duplicate entry is reported
    // separately by validateStructure.
    const entries = w.stages.filter((s) => s.entry);
    const entry = entries[0];
    if (entry && entries.length === 1) {
      const reachable = reachableFrom(entry.id, w);
      for (const stage of w.stages) {
        if (!reachable.has(stage.id)) {
          problems.push({
            rule: "reachability",
            message: `stage "${stage.id}" is not reachable from the entry stage "${entry.id}"`,
          });
        }
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
          message: `stages "${a.id}" and "${b.id}" can both be the current position (this check only compares literal scalars, so a genuine $lt/$gt range split can false-positive here)`,
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
  return dedupe([...validateStructure(w, steps), ...validateSemantics(w, steps, provided)]);
}
