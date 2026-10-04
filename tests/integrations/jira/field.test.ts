import { Jira, JiraField, type JiraFieldOptions } from "landrace/integrations/jira";
import { isEffectRefused } from "#conventions.js";
import { compose, hashOf, PUBLISH, SPEC } from "#kit/index.js";
import type { HookContext, RuntimeContext, Snapshot } from "#namespace.js";
import {
  createFakeJira, DAY, DESIGN, EMAIL, jiraTime, OTHER, paragraphs, PERSON, SITE, TEXTFIELD, TOKEN,
} from "#tests/integrations/jira/fake-jira.js";

/*
 * The Jira field docs role over the fake Jira Cloud: an item's spec is one
 * multi-line custom field on its own issue.
 */

const SECRETS = { jiraBaseUrl: SITE, jiraEmail: EMAIL, jiraToken: TOKEN };

function setup(options: Partial<JiraFieldOptions> = {}, secrets: Record<string, string> = SECRETS) {
  const fake = createFakeJira();
  const docs = new JiraField({ tracker: new Jira({ project: "KEY", fetchImpl: fake.fetchImpl }), field: DESIGN, fetchImpl: fake.fetchImpl, ...options });
  const events: Array<{ event: string; data: Record<string, unknown> | undefined }> = [];
  const ctx: RuntimeContext = {
    config: {} as never, secrets: new Map(Object.entries(secrets)), signal: new AbortController().signal,
    log: (event, data) => { events.push({ event, data }); },
  };
  return { fake, docs, ctx, events };
}

const on = (ctx: RuntimeContext, item: string, snapshot: Snapshot = {}): HookContext => ({ ...ctx, item, snapshot });

const SPEC_TEXT = "## Design\n\n- one\n- two\n\n```ts\nconst x = 1;\n```";

