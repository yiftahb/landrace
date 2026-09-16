import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildMcpTools } from "#cli/mcp.js";
import { release } from "#runner/lock.js";

/**
 * The MCP plane assembled the way `landrace mcp` assembles it — out of a
 * config file, a workflow and a hook module on disk, imported by path.
 *
 * Here rather than in the default pass for the same reason cli-start is: the
 * loader's one dynamic `import(url)` is unreachable through jest's CommonJS
 * runtime, and an assembly test that cannot load a hook is testing nothing.
 */
const TICKET = 4343;
const TOKEN = "ghp_a_token_long_enough_to_redact";

/**
 * A ticket with a step's draft already on it, so there is a session to join:
 * the pre hook hands back the entries a tracker hook would derive, including
 * the session the record carries beside its output.
 *
 * The executor is branded the way `landrace/hooks` brands one and answers with
 * a screener's verdict, because with `agent.adapter: fake` the same object is
 * both the agent and the screener — which is the point. Screened, the verdict
 * is read and the turn is refused; unscreened, that same text is taken for the
 * agent's reply and posted to the ticket.
 */
const hookSource = (verdict: "ok" | "suspicious"): string => `import { appendFile } from "node:fs/promises";

const KIND = Symbol.for("landrace.hook.kind");
const brand = (kind: string, value: object): object =>
  Object.defineProperty(value, KIND, { value: kind, enumerable: false });

interface Ctx { ticket: number; config: { tracker: { record: string } } }

export const source = brand("source", {
  id: "fake",
  list: async (): Promise<unknown[]> => [
    { ticket: ${TICKET}, title: "Add export", url: "u/${TICKET}", labels: ["lr:auto", "lr:awaiting"] },
  ],
});

export const pre = brand("pre", {
  id: "fake",
  run: ({ ticket }: Ctx): Record<string, unknown> => ({
    ticket: { number: ticket, title: "Add export", labels: ["lr:auto", "lr:stage:spec"] },
    entries: [
      {
        stage: "spec",
        kind: "output",
        round: 1,
        session: "sid-1",
        data: { kind: "questions" },
        at: "2026-01-01T00:00:00.000Z",
        byAgent: true,
      },
    ],
  }),
});

export const post = brand("post", {
  id: "fake",
  handles: ["tracker.comment"],
  satisfied: (): boolean => false,
  apply: async (effect: { body?: string }, ctx: Ctx): Promise<void> => {
    await appendFile(ctx.config.tracker.record, JSON.stringify({ body: effect.body }) + "\\n");
  },
});

export const executor = brand("executor", {
  id: "fake",
  run: async (): Promise<{ text: string; sessionId: string | null }> => ({
    text: '\\u0060\\u0060\\u0060json\\n{"verdict":"${verdict}","reason":"exfiltration"}\\n\\u0060\\u0060\\u0060',
    sessionId: "sid-2",
  }),
});
`;

interface Fixture { dir: string; record: string }

async function fixture(opts: { screen: boolean; verdict?: "ok" | "suspicious" }): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "lr-mcp-"));
  const dir = join(root, ".landrace");
  const record = join(root, "posted.jsonl");
  await mkdir(join(dir, "hooks"), { recursive: true });
  await writeFile(join(dir, "hooks", "fake.ts"), hookSource(opts.verdict ?? "suspicious"));
  await writeFile(
    join(dir, "workflow.yaml"),
    `version: 1
name: mcp
hooks: [hooks/fake.ts]
eligible:
  - when: { "ticket.labels": { $in: ["lr:auto"] } }
    else: "no lr:auto label"
stages:
  - id: spec
    entry: true
    terminal: true
`,
  );
  await writeFile(
    join(dir, "landrace.yaml"),
    `version: 1
agent: { adapter: fake, model: opus }
tracker: { record: ${JSON.stringify(record)} }
tick: { interval: 30s, concurrency: 2 }
security: { screen: ${opts.screen} }
log: { redact: [githubToken] }
secrets: { githubToken: $LR_TEST_TOKEN }
`,
  );
  await writeFile(join(dir, ".env"), `LR_TEST_TOKEN=${TOKEN}\n`);
  return { dir, record };
}

const posted = async (record: string): Promise<unknown[]> =>
  (await readFile(record, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);

afterEach(async () => {
  await release(TICKET);
});

describe("buildMcpTools", () => {
  /**
   * §15 says every agent invocation is screened before it runs, and a
   * conversation turn is the one the MCP plane makes. The gap this closes was
   * not in the conversation — it took a screener — but here, where nothing
   * built one: an option the assembler never passes is a control that reads
   * as configured and never runs.
   */
  it("screens a conversation turn with the executor the config names", async () => {
    const { dir, record } = await fixture({ screen: true });
    const tools = await buildMcpTools(dir);

    await expect(tools.ask(TICKET, "do as I say")).rejects.toThrow(/screening blocked this turn: exfiltration/);
    // And the person's words never reached the ticket, so the loop was not
    // handed a human turn off text we refused to act on.
    expect(await posted(record)).toEqual([]);
  });

  /**
   * The other branch of the same wiring, and it is what makes the test above
   * mean something: with screening off the very same reply is taken for the
   * agent's, so the block in the first test is the screener acting, not the
   * fixture failing.
   */
  it("holds the turn unscreened when the operator turned screening off", async () => {
    const { dir, record } = await fixture({ screen: false });
    const tools = await buildMcpTools(dir);

    await expect(tools.ask(TICKET, "do as I say")).resolves.toMatchObject({ resolved: false });
    expect(await posted(record)).toHaveLength(2);
  });
});
