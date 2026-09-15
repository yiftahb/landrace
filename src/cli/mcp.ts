import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../config/load.js";
import { createGitHubClient } from "../github/client.js";
import { createMcpServer } from "../mcp/server.js";
import { createTools } from "../mcp/tools.js";

export async function runMcp(dir: string): Promise<void> {
  const { config, missing, secretValues } = await loadConfig(dir);
  if (missing.length) {
    throw new Error(`secret(s) do not resolve: ${missing.join(", ")}. Set them in ${dir}/.env`);
  }
  const token = secretValues.get("githubToken");
  if (!token) throw new Error(`no githubToken secret declared in ${dir}/landrace.yaml`);

  const gh = createGitHubClient({ repo: config.tracker.repo, token });
  const server = createMcpServer(createTools(gh));
  await server.connect(new StdioServerTransport());
}
