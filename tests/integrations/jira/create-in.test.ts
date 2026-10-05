import { Jira, type JiraOptions } from "landrace/integrations/jira";
import { isEffectRefused, parseMarker } from "#conventions.js";
import type { Effect, HookContext, RuntimeContext, Snapshot } from "#namespace.js";
import { createFakeJira, DESIGN, EMAIL, PERSON, SITE, TEXTFIELD, TOKEN } from "#tests/integrations/jira/fake-jira.js";

/*
 * `createIn`: a support desk's tracker filing an ENG bug for a ticket — one
 * request carrying the issue, its link to the ticket, who it is assigned to
 * and the marker that says landrace filed it for this ticket.
 */
const SECRETS = { jiraBaseUrl: SITE, jiraEmail: EMAIL, jiraToken: TOKEN };

function setup(options: Partial<JiraOptions> = {}, secrets: Record<string, string> = SECRETS) {
  const fake = createFakeJira();
  fake.addProject("ENG");
  const jira = new Jira({ project: "KEY", createIn: ["ENG"], fetchImpl: fake.fetchImpl, ...options });
  const ctx: RuntimeContext = {
    config: {} as never, secrets: new Map(Object.entries(secrets)), signal: new AbortController().signal, log: () => {},
  };
  const ticket = fake.add({ summary: "Export crashes", labels: ["lr:auto"] });
  return { fake, jira, ctx, ticket };
}

const bug: Effect = {
  type: "tracker.create", project: "ENG", title: "Crash on export", body: "Stack trace\n\nline 2",
  stage: "diagnose", round: 1, kind: "part", marker: "part:diagnose:1:1",
};

const on = (ctx: RuntimeContext, item: string, snapshot: Snapshot = {}): HookContext => ({ ...ctx, item, snapshot });

/** A single-line text field, "Root cause", on a Task's screens. */
const ROOT_CAUSE = "customfield_10060";
function withRootCause(fake: ReturnType<typeof createFakeJira>): void {
  fake.fields.push({ id: ROOT_CAUSE, name: "Root cause", custom: true, schema: { type: "string", custom: TEXTFIELD, customId: 10060 } });
  fake.issueTypes.find((t) => t.name === "Task")?.fields.push(ROOT_CAUSE);
}

