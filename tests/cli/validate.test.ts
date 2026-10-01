import { runValidate } from "#cli/validate.js";
import { runNext } from "#cli/next.js";
import { loadShipped } from "#tests/support/shipped.js";
import { workflowIn, workspaceOf } from "#tests/support/workspace.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("landrace validate", () => {
  it("reports a sound workflow as valid", async () => {
    const r = await runValidate(await workspaceOf({ main: "tests/fixtures/minimal" }));
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
  });

  it("returns the problems it found, not just a boolean", async () => {
    const r = await runValidate(await workspaceOf({ main: "tests/fixtures/duplicate-id" }));
    expect(r.ok).toBe(false);
    expect(r.problems).toContainEqual(
      expect.objectContaining({ rule: "duplicate-id", message: expect.stringMatching(/duplicate stage id/) }),
    );
  });

  it("reports a missing step file as a problem instead of throwing", async () => {
    const r = await runValidate(await workspaceOf({ main: "tests/fixtures/missing-step" }));
    expect(r.ok).toBe(false);
    expect(r.problems).toContainEqual(
      expect.objectContaining({ rule: "missing-step", message: expect.stringMatching(/does not exist/) }),
    );
  });

  it("reports a schema failure as a problem instead of throwing", async () => {
    const r = await runValidate(await workspaceOf({ main: "tests/fixtures/bad-schema" }));
    expect(r.ok).toBe(false);
    expect(r.problems).toContainEqual(expect.objectContaining({ rule: "schema" }));
  });

  // C1's real-world proof, checked against the real file rather than a
  // fixture. The shipped workflow burned 30 paid opus invocations in a
  // single converge() call, forever, because build, code-review and
  // fix-review each named a step with no output: block — assess() can never
  // see run.outputs[stage.id] and decide() invokes it again on every pass.
  it("gives every stage with a step a real output contract, so assess() can mark it complete", async () => {
    const { workflow, steps } = await loadShipped();
    const missingOutput = workflow.stages
      .filter((s) => s.step && !steps.get(s.step)?.output)
      .map((s) => s.id);
    expect(missingOutput).toEqual([]);
  });

  /*
   * "validates the shipped .landrace workflow clean, on every rule" — every
   * rule, because filtering to one let a later rule pass this test while the
   * shipped file actually violated it — now lives in
   * tests/esm/cli-validate.test.ts, beside the rule that moved it.
   *
   * `validate` imports the hook modules to answer §11.8's path coverage, and
   * the default pass's CommonJS runtime cannot resolve the `file:` URL the
   * loader hands `import()`. Asked here, the shipped workflow would report a
   * hook that would not load rather than the coverage it now proves.
   *
   * Every runValidate case left in this file names a fixture with no hooks, so
   * nothing is imported and the coverage rule abstains.
   */

  // Round-3 Important: a step's own prompt printing a literal object (e.g.
  // `` `{"kind": "done"}` `` in build.md) is an honest completion away from
  // triggering the false-"many" it causes if the model echoes that exact
  // line back — the discriminator-key fix on the extractor makes it a real
  // (if unlikely) candidate, and two claimed candidates is still ambiguous.
  // The step files should describe the shape in prose, not print it.
  it("does not print a literal json object in any shipped step's prompt", async () => {
    const { steps } = await loadShipped();
    for (const step of steps.values()) {
      expect(step.prompt).not.toMatch(/\{\s*"[a-zA-Z_]+"\s*:/);
    }
    expect(steps.size).toBeGreaterThan(0);
  });
});

/*
 * A workspace is checked whole: every workflow in it, each as it would run.
 * With more than one, a problem that did not say which workflow it is in would
 * send the reader through every folder to find it.
 */
