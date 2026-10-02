import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gotoTargetsOf } from "#core/goto.js";
import { compile, decide, eligibilityOfNode, gotoDeclined, gotoNotListed, missingPaths } from "#core/index.js";
import { globMatches } from "#kit/forge.js";
import type { Condition, LoadedWorkflow, Run, Snapshot, Stage, Step, Workflow, Workspace } from "#namespace.js";
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

const stageOf = (id: string): Stage => {
  const found = flow("fastlane").workflow.stages.find((s) => s.id === id);
  if (!found) throw new Error(`fastlane has no stage ${id}`);
  return found;
};

const stepOf = (id: string, path: string): Step => {
  const step = flow(id).steps.get(path);
  if (!step) throw new Error(`${id} has no step ${path}; it has ${[...flow(id).steps.keys()].join(", ")}`);
  return step;
};

const sectionOf = (prompt: string, heading: string): string | undefined =>
  splitSections(prompt).sections.find((s) => s.heading === heading)?.text;

/** Text as one line, for a phrase a prompt wraps across lines. */
const flat = (text: string | undefined): string => (text ?? "").replace(/\s+/g, " ");

/** A step's lead, paragraph by paragraph. */
const paragraphsOf = (prompt: string): string[] =>
  splitSections(prompt).lead.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p !== "");

/** main's lead without the spec it embeds: the paragraph framing it, the spec between its rules, and the page's link. */
const withoutSpec = (paragraphs: string[]): string[] =>
  paragraphs.filter((p) => !/approved spec|\{brief\.spec\.content\}|\{artifacts\.spec\.url\}/.test(p));

/** A fastlane lead without the item it embeds: the paragraph framing it, through the item's closing rule. */
function withoutItem(paragraphs: string[]): { rest: string[]; item: string[] } {
  const opens = paragraphs.findIndex((p) => p.startsWith("--- the item ---"));
  const closes = paragraphs.findIndex((p) => p.endsWith("--- end of the item ---"));
  if (opens < 1 || closes < opens) return { rest: paragraphs, item: [] };
  return { rest: [...paragraphs.slice(0, opens - 1), ...paragraphs.slice(closes + 1)], item: paragraphs.slice(opens - 1, closes + 1) };
}

/** The item, as every fastlane step that embeds it does: its number, title and text between two rules. */
const ITEM = "--- the item ---\n#{node.id}: {node.title}\n\n{brief.project.body}\n--- end of the item ---";

/** Whether an item carrying exactly these labels passes every one of a workflow's eligible rules. */
const accepts = (w: Workflow, labels: string[]): boolean =>
  (w.eligible ?? []).every((rule) => compile(rule.when)({ node: { state: { labels } } }));

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)])));
  return nested.flat();
}

