import { Jira, type JiraOptions } from "landrace/integrations/jira";
import { isEffectRefused, LABELS } from "#conventions.js";
import { compose } from "#kit/compose.js";
import type { Effect, HookContext, Node, RuntimeContext, Snapshot, Step, Workflow } from "#namespace.js";
import { converge } from "#runner/converge.js";
import { createDispatcher } from "#runner/effects.js";
import { createLogger } from "#runner/events.js";
import { runPreflights, scopedPreflights } from "#runner/preflight.js";
import {
  type Adf, AREAS, CATEGORY, createFakeJira, DUE, EMAIL, NOTES, OTHER, PERSON, POINTS, REVIEWER, SITE, SUMMARY_LINE, TOKEN, WATCHERS,
} from "#tests/integrations/jira/fake-jira.js";

/*
 * `tracker.field` over a fake Jira Cloud: issue fields a transition's
 * conditions or validators need, set from the workflow file in each field's
 * own shape, and read back into `node.state.fields` for `satisfied`.
 */

const SECRETS = { jiraBaseUrl: SITE, jiraEmail: EMAIL, jiraToken: TOKEN };
const FIELD = "tracker.field";
const ALL = [CATEGORY, AREAS, REVIEWER, WATCHERS, POINTS, SUMMARY_LINE, NOTES, DUE];

function setup(options: Partial<JiraOptions> = {}, project = "KEY") {
  const fake = createFakeJira(project);
  fake.fields.push(...ALL);
  fake.options[CATEGORY.id] = ["R&D", "Support"];
  fake.options[AREAS.id] = ["Billing", "Search", "Login"];
  for (const type of fake.issueTypes) type.fields.push(...ALL.map((f) => f.id));
  const jira = new Jira({ project, fetchImpl: fake.fetchImpl, ...options });
  const ctx: RuntimeContext = {
    config: {} as never, secrets: new Map(Object.entries(SECRETS)), signal: new AbortController().signal, log: () => {},
    trackerFields: new Set(ALL.map((f) => f.id)),
  };
  return { fake, jira, ctx };
}

const on = (ctx: RuntimeContext, item: string, snapshot: Snapshot = {}): HookContext => ({ ...ctx, item, snapshot });

const handler = (jira: Jira) => {
  const found = jira.effects()[FIELD];
  if (!found) throw new Error("no tracker.field handler");
  return found;
};

const set = (fields: Record<string, unknown>, onlyIfEmpty?: boolean): Effect =>
  ({ type: FIELD, fields, ...(onlyIfEmpty === undefined ? {} : { onlyIfEmpty }) }) as Effect;

const puts = (fake: ReturnType<typeof createFakeJira>, key: string) =>
  fake.calls.filter((c) => c.method === "PUT" && c.path === `/rest/api/3/issue/${key}`).map((c) => c.body);

const node = (fields?: Record<string, unknown>): Node => ({
  id: "KEY-1", kind: "item", title: "", link: "", closed: null, priority: null, origin: null,
  state: { labels: [], assignees: [], ...(fields === undefined ? {} : { fields: fields as Node["state"] }) },
});