describe("landrace validate, over a workspace", () => {
  const SOUND = (name: string): string => [
    "version: 1", `name: ${name}`, "description: test", "stages:",
    "  - id: a", "    entry: true", "    terminal: true", "    triggers:", '      - { when: { "run.stage": null } }', "",
  ].join("\n");
  // Schema-valid and unsound: no entry stage, so nothing can ever begin.
  const NO_ENTRY = "version: 1\nname: Main\ndescription: test\nstages:\n  - id: only\n    triggers: [{ when: { \"run.stage\": null } }]\n";

  const workspace = async (workflows: Record<string, string>): Promise<string> => {
    const ws = await mkdtemp(join(tmpdir(), "landrace-validate-ws-"));
    for (const [id, yaml] of Object.entries(workflows)) {
      await mkdir(workflowIn(ws, id), { recursive: true });
      await writeFile(join(workflowIn(ws, id), "workflow.yaml"), yaml);
    }
    return ws;
  };

  it("validates every workflow, and names the one each problem is in", async () => {
    const r = await runValidate(await workspace({ main: NO_ENTRY, fastlane: SOUND("Fastlane") }));
    expect(r.ok).toBe(false);
    expect(r.problems).toContainEqual(expect.objectContaining({ message: expect.stringMatching(/^main: .*entry/) }));
    expect(r.problems.filter((p) => !p.message.startsWith("main: "))).toEqual([]);
  });

  it("is valid when every workflow in it is", async () => {
    expect(await runValidate(await workspace({ main: SOUND("Main"), fastlane: SOUND("Fastlane") }))).toEqual({ ok: true, problems: [] });
  });

  it("does not prefix a problem with the id when there is only one workflow to be in", async () => {
    const r = await runValidate(await workspace({ main: NO_ENTRY }));
    expect(r.problems).toContainEqual(expect.objectContaining({ message: expect.stringMatching(/entry/) }));
    expect(r.problems.filter((p) => p.message.startsWith("main: "))).toEqual([]);
  });

  /*
   * One workflow that will not load does not hide the others: its load
   * problem names its folder, and the rest are still checked.
   */
  it("reports a workflow that will not load, and still checks the others", async () => {
    const DUPLICATE = "version: 1\nname: Main\ndescription: test\nstages:\n  - { id: a, entry: true, terminal: true }\n  - { id: a, terminal: true }\n";
    const r = await runValidate(await workspace({ main: DUPLICATE, fastlane: NO_ENTRY.replace("name: Main", "name: Fastlane") }));
    expect(r.ok).toBe(false);
    expect(r.problems).toContainEqual({ rule: "duplicate-id", message: 'workflows/main: duplicate stage id "a"' });
    expect(r.problems).toContainEqual(expect.objectContaining({ message: expect.stringMatching(/^fastlane: .*entry/) }));
  });

  /*
   * A check of the configuration and the hooks every workflow shares is one
   * problem, however many workflows meet it: the same sentence once per
   * folder reads as several things to fix.
   */
  it("reports a configuration problem the workflows share once", async () => {
    const ws = await workspace({ main: SOUND("Main"), fastlane: SOUND("Fastlane") });
    await writeFile(join(ws, "landrace.yaml"), "version: 1\nagent: { adapter: claude }\nnotify: { on: [needs-you], via: [slack] }\n");
    const r = await runValidate(ws);
    expect(r.problems.filter((p) => p.rule === "notify")).toEqual([
      { rule: "notify", message: 'notify.via names "slack", which no notifier registers: the loaded hooks register none' },
    ]);
  });

  it("reports the layout before workspaces, saying where to move it, and the command exits 1", async () => {
    // tests/fixtures/minimal is a workflow folder: workflow.yaml at its root.
    expect(await runValidate("tests/fixtures/minimal")).toEqual({
      ok: false,
      problems: [{ rule: "layout", message: expect.stringMatching(/workflow\.yaml is the layout before workspaces; move it to .*workflows\/main\/workflow\.yaml/) }],
    });

    const failure = await promisify(execFile)(process.execPath,
      ["--experimental-strip-types", "--no-warnings", "src/cli/index.ts", "validate", "tests/fixtures/minimal"])
      .then(() => null, (e: { code?: number; stderr?: string }) => e);
    expect(failure?.code).toBe(1);
    expect(failure?.stderr).toMatch(/layout: .*layout before workspaces/);
  });
});

