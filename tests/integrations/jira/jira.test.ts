import { Jira, type JiraOptions } from "landrace/integrations/jira";
import { LABELS, parseMarker, renderMarker } from "#conventions.js";
import { compose } from "#kit/compose.js";
import { TICKET_PAGE } from "#kit/tracker.js";
import type { HookContext, Node, RuntimeContext, Snapshot } from "#namespace.js";
import { MemoryDocs, MemoryForge } from "#testing/index.js";
import {
  type Adf, BOT, createFakeJira, DAY, EMAIL, jiraTime, paragraphs, PERSON, SITE, TOKEN,
} from "#tests/integrations/jira/fake-jira.js";

/*
 * The Jira integration over a fake Jira Cloud: every request goes through
 * `fetchImpl` to an in-memory v3 that answers as Atlassian documents it, so
 * these drive the shipped class through its own HTTP boundary.
 */

const SECRETS = { jiraBaseUrl: SITE, jiraEmail: EMAIL, jiraToken: TOKEN };

function setup(options: Partial<JiraOptions> = {}, secrets: Record<string, string> = SECRETS) {
  const fake = createFakeJira();
  const jira = new Jira({ project: "KEY", fetchImpl: fake.fetchImpl, ...options });
  // A fresh configuration object each time: the client is one per configuration.
  const ctx: RuntimeContext = {
    config: {} as never, secrets: new Map(Object.entries(secrets)), signal: new AbortController().signal, log: () => {},
  };
  return { fake, jira, ctx };
}

const on = (ctx: RuntimeContext, ticket: string, snapshot: Snapshot = {}): HookContext => ({ ...ctx, ticket, snapshot });

/** The text of every paragraph in a document, a hard break read as "\n". */
const paragraphTexts = (doc: Adf | null): string[] =>
  (doc?.content ?? []).map((p) => (p.content ?? []).map((n) => (n.type === "hardBreak" ? "\n" : n.text ?? "")).join(""));

describe("the client", () => {
  it("asks /myself first, with basic auth, and posts as the account's id", async () => {
    const { fake, jira, ctx } = setup();
    expect(await jira.login(ctx)).toBe(BOT.accountId);
    await jira.tickets(ctx);
    expect(fake.calls[0]?.path).toBe("/rest/api/3/myself");
    expect(fake.calls.filter((c) => c.path === "/rest/api/3/myself")).toHaveLength(1);
  });

  it("refuses to run when Jira rejects the email and token", async () => {
    const { fake, jira, ctx } = setup({}, { ...SECRETS, jiraToken: "not-the-token-at-all" });
    await expect(jira.tickets(ctx)).rejects.toThrow(/cannot resolve the account landrace posts as.*401/);
    expect(fake.calls.map((c) => c.path)).toEqual(["/rest/api/3/myself"]);
  });

  it("names every secret it is missing", async () => {
    const { jira, ctx } = setup({}, { jiraBaseUrl: SITE });
    await expect(jira.login(ctx)).rejects.toThrow(/"jiraEmail".*"jiraToken"/);
  });

  it.each([
    "http://acme.atlassian.net",
    "https://acme.atlassian.net.evil.example",
    "https://evil.example/acme.atlassian.net",
    "https://acme.atlassian.net/jira",
    "https://user@acme.atlassian.net",
  ])("refuses %s as a site before any request: basic auth carries the account's token", async (site) => {
    const { fake, jira, ctx } = setup({}, { ...SECRETS, jiraBaseUrl: site });
    await expect(jira.login(ctx)).rejects.toThrow(/https:\/\/<site>\.atlassian\.net/);
    expect(fake.calls).toEqual([]);
  });

  it("takes the site with a trailing slash", async () => {
    const { jira, ctx } = setup({}, { ...SECRETS, jiraBaseUrl: `${SITE}/` });
    expect(await jira.login(ctx)).toBe(BOT.accountId);
  });

  it("refuses a project that is not a Jira project key", () => {
    expect(() => new Jira({ project: "key" })).toThrow(/project key/);
    expect(() => new Jira({ project: "K\" OR project = X" })).toThrow(/project key/);
  });
});

