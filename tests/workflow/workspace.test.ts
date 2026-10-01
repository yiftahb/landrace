import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkspace } from "#workflow/workspace.js";

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
