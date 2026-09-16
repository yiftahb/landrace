import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { createTools } from "../../src/mcp/tools.js";
import { createFakeTracker, type FakeIssue } from "../support/fake-tracker.js";

async function connect(seed: Array<Partial<FakeIssue>> = []) {
  const gh = createFakeTracker(seed);
  const server = createMcpServer(createTools(gh.registry, gh.ctx));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, gh };
}

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

describe("mcp server over a real transport", () => {
  it("advertises exactly the tools it implements", async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "landrace_create_ticket",
      "landrace_reply",
      "landrace_status",
      "landrace_update_ticket",
      "landrace_waiting",
    ]);
    await client.close();
  });

  it("creates a ticket end to end through the protocol", async () => {
    const { client, gh } = await connect();
    const r = await client.callTool({ name: "landrace_create_ticket", arguments: { title: "Add CSV export" } });
    expect(JSON.parse(textOf(r))).toMatchObject({ ticket: 1, started: true });
    expect(gh.issues.get(1)?.title).toBe("Add CSV export");
    await client.close();
  });

  it("returns an error result rather than throwing when a ticket is missing", async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: "landrace_status", arguments: { ticket: 99 } });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(textOf(r)).toMatch(/error: .*404/);
    await client.close();
  });

  it("enforces the argument schema and says why", async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: "landrace_status", arguments: { ticket: -1 } });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(textOf(r)).toMatch(/validation error.*ticket/i);
    await client.close();
  });

  it("starting a ticket is opt-out, and the tool says which it did", async () => {
    const { client, gh } = await connect();
    const r = await client.callTool({
      name: "landrace_create_ticket",
      arguments: { title: "File for later", start: false },
    });
    expect(JSON.parse(textOf(r))).toMatchObject({ started: false });
    expect(gh.labelsOf(1)).not.toContain("lr:auto");
    await client.close();
  });
});