describe("reading tickets", () => {
  it("lists the project's open issues as tickets, mapped field by field", async () => {
    const { fake, jira, ctx } = setup();
    const created = Date.parse("2026-09-01T12:00:00.000Z");
    const one = fake.add({
      summary: "Ship it", labels: ["lr:auto"], assignee: PERSON, creator: BOT, reporter: PERSON,
      created: jiraTime(created), updated: jiraTime(created + 60_000), status: "In Progress", priority: "2",
    });
    const [ticket] = await jira.tickets(ctx);
    expect(ticket).toEqual({
      id: one.key,
      title: "Ship it",
      link: `${SITE}/browse/${one.key}`,
      closed: null,
      labels: ["lr:auto"],
      assignees: [PERSON.accountId],
      body: "",
      author: BOT.accountId,
      editor: undefined,
      createdAt: "2026-09-01T12:00:00.000Z",
      updatedAt: "2026-09-01T12:01:00.000Z",
      parent: null,
      priority: 1,
    });
  });

  it("reads every page of the open list", async () => {
    const { fake, jira, ctx } = setup();
    fake.pageSize = 2;
    for (let i = 0; i < 5; i++) fake.add();
    expect((await jira.tickets(ctx)).map((t) => t.id)).toEqual(["KEY-1", "KEY-2", "KEY-3", "KEY-4", "KEY-5"]);
  });

  it("lists a closed issue only when landrace moved it and it closed inside the Done window", async () => {
    const { fake, jira, ctx } = setup();
    const recent = jiraTime(Date.now() - DAY);
    const stage = LABELS.stage("build");
    fake.add({ status: "Done", labels: [stage], updated: recent, statusChanged: recent });
    fake.add({ status: "Done", labels: ["unrelated"], updated: recent, statusChanged: recent });
    fake.add({ status: "Done", labels: [stage], updated: jiraTime(Date.now() - 40 * DAY), statusChanged: jiraTime(Date.now() - 40 * DAY) });
    // Touched lately, but closed long before the window.
    fake.add({ status: "Done", labels: [stage], updated: recent, statusChanged: jiraTime(Date.now() - 40 * DAY) });
    expect((await jira.tickets(ctx)).map((t) => [t.id, t.closed])).toEqual([["KEY-1", "done"]]);
  });

  it("reads closed as dropped when the status or the resolution is named as transitions.dropped", async () => {
    const { fake, jira, ctx } = setup({ transitions: { dropped: "Won't Do" } });
    fake.add({ status: "Won't Do", resolution: "Won't Do" });
    fake.add({ status: "Done", resolution: "Won't Do" });
    fake.add({ status: "Done", resolution: "Done" });
    fake.add({ status: "Done", resolution: null });
    fake.add({ status: "To Do" });
    const closed = await Promise.all(["KEY-1", "KEY-2", "KEY-3", "KEY-4", "KEY-5"].map(async (k) => (await jira.ticket(k, ctx)).closed));
    expect(closed).toEqual(["dropped", "dropped", "done", "done", null]);
  });

  it("gives a child its parent, and none for a parent in another project", async () => {
    const { fake, jira, ctx } = setup();
    const parent = fake.add();
    const child = fake.add({ parent: parent.key, issuetype: "Subtask" });
    const stray = fake.add({ parent: "OTHER-9" });
    const parents = new Map((await jira.tickets(ctx)).map((t) => [t.id, t.parent]));
    expect(parents.get(child.key)).toBe(parent.key);
    expect(parents.get(stray.key)).toBeNull();
  });

  it("reads who last changed the description as the body's editor", async () => {
    const { fake, jira, ctx } = setup();
    const issue = fake.add({ creator: BOT });
    expect((await jira.ticket(issue.key, ctx)).editor).toBeUndefined();
    fake.edit(issue.key, PERSON, paragraphs("rewritten"));
    fake.edit(issue.key, BOT, paragraphs("back"));
    fake.edit(issue.key, PERSON, paragraphs("again"));
    expect((await jira.ticket(issue.key, ctx)).editor).toBe(PERSON.accountId);
    expect((await jira.tickets(ctx))[0]?.editor).toBe(PERSON.accountId);
  });

  it("reads the editor across every page of changes", async () => {
    const { fake, jira, ctx } = setup();
    fake.pageSize = 2;
    const issue = fake.add();
    for (let i = 0; i < 4; i++) fake.edit(issue.key, PERSON, paragraphs(`${i}`));
    fake.edit(issue.key, BOT, paragraphs("ours"));
    expect((await jira.ticket(issue.key, ctx)).editor).toBe(BOT.accountId);
  });

  it("refuses an issue Jira answers under another key: it moved", async () => {
    const { fake, jira, ctx } = setup();
    const { key } = fake.add();
    fake.move(key, "KEY-77");
    await expect(jira.ticket(key, ctx)).rejects.toThrow(/KEY-1 has moved to KEY-77/);
  });

  it("says which issue it could not find", async () => {
    const { jira, ctx } = setup();
    await expect(jira.ticket("KEY-404", ctx)).rejects.toThrow(/KEY-404 is not an issue in KEY/);
  });

  it.each(["OTHER-1", "KEY-0", "KEY-1 OR project = OTHER", "KEY-1/comment", "key-1", "KEY-01"])(
    "refuses %s before any request: only KEY-<n> is this project's",
    async (id) => {
      const { fake, jira, ctx } = setup();
      for (const read of [
        () => jira.ticket(id, ctx), () => jira.children(id, ctx), () => jira.comments(id, ctx),
        () => jira.comment(id, "x", ctx), () => jira.addLabels(id, ["a"], ctx), () => jira.removeLabel(id, "a", ctx),
        () => jira.close(id, "done", ctx), () => jira.update(id, { title: "t" }, ctx),
        () => jira.create({ title: "t", body: "", parent: id, priority: undefined }, ctx),
      ]) {
        await expect(read()).rejects.toThrow(new RegExp(`is not an issue of KEY`));
      }
      expect(fake.calls).toEqual([]);
    },
  );

  it("reads a ticket's children, closed ones too", async () => {
    const { fake, jira, ctx } = setup();
    const parent = fake.add();
    fake.add({ parent: parent.key, issuetype: "Subtask" });
    fake.add({ parent: parent.key, issuetype: "Subtask", status: "Done" });
    fake.add();
    expect((await jira.children(parent.key, ctx)).map((c) => [c.id, c.parent, c.closed]))
      .toEqual([["KEY-2", "KEY-1", null], ["KEY-3", "KEY-1", "done"]]);
  });

  it("refuses a ticket with more children than one read carries", async () => {
    const { fake, jira, ctx } = setup();
    fake.pageSize = 20;
    const parent = fake.add();
    for (let i = 0; i <= TICKET_PAGE; i++) fake.add({ parent: parent.key, issuetype: "Subtask" });
    await expect(jira.children(parent.key, ctx)).rejects.toThrow(new RegExp(`more than the ${TICKET_PAGE}`));
  });

  it("reads every comment, oldest first, as text under the author's account id", async () => {
    const { fake, jira, ctx } = setup();
    fake.pageSize = 2;
    const issue = fake.add();
    for (let i = 0; i < 5; i++) fake.say(issue.key, i % 2 ? BOT : PERSON, paragraphs(`comment ${i}`));
    const comments = await jira.comments(issue.key, ctx);
    expect(comments.map((c) => [c.body, c.user?.login])).toEqual([
      ["comment 0", PERSON.accountId], ["comment 1", BOT.accountId], ["comment 2", PERSON.accountId],
      ["comment 3", BOT.accountId], ["comment 4", PERSON.accountId],
    ]);
    expect(comments[0]?.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(Date.parse(comments[0]?.created_at ?? "")).toBe(Date.parse(issue.comments[0]?.created ?? ""));
  });

  it("reads a person's formatted comment as its text", async () => {
    const { fake, jira, ctx } = setup();
    const issue = fake.add();
    fake.say(issue.key, PERSON, {
      type: "doc", version: 1, content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Findings" }] },
        { type: "bulletList", content: [
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] },
          { type: "listItem", content: [{ type: "paragraph", content: [
            { type: "mention", attrs: { id: BOT.accountId, text: "@landrace" } }, { type: "text", text: " two" },
          ] }] },
        ] },
        { type: "paragraph", content: [{ type: "text", text: "see " }, { type: "inlineCard", attrs: { url: "https://x.example/1" } }] },
      ],
    });
    expect((await jira.comments(issue.key, ctx))[0]?.body).toBe("Findings\n\none\n\n@landrace two\n\nsee https://x.example/1");
  });
});

