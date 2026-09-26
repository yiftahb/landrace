import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OUTPUT_KIND, renderMarker } from "#conventions.js";
import type { Executor, Step, ToolOptions, Workflow } from "#namespace.js";
import { createMcpServer } from "#mcp/server.js";
import { createTools } from "#mcp/tools.js";
import { held } from "#runner/lock.js";
import { createFakeTracker, type FakeIssue } from "#tests/support/fake-tracker.js";

/** Wait for a fact rather than for a number of milliseconds. */
async function until(done: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (await done()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function connect(seed: Array<Partial<FakeIssue>> = [], opts: ToolOptions = {}) {
  const gh = createFakeTracker(seed);
  const server = createMcpServer(createTools(gh.registry, gh.ctx, opts));
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
      "landrace_ask",
      "landrace_create_ticket",
      "landrace_goto",
      "landrace_reply",
      "landrace_resolve",
      "landrace_status",
      "landrace_update_ticket",
      "landrace_waiting",
    ]);
    await client.close();
  });

  it("creates a ticket end to end through the protocol", async () => {
    const { client, gh } = await connect();
    const r = await client.callTool({ name: "landrace_create_ticket", arguments: { title: "Add CSV export" } });
    expect(JSON.parse(textOf(r))).toMatchObject({ ticket: "1", started: true });
    expect(gh.issues.get(1)?.title).toBe("Add CSV export");
    await client.close();
  });

  it("returns an error result rather than throwing when a ticket is missing", async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: "landrace_status", arguments: { ticket: 99 } });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(textOf(r)).toMatch(/error: .*#99 is not an issue/);
    await client.close();
  });

  it("enforces the argument schema and says why", async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: "landrace_status", arguments: { ticket: -1 } });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(textOf(r)).toMatch(/validation error.*ticket/i);
    await client.close();
  });

  it("still accepts a numeric ticket id, for clients written before ids were strings", async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: "landrace_status", arguments: { ticket: 99 } });
    expect(textOf(r)).toMatch(/#99 is not an issue/); // reached the tool
    await client.close();
  });

  it("accepts a string ticket id", async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: "landrace_status", arguments: { ticket: "99" } });
    expect(textOf(r)).toMatch(/#99 is not an issue/); // reached the tool, as the same ticket
    await client.close();
  });

  it("refuses a hostile ticket id before any tool runs", async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: "landrace_status", arguments: { ticket: "../x" } });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(textOf(r)).toMatch(/ticket id/);
    expect(textOf(r)).not.toMatch(/404|not an issue/);
    await client.close();
  });

  /**
   * The lock a conversation holds is the one that stops a tick resuming the
   * same session underneath it — and a conversation that takes it and never
   * gives it back starves that ticket for as long as the process lives. A
   * client that disconnects mid-call is the path nothing else covers: the
   * promise is still pending, so only the request's own abort signal ends it.
   */
  it("gives the ticket's lock back when a client disconnects in the middle of a turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "lr-mcp-"));
    const hanging: Executor = {
      id: "hanging",
      run: (_p, o) =>
        new Promise((_resolve, reject) => {
          o.signal.addEventListener("abort", () => reject(new Error("agent aborted")), { once: true });
        }),
    };
    const { client, gh } = await connect(
      [{ number: 1, labels: ["lr:auto", "lr:stage:spec"] }],
      {
        executor: hanging,
        lock: { root },
        // A turn is held to what its step declared, so the conversation has to
        // be told what that is — as the loop tells it.
        workflow: { version: 1, name: "t", stages: [{ id: "spec", step: "spec", triggers: [] }] } as Workflow,
        steps: new Map<string, Step>([["spec", { prompt: "write the spec", capabilities: ["repo:read"] }]]),
      },
    );
    gh.say(
      1,
      "draft" +
        renderMarker({ stage: "spec", kind: OUTPUT_KIND, round: 1, session: "sid-1", output: { kind: "questions" } }),
    );

    const call = client.callTool({ name: "landrace_ask", arguments: { ticket: 1, message: "B2B only" } });
    // Polled, not slept for. Both of these used to be a flat 30ms — a bet on
    // how long the handler takes to reach the lock and how long its finally
    // takes to give it back, on a machine running the rest of this suite
    // beside it. Waiting for the fact itself is the same assertion without
    // the bet.
    await until(async () => (await held("1", { root })) !== null, "the turn to take the lock");

    await client.close();
    await call.catch(() => undefined);
    await until(async () => (await held("1", { root })) === null, "the turn to give the lock back");
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
