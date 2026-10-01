import { defineNotifier } from "#hooks/contracts.js";
import { runtimeConfigSchema } from "#config/schema.js";
import { createNotify, notifyProblems } from "#runner/notify.js";
import type { Node, Notifier, NotifyEvent, RuntimeConfig, RuntimeContext, Workflow } from "#namespace.js";

const workflow: Workflow = {
  version: 1, name: "t", description: "test",
  eligible: [{ when: { "node.state.labels": { $in: ["lr:auto"] } }, else: "no lr:auto label" }],
  stages: [
    { id: "spec-questions", triggers: [{ when: { "run.stage": null } }] },
    { id: "build", triggers: [{ when: { "run.stage": "spec-questions" } }] },
  ],
};

const node = (labels: string[], title = "Add export"): Node => ({
  id: "29", kind: "item", title, link: "https://tracker.example/29", closed: null, priority: null, origin: null,
  state: { labels: ["lr:auto", ...labels] },
});
const waiting = { node: node(["lr:stage:spec-questions", "lr:awaiting"]) };

const config = (notify?: unknown): RuntimeConfig =>
  runtimeConfigSchema.parse({ version: 1, agent: { adapter: "fake" }, ...(notify == null ? {} : { notify }) });

const ctx: RuntimeContext = { config: config(), secrets: new Map(), signal: new AbortController().signal, log: () => {} };

/** Fire-and-forget: what a send did is only visible once its promise has had a turn. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function harness(notifiers: Notifier[], notify: unknown = { on: ["needs-you"], via: notifiers.map((n) => n.id) }) {
  const events: Array<{ name: string; data?: Record<string, unknown> }> = [];
  const fire = createNotify({
    workflow, notify: config(notify).notify, notifiers: new Map(notifiers.map((n) => [n.id, n])), ctx,
    log: (name, data) => events.push({ name, ...(data ? { data } : {}) }),
    board: () => "http://127.0.0.1:4545",
  });
  return { fire, events };
}

const recorder = (id: string) => {
  const sent: NotifyEvent[] = [];
  return { sent, notifier: defineNotifier({ id, send: async (e) => { sent.push(e); } }) };
};

describe("createNotify", () => {
  it("tells each notifier once what the board says about an item waiting on you", async () => {
    const { sent, notifier } = recorder("chat");
    const { fire, events } = harness([notifier]);

    fire(waiting);
    await settle();

    expect(sent).toEqual([{
      event: "needs-you", item: "29", title: "Add export", link: "https://tracker.example/29",
      stage: "spec-questions", why: "waiting on you", board: "http://127.0.0.1:4545",
    }]);
    expect(events).toEqual([{ name: "notify.sent", data: { item: "29", via: "chat" } }]);
  });

  it("says why a blocked item stopped, as the board does", async () => {
    const { sent, notifier } = recorder("chat");
    harness([notifier]).fire({ node: node(["lr:stage:screened", "lr:blocked", "lr:screened"]) });
    await settle();
    expect(sent.map((e) => e.why)).toEqual(["blocked by a security check"]);
  });

  it("says nothing about an item an agent is working on", async () => {
    const { sent, notifier } = recorder("chat");
    const { fire, events } = harness([notifier]);
    fire({ node: node(["lr:stage:build", "lr:working"]) });
    await settle();
    expect(sent).toEqual([]);
    expect(events).toEqual([]);
  });

  // The board files a closed item under Done whatever its labels still say.
  it("says nothing about a closed item still wearing lr:awaiting", async () => {
    const { sent, notifier } = recorder("chat");
    harness([notifier]).fire({ node: { ...waiting.node, closed: "done" } });
    await settle();
    expect(sent).toEqual([]);
  });

  it("sends nothing when no notify block is configured", async () => {
    const { sent, notifier } = recorder("chat");
    harness([notifier], null).fire(waiting);
    await settle();
    expect(sent).toEqual([]);
  });

  it("logs a notifier that rejects, and one that throws before it returns, and still sends through the rest", async () => {
    const rejects = defineNotifier({ id: "rejects", send: () => Promise.reject(new Error("503 from upstream")) });
    const throws = defineNotifier({
      id: "throws",
      send: () => { throw new Error("no webhook configured"); },
    });
    const { sent, notifier } = recorder("chat");
    const { fire, events } = harness([rejects, throws, notifier]);

    expect(() => fire(waiting)).not.toThrow();
    await settle();

    expect(sent).toHaveLength(1);
    expect(events).toEqual(expect.arrayContaining([
      { name: "notify.failed", data: { item: "29", via: "rejects", reason: "503 from upstream" } },
      { name: "notify.failed", data: { item: "29", via: "throws", reason: "no webhook configured" } },
      { name: "notify.sent", data: { item: "29", via: "chat" } },
    ]));
  });

  it("flattens a title onto one line", async () => {
    const { sent, notifier } = recorder("chat");
    harness([notifier]).fire({ node: node(["lr:stage:spec-questions", "lr:awaiting"], "Add\nexport\u001b[2J") });
    await settle();
    expect(sent[0]?.title).toBe("Add export [2J");
  });
});

describe("notifyProblems", () => {
  const registry = (...ids: string[]) => ({ notifiers: new Map(ids.map((id) => [id, recorder(id).notifier])) });

  it("names a via id no notifier registers, and what is registered", () => {
    expect(notifyProblems(config({ on: ["needs-you"], via: ["slack", "pager"] }), registry("slack"))).toEqual([
      { rule: "notify", message: 'notify.via names "pager", which no notifier registers: the loaded hooks register "slack"' },
    ]);
  });

  it("says none are registered when none are", () => {
    expect(notifyProblems(config({ on: ["needs-you"], via: ["slack"] }), registry())[0]?.message)
      .toMatch(/register none$/);
  });

  it("has nothing to say without a notify block", () => {
    expect(notifyProblems(config(), registry())).toEqual([]);
  });
});