describe("comments as ADF", () => {
  it("posts a paragraph per blank-line block and a hard break per line, text verbatim", async () => {
    const { fake, jira, ctx } = setup();
    const issue = fake.add();
    await jira.comment(issue.key, "one\ntwo\n\nthree {x} \\ *not bold*", ctx);
    const doc = issue.comments[0]?.body as Adf;
    expect(doc).toEqual({
      type: "doc", version: 1, content: [
        { type: "paragraph", content: [{ type: "text", text: "one" }, { type: "hardBreak" }, { type: "text", text: "two" }] },
        { type: "paragraph", content: [{ type: "text", text: "three {x} \\ *not bold*" }] },
      ],
    });
  });

  it.each([
    "", "a", "a\nb", "a\n\n\nb", "a\n\n\n\nb", "\n\nx\n", "x\n\n", "  indented\n\ttab",
    `report${renderMarker({ stage: "spec", kind: "output", round: 2, output: { path: "C:\\x", note: "{x} \"q\"\n" } })}`,
  ])("reads %j back exactly as it was posted", async (text) => {
    const { fake, jira, ctx } = setup();
    const issue = fake.add();
    await jira.comment(issue.key, text, ctx);
    expect((await jira.comments(issue.key, ctx))[0]?.body).toBe(text);
  });

  it("puts the marker last, as its own visible paragraph, and reads it back verbatim", async () => {
    const { fake, jira, ctx } = setup();
    const issue = fake.add();
    const marker = renderMarker({ stage: "spec", kind: "output", round: 1, output: { a: "\\{b}" } });
    await jira.comment(issue.key, `done${marker}`, ctx);
    expect(paragraphTexts(issue.comments[0]?.body ?? null).at(-1)).toBe(marker.trim());
    const [read] = await jira.comments(issue.key, ctx);
    expect(parseMarker(read?.body ?? "")).toEqual({ stage: "spec", kind: "output", round: 1, output: { a: "\\{b}" } });
  });

  it("refuses a body past Jira's 32,767 characters before the request", async () => {
    const { fake, jira, ctx } = setup();
    const issue = fake.add();
    await expect(jira.comment(issue.key, "x".repeat(32_767), ctx)).rejects.toThrow(/32767/);
    await expect(jira.create({ title: "t", body: "y".repeat(40_000), parent: undefined, priority: undefined }, ctx)).rejects.toThrow(/32767/);
    await expect(jira.update(issue.key, { body: "z".repeat(40_000) }, ctx)).rejects.toThrow(/32767/);
    expect(fake.writes()).toEqual([]);
  });
});