describe("the .landrace workspace", () => {
  /*
   * The label model (the user's, 2026-10-02): `lr:auto` is "Landrace manages
   * this item", and `lr:fast` routes it to fastlane instead of full-cycle.
   * full-cycle admits lr:auto and turns lr:fast away; fastlane admits, and
   * needs, both.
   */
  it("holds fastlane beside full-cycle: lr:auto starts either, and lr:fast says which", () => {
    expect(workspace.workflows.map((w) => w.id)).toEqual(["fastlane", "full-cycle"]);
    const { workflow } = flow("fastlane");
    expect(workflow.name).toBe("Fastlane");
    expect(workflow.description.trim()).not.toBe("");
    expect(workflow.admit).toEqual(["lr:auto", "lr:fast"]);
    expect(flow("main").workflow.admit).toEqual(["lr:auto"]);
  });

  it("validates both workflows clean, and neither claims an item the other starts", () => {
    for (const { id, workflow, steps } of workspace.workflows) {
      expect({ id, problems: [...validate(workflow, steps), ...admitProblems(id, workflow)] }).toEqual({ id, problems: [] });
    }
    // One source, as the shipped hooks are one module both workflows load.
    expect(claimProblems(workspace, () => "the project's source")).toEqual([]);
    // And not by abstaining: both rules are labels alone, and each turns the other's start away.
    expect(accepts(flow("fastlane").workflow, ["lr:auto", "lr:fast"])).toBe(true);
    expect(accepts(flow("fastlane").workflow, ["lr:auto"])).toBe(false);
    expect(accepts(flow("fastlane").workflow, ["lr:fast"])).toBe(false);
    expect(accepts(flow("full-cycle").workflow, ["lr:auto"])).toBe(true);
    expect(accepts(flow("full-cycle").workflow, ["lr:auto", "lr:fast"])).toBe(false);
    expect(accepts(flow("full-cycle").workflow, ["lr:fast"])).toBe(false);
  });

  it.each([
    ["fastlane", ["lr:fast"], "no lr:auto label"],
    ["fastlane", ["lr:auto"], "no lr:fast label"],
    ["main", ["lr:fast"], "no lr:auto label"],
    ["main", ["lr:auto", "lr:fast"], "a fastlane item (lr:fast)"],
  ])("turns %s's item labelled %j away, saying %s", (id, labels, reason) => {
    const node = { id: "1", kind: "item", title: "t", link: "", closed: null, priority: null, origin: null, state: { labels, assignees: [] } };
    expect(eligibilityOfNode(flow(id).workflow, node)).toEqual({ eligible: false, reason });
  });

  /*
   * A finished item keeps what admitted it, so the board files it under the
   * workflow that worked it rather than on every page: no stage of either
   * workflow takes an admit label off — `done` and `closed` remove only
   * the engine's own working, waiting and halt labels.
   */
  it.each(["main", "fastlane"])("never takes %s's admit labels off, finishing or not", (id) => {
    const { workflow } = flow(id);
    const admit = new Set(workflow.admit ?? []);
    const removed = workflow.stages.flatMap((stage) => (stage.on_enter ?? [])
      .filter((e) => e.type === "tracker.label")
      .flatMap((e) => ((e.remove as string[] | undefined) ?? []).filter((l) => admit.has(l)).map((l) => `${stage.id}: ${l}`)));
    expect(removed).toEqual([]);
  });

  it.each([
    ["main", "done", ["lr:awaiting", "lr:working"]],
    ["fastlane", "done", ["lr:awaiting", "lr:working", "lr:blocked", "lr:screened"]],
    ["fastlane", "closed", ["lr:awaiting", "lr:working", "lr:blocked", "lr:screened"]],
  ])("finishes %s's item at %s taking off only %j", (id, stage, labels) => {
    const found = flow(id).workflow.stages.find((s) => s.id === stage);
    const label = (found?.on_enter ?? []).filter((e) => e.type === "tracker.label");
    expect(label).toEqual([{ type: "tracker.label", remove: labels }]);
  });

  /*
   * Adding lr:fast to an item main is working moves it to fastlane, at the
   * same stage where fastlane has one; at a stage fastlane lacks — main's
   * spec stages — it is placed nowhere, and halts for a person rather than
   * starting over at build.
   */
  it("halts, unplaced, an item main had at a spec stage, and carries on one at code review", () => {
    const fastlane = flow("fastlane").workflow;
    const relabelled = (stage: string): Snapshot => ({
      ...snapshotOf({ stage, counters: { [stage]: 1 } }),
      node: { id: "1", kind: "item", state: { labels: ["lr:auto", "lr:fast", `lr:stage:${stage}`], assignees: [] } },
    });
    expect(decide(fastlane, relabelled("spec")))
      .toMatchObject({ action: "halt", why: expect.stringMatching(/already run spec but has no position/) });
    expect(decide(fastlane, relabelled("code-review"))).toMatchObject({ stage: { id: "code-review" } });
  });

  it("leaves lr:fast to the workflow: the engine names it nowhere", async () => {
    const named: string[] = [];
    for (const file of await filesUnder("src")) if ((await readFile(file, "utf8")).includes("lr:fast")) named.push(file);
    expect(named).toEqual([]);
  });
});

/*
 * The header's conventions for a way on the forge can refuse, held in both
 * workflows alike. A refusal on the way into a stage is recorded as that
 * stage's rejected round and read where the item still stands, as
 * `run.lastOutputValid: false` — so a trigger leaving that stage which does
 * not read it would match beside the halt's, and the item would halt on the
 * ambiguity where no board shows it. A person's own message is outdated by
 * the record, which is the bot's, so a trigger reading one needs nothing.
 */