describe("an issue field as the docs role", () => {
  it("refuses a field that is not a custom field's id", () => {
    const tracker = new Jira({ project: "KEY" });
    expect(() => new JiraField({ tracker, field: "description" })).toThrow(/customfield_<n>/);
    expect(() => new JiraField({ tracker, field: "customfield_1 OR x" })).toThrow(/customfield_<n>/);
  });

  it("takes its project from the tracker, so the two cannot disagree", async () => {
    const { ctx } = setup();
    const docs = new JiraField({ tracker: new Jira({ project: "APP" }), field: DESIGN });
    expect(await docs.link("APP-1", ctx)).toBe(`${SITE}/browse/APP-1`);
    await expect(docs.link("KEY-1", ctx)).rejects.toThrow(/not an issue of APP/);
  });

  it("reads an empty, absent or blank field as no page", async () => {
    const { fake, docs, ctx } = setup();
    const absent = fake.add();
    const empty = fake.add({ custom: { [DESIGN]: null } });
    const blank = fake.add({ custom: { [DESIGN]: paragraphs("") } });
    for (const { key } of [absent, empty, blank]) expect(await docs.page(key, ctx)).toBeNull();
  });

  it("reads a field as ADF as Markdown, and one as a plain string as it is", async () => {
    const { fake, docs, ctx } = setup();
    const rich = fake.add({ custom: { [DESIGN]: paragraphs("A person wrote this.") } });
    const plain = fake.add({ custom: { [DESIGN]: "Plain *text* as the field holds it" } });
    expect(await docs.page(rich.key, ctx)).toBe("A person wrote this.");
    expect(await docs.page(plain.key, ctx)).toBe("Plain *text* as the field holds it");
  });

  it("writes a textarea as ADF, reads it back as written, and writes nothing when it already says it", async () => {
    const { fake, docs, ctx } = setup();
    const { key } = fake.add();
    await docs.publish(key, SPEC_TEXT, ctx);
    const put = fake.writes().at(-1);
    expect(put?.method).toBe("PUT");
    expect(put?.path).toBe(`/rest/api/3/issue/${key}`);
    expect((put?.body as { fields: Record<string, { type?: string }> }).fields[DESIGN]?.type).toBe("doc");
    expect(await docs.page(key, ctx)).toBe(SPEC_TEXT);
    const writes = fake.writes().length;
    await docs.effects()[PUBLISH]?.apply({ type: PUBLISH, artifact: SPEC, body: SPEC_TEXT }, on(ctx, key));
    expect(fake.writes()).toHaveLength(writes);
  });

  it("writes a spec past Jira's bound as plain paragraphs, and refuses one past it even so, before the request", async () => {
    const { fake, docs, ctx } = setup();
    const { key } = fake.add();
    const big = Array.from({ length: 250 }, (_, i) => `- item **${i}** with \`code\``).join("\n");
    await docs.publish(key, big, ctx);
    // Landed plain: one paragraph, no list Jira would have refused as too long.
    expect((fake.issue(key).custom[DESIGN] as { content: Array<{ type: string }> }).content.map((n) => n.type)).toEqual(["paragraph"]);
    expect(await docs.page(key, ctx)).toBe(big);
    const writes = fake.writes().length;
    const error: unknown = await docs.publish(key, "x".repeat(40_000), ctx).catch((e: unknown) => e);
    expect(isEffectRefused(error)).toBe(true);
    expect(fake.writes()).toHaveLength(writes);
  });

  it("writes a textarea with the plain-text renderer as a string, the shape Jira takes for it", async () => {
    const { fake, docs, ctx } = setup();
    fake.plainText.add(DESIGN);
    const { key } = fake.add();
    await docs.publish(key, SPEC_TEXT, ctx);
    expect(fake.issue(key).custom[DESIGN]).toBe(SPEC_TEXT);
    expect(await docs.page(key, ctx)).toBe(SPEC_TEXT);
  });

  it("writes a single-line text field as a string, and refuses one past 255 characters before the request", async () => {
    const { fake, docs, ctx } = setup();
    const field = fake.fields[0];
    if (!field) throw new Error("no field");
    field.schema.custom = TEXTFIELD;
    const { key } = fake.add();
    await docs.publish(key, "One line of design", ctx);
    expect(fake.issue(key).custom[DESIGN]).toBe("One line of design");
    expect(await docs.page(key, ctx)).toBe("One line of design");
    const writes = fake.writes().length;
    const error: unknown = await docs.publish(key, "y".repeat(256), ctx).catch((e: unknown) => e);
    expect(isEffectRefused(error)).toBe(true);
    expect(fake.writes()).toHaveLength(writes);
  });

  // One Epic never stops the workspace: its item is refused, naming why.
  it("refuses the item whose issue type has no field on its edit screen, naming the type, writing nothing", async () => {
    const { fake, docs, ctx } = setup();
    fake.issueTypes.push({ id: "10004", name: "Epic", subtask: false, fields: ["summary", "issuetype", "project", "labels"] });
    const { key } = fake.add({ issuetype: "Epic" });
    const error: unknown = await docs.publish(key, SPEC_TEXT, ctx).catch((e: unknown) => e);
    expect(isEffectRefused(error)).toBe(true);
    expect(String(error)).toContain(`${key} is a "Epic" issue, whose edit screen has no ${DESIGN}`);
    expect(fake.issue(key).custom[DESIGN]).toBeUndefined();
  });

  it("links to the issue itself", async () => {
    const { fake, docs, ctx } = setup();
    const { key } = fake.add();
    expect(await docs.link(key, ctx)).toBe(`${SITE}/browse/${key}`);
  });

  it("refuses an id that is not the project's issue, and one Jira answers under another key", async () => {
    const { fake, docs, ctx } = setup();
    await expect(docs.page("OTHER-1", ctx)).rejects.toThrow(/not an issue of KEY/);
    const { key } = fake.add();
    fake.move(key, "KEY-99");
    await expect(docs.page(key, ctx)).rejects.toThrow(/moved to KEY-99/);
  });

  it("lists the items whose field is filled, in one query inside the project", async () => {
    const { fake, docs, ctx } = setup();
    const filled = fake.add({ custom: { [DESIGN]: paragraphs("Spec") } });
    fake.add();
    expect(await docs.published(ctx)).toEqual(new Set([filled.key]));
    const queries = fake.calls.filter((c) => c.path === "/rest/api/3/search/jql").map((c) => (c.body as { jql: string }).jql);
    expect(queries).toEqual([`project = "KEY" AND cf[10050] is not EMPTY ORDER BY created ASC`]);
  });

  it("lists only jiraAssignee's items when the tracker is scoped", async () => {
    const { fake, docs, ctx } = setup({}, { ...SECRETS, jiraAssignee: PERSON.accountId });
    const mine = fake.add({ assignee: PERSON, custom: { [DESIGN]: paragraphs("Spec") } });
    fake.add({ custom: { [DESIGN]: paragraphs("Somebody else's") } });
    expect(await docs.published(ctx)).toEqual(new Set([mine.key]));
    const [query] = fake.calls.filter((c) => c.path === "/rest/api/3/search/jql").map((c) => (c.body as { jql: string }).jql);
    expect(query).toContain(`assignee = "${PERSON.accountId}"`);
  });

  it("composes beside the Jira tracker, its spec read and published through the composed hook", async () => {
    const { fake, ctx } = setup();
    const tracker = new Jira({ project: "KEY", fetchImpl: fake.fetchImpl });
    const hooks = compose({ tracker, docs: new JiraField({ tracker, field: DESIGN, fetchImpl: fake.fetchImpl }) });
    const { key } = fake.add({ custom: { [DESIGN]: "Written by a person" } });
    const state = await hooks.spec?.read(on(ctx, key));
    expect(state).toEqual({ exists: true, hash: hashOf("Written by a person"), url: `${SITE}/browse/${key}` });
  });
});