describe("writing", () => {
  it("adds and removes labels", async () => {
    const { fake, jira, ctx } = setup();
    const issue = fake.add({ labels: ["keep"] });
    await jira.addLabels(issue.key, ["lr:auto", "lr:stage:spec"], ctx);
    await jira.removeLabel(issue.key, "lr:auto", ctx);
    await jira.removeLabel(issue.key, "never-there", ctx);
    expect(issue.labels).toEqual(["keep", "lr:stage:spec"]);
  });

  it("closes as done and as dropped through the named transitions", async () => {
    const { fake, jira, ctx } = setup();
    const a = fake.add();
    const b = fake.add();
    await jira.close(a.key, "done", ctx);
    await jira.close(b.key, "dropped", ctx);
    expect([a.status, b.status]).toEqual(["Done", "Won't Do"]);
    expect([(await jira.ticket(a.key, ctx)).closed, (await jira.ticket(b.key, ctx)).closed]).toEqual(["done", "dropped"]);
  });

  it("takes the transitions' names from its options", async () => {
    const { fake, jira, ctx } = setup({ transitions: { done: "Ship", dropped: "Abandon" } });
    fake.transitions = [{ id: "31", name: "Ship", to: "Done" }, { id: "41", name: "Abandon", to: "Won't Do" }];
    const a = fake.add();
    const b = fake.add();
    await jira.close(a.key, "done", ctx);
    await jira.close(b.key, "dropped", ctx);
    expect([a.status, b.status]).toEqual(["Done", "Won't Do"]);
  });

  it("names the transitions on offer when the one it needs is not", async () => {
    const { fake, jira, ctx } = setup();
    fake.transitions = [{ id: "21", name: "In Progress", to: "In Progress" }, { id: "31", name: "Done", to: "Done" }];
    const issue = fake.add();
    await expect(jira.close(issue.key, "dropped", ctx))
      .rejects.toThrow(/no "Won't Do" transition.*"In Progress" \(to In Progress\), "Done" \(to Done\)/);
    expect(fake.writes()).toEqual([]);
  });

  it("halts on two transitions of the one name rather than pick one", async () => {
    const { fake, jira, ctx } = setup();
    fake.transitions = [{ id: "31", name: "Done", to: "Done" }, { id: "32", name: "Done", to: "Won't Do" }];
    const issue = fake.add();
    await expect(jira.close(issue.key, "done", ctx)).rejects.toThrow(/2 transitions named "Done"/);
    expect(fake.writes()).toEqual([]);
  });

  it("refuses a closing transition into a status Jira does not count as done", async () => {
    const { fake, jira, ctx } = setup();
    fake.transitions = [{ id: "31", name: "Done", to: "In Progress" }];
    const issue = fake.add();
    await expect(jira.close(issue.key, "done", ctx)).rejects.toThrow(/does not count as done/);
    expect(fake.writes()).toEqual([]);
  });

  it("creates a ticket as the issue type, and a child as the child type under its parent", async () => {
    const { fake, jira, ctx } = setup();
    const top = await jira.create({ title: "Top", body: "line one\nline two", parent: undefined, priority: undefined }, ctx);
    const child = await jira.create({ title: "Child", body: "", parent: top, priority: undefined }, ctx);
    expect([fake.issue(top).issuetype, fake.issue(top).parent]).toEqual(["Task", null]);
    expect([fake.issue(child).issuetype, fake.issue(child).parent]).toEqual(["Subtask", top]);
    expect((await jira.ticket(top, ctx)).body).toBe("line one\nline two");
  });

  it("creates with the project's priority at landrace's index, and past its last with the lowest", async () => {
    const { fake, jira, ctx } = setup();
    const p0 = await jira.create({ title: "a", body: "", parent: undefined, priority: 0 }, ctx);
    const p3 = await jira.create({ title: "b", body: "", parent: undefined, priority: 3 }, ctx);
    const p9 = await jira.create({ title: "c", body: "", parent: undefined, priority: 9 }, ctx);
    expect([p0, p3, p9].map((k) => fake.issue(k).priority)).toEqual(["1", "4", "5"]);
    expect((await jira.ticket(p9, ctx)).priority).toBe(4);
  });

  it("updates the title and the body", async () => {
    const { fake, jira, ctx } = setup();
    const issue = fake.add();
    await jira.update(issue.key, { title: "New", body: "a\n\nb" }, ctx);
    expect(issue.summary).toBe("New");
    expect(paragraphTexts(issue.description)).toEqual(["a", "b"]);
  });

  it("closes through the done transition, and reopens through the first one into To Do", async () => {
    const { fake, jira, ctx } = setup();
    fake.transitions = [
      { id: "21", name: "In Progress", to: "In Progress" }, { id: "31", name: "Done", to: "Done" },
      { id: "11", name: "Reopen", to: "To Do" }, { id: "12", name: "Back to To Do", to: "To Do" },
    ];
    const issue = fake.add();
    await jira.update(issue.key, { state: "closed" }, ctx);
    expect(issue.status).toBe("Done");
    await jira.update(issue.key, { state: "open" }, ctx);
    expect(issue.status).toBe("To Do");
    expect(fake.writes().filter((c) => c.path.endsWith("/transitions")).map((c) => c.body))
      .toEqual([{ transition: { id: "31" } }, { transition: { id: "11" } }]);
  });

  it("asks for no transition when the ticket is already in the state asked for", async () => {
    const { fake, jira, ctx } = setup();
    const issue = fake.add();
    await jira.update(issue.key, { state: "open" }, ctx);
    expect(fake.writes()).toEqual([]);
  });

  it("names the transitions on offer when none leads back to To Do", async () => {
    const { fake, jira, ctx } = setup();
    fake.transitions = [{ id: "31", name: "Done", to: "Done" }];
    const issue = fake.add({ status: "Won't Do" });
    await expect(jira.update(issue.key, { state: "open" }, ctx)).rejects.toThrow(/To Do.*"Done" \(to Done\)/);
  });
});

