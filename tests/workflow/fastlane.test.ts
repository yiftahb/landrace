import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { compile, missingPaths } from "#core/index.js";
import type { LoadedWorkflow, Run, Snapshot, Step, Workflow, Workspace } from "#namespace.js";
import { splitSections } from "#workflow/extend.js";
import { admitProblems, claimProblems, validate } from "#workflow/validate.js";
import { loadWorkspace } from "#workflow/workspace.js";

/*
 * Fastlane, beside main in this repository's own workspace: an item labelled
 * lr:fast goes from its own text to a merged pull request, and a person is
 * needed only at a halt or when it is stuck. Read statically here — the
 * workflow as the loader builds it, and its triggers through the engine's
 * own compiler. Driving it end to end over the harness is a test of its own.
 */

let workspace: Workspace;

/** The stages that run a step, and so can fail one. */
const STEPPED = ["build", "code-review", "fix-review", "retro", "triage"];

beforeAll(async () => {
  workspace = await loadWorkspace(".landrace");
});

const flow = (id: string): LoadedWorkflow => {
  const found = workspace.workflows.find((w) => w.id === id);
  if (!found) throw new Error(`.landrace has no workflow ${id}; it has ${workspace.workflows.map((w) => w.id).join(", ")}`);
  return found;
};

const stepOf = (id: string, path: string): Step => {
  const step = flow(id).steps.get(path);
  if (!step) throw new Error(`${id} has no step ${path}; it has ${[...flow(id).steps.keys()].join(", ")}`);
  return step;
};

const sectionOf = (prompt: string, heading: string): string | undefined =>
  splitSections(prompt).sections.find((s) => s.heading === heading)?.text;

/** Whether an item carrying exactly these labels passes every one of a workflow's eligible rules. */
const accepts = (w: Workflow, labels: string[]): boolean =>
  (w.eligible ?? []).every((rule) => compile(rule.when)({ node: { state: { labels } } }));

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)])));
  return nested.flat();
}

describe("the .landrace workspace", () => {
  it("holds fastlane beside main, each started by a label of its own", () => {
    expect(workspace.workflows.map((w) => w.id)).toEqual(["fastlane", "main"]);
    const { workflow } = flow("fastlane");
    expect(workflow.name).toBe("Fastlane");
    expect(workflow.description.trim()).not.toBe("");
    expect(workflow.admit).toEqual(["lr:fast"]);
  });

  it("validates both workflows clean, and neither claims an item the other starts", () => {
    for (const { id, workflow, steps } of workspace.workflows) {
      expect({ id, problems: [...validate(workflow, steps), ...admitProblems(id, workflow)] }).toEqual({ id, problems: [] });
    }
    // One source, as the shipped hooks are one module both workflows load.
    expect(claimProblems(workspace, () => "the project's source")).toEqual([]);
    // And not by abstaining: both rules are labels alone, and each refuses the other's label.
    expect(accepts(flow("fastlane").workflow, ["lr:fast"])).toBe(true);
    expect(accepts(flow("fastlane").workflow, ["lr:auto"])).toBe(false);
    expect(accepts(flow("main").workflow, ["lr:auto"])).toBe(true);
    expect(accepts(flow("main").workflow, ["lr:fast"])).toBe(false);
  });

  it("leaves lr:fast to the workflow: the engine names it nowhere", async () => {
    const named: string[] = [];
    for (const file of await filesUnder("src")) if ((await readFile(file, "utf8")).includes("lr:fast")) named.push(file);
    expect(named).toEqual([]);
  });
});

