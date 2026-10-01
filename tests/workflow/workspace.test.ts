import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowLoadError } from "#workflow/load.js";
import { loadWorkspace, onlyWorkflow } from "#workflow/workspace.js";

async function workspaceWith(map: Record<string, { name: string }>): Promise<string> {
  const ws = await mkdtemp(join(tmpdir(), "lr-ws-"));
  for (const [id, { name }] of Object.entries(map)) {
    const dir = join(ws, "workflows", id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "workflow.yaml"),
      `version: 1\nname: ${JSON.stringify(name)}\ndescription: "d"\nstages:\n  - { id: a, entry: true, terminal: true }\n`,
    );
  }
  return ws;
}

describe("loadWorkspace", () => {
  it("loads every workflows/<id>/workflow.yaml, sorted by name", async () => {
    const ws = await workspaceWith({ main: { name: "Main" }, fastlane: { name: "Fastlane" } });
    expect((await loadWorkspace(ws)).workflows.map((w) => w.id)).toEqual(["fastlane", "main"]);
  });
  it("follows the configured order, which must name exactly the folders", async () => {
    const ws = await workspaceWith({ fastlane: { name: "Fastlane" }, main: { name: "Main" } });
    expect((await loadWorkspace(ws, new Map(), ["main", "fastlane"])).workflows.map((w) => w.id)).toEqual(["main", "fastlane"]);
    await expect(loadWorkspace(ws, new Map(), ["main"])).rejects.toThrow(/workflows.*fastlane/);
    await expect(loadWorkspace(ws, new Map(), ["main", "fastlane", "x"])).rejects.toThrow(/workflows.*"x"/);
  });
  it("refuses the single-workflow layout, saying where to move it", async () => {
    const ws = await workspaceWith({ main: { name: "Main" } });
    await writeFile(join(ws, "workflow.yaml"), "version: 1\n");
    await expect(loadWorkspace(ws)).rejects.toThrow(/workflow\.yaml.*workflows\/main\/workflow\.yaml/);
  });
  it("names the other edits the old layout needs: hook paths, description and admit", async () => {
    const ws = await workspaceWith({ main: { name: "Main" } });
    await writeFile(join(ws, "workflow.yaml"), "version: 1\n");
    await expect(loadWorkspace(ws)).rejects.toThrow(/\.\.\/\.\.\/hooks\/<module>\.ts.*description:.*admit:/);
  });
  it("told a workflow folder, says it is one workflow and names the workspace", async () => {
    const ws = await workspaceWith({ main: { name: "Main" } });
    const one = join(ws, "workflows", "main");
    await expect(loadWorkspace(one)).rejects.toThrow(`${one} is one workflow of the workspace ${ws}; run with --workspace ${ws}`);
  });
  it("refuses workflows/ itself being a symbolic link", async () => {
    const ws = await mkdtemp(join(tmpdir(), "lr-ws-"));
    const real = await workspaceWith({ main: { name: "Main" } });
    await symlink(join(real, "workflows"), join(ws, "workflows"));
    await expect(loadWorkspace(ws)).rejects.toMatchObject({
      rule: "layout", message: "workflows is a symbolic link; workflows must be a real folder inside the workspace",
    });
  });
  it("refuses a workspace with no workflows", async () => {
    const ws = await mkdtemp(join(tmpdir(), "lr-ws-"));
    await expect(loadWorkspace(ws)).rejects.toThrow(/no workflows.*workflows\/<id>\/workflow\.yaml/);
  });
  it("refuses a folder whose name is not a usable id", async () => {
    const ws = await workspaceWith({ "Main Flow": { name: "Main" } });
    await expect(loadWorkspace(ws)).rejects.toThrow(/"Main Flow"/);
  });
  it("ignores a folder under workflows/ with no workflow.yaml", async () => {
    const ws = await workspaceWith({ main: { name: "Main" } });
    await mkdir(join(ws, "workflows", "drafts"));
    expect((await loadWorkspace(ws)).workflows.map((w) => w.id)).toEqual(["main"]);
  });
  it("refuses a workflow folder that is a symbolic link, inside the workspace or out of it", async () => {
    for (const target of ["inside", "outside"]) {
      const ws = await workspaceWith({ main: { name: "Main" } });
      const real = target === "inside" ? join(ws, "workflows", "main") : (await workspaceWith({ main: { name: "Main" } })) + "/workflows/main";
      await symlink(real, join(ws, "workflows", "linked"));
      await expect(loadWorkspace(ws)).rejects.toThrow(/workflows\/linked is a symbolic link; a workflow must be a real folder inside the workspace/);
      await expect(loadWorkspace(ws, new Map(), ["main", "linked"])).rejects.toThrow(/symbolic link/);
    }
  });
  it("refuses an order that names a workflow twice", async () => {
    const ws = await workspaceWith({ main: { name: "Main" } });
    await expect(loadWorkspace(ws, new Map(), ["main", "main"])).rejects.toThrow(/workflows: names "main" twice/);
  });
  it("orders by code point, not by the machine's locale", async () => {
    const ws = await workspaceWith({ a: { name: "alpha" }, z: { name: "Zed" } });
    expect((await loadWorkspace(ws)).workflows.map((w) => w.id)).toEqual(["z", "a"]);
  });
});

