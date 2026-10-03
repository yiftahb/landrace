import { Jira, type JiraOptions } from "landrace/integrations/jira";
import { LABELS, parseMarker, renderMarker } from "#conventions.js";
import { compile } from "#core/predicate.js";
import { deriveRel } from "#core/rel.js";
import { compose } from "#kit/compose.js";
import { ITEM_PAGE, MAX_ISSUE_PAGES } from "#kit/tracker.js";
import type { Graph, HookContext, Node, RuntimeContext, Snapshot } from "#namespace.js";
import { MemoryDocs, MemoryForge } from "#testing/index.js";
import {
  type Adf, BOT, createFakeJira, DAY, EMAIL, type FakeJira, jiraTime, paragraphs, PERSON, SITE, TOKEN,
} from "#tests/integrations/jira/fake-jira.js";
import { loadShipped } from "#tests/support/shipped.js";

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

const on = (ctx: RuntimeContext, item: string, snapshot: Snapshot = {}): HookContext => ({ ...ctx, item, snapshot });

/** The text of every paragraph in a document, a hard break read as "\n". */
const paragraphTexts = (doc: Adf | null): string[] =>
  (doc?.content ?? []).map((p) => (p.content ?? []).map((n) => (n.type === "hardBreak" ? "\n" : n.text ?? "")).join(""));