/**
 * `validate` and the variables a workflow is substituted with.
 *
 * Every one of these is a report rather than an exception — the whole job of
 * the command — and every one of them is a mistake that otherwise surfaces as
 * a repository where nothing happens: a filter substituted with nothing
 * claims no item, and `status` prints the workflow's own `else` beside every
 * one of them, which reads exactly like the filter working.
 */
describe("landrace validate, and the vars a workflow is substituted with", () => {
  const GRAPH = `version: 1
name: t
description: test
eligible:
  - when: { "item.assignees": { $in: ["{vars.assignee}"] } }
    else: "assigned to somebody else"
stages:
  - id: a
    entry: true
    triggers: [{ when: { "run.stage": null } }]
  - id: done
    terminal: true
    triggers: [{ when: { "run.stage": "a" } }]
`;

  const dirFor = async (config: string, graph = GRAPH): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "landrace-validate-vars-"));
    await mkdir(workflowIn(dir), { recursive: true });
    await writeFile(join(workflowIn(dir), "workflow.yaml"), graph);
    await writeFile(join(dir, "landrace.yaml"), `version: 1\nagent: { adapter: claude }\n${config}`);
    return dir;
  };

  const rulesOf = (problems: Array<{ rule: string }>): string[] => problems.map((p) => p.rule);

  beforeAll(() => { process.env.LR_VALIDATE_ASSIGNEE = "ann"; });
  afterAll(() => { delete process.env.LR_VALIDATE_ASSIGNEE; });

  it("passes a workflow whose var resolves, having substituted a literal into it", async () => {
    const r = await runValidate(await dirFor("vars: { assignee: $LR_VALIDATE_ASSIGNEE }\n"));
    // This fixture names no hooks, so `agent.adapter: claude` never resolves
    // in this jest pass (the loader's dynamic import is unreachable under
    // CommonJS, which is why every fixture in this file names none) — the one
    // `executor` problem that follows from that is filtered out, and with it
    // `r.ok`, since neither is what this describe is about.
    expect(r.problems.filter((p) => p.rule !== "executor")).toEqual([]);
  });

  /*
   * One problem, not two. The workflow is not loaded at all when a var did not
   * resolve: loading it would report every reference to that var a second
   * time, as a name nothing declares — which is a misdescription of the one
   * fact that is actually wrong.
   */
  it("reports the variable that did not resolve, and does not go on to misreport its uses", async () => {
    const r = await runValidate(await dirFor("vars: { assignee: $LR_VALIDATE_NOBODY }\n"));
    expect(rulesOf(r.problems)).toEqual(["vars"]);
    // The resolution failure in its own words, not the workflow loader's "no
    // vars entry defines {vars.assignee}" — which is true of the substitution
    // and false about the configuration, where the entry is right there.
    expect(r.problems[0]?.message).toMatch(/"assignee" does not resolve/);
  });

  it("reports a var nothing in the workflow references", async () => {
    const r = await runValidate(await dirFor("vars: { assignee: $LR_VALIDATE_ASSIGNEE, team: platform }\n"));
    // Not `r.ok`: this fixture's unrelated `executor` problem (see the "passes
    // a workflow whose var resolves" case above) already makes it false, so
    // asserting that would pass whether or not `vars` reported anything.
    expect(r.problems).toContainEqual(
      expect.objectContaining({ rule: "vars", message: expect.stringMatching(/"team"/) }),
    );
  });

  it("reports a reference no var defines", async () => {
    const graph = GRAPH.replace("{vars.assignee}", "{vars.asignee}");
    const r = await runValidate(await dirFor("vars: { assignee: $LR_VALIDATE_ASSIGNEE }\n", graph));
    expect(r.problems).toContainEqual(
      expect.objectContaining({ rule: "vars", message: expect.stringMatching(/\{vars\.asignee\}/) }),
    );
  });

  /*
   * A var is not a second way to hold a secret: secrets are stripped from
   * every log line and event by value, and a var is substituted into the
   * workflow, so it reaches a comment body and a prompt unredacted.
   */
  it("reports a var that resolves to a value a secret also holds", async () => {
    const r = await runValidate(await dirFor(
      "secrets: { token: $LR_VALIDATE_ASSIGNEE }\nvars: { assignee: $LR_VALIDATE_ASSIGNEE }\n",
    ));
    expect(r.problems).toContainEqual(
      expect.objectContaining({ rule: "vars", message: expect.stringMatching(/"assignee"[\s\S]*secret/) }),
    );
  });
});