describe("tracker.field writes each field in its own shape", () => {
  it("writes a select, a multi-select, a user by email, users, a number and text in one request", async () => {
    const { fake, jira, ctx } = setup();
    const { key } = fake.add();
    await handler(jira).apply(set({
      [CATEGORY.id]: "R&D",
      [AREAS.id]: ["Billing", "Search"],
      [REVIEWER.id]: "mia@acme.example",
      [WATCHERS.id]: [OTHER.accountId, "mia@acme.example"],
      [POINTS.id]: 3,
      [SUMMARY_LINE.id]: "Payments",
      [NOTES.id]: "Reviewed by **R&D**",
    }), on(ctx, key));
    expect(puts(fake, key)).toEqual([{
      fields: {
        [CATEGORY.id]: { value: "R&D" },
        [AREAS.id]: [{ value: "Billing" }, { value: "Search" }],
        [REVIEWER.id]: { accountId: PERSON.accountId },
        [WATCHERS.id]: [{ accountId: OTHER.accountId }, { accountId: PERSON.accountId }],
        [POINTS.id]: 3,
        [SUMMARY_LINE.id]: "Payments",
        [NOTES.id]: expect.objectContaining({ type: "doc", version: 1 }),
      },
    }]);
    const custom = fake.issue(key).custom;
    expect(custom[CATEGORY.id]).toMatchObject({ value: "R&D" });
    expect(custom[REVIEWER.id]).toMatchObject({ accountId: PERSON.accountId });
    expect((custom[NOTES.id] as Adf).content?.[0]?.content?.some((n) => n.text === "R&D")).toBe(true);
  });

  it("takes one value for a multi-select as a list of it", async () => {
    const { fake, jira, ctx } = setup();
    const { key } = fake.add();
    await handler(jira).apply(set({ [AREAS.id]: "Login" }), on(ctx, key));
    expect(puts(fake, key)).toEqual([{ fields: { [AREAS.id]: [{ value: "Login" }] } }]);
  });

  // `{ customfield_10123: ["R&D"] }`, as a workflow names a select's one option.
  it("takes a list of one for a select or a user as that one value", async () => {
    const { fake, jira, ctx } = setup();
    const { key } = fake.add();
    await handler(jira).apply(set({ [CATEGORY.id]: ["R&D"], [REVIEWER.id]: [PERSON.accountId] }), on(ctx, key));
    expect(puts(fake, key)).toEqual([{ fields: { [CATEGORY.id]: { value: "R&D" }, [REVIEWER.id]: { accountId: PERSON.accountId } } }]);
  });

  // A textarea with the plain-text renderer refuses a document by name, as JiraField and tracker.create learn it.
  it("writes a plain-text textarea as a string once Jira refuses the document", async () => {
    const { fake, jira, ctx } = setup();
    fake.plainText.add(NOTES.id);
    const { key } = fake.add();
    await handler(jira).apply(set({ [NOTES.id]: "plain words", [POINTS.id]: 2 }), on(ctx, key));
    expect(fake.issue(key).custom[NOTES.id]).toBe("plain words");
    expect(fake.issue(key).custom[POINTS.id]).toBe(2);
  });

  it("writes only the fields not already holding their value, and nothing when all do", async () => {
    const { fake, jira, ctx } = setup();
    const { key } = fake.add();
    await handler(jira).apply(set({ [CATEGORY.id]: "R&D" }), on(ctx, key));
    await handler(jira).apply(set({ [CATEGORY.id]: "R&D", [REVIEWER.id]: "mia@acme.example", [AREAS.id]: ["Search"] }), on(ctx, key));
    await handler(jira).apply(set({ [REVIEWER.id]: PERSON.accountId, [AREAS.id]: ["Search"] }), on(ctx, key));
    expect(puts(fake, key)).toEqual([
      { fields: { [CATEGORY.id]: { value: "R&D" } } },
      { fields: { [REVIEWER.id]: { accountId: PERSON.accountId }, [AREAS.id]: [{ value: "Search" }] } },
    ]);
  });

  it("overwrites a value a person set, without onlyIfEmpty", async () => {
    const { fake, jira, ctx } = setup();
    const { key } = fake.add();
    await handler(jira).apply(set({ [CATEGORY.id]: "Support" }), on(ctx, key));
    await handler(jira).apply(set({ [CATEGORY.id]: "R&D" }), on(ctx, key));
    expect(fake.issue(key).custom[CATEGORY.id]).toMatchObject({ value: "R&D" });
  });
});