describe("the client", () => {
  it("asks /myself first, with basic auth, and posts as the account's id", async () => {
    const { fake, jira, ctx } = setup();
    expect(await jira.login(ctx)).toBe(BOT.accountId);
    await jira.items(ctx);
    expect(fake.calls[0]?.path).toBe("/rest/api/3/myself");
    expect(fake.calls.filter((c) => c.path === "/rest/api/3/myself")).toHaveLength(1);
  });

  it("refuses to run when Jira rejects the email and token", async () => {
    const { fake, jira, ctx } = setup({}, { ...SECRETS, jiraToken: "not-the-token-at-all" });
    await expect(jira.items(ctx)).rejects.toThrow(/cannot resolve the account landrace posts as.*401/);
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

  // Its "Blocks" links are read as blocked-by, and only the item's own side of them.
  it("declares blocked-by beside the parent, and writes it", () => {
    const jira = new Jira({ project: "KEY" });
    expect(jira.relations()).toEqual([
      { type: "child-of", singular: true }, { type: "blocked-by", singular: false, outwardOnly: true },
    ]);
    expect(jira.relates()).toEqual(["blocked-by"]);
  });

  it("refuses a project that is not a Jira project key", () => {
    expect(() => new Jira({ project: "key" })).toThrow(/project key/);
    expect(() => new Jira({ project: "K\" OR project = X" })).toThrow(/project key/);
  });
});

describe("reading items", () => {
  it("lists the project's open issues as items, mapped field by field", async () => {
    const { fake, jira, ctx } = setup();
    const created = Date.parse("2026-09-01T12:00:00.000Z");
    const one = fake.add({
      summary: "Ship it", labels: ["lr:auto"], assignee: PERSON, creator: BOT, reporter: PERSON,
      created: jiraTime(created), updated: jiraTime(created + 60_000), status: "In Progress", priority: "2",
    });
    const [item] = await jira.items(ctx);
    expect(item).toEqual({
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
      related: [],
      relatedComplete: true,
    });
  });

  it("reads every page of the open list", async () => {
    const { fake, jira, ctx } = setup();
    fake.pageSize = 2;
    for (let i = 0; i < 5; i++) fake.add();
    expect((await jira.items(ctx)).map((t) => t.id)).toEqual(["KEY-1", "KEY-2", "KEY-3", "KEY-4", "KEY-5"]);
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
    expect((await jira.items(ctx)).map((t) => [t.id, t.closed])).toEqual([["KEY-1", "done"]]);
  });

  it("reads closed as dropped when the status or the resolution is named as transitions.dropped", async () => {
    const { fake, jira, ctx } = setup({ transitions: { dropped: "Won't Do" } });
    fake.add({ status: "Won't Do", resolution: "Won't Do" });
    fake.add({ status: "Done", resolution: "Won't Do" });
    fake.add({ status: "Done", resolution: "Done" });
    fake.add({ status: "Done", resolution: null });
    fake.add({ status: "To Do" });
    const closed = await Promise.all(["KEY-1", "KEY-2", "KEY-3", "KEY-4", "KEY-5"].map(async (k) => (await jira.item(k, ctx)).closed));
    expect(closed).toEqual(["dropped", "dropped", "done", "done", null]);
  });

  it("gives a child its parent, and none for a parent in another project", async () => {
    const { fake, jira, ctx } = setup();
    const parent = fake.add();
    const child = fake.add({ parent: parent.key, issuetype: "Subtask" });
    const stray = fake.add({ parent: "OTHER-9" });
    const parents = new Map((await jira.items(ctx)).map((t) => [t.id, t.parent]));
    expect(parents.get(child.key)).toBe(parent.key);
    expect(parents.get(stray.key)).toBeNull();
  });

  it("reads who last changed the description as the body's editor", async () => {
    const { fake, jira, ctx } = setup();
    const issue = fake.add({ creator: BOT });
    expect((await jira.item(issue.key, ctx)).editor).toBeUndefined();
    fake.edit(issue.key, PERSON, paragraphs("rewritten"));
    fake.edit(issue.key, BOT, paragraphs("back"));
    fake.edit(issue.key, PERSON, paragraphs("again"));
    expect((await jira.item(issue.key, ctx)).editor).toBe(PERSON.accountId);
    expect((await jira.items(ctx))[0]?.editor).toBe(PERSON.accountId);
  });

  it("reads the editor across every page of changes", async () => {
    const { fake, jira, ctx } = setup();
    fake.pageSize = 2;
    const issue = fake.add();
    for (let i = 0; i < 4; i++) fake.edit(issue.key, PERSON, paragraphs(`${i}`));
    fake.edit(issue.key, BOT, paragraphs("ours"));
    expect((await jira.item(issue.key, ctx)).editor).toBe(BOT.accountId);
  });

  it("refuses an issue Jira answers under another key: it moved", async () => {
    const { fake, jira, ctx } = setup();
    const { key } = fake.add();
    fake.move(key, "KEY-77");
    await expect(jira.item(key, ctx)).rejects.toThrow(/KEY-1 has moved to KEY-77/);
  });

  it("says which issue it could not find", async () => {
    const { jira, ctx } = setup();
    await expect(jira.item("KEY-404", ctx)).rejects.toThrow(/KEY-404 is not an issue in KEY/);
  });

  it.each(["OTHER-1", "KEY-0", "KEY-1 OR project = OTHER", "KEY-1/comment", "key-1", "KEY-01"])(
    "refuses %s before any request: only KEY-<n> is this project's",
    async (id) => {
      const { fake, jira, ctx } = setup();
      for (const read of [
        () => jira.item(id, ctx), () => jira.children(id, ctx), () => jira.comments(id, ctx),
        () => jira.comment(id, "x", ctx), () => jira.addLabels(id, ["a"], ctx), () => jira.removeLabel(id, "a", ctx),
        () => jira.close(id, "done", ctx), () => jira.update(id, { title: "t" }, ctx),
        () => jira.create({ title: "t", body: "", parent: id, priority: undefined }, ctx),
      ]) {
        await expect(read()).rejects.toThrow(new RegExp(`is not an issue of KEY`));
      }
      expect(fake.calls).toEqual([]);
    },
  );

  it("reads an item's children, closed ones too", async () => {
    const { fake, jira, ctx } = setup();
    const parent = fake.add();
    fake.add({ parent: parent.key, issuetype: "Subtask" });
    fake.add({ parent: parent.key, issuetype: "Subtask", status: "Done" });
    fake.add();
    expect((await jira.children(parent.key, ctx)).map((c) => [c.id, c.parent, c.closed]))
      .toEqual([["KEY-2", "KEY-1", null], ["KEY-3", "KEY-1", "done"]]);
  });

  it("reads a child created a moment ago, before Jira's search has indexed it", async () => {
    // A graph short a child just made routes as if the split never happened.
    const { fake, jira, ctx } = setup();
    fake.indexLag = true;
    const parent = fake.add();
    const child = await jira.create({ title: "Just made", body: "", parent: parent.key, priority: undefined }, ctx);
    expect((await jira.children(parent.key, ctx)).map((c) => c.id)).toEqual([child]);
  });

  it("refuses an item with more children than one read carries", async () => {
    const { fake, jira, ctx } = setup();
    fake.pageSize = 20;
    const parent = fake.add();
    for (let i = 0; i <= ITEM_PAGE; i++) fake.add({ parent: parent.key, issuetype: "Subtask" });
    await expect(jira.children(parent.key, ctx)).rejects.toThrow(new RegExp(`more than the ${ITEM_PAGE}`));
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
    expect([(await jira.item(a.key, ctx)).closed, (await jira.item(b.key, ctx)).closed]).toEqual(["done", "dropped"]);
  });

  it("leaves an issue already closed as it is, whatever the graph it was planned from said", async () => {
    // Search lags, so a graph can still show open an issue a person has just
    // closed as done; closing it again as dropped would overrule them.
    const { fake, jira, ctx } = setup();
    const issue = fake.add({ status: "Done", resolution: "Done" });
    await jira.close(issue.key, "dropped", ctx);
    expect(issue.status).toBe("Done");
    expect(fake.writes()).toEqual([]);
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

  it("creates an item as the issue type, and a child as the child type under its parent", async () => {
    const { fake, jira, ctx } = setup();
    const top = await jira.create({ title: "Top", body: "line one\nline two", parent: undefined, priority: undefined }, ctx);
    const child = await jira.create({ title: "Child", body: "", parent: top, priority: undefined }, ctx);
    expect([fake.issue(top).issuetype, fake.issue(top).parent]).toEqual(["Task", null]);
    expect([fake.issue(child).issuetype, fake.issue(child).parent]).toEqual(["Subtask", top]);
    expect((await jira.item(top, ctx)).body).toBe("line one\nline two");
  });

  it("creates with the project's priority at landrace's index, and past its last with the lowest", async () => {
    const { fake, jira, ctx } = setup();
    const p0 = await jira.create({ title: "a", body: "", parent: undefined, priority: 0 }, ctx);
    const p3 = await jira.create({ title: "b", body: "", parent: undefined, priority: 3 }, ctx);
    const p9 = await jira.create({ title: "c", body: "", parent: undefined, priority: 9 }, ctx);
    expect([p0, p3, p9].map((k) => fake.issue(k).priority)).toEqual(["1", "4", "5"]);
    expect((await jira.item(p9, ctx)).priority).toBe(4);
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

  it("asks for no transition when the item is already in the state asked for", async () => {
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
    expect(fake.calls.map((c) => c.path)).toContain("/rest/api/3/issueLinkType");
  });

  // blocked-by is read off links of one type: a site without it would read every item as blocked by nothing.
  it("refuses a site with no link type of the name blocked-by is read from, naming the option and the types it has", async () => {
    const { fake, jira, ctx } = setup({ blockedByLinkType: "Depends" });
    await expect(jira.check?.(ctx)).rejects.toThrow(
      /no issue link type "Depends" \(blockedByLinkType\)[\s\S]*it has "Blocks", "Cloners", "Duplicate", "Relates"/,
    );
    expect(fake.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("refuses a site whose \"Blocks\" type is gone, by its exact name", async () => {
    const { fake, jira, ctx } = setup();
    fake.linkTypes = fake.linkTypes.map((t) => (t.name === "Blocks" ? { ...t, name: "blocks" } : t));
    await expect(jira.check?.(ctx)).rejects.toThrow(/no issue link type "Blocks" \(blockedByLinkType\)[\s\S]*"blocks"/);
  });

  // A breakdown's related children are created before they are linked: a refused link drops each, in Jira's history.
  it("names a missing \"Link Issues\" permission", async () => {
    const { fake, jira, ctx } = setup();
    fake.permissions.LINK_ISSUES = false;
    await expect(jira.check?.(ctx)).rejects.toThrow(/"Link Issues" \(LINK_ISSUES\) on KEY/);
  });

  // The blocker is the link's inward end: a type that reads the same both ways cannot say which end that is.
  it("refuses a link type that reads the same both ways, naming the option", async () => {
    const { jira, ctx } = setup({ blockedByLinkType: "Relates" });
    await expect(jira.check?.(ctx)).rejects.toThrow(
      /"Relates" \(blockedByLinkType\) reads "relates to" both ways[\s\S]*inward side reads "is blocked by"/,
    );
  });

  it("says once, at start, how the link type it reads words each side", async () => {
    const { jira, ctx } = setup();
    const events: Array<{ event: string; data: Record<string, unknown> | undefined }> = [];
    await jira.check?.({ ...ctx, log: (event, data) => { events.push({ event, data }); } });
    expect(events.filter((e) => e.event === "jira.blocked-by.link-type")).toEqual([{
      event: "jira.blocked-by.link-type",
      data: { linkType: "Blocks", blocker: "inward", inward: "is blocked by", outward: "blocks" },
    }]);
  });

  it("refuses a site with issue linking turned off", async () => {
    const { fake, jira, ctx } = setup();
    fake.linking = false;
    await expect(jira.check?.(ctx)).rejects.toThrow(/issue linking is disabled on this site[\s\S]*"Blocks"/);
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

  it("reads every page of issue types and fields before calling one missing", async () => {
    const { fake, jira, ctx } = setup({ issueType: "Bug" });
    fake.pageSize = 2;
    fake.issueTypes.find((t) => t.name === "Bug")?.fields.push("labels");
    await jira.check?.(ctx);
  });
});

describe("composed with a forge and docs", () => {
  const hooksOver = (jira: Jira) => compose({ tracker: jira, forge: new MemoryForge(), docs: new MemoryDocs() });
  const snapshotOf = async (hooks: ReturnType<typeof hooksOver>, ctx: RuntimeContext, id: string): Promise<Snapshot> => {
    const graph = await hooks.source.read(id, ctx);
    return { graph, node: graph.nodes.find((n) => n.id === id) };
  };

  it("creates, records, labels and closes an item, and reads each back", async () => {
    const { fake, jira, ctx } = setup();
    const hooks = hooksOver(jira);
    const node = await hooks.operator.createItem({ title: "Work", body: "do it", labels: ["lr:auto"] }, ctx);
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
    const parent = await hooks.operator.createItem({ title: "Parent" }, ctx);
    const child = await hooks.operator.createItem(
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
    const parent = await hooks.operator.createItem({ title: "Parent" }, ctx);
    const child = await hooks.operator.createItem(
      { title: "Child", parent: parent.id, origin: { parent: parent.id, stage: "breakdown", round: 1 } }, ctx,
    );
    fake.edit(child.id, PERSON, fake.issue(child.id).description as Adf);
    const graph = await hooks.source.read(child.id, ctx);
    expect(graph.nodes.find((n) => n.id === child.id)?.origin).toBeNull();
  });
});

/*
 * Jira's own "Blocks" links, read and written as blocked-by. The direction
 * is Atlassian's: a blocked issue lists its blocker under `inwardIssue`,
 * which Jira labels with the type's inward words, "is blocked by"; and a
 * link is written with the blocker as `inwardIssue`, the blocked issue as
 * `outwardIssue`. The fake keeps each end in the slot it was written in.
 */
describe("blocked-by, as Jira's Blocks links", () => {
  const hooksOf = (jira: Jira) => compose({ tracker: jira, forge: new MemoryForge(), docs: new MemoryDocs() });
  const blockedBy = (g: Graph) => g.relationships.filter((r) => r.type === "blocked-by");
  const nodeOf = (g: Graph, id: string) => g.nodes.find((n) => n.id === id);
  const relOf = (g: Graph, id: string) => {
    const rel = deriveRel(g, id, ["child-of", "blocked-by"]);
    if (!rel.ok) throw new Error(rel.why);
    return rel.rel["blocked-by"]?.out;
  };
  /** Both ways the engine reads an item, so each case is asked of the list and of the read alike. */
  const both = async (jira: Jira, ctx: RuntimeContext, id: string): Promise<Array<[string, Graph]>> => {
    const hooks = hooksOf(jira);
    return [["list", await hooks.source.list(ctx)], ["read", await hooks.source.read(id, ctx)]];
  };
  /** `blocked` is blocked by `blocker`, as a person links them in Jira. */
  const blocks = (fake: FakeJira, blocker: string, blocked: string, type = "Blocks") => fake.link(type, blocker, blocked);
  const blockersRead = async (jira: Jira, ctx: RuntimeContext, id: string) =>
    blockedBy(await hooksOf(jira).source.read(id, ctx)).map((r) => r.to);
  const searches = (fake: FakeJira) => fake.calls.filter((c) => c.path === "/rest/api/3/search/jql")
    .map((c) => c.body as { jql: string; fields: string[] });
  /** The open list's searches: the one a list makes, and the one a read's cycle walk makes. */
  const openSearches = (fake: FakeJira) => searches(fake).filter((b) => b.jql.startsWith('project = "KEY" AND statusCategory != Done'));
  type Entry = Record<string, unknown> & { inwardIssue?: { key?: string; fields?: Record<string, unknown> } };
  /** Jira's answers with each issue's links edited — undefined removes the field — as a site might answer them. */
  const editing = (fake: FakeJira, edit: (key: string, links: Entry[]) => Entry[] | undefined): typeof fetch =>
    (async (input: string | URL, init?: RequestInit) => {
      const res = await fake.fetchImpl(input, init);
      const text = await res.text();
      if (!res.ok || text === "") return new Response(text === "" ? null : text, { status: res.status });
      const body = JSON.parse(text) as { key?: string; fields?: { issuelinks?: Entry[] }; issues?: Array<{ key: string; fields?: { issuelinks?: Entry[] } }> };
      for (const issue of [body, ...(body.issues ?? [])]) {
        if (typeof issue.key !== "string" || !Array.isArray(issue.fields?.issuelinks)) continue;
        const next = edit(issue.key, issue.fields.issuelinks);
        if (next === undefined) delete issue.fields.issuelinks;
        else issue.fields.issuelinks = next;
      }
      return new Response(JSON.stringify(body), { status: res.status, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
  /** The one entry naming KEY-2 edited, every other answered as Jira gave it. */
  const atKey2 = (change: (e: Entry) => Entry) => (_key: string, links: Entry[]) =>
    links.map((e) => (e.inwardIssue?.key === "KEY-2" ? change(structuredClone(e)) : e));

  describe("reading", () => {
    it("reads an open blocker in the project by its key, the listed item itself in a list", async () => {
      const { fake, jira, ctx } = setup();
      const blocker = fake.add({ summary: "Schema" });
      const item = fake.add();
      blocks(fake, blocker.key, item.key);
      for (const [, g] of await both(jira, ctx, item.key)) {
        expect(blockedBy(g)).toEqual([{ from: item.key, to: blocker.key, type: "blocked-by" }]);
        expect(nodeOf(g, blocker.key)).toMatchObject({ title: "Schema", link: `${SITE}/browse/${blocker.key}`, closed: null });
        expect(nodeOf(g, item.key)?.state).not.toHaveProperty("relatedUnreadable");
        expect(relOf(g, item.key)).toMatchObject({ total: 1, dropped: 0, open: [blocker.key] });
      }
      expect(nodeOf(await hooksOf(jira).source.list(ctx), blocker.key)?.placeholder).toBeUndefined();
    });

    it("reads only the blocked side: the blocker's own link says it blocks, which blocks nothing of its own", async () => {
      const { fake, jira, ctx } = setup();
      const blocker = fake.add();
      const item = fake.add();
      blocks(fake, blocker.key, item.key);
      expect((await jira.item(blocker.key, ctx)).related).toEqual([]);
      expect((await jira.item(item.key, ctx)).related?.map((r) => r.to)).toEqual([blocker.key]);
      expect(blockedBy(await hooksOf(jira).source.read(blocker.key, ctx))).toEqual([]);
      expect(blockedBy(await hooksOf(jira).source.list(ctx))).toEqual([{ from: item.key, to: blocker.key, type: "blocked-by" }]);
    });

    it("reads a closed blocker as done, and as dropped by its status name or its resolution, asking only what the link cannot say", async () => {
      const { fake, jira, ctx } = setup();
      const done = fake.add({ status: "Done", resolution: "Done" });
      const wontDo = fake.add({ status: "Won't Do", resolution: "Won't Do" });
      const resolved = fake.add({ status: "Done", resolution: "Won't Do" });
      const item = fake.add();
      for (const b of [done, wontDo, resolved]) blocks(fake, b.key, item.key);
      for (const [, g] of await both(jira, ctx, item.key)) {
        expect(blockedBy(g).map((r) => r.to)).toEqual([done.key, wontDo.key, resolved.key]);
        expect([done.key, wontDo.key, resolved.key].map((id) => nodeOf(g, id)?.closed)).toEqual(["done", "dropped", "dropped"]);
        expect(relOf(g, item.key)).toMatchObject({ total: 1, dropped: 2, open: [] });
        expect(nodeOf(g, item.key)?.state).not.toHaveProperty("relatedUnreadable");
      }
      // The link carries the status, not the resolution: a done status is read for it, in one request by issue
      // id, and a dropped one's name already says. Once for the list and once for the read, and never one by one.
      expect(fake.calls.filter((c) => c.path === "/rest/api/3/issue/bulkfetch").map((c) => c.body)).toEqual([
        { issueIdsOrKeys: [done.id, resolved.id], fields: ["status", "resolution"] },
        { issueIdsOrKeys: [done.id, resolved.id], fields: ["status", "resolution"] },
      ]);
      expect(fake.calls.filter((c) => c.method === "GET" && /^\/rest\/api\/3\/issue\/KEY-[123]\?/.test(c.path))).toEqual([]);
    });

    it("asks nothing of a closed blocker the list already holds", async () => {
      const { fake, jira, ctx } = setup();
      const recent = jiraTime(Date.now() - DAY);
      const done = fake.add({ status: "Done", resolution: "Won't Do", labels: [LABELS.stage("build")], updated: recent, statusChanged: recent });
      const item = fake.add();
      blocks(fake, done.key, item.key);
      const listed = await hooksOf(jira).source.list(ctx);
      expect(nodeOf(listed, done.key)?.closed).toBe("dropped");
      expect(relOf(listed, item.key)).toMatchObject({ dropped: 1 });
      expect(fake.calls.filter((c) => c.path === "/rest/api/3/issue/bulkfetch")).toEqual([]);
    });

    // Jira answers a link with the issue under the key it has now, and so is it read.
    it("reads a blocker moved to another project under its new key", async () => {
      const { fake, jira, ctx } = setup();
      const blocker = fake.add();
      const item = fake.add();
      blocks(fake, blocker.key, item.key);
      fake.move(blocker.key, "OTHER-7");
      for (const [, g] of await both(jira, ctx, item.key)) expect(blockedBy(g).map((r) => r.to)).toEqual(["OTHER-7"]);
    });

    // Link type names are compared as Jira spells them: "blocks" is some other type.
    it("reads no link of a type named like the configured one in another case", async () => {
      const { fake, jira, ctx } = setup();
      fake.linkTypes.push({ id: "10101", name: "blocks", inward: "is blocked by", outward: "blocks" });
      const a = fake.add();
      const item = fake.add();
      fake.link("blocks", a.key, item.key);
      for (const [, g] of await both(jira, ctx, item.key)) expect(blockedBy(g)).toEqual([]);
    });

    it("reads a blocker in another project on the site by its own key, from what the link said of it", async () => {
      const { fake, jira, ctx } = setup();
      fake.add({ key: "OTHER-5", summary: "Upstream fix" });
      fake.add({ key: "OTHER-6", summary: "Shipped upstream", status: "Done", resolution: "Done" });
      const item = fake.add();
      blocks(fake, "OTHER-5", item.key);
      blocks(fake, "OTHER-6", item.key);
      for (const [, g] of await both(jira, ctx, item.key)) {
        expect(blockedBy(g).map((r) => r.to)).toEqual(["OTHER-5", "OTHER-6"]);
        expect(nodeOf(g, "OTHER-5")).toMatchObject({
          kind: "item", title: "Upstream fix", link: `${SITE}/browse/OTHER-5`, closed: null, placeholder: true,
        });
        expect(nodeOf(g, "OTHER-6")?.closed).toBe("done");
        expect(nodeOf(g, item.key)?.state).not.toHaveProperty("relatedUnreadable");
        expect(nodeOf(g, item.key)?.state).not.toHaveProperty("dependencyCycle");
        expect(relOf(g, item.key)).toMatchObject({ total: 2, open: ["OTHER-5"] });
      }
    });

    it("reads no link of another type", async () => {
      const { fake, jira, ctx } = setup();
      const a = fake.add();
      const b = fake.add();
      const item = fake.add();
      fake.link("Relates", a.key, item.key);
      fake.link("Cloners", b.key, item.key);
      fake.link("Duplicate", item.key, a.key);
      for (const [, g] of await both(jira, ctx, item.key)) {
        expect(blockedBy(g)).toEqual([]);
        expect(nodeOf(g, item.key)?.state).not.toHaveProperty("relatedUnreadable");
      }
    });

    it("reads the link type its options name, and that one alone", async () => {
      const { fake, jira, ctx } = setup({ blockedByLinkType: "Gates" });
      fake.linkTypes.push({ id: "10100", name: "Gates", inward: "is gated by", outward: "gates" });
      const a = fake.add();
      const b = fake.add();
      const item = fake.add();
      fake.link("Gates", a.key, item.key);
      blocks(fake, b.key, item.key);
      for (const [, g] of await both(jira, ctx, item.key)) expect(blockedBy(g).map((r) => r.to)).toEqual([a.key]);
    });

    // A list reads its children through the issue list, a read through each parent: neither draws a child's links.
    it("asks for no links in a read's children, which a read never draws", async () => {
      const { fake, jira, ctx } = setup();
      const parent = fake.add();
      fake.add({ parent: parent.key, issuetype: "Subtask" });
      await hooksOf(jira).source.read(parent.key, ctx);
      const children = searches(fake).filter((b) => b.jql.includes("parent ="));
      expect(children.length).toBeGreaterThan(0);
      expect(children.filter((b) => b.fields.includes("issuelinks"))).toEqual([]);
      expect((await jira.children(parent.key, ctx)).map((c) => Object.keys(c).filter((k) => k.startsWith("related")))).toEqual([[]]);
    });
  });

  describe("and says what it could not read, never reading it as no blocker", () => {
    it("when Jira does not return a closed blocker's state — gone, or not the account's to see: unreadable, never done", async () => {
      const { fake, jira, ctx } = setup();
      fake.add({ key: "OTHER-5", summary: "Upstream", status: "Done", resolution: "Done" });
      const item = fake.add({ labels: ["lr:auto"] });
      blocks(fake, "OTHER-5", item.key);
      fake.unreturned.add("OTHER-5");
      for (const [, g] of await both(jira, ctx, item.key)) {
        expect(nodeOf(g, item.key)?.state.relatedUnreadable).toBe(true);
        expect(nodeOf(g, "OTHER-5")).toMatchObject({ title: "Upstream", closed: null, placeholder: true, unreadable: true });
        expect(nodeOf(g, item.key)?.state.labels).toEqual(["lr:auto"]);
      }
    });

    it.each([
      ["a fault", (fake: FakeJira) => { fake.failOn = (method, path) => (path === "/rest/api/3/issue/bulkfetch" ? 500 : null); }, /500/],
      ["an error Jira says passes", (fake: FakeJira) => { fake.retriable.add("OTHER-5"); }, /Jira could not return issue \d+: Retry the request later/],
    ] as const)("but fails the read on %s, for the next tick to read again", async (_what, fail, said) => {
      const { fake, jira, ctx } = setup();
      fake.add({ key: "OTHER-5", status: "Done", resolution: "Done" });
      const item = fake.add();
      blocks(fake, "OTHER-5", item.key);
      fail(fake);
      await expect(hooksOf(jira).source.read(item.key, ctx)).rejects.toThrow(said);
      await expect(hooksOf(jira).source.list(ctx)).rejects.toThrow(said);
    });

    it("when Jira returns a closed blocker with no status, rather than reading it open", async () => {
      const { fake, ctx } = setup();
      fake.add({ key: "OTHER-5", status: "Done", resolution: "Done" });
      const item = fake.add();
      blocks(fake, "OTHER-5", item.key);
      const statusless = (async (input: string | URL, init?: RequestInit) => {
        const res = await fake.fetchImpl(input, init);
        if (!String(input).endsWith("/rest/api/3/issue/bulkfetch")) return res;
        const body = (await res.json()) as { issues: Array<{ fields: Record<string, unknown> }> };
        for (const issue of body.issues) delete issue.fields.status;
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch;
      const jira = new Jira({ project: "KEY", fetchImpl: statusless });
      const fresh: RuntimeContext = { ...ctx, config: {} as never };
      for (const [, g] of await both(jira, fresh, item.key)) {
        expect(nodeOf(g, item.key)?.state.relatedUnreadable).toBe(true);
        expect(nodeOf(g, "OTHER-5")).toMatchObject({ closed: null, unreadable: true });
      }
    });

    it("saying once a tick which item's blocker it could not read, and what Jira answered", async () => {
      const { fake, jira, ctx } = setup();
      fake.add({ key: "OTHER-5", status: "Done", resolution: "Done" });
      const item = fake.add();
      blocks(fake, "OTHER-5", item.key);
      fake.unreturned.add("OTHER-5");
      const events: Array<Record<string, unknown> | undefined> = [];
      const logged: RuntimeContext = { ...ctx, log: (event, data) => { if (event === "jira.blocker.unreadable") events.push(data); } };
      const tick = async (): Promise<void> => {
        await hooksOf(jira).source.list(logged);
        await hooksOf(jira).source.read(item.key, logged);
      };
      await tick();
      expect(events).toEqual([{ item: item.key, blocker: "OTHER-5", message: expect.stringMatching(/gone, or this account may not see it/) }]);
      await tick();
      expect(events).toHaveLength(2);
    });

    it.each([
      ["names no key for its other end", atKey2((e) => { delete e.inwardIssue?.key; return e; }), ["KEY-1"]],
      ["names a key no Jira issue has", atKey2((e) => { (e.inwardIssue as { key: string }).key = "key-2"; return e; }), ["KEY-1"]],
      ["carries no type", atKey2((e) => { delete e.type; return e; }), ["KEY-1"]],
      ["names both ends", atKey2((e) => ({ ...e, outwardIssue: e.inwardIssue })), ["KEY-1"]],
    ] as const)("when an entry %s", async (_what, edit, read) => {
      const { fake, ctx } = setup();
      for (let i = 0; i < 3; i++) fake.add();
      blocks(fake, "KEY-1", "KEY-3");
      blocks(fake, "KEY-2", "KEY-3");
      const jira = new Jira({ project: "KEY", fetchImpl: editing(fake, edit) });
      const fresh: RuntimeContext = { ...ctx, config: {} as never };
      expect((await jira.item("KEY-3", fresh)).relatedComplete).toBe(false);
      for (const [, g] of await both(jira, fresh, "KEY-3")) {
        expect(nodeOf(g, "KEY-3")?.state.relatedUnreadable).toBe(true);
        expect(blockedBy(g).map((r) => r.to)).toEqual(read);
      }
    });

    // Which issue it is, the link said: the panel names it, as unreadable, and never as done or open.
    it("when an entry carries no status for its other end", async () => {
      const { fake, ctx } = setup();
      for (let i = 0; i < 3; i++) fake.add();
      blocks(fake, "KEY-1", "KEY-3");
      blocks(fake, "KEY-2", "KEY-3");
      const jira = new Jira({ project: "KEY", fetchImpl: editing(fake, atKey2((e) => { delete e.inwardIssue?.fields?.status; return e; })) });
      const fresh: RuntimeContext = { ...ctx, config: {} as never };
      const g = await hooksOf(jira).source.read("KEY-3", fresh);
      expect(nodeOf(g, "KEY-3")?.state.relatedUnreadable).toBe(true);
      expect(blockedBy(g).map((r) => r.to)).toEqual(["KEY-1", "KEY-2"]);
      expect(nodeOf(g, "KEY-2")).toMatchObject({ closed: null, unreadable: true });
    });

    it("when the answer carries no links at all", async () => {
      const { fake, ctx } = setup();
      fake.add();
      const jira = new Jira({ project: "KEY", fetchImpl: editing(fake, () => undefined) });
      const fresh: RuntimeContext = { ...ctx, config: {} as never };
      for (const [, g] of await both(jira, fresh, "KEY-1")) expect(nodeOf(g, "KEY-1")?.state.relatedUnreadable).toBe(true);
    });

    /*
     * The list judges a walk by each listed item's own record, the read by
     * the walk's own search: both are asked, since each takes its own path.
     */
    it.each([
      ["names no key for the blocker's blocker", (e: Entry) => { delete e.inwardIssue?.key; return e; }],
      ["carries no status for the blocker's blocker", (e: Entry) => { delete e.inwardIssue?.fields?.status; return e; }],
    ] as const)("of an item whose cycle walk meets a link that %s", async (_what, cut) => {
      const { fake, ctx } = setup();
      for (let i = 0; i < 4; i++) fake.add();
      blocks(fake, "KEY-2", "KEY-1");
      blocks(fake, "KEY-3", "KEY-2");
      blocks(fake, "KEY-4", "KEY-2");
      const jira = new Jira({
        project: "KEY",
        fetchImpl: editing(fake, (key, links) => (key === "KEY-2"
          ? links.map((e) => (e.inwardIssue?.key === "KEY-4" ? cut(structuredClone(e)) : e))
          : links)),
      });
      const fresh: RuntimeContext = { ...ctx, config: {} as never };
      for (const [, g] of await both(jira, fresh, "KEY-1")) expect(nodeOf(g, "KEY-1")?.state.relatedUnreadable).toBe(true);
      // Nothing it walks past is short: the walk is whole.
      expect(nodeOf(await hooksOf(jira).source.read("KEY-3", fresh), "KEY-3")?.state.relatedUnreadable).toBeUndefined();
    });
  });

  describe("cycles", () => {
    it("says dependencyCycle of two issues blocked by each other, in a list and in a read", async () => {
      const { fake, jira, ctx } = setup();
      for (let i = 0; i < 3; i++) fake.add();
      blocks(fake, "KEY-2", "KEY-1");
      blocks(fake, "KEY-1", "KEY-2");
      blocks(fake, "KEY-1", "KEY-3");
      const listed = await hooksOf(jira).source.list(ctx);
      expect(["KEY-1", "KEY-2", "KEY-3"].map((id) => nodeOf(listed, id)?.state.dependencyCycle)).toEqual([true, true, undefined]);
      expect(nodeOf(await hooksOf(jira).source.read("KEY-1", ctx), "KEY-1")?.state.dependencyCycle).toBe(true);
      expect(nodeOf(await hooksOf(jira).source.read("KEY-3", ctx), "KEY-3")?.state.dependencyCycle).toBeUndefined();
    });

    /*
     * Every waiting item is read every tick, and a read whose item waits on
     * an open issue walks every open issue's links. Asked through the issue
     * list, that is every open issue's fields and changelog per waiting item:
     * the walk asks for the links alone.
     */
    it("walks the open issues' links alone, in one search asking for nothing else", async () => {
      const { fake, jira, ctx } = setup();
      for (let i = 0; i < 3; i++) fake.add();
      blocks(fake, "KEY-2", "KEY-1");
      blocks(fake, "KEY-3", "KEY-2");
      blocks(fake, "KEY-1", "KEY-3");
      expect(nodeOf(await hooksOf(jira).source.read("KEY-1", ctx), "KEY-1")?.state.dependencyCycle).toBe(true);
      expect(openSearches(fake).map((b) => b.fields)).toEqual([["issuelinks"]]);
    });

    it("pages them to the end, and refuses past the pages one list may carry, as the list does", async () => {
      const { fake, jira, ctx } = setup();
      fake.pageSize = 1;
      for (let i = 0; i < 3; i++) fake.add();
      blocks(fake, "KEY-3", "KEY-1");
      blocks(fake, "KEY-1", "KEY-3");
      expect(nodeOf(await hooksOf(jira).source.read("KEY-1", ctx), "KEY-1")?.state.dependencyCycle).toBe(true);
      expect(openSearches(fake)).toHaveLength(3);
      for (let i = 3; i < MAX_ISSUE_PAGES; i++) fake.add();
      await expect(hooksOf(jira).source.read("KEY-1", ctx)).resolves.toBeDefined();
      fake.add();
      await expect(hooksOf(jira).source.read("KEY-1", ctx)).rejects.toThrow(new RegExp(`more open issues than ${MAX_ISSUE_PAGES} pages carry`));
    });

    it("asks nothing of the open issues when the item has no open blocker", async () => {
      const { fake, jira, ctx } = setup();
      const done = fake.add({ status: "Done", resolution: "Done" });
      const item = fake.add();
      blocks(fake, done.key, item.key);
      await hooksOf(jira).source.read(item.key, ctx);
      expect(openSearches(fake)).toEqual([]);
    });

    // The walk reads the configured project's open issues: one elsewhere holds an item back by its state alone.
    it("sees no cycle through an issue in another project", async () => {
      const { fake, jira, ctx } = setup();
      fake.add({ key: "OTHER-5" });
      const item = fake.add();
      blocks(fake, "OTHER-5", item.key);
      blocks(fake, item.key, "OTHER-5");
      for (const [, g] of await both(jira, ctx, item.key)) {
        expect(nodeOf(g, item.key)?.state.dependencyCycle).toBeUndefined();
        expect(nodeOf(g, item.key)?.state.relatedUnreadable).toBeUndefined();
      }
    });
  });

  describe("writing", () => {
    it("relates an issue to its blocker, the blocker sent as inwardIssue and the blocked as outwardIssue, and reads it back", async () => {
      const { fake, jira, ctx } = setup();
      const blocker = fake.add();
      const item = fake.add();
      await hooksOf(jira).operator.relate(item.key, "blocked-by", blocker.key, ctx);
      expect(fake.writes()).toEqual([{
        method: "POST", path: "/rest/api/3/issueLink",
        body: { type: { name: "Blocks" }, inwardIssue: { key: blocker.key }, outwardIssue: { key: item.key } },
      }]);
      expect(await blockersRead(jira, ctx, item.key)).toEqual([blocker.key]);
      expect(await blockersRead(jira, ctx, blocker.key)).toEqual([]);
    });

    it("relates again what Jira already holds, writing nothing", async () => {
      const { fake, jira, ctx } = setup();
      const blocker = fake.add();
      const item = fake.add();
      blocks(fake, blocker.key, item.key);
      await hooksOf(jira).operator.relate(item.key, "blocked-by", blocker.key, ctx);
      expect(fake.writes()).toEqual([]);
      expect(fake.links).toHaveLength(1);
    });

    it("unrelates by the link's id, leaving the other way round and other types alone, and reads none back", async () => {
      const { fake, jira, ctx } = setup();
      const blocker = fake.add();
      const item = fake.add();
      const link = blocks(fake, blocker.key, item.key);
      const reverse = blocks(fake, item.key, blocker.key);
      const relates = fake.link("Relates", blocker.key, item.key);
      await hooksOf(jira).operator.unrelate(item.key, "blocked-by", blocker.key, ctx);
      expect(fake.writes()).toEqual([{ method: "DELETE", path: `/rest/api/3/issueLink/${link.id}`, body: undefined }]);
      expect(fake.links).toEqual([reverse, relates]);
      expect(await blockersRead(jira, ctx, item.key)).toEqual([]);
    });

    it("unrelates one blocker by its own link alone, leaving the item's other blockers linked", async () => {
      const { fake, jira, ctx } = setup();
      const first = fake.add();
      const second = fake.add();
      const item = fake.add();
      const gone = blocks(fake, first.key, item.key);
      const kept = blocks(fake, second.key, item.key);
      await hooksOf(jira).operator.unrelate(item.key, "blocked-by", first.key, ctx);
      expect(fake.writes()).toEqual([{ method: "DELETE", path: `/rest/api/3/issueLink/${gone.id}`, body: undefined }]);
      expect(fake.links).toEqual([kept]);
      expect(await blockersRead(jira, ctx, item.key)).toEqual([second.key]);
    });

    it("unrelates what Jira no longer holds, writing nothing", async () => {
      const { fake, jira, ctx } = setup();
      const blocker = fake.add();
      const item = fake.add();
      await hooksOf(jira).operator.unrelate(item.key, "blocked-by", blocker.key, ctx);
      expect(fake.writes()).toEqual([]);
    });

    it("refuses an unrelate whose blocked issue's links could not all be read, rather than read the link as gone", async () => {
      const { fake, ctx } = setup();
      fake.add();
      fake.add();
      fake.add();
      blocks(fake, "KEY-2", "KEY-3");
      const jira = new Jira({ project: "KEY", fetchImpl: editing(fake, atKey2((e) => { delete e.inwardIssue?.key; return e; })) });
      const fresh: RuntimeContext = { ...ctx, config: {} as never };
      await expect(hooksOf(jira).operator.unrelate("KEY-3", "blocked-by", "KEY-2", fresh))
        .rejects.toThrow(/KEY-3's links could not all be read, so whether KEY-2 blocks it cannot be told/);
      expect(fake.writes()).toEqual([]);
    });

    it("refuses to delete a link Jira answered with no usable id, rather than spell it into a URL", async () => {
      const { fake, ctx } = setup();
      fake.add();
      fake.add();
      blocks(fake, "KEY-1", "KEY-2");
      const jira = new Jira({ project: "KEY", fetchImpl: editing(fake, (_key, links) => links.map((e) => ({ ...e, id: "1/../../myself" }))) });
      const fresh: RuntimeContext = { ...ctx, config: {} as never };
      await expect(hooksOf(jira).operator.unrelate("KEY-2", "blocked-by", "KEY-1", fresh))
        .rejects.toThrow(/Jira answered KEY-2's link to KEY-1 with no usable id/);
      expect(fake.writes()).toEqual([]);
    });

    it("relates to a blocker in another project on the site, and unrelates it", async () => {
      const { fake, jira, ctx } = setup();
      fake.add({ key: "OTHER-5" });
      const item = fake.add();
      await hooksOf(jira).operator.relate(item.key, "blocked-by", "OTHER-5", ctx);
      expect(fake.links).toMatchObject([{ type: "Blocks", inward: "OTHER-5", outward: item.key }]);
      expect(await blockersRead(jira, ctx, item.key)).toEqual(["OTHER-5"]);
      await hooksOf(jira).operator.unrelate(item.key, "blocked-by", "OTHER-5", ctx);
      expect(fake.links).toEqual([]);
    });

    it.each([
      ["relate", "OTHER-1", "KEY-1", /cannot relate OTHER-1 to KEY-1 as "blocked-by": "OTHER-1" is not an issue of KEY/],
      ["relate", "KEY-1", "pr-3", /cannot relate KEY-1 to pr-3 as "blocked-by": "pr-3" is not a Jira issue key/],
      ["relate", "KEY-1", "KEY-99", /cannot relate KEY-1 to KEY-99 as "blocked-by": KEY-99 is not an issue on this site, or this account cannot see it/],
      ["unrelate", "KEY-1", "KEY-99", /cannot unrelate KEY-1 from KEY-99 as "blocked-by": KEY-99 is not an issue on this site/],
      ["relate", "KEY-1", "KEY-2", /KEY-2 has moved to NEW-9; landrace will not follow an issue to a new key/],
      ["relate", "KEY-2", "KEY-1", /cannot relate KEY-2 to KEY-1 as "blocked-by": KEY-2 has moved to NEW-9/],
      ["unrelate", "KEY-2", "KEY-1", /cannot unrelate KEY-2 from KEY-1 as "blocked-by": KEY-2 has moved to NEW-9/],
      ["relate", "KEY-1", "OTHER-5", /cannot relate KEY-1 to OTHER-5 as "blocked-by": OTHER-5 is not an issue on this site, or this account cannot see it$/],
    ] as const)("refuses to %s %s and %s, writing nothing", async (write, item, other, refusal) => {
      const { fake, jira, ctx } = setup();
      fake.add();
      fake.add();
      fake.add({ key: "OTHER-5" });
      fake.move("KEY-2", "NEW-9");
      // Jira's 403 for an issue the account may not browse, which it answers as a 404 elsewhere.
      fake.failOn = (method, path) => (method === "GET" && path === "/rest/api/3/issue/OTHER-5" ? 403 : null);
      await expect(hooksOf(jira).operator[write](item, "blocked-by", other, ctx)).rejects.toThrow(refusal);
      expect(fake.writes()).toEqual([]);
    });

    it.each([
      ["relate", "a 403", (fake: FakeJira) => { fake.failOn = (m) => (m === "POST" ? 403 : null); }],
      ["relate", "the 404 Jira documents for it", (fake: FakeJira) => { fake.canLink = false; }],
      ["unrelate", "a 403", (fake: FakeJira) => { fake.failOn = (m) => (m === "DELETE" ? 403 : null); }],
      ["unrelate", "the 404 Jira documents for it, the link still there", (fake: FakeJira) => { fake.canLink = false; }],
    ] as const)("names the \"Link issues\" permission when a %s is refused with %s", async (write, _how, refuse) => {
      const { fake, jira, ctx } = setup();
      const blocker = fake.add();
      const item = fake.add();
      if (write === "unrelate") blocks(fake, blocker.key, item.key);
      refuse(fake);
      await expect(hooksOf(jira).operator[write](item.key, "blocked-by", blocker.key, ctx))
        .rejects.toThrow(/the account needs the "Link issues" permission on KEY/);
    });

    it("names both projects' \"Link issues\" when the blocker is in another, Jira not saying which it checked", async () => {
      const { fake, jira, ctx } = setup();
      fake.add({ key: "OTHER-5" });
      const item = fake.add();
      fake.canLink = false;
      await expect(hooksOf(jira).operator.relate(item.key, "blocked-by", "OTHER-5", ctx))
        .rejects.toThrow(/the account needs the "Link issues" permission on KEY, or on OTHER, the blocker's project/);
    });

    it("unrelates a link Jira answers 404 for that is gone by the time it is read again, as done", async () => {
      const { fake, jira, ctx } = setup();
      const blocker = fake.add();
      const item = fake.add();
      blocks(fake, blocker.key, item.key);
      fake.failOn = (method) => {
        if (method !== "DELETE") return null;
        fake.links.length = 0; // a person removed it a moment before
        return 404;
      };
      await expect(hooksOf(jira).operator.unrelate(item.key, "blocked-by", blocker.key, ctx)).resolves.toBeUndefined();
    });

    it.each([
      ["relate", "POST", "relate KEY-2 to KEY-1"],
      ["unrelate", "DELETE", "unrelate KEY-2 from KEY-1"],
    ] as const)("fails any other answer to a %s, in a sentence", async (write, method, what) => {
      const { fake, jira, ctx } = setup();
      fake.add();
      fake.add();
      if (write === "unrelate") blocks(fake, "KEY-1", "KEY-2");
      fake.failOn = (m) => (m === method ? 500 : null);
      await expect(hooksOf(jira).operator[write]("KEY-2", "blocked-by", "KEY-1", ctx))
        .rejects.toThrow(new RegExp(`^cannot ${what} as "blocked-by": .*500`));
    });

    it("writes no other type as a link, even for a subclass that says it writes one", async () => {
      class Wider extends Jira {
        protected override writableRelations(): string[] {
          return ["blocked-by", "relates-to"];
        }
      }
      const { fake, ctx } = setup();
      fake.add();
      fake.add();
      const jira = new Wider({ project: "KEY", fetchImpl: fake.fetchImpl });
      await expect(jira.relate("KEY-2", "relates-to", "KEY-1", ctx)).rejects.toThrow(/writes only "blocked-by"/);
      expect(fake.writes()).toEqual([]);
    });

    it("creates an issue blocked by another, related before it is labelled", async () => {
      const { fake, jira, ctx } = setup();
      const blocker = fake.add();
      const node = await hooksOf(jira).operator.createItem(
        { title: "next", labels: ["lr:auto"], relate: [{ type: "blocked-by", item: blocker.key }] }, ctx,
      );
      const order = fake.writes().map((c) => `${c.method} ${c.path}`);
      expect(order.indexOf("POST /rest/api/3/issueLink")).toBeGreaterThan(order.indexOf("POST /rest/api/3/issue"));
      expect(order.indexOf("POST /rest/api/3/issueLink")).toBeLessThan(order.indexOf(`PUT /rest/api/3/issue/${node.id}`));
      expect(await blockersRead(jira, ctx, node.id)).toEqual([blocker.key]);
    });

    it("refuses a new issue blocked by one Jira does not have, before creating anything", async () => {
      const { fake, jira, ctx } = setup();
      fake.add();
      await expect(hooksOf(jira).operator.createItem({ title: "next", relate: [{ type: "blocked-by", item: "KEY-99" }] }, ctx))
        .rejects.toThrow(/KEY-99 is not an issue on this site/);
      expect(fake.writes()).toEqual([]);
      expect([...fake.issues.keys()]).toEqual(["KEY-1"]);
    });

    it("drops a new issue whose link Jira refuses, naming it", async () => {
      const { fake, jira, ctx } = setup();
      const blocker = fake.add();
      fake.canLink = false;
      await expect(hooksOf(jira).operator.createItem({ title: "next", relate: [{ type: "blocked-by", item: blocker.key }] }, ctx))
        .rejects.toThrow(/#KEY-2 was created, but relating it failed: blocked-by #KEY-1: .*"Link issues"/);
      expect(fake.issue("KEY-2").status).toBe("Won't Do");
    });

    it("asks, before any write, by the lookup the write makes", async () => {
      const { fake, jira, ctx } = setup();
      fake.add();
      fake.add();
      fake.add({ key: "OTHER-5" });
      const { operator } = hooksOf(jira);
      expect(await operator.checkRelate("KEY-2", "blocked-by", "KEY-1", ctx)).toBeNull();
      expect(await operator.checkRelate("KEY-2", "blocked-by", "OTHER-5", ctx)).toBeNull();
      expect(await operator.checkRelate("KEY-2", "blocked-by", "KEY-99", ctx)).toBe("KEY-99 is not an issue on this site, or this account cannot see it");
      expect(fake.writes()).toEqual([]);
    });
  });

  // A project named PR keys its issues PR-<n>; the forge's pull requests are pr-<n>, and ids are compared as they are spelt.
  it("reads a blocker in a project named PR as its own key, never as the forge's pull request", async () => {
    const { fake, jira, ctx } = setup();
    const item = fake.add();
    fake.add({ key: "PR-1", summary: "A PR project issue" });
    blocks(fake, "PR-1", item.key);
    const forge = new MemoryForge();
    forge.add(item.key);
    const hooks = compose({ tracker: jira, forge, docs: new MemoryDocs() });
    for (const g of [await hooks.source.list(ctx), await hooks.source.read(item.key, ctx)]) {
      expect(nodeOf(g, "PR-1")).toMatchObject({ kind: "item", title: "A PR project issue", placeholder: true });
      expect(nodeOf(g, "pr-1")?.kind).toBe("pull-request");
      expect(blockedBy(g)).toEqual([{ from: item.key, to: "PR-1", type: "blocked-by" }]);
    }
  });

  /*
   * The shipped fastlane's own gate, asked of what this integration reads:
   * the triggers that take a fresh item to `waiting` or to `build`, and the
   * one that takes it on from `waiting`, word for word as the workflow
   * writes them.
   */
  it("holds an item at fastlane's gate while its Jira blocker is open, and lets it build once the blocker is done", async () => {
    const fast = (await loadShipped()).workspace.workflows.find((w) => w.id === "fastlane");
    if (!fast) throw new Error(".landrace has no workflows/fastlane");
    const trigger = (stage: string, name: string) => {
      const found = fast.workflow.stages.find((s) => s.id === stage)?.triggers?.find((t) => t.name === name);
      if (!found) throw new Error(`fastlane's ${stage} has no trigger "${name}"`);
      return compile(found.when);
    };
    const waits = trigger("waiting", "a fresh item, and a blocker is open");
    const fresh = trigger("build", "a fresh item");
    const frees = trigger("build", "its blockers are done");

    const { fake, jira, ctx } = setup();
    const blocker = fake.add({ summary: "Schema" });
    const item = fake.add({ labels: ["lr:auto", "lr:fast"] });
    blocks(fake, blocker.key, item.key);
    const snapshot = async (stage: string | null): Promise<Snapshot> => {
      const graph = await hooksOf(jira).source.read(item.key, ctx);
      const rel = deriveRel(graph, item.key, hooksOf(jira).source.relations.map((r) => r.type));
      if (!rel.ok) throw new Error(rel.why);
      // Only what the gate reads of the run: where it is, and that no step's output is pending.
      return { node: nodeOf(graph, item.key), graph, rel: rel.rel, run: { stage, lastOutputValid: null } as unknown as NonNullable<Snapshot["run"]> };
    };

    const before = await snapshot(null);
    expect([waits(before), fresh(before)]).toEqual([true, false]);
    expect(relOf(before.graph as Graph, item.key)).toMatchObject({ open: [blocker.key] });
    expect(frees(await snapshot("waiting"))).toBe(false);

    // A person closes the blocker in Jira.
    Object.assign(fake.issue(blocker.key), { status: "Done", resolution: "Done" });
    expect(frees(await snapshot("waiting"))).toBe(true);
    const after = await snapshot(null);
    expect([waits(after), fresh(after)]).toEqual([false, true]);
  });
});
