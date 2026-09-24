import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createChildMcpServer } from "#mcp/server.js";
import type { NewChild } from "#namespace.js";

async function connect(onCreate: (i: NewChild) => void) {
  const server = createChildMcpServer({
    createChild: async (i) => { onCreate(i); return { ticket: "7", title: i.title, link: "u/7" }; },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

describe("the child MCP server", () => {
  it("offers exactly one tool, and it takes no parent, stage or round", async () => {
    const client = await connect(() => {});
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name)).toEqual(["landrace_create_child"]);
    const props = Object.keys((tools[0]?.inputSchema as { properties: object }).properties);
    expect(props.sort()).toEqual(["body", "priority", "title"]);
    await client.close();
  });

  it("passes title, body and priority through, and nothing else", async () => {
    const seen: NewChild[] = [];
    const client = await connect((i) => seen.push(i));
    await client.callTool({ name: "landrace_create_child", arguments: { title: "api", body: "b", priority: 2, parent: "99" } });
    expect(seen).toEqual([{ title: "api", body: "b", priority: 2 }]);
    await client.close();
  });
});