describe("the preflight", () => {
  it("passes an account that can do everything, writing nothing", async () => {
    const { fake, jira, ctx } = setup();
    await jira.check?.(ctx);
    expect(fake.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("names each missing permission", async () => {
    const { fake, jira, ctx } = setup();
    fake.permissions.EDIT_ISSUES = false;
    fake.permissions.ADD_COMMENTS = false;
    await expect(jira.check?.(ctx)).rejects.toThrow(/"Edit Issues" \(EDIT_ISSUES\).*"Add Comments" \(ADD_COMMENTS\)/);
  });

  it("names a missing issue type with the ones the project has, and a type with no labels field", async () => {
    const { fake, jira, ctx } = setup({ issueType: "Bug", childType: "Sub-task" });
    fake.permissions.TRANSITION_ISSUES = false;
    await expect(jira.check?.(ctx)).rejects.toThrow(
      /"Transition Issues"[\s\S]*"Bug" issues have no labels field[\s\S]*no issue type "Sub-task"; it has "Task", "Subtask", "Bug"/,
    );
    expect(fake.calls.every((c) => c.method === "GET")).toBe(true);
  });
});

describe("composed with a forge and docs", () => {
  const hooksOver = (jira: Jira) => compose({ tracker: jira, forge: new MemoryForge(), docs: new MemoryDocs() });
  const snapshotOf = async (hooks: ReturnType<typeof hooksOver>, ctx: RuntimeContext, id: string): Promise<Snapshot> => {
    const graph = await hooks.source.read(id, ctx);
    return { graph, node: graph.nodes.find((n) => n.id === id) };
  };

  it("creates, records, labels and closes a ticket, and reads each back", async () => {
    const { fake, jira, ctx } = setup();
    const hooks = hooksOver(jira);
    const node = await hooks.operator.createTicket({ title: "Work", body: "do it", labels: ["lr:auto"] }, ctx);
    expect([node.id, node.title, node.state.labels]).toEqual(["KEY-1", "Work", ["lr:auto"]]);

    const record = { type: "tracker.comment", stage: "spec", kind: "enter", round: 1, marker: "enter:spec:1", body: "Entered spec." };
    await hooks.post.apply(record, on(ctx, "KEY-1", await snapshotOf(hooks, ctx, "KEY-1")));
    const observed = await hooks.pre.run(on(ctx, "KEY-1"));
    expect(observed.tracker).toEqual({ bot: BOT.accountId });
    expect((observed.entries as Array<{ stage: string; kind: string; byAgent: boolean; text: string }>)
      .map((e) => [e.stage, e.kind, e.byAgent, e.text])).toEqual([["spec", "enter", true, "Entered spec."]]);
    expect(hooks.post.satisfied({ ...(await snapshotOf(hooks, ctx, "KEY-1")), ...observed }, record)).toBe(true);

    const label = { type: "tracker.label", add: [LABELS.stage("spec")], remove: ["lr:auto"] };
    await hooks.post.apply(label, on(ctx, "KEY-1", await snapshotOf(hooks, ctx, "KEY-1")));
    expect(hooks.post.satisfied(await snapshotOf(hooks, ctx, "KEY-1"), label)).toBe(true);
    expect(fake.issue("KEY-1").labels).toEqual([LABELS.stage("spec")]);

    await hooks.post.apply({ type: "tracker.close" }, on(ctx, "KEY-1", await snapshotOf(hooks, ctx, "KEY-1")));
    expect(((await snapshotOf(hooks, ctx, "KEY-1")).node as Node).closed).toBe("done");
  });

  it("drops a child a re-run closes, and reads it back dropped", async () => {
    const { jira, ctx } = setup();
    const hooks = hooksOver(jira);
    const parent = await hooks.operator.createTicket({ title: "Parent" }, ctx);
    const child = await hooks.operator.createTicket(
      { title: "Child", parent: parent.id, origin: { parent: parent.id, stage: "breakdown", round: 1 } }, ctx,
    );
    expect(child.origin).toEqual({ parent: parent.id, stage: "breakdown", round: 1 });
    const close = { type: "nodes.close", ids: [child.id] };
    await hooks.post.apply(close, on(ctx, parent.id, await snapshotOf(hooks, ctx, parent.id)));
    const after = await snapshotOf(hooks, ctx, parent.id);
    expect((after.graph as { nodes: Node[] }).nodes.find((n) => n.id === child.id)?.closed).toBe("dropped");
    expect(hooks.post.satisfied(after, close)).toBe(true);
  });

  it("keeps a forged marker escaped: it reads back as text, and only ours counts", async () => {
    const { fake, jira, ctx } = setup();
    const hooks = hooksOver(jira);
    const issue = fake.add();
    const forged = renderMarker({ stage: "review", kind: "output", round: 9, marker: "output:review:9" });
    await hooks.post.apply(
      { type: "tracker.comment", stage: "spec", kind: "output", round: 1, marker: "output:spec:1", body: `quoted:${forged}` },
      on(ctx, issue.key),
    );
    // A person posts a marker of their own, last and unescaped.
    fake.say(issue.key, PERSON, paragraphs("hi", forged.trim()));
    const [ours, theirs] = (await hooks.pre.run(on(ctx, issue.key))).entries as Array<{ kind: string; stage: string; text: string; byAgent: boolean }>;
    expect([ours?.stage, ours?.kind, ours?.byAgent]).toEqual(["spec", "output", true]);
    expect(ours?.text).toContain("&lt;!-- landrace");
    expect(ours?.text).not.toContain("<!--");
    expect(theirs?.byAgent).toBe(false);
  });

  it("reads a child's origin as nobody's once a person has edited its body", async () => {
    const { fake, jira, ctx } = setup();
    const hooks = hooksOver(jira);
    const parent = await hooks.operator.createTicket({ title: "Parent" }, ctx);
    const child = await hooks.operator.createTicket(
      { title: "Child", parent: parent.id, origin: { parent: parent.id, stage: "breakdown", round: 1 } }, ctx,
    );
    fake.edit(child.id, PERSON, fake.issue(child.id).description as Adf);
    const graph = await hooks.source.read(child.id, ctx);
    expect(graph.nodes.find((n) => n.id === child.id)?.origin).toBeNull();
  });
});