describe("onlyIfEmpty keeps a person's value", () => {
  it("writes only the fields that are empty on the issue when it is applied", async () => {
    const { fake, jira, ctx } = setup();
    const { key } = fake.add();
    // The filer already chose a reviewer.
    await handler(jira).apply(set({ [REVIEWER.id]: OTHER.accountId }), on(ctx, key));
    await handler(jira).apply(set({ [REVIEWER.id]: "mia@acme.example", [CATEGORY.id]: "R&D" }, true), on(ctx, key));
    expect(fake.issue(key).custom[REVIEWER.id]).toMatchObject({ accountId: OTHER.accountId });
    expect(fake.issue(key).custom[CATEGORY.id]).toMatchObject({ value: "R&D" });
    expect(puts(fake, key).at(-1)).toEqual({ fields: { [CATEGORY.id]: { value: "R&D" } } });
  });

  it("writes nothing when every field holds a value", async () => {
    const { fake, jira, ctx } = setup();
    const { key } = fake.add();
    await handler(jira).apply(set({ [CATEGORY.id]: "Support" }), on(ctx, key));
    await handler(jira).apply(set({ [CATEGORY.id]: "R&D" }, true), on(ctx, key));
    expect(puts(fake, key)).toHaveLength(1);
    expect(fake.issue(key).custom[CATEGORY.id]).toMatchObject({ value: "Support" });
  });
});

describe("tracker.field is satisfied from node.state.fields", () => {
  const satisfied = (effect: Effect, fields?: Record<string, unknown>): boolean =>
    handler(setup().jira).satisfied({ node: node(fields) }, effect);

  it("holds when every field equals its value, a list compared as a set", () => {
    const effect = set({ [CATEGORY.id]: "R&D", [AREAS.id]: ["Search", "Billing"], [POINTS.id]: 3, [REVIEWER.id]: PERSON.accountId });
    const read = { [CATEGORY.id]: "R&D", [AREAS.id]: ["Billing", "Search"], [POINTS.id]: 3, [REVIEWER.id]: PERSON.accountId };
    expect(satisfied(effect, read)).toBe(true);
    expect(satisfied(effect, { ...read, [AREAS.id]: ["Billing"] })).toBe(false);
    expect(satisfied(effect, { ...read, [AREAS.id]: ["Billing", "Search", "Login"] })).toBe(false);
    expect(satisfied(effect, { ...read, [CATEGORY.id]: "Support" })).toBe(false);
    expect(satisfied(effect, { ...read, [POINTS.id]: 4 })).toBe(false);
    expect(satisfied(effect, { ...read, [CATEGORY.id]: null })).toBe(false);
  });

  // Not read is not empty: a field the tracker did not fetch may hold anything.
  it("does not hold for a field missing from node.state.fields, or with no fields read at all", () => {
    expect(satisfied(set({ [CATEGORY.id]: "R&D" }), { [AREAS.id]: null })).toBe(false);
    expect(satisfied(set({ [CATEGORY.id]: "R&D" }, true), {})).toBe(false);
    expect(satisfied(set({ [CATEGORY.id]: "R&D" }))).toBe(false);
  });

  it("holds, with onlyIfEmpty, for a field holding any value, and not for an empty one", () => {
    expect(satisfied(set({ [REVIEWER.id]: "mia@acme.example" }, true), { [REVIEWER.id]: OTHER.accountId })).toBe(true);
    expect(satisfied(set({ [REVIEWER.id]: "mia@acme.example" }, true), { [REVIEWER.id]: null })).toBe(false);
  });

  // An email is resolved only by apply or the preflight; once it is, a field holding its account reads as set.
  it("holds for a user given by email once that email has been resolved", async () => {
    const { fake, jira, ctx } = setup();
    const { key } = fake.add();
    const effect = set({ [REVIEWER.id]: "mia@acme.example" });
    const read = { node: node({ [REVIEWER.id]: PERSON.accountId }) };
    expect(handler(jira).satisfied(read, effect)).toBe(false);
    await handler(jira).apply(effect, on(ctx, key));
    expect(handler(jira).satisfied(read, effect)).toBe(true);
  });

  it("reads each field in its neutral shape from a list and from a read, and nothing it was not asked for", async () => {
    const { fake, jira, ctx } = setup();
    const { key } = fake.add();
    await handler(jira).apply(set({
      [CATEGORY.id]: "R&D", [AREAS.id]: ["Billing", "Login"], [REVIEWER.id]: PERSON.accountId, [WATCHERS.id]: [OTHER.accountId],
      [POINTS.id]: 2.5, [SUMMARY_LINE.id]: "Payments", [NOTES.id]: "Some notes",
    }), on(ctx, key));
    const expected = {
      [CATEGORY.id]: "R&D", [AREAS.id]: ["Billing", "Login"], [REVIEWER.id]: PERSON.accountId, [WATCHERS.id]: [OTHER.accountId],
      [POINTS.id]: 2.5, [SUMMARY_LINE.id]: "Payments", [NOTES.id]: "Some notes", [DUE.id]: null,
    };
    const listed = (await jira.list(ctx)).nodes.find((n) => n.id === key);
    expect(listed?.state.fields).toEqual(expected);
    const read = (await jira.read(key, ctx)).nodes.find((n) => n.id === key);
    expect(read?.state.fields).toEqual(expected);
    const unasked = (await jira.list({ ...ctx, trackerFields: undefined })).nodes.find((n) => n.id === key);
    expect(unasked?.state).not.toHaveProperty("fields");
  });

  // With nothing to fetch, every request is the one it was before tracker.field.
  it("asks for no field beyond its own when no tracker.field names one", async () => {
    const { fake, jira, ctx } = setup();
    fake.add();
    await jira.list({ ...ctx, trackerFields: new Set() });
    const searched = fake.calls.filter((c) => c.path === "/rest/api/3/search/jql").map((c) => (c.body as { fields: string[] }).fields);
    expect(searched.flat().some((f) => f.startsWith("customfield_"))).toBe(false);
  });
});

