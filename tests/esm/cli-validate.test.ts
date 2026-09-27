import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runValidate } from "#cli/validate.js";
import { loadHooks } from "#hooks/load.js";
import { snapshotProvides } from "#runner/snapshot.js";
import { loadWorkflow } from "#workflow/load.js";
import { validate } from "#workflow/validate.js";
import type { Problem } from "#namespace.js";

/**
 * `landrace validate` with the hooks it will actually run.
 *
 * This file is in the ESM pass because the check under test only exists once
 * the hook modules have been imported, and the default pass's CommonJS runtime
 * cannot resolve the `file:` URL the loader hands `import()`. Checking path
 * coverage against a hand-written list of what the integration *says* it
 * provides would be checking the test's copy rather than the hook's.
 */
describe("landrace validate, against the hooks the workflow loads", () => {
  /*
   * The whole file, every rule, proved against the real thing rather than a
   * fixture. Two exceptions, both facts about this checkout and not the
   * workflow: whether a token resolves ("secret"), and whether `agsync sync`
   * has written this checkout's gitignored `.mcp.json` — which CI never has.
   *
   * Only that one missing-file problem is excused, matched by the whole of
   * its own message rather than a substring: an executor's several problems
   * are now several `executor` entries (see `startRefusalProblems`,
   * src/cli/validate.ts), so an unanchored match here could otherwise excuse
   * a real one bundled beside it. Any other executor problem — a name
   * `.mcp.json` does not define, the operator server allowed by name — still
   * fails this test, as does any other rule. tests/hooks/claude-mcp.test.ts
   * asks the same question of the file agsync would generate, on every
   * machine.
   */
  it("validates the shipped .landrace workflow clean, on every rule", async () => {
    const r = await runValidate(".landrace");
    const missingMcpJson =
      /^executor "claude" could not start: mcp: agent\.mcp names "codebase-memory-mcp", but .*\.mcp\.json does not exist; `agsync sync` generates it$/;
    const machine = (p: Problem): boolean =>
      p.rule === "secret" || (p.rule === "executor" && missingMcpJson.test(p.message));
    expect(r.problems.filter((p) => !machine(p))).toEqual([]);
  });

  /*
   * The engine's child-ticket feature lives in a fixture now that the shipped
   * workflow is a single flow, and it has to stay a workflow a project could
   * actually copy: clean on every rule, including the tickets:create ↔
   * nodes.close pairing and the entry record a creating stage must write. It
   * declares no hooks of its own (a hook path must stay inside its directory),
   * so path coverage is asked against the shipped GitHub hook — the one that
   * reports child-of — rather than left to abstain.
   */
  it("validates the children fixture clean, and covered by the shipped GitHub hook", async () => {
    const r = await runValidate("tests/fixtures/children");
    expect(r.problems.filter((p) => p.rule !== "secret")).toEqual([]);

    const { workflow, steps } = await loadWorkflow("tests/fixtures/children");
    const registry = await loadHooks({ dir: ".landrace", modules: ["hooks/github.ts"] });
    const provided = snapshotProvides(registry.pre, registry.source);
    expect(provided).not.toBeNull();
    expect(validate(workflow, steps, provided ?? undefined)).toEqual([]);
  });

  /**
   * And clean for the right reason.
   *
   * §11's rule 8 was dormant — `runValidate` never passed `provided`, so the
   * rule compared nothing to nothing and reported the shipped workflow valid
   * while a pull request gate had no hook behind it and a real ticket waited
   * at `build` forever. This asks the same file with the source's relations
   * taken back out, and requires it to say so: a `rel.implements` path is
   * covered because the source declares `implements`, not because anything
   * under `rel` passes.
   */
  it("reports the pull request gates when the source does not declare implements", async () => {
    const { workflow, steps } = await loadWorkflow(".landrace");
    const registry = await loadHooks({ dir: ".landrace", modules: workflow.hooks ?? [] });
    const empty = async () => ({ nodes: [], relationships: [] });
    const undeclaring = { id: "none", relations: [], list: empty, read: empty };

    const without = validate(workflow, steps, snapshotProvides(registry.pre, undeclaring) ?? undefined);
    const messages = without.filter((p) => p.rule === "path-coverage").map((p) => p.message);

    expect(messages).toEqual(expect.arrayContaining([
      expect.stringContaining("rel.implements.in.total"),
      expect.stringContaining("rel.implements.in.sum.openThreads"),
      expect.stringContaining("rel.implements.in.not.merged"),
    ]));
    // And with it loaded, nothing: the same rule, the same workflow.
    expect(validate(workflow, steps, snapshotProvides(registry.pre, registry.source) ?? undefined)
      .filter((p) => p.rule === "path-coverage")).toEqual([]);
  });

  /**
   * `landrace validate` builds the same executors `start` would, in the same
   * words it refuses with, under rule `executor` — an executor's own setup
   * can read files outside the workflow (`.mcp.json`, for the shipped claude
   * hook), so a configuration mistake there is exactly as much `validate`'s
   * business as a broken predicate path is.
   */
  it("reports an executor that cannot start, in the words start refuses with", async () => {
    const dir = await validateDirWithClaudeHook("plugin: [p@m]");
    const r = await runValidate(dir);
    expect(r.problems).toContainEqual({ rule: "executor", message: expect.stringMatching(/executor "claude" could not start: agent\.plugin/) });
  });

  /**
   * A factory can refuse for several reasons at once — two unrecognised
   * `agent.*` keys here — joined by `\n` into the one message it throws.
   * Left whole, that printed as a single multi-line entry under one
   * `  executor: ` line (`src/cli/index.ts`) and counted as one problem
   * rather than two; split, each line is its own `executor` problem, with
   * the same `executor "claude" could not start: ` prefix `start` throws
   * with.
   */
  it("splits a factory's multi-line refusal into one executor problem per line", async () => {
    const dir = await validateDirWithClaudeHook("plugin: [p@m], scope: x");
    const r = await runValidate(dir);
    const executor = r.problems.filter((p) => p.rule === "executor");
    expect(executor).toHaveLength(2);
    expect(executor.every((p) => !p.message.includes("\n"))).toBe(true);
    expect(executor.map((p) => p.message)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^executor "claude" could not start: agent\.plugin is not a setting the claude executor reads$/),
      expect.stringMatching(/^executor "claude" could not start: agent\.scope is not a setting the claude executor reads$/),
    ]));
  });

  /**
   * The wiring itself, end to end through the command: a path nothing
   * provides, in a workflow whose one hook does declare what it provides.
   *
   * Without this, every other test here passes whether or not `runValidate`
   * hands the union to the validator — which is exactly how the rule came to
   * be dormant in the first place.
   */
  it("reports a predicate path no loaded hook provides", async () => {
    const dir = await workflowDir(DECLARING_HOOK, { reads: '"artifacts.pr.number": { $exists: true }' });

    const r = await runValidate(dir);

    expect(r.ok).toBe(false);
    expect(r.problems).toContainEqual(expect.objectContaining({
      rule: "path-coverage",
      message: expect.stringContaining("artifacts.pr.number"),
    }));
  });

  /**
   * A hook module that cannot be imported is §11.1's "every referenced hook
   * file resolves", so it is a problem. It is also the one case where path
   * coverage has to abstain: with no registry there is nothing to compare
   * against, and reporting every path in the workflow as uncovered would bury
   * the one problem that is real.
   */
  it("reports a hook module that will not import, and does not then flag every path", async () => {
    const dir = await workflowDir("throw new Error('this module does not load');\n");

    const r = await runValidate(dir);

    expect(r.ok).toBe(false);
    expect(r.problems).toContainEqual(
      expect.objectContaining({ rule: "hooks", message: expect.stringContaining("this module does not load") }),
    );
    expect(r.problems.filter((p) => p.rule === "path-coverage")).toEqual([]);
  });

  /**
   * The ordering `buildRuntime` already pins, now that `validate` imports hook
   * modules too: importing one runs whatever is at its top level, and a
   * workflow that has already been found unsound must not get that far. A
   * command whose whole job is to check would be a strange place to run a
   * user's code against a workflow it is about to reject.
   */
  it("does not import a hook module for a workflow it has already found unsound", async () => {
    const dir = await workflowDir(
      "", { entry: false },
    );
    const ran = join(dir, "imported.txt");
    await writeFile(join(dir, "hook.ts"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(ran)}, "ran");\nexport const nothing = null;\n`);

    const r = await runValidate(dir);

    expect(r.problems.map((p) => p.rule)).toContain("entry");
    await expect(readFile(ran, "utf8")).rejects.toThrow();
  });
});

/**
 * A workflow directory with the real claude hook loaded and `agent:` set to
 * `adapter: claude, ${agentKeys}` — what both "reports an executor that
 * cannot start" and the multi-line case beside it need: a hook whose
 * `create()` can actually be reached and made to refuse.
 */
async function validateDirWithClaudeHook(agentKeys: string): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), "lr-validate-")), ".landrace");
  await mkdir(join(dir, "hooks"), { recursive: true });
  // A dynamic import with a computed specifier, not a static
  // `export … from "…claude.ts"`: ts-jest type-checks a literal specifier
  // under this project's `moduleResolution: NodeNext` and refuses one
  // ending in `.ts` (TS5097), a rule real Node's type-stripping does not
  // enforce at all.
  await writeFile(
    join(dir, "hooks", "claude.ts"),
    `import { pathToFileURL } from "node:url";
export const { claude } = await import(pathToFileURL(${JSON.stringify(join(process.cwd(), ".landrace", "hooks", "claude.ts"))}).href);
`,
  );
  await writeFile(join(dir, "landrace.yaml"), `version: 1\nagent: { adapter: claude, ${agentKeys} }\n`);
  await writeFile(join(dir, "workflow.yaml"), [
    "version: 1", "name: t", "hooks: [hooks/claude.ts]", "stages:",
    "  - id: a", "    entry: true", "    terminal: true", "    triggers:",
    "      - name: fresh", '        when: { "run.stage": null }', "",
  ].join("\n"));
  return dir;
}

/** A workflow directory with one hook module in it, written from `module`. */
async function workflowDir(module: string, opts: { entry?: boolean; reads?: string } = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "landrace-hooks-"));
  await writeFile(join(dir, "hook.ts"), module);
  await writeFile(join(dir, "workflow.yaml"), [
    "version: 1",
    "name: hooked",
    "hooks: [hook.ts]",
    "stages:",
    "  - id: spec",
    ...(opts.entry === false ? [] : ["    entry: true"]),
    "    triggers:",
    '      - { name: fresh, when: { "run.stage": null } }',
    "  - id: done",
    "    terminal: true",
    "    triggers:",
    `      - { name: written, when: { "run.outputs.spec": { $exists: true }${opts.reads ? `, ${opts.reads}` : ""} } }`,
  ].join("\n"));
  return dir;
}

/**
 * A pre hook the way a hook author's module exports one, branded through
 * `Symbol.for` exactly as `landrace/hooks` does it — so the fixture needs no
 * import, which a module in a temp directory could not resolve anyway.
 */
const DECLARING_HOOK = `const KIND = Symbol.for("landrace.hook.kind");
export const observe = Object.defineProperty(
  { id: "fixture", provides: ["ticket.labels"], run: () => ({}) },
  KIND, { value: "pre", enumerable: false },
);
`;