describe("the field's preflight", () => {
  it("passes a textarea on every issue type's edit screen, writing nothing", async () => {
    const { fake, docs, ctx } = setup();
    fake.add({ issuetype: "Task" });
    fake.add({ issuetype: "Bug" });
    fake.add({ issuetype: "Subtask", parent: "KEY-1" });
    await expect(docs.check(ctx)).resolves.toBeUndefined();
    expect(fake.writes()).toEqual([]);
  });

  it("names a field the site does not have", async () => {
    const { fake, docs, ctx } = setup({ field: "customfield_99999" });
    fake.add();
    await expect(docs.check(ctx)).rejects.toThrow(/no field customfield_99999/);
  });

  it("names a field that is neither text nor textarea, by its type", async () => {
    const { fake, docs, ctx } = setup({ field: "customfield_10051" });
    fake.add();
    await expect(docs.check(ctx)).rejects.toThrow(/"Team" \(customfield_10051\) is a .*select field/);
  });

  /*
   * A project's Epics, or its own design-doc type, may not carry the field,
   * and no item of theirs is ever specced: only the types an item can be are
   * checked, and one without the field is logged, never a refused start.
   */
  it("checks only the types of the open issues in the tracker's scope, and those it creates, logging each without the field", async () => {
    const { fake, docs, ctx, events } = setup({}, { ...SECRETS, jiraAssignee: PERSON.accountId });
    fake.issueTypes.push({ id: "10004", name: "Epic", subtask: false, fields: ["summary", "issuetype", "project", "labels", "assignee"] });
    fake.issueTypes.push({ id: "10005", name: "Design doc", subtask: false, fields: ["summary", "issuetype", "project", "labels"] });
    const bug = fake.issueTypes.find((t) => t.name === "Bug");
    if (bug) bug.fields = bug.fields.filter((f) => f !== DESIGN);
    fake.add({ issuetype: "Task", assignee: PERSON });
    fake.add({ issuetype: "Bug", assignee: PERSON });
    fake.add({ issuetype: "Epic", assignee: PERSON });
    // Somebody else's: outside the scope, so its type is no item's.
    const elsewhere = fake.add({ issuetype: "Design doc", assignee: OTHER });
    await expect(docs.check(ctx)).resolves.toBeUndefined();
    expect(events.filter((e) => e.event === "jira.field.missing").map((e) => e.data?.type)).toEqual(["Bug", "Epic"]);
    expect(fake.calls.some((c) => c.path === `/rest/api/3/issue/${elsewhere.key}/editmeta`)).toBe(false);
    const listing = fake.calls.find((c) => c.path === "/rest/api/3/search/jql" && (c.body as { fields: string[] }).fields.join() === "issuetype");
    expect((listing?.body as { jql: string }).jql).toContain(`AND assignee = "${PERSON.accountId}"`);
  });

  it("lists the types an item can be, and the items whose field is filled, inside the tracker's jql too", async () => {
    const fake = createFakeJira();
    const since = new Date(Date.now() - 5 * DAY).toISOString().slice(0, 10);
    const tracker = new Jira({ project: "KEY", jql: `created >= "${since}"`, fetchImpl: fake.fetchImpl });
    const docs = new JiraField({ tracker, field: DESIGN, fetchImpl: fake.fetchImpl });
    const events: string[] = [];
    const ctx: RuntimeContext = {
      config: {} as never, secrets: new Map(Object.entries(SECRETS)), signal: new AbortController().signal, log: (event) => { events.push(event); },
    };
    const bug = fake.issueTypes.find((t) => t.name === "Bug");
    if (bug) bug.fields = bug.fields.filter((f) => f !== DESIGN);
    fake.add({ issuetype: "Task" });
    fake.add({ issuetype: "Bug", created: jiraTime(Date.now() - 30 * DAY) });
    await docs.check(ctx);
    expect(events).not.toContain("jira.field.missing");
    const filled = fake.add({ custom: { [DESIGN]: paragraphs("Spec") } });
    fake.add({ custom: { [DESIGN]: paragraphs("Old") }, created: jiraTime(Date.now() - 30 * DAY) });
    expect(await docs.published(ctx)).toEqual(new Set([filled.key]));
  });

  it("counts an issue type with no issue to look at as unchecked, and says so", async () => {
    const { fake, docs, ctx, events } = setup();
    fake.add({ issuetype: "Task" });
    await expect(docs.check(ctx)).resolves.toBeUndefined();
    expect(events).toContainEqual({ event: "jira.field.unchecked", data: expect.objectContaining({ types: ["Subtask"] }) });
  });

  it("reads an edit screen off an open issue, and counts a type with only closed ones as unchecked", async () => {
    const { fake, docs, ctx, events } = setup();
    fake.add({ issuetype: "Task" });
    fake.add({ issuetype: "Subtask", parent: "KEY-1", status: "Done" });
    await expect(docs.check(ctx)).resolves.toBeUndefined();
    expect(events).toContainEqual({ event: "jira.field.unchecked", data: expect.objectContaining({ types: ["Subtask"] }) });
  });

  it("fails when no issue type could be checked at all", async () => {
    const { docs, ctx } = setup();
    await expect(docs.check(ctx)).rejects.toThrow(/no open issue of any issue type an item of KEY can be/);
  });
});