describe("tracker.field refuses what no retry fixes", () => {
  const refusal = async (effect: Effect, prepare?: (fake: ReturnType<typeof createFakeJira>, key: string) => void): Promise<unknown> => {
    const { fake, jira, ctx } = setup();
    const { key } = fake.add();
    prepare?.(fake, key);
    const err = await handler(jira).apply(effect, on(ctx, key)).then(() => null, (e: unknown) => e);
    expect(puts(fake, key)).toEqual([]);
    return err;
  };

  it("refuses a field not on the issue's edit screen, naming it", async () => {
    const err = await refusal(set({ [CATEGORY.id]: "R&D" }), (fake) => {
      for (const type of fake.issueTypes) type.fields = type.fields.filter((f) => f !== CATEGORY.id);
    });
    expect(isEffectRefused(err)).toBe(true);
    expect(String(err)).toMatch(/KEY-1.*"Task".*edit screen has no customfield_10123/);
  });

  it("refuses a field of a type it cannot write, naming it", async () => {
    const err = await refusal(set({ [DUE.id]: "2026-10-05" }));
    expect(isEffectRefused(err)).toBe(true);
    expect(String(err)).toMatch(/"Due" \(customfield_10130\).*datepicker/);
  });

  it.each([
    ["an option the field lacks", { [CATEGORY.id]: "Marketing" }, /"Marketing".*Category.*"R&D", "Support"/],
    ["a list for a select", { [CATEGORY.id]: ["R&D", "Support"] }, /Category.*one value/],
    ["text for a number", { [POINTS.id]: "three" }, /Points.*number/],
    ["a number for text", { [SUMMARY_LINE.id]: 3 }, /One line.*text/],
    ["an email no user has", { [REVIEWER.id]: "nobody@acme.example" }, /nobody@acme\.example.*no Jira user/],
  ])("refuses %s before writing anything", async (_, fields, message) => {
    const err = await refusal(set(fields));
    expect(isEffectRefused(err)).toBe(true);
    expect(String(err)).toMatch(message);
  });
});