/*
 * Until a workspace can run several workflows at once, a command that runs one
 * takes the only one there is — and refuses two rather than running whichever
 * sorted first, which is the "first match wins" this codebase never does.
 */
describe("onlyWorkflow", () => {
  it("is the workspace's one workflow", async () => {
    const ws = await loadWorkspace(await workspaceWith({ main: { name: "Main" } }));
    expect(onlyWorkflow(ws, "start").id).toBe("main");
  });
  it("refuses two, naming the command, the folder and both ids", async () => {
    const ws = await loadWorkspace(await workspaceWith({ main: { name: "Main" }, fastlane: { name: "Fastlane" } }));
    expect(() => onlyWorkflow(ws, "start"))
      .toThrow(`landrace start runs one workflow at a time; ${ws.dir}/workflows has 2 (fastlane, main)`);
  });
});

/** A workspace of the given workflow.yaml texts, by id. */
async function workspaceOfYaml(map: Record<string, string>): Promise<string> {
  const ws = await mkdtemp(join(tmpdir(), "lr-ws-"));
  for (const [id, yaml] of Object.entries(map)) {
    await mkdir(join(ws, "workflows", id), { recursive: true });
    await writeFile(join(ws, "workflows", id, "workflow.yaml"), yaml);
  }
  return ws;
}

const flow = (name: string, extra = ""): string =>
  `version: 1\nname: ${name}\ndescription: "d"\n${extra}stages:\n  - { id: a, entry: true, terminal: true }\n`;

/*
 * `vars` is the workspace's, in landrace.yaml beside every workflow, so "is
 * anything reading this" is asked of all of them together: a var only main
 * reads is not fastlane's typo, and one nobody reads is one problem, not one
 * per workflow.
 */
describe("loadWorkspace and the workspace's vars", () => {
  const who = new Map([["who", "ann"]]);

  it("loads a var only one of its workflows reads", async () => {
    const ws = await workspaceOfYaml({ main: flow("Main", 'admit: ["for:{vars.who}"]\n'), fastlane: flow("Fastlane") });
    const loaded = await loadWorkspace(ws, who);
    expect(loaded.workflows.find((w) => w.id === "main")?.workflow.admit).toEqual(["for:ann"]);
  });

  it("refuses a var no workflow reads, once", async () => {
    const ws = await workspaceOfYaml({ main: flow("Main"), fastlane: flow("Fastlane") });
    const err = await loadWorkspace(ws, who).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowLoadError);
    expect((err as WorkflowLoadError).rule).toBe("vars");
    expect((err as Error).message.match(/vars entry "who" is declared and nothing references it/g)).toHaveLength(1);
  });

  it("still says which workflow a var nothing defines is used in", async () => {
    const ws = await workspaceOfYaml({ main: flow("Main", 'admit: ["for:{vars.nobody}"]\n'), fastlane: flow("Fastlane") });
    await expect(loadWorkspace(ws, new Map())).rejects.toThrow(/^workflows\/main: workflow\.yaml .*uses \{vars\.nobody\}, which no vars entry defines/);
  });
});

/*
 * A workflow that will not load is a fact about that folder, and the others
 * are still worth reading: every one is tried, each failure says which folder
 * it is in, and the workspace is refused once they all have been.
 */
describe("loadWorkspace and a workflow that will not load", () => {
  const DUPLICATE = "version: 1\nname: Main\ndescription: d\nstages:\n  - { id: a, entry: true, terminal: true }\n  - { id: a, terminal: true }\n";
  const MISSING_STEP = "version: 1\nname: Fastlane\ndescription: d\nstages:\n  - { id: a, entry: true, terminal: true, step: steps/nope.md }\n";

  it("tries every workflow, and names the folder of each failure", async () => {
    const ws = await workspaceOfYaml({ main: DUPLICATE, fastlane: MISSING_STEP });
    const err = await loadWorkspace(ws).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowLoadError);
    // The first failure's rule, in id order: fastlane before main.
    expect((err as WorkflowLoadError).rule).toBe("missing-step");
    expect((err as Error).message).toMatch(/^workflows\/fastlane: stage "a" names a step file that does not exist: steps\/nope\.md/);
    expect((err as Error).message).toContain('; workflows/main: duplicate stage id "a"');
  });

  it("names the folder when it is the only workflow, too", async () => {
    const ws = await workspaceOfYaml({ main: DUPLICATE });
    await expect(loadWorkspace(ws)).rejects.toThrow('workflows/main: duplicate stage id "a"');
  });
});