describe("fastlane's steps", () => {
  it("builds on main's build, from the item's own text and its checks rather than a spec", () => {
    const { prompt, ...front } = stepOf("fastlane", "steps/build.md");
    const { prompt: base, ...baseFront } = stepOf("main", "steps/build.md");
    expect(front).toEqual(baseFront);
    expect(splitSections(prompt).sections.map((s) => s.heading)).toEqual(splitSections(base).sections.map((s) => s.heading));
    for (const heading of ["Procedure", "Rules"]) expect(sectionOf(prompt, heading)).toBe(sectionOf(base, heading));

    const what = sectionOf(prompt, "What to build") ?? "";
    expect(what).toContain("{brief.project.body}");
    expect(what).toContain("{brief.project.ci}");
    expect(what).toContain("{run.lastHuman.data.body}");
    expect(prompt).not.toContain("{brief.spec.content}");
    expect(prompt).not.toContain("{artifacts.spec.url}");
  });

  it("judges a reply with main's judge, into four answers of its own", () => {
    const triage = stepOf("fastlane", "steps/triage.md");
    const base = stepOf("main", "steps/triage.md");
    expect({ model: triage.model, capabilities: triage.capabilities }).toEqual({ model: base.model, capabilities: base.capabilities });
    expect(splitSections(triage.prompt).lead.trim()).toBe(splitSections(base.prompt).lead.trim());

    const intents = ["rework", "close", "question", "unclear"];
    expect(triage.output?.discriminator).toBe("intent");
    expect(Object.keys(triage.output?.shapes ?? {})).toEqual(intents);
    // Each answer recorded the way main's are, and none sends the item anywhere itself: the triggers do.
    expect(triage.output?.routes).toEqual(intents.map((intent) => ({
      when: { intent }, effect: { type: "tracker.comment", marker: "intent:{round}" },
    })));
    const procedure = sectionOf(triage.prompt, "Procedure") ?? "";
    for (const intent of intents) expect(procedure).toContain(`\`${intent}\``);
    expect(procedure).not.toMatch(/goto-|`approve`|`revise`/);
  });

  it.each(["code-review", "fix-review", "retro"])("runs main's own %s step, unchanged", (id) => {
    const stage = flow("fastlane").workflow.stages.find((s) => s.id === id);
    expect(stage?.step).toBe(`../main/steps/${id}.md`);
    expect(stepOf("fastlane", `../main/steps/${id}.md`)).toEqual(stepOf("main", `steps/${id}.md`));
  });
});

describe("fastlane's stages", () => {
  const stage = (id: string) => flow("fastlane").workflow.stages.find((s) => s.id === id);

  it("waits on a person only when it is stuck; a halt is a person's by being a halt", () => {
    expect(flow("fastlane").workflow.stages.filter((s) => s.waits === "person").map((s) => s.id)).toEqual(["stuck"]);
  });

  /*
   * The merge before the position moves, as publish pushes before it does:
   * a refusal then leaves the item at ci, where the next tick re-plans the
   * merge and halts again with the forge's reason. Moved past it, the
   * refusal would read as an open pull request at merge — a moved head —
   * and send the item back to review instead of to a person.
   */
  it("merges before it moves the item to merge, guarded on the item's own branch", () => {
    const types = (stage("merge")?.on_enter ?? []).map((e) => e.type);
    expect(types.indexOf("pull.merge")).toBeLessThan(types.indexOf("tracker.status"));
    expect(stage("merge")?.on_enter).toContainEqual({ type: "pull.merge", branch: "landrace/{item}" });
  });

  it.each(["done", "closed"])("closes the item at %s and takes its labels off", (id) => {
    const effects = stage(id)?.on_enter ?? [];
    expect(stage(id)?.terminal).toBe(true);
    expect(effects).toContainEqual({ type: "tracker.close" });
    const removed = effects.flatMap((e) => (e.type === "tracker.label" ? (e.remove as string[]) : []));
    expect(removed).toEqual(expect.arrayContaining(["lr:fast", "lr:working", "lr:awaiting"]));
  });

  it("lets a halt send the item back to every step it has, and only to those", () => {
    const stepped = flow("fastlane").workflow.stages.filter((s) => s.step).map((s) => s.id).sort();
    expect(stepped).toEqual(STEPPED.slice().sort());
    for (const halt of ["blocked", "screened"]) {
      expect((stage(halt)?.goto ?? []).map((g) => (typeof g === "string" ? g : g.stage)).sort()).toEqual(stepped);
    }
  });
});