describe.each(["full-cycle", "fastlane"])("%s's ways the forge can refuse", (id) => {
  const PULL_EFFECTS = ["pull.open", "pull.merge", "pull.close"];
  const workflowOf = (): Workflow => flow(id).workflow;
  const pullingIn = (w: Workflow): Stage[] => w.stages.filter((s) => !s.step && (s.on_enter ?? []).some((e) => PULL_EFFECTS.includes(e.type)));

  /*
   * A halt is where a refusal is taken from, so a way out of one need not
   * read it: after a Retry the forge refused again, `run.lastOutputValid` is
   * false at the halt itself, and a pull request a person then merged by
   * hand would leave the item there for good.
   */
  it("reads `run.lastOutputValid: null` on every trigger leaving a stage with no step, but a person's own message or a way out of a halt", () => {
    const workflow = workflowOf();
    const halts = new Set(workflow.stages.filter((s) => (s.triggers ?? []).some((t) => t.when["run.lastOutputValid"] === false)).map((s) => s.id));
    const stepless = new Set(workflow.stages.filter((s) => !s.step && !halts.has(s.id)).map((s) => s.id));
    const unguarded = workflow.stages.flatMap((s) => (s.triggers ?? [])
      .filter((t) => {
        const from = t.when["run.stage"];
        return typeof from === "string" && stepless.has(from) && !("run.lastEvent.actor" in t.when) && t.when["run.lastOutputValid"] !== null;
      })
      .map((t) => `${s.id}: ${t.name ?? ""}`));
    expect(unguarded).toEqual([]);
  });

  /*
   * Code review's push is a way the forge can refuse too (separation review
   * M2): the record first, so a refused push is its rejected round; the push
   * before the status, so a crash between them leaves the item where it was.
   */
  it("records code review's entry before its push, and pushes before the status moves the item", () => {
    const review = workflowOf().stages.find((s) => s.id === "code-review");
    expect((review?.on_enter ?? []).map((e) => e.type)).toEqual(["tracker.comment", "branch.push", "tracker.status", "tracker.label"]);
  });

  it("writes its entry record first wherever a stage with no step opens, merges or closes a pull request", () => {
    const pulling = pullingIn(workflowOf());
    expect(pulling.map((s) => s.id).sort()).toEqual(id === "full-cycle" ? ["publish"] : ["closed", "merge", "publish"]);
    for (const stage of pulling) {
      expect([stage.id, stage.on_enter?.[0]]).toEqual([stage.id, expect.objectContaining({ type: "tracker.comment", kind: "enter", marker: "enter:{stage}:{round}" })]);
    }
  });

  it("lets a halt Retry each of them, only as what failed and within rounds of its own, taking the halt's labels off", () => {
    const workflow = workflowOf();
    const pulling = pullingIn(workflow);
    const halts = workflow.stages.filter((s) => (s.triggers ?? []).some((t) => t.when["run.lastOutputValid"] === false));
    expect(halts.map((h) => h.id).sort()).toEqual(["blocked", "screened"]);
    for (const halt of halts) {
      for (const stage of pulling) {
        const target = gotoTargetsOf(halt).find((g) => g.stage === stage.id);
        expect([halt.id, stage.id, target?.when?.[`run.counters.${stage.id}`]]).toEqual([halt.id, stage.id, { $lt: 3 }]);
        // Retry's alone, declared: only while it is what failed, so "Go to step…" never takes an item there past a review.
        expect([halt.id, stage.id, target?.retryOnly, target?.when?.["run.failedStage"]]).toEqual([halt.id, stage.id, true, undefined]);
        const removed = (stage.on_enter ?? []).flatMap((e) => (e.type === "tracker.label" ? (e.remove as string[]) : []));
        expect([stage.id, removed]).toEqual([stage.id, expect.arrayContaining(["lr:blocked", "lr:screened"])]);
      }
    }
  });
});

/*
 * What fastlane's steps change of main's, and nothing more: each replaced
 * part named here, everything else word for word.
 */

/** The paragraphs a fastlane lead adds to main's, beside the item. */
const ADDED: Record<string, RegExp[]> = {
  // A lesson commit changes agent instructions, not the item: judged for what it loosens.
  "code-review": [/^Commits titled `retro: lessons from #\{node\.id\}` change agent instructions/],
  "fix-review": [],
  // Every file a lesson goes in is protected (re-review N1): a retro's commit is a person's to merge.
  retro: [/^Here the code reviewer checks what you change, and then a person merges it/],
};

/** main's retro promises a person reads the commit before the merge; fastlane's says the reviewer reads it first. */
const RETRO_PROMISE = "and a person\nreads it beside the commit before they merge.";
const RETRO_REVIEWED = "and if you\ncommit, the code reviewer checks the commit, then a person reads both before\nthey merge.";