/** The notify block, refused here in the words `start` refuses it with. */
describe("landrace validate, and the notify block", () => {
  const dirFor = async (config: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "landrace-validate-notify-"));
    await mkdir(workflowIn(dir), { recursive: true });
    await writeFile(join(workflowIn(dir), "workflow.yaml"), [
      "version: 1", "name: t", "description: test", "stages:",
      "  - id: a", "    entry: true", "    terminal: true", "    triggers:", '      - { when: { "run.stage": null } }', "",
    ].join("\n"));
    await writeFile(join(dir, "landrace.yaml"), `version: 1\nagent: { adapter: claude }\n${config}`);
    return dir;
  };

  it("reports an event there is none of, rather than reading the file as absent", async () => {
    const r = await runValidate(await dirFor("notify: { on: [done], via: [slack] }\n"));
    expect(r.problems).toContainEqual({ rule: "config", message: expect.stringMatching(/notify\.on\.0: .*"needs-you"/) });
  });

  it("reports a via id no loaded notifier answers to", async () => {
    const r = await runValidate(await dirFor("notify: { on: [needs-you], via: [slack] }\n"));
    expect(r.problems).toContainEqual({
      rule: "notify", message: 'notify.via names "slack", which no notifier registers: the loaded hooks register none',
    });
  });

  it("still checks a workflow with no landrace.yaml beside it", async () => {
    const dir = await dirFor("");
    await rm(join(dir, "landrace.yaml"));
    expect((await runValidate(dir)).problems).toEqual([]);
  });
});

describe("landrace next", () => {
  it("prints the decision for a snapshot with no I/O", async () => {
    const dir = await mkdtemp(join(tmpdir(), "landrace-cli-"));
    const file = join(dir, "snap.json");
    await writeFile(file, JSON.stringify({ entries: [], run: { stage: null, counters: {}, outputs: {} } }));

    const r = await runNext(await workspaceOf({ main: "tests/fixtures/minimal" }), file);
    expect(r.decision.action).toBe("transition");
    expect(r.decision.to?.id).toBe("spec");
    // The plan for entering a stage, with the round filled in from the
    // destination's own counter — nothing in `next` reads the network.
    expect(r.effects).toEqual([
      {
        type: "tracker.comment", kind: "enter", stage: "spec", round: 1,
        marker: "enter:spec:1", body: "Writing the spec, round 1.",
      },
      { type: "tracker.status", value: "spec", stage: "spec", round: 1 },
    ]);
  });

  /*
   * And with the workflow's vars filled in. `next` exists to answer "what
   * would the engine do", and a graph read with `{vars.assignee}` still in it
   * is a different graph from the one that would run.
   */
  it("substitutes the workflow's vars before deciding", async () => {
    process.env.LR_E2E_ASSIGNEE = "ann";
    const dir = await mkdtemp(join(tmpdir(), "landrace-next-vars-"));
    const file = join(dir, "snap.json");
    // Assigned to this instance, because the fixture's eligibility rule is the
    // substituted one: a snapshot with no assignee is skipped, and a skipped
    // item plans nothing at all.
    await writeFile(file, JSON.stringify({
      node: { id: "1", kind: "item", state: { labels: [], assignees: ["ann"] } },
      entries: [],
      run: { stage: null, counters: {}, outputs: {} },
    }));

    const r = await runNext(await workspaceOf({ main: "tests/fixtures/assigned" }), file);

    expect(r.decision.action).toBe("transition");
    expect(r.effects[0]).toMatchObject({ body: "ann is writing the spec, round 1." });
    delete process.env.LR_E2E_ASSIGNEE;
  });
});

