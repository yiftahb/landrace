import {
  CAPABILITIES,
  ENTRY_KIND,
  GOTO_TRIGGER,
  isReservedId,
  mayCreateItems,
  NODES_CLOSE_EFFECT,
  OUTPUT_KIND,
  RECORD_EFFECT,
  retiredCapabilityPointers,
  retiredPlaceholder,
  unknownCapabilities,
} from "#conventions.js";
import { LABELS, STAGE_LABEL_PREFIX } from "#conventions.js";
import { gotoTargetsOf } from "#core/goto.js";
import { fillTemplate, pathsNoNodeCarries } from "#core/index.js";
import { identityOf, placedByState } from "#core/locate.js";
import { assertAllowedOperators, compile, pathsIn } from "#core/predicate.js";
import type { Condition, EligibilityRule, LoadedWorkflow, Problem, Snapshot, Stage, Step, Workflow, Workspace } from "#namespace.js";
import { messageOf } from "#runner/errors.js";

export function validateStructure(w: Workflow, steps: Map<string, Step> = new Map()): Problem[] {
  const problems: Problem[] = [];

  const entries = w.stages.filter((s) => s.entry);
  /*
   * A workflow whose every open stage is placed by the item's own state
   * enters nothing: an item is at a stage because its labels say so, never
   * at no stage waiting to be entered — and entering is a write, which a
   * workflow over a tracker it only reads cannot make. An item its
   * identities leave unplaced halts saying no stage places it, and writes
   * nothing.
   */
  const open = w.stages.filter((s) => !s.terminal);
  const placedOnly = open.length > 0 && open.every(placedByState);
  if (entries.length === 0 && !placedOnly) {
    problems.push({ rule: "entry", message: "no stage has entry: true, so no item can start" });
  }
  /*
   * With several entry stages, a fresh item is placed by their triggers
   * (decide.ts, pickEntry), so each needs one that says which fresh items
   * it takes — and says *fresh*. decide() evaluates every other stage's
   * triggers whenever a positioned item settles, so an entry trigger that
   * is not anchored on `"run.stage": null` also fires mid-workflow: a child
   * at code-review whose `rel.child-of.out.total` is 1 would be dragged back
   * to build on every pass. A sole entry stage is entered unconditionally and
   * owes nothing here.
   */
  if (entries.length > 1) {
    for (const stage of entries) {
      const triggers = stage.triggers ?? [];
      const anchored = triggers.some((t) => readableRunStage(t.when) === null);
      if (!anchored) {
        /*
         * A trigger whose run.stage this file can read and is a specific
         * stage id, not null, is not ambiguous — it plainly is not the fresh
         * anchor, and counts against the stage rather than saving it. Only a
         * trigger whose run.stage is wrapped in a form this file cannot read
         * at all ($or, $in, $not, $ne, ...) leaves real doubt about what it
         * claims, and that is the one case this refusal must not guess
         * through — round 1 of this rule treated "mentions run.stage at
         * all" as that doubt and missed the readable-but-not-null case
         * entirely (build's loop-back trigger, "run.stage": triage).
         */
        const ambiguous = triggers.some((t) => readableRunStage(t.when) === undefined && mentionsRunStage(t.when));
        if (!ambiguous) {
          problems.push({
            rule: "entry",
            message: `entry stage "${stage.id}" has no trigger anchored on "run.stage": null, ` +
              "so with several entry stages it can never be chosen for a fresh item",
          });
        }
        continue;
      }
      for (const t of triggers) {
        // A readable non-null anchor (a specific stage id) fires only from
        // that stage — exactly the loop-back purpose this check is meant to
        // leave alone. Only a trigger naming no stage at all is refused.
        if (readableRunStage(t.when) === undefined && !mentionsRunStage(t.when)) {
          problems.push({
            rule: "entry",
            message: `entry stage "${stage.id}" has a trigger${t.name ? ` ("${t.name}")` : ""} not anchored on ` +
              '"run.stage": null or on a stage, so it could also fire mid-workflow and drag a running item back',
          });
        }
      }
    }
  }

  // A stage id is used as an object key, so a reserved one is not a name but
  // a write to a prototype. Rejected here as well as in parseMarker: a
  // workflow file is a repo file, and a contributor's PR can edit it.
  for (const stage of w.stages) {
    if (isReservedId(stage.id)) {
      problems.push({
        rule: "stage-id",
        message: `stage id "${stage.id}" is a reserved object key and cannot be a stage`,
      });
    }
  }

  // A stage the item's own state places it at is reached by that state.
  for (const stage of w.stages) {
    if (!stage.entry && (stage.triggers?.length ?? 0) === 0 && !placedByState(stage)) {
      problems.push({ rule: "reachability", message: `nothing can reach stage "${stage.id}"` });
    }
  }

  // A person's turn runs no agent: a stage saying both would file an item
  // under Needs you while a paid step ran on it.
  for (const stage of w.stages) {
    if (stage.waits === "person" && stage.step !== undefined) {
      problems.push({
        rule: "waits",
        message: `stage "${stage.id}" waits on a person and runs step ${stage.step}: a person's turn runs no agent, so it cannot do both`,
      });
    }
    // Needs you asks a stage's waits before it asks terminal, so an item at
    // one saying both sat in Needs you, its work done, until it was closed.
    if (stage.waits === "person" && stage.terminal === true) {
      problems.push({
        rule: "waits",
        message: `stage "${stage.id}" is terminal and waits on a person: an item's work is done at a terminal stage, so it waits on no one there`,
      });
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

  /*
   * A goto names a stage the way a trigger does, and is consumed by the
   * entry record its target writes on arrival. A target that writes none
   * leaves the goto pending when the item lands, and a pending goto its
   * new stage does not list halts it there — so that is refused here, with
   * an unknown target and one named twice.
   */
  const stageById = new Map(w.stages.map((s) => [s.id, s]));
  for (const stage of w.stages) {
    const named = new Set<string>();
    for (const g of gotoTargetsOf(stage)) {
      if (named.has(g.stage)) problems.push({ rule: "goto", message: `stage "${stage.id}" names "${g.stage}" twice in goto` });
      named.add(g.stage);
      const target = stageById.get(g.stage);
      if (!target) {
        problems.push({ rule: "goto", message: `stage "${stage.id}" sends items to "${g.stage}", which is not in the workflow` });
      } else if (!recordsItsEntry(target)) {
        problems.push({
          rule: "goto",
          message: `stage "${stage.id}" sends items to "${g.stage}", which records no "${ENTRY_KIND}" naming {round}: ` +
            "its entry record is what consumes a goto, so the item would arrive with the goto still pending",
        });
      }
      if (g.when === null) continue;
      try {
        assertAllowedOperators(g.when);
      } catch (e) {
        problems.push({ rule: "operator", message: `stage "${stage.id}", goto "${g.stage}": ${messageOf(e)}` });
      }
    }
  }

  // The name the engine logs a goto transition under. A trigger of the same
  // name would read, in the event stream and on the board, as a person
  // sending the item back.
  for (const stage of w.stages) {
    for (const t of stage.triggers ?? []) {
      if (t.name === GOTO_TRIGGER) {
        problems.push({
          rule: "trigger-name",
          message: `stage "${stage.id}" names a trigger "${GOTO_TRIGGER}", the name a goto transition is logged under`,
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
        problems.push({ rule: "operator", message: `stage "${stage.id}": ${messageOf(e)}` });
      }
    }
  }

  for (const rule of w.eligible ?? []) {
    try {
      assertAllowedOperators(rule.when);
    } catch (e) {
      problems.push({ rule: "operator", message: `eligibility rule: ${messageOf(e)}` });
    }
  }

  // The allowlist is structural, so it must cover every condition a workflow
  // author can write — including a step's route conditions, not just stage
  // and eligibility conditions. Routes are not compiled/executed in this
  // plan, so this is not yet exploitable, but the next plan does compile
  // them, and the allowlist should not have a documented gap by then.
  for (const stage of w.stages) {
    const step = stage.step ? steps.get(stage.step) : undefined;
    // Reported here as well as refused at runtime, and this is the half that
    // matters: a capability nothing enforces is the operator reading the step
    // file, seeing the word, and believing they are covered. Meeting it at
    // runtime means finding out on an item already in flight.
    const unenforceable = unknownCapabilities(step?.capabilities);
    if (unenforceable.length) {
      problems.push({
        rule: "capability",
        message:
          `step ${stage.step} declares ${unenforceable.map((c) => `"${c}"`).join(", ")}, ` +
          `which nothing enforces; this engine enforces ${CAPABILITIES.join(", ")}` +
          retiredCapabilityPointers(unenforceable),
      });
    }
    for (const route of step?.output?.routes ?? []) {
      try {
        assertAllowedOperators(route.when);
      } catch (e) {
        problems.push({ rule: "operator", message: `step ${stage.step}, route: ${messageOf(e)}` });
      }
      if (route.goto !== undefined && !gotoTargetsOf(stage).some((g) => g.stage === route.goto)) {
        problems.push({
          rule: "goto",
          message: `step ${stage.step}'s route for ${JSON.stringify(route.when)} sends items to "${route.goto}", ` +
            `which stage "${stage.id}" does not list in goto, so every such answer would halt the item`,
        });
      }
    }
  }

  // `goto` and `from` are the engine's to write on a record: a route's goto is
  // checked against its stage's list above, and an effect field of either
  // name would carry one past that check — or overwrite, on an entry record,
  // the stage the item came from.
  //
  // And a placeholder the rename of ticket to item retired, in the prompt or
  // in any field the planner fills. Every pass leaves a name nobody answers
  // for visible, so nothing at runtime says so: the agent reads
  // `{ticket.body}` as text and a marker carries the literal `{ticket}`. A
  // stage's own `branch` is refused at load, in its own words.
  for (const stage of w.stages) {
    const step = stage.step ? steps.get(stage.step) : undefined;
    for (const pointer of retiredPointers(step?.prompt ?? "")) {
      problems.push({ rule: "placeholder", message: `step ${stage.step}'s prompt names a placeholder the rename retired; ${pointer}` });
    }
    const effects = [...(stage.on_enter ?? []), ...(step?.output?.routes ?? []).map((r) => r.effect)];
    for (const effect of effects) {
      for (const field of ["goto", "from"]) {
        if (field in effect) {
          problems.push({ rule: "reserved-field", message: `stage "${stage.id}" has an effect with a "${field}" field, which only the engine writes` });
        }
      }
      for (const [field, value] of Object.entries(effect)) {
        if (typeof value !== "string") continue;
        for (const pointer of retiredPointers(value)) {
          problems.push({
            rule: "placeholder",
            message: `stage "${stage.id}" has a ${effect.type} effect whose ${field} names a placeholder the rename retired; ${pointer}`,
          });
        }
      }
    }
  }

  return dedupe(problems);
}

/**
 * Each retired placeholder in `text`, once, as `"{ticket.body}" is now
 * "{item.body}"`. Read with core's own template syntax, so what counts as a
 * placeholder here is exactly what every pass would try to fill.
 */
function retiredPointers(text: string): string[] {
  const found = new Set<string>();
  fillTemplate(text, (name) => {
    const now = retiredPlaceholder(name);
    if (now !== null) found.add(`"{${name}}" is now "{${now}}"`);
    return undefined;
  });
  return [...found];
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

/**
 * The one stage a trigger can fire from, when its condition names exactly one.
 *
 * A top-level `"run.stage": "x"` is a conjunct of the whole condition, so the
 * trigger can fire from "x" and from nowhere else however the rest of the
 * document is written. Anything else — an $in list, a $ne, a mention buried
 * under $or, or no mention at all — names no single stage.
 */
function anchorOf(when: Condition): string | null {
  const top = when["run.stage"];
  return typeof top === "string" ? top : null;
}

/**
 * The run.stage value a condition can be read as, when it names one
 * reliably: a literal — a stage id, or null for "an item at no stage at
 * all" — at the top level, the same claim spelled as an operator
 * (`{ $eq: <literal> }`), or either form nested under $and at any depth. An
 * author writes `{ "run.stage": null, x: 0 }` and
 * `{ $and: [{ "run.stage": null }, { x: 0 }] }` to mean the same thing, so
 * both must read the same; recursing only into $and mirrors
 * boundsACounter's read of run.counters.*, since an $and member can only
 * narrow what a condition matches, never widen it.
 *
 * `undefined` means unreadable: no run.stage claim was found in a form this
 * function resolves — either there is none at all, or it is wrapped in an
 * operator this file does not read ($or, $in, $not, $ne, ...).
 * mentionsRunStage is what tells those two cases apart, because they are not
 * the same finding: "no mention" is refused, "mentioned but unreadable" is
 * abstained on.
 */
function readableRunStage(when: Condition): string | null | undefined {
  const top = when["run.stage"];
  if (top === null || typeof top === "string") return top;
  if (typeof top === "object" && top !== null && !Array.isArray(top)) {
    const eq = (top as Record<string, unknown>).$eq;
    if (eq === null || typeof eq === "string") return eq;
  }
  const and = when.$and;
  if (Array.isArray(and)) {
    for (const c of and) {
      if (typeof c !== "object" || c === null) continue;
      const found = readableRunStage(c as Condition);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * True when a trigger can only fire on an item that is at no stage at all.
 *
 * `{ "run.stage": null }` is how every workflow says "a fresh item", and it
 * is an edge from nothing rather than an unreadable one: run.stage is the
 * position, so on an item that has one this can never hold — and an item
 * that has none never reaches a trigger, because decide() sends it to the
 * entry stage without evaluating any. Reading it as "unreadable" is what
 * switched all three rules below off on every workflow that exists.
 */
function isFreshItemOnly(when: Condition): boolean {
  return readableRunStage(when) === null;
}

/**
 * True when a condition mentions run.stage anywhere — at the top level, or
 * nested under $and, $or or $not at any depth.
 *
 * This is the line "abstain rather than guess" draws for the entry rule: a
 * condition that never mentions run.stage at all cannot possibly anchor an
 * item to a position, so refusing it is not a guess. Everything that does
 * mention it but is not isFreshItemOnly — $or, $in, $not, $ne, or a form
 * this file has not been taught — is read here only far enough to know it
 * exists, never far enough to claim what it means, so the caller abstains
 * instead of reporting a possibly-wrong finding.
 */
function mentionsRunStage(when: Condition): boolean {
  if ("run.stage" in when) return true;
  for (const [key, value] of Object.entries(when)) {
    if ((key === "$and" || key === "$or") && Array.isArray(value)) {
      if (value.some((c) => typeof c === "object" && c !== null && mentionsRunStage(c as Condition))) return true;
    } else if (key === "$not" && typeof value === "object" && value !== null) {
      if (mentionsRunStage(value as Condition)) return true;
    }
  }
  return false;
}

/**
 * Edges the graph may have: a trigger that does not name its source is an edge
 * from every stage but its own.
 *
 * That is not a guess about the workflow, it is what decide() does — it
 * evaluates every *other* stage's triggers against the snapshot, so a trigger
 * saying nothing about position can fire wherever the item is. The shipped
 * workflow's `blocked` is exactly this: `{ "run.lastOutputValid": false }`.
 *
 * A superset of the real edge set, which is what dead-end and reachability
 * need — more edges can only mean fewer "no way out" and "unreachable"
 * reports, never one about a stage that has a way out.
 */
function possibleEdges(w: Workflow): Array<[string, string]> {
  const ids = w.stages.map((s) => s.id);
  const out: Array<[string, string]> = [];
  for (const stage of w.stages) {
    for (const t of stage.triggers ?? []) {
      const from = anchorOf(t.when);
      if (from !== null) {
        out.push([from, stage.id]);
      } else if (!isFreshItemOnly(t.when)) {
        for (const candidate of ids) if (candidate !== stage.id) out.push([candidate, stage.id]);
      }
    }
    for (const g of gotoTargetsOf(stage)) out.push([stage.id, g.stage]);
  }
  return out;
}

function adjacencyOf(edges: Array<[string, string]>): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const [from, to] of edges) adjacency.set(from, [...(adjacency.get(from) ?? []), to]);
  return adjacency;
}

/** Every stage id reachable from `start` over the given edges, start included. */
function reachableFrom(start: string, edges: Array<[string, string]>): Set<string> {
  const adjacency = adjacencyOf(edges);
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
 * Adjacency built from only the anchored edges whose own trigger does *not*
 * bound a run.counters.* path — the "unbounded" edges. Anchored only, and
 * deliberately: this is the *subset* of the real edge set, which is the
 * direction cycle-bound has to approximate in. Fewer edges can only mean
 * fewer cycles, never a cycle that is not there — where possibleEdges, the
 * superset dead-end and reachability read, would manufacture one out of every
 * pair of triggers that name no source. A cycle counts as bounded
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
      if (typeof from === "string" && !boundsACounter(t.when) && !waitsForAPerson(t.when)) {
        adjacency.set(from, [...(adjacency.get(from) ?? []), stage.id]);
      }
    }
    // A goto is an edge like a trigger's, and its cap is its `when`.
    for (const g of gotoTargetsOf(stage)) {
      if (g.when !== null && boundsACounter(g.when)) continue;
      adjacency.set(stage.id, [...(adjacency.get(stage.id) ?? []), g.stage]);
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

/**
 * Whether a stage's on_enter records that the state was entered, in a form
 * the engine can tell apart from the previous entry.
 *
 * Both halves matter. Without any entry record, assess() reads the stage's
 * first round as its last one forever: the loop runs its body exactly once
 * and the item ping-pongs between stages that all read "complete" until the
 * pass cap. With a record that is byte-identical every time round, the post
 * hook's satisfied() finds the first one already posted and reconcile drops
 * it — the same stall, with something in the file that looks like it should
 * work. "{round}" somewhere in the effect is what makes the second record a
 * new one; which field carries it is the tracker's business, not this rule's.
 */
function recordsItsEntry(stage: Stage): boolean {
  return (stage.on_enter ?? []).some(
    (e) => e.kind === ENTRY_KIND &&
      Object.values(e).some((v) => typeof v === "string" && v.includes("{round}")),
  );
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
 * A trigger that fires only on a person's own message bounds a loop as surely
 * as a counter does: every time round, it waits for someone to write, so the
 * loop cannot run away on its own. Triage's loops are this shape, and a round
 * cap there only cut a real back-and-forth short (#27).
 *
 * The exact value at the top level, and nothing looser: `$ne`, `$in` or an
 * `$or` could each match an agent's turn, and a check that let one through
 * would pass the very runaway this rule exists to catch.
 */
const waitsForAPerson = (c: Condition): boolean => c["run.lastEvent.actor"] === "human";

/**
 * An item two identities both place, when one can be shown — as its paths
 * and their values — or null. Built from what the two read, then handed to
 * the engine's own compiler, which must say each identity matches it: a
 * report names a real item, never a guess. The rule this replaced flagged
 * every pair it could not tell apart, so `$in: [approved]` beside `$nin:
 * [approved]` read as overlapping, and so did any `$lt`/`$gte` split.
 *
 * Built path by path, since a condition document is one conjunct per path:
 *
 * - the labels: every set of the labels the two name. Exhaustive for a bare
 *   label, `$eq`, `$ne`, `$in`, `$nin` and `$all`, which ask only which named
 *   labels an item carries — so where no set satisfies both, no item does.
 * - any other path: one value, tried from what the demands on it name — each
 *   literal and listed value, each bound and the numbers beside it, and a
 *   string none of them names for a `$ne`, a `$nin` or an `$exists`. Such a
 *   path holds one value, so two literals that differ are two positions, as
 *   `run.stage` is for every default identity, and `$lt: 3` beside `$gte: 3`
 *   finds no value; `$lt: 5` beside `$lt: 3` finds 2.
 *
 * Where nothing tried satisfies every demand, the pair is abstained on, and
 * so it is for $or, $and or $not at the top, one path inside another, a
 * reserved key, or more labels than are worth enumerating. Disjoint and
 * unknown both report nothing, which is the direction this rule may be wrong
 * in — between two custom identities. Beside a default one, see
 * `labelBesideFree`.
 */
function itemBothPlace(a: Condition, b: Condition): Record<string, unknown> | null {
  const paths = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  if (paths.some((p) => p.startsWith("$") || p.split(".").some(isReservedId))) return null;
  if (paths.some((p) => paths.some((q) => q.startsWith(`${p}.`)))) return null;
  const item: Record<string, unknown> = {};
  try {
    for (const path of paths) {
      const demands = [a, b].filter((c) => path in c).map((c) => c[path]);
      const found = path === LABELS_PATH ? labelsAll(demands) : valueAll(path, demands);
      if (found === null) return null;
      item[path] = found.value;
    }
    const snapshot = nested(item);
    return compile(a)(snapshot) && compile(b)(snapshot) ? item : null;
  } catch {
    // An operator outside the allowlist: the structural rules report it.
    return null;
  }
}

/**
 * Whether `placed` is placed by its label alone — the default identity,
 * `"run.stage": <its id>` — and `other` reads no position at all. Then any
 * item `other` holds, at `placed`'s stage, matches both, so the pair
 * overlaps unless `other` can never hold, which is a defect too. The
 * witness cannot build every such item — a `$regex`, a field that must be
 * absent, a top-level `$or`, a `$size` — and abstaining on those let a
 * workflow the rule before it refused validate clean and then halt every
 * such item, while the board, giving way to the label, showed it queued.
 */
function labelBesideFree(placed: Stage, other: Stage): boolean {
  const identity = identityOf(placed);
  const byLabel = Object.keys(identity).length === 1 && identity["run.stage"] === placed.id;
  return byLabel && other.identity !== undefined && !pathsIn(other.identity).includes("run.stage");
}

/** Past this many named labels, the sets to try outnumber what a validator should spend. */
const MOST_LABELS = 10;

/** A set of the named labels every demand on the labels accepts, or null when there is none. */
function labelsAll(demands: unknown[]): { value: string[] } | null {
  const named = [...new Set(demands.flatMap(stringsIn))];
  if (named.length > MOST_LABELS) return null;
  const accepts = demands.map((d) => compile({ [LABELS_PATH]: d }));
  for (let set = 0; set < 2 ** named.length; set++) {
    const labels = named.filter((_, i) => (set & (2 ** i)) !== 0);
    if (accepts.every((accept) => accept(nested({ [LABELS_PATH]: labels })))) return { value: labels };
  }
  return null;
}

/** A value at `path` every demand on it accepts, tried from what they name, or null when none is. */
function valueAll(path: string, demands: unknown[]): { value: unknown } | null {
  const accepts = demands.map((d) => compile({ [path]: d }));
  const value = valuesNamedBy(demands).find((v) => accepts.every((accept) => accept(nested({ [path]: v }))));
  return value === undefined ? null : { value };
}

const isScalar = (v: unknown): boolean => v === null || (typeof v !== "object" && v !== undefined);

/**
 * The single values worth trying at a path, from the demands on it: every
 * literal and listed value, each number a bound names with the one on either
 * side, and — for `$ne`, `$nin` and `$exists` — a string none of them names.
 */
function valuesNamedBy(demands: unknown[]): unknown[] {
  const named: unknown[] = [];
  let fresh = false;
  const visit = (op: string, operand: unknown): void => {
    if (op === "$in" || op === "$nin") {
      if (Array.isArray(operand)) named.push(...operand.filter(isScalar));
      fresh ||= op === "$nin";
    } else if (op === "$ne" || op === "$exists") {
      if (op === "$ne" && isScalar(operand)) named.push(operand);
      fresh = true;
    } else if (["$eq", "$lt", "$lte", "$gt", "$gte"].includes(op) && isScalar(operand)) {
      named.push(operand);
      if (typeof operand === "number" && op !== "$eq") named.push(operand - 1, operand + 1);
    }
  };
  for (const d of demands) {
    if (isScalar(d)) named.push(d);
    else if (d !== null && typeof d === "object" && !Array.isArray(d)) {
      for (const [op, operand] of Object.entries(d)) visit(op, operand);
    }
  }
  if (fresh) {
    let other = "other";
    for (let n = 2; named.includes(other); n++) other = `other-${n}`;
    named.push(other);
  }
  return [...new Set(named)];
}

/** Every string anywhere inside a demand: the labels it names. */
function stringsIn(demand: unknown): string[] {
  if (typeof demand === "string") return [demand];
  if (demand === null || typeof demand !== "object") return [];
  return Object.values(demand).flatMap(stringsIn);
}

/** The snapshot holding each dotted path's value where the compiler reads it. */
function nested(flat: Record<string, unknown>): Snapshot {
  const root: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(flat)) {
    const parts = path.split(".");
    const last = parts.pop() as string;
    let at = root;
    for (const part of parts) {
      const next = at[part];
      at = (at[part] = next !== null && typeof next === "object" ? next : {}) as Record<string, unknown>;
    }
    at[last] = value;
  }
  return root as Snapshot;
}

/**
 * A step that creates children and a close that drops them are one feature in
 * two places, and either half alone is a defect with no symptom until the
 * second round: children pile up beside their replacements, or a close runs
 * that can never find anything.
 *
 * `relations` is the declared relationship types, read off the same
 * `provided` list §11.8 already takes — every bare `rel.<type>` entry
 * `snapshotProvides` emits, with the prefix stripped. `null` means "unknown"
 * (provided is undefined, so path coverage is abstaining too), and the
 * follow-type check abstains along with it rather than guessing.
 */
function checkChildren(w: Workflow, steps: Map<string, Step>, relations: readonly string[] | null): Problem[] {
  const out: Problem[] = [];
  for (const stage of w.stages) {
    const creates = mayCreateItems(stage.step ? steps.get(stage.step)?.capabilities : undefined);
    const closes = (stage.on_enter ?? []).filter((e) => e.type === NODES_CLOSE_EFFECT);
    if (creates && !closes.length) {
      out.push({
        rule: "children",
        message: `stage "${stage.id}"'s step declares items:create but its on_enter has no nodes.close, ` +
          "so a re-run would leave the last round's children open beside the new ones",
      });
    }
    // Supersession drops a child whose origin round is below the round its
    // stage was last entered, and that round is counted from entry records.
    // A creating stage that writes none stays at round one for good, so no
    // re-run's plan ever replaces the last one's.
    const recordsEntry = (stage.on_enter ?? []).some((e) => e.type === RECORD_EFFECT && e.kind === ENTRY_KIND);
    if (creates && !recordsEntry) {
      out.push({
        rule: "children",
        message: `stage "${stage.id}"'s step declares items:create but its on_enter writes no entry record ` +
          `(a ${RECORD_EFFECT} with kind: ${ENTRY_KIND}), so its round never advances and a re-run's children ` +
          "never supersede the last round's",
      });
    }
    if (closes.length && !creates) {
      out.push({
        rule: "children",
        message: `stage "${stage.id}" declares nodes.close but its step does not declare items:create, ` +
          "so nothing it closes could ever exist",
      });
    }
    for (const c of closes) {
      const follow = c.follow;
      if (!Array.isArray(follow) || !follow.length || !follow.every((f) => typeof f === "string")) {
        out.push({
          rule: "children",
          message: `stage "${stage.id}": nodes.close needs a non-empty "follow" list of relationship types`,
        });
        continue;
      }
      if (relations === null) continue;
      for (const f of follow as string[]) {
        if (!relations.includes(f)) {
          out.push({
            rule: "children",
            message: `stage "${stage.id}": nodes.close follows "${f}", which no source declares`,
          });
        }
      }
    }
  }
  return out;
}

export function validateSemantics(w: Workflow, steps: Map<string, Step>, provided?: string[]): Problem[] {
  const problems: Problem[] = [];

  const relations = provided === undefined
    ? null
    : provided.filter((p) => /^rel\.[^.*]+$/.test(p)).map((p) => p.slice(4));
  problems.push(...checkChildren(w, steps, relations));

  /*
   * A non-terminal stage nothing leads away from is a trap, and an unbounded
   * cycle is a stuck workflow. Neither is decidable on the exact edge set —
   * a trigger can hide its source inside an operator — and the previous
   * answer to that was to abstain for the whole graph whenever any trigger
   * mentioned run.stage in a form the edge derivation could not read.
   *
   * `{ "run.stage": null }` was one of those forms, and it is the only way to
   * say "a fresh item", so all three rules were off for every workflow that
   * has an entry stage — which is every workflow. `landrace validate` on a
   * copy of the shipped workflow carrying an unbounded cycle, an unreachable
   * pair and a dead end reported none of them.
   *
   * So each rule reads the approximation that cannot invent a problem
   * instead: cycle-bound the subset, dead-end and reachability the superset.
   * A hidden edge now weakens one answer rather than withdrawing all three,
   * and "abstain rather than guess" is kept where it belongs — in which
   * direction each rule is allowed to be wrong.
   */
  const possible = possibleEdges(w);
  for (const stage of w.stages) {
    // Left when the state that places an item there stops saying so: by a
    // label coming off, not by a trigger.
    if (stage.terminal || placedByState(stage)) continue;
    if (!possible.some(([from]) => from === stage.id)) {
      problems.push({ rule: "dead-end", message: `stage "${stage.id}" has no way out and is not terminal` });
    }
  }

  for (const members of unboundedCycles(w)) {
    problems.push({ rule: "cycle-bound", message: cycleMessage(members) });
  }

  // Reachability from the entry stages, and from every stage the item's own
  // state places it at, over the same superset dead-end reads. A stage any
  // one of them reaches is reachable: a top-level item and a child start in
  // different places, an item placed by its labels starts wherever they put
  // it, and each walks its own part of the graph. No entry stage at all is
  // reported by validateStructure.
  const entries = w.stages.filter((s) => s.entry);
  const placed = w.stages.filter((s) => !s.entry && placedByState(s));
  if (entries.length + placed.length > 0) {
    const reachable = new Set<string>();
    for (const root of [...entries, ...placed]) for (const id of reachableFrom(root.id, possible)) reachable.add(id);
    const fromEntry = entries.length === 0
      ? null
      : entries.length === 1
        ? `the entry stage "${entries[0]?.id ?? ""}"`
        : `any entry stage (${entries.map((e) => e.id).join(", ")})`;
    const fromPlaced = placed.length === 0
      ? null
      : `a stage an item's own state places it at (${placed.map((s) => s.id).join(", ")})`;
    const from = [fromEntry, fromPlaced].filter((f) => f !== null).join(", nor from ");
    for (const stage of w.stages) {
      if (!reachable.has(stage.id)) {
        problems.push({ rule: "reachability", message: `stage "${stage.id}" is not reachable from ${from}` });
      }
    }
  }

  // assess() marks a stage with a `step` complete only once
  // run.outputs[stage.id] exists, and that can only ever be populated by an
  // "output"-kind entry recorded against *this stage's own id* — which only
  // a declared `output:` contract can ever produce (src/runner/step.ts
  // returns no effects at all for a step with none). A stage like this is
  // therefore unreachable-past: decide() invokes it, forever, on every
  // single pass, no matter how many times it runs. This was live in
  // .landrace/workflows/main/workflow.yaml for build, code-review and fix-review — 30 paid
  // opus invocations in one converge() call, then the same again on the
  // next poll.
  //
  // Declaring an output block is necessary but not sufficient: a route that
  // writes to the tracker *is* the record, so its own `effect` can override
  // the `kind` runStep would otherwise default to "output", or the `stage` it
  // would otherwise default to the stage's own id. A step whose *every* route
  // does one of those can never produce a same-stage "output" entry either,
  // and is exactly as stuck as one with no output block at all — just less
  // visibly so, since `output:` is right there in the file.
  //
  // A route to any other destination carries no record, so runStep plans one
  // beside it with the kind and stage fixed, and the route's fields describe
  // the destination rather than the record. There is nothing for such a route
  // to retarget, and flagging one would report a healthy workflow as broken.
  /*
   * Every stage that runs a step records that it started it. Not only the
   * stages in a cycle: that is the wrong question. `blocked -> spec` puts very
   * nearly every stage of the shipped workflow on a cycle anyway, a stage
   * joins one the moment somebody adds a trigger, and the cost of recording an
   * entry a stage turns out never to need is one comment. A cycle-scoped
   * version of this rule would also inherit whichever approximation it read
   * the cycles from, and neither direction is safe for a rule whose report is
   * about a single stage.
   */
  for (const stage of w.stages) {
    if (!stage.step || recordsItsEntry(stage)) continue;
    problems.push({
      rule: "entry-record",
      message: `stage "${stage.id}" runs a step but its on_enter records no "${ENTRY_KIND}" naming {round}, so a second round would be read as already complete and silently skipped`,
    });
  }

  for (const stage of w.stages) {
    if (!stage.step) continue;
    const step = steps.get(stage.step);
    if (!step) continue;
    if (!step.output) {
      problems.push({
        rule: "step-output-required",
        message: `stage "${stage.id}" names a step with no declared output, so assess() can never mark it complete and it can never be left`,
      });
      continue;
    }
    const producesOwnOutput = step.output.routes.some((route) => {
      if (route.effect.type !== RECORD_EFFECT) return true;
      const kind = route.effect.kind;
      const target = route.effect.stage;
      return (kind === undefined || kind === OUTPUT_KIND) && (target === undefined || target === stage.id);
    });
    if (!producesOwnOutput) {
      problems.push({
        rule: "step-output-required",
        message: `stage "${stage.id}"'s step declares an output, but every route retargets "kind" or "stage" away from this stage's own "output" entry, so assess() can never mark it complete either`,
      });
    }
  }

  for (const stage of w.stages) {
    const step = stage.step ? steps.get(stage.step) : undefined;
    const output = step?.output;
    if (!output) continue;
    for (const [shape, declared] of Object.entries(output.shapes)) {
      const routed = output.routes.some((r) => r.when[output.discriminator] === shape);
      if (!routed) {
        problems.push({
          rule: "totality",
          message: `step ${stage.step} declares output shape "${shape}" with no route`,
        });
      }

      /*
       * A declared shape is what decides which of an agent's fields become
       * snapshot state, so a field it names that can never travel is a rule
       * that silently does nothing. A reserved id is not a field name but a
       * reachable key on a plain object, and runner/step.ts drops it at the
       * boundary: the value never arrives, the trigger reading it never
       * matches, and the item waits with nothing to explain why.
       */
      if (declared === null || typeof declared !== "object" || Array.isArray(declared)) continue;
      for (const field of Object.keys(declared)) {
        if (!isReservedId(field)) continue;
        problems.push({
          rule: "shape-field",
          message: `step ${stage.step} shape "${shape}" declares a field named "${field}", which is a reserved object key and can never be carried in an output value`,
        });
      }
    }
  }

  /*
   * §11.5's other half: every declared enum value has an outbound *edge*, not
   * just an outbound route. A route says where the content goes; an edge says
   * where the item goes, and they are different questions — `triage`
   * declared `question` and `unclear`, routed both to a comment, and nothing
   * in the graph fired on either. An item that reached one sat at `triage`
   * wearing `lr:awaiting` for good, and the human's next reply did nothing,
   * because decide() excludes the current stage's own triggers.
   *
   * A trigger leads away from this stage when it mentions the stage at all —
   * anchored on it as a source, or reading anything under its `run.outputs`.
   * That second form matters: a trigger can say `run.outputs.s.kind: b` and
   * nothing about position, or wait on `run.outputs.s` existing at all, and
   * both are exits. A trigger that mentions neither is not counted even
   * though it may fire from anywhere: `blocked`'s
   * `{ "run.lastOutputValid": false }` can fire from every stage in the
   * shipped workflow and can never fire on a *valid* output, so crediting it
   * would leave this rule reporting nothing at all.
   *
   * Of those triggers, one claims a shape unless it demands a different one.
   * A demand written as an operator document ($in, $ne) or hidden under $or
   * is unreadable here and treated as claiming: over-reporting a healthy
   * workflow is how a rule gets switched off.
   */
  for (const stage of w.stages) {
    const output = stage.step ? steps.get(stage.step)?.output : undefined;
    if (!output) continue;
    const owned = `run.outputs.${stage.id}`;
    const path = `${owned}.${output.discriminator}`;
    const exits = w.stages
      .filter((other) => other.id !== stage.id)
      .flatMap((other) => other.triggers ?? [])
      .filter((t) =>
        anchorOf(t.when) === stage.id ||
        pathsIn(t.when).some((p) => p === owned || p.startsWith(`${owned}.`)));
    for (const shape of Object.keys(output.shapes)) {
      const claimed = exits.some((t) => {
        const demanded = t.when[path];
        return demanded === undefined || demanded === shape || typeof demanded === "object";
      });
      // A route that names a goto is its own edge: the answer sends the item there.
      const sent = output.routes.some((r) => r.when[output.discriminator] === shape && r.goto !== undefined);
      if (claimed || sent) continue;
      problems.push({
        rule: "shape-edge",
        message:
          `stage "${stage.id}" can produce output shape "${shape}" and no trigger leads away from it, ` +
          "so an item that produces one stops there for good",
      });
    }
  }

  for (let i = 0; i < w.stages.length; i++) {
    for (let j = i + 1; j < w.stages.length; j++) {
      const a = w.stages[i] as Stage;
      const b = w.stages[j] as Stage;
      const item = itemBothPlace(identityOf(a), identityOf(b));
      if (item !== null) {
        problems.push({
          rule: "identity",
          message: `stages "${a.id}" and "${b.id}" can both be the current position: an item with ${JSON.stringify(item)} matches both`,
        });
      } else if (labelBesideFree(a, b) || labelBesideFree(b, a)) {
        // In the words of the rule before the witness, which reported it.
        problems.push({
          rule: "identity",
          message: `stages "${a.id}" and "${b.id}" can both be the current position ` +
            "(this check only compares literal scalars, so a genuine $lt/$gt range split can false-positive here)",
        });
      }
    }
  }

  if (provided) {
    const known = new Set(provided);
    const covered = (path: string) =>
      known.has(path) || [...known].some((k) => k.endsWith("*") && path.startsWith(k.slice(0, -1)));
    const uncovered = (c: Condition | undefined, where: string): void => {
      for (const path of pathsIn(c ?? {})) {
        if (!covered(path)) {
          const now = retiredPlaceholder(path);
          problems.push({
            rule: "path-coverage",
            message: `${where} reads ${path}, which no hook provides${now === null ? "" : `; "${path}" is now "${now}"`}`,
          });
        }
      }
    };

    for (const stage of w.stages) {
      const conditions = [
        stage.identity, stage.requires, ...(stage.triggers ?? []).map((t) => t.when),
        ...gotoTargetsOf(stage).map((g) => g.when ?? undefined),
      ];
      for (const c of conditions) uncovered(c, `stage "${stage.id}"`);
    }

    /*
     * Eligibility rules too, and they are the quieter half. A trigger reading
     * a path nothing provides leaves one item where it is; an `eligible`
     * rule reading one skips *every* item in the repository, and `status`
     * prints the workflow's own `else` beside each, which reads exactly like
     * the rule doing its job. `item.assignee` written beside a hook that
     * provides `item.assignees` is how it arrives.
     */
    for (const rule of w.eligible ?? []) uncovered(rule.when, "eligibility rule");
  }

  return dedupe(problems);
}

/**
 * A stage's `branch` is where its step's worktree is checked out, and with
 * `agent.isolation` anything but `worktree` there is no worktree: the agent
 * commits wherever the operator's checkout happens to be, and the branch is
 * a promise nothing keeps. Asked by `validate` and refused by `start`, in the
 * same words, beside the workflow rules rather than among them because the
 * isolation is the runtime configuration's, not the workflow's.
 */
export function branchIsolationProblems(w: Workflow, isolation: string): Problem[] {
  if (isolation === "worktree") return [];
  return w.stages.flatMap((stage) => stage.branch === undefined ? [] : [{
    rule: "branch",
    message:
      `stage "${stage.id}" names the branch "${stage.branch}", but agent.isolation is "${isolation}": a branch is ` +
      "where a step's worktree is checked out, and without worktree isolation there is none, so the agent would " +
      "commit wherever this checkout is. Set agent.isolation: worktree, or drop the branch",
  }]);
}

/** The one path an admission label can satisfy a rule through. */
const LABELS_PATH = "node.state.labels";

/** The eligible rules that read the labels and nothing else: the only ones a label list can answer. */
const labelRules = (w: Workflow): EligibilityRule[] =>
  (w.eligible ?? []).filter((r) => Object.keys(r.when).length === 1 && LABELS_PATH in r.when);

/** Whether an item carrying exactly these labels passes the rule; throws on an operator outside the allowlist. */
const acceptsLabels = (r: EligibilityRule, labels: string[]): boolean =>
  compile(r.when)({ node: { state: { labels: [...labels] } } } as unknown as Snapshot);

/**
 * Why `b` certainly claims an item carrying exactly `admit`, or null when
 * that is not certain. Certain where `b` claims every item — it states no
 * eligible rule, or one reads what no listed item carries — and where its
 * eligibility is wholly a check of labels (every rule, and at least one)
 * that `admit` passes. Anything else could refuse what labels alone accept,
 * so the check abstains rather than guess.
 */
function claimsAdmitted(b: LoadedWorkflow, admit: string[]): string | null {
  const all = b.workflow.eligible ?? [];
  if (all.length === 0) return `${b.id} states no eligible rule, so it claims every item`;
  const unread = pathsNoNodeCarries(b.workflow);
  if (unread.length) {
    return `${b.id}'s eligible reads ${unread.join(", ")}, which no listed item carries, so it claims every item`;
  }
  const rules = labelRules(b.workflow);
  if (rules.length !== all.length) return null;
  try {
    return rules.every((r) => acceptsLabels(r, admit)) ? `admit [${admit.join(", ")}] satisfies ${b.id}'s eligible` : null;
  } catch {
    return null;
  }
}

/**
 * Two workflows over one source cannot both claim an item one of them
 * admits: `landrace_create_item` would start it in `a` and the next tick
 * would halt it, claimed twice.
 *
 * `sourceOf` names the source a workflow reads from, "" when that is not
 * known; two workflows are compared only when they name the same one — by
 * identity of the loaded source object, which is what the tick's own claims
 * go by. Reported only where `b`'s claim is certain (see `claimsAdmitted`).
 */
export function claimProblems(ws: Workspace, sourceOf: (id: string) => string): Problem[] {
  const problems: Problem[] = [];
  for (const a of ws.workflows) {
    const admit = a.workflow.admit ?? [];
    const source = sourceOf(a.id);
    if (admit.length === 0 || source === "") continue;
    for (const b of ws.workflows) {
      if (b === a || sourceOf(b.id) !== source) continue;
      const why = claimsAdmitted(b, admit);
      if (why !== null) problems.push({ rule: "claims", message: `workflows ${a.id} and ${b.id} both claim an item started in ${a.id} (${why})` });
    }
  }
  return problems;
}

/**
 * Whether what workflow `id` admits an item with is what its own eligibility
 * accepts. An item `landrace_create_item` starts there carries exactly those
 * labels, and one its rule turns away is skipped as ineligible on the next
 * tick: filed, reported started, and never worked.
 *
 * Each rule that is a check of the labels alone is asked, through the compiler
 * `decide` gates eligibility with, against a node carrying exactly the admitted
 * labels. All rules must pass, so one such rule they fail is a definite
 * failure whatever the others say. A rule reading anything else — an assignee,
 * a counter — cannot be answered from labels and is skipped rather than
 * guessed at; a workflow that admits nothing is not asked at all.
 *
 * An admitted label may not be one the engine writes itself: a stage or
 * working label there would put an item into a state nothing put it in.
 */
export function admitProblems(id: string, w: Workflow): Problem[] {
  const admit = w.admit ?? [];
  if (admit.length === 0) return [];
  const reserved: Problem[] = admit
    .filter((l) => l.startsWith(STAGE_LABEL_PREFIX) || (Object.values(LABELS) as unknown[]).includes(l))
    .map((l) => ({ rule: "admit", message: `workflow "${id}" admits "${l}", a label the engine writes itself` }));
  const rules = labelRules(w);
  let refused: typeof rules;
  try {
    refused = rules.filter((r) => !acceptsLabels(r, admit));
  } catch {
    // An operator outside the allowlist: the structural rules report it, and
    // a rule that cannot be compiled cannot be asked anything.
    return reserved;
  }
  return [...reserved, ...refused.map((r) => ({
    rule: "admit",
    message: `workflow "${id}" admits [${admit.join(", ")}] but its eligible rule "${r.else}" does not accept those labels`,
  }))];
}

export function validate(w: Workflow, steps: Map<string, Step>, provided?: string[]): Problem[] {
  return dedupe([...validateStructure(w, steps), ...validateSemantics(w, steps, provided)]);
}
