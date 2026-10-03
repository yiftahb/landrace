import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runInit } from "#cli/init.js";
import { runValidate } from "#cli/validate.js";
import { configProblems, loadConfig } from "#config/load.js";

const exec = promisify(execFile);
const fresh = (): Promise<string> => mkdtemp(join(tmpdir(), "landrace-init-"));

/** Every file under `dir`, by path, with its contents: what "nothing changed" is compared on. */
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    const path = join(e.parentPath, e.name);
    out[path.slice(dir.length + 1)] = e.isDirectory() ? "<dir>" : await readFile(path, "utf8");
  }
  return out;
}

/*
 * The skeleton names an agent no hook registers yet — it ships no hooks, and
 * the engine names no vendor — so that one executor problem is what validate
 * owes a fresh init. Anything else is the skeleton being wrong.
 */
const beyondTheMissingAgent = (problems: { rule: string }[]) => problems.filter((p) => p.rule !== "executor");

describe("landrace init", () => {
  it("makes .landrace/ in a fresh directory: the config, the workflow, its steps/ and the .gitignore entry", async () => {
    const cwd = await fresh();
    const lines = await runInit(cwd, "triage");

    expect(Object.keys(await tree(cwd)).sort()).toEqual([
      ".gitignore",
      ".landrace",
      ".landrace/landrace.yaml",
      ".landrace/workflows",
      ".landrace/workflows/triage",
      ".landrace/workflows/triage/steps",
      ".landrace/workflows/triage/steps/.gitkeep",
      ".landrace/workflows/triage/workflow.yaml",
    ]);
    expect(await readFile(join(cwd, ".gitignore"), "utf8")).toBe(".landrace/.env\n");

    // Path by path, then what to do next.
    for (const path of [".landrace/landrace.yaml", ".landrace/workflows/triage/workflow.yaml", ".landrace/workflows/triage/steps/.gitkeep", ".gitignore"]) {
      expect(lines).toContainEqual(expect.stringContaining(path));
    }
    expect(lines.at(-1)).toMatch(/landrace validate/);
  });

  it("writes a landrace.yaml that loads as written, with every key commented", async () => {
    const cwd = await fresh();
    await runInit(cwd, "triage");
    const dir = join(cwd, ".landrace");

    const loaded = await loadConfig(dir);
    expect(configProblems(dir, loaded)).toEqual([]);
    const text = await readFile(join(dir, "landrace.yaml"), "utf8");
    // The repository and the secrets, as commented placeholders.
    expect(text).toMatch(/^# tracker:/m);
    expect(text).toMatch(/^# secrets:/m);
  });

  it("writes a skeleton that validate passes, admitting with a label its own eligible accepts", async () => {
    const cwd = await fresh();
    await runInit(cwd, "triage");

    const { problems } = await runValidate(join(cwd, ".landrace"));
    expect(beyondTheMissingAgent(problems)).toEqual([]);
    const yaml = await readFile(join(cwd, ".landrace/workflows/triage/workflow.yaml"), "utf8");
    expect(yaml).toMatch(/^admit: \["lr:triage"\]$/m);
    expect(yaml).not.toMatch(/^hooks:/m);
    expect(yaml).not.toMatch(/^\s+step:/m);
  });

  // YAML reads a bare 123 as a number, and `name` must be a string.
  it("writes a skeleton that validates for a name YAML would read as a number", async () => {
    const cwd = await fresh();
    await runInit(cwd, "123");
    expect(beyondTheMissingAgent((await runValidate(join(cwd, ".landrace"))).problems)).toEqual([]);
  });

  it("adds only the new workflow when .landrace/ exists", async () => {
    const cwd = await fresh();
    await runInit(cwd, "triage");
    const config = await readFile(join(cwd, ".landrace/landrace.yaml"), "utf8");
    const ignore = await readFile(join(cwd, ".gitignore"), "utf8");

    const lines = await runInit(cwd, "release");

    expect(Object.keys(await tree(join(cwd, ".landrace/workflows/release"))).sort()).toEqual(["steps", "steps/.gitkeep", "workflow.yaml"]);
    expect(await readFile(join(cwd, ".landrace/landrace.yaml"), "utf8")).toBe(config);
    expect(await readFile(join(cwd, ".gitignore"), "utf8")).toBe(ignore);
    expect(lines.filter((l) => /landrace\.yaml|\.gitignore/.test(l))).toEqual([]);
    expect(beyondTheMissingAgent((await runValidate(join(cwd, ".landrace"))).problems)).toEqual([]);
  });

  it("refuses a workflow folder that already exists, and changes nothing", async () => {
    const cwd = await fresh();
    await runInit(cwd, "triage");
    await writeFile(join(cwd, ".landrace/workflows/triage/workflow.yaml"), "edited\n");
    const before = await tree(cwd);

    await expect(runInit(cwd, "triage")).rejects.toThrow(/\.landrace\/workflows\/triage.* already exists/);
    expect(await tree(cwd)).toEqual(before);
  });

  it("refuses an existing workflow folder even with nothing in it", async () => {
    const cwd = await fresh();
    await mkdir(join(cwd, ".landrace/workflows/triage"), { recursive: true });
    const before = await tree(cwd);

    await expect(runInit(cwd, "triage")).rejects.toThrow(/already exists/);
    expect(await tree(cwd)).toEqual(before);
  });

  it.each(["Triage", "-triage", "tri_age", "a/b", "../x", "", "a".repeat(65)])("refuses %j as a workflow id, naming the rule, and writes nothing", async (name) => {
    const cwd = await fresh();
    await expect(runInit(cwd, name)).rejects.toThrow(/not a usable workflow id: lowercase letters, digits and "-", starting with a letter or digit/);
    expect(await tree(cwd)).toEqual({});
  });

  it("accepts an id at the 64-character limit", async () => {
    const cwd = await fresh();
    await runInit(cwd, "a".repeat(64));
    expect(beyondTheMissingAgent((await runValidate(join(cwd, ".landrace"))).problems)).toEqual([]);
  });

  // Its admit label would be one the engine writes, which validate refuses.
  it("refuses a name whose admit label is the engine's own, and writes nothing", async () => {
    const cwd = await fresh();
    await expect(runInit(cwd, "blocked")).rejects.toThrow(/lr:blocked/);
    expect(await tree(cwd)).toEqual({});
  });
});

describe("landrace init's .gitignore entry", () => {
  it("appends to a .gitignore that does not ignore .landrace/.env, on a line of its own", async () => {
    const cwd = await fresh();
    await writeFile(join(cwd, ".gitignore"), "node_modules/");
    const lines = await runInit(cwd, "triage");
    expect(await readFile(join(cwd, ".gitignore"), "utf8")).toBe("node_modules/\n.landrace/.env\n");
    expect(lines).toContainEqual(expect.stringContaining(".gitignore"));
  });

  it("leaves a .gitignore alone when git already ignores .landrace/.env through a broader pattern", async () => {
    const cwd = await fresh();
    await exec("git", ["init", "-q"], { cwd });
    await writeFile(join(cwd, ".gitignore"), ".env\n");
    const lines = await runInit(cwd, "triage");
    expect(await readFile(join(cwd, ".gitignore"), "utf8")).toBe(".env\n");
    expect(lines.filter((l) => l.includes(".gitignore"))).toEqual([]);
  });

  it("leaves a .gitignore alone that already names .landrace/.env, outside any git repository", async () => {
    const cwd = await fresh();
    await writeFile(join(cwd, ".gitignore"), "dist/\n.landrace/.env\n");
    await runInit(cwd, "triage");
    expect(await readFile(join(cwd, ".gitignore"), "utf8")).toBe("dist/\n.landrace/.env\n");
  });
});

describe("the landrace binary", () => {
  const cli = join(process.cwd(), "src/cli/index.ts");
  const run = (args: string[], cwd: string) => exec(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, ...args], { cwd });

  it("lists init in --help", async () => {
    const { stdout } = await run(["--help"], process.cwd());
    expect(stdout).toMatch(/^\s+init \[options\] <name>|^\s+init <name>/m);
  });

  it("runs init in the current directory and prints what it made", async () => {
    const cwd = await fresh();
    const { stdout } = await run(["init", "triage"], cwd);
    expect(stdout).toContain(".landrace/workflows/triage/workflow.yaml");
    expect(Object.keys(await tree(cwd))).toContain(".landrace/landrace.yaml");
  });

  it("reports a refusal on stderr and exits 1, without a stack trace", async () => {
    const cwd = await fresh();
    const failure = await run(["init", "Bad"], cwd).then(() => null, (e: { code?: number; stderr?: string }) => e);
    expect(failure?.code).toBe(1);
    expect(failure?.stderr?.trim()).toMatch(/^landrace init: "Bad" is not a usable workflow id/);
  });
});