/*
 * What a workflow admits an item with has to be something its own eligibility
 * rule accepts, or every item landrace_create_item starts there is skipped as
 * ineligible on the next tick. Asked only where the rule is a check of labels
 * alone; a rule reading anything else cannot be answered from labels, and the
 * check abstains rather than guesses.
 */
describe("landrace validate, and what a workflow admits", () => {
  const flow = (admit: string, eligible: string): string => [
    "version: 1", "name: Fastlane", "description: test", admit, "eligible:", eligible, "stages:",
    "  - id: a", "    entry: true", "    terminal: true", "    triggers:", '      - { when: { "run.stage": null } }', "",
  ].filter((l) => l !== "").join("\n");
  const LABEL_RULE = '  - { when: { "node.state.labels": { $in: ["lr:auto"] } }, else: "no lr:auto label" }';

  const check = async (yaml: string) => {
    const ws = await mkdtemp(join(tmpdir(), "landrace-validate-admit-"));
    await mkdir(workflowIn(ws, "fastlane"), { recursive: true });
    await writeFile(join(workflowIn(ws, "fastlane"), "workflow.yaml"), yaml);
    return (await runValidate(ws)).problems;
  };

  it("reports labels its own eligible rule does not accept", async () => {
    expect(await check(flow("admit: [lr:fast]", LABEL_RULE))).toEqual([{
      rule: "admit",
      message: 'workflow "fastlane" admits [lr:fast] but its eligible rule "no lr:auto label" does not accept those labels',
    }]);
  });

  it("is clean when the rule accepts them", async () => {
    expect(await check(flow("admit: [lr:auto]", LABEL_RULE))).toEqual([]);
  });

  it("judges each labels-only rule on its own, skipping only the rules that read more", async () => {
    const other = '  - { when: { "node.state.assignees": { $in: ["ann"] } }, else: "not ann\'s" }';
    // The labels rule fails on its own, whatever the assignee rule says.
    expect(await check(flow("admit: [lr:fast]", `${LABEL_RULE}\n${other}`))).toEqual([{
      rule: "admit",
      message: 'workflow "fastlane" admits [lr:fast] but its eligible rule "no lr:auto label" does not accept those labels',
    }]);
    // A rule reading labels and another path at once cannot be answered from labels.
    const both = '  - { when: { "node.state.labels": { $in: ["lr:auto"] }, "node.state.assignees": { $in: ["ann"] } }, else: "both" }';
    expect(await check(flow("admit: [lr:fast]", both))).toEqual([]);
    expect(await check(flow("", LABEL_RULE))).toEqual([]);
  });

  it("refuses an admit label the engine writes itself", async () => {
    const rule = '  - { when: { "node.state.labels": { $in: ["lr:working", "lr:stage:build"] } }, else: "x" }';
    expect((await check(flow("admit: [lr:stage:build, lr:working]", rule))).map((p) => p.message)).toEqual([
      'workflow "fastlane" admits "lr:stage:build", a label the engine writes itself',
      'workflow "fastlane" admits "lr:working", a label the engine writes itself',
    ]);
  });
});

/*
 * `next` explains one workflow. With one in the workspace that is the one; with
 * several it is the one named, and naming none is the ambiguity it is.
 */
