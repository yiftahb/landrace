import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCredentialStore } from "#people/store.js";
import type { CredentialStore, LoadedWorkflow, Workspace } from "#namespace.js";
import { loadWorkspace } from "#workflow/workspace.js";

/**
 * This repository's own workflow, `full-cycle`, loaded the way the commands load
 * it: as one workflow of the `.landrace` workspace, its hook and step paths
 * resolved inside it.
 */
export async function loadShipped(vars?: ReadonlyMap<string, string>): Promise<LoadedWorkflow & { workspace: Workspace }> {
  const workspace = await loadWorkspace(".landrace", vars);
  const main = workspace.workflows.find((w) => w.id === "full-cycle");
  if (!main) throw new Error(`.landrace has no workflows/full-cycle; it has ${workspace.workflows.map((w) => w.id).join(", ")}`);
  return { ...main, workspace };
}

/**
 * A credentials store of its own, holding the local person's `github`
 * connection — or nothing, given `null`. The shipped `githubToken` is a
 * per-person key, and `validate` stops at one nothing answers, before the
 * hooks load: a test checking every rule of `.landrace` hands it this, so
 * neither this machine's store nor whether GITHUB_TOKEN is set decides how
 * far it gets.
 */
export async function connectedStore(token: string | null = "gho_stored0123456789abcdefghijklmnopqr"): Promise<CredentialStore> {
  const root = join(await mkdtemp(join(tmpdir(), "lr-shipped-creds-")), "credentials");
  if (token !== null) {
    await mkdir(root, { recursive: true });
    const github = { fields: { token }, source: "oauth", connectedAt: new Date().toISOString() };
    await writeFile(join(root, "local.json"), JSON.stringify({ person: { id: "local" }, connections: { github } }));
  }
  return createCredentialStore(root);
}