describe("Jira, filing an issue in another project", () => {
  it("creates in what createIn names, and nowhere unless named", () => {
    expect(new Jira({ project: "KEY", createIn: ["ENG", "OPS"] }).createsIn()).toEqual(["ENG", "OPS"]);
    expect(new Jira({ project: "KEY" }).createsIn()).toEqual([]);
  });

  it("refuses a createIn that is not a project key, is its own project, or links as blocked-by", () => {
    expect(() => new Jira({ project: "KEY", createIn: ["eng"] })).toThrow(/createIn must name Jira project keys/);
    expect(() => new Jira({ project: "KEY", createIn: ["KEY"] })).toThrow(/createIn names KEY, this tracker's own project/);
    expect(() => new Jira({ project: "KEY", createIn: ["ENG"], createLinkType: "Blocks" })).toThrow(/createLinkType .* blockedByLinkType/);
  });

  it("files one issue, linked, marked and assigned in one request, and records it on the ticket", async () => {
    const { fake, jira, ctx, ticket } = setup({}, { ...SECRETS, jiraAssignee: PERSON.accountId });
    await jira.effects()["tracker.create"]?.apply(bug, on(ctx, ticket.key));

    const creates = fake.writes().filter((c) => c.method === "POST" && c.path === "/rest/api/3/issue");
    expect(creates).toHaveLength(1);
    const filed = fake.issue("ENG-1");
    expect(filed).toMatchObject({ summary: "Crash on export", issuetype: "Task", labels: [], assignee: PERSON });
    expect(filed.properties).toEqual({ "landrace.created-by": { item: ticket.key, marker: "created:part:diagnose:1:1" } });
    expect(fake.links).toEqual([expect.objectContaining({ type: "Relates", inward: "ENG-1", outward: ticket.key })]);

    const record = ticket.comments.at(-1);
    expect(JSON.stringify(record?.body)).toContain("Filed ENG-1: Crash on export");
  });

  it("reuses the issue already filed for this ticket and marker, rather than filing two", async () => {
    const { fake, jira, ctx, ticket } = setup();
    const apply = jira.effects()["tracker.create"]?.apply;
    await apply?.(bug, on(ctx, ticket.key));
    ticket.comments = []; // a crash between the issue and its record
    await apply?.(bug, on(ctx, ticket.key));
    expect(fake.writes().filter((c) => c.method === "POST" && c.path === "/rest/api/3/issue")).toHaveLength(1);
    // Another part's issue is its own.
    await apply?.({ ...bug, marker: "part:diagnose:1:2" }, on(ctx, ticket.key));
    expect(fake.writes().filter((c) => c.method === "POST" && c.path === "/rest/api/3/issue")).toHaveLength(2);
  });

  it("does not read a linked issue it did not mark as the one it filed", async () => {
    const { fake, jira, ctx, ticket } = setup();
    const theirs = fake.add({ key: "ENG-77", summary: "someone's" });
    fake.link("Relates", theirs.key, ticket.key);
    await jira.effects()["tracker.create"]?.apply(bug, on(ctx, ticket.key));
    expect(fake.writes().filter((c) => c.method === "POST" && c.path === "/rest/api/3/issue")).toHaveLength(1);
  });

  it("refuses an issue Jira will not take, as a refusal, not an outage", async () => {
    const { jira, ctx, ticket } = setup({ createType: "Epic" });
    const refused = await jira.effects()["tracker.create"]?.apply(bug, on(ctx, ticket.key)).catch((e: unknown) => e);
    expect(isEffectRefused(refused)).toBe(true);
    expect((refused as Error).message).toMatch(/Jira refused to file an issue in ENG/);
  });

  it("is satisfied by the record on the ticket, read back through the snapshot", async () => {
    const { jira, ctx, ticket } = setup();
    await jira.effects()["tracker.create"]?.apply(bug, on(ctx, ticket.key));
    const snapshot = (await jira.observe(on(ctx, ticket.key))) as unknown as Snapshot;
    expect(jira.effects()["tracker.create"]?.satisfied(snapshot, bug)).toBe(true);
    expect(jira.effects()["tracker.create"]?.satisfied(snapshot, { ...bug, marker: "part:diagnose:1:2" })).toBe(false);
    const comments = (snapshot as unknown as { item: { comments: Array<{ body: string }> } }).item.comments;
    expect(parseMarker(comments.at(-1)?.body ?? "")).toMatchObject({ kind: "created", marker: "created:part:diagnose:1:1" });
  });

  it("fills each field in the shape it takes, in the one request: a document for a rich textarea, a string for a text field", async () => {
    const { fake, jira, ctx, ticket } = setup();
    withRootCause(fake);
    await jira.effects()["tracker.create"]?.apply(
      { ...bug, fields: { [DESIGN]: "## Plan\n\nGuard the **empty** case", [ROOT_CAUSE]: "No guard" } },
      on(ctx, ticket.key),
    );
    expect(fake.writes().filter((c) => c.method === "POST" && c.path === "/rest/api/3/issue")).toHaveLength(1);
    const { custom } = fake.issue("ENG-1");
    expect(custom[DESIGN]).toMatchObject({ type: "doc", version: 1 });
    expect(JSON.stringify(custom[DESIGN])).toContain("Guard the ");
    expect(custom[ROOT_CAUSE]).toBe("No guard");
  });

  it("writes a plain-text textarea as a string, when Jira refuses it the document", async () => {
    const { fake, jira, ctx, ticket } = setup();
    fake.plainText.add(DESIGN);
    await jira.effects()["tracker.create"]?.apply({ ...bug, fields: { [DESIGN]: "Guard the empty case" } }, on(ctx, ticket.key));
    expect(fake.issue("ENG-1").custom[DESIGN]).toBe("Guard the empty case");
    expect(fake.writes().filter((c) => c.method === "POST" && c.path === "/rest/api/3/issue")).toHaveLength(2);
  });

  it("refuses a text field's value past its bound before asking Jira, filing nothing", async () => {
    const { fake, jira, ctx, ticket } = setup();
    withRootCause(fake);
    const refused = await jira.effects()["tracker.create"]?.apply({ ...bug, fields: { [ROOT_CAUSE]: "x".repeat(256) } }, on(ctx, ticket.key))
      .catch((e: unknown) => e);
    expect(isEffectRefused(refused)).toBe(true);
    expect((refused as Error).message).toMatch(/256-character customfield_10060: a text field holds at most 255/);
    expect(fake.writes().filter((c) => c.method === "POST" && c.path === "/rest/api/3/issue")).toHaveLength(0);
  });

  it("cuts a title past Jira's summary bound to fit", async () => {
    const { fake, jira, ctx, ticket } = setup();
    const long = `${"word ".repeat(60)}end`;
    expect(long.length).toBeGreaterThan(255);
    await jira.effects()["tracker.create"]?.apply({ ...bug, title: long }, on(ctx, ticket.key));
    expect(fake.issue("ENG-1").summary).toBe(long.slice(0, 255));
  });

  it("leaves a filed issue out of the tracker's own items", async () => {
    const { jira, ctx, ticket } = setup();
    await jira.effects()["tracker.create"]?.apply(bug, on(ctx, ticket.key));
    expect((await jira.items(ctx)).map((i) => i.id)).toEqual([ticket.key]);
  });
});

describe("Jira's preflight, for createIn", () => {
  it("passes an account that may file, link and browse there", async () => {
    const { jira, ctx } = setup();
    await expect(jira.check(ctx)).resolves.toBeUndefined();
  });

  it("names each permission the account lacks on a createIn project", async () => {
    const { fake, jira, ctx } = setup({}, { ...SECRETS, jiraAssignee: PERSON.accountId });
    fake.projectPermissions("ENG", { CREATE_ISSUES: false, LINK_ISSUES: false, ASSIGN_ISSUES: false });
    await expect(jira.check(ctx)).rejects.toThrow(
      /the account lacks "Create Issues" \(CREATE_ISSUES\) on ENG, where createIn files issues; the account lacks "Link Issues" \(LINK_ISSUES\) on ENG, where createIn files issues; the account lacks "Assign Issues" \(ASSIGN_ISSUES\) on ENG/,
    );
  });

  it("names an issue type the project lacks, and a link type the site lacks", async () => {
    const { jira, ctx } = setup({ createType: "Epic", createLinkType: "Mentions" });
    await expect(jira.check(ctx)).rejects.toThrow(/ENG has no issue type "Epic" \(createType\)[\s\S]*no issue link type "Mentions" \(createLinkType\)/);
  });

  const mapped = (ctx: RuntimeContext, ...fields: string[]) => ({ ...ctx, createFields: new Map([["ENG", new Set(fields)]]) });

  it("passes a mapped text or textarea field on createType's create screen", async () => {
    const { fake, jira, ctx } = setup();
    withRootCause(fake);
    await expect(jira.check(mapped(ctx, DESIGN, ROOT_CAUSE))).resolves.toBeUndefined();
  });

  it("names a mapped field off createType's create screen, and one that is not text, for each createIn project", async () => {
    const { fake, jira, ctx } = setup({ createType: "Bug" });
    const bugType = fake.issueTypes.find((t) => t.name === "Bug");
    if (bugType) bugType.fields = bugType.fields.filter((f) => f !== DESIGN);
    bugType?.fields.push("customfield_10051");
    await expect(jira.check(mapped(ctx, DESIGN, "customfield_10051"))).rejects.toThrow(
      /ENG's "Bug" issues have no customfield_10050 on their create screen, and a tracker\.create fills it[\s\S]*"Team" \(customfield_10051\) is a com\.atlassian\.jira\.plugin\.system\.customfieldtypes:select field, not a text or textarea one/,
    );
  });

  it("asks nothing of the create screen when no route maps a field", async () => {
    const { fake, jira, ctx } = setup({ createType: "Bug" });
    const bugType = fake.issueTypes.find((t) => t.name === "Bug");
    if (bugType) bugType.fields = bugType.fields.filter((f) => f !== DESIGN);
    await expect(jira.check(ctx)).resolves.toBeUndefined();
    await expect(jira.check({ ...ctx, createFields: new Map() })).resolves.toBeUndefined();
  });

  it("asks nothing of a project when createIn names none", async () => {
    const { fake, ctx } = setup();
    const plain = new Jira({ project: "KEY", fetchImpl: fake.fetchImpl });
    await plain.check(ctx);
    expect(fake.calls.some((c) => c.path.includes("ENG"))).toBe(false);
  });
});