describe("fastlane's steps", () => {
  it("builds on main's build, from the item's own text and its checks rather than a spec", () => {
    const { prompt, ...front } = stepOf("fastlane", "steps/build.md");
    const { prompt: base, ...baseFront } = stepOf("full-cycle", "steps/build.md");
    expect(front).toEqual(baseFront);
    expect(splitSections(prompt).sections.map((s) => s.heading)).toEqual(splitSections(base).sections.map((s) => s.heading));
    for (const heading of ["Procedure", "Rules"]) expect(sectionOf(prompt, heading)).toBe(sectionOf(base, heading));

    const what = sectionOf(prompt, "What to build") ?? "";
    expect(what).toContain("{brief.project.body}");
    expect(what).toContain("{brief.project.ci}");
    expect(flat(what)).toContain("wherever this step says the spec, it means this text");
    // A person's message is this round's work only when a reply sent it, as fix-review scopes it.
    expect(what).toContain("{run.lastHuman.data.body}");
    expect(what).toContain("This round was sent here from: {run.previousStage}");
    expect(flat(what)).toContain("When the round was sent from anywhere else, that message is an older one, already handled: ignore it.");
    expect(prompt).not.toContain("{brief.spec.content}");
    expect(prompt).not.toContain("{artifacts.spec.url}");
  });

  it("judges a reply with main's judge, into four answers of its own", () => {
    const triage = stepOf("fastlane", "steps/triage.md");
    const base = stepOf("full-cycle", "steps/triage.md");
    expect({ model: triage.model, capabilities: triage.capabilities }).toEqual({ model: base.model, capabilities: base.capabilities });
    // main's lead, and no item: a body the screener refuses would refuse every reply too.
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

  /*
   * main's review, fix and retro, with the one thing in them fastlane does
   * not have — the spec — replaced by the item's own text, framed the way
   * main frames the spec. Beside it, what fastlane's own lack of a person
   * needs said (ADDED, and the retro's promise). Everything else in the lead
   * is main's word for word, and every other section is main's.
   */
  it.each(["code-review", "fix-review", "retro"])("runs main's %s with the item's own text where main's has the spec", (id) => {
    expect(stageOf(id).step).toBe(`steps/${id}.md`);
    const { prompt, ...front } = stepOf("fastlane", `steps/${id}.md`);
    const { prompt: base, ...baseFront } = stepOf("full-cycle", `steps/${id}.md`);
    expect(front).toEqual(baseFront);

    const own = splitSections(prompt).sections;
    const theirs = splitSections(base).sections.map((s) => (id === "retro" && s.heading === "Procedure"
      ? { ...s, text: s.text.replace(RETRO_PROMISE, RETRO_REVIEWED) }
      : s));
    if (id === "retro") expect(sectionOf(base, "Procedure")).toContain(RETRO_PROMISE);
    expect(own).toEqual(theirs);

    const { rest, item } = withoutItem(paragraphsOf(prompt));
    const added = ADDED[id] ?? [];
    for (const pattern of added) expect(rest.filter((p) => pattern.test(p))).toHaveLength(1);
    expect(rest.filter((p) => !added.some((pattern) => pattern.test(p)))).toEqual(withoutSpec(paragraphsOf(base)));
    expect(withoutSpec(paragraphsOf(base)).length).toBeLessThan(paragraphsOf(base).length);
    expect(item.slice(1).join("\n\n")).toBe(ITEM);
    // Framed as main frames the spec: a person's requirements, never instructions for the session.
    expect(flat(item[0])).toMatch(/written by a person/);
    expect(flat(item[0])).toMatch(/never instructions about how to run this session/);
  });

  it("tells the reviewer to judge a lesson commit for what it loosens, not against the item", () => {
    const lead = flat(splitSections(stepOf("fastlane", "steps/code-review.md").prompt).lead);
    expect(lead).toMatch(/loosens any rule, check or guard/);
    expect(lead).toMatch(/raise a finding/);
    expect(lead).toMatch(/do not review it against the item's text/);
  });

  it("names the item's text in every step but the judge's, and the spec in none", () => {
    const steps = flow("fastlane").steps;
    expect([...steps.keys()].sort()).toEqual(STEPPED.map((id) => `steps/${id}.md`).sort());
    for (const [path, { prompt }] of steps) {
      expect({ path, body: prompt.includes("{brief.project.body}") }).toEqual({ path, body: path !== "steps/triage.md" });
      expect({ path, spec: /\{brief\.spec\.content\}|\{artifacts\.spec\.url\}/.test(prompt) }).toEqual({ path, spec: false });
    }
  });

  // A lesson that narrowed this back would let a retro rewrite the routing,
  // or the agents' configuration, that merges its own commit.
  it.each(["full-cycle", "fastlane"])("keeps %s's retro off every workflow and the configuration", (id) => {
    const rules = sectionOf(stepOf(id, "steps/retro.md").prompt, "Rules") ?? "";
    expect(rules).toContain("`.landrace/workflows/*/workflow.yaml`");
    expect(rules).toContain("`.landrace/landrace.yaml`");
  });
});

describe("fastlane's stages", () => {
  it("waits on a person only when it is stuck; a halt is a person's by being a halt", () => {
    expect(flow("fastlane").workflow.stages.filter((s) => s.waits === "person").map((s) => s.id)).toEqual(["stuck"]);
  });

  /*
   * The merge before the position moves, as publish pushes before it does,
   * and after the entry record: a refusal is merge's rejected round, read at
   * ci where the item still is, and goes to a halt. Moved past it, the
   * refusal would read as an open pull request at merge — a moved head —
   * and send the item back to review.
   */
  it("merges before it moves the item to merge, guarded on the item's own branch", () => {
    const types = (stageOf("merge").on_enter ?? []).map((e) => e.type);
    expect(types.indexOf("pull.merge")).toBeLessThan(types.indexOf("tracker.status"));
    expect(types.indexOf("tracker.comment")).toBeLessThan(types.indexOf("pull.merge"));
    expect(stageOf("merge").on_enter).toContainEqual(expect.objectContaining({ type: "pull.merge", branch: "landrace/{item}" }));
  });

  /*
   * Security audit C1: what a prompt-injected build could merge to main with
   * no person — the engine's own hooks, imported with the project's secrets;
   * its configuration and workflows; CI with the repository's secrets; the
   * dependencies the next install runs; the agents' own instructions — is a
   * person's to merge, refused by the kit whatever the reviewer said.
   */
  // Security audit H1: the head CI judged is not enough; the head a review read is.
  it("merges only the head code review's latest round started at", () => {
    const merge = (stageOf("merge").on_enter ?? []).find((e) => e.type === "pull.merge");
    expect(merge?.reviewedBy).toBe("code-review");
  });

  it("leaves to a person every merge that changes the engine's hooks, configuration or workflows, CI, dependencies or agent instructions", () => {
    const merge = (stageOf("merge").on_enter ?? []).find((e) => e.type === "pull.merge");
    expect(merge?.refuse).toEqual([
      ".landrace/**", ".github/**",
      "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", ".pnpmfile.cjs",
      ".agsync/**", ".agents/**", ".claude/**", ".codex/**", ".cursor/**", ".mcp.json",
      "**/CLAUDE.md", "**/CLAUDE.local.md", "**/AGENTS.md",
    ]);
  });

  /*
   * Re-review N5: what the list says it protects, by its equivalents too —
   * the operator's own agents' settings and hooks, the skills every agent
   * links to, instructions in any directory, and the code an install runs —
   * judged with the kit's own matcher, root and nested. And N1: the whole of
   * `.landrace/`, a step file's front matter as much as a workflow — its
   * routes, effects and capabilities are configuration.
   */
  it.each([
    ".landrace/hooks/github.ts", ".landrace/landrace.yaml", ".landrace/workflows/fastlane/workflow.yaml",
    ".landrace/workflows/main/steps/code-review.md", ".landrace/workflows/fastlane/steps/build.md", ".landrace/.env.example",
    ".claude/settings.json", ".claude/commands/x.md", ".agents/skills/agsync/SKILL.md", ".codex/config.toml", ".cursor/mcp.json",
    "CLAUDE.md", "docs/CLAUDE.md", "CLAUDE.local.md", "src/CLAUDE.local.md", "AGENTS.md", "packages/x/AGENTS.md",
    ".npmrc", ".pnpmfile.cjs", "pnpm-workspace.yaml",
  ])("refuses a merge changing %s", (path) => {
    const merge = (stageOf("merge").on_enter ?? []).find((e) => e.type === "pull.merge");
    expect((merge?.refuse as string[]).some((glob) => globMatches(glob, path))).toBe(true);
  });

  it.each(["src/export.ts", "README.md", "docs/notes.md", "tests/export.test.ts", "packages/x/package-notes.md"])(
    "leaves a merge changing %s to the guards alone",
    (path) => {
      const merge = (stageOf("merge").on_enter ?? []).find((e) => e.type === "pull.merge");
      expect((merge?.refuse as string[]).some((glob) => globMatches(glob, path))).toBe(false);
    },
  );

  // The review's own push published the reviewed head; one here could publish one nobody reviewed.
  it("pushes nothing as it waits for the checks", () => {
    expect((stageOf("ci").on_enter ?? []).map((e) => e.type)).not.toContain("branch.push");
  });

  /*
   * The pull request before the position moves, as merge merges before it
   * does: a close the forge refuses is closed's rejected round, read at
   * triage, and goes to a halt; one that failed on the way leaves the item at
   * triage for the next tick. Moved to the terminal stage first, nothing would.
   */
  it("closes the pull request at closed, before it moves the item there", () => {
    const effects = stageOf("closed").on_enter ?? [];
    expect(effects).toContainEqual({ type: "pull.close", branch: "landrace/{item}" });
    const types = effects.map((e) => e.type);
    expect(types.indexOf("pull.close")).toBeLessThan(types.indexOf("tracker.status"));
    expect(types).not.toContain("nodes.close");
  });

  it.each([["done", undefined], ["closed", "dropped"]])("closes the item at %s (how: %s) and takes its working labels off", (id, how) => {
    const effects = stageOf(id).on_enter ?? [];
    expect(stageOf(id).terminal).toBe(true);
    expect(effects.filter((e) => e.type === "tracker.close")).toEqual([how === undefined ? { type: "tracker.close" } : { type: "tracker.close", how }]);
    // Closed before the position and labels say so: an outage on the close leaves the item where it was, admitted.
    const types = effects.map((e) => e.type);
    expect(types.indexOf("tracker.close")).toBeLessThan(types.indexOf("tracker.status"));
    expect(types.indexOf("tracker.close")).toBeLessThan(types.indexOf("tracker.label"));
    const removed = effects.flatMap((e) => (e.type === "tracker.label" ? (e.remove as string[]) : []));
    expect(removed).toEqual(expect.arrayContaining(["lr:working", "lr:awaiting"]));
    // Never what admitted it: the board files a finished item by its own eligible rule.
    expect(removed).not.toEqual(expect.arrayContaining(["lr:fast"]));
    expect(removed).not.toEqual(expect.arrayContaining(["lr:auto"]));
  });

  it("lets a halt send the item back to every step it has and every way in the forge can refuse, and stuck to build and review", () => {
    const targets = (id: string) => (stageOf(id).goto ?? []).map((g) => (typeof g === "string" ? g : g.stage)).sort();
    const stepped = flow("fastlane").workflow.stages.filter((s) => s.step).map((s) => s.id).sort();
    expect(stepped).toEqual(STEPPED.slice().sort());
    for (const halt of ["blocked", "screened"]) expect(targets(halt)).toEqual([...stepped, "closed", "merge", "publish"].sort());
    expect(targets("stuck")).toEqual(["build", "code-review"]);
  });

  /*
   * The halts send an item to publish, merge or closed only as the Retry of
   * that stage's refused way in: after any other failure, "Go to step…
   * merge" would merge code a review never passed.
   */
  it.each(["blocked", "screened"].flatMap((halt) => ["publish", "merge", "closed"].map((to) => [halt, to] as const)))(
    "from %s, a goto to %s is declined unless it is what failed",
    (from, to) => {
      expect(gotoDeclined(stageOf(from), snapshotOf({ stage: from, human: true, failedStage: "build" }), to)).toMatch(/only as the Retry/);
      expect(gotoDeclined(stageOf(from), snapshotOf({ stage: from, human: true }), to)).toMatch(/only as the Retry/);
      expect(gotoDeclined(stageOf(from), snapshotOf({ stage: from, human: true, failedStage: to }), to)).toBeNull();
    },
  );

  /*
   * Each goto's cap, at the round below it and at it. Code review is held
   * to eight from a halt, past its loop's four; the retro to two, so a failed
   * retro's Retry is taken once.
   */
  it.each([
    ...["blocked", "screened"].flatMap((halt) => [
      [halt, "build", 3], [halt, "code-review", 8], [halt, "fix-review", 8], [halt, "retro", 2], [halt, "triage", 20],
      [halt, "publish", 3], [halt, "merge", 3], [halt, "closed", 3],
    ] as const),
    ["stuck", "build", 3], ["stuck", "code-review", 4],
  ] as const)("from %s, a goto to %s is taken below %i rounds and declined at it", (from, to, cap) => {
    const retried = ["publish", "merge", "closed"].includes(to) ? { failedStage: to } : {};
    const at = (rounds: number): Snapshot => snapshotOf({ stage: from, human: true, counters: { [to]: rounds }, ...retried });
    expect(gotoNotListed(stageOf(from), to)).toBeNull();
    expect(gotoDeclined(stageOf(from), at(cap - 1), to)).toBeNull();
    expect(gotoDeclined(stageOf(from), at(cap), to)).toMatch(/only while/);
  });
});

/*
 * Every exit from one stage is exclusive: two triggers matching one item is
 * an ambiguity halt, and none matching is an item that waits for ever. For
 * each stage, every combination of the boundary values its exits read — a
 * cap less one and the cap, friction on and off, checks pending, failed or
 * green, threads awaiting a fix, answered or opened late, the pull request
 * merged, open or closed — is put to every other stage's triggers through
 * the engine's own compiler, as decide() puts them, and exactly the exit the
 * plan names must match. Nothing matches only where the plan means a wait.
 */

/** The facts a fastlane trigger reads at one item. */
interface Facts {
  stage: string;
  valid?: false | null;
  refused?: boolean;
  previous?: string;
  actor?: "agent" | "human";
  /** Whether a person has written on the item: `run.lastHuman`. */
  human?: boolean;
  /** What failed and put the item where it is: `run.failedStage`. */
  failedStage?: string;
  intent?: string;
  counters?: Record<string, number>;
  total?: number;
  /** Pull requests closed unmerged, which `total` leaves out: `rel.implements.in.dropped`. */
  dropped?: number;
  notMerged?: number;
  awaitingFix?: number;
  openThreads?: number;
  ciPending?: number;
  ciFailed?: number;
}

/**
 * The snapshot an item with these facts reads as. A counter at zero is left
 * out, as the engine derives one: a stage that never ran has no counter at
 * all. So are the per-field counts of an item with no pull request, as
 * deriveRel leaves them: `not.merged: 0` is no match there. A build has
 * always run, and an earlier reply's answer is still on the item wherever it
 * is now — a trigger routing on it must not fire elsewhere.
 */
function snapshotOf(f: Facts): Snapshot {
  const run: Run = {
    stage: f.stage,
    counters: Object.fromEntries(Object.entries(f.counters ?? {}).filter(([, n]) => n > 0)),
    rounds: {},
    next: {},
    outputs: { build: { kind: "done" }, triage: { intent: f.intent ?? "rework" } },
    lastEvent: { actor: f.actor ?? "agent", at: null },
    lastHuman: f.human ? { stage: f.stage, kind: "human", round: 0, at: "2026-10-02T00:00:00.000Z", byAgent: false } : null,
    lastOutputValid: f.valid ?? null,
    lastRefused: f.valid === false ? f.refused ?? false : null,
    goto: null,
    cleared: null,
    previousStage: f.previous ?? null,
    failedStages: f.valid === false ? [f.stage] : [],
    failedStage: f.failedStage ?? null,
    unblockedAt: 0,
    pairing: null,
    lastOutputBy: "agent",
    heads: {},
  };
  const total = f.total ?? 1;
  const notMerged = f.notMerged ?? total;
  const dropped = f.dropped ?? 0;
  const counts = total === 0
    ? { total, dropped, is: {}, not: {}, sum: {}, stage: {} }
    : {
      total, dropped, is: { merged: total - notMerged }, not: { merged: notMerged }, stage: {},
      sum: { awaitingFix: f.awaitingFix ?? 0, openThreads: f.openThreads ?? 0, ciPending: f.ciPending ?? 0, ciFailed: f.ciFailed ?? 0 },
    };
  return { run, rel: { implements: { in: counts, out: { total: 0, dropped: 0, is: {}, not: {}, sum: {}, stage: {} } } } };
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
const n = (value: number | undefined, otherwise: number): number => value ?? otherwise;

/** Each stage, the boundary values its exits read, and where the plan sends an item with those facts — null for a wait. */
const STAGES: Array<[string, Record<string, readonly unknown[]>, (f: Facts) => string | null]> = [
  // A pull request a person closed unmerged, with nothing open or merged
  // beside it, is their stop: a build done after it goes to stuck, never to
  // publish, which would open another. A replacement they opened is them
  // carrying on.
  ["build", { dropped: [0, 1, 2], total: [0, 1] }, (f) => (n(f.dropped, 0) > 0 && n(f.total, 1) === 0 ? "stuck" : "publish")],
  // No pull request at publish is no exit: pull.open lands before the position moves there.
  ["publish", { total: [0, 1] }, (f) => (n(f.total, 1) > 0 ? "code-review" : null)],
  // A pull request a person closed during a review, a fix or the retro is their stop: stuck.
  ["code-review", {
    total: [0, 1], awaitingFix: [0, 1], openThreads: [0, 1], notMerged: [0, 1], "counters.code-review": [3, 4],
  }, (f) => {
    if (n(f.total, 1) === 0) return "stuck";
    if (n(f.awaitingFix, 0) > 0) return count(f, "code-review") < 4 ? "fix-review" : "stuck";
    if (n(f.openThreads, 0) > 0) return "stuck";
    return n(f.notMerged, 1) > 0 ? "ci" : "done";
  }],
  ["fix-review", { total: [0, 1], "counters.fix-review": [7, 8] }, (f) =>
    (n(f.total, 1) === 0 ? "stuck" : count(f, "fix-review") < 8 ? "code-review" : "stuck")],
  // Checks still running is the one wait here. A thread opened while they ran goes to review first.
  ["ci", {
    total: [0, 1], openThreads: [0, 1], ciPending: [0, 1], ciFailed: [0, 1], notMerged: [0, 1],
    "counters.code-review": [3, 4], "counters.build": [1, 2, 3], "counters.fix-review": [0, 1],
    "counters.triage": [0, 1], "counters.retro": [0, 1],
  }, (f) => {
    if (n(f.total, 1) === 0) return "stuck";
    if (n(f.openThreads, 0) > 0) return count(f, "code-review") < 4 ? "code-review" : "stuck";
    if (n(f.ciFailed, 0) > 0) return count(f, "build") < 3 ? "build" : "stuck";
    if (n(f.ciPending, 0) > 0) return null;
    return count(f, "retro") < 1 && friction(f) && n(f.notMerged, 1) > 0 ? "retro" : "merge";
  }],
  ["retro", { total: [0, 1] }, (f) => (n(f.total, 1) === 0 ? "stuck" : "code-review")],
  ["merge", { total: [0, 1], notMerged: [0, 1], "counters.code-review": [3, 4] }, (f) => {
    if (n(f.total, 1) === 0) return "stuck";
    if (n(f.notMerged, 1) === 0) return "done";
    return count(f, "code-review") < 4 ? "code-review" : "stuck";
  }],
  ["triage", { intent: ["rework", "close", "question", "unclear"], previous: ["stuck", "blocked", "screened"] }, (f) => {
    if (f.intent === "rework") return "build";
    if (f.intent === "close") return "closed";
    return f.previous ?? null;
  }],
  // A person's turn: their own message moves the item on — and at stuck, a
  // pull request they merged by hand finishes it.
  ["stuck", { actor: ["agent", "human"], total: [0, 1], notMerged: [0, 1] }, (f) => {
    if (n(f.total, 1) > 0 && n(f.notMerged, 1) === 0) return "done";
    return f.actor === "human" ? "triage" : null;
  }],
  // At blocked, as at stuck, a pull request a person merged by hand finishes
  // it: a merge the kit refused — a protected path — is theirs to make.
  ["blocked", { actor: ["agent", "human"], total: [0, 1], notMerged: [0, 1] }, (f) => {
    if (n(f.total, 1) > 0 && n(f.notMerged, 1) === 0) return "done";
    return f.actor === "human" ? "triage" : null;
  }],
  ["screened", { actor: ["agent", "human"] }, (f) => (f.actor === "human" ? "triage" : null)],
];

/** Each trigger's compiled `when`, compiled once: the sweep asks thousands of items. */
const compiled = new WeakMap<Condition, (s: Snapshot) => boolean>();
const matches = (when: Condition, s: Snapshot): boolean => {
  let test = compiled.get(when);
  if (!test) compiled.set(when, (test = compile(when)));
  return test(s);
};

/** What decide() weighs once a stage has settled: every other stage's triggers, through the engine's compiler. */
const exitsFrom = (w: Workflow, f: Facts): string[] => {
  const s = snapshotOf(f);
  return w.stages
    .filter((candidate) => candidate.id !== f.stage)
    .flatMap((candidate) => (candidate.triggers ?? [])
      .filter((t) => matches(t.when, s))
      .map((t) => `${candidate.id}: ${t.name ?? ""}`));
};

const label = (f: Facts): string => JSON.stringify({ ...f, stage: undefined });
const destinationOf = (exit: string): string => exit.split(":")[0] ?? exit;

describe("every exit from a fastlane stage is exclusive", () => {
  it.each(STAGES)("from %s, exactly the exit the plan names matches, at every boundary", (stage, axes, to) => {
    const { workflow } = flow("fastlane");
    const facts = grid(stage, axes);
    const got = facts.map((f) => [label(f), exitsFrom(workflow, f).map(destinationOf)]);
    const want = facts.map((f) => [label(f), [to(f)].filter((x) => x !== null)]);
    expect(got).toEqual(want);

    // And for the right reason: each exit reads only paths these facts carry
    // — a counter at zero is absent, as the engine leaves it, and so is every
    // count of an item with no pull request — and the grid reaches every one.
    const anchored = workflow.stages.flatMap((s) => (s.triggers ?? []).filter((t) => t.when["run.stage"] === stage).map((t) => ({ to: s.id, t })));
    expect(anchored.length).toBeGreaterThan(0);
    const missing = facts.filter((f) => n(f.total, 1) > 0).flatMap((f) => anchored.flatMap(({ t }) =>
      missingPaths(t.when, snapshotOf(f)).filter((p) => !p.startsWith("run.counters."))));
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
      expect(facts.map((f) => [label(f), exitsFrom(flow("fastlane").workflow, f).map(destinationOf)]))
        .toEqual(facts.map((f) => [label(f), [halt]]));
    },
  );

  /*
   * A way on the forge refused, read at the stage the item was leaving: the
   * record of it is the bot's and the latest word, so no person's message
   * is. Every boundary value of the stage's own exits, and only the halt
   * matches — at `blocked` itself, nothing, unless a person merged the pull
   * request by hand after their Retry was refused again: the item waits
   * there for them. A Retry from `screened` the forge refused goes to
   * `blocked`: the newest failure is the forge's, not a security check's.
   */
  it.each(["publish", "ci", "merge", "stuck", "blocked", "screened"])("a refused way on from %s goes to blocked alone", (stage) => {
    const axes = Object.fromEntries(Object.entries(STAGES.find(([id]) => id === stage)?.[1] ?? {}).filter(([axis]) => axis !== "actor"));
    const facts = grid(stage, axes, { valid: false, refused: false, actor: "agent" });
    const halt = (f: Facts): string[] => stage !== "blocked"
      ? ["blocked"]
      : n(f.total, 1) > 0 && n(f.notMerged, 1) === 0 ? ["done"] : [];
    expect(facts.map((f) => [label(f), exitsFrom(flow("fastlane").workflow, f).map(destinationOf)]))
      .toEqual(facts.map((f) => [label(f), halt(f)]));
  });
});

/*
 * Re-review N1, its probe as a test: one line of main's code-review front
 * matter — the route's effect made a merge — and a fastlane item whose pull
 * request rewrote the hooks was merged on the reviewer's say-so, with no
 * guard, while `validate` reported nothing. Both workflows run that step:
 * fastlane's extends main's front matter whole.
 */
describe("a step route that merges, as the re-review planted it", () => {
  const ROUTE = '      effect: { type: pull.review, branch: "landrace/{item}", marker: "review:{round}" }';

  const probed = async (edit: (text: string) => string): Promise<Workspace> => {
    const copy = await mkdtemp(join(tmpdir(), "lr-probe-"));
    try {
      await cp(join(".landrace", "workflows"), join(copy, "workflows"), { recursive: true });
      const step = join(copy, "workflows", "main", "steps", "code-review.md");
      await writeFile(step, edit(await readFile(step, "utf8")));
      return await loadWorkspace(copy);
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  };
  const placement = (ws: Workspace) =>
    ws.workflows.map(({ id, workflow, steps }) => [id, validate(workflow, steps).filter((p) => p.rule === "merge-placement").length]);

  it("is refused by validate, in main and in fastlane", async () => {
    expect((await readFile(".landrace/workflows/main/steps/code-review.md", "utf8")).split("\n")).toContain(ROUTE);
    const merging = await probed((text) => text.replace(ROUTE, '      effect: { type: pull.merge, branch: "landrace/{item}" }'));
    expect(placement(merging)).toEqual([["fastlane", 1], ["main", 1]]);
    // The copy as it was is clean on the rule: what it refuses is the line.
    expect(placement(await probed((text) => text))).toEqual([["fastlane", 0], ["main", 0]]);
  });

  it("is in a pull request fastlane leaves to a person, as every change under .landrace/ is", () => {
    const merge = (stageOf("merge").on_enter ?? []).find((e) => e.type === "pull.merge");
    expect((merge?.refuse as string[]).some((glob) => globMatches(glob, ".landrace/workflows/main/steps/code-review.md"))).toBe(true);
  });
});
