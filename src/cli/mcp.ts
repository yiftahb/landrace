import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../config/load.js";
import { createTrackerAdapter } from "../adapters/index.js";
import { createMcpServer } from "../mcp/server.js";
import { createTools } from "../mcp/tools.js";

export async function runMcp(dir: string): Promise<void> {
  const { config, missing, secretValues } = await loadConfig(dir);
  if (missing.length) {
    throw new Error(`secret(s) do not resolve: ${missing.join(", ")}. Set them in ${dir}/.env`);
  }
  const token = secretValues.get("githubToken");
  if (!token) throw new Error(`no githubToken secret declared in ${dir}/landrace.yaml`);

  // Reached by id, never imported: the operator tools depend on TrackerPort,
  // not on which tracker is behind it.
  const adapter = createTrackerAdapter(config.tracker.adapter, { repo: config.tracker.repo, token });
  const server = createMcpServer(createTools(adapter));
  await server.connect(new StdioServerTransport());
}
