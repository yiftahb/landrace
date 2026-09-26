import { runValidate } from "#cli/validate.js";
import { runNext } from "#cli/next.js";
import { loadWorkflow } from "#workflow/load.js";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("landrace validate", () => {
  it("reports a sound workflow as valid", async () => {
    const r = await runValidate("tests/fixtures/minimal");
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
  });

  it("returns the problems it found, not just a boolean", async () => {
    const r = await runValidate("tests/fixtures/duplicate-id");
    expect(r.ok).toBe(false);
    expect(r.problems).toContainEqual(
      expect.objectContaining({ rule: "duplicate-id", message: expect.stringMatching(/duplicate stage id/) }),
    );
  });

  it("reports a missing step file as a problem instead of throwing", async () => {
    const r = await runValidate("tests/fixtures/missing-step");
    expect(r.ok).toBe(false);
    expect(r.problems).toContainEqual(
      expect.objectContaining({ rule: "missing-step", message: expect.stringMatching(/does not exist/) }),
    );
  });

  it("reports a schema failure as a problem instead of throwing", async () => {
    const r = await runValidate("tests/fixtures/bad-schema");
    expect(r.ok).toBe(false);
    expect(r.problems).toContainEqual(expect.objectContaining({ rule: "schema" }));
  });

  // C1's real-world proof, checked against the real file rather than a
  // fixture. The shipped workflow burned 30 paid opus invocations in a
  // single converge() call, forever, because build, code-review and
  // fix-review each named a step with no output: block — assess() can never
  // see run.outputs[stage.id] and decide() invokes it again on every pass.
  it("gives every stage with a step a real output contract, so assess() can mark it complete", async () => {
    const { workflow, steps } = await loadWorkflow(".landrace");
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
    const { steps } = await loadWorkflow(".landrace");
    for (const step of steps.values()) {
      expect(step.prompt).not.toMatch(/\{\s*"[a-zA-Z_]+"\s*:/);
    }
    expect(steps.size).toBeGreaterThan(0);
  });
});

/**
 * `validate` and the variables a workflow is substituted with.
 *
 * Every one of these is a report rather than an exception — the whole job of
 * the command — and every one of them is a mistake that otherwise surfaces as
 * a repository where nothing happens: a filter substituted with nothing
 * claims no ticket, and `status` prints the workflow's own `else` beside every
 * one of them, which reads exactly like the filter working.
 */
describe("landrace validate, and the vars a workflow is substituted with", () => {
  const GRAPH = `version: 1
name: t
eligible:
  - when: { "ticket.assignees": { $in: ["{vars.assignee}"] } }
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
    await writeFile(join(dir, "workflow.yaml"), graph);
    await writeFile(join(dir, "landrace.yaml"), `version: 1\nagent: { adapter: claude }\n${config}`);
    return dir;
  };

  const rulesOf = (problems: Array<{ rule: string }>): string[] => problems.map((p) => p.rule);

  beforeAll(() => { process.env.LR_VALIDATE_ASSIGNEE = "ann"; });
  afterAll(() => { delete process.env.LR_VALIDATE_ASSIGNEE; });

  it("passes a workflow whose var resolves, having substituted a literal into it", async () => {
    const r = await runValidate(await dirFor("vars: { assignee: $LR_VALIDATE_ASSIGNEE }\n"));
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
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
    expect(r.ok).toBe(false);
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

describe("landrace next", () => {
  it("prints the decision for a snapshot with no I/O", async () => {
    const dir = await mkdtemp(join(tmpdir(), "landrace-cli-"));
    const file = join(dir, "snap.json");
    await writeFile(file, JSON.stringify({ entries: [], run: { stage: null, counters: {}, outputs: {} } }));

    const r = await runNext("tests/fixtures/minimal", file);
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
    // ticket plans nothing at all.
    await writeFile(file, JSON.stringify({
      node: { id: "1", kind: "ticket", state: { labels: [], assignees: ["ann"] } },
      entries: [],
      run: { stage: null, counters: {}, outputs: {} },
    }));

    const r = await runNext("tests/fixtures/assigned", file);

    expect(r.decision.action).toBe("transition");
    expect(r.effects[0]).toMatchObject({ body: "ann is writing the spec, round 1." });
    delete process.env.LR_E2E_ASSIGNEE;
  });
});

/*
 * `agent.mcp`, reported by `validate` in the same words `start` refuses with:
 * a daemon that refuses what the CLI passed is the two disagreeing about
 * what is fatal, and the operator finds out one start at a time.
 */
describe("landrace validate and the servers a step may use", () => {
  const exec = promisify(execFile);

  const repo = async (names: string, mcpJson?: unknown): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "landrace-validate-mcp-"));
    await exec("git", ["init", "-q"], { cwd: root });
    await writeFile(join(root, ".gitignore"), ".env\n");
    const dir = join(root, ".landrace");
    await mkdir(join(dir, "steps"), { recursive: true });
    await copyFile("tests/fixtures/minimal/workflow.yaml", join(dir, "workflow.yaml"));
    await copyFile("tests/fixtures/minimal/steps/spec.md", join(dir, "steps", "spec.md"));
    await writeFile(join(dir, "landrace.yaml"), `version: 1\nagent: { adapter: claude, mcp: [${names}] }\n`);
    if (mcpJson !== undefined) await writeFile(join(root, ".mcp.json"), JSON.stringify(mcpJson));
    return dir;
  };

  it("is clean when every allowed server resolves", async () => {
    const r = await runValidate(await repo("codebase-memory-mcp", { mcpServers: { "codebase-memory-mcp": { command: "cbm" } } }));
    expect(r.problems).toEqual([]);
  });

  it("reports a missing .mcp.json, and says what generates it", async () => {
    const r = await runValidate(await repo("codebase-memory-mcp"));
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([{ rule: "mcp", message: expect.stringMatching(/does not exist; `agsync sync` generates it/) }]);
  });

  // The one `start` used to refuse in the executor and `validate` passed.
  it("reports a server name the agent's argv could not carry whole", async () => {
    const r = await runValidate(await repo('"my server"', { mcpServers: { "my server": { command: "cbm" } } }));
    expect(r.problems).toEqual([{ rule: "mcp", message: expect.stringContaining('"my server"') }]);
  });

  it("reports the operator server, by name and by command", async () => {
    const r = await runValidate(await repo("landrace, tickets", { mcpServers: {
      landrace: { command: "node", args: ["dist/cli.js", "mcp"] },
      tickets: { command: "landrace", args: ["mcp"] },
    } }));
    expect(r.problems.map((p) => p.rule)).toEqual(["mcp", "mcp"]);
    expect(r.problems.map((p) => p.message).join("\n")).toMatch(/"landrace"[\s\S]*"tickets"/);
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
    await mkdir(join(dir, "steps"), { recursive: true });
    await writeFile(join(dir, "workflow.yaml"), `version: 1
name: t
stages:
  - id: build
    entry: true
    step: steps/build.md
    branch: "landrace/{ticket}"
    triggers: [{ when: { "run.stage": null } }]
    on_enter:
      - { type: tracker.comment, kind: enter, marker: "enter:{stage}:{round}", body: "round {round}" }
  - id: done
    terminal: true
    triggers: [{ when: { "run.outputs.build.kind": done } }]
`);
    await writeFile(join(dir, "steps", "build.md"), `---
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

  it("is clean with worktree isolation", async () => {
    expect((await runValidate(await repo("worktree"))).problems).toEqual([]);
  });

  it("reports the stage when there is no worktree for its branch to be checked out in", async () => {
    const r = await runValidate(await repo("none"));
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([
      { rule: "branch", message: expect.stringMatching(/stage "build"[\s\S]*agent\.isolation[\s\S]*"none"/) },
    ]);
  });
});