/*
 * Every exit from one stage is exclusive: two triggers matching one item is
 * an ambiguity halt, and none matching is an item that waits for ever. For
 * each stage, every combination of the boundary values its exits read — a
 * cap less one and the cap, friction on and off, checks pending, failed or
 * green, threads awaiting a fix or answered, the pull request merged or not —
 * is put to every other stage's triggers through the engine's own compiler,
 * as decide() puts them, and exactly the exit the plan names must match.
 * Nothing matches only where the plan means a wait.
 */

/** The facts a fastlane trigger reads at one item. */
interface Facts {
  stage: string;
  valid?: false | null;
  refused?: boolean;
  previous?: string;
  actor?: "agent" | "human";
  intent?: string;
  counters?: Record<string, number>;
  total?: number;
  notMerged?: number;
  awaitingFix?: number;
  openThreads?: number;
  ciPending?: number;
  ciFailed?: number;
}

/**
 * The snapshot an item with these facts reads as. A counter at zero is left
 * out, as the engine derives one: a stage that never ran has no counter at
 * all. A build has always run, and an earlier reply's answer is still on the
 * item wherever it is now — a trigger routing on it must not fire elsewhere.
 */
function snapshotOf(f: Facts): Snapshot {
  const run: Run = {
    stage: f.stage,
    counters: Object.fromEntries(Object.entries(f.counters ?? {}).filter(([, n]) => n > 0)),
    rounds: {},
    outputs: { build: { kind: "done" }, triage: { intent: f.intent ?? "rework" } },
    lastEvent: { actor: f.actor ?? "agent", at: null },
    lastHuman: null,
    lastOutputValid: f.valid ?? null,
    lastRefused: f.valid === false ? f.refused ?? false : null,
    goto: null,
    cleared: null,
    previousStage: f.previous ?? null,
    failedStages: f.valid === false ? [f.stage] : [],
    failedStage: null,
    unblockedAt: 0,
    pairing: null,
    lastOutputBy: "agent",
  };
  const total = f.total ?? 1;
  const notMerged = f.notMerged ?? total;
  const sum = { awaitingFix: f.awaitingFix ?? 0, openThreads: f.openThreads ?? 0, ciPending: f.ciPending ?? 0, ciFailed: f.ciFailed ?? 0 };
  return {
    run,
    rel: { implements: {
      in: { total, is: { merged: total - notMerged }, not: { merged: notMerged }, sum, stage: {} },
      out: { total: 0, is: {}, not: {}, sum: {}, stage: {} },
    } },
  };
}

/** Each axis's values, every combination of them. A `counters.<stage>` axis sets that counter. */
function grid(stage: string, axes: Record<string, readonly unknown[]>, base: Partial<Facts> = {}): Facts[] {
  let out: Facts[] = [{ ...base, stage }];
  for (const [axis, values] of Object.entries(axes)) {
    out = out.flatMap((f) => values.map((v): Facts => (axis.startsWith("counters.")
      ? { ...f, counters: { ...f.counters, [axis.slice("counters.".length)]: v as number } }
      : { ...f, [axis]: v })));
  }
  return out;
}

const count = (f: Facts, stage: string): number => f.counters?.[stage] ?? 0;
const friction = (f: Facts): boolean => count(f, "build") > 1 || count(f, "fix-review") > 0 || count(f, "triage") > 0;