describe("a stage sets the field its transition needs", () => {
  // Through the engine's own converge: on_enter in its declared order, the field before the status.
  const enterBuild = async (onEnter: Effect[]) => {
    const { fake, jira, ctx } = setup({ statuses: { build: "In Progress" } });
    // "Start work" is hidden until a Category is set, as a Jira workflow's condition hides it.
    fake.transitions = fake.transitions.map((t) => (t.to === "In Progress" ? { ...t, needs: [CATEGORY.id] } : t));
    const { key } = fake.add({ labels: ["lr:auto"] });
    const hooks = compose({ tracker: jira });
    const workflow = {
      version: 1, name: "fields", description: "", hooks: [],
      stages: [{ id: "build", entry: true, terminal: true, on_enter: onEnter }],
    } as unknown as Workflow;
    const result = await converge(key, {
      workflow, steps: new Map<string, Step>(), source: hooks.source, pre: [hooks.pre], dispatcher: createDispatcher([hooks.post]),
      executor: { id: "none", run: async () => { throw new Error("no step runs here"); } },
      ctx: { ...ctx, item: key }, log: createLogger({ sink: () => {} }),
    });
    return { fake, key, result };
  };
  const ENTER = { type: "tracker.comment", kind: "enter", marker: "enter:{stage}:{round}", body: "Building." } as Effect;
  const STATUS = { type: "tracker.status", value: "build" } as Effect;
  const CATEGORISE = set({ [CATEGORY.id]: ["R&D"] }, true);

  it("writes the field before the status, so the transition it unlocks is taken", async () => {
    const { fake, key, result } = await enterBuild([ENTER, CATEGORISE, STATUS]);
    expect(result).toMatchObject({ settled: "terminal" });
    expect(fake.issue(key).custom[CATEGORY.id]).toMatchObject({ value: "R&D" });
    expect(fake.issue(key).labels).toContain(LABELS.stage("build"));
    expect(fake.issue(key).status).toBe("In Progress");
  });

  // The other order shows the condition is real: the transition is not offered, and the status stays.
  it("leaves the status where it was when the status comes first", async () => {
    const { fake, key } = await enterBuild([ENTER, STATUS, CATEGORISE]);
    expect(fake.issue(key).custom[CATEGORY.id]).toMatchObject({ value: "R&D" });
    expect(fake.issue(key).status).toBe("To Do");
  });
});