describe("landrace next, over a workspace", () => {
  const snapshot = async (): Promise<string> => {
    const file = join(await mkdtemp(join(tmpdir(), "landrace-next-ws-")), "snap.json");
    await writeFile(file, JSON.stringify({ entries: [], run: { stage: null, counters: {}, outputs: {} } }));
    return file;
  };
  const two = () => workspaceOf({ main: "tests/fixtures/minimal", fastlane: "tests/fixtures/minimal" });

  it("decides with the workflow it is told to", async () => {
    const r = await runNext(await two(), await snapshot(), "fastlane");
    expect(r.decision.to?.id).toBe("spec");
  });

  it("refuses to pick one of several by itself, naming them", async () => {
    const ws = await two();
    await expect(runNext(ws, await snapshot())).rejects.toThrow(`landrace next runs one workflow at a time; ${ws}/workflows has 2 (fastlane, main)`);
  });

  it("refuses a workflow id the workspace has no folder for, naming the ones it has", async () => {
    const ws = await two();
    await expect(runNext(ws, await snapshot(), "nope")).rejects.toThrow(`no workflow "nope" in ${ws}; it has fastlane, main`);
  });
});

/*
 * A stage's branch is where its step's worktree is checked out. With
 * `agent.isolation` anything but `worktree` there is no worktree: the agent
 * commits wherever the operator's checkout is, and the branch is a promise
 * nothing keeps — so it is refused rather than silently ignored.
 */
describe("landrace validate, a stage's branch, and worktree isolation", () => {
  const exec = promisify(execFile);

  const repo = async (isolation: string): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "landrace-validate-branch-"));
    await exec("git", ["init", "-q"], { cwd: root });
    const dir = join(root, ".landrace");
    await mkdir(join(workflowIn(dir), "steps"), { recursive: true });
    await writeFile(join(workflowIn(dir), "workflow.yaml"), `version: 1
name: t
description: test
stages:
  - id: build
    entry: true
    step: steps/build.md
    branch: "landrace/{item}"
    triggers: [{ when: { "run.stage": null } }]
    on_enter:
      - { type: tracker.comment, kind: enter, marker: "enter:{stage}:{round}", body: "round {round}" }
  - id: done
    terminal: true
    triggers: [{ when: { "run.outputs.build.kind": done } }]
`);
    await writeFile(join(workflowIn(dir), "steps", "build.md"), `---
capabilities: [repo:read, repo:write]
output:
  discriminator: kind
  shapes: { done: {} }
  routes:
    - when: { kind: done }
      effect: { type: tracker.comment, marker: "done:{round}" }
---

build
`);
    await writeFile(join(dir, "landrace.yaml"), `version: 1\nagent: { adapter: claude, isolation: ${isolation} }\n`);
    return dir;
  };

  // This fixture names no hooks, and this jest pass cannot import one even if
  // it did (the loader's dynamic `import()` is unreachable under CommonJS —
  // see tests/esm/cli-start.test.ts's own header comment). So `agent.adapter:
  // claude` never resolves here, and every case below carries that one
  // unrelated `executor` problem alongside whatever `branch` reports — which
  // is not what this describe is about, so it is filtered out rather than
  // asserted on.
  const notExecutor = (p: { rule: string }): boolean => p.rule !== "executor";

  it("is clean with worktree isolation", async () => {
    expect((await runValidate(await repo("worktree"))).problems.filter(notExecutor)).toEqual([]);
  });

  it("reports the stage when there is no worktree for its branch to be checked out in", async () => {
    const r = await runValidate(await repo("none"));
    // Not `r.ok`: the unrelated `executor` problem this fixture always
    // carries already makes it false, whether or not `branch` reported
    // anything — the filtered equality below is the actual assertion.
    expect(r.problems.filter(notExecutor)).toEqual([
      { rule: "branch", message: expect.stringMatching(/stage "build"[\s\S]*agent\.isolation[\s\S]*"none"/) },
    ]);
  });
});