/** Each stage, the boundary values its exits read, and where the plan sends an item with those facts — null for a wait. */
const STAGES: Array<[string, Record<string, readonly unknown[]>, (f: Facts) => string | null]> = [
  ["build", {}, () => "publish"],
  // No pull request at publish is no exit: pull.open lands before the position moves there.
  ["publish", { total: [0, 1] }, (f) => ((f.total ?? 1) > 0 ? "code-review" : null)],
  ["code-review", {
    awaitingFix: [0, 1], openThreads: [0, 1], notMerged: [0, 1], "counters.code-review": [3, 4],
  }, (f) => {
    if ((f.awaitingFix ?? 0) > 0) return count(f, "code-review") < 4 ? "fix-review" : "stuck";
    if ((f.openThreads ?? 0) > 0) return "stuck";
    return (f.notMerged ?? 1) > 0 ? "ci" : "done";
  }],
  ["fix-review", { "counters.fix-review": [7, 8] }, (f) => (count(f, "fix-review") < 8 ? "code-review" : "stuck")],
  // Checks still running is the one wait here.
  ["ci", {
    ciPending: [0, 1], ciFailed: [0, 1], notMerged: [0, 1],
    "counters.build": [1, 2, 3], "counters.fix-review": [0, 1], "counters.triage": [0, 1], "counters.retro": [0, 1],
  }, (f) => {
    if ((f.ciFailed ?? 0) > 0) return count(f, "build") < 3 ? "build" : "stuck";
    if ((f.ciPending ?? 0) > 0) return null;
    return count(f, "retro") < 1 && friction(f) && (f.notMerged ?? 1) > 0 ? "retro" : "merge";
  }],
  ["retro", {}, () => "code-review"],
  ["merge", { notMerged: [0, 1], "counters.code-review": [3, 4] }, (f) => {
    if ((f.notMerged ?? 1) === 0) return "done";
    return count(f, "code-review") < 4 ? "code-review" : "stuck";
  }],
  ["triage", { intent: ["rework", "close", "question", "unclear"], previous: ["stuck", "blocked", "screened"] }, (f) => {
    if (f.intent === "rework") return "build";
    if (f.intent === "close") return "closed";
    return f.previous ?? null;
  }],
  // A person's turn: only their own message moves the item on.
  ...["stuck", "blocked", "screened"].map((home): [string, Record<string, readonly unknown[]>, (f: Facts) => string | null] =>
    [home, { actor: ["agent", "human"] }, (f) => (f.actor === "human" ? "triage" : null)]),
];

/** What decide() weighs once a stage has settled: every other stage's triggers, through the engine's compiler. */
const exitsFrom = (w: Workflow, f: Facts): string[] => {
  const s = snapshotOf(f);
  return w.stages
    .filter((candidate) => candidate.id !== f.stage)
    .flatMap((candidate) => (candidate.triggers ?? [])
      .filter((t) => compile(t.when)(s))
      .map((t) => `${candidate.id}: ${t.name ?? ""}`));
};

const label = (f: Facts): string => JSON.stringify({ ...f, stage: undefined });
const stageOf = (exit: string): string => exit.split(":")[0] ?? exit;

describe("every exit from a fastlane stage is exclusive", () => {
  it.each(STAGES)("from %s, exactly the exit the plan names matches, at every boundary", (stage, axes, to) => {
    const { workflow } = flow("fastlane");
    const facts = grid(stage, axes);
    const got = facts.map((f) => [label(f), exitsFrom(workflow, f).map(stageOf)]);
    const want = facts.map((f) => [label(f), [to(f)].filter((x) => x !== null)]);
    expect(got).toEqual(want);

    // And for the right reason: each exit reads only paths these facts carry
    // — a counter at zero is absent, as the engine leaves it — and the grid
    // reaches every one of them.
    const anchored = workflow.stages.flatMap((s) => (s.triggers ?? []).filter((t) => t.when["run.stage"] === stage).map((t) => ({ to: s.id, t })));
    expect(anchored.length).toBeGreaterThan(0);
    const missing = facts.flatMap((f) => anchored.flatMap(({ t }) => missingPaths(t.when, snapshotOf(f)).filter((p) => !p.startsWith("run.counters."))));
    expect([...new Set(missing)]).toEqual([]);
    const reached = new Set(facts.flatMap((f) => exitsFrom(workflow, f)));
    expect(anchored.map(({ to: id, t }) => `${id}: ${t.name ?? ""}`).filter((exit) => !reached.has(exit))).toEqual([]);
  });

  it.each(STEPPED.flatMap((stage) => [false, true].map((refused) => [stage, refused] as const)))(
    "a failed round of %s goes to its halt alone (refused: %s)",
    (stage, refused) => {
      const axes = STAGES.find(([id]) => id === stage)?.[1] ?? {};
      const facts = grid(stage, axes, { valid: false, refused });
      const halt = refused ? "screened" : "blocked";
      expect(facts.map((f) => [label(f), exitsFrom(flow("fastlane").workflow, f).map(stageOf)]))
        .toEqual(facts.map((f) => [label(f), [halt]]));
    },
  );
});