describe("the preflight checks each tracker.field value", () => {
  const values = (entries: Array<[string, unknown[]]>) => new Map(entries) as never;

  it("passes values every field holds, reading an open issue's edit screen", async () => {
    const { fake, jira, ctx } = setup();
    fake.add();
    await expect(jira.check({
      ...ctx, fieldValues: values([[CATEGORY.id, ["R&D"]], [AREAS.id, [["Billing", "Login"]]], [REVIEWER.id, ["mia@acme.example", OTHER.accountId]], [POINTS.id, [3]]]),
    })).resolves.toBeUndefined();
    expect(fake.calls.some((c) => c.path.endsWith("/editmeta"))).toBe(true);
    expect(fake.writes()).toEqual([]);
  });

  it("refuses an option the field lacks, naming the field and the options it has", async () => {
    const { fake, jira, ctx } = setup();
    fake.add();
    await expect(jira.check({ ...ctx, fieldValues: values([[CATEGORY.id, ["R&D", "Marketing"]]]) }))
      .rejects.toThrow(/"Marketing".*"Category" \(customfield_10123\).*"R&D", "Support"/);
  });

  it.each([
    ["a field the site lacks", [["customfield_99999", ["x"]]], /no field customfield_99999/],
    ["a field of a type it cannot write", [[DUE.id, ["2026-10-05"]]], /"Due" \(customfield_10130\).*datepicker/],
    ["a user no account is", [[REVIEWER.id, ["nobody@acme.example"]]], /nobody@acme\.example.*no Jira user/],
    ["an account id no user has", [[REVIEWER.id, ["557058:00000000-0000-0000-0000-000000000000"]]], /557058:0{8}.*no Jira user/],
    ["text for a number", [[POINTS.id, ["three"]]], /Points.*number/],
  ])("refuses %s", async (_, entries, message) => {
    const { fake, jira, ctx } = setup();
    fake.add();
    await expect(jira.check({ ...ctx, fieldValues: values(entries as Array<[string, unknown[]]>) })).rejects.toThrow(message);
  });

  // Not found is not missing: a type no open issue shows is said, never passed or failed by guess.
  it("logs a type with no open issue to read an edit screen from, and leaves it unchecked", async () => {
    const { fake, jira, ctx } = setup();
    fake.add();
    const events: Array<Record<string, unknown>> = [];
    const logged = { ...ctx, log: (event: string, data?: Record<string, unknown>) => { if (event === "jira.tracker-field.unchecked") events.push(data ?? {}); } };
    await jira.check({ ...logged, fieldValues: values([[CATEGORY.id, ["R&D"]]]) });
    expect(events).toEqual([expect.objectContaining({ types: ["Subtask"] })]);
  });

  it("refuses options it could read off no edit screen at all", async () => {
    const { jira, ctx } = setup();
    await expect(jira.check({ ...ctx, fieldValues: values([[CATEGORY.id, ["R&D"]]]) })).rejects.toThrow(/no open issue.*customfield_10123/);
  });

  // Nothing compared is not a pass: an option checked against no screen would pass start and be refused on every item.
  it("refuses an option field no edit screen it read has", async () => {
    const { fake, jira, ctx } = setup();
    for (const type of fake.issueTypes) type.fields = type.fields.filter((f) => f !== CATEGORY.id);
    fake.add();
    await expect(jira.check({ ...ctx, fieldValues: values([[CATEGORY.id, ["R&D"]]]) }))
      .rejects.toThrow(/"Category" \(customfield_10123\).*no edit screen.*"R&D".*cannot be told/);
  });

  it("refuses an option field whose edit screen lists no allowed values", async () => {
    const { fake, jira, ctx } = setup();
    delete fake.options[CATEGORY.id];
    fake.add();
    await expect(jira.check({ ...ctx, fieldValues: values([[CATEGORY.id, ["R&D"]]]) }))
      .rejects.toThrow(/"Category" \(customfield_10123\).*"Task".*no allowed values.*"R&D".*cannot be told/);
  });

  /*
   * Two workflows on two projects, each setting Category to an option only its
   * own project offers. Each tracker's preflight is handed the values of the
   * workflows that load it, so each passes; handed every workflow's, ENG's would
   * refuse OPS's option, though both workflows are sound.
   */
  it("checks each project's values against its own screens, in a workspace of two", async () => {
    const project = (key: string, options: string[]) => {
      const { fake, jira, ctx } = setup({}, key);
      fake.options[CATEGORY.id] = options;
      fake.add();
      return { jira, ctx };
    };
    const eng = project("ENG", ["R&D"]);
    const ops = project("OPS", ["Ops"]);
    const categorised = (option: string) => ({
      workflow: { stages: [{ id: "build", on_enter: [set({ [CATEGORY.id]: [option] })] }] } as unknown as Workflow,
      steps: new Map<string, Step>(),
    });
    const preflights = scopedPreflights([
      { preflights: [compose({ tracker: eng.jira }).preflight], workflow: categorised("R&D") },
      { preflights: [compose({ tracker: ops.jira }).preflight], workflow: categorised("Ops") },
    ]);
    await expect(runPreflights(preflights.slice(0, 1), eng.ctx)).resolves.toBeUndefined();
    await expect(runPreflights(preflights.slice(1), ops.ctx)).resolves.toBeUndefined();
    await expect(eng.jira.check({ ...eng.ctx, fieldValues: values([[CATEGORY.id, [["R&D"], ["Ops"]]]]) })).rejects.toThrow(/"Ops"/);
  });

  it("reads nothing more when no tracker.field is loaded", async () => {
    const { fake, jira, ctx } = setup();
    fake.add();
    await jira.check({ ...ctx, fieldValues: values([]) });
    expect(fake.calls.some((c) => c.path.endsWith("/editmeta") || c.path === "/rest/api/3/field")).toBe(false);
  });
});
