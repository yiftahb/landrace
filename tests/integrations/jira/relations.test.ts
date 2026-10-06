import { Jira, type JiraOptions } from "landrace/integrations/jira";
import { deriveRel } from "#core/rel.js";
import { compose } from "#kit/compose.js";
import type { Graph, RuntimeContext, Snapshot, Workflow } from "#namespace.js";
import { snapshotProvides } from "#runner/snapshot.js";
import { createFakeJira, EMAIL, type FakeJira, SITE, TOKEN } from "#tests/integrations/jira/fake-jira.js";
import { validateSemantics } from "#workflow/validate.js";

/*
 * `relations`: issue link types a project maps to relationship types, read
 * both ways off the `issuelinks` the list already asks for — an outward link
 * `rel.<name>.out`, an inward one `rel.<name>.in`, and one whose type reads
 * the same both ways `out` from either end. And the item's own status, and a
 * related issue's, on `node.state`. Read only: `relate` still writes
 * blocked-by alone.
 */

const SECRETS = { jiraBaseUrl: SITE, jiraEmail: EMAIL, jiraToken: TOKEN };
const MAPPED = { relates: "Relates", duplicates: "Duplicate" };

function setup(options: Partial<JiraOptions> = {}) {
  const fake = createFakeJira();
  const jira = new Jira({ project: "KEY", fetchImpl: fake.fetchImpl, relations: MAPPED, ...options });
  const ctx: RuntimeContext = {
    config: {} as never, secrets: new Map(Object.entries(SECRETS)), signal: new AbortController().signal, log: () => {},
  };
  return { fake, jira, ctx };
}

const hooksOf = (jira: Jira) => compose({ tracker: jira });
const nodeOf = (g: Graph, id: string) => g.nodes.find((n) => n.id === id);
/** Both ways the engine reads an item. */
const both = async (jira: Jira, ctx: RuntimeContext, id: string): Promise<Array<[string, Graph]>> =>
  [["list", await hooksOf(jira).source.list(ctx)], ["read", await hooksOf(jira).source.read(id, ctx)]];
const TYPES = ["child-of", "blocked-by", "relates", "duplicates"];
const relOf = (g: Graph, id: string, type: string) => {
  const rel = deriveRel(g, id, TYPES);
  if (!rel.ok) throw new Error(rel.why);
  return rel.rel[type];
};
/** As a person links two issues in Jira: the type's outward words are said of `inward` — "A duplicates B" is `link("Duplicate", A, B)`. */
const link = (fake: FakeJira, type: string, inward: string, outward: string) => fake.link(type, inward, outward);

describe("relations, as issue links of the types a project maps", () => {
  it("declares each mapped name, read both ways, beside blocked-by, and writes blocked-by alone", () => {
    const { jira } = setup();
    expect(jira.relations()).toEqual([
      { type: "child-of", singular: true }, { type: "blocked-by", singular: false, outwardOnly: true },
      { type: "relates", singular: false }, { type: "duplicates", singular: false },
    ]);
    expect(jira.relates()).toEqual(["blocked-by"]);
  });

  it.each([
    [{ Relates: "Relates" }, /relations name "Relates" must be lowercase/],
    [{ "blocked-by": "Duplicate" }, /relations name "blocked-by" is one of the engine's own relationship types/],
    [{ "child-of": "Duplicate" }, /"child-of" is one of the engine's own/],
    [{ waits: "Blocks" }, /relations\.waits maps "Blocks", which is blockedByLinkType/],
    [{ relates: "Relates", related: "Relates" }, /relations\.relates and relations\.related both map "Relates"/],
    [{ relates: " " }, /relations\.relates must name an issue link type/],
  ])("refuses %j at load, before anything is read", (relations, said) => {
    expect(() => new Jira({ project: "KEY", relations })).toThrow(said);
  });

  it("refuses a name that maps blockedByLinkType when it is renamed too", () => {
    expect(() => new Jira({ project: "KEY", blockedByLinkType: "Gates", relations: { gated: "Gates" } })).toThrow(/blockedByLinkType/);
  });

  it("reads a link both ways: the outward end's out, the inward end's in", async () => {
    const { fake, jira, ctx } = setup();
    const original = fake.add({ summary: "The original" });
    const copy = fake.add({ summary: "Same report" });
    const item = fake.add({ summary: "Login fails" });
    link(fake, "Duplicate", item.key, original.key);
    link(fake, "Duplicate", copy.key, item.key);
    for (const [, g] of await both(jira, ctx, item.key)) {
      expect(g.relationships).toEqual(expect.arrayContaining([
        { from: item.key, to: original.key, type: "duplicates" }, { from: copy.key, to: item.key, type: "duplicates" },
      ]));
      expect(relOf(g, item.key, "duplicates")).toMatchObject({ out: { total: 1, open: [original.key] }, in: { total: 1, open: [copy.key] } });
    }
  });

  it("reads a link whose type says the same both ways as out from either end, whichever made it", async () => {
    const { fake, jira, ctx } = setup();
    const a = fake.add();
    const b = fake.add();
    const item = fake.add();
    link(fake, "Relates", item.key, a.key);
    link(fake, "Relates", b.key, item.key);
    const read = await hooksOf(jira).source.read(item.key, ctx);
    expect(relOf(read, item.key, "relates")).toMatchObject({ out: { total: 2, open: [a.key, b.key] }, in: { total: 0 } });
    expect(relOf(await hooksOf(jira).source.read(a.key, ctx), a.key, "relates")).toMatchObject({ out: { total: 1, open: [item.key] } });
  });

  it("reads no link of a type it does not map", async () => {
    const { fake, jira, ctx } = setup({ relations: { relates: "Relates" } });
    const a = fake.add();
    const item = fake.add();
    link(fake, "Duplicate", item.key, a.key);
    link(fake, "Cloners", item.key, a.key);
    for (const [, g] of await both(jira, ctx, item.key)) {
      expect(g.relationships.filter((r) => r.from === item.key || r.to === item.key)).toEqual([]);
      expect(nodeOf(g, item.key)?.state).not.toHaveProperty("relatedUnreadable");
    }
  });

  it("draws an issue in another project as a placeholder with its key, title, link, state and status, from the link alone", async () => {
    const { fake, jira, ctx } = setup();
    fake.add({ key: "ENG-5", summary: "Fix the login bug", status: "In Progress" });
    fake.add({ key: "ENG-6", summary: "Old fix", status: "Won't Do", resolution: "Won't Do" });
    const item = fake.add();
    link(fake, "Relates", item.key, "ENG-5");
    link(fake, "Relates", "ENG-6", item.key);
    const before = fake.calls.length;
    for (const [, g] of await both(jira, ctx, item.key)) {
      expect(nodeOf(g, "ENG-5")).toEqual({
        id: "ENG-5", kind: "item", title: "Fix the login bug", link: `${SITE}/browse/ENG-5`, closed: null, priority: null, origin: null,
        state: { labels: [], assignees: [], status: "In Progress", statusCategory: "indeterminate" }, placeholder: true,
      });
      expect(nodeOf(g, "ENG-6")).toMatchObject({ closed: "dropped", state: { status: "Won't Do", statusCategory: "done" } });
      expect(relOf(g, item.key, "relates")).toMatchObject({ out: { total: 1, dropped: 1, open: ["ENG-5"] } });
    }
    // Nothing asked of either: what the link says is all that is read.
    expect(fake.calls.slice(before).filter((c) => /ENG-|\/issue\/bulkfetch/.test(c.path) || JSON.stringify(c.body ?? "").includes("ENG-"))).toEqual([]);
  });

  it("draws an issue filed by tracker.create, in the slot createIn links it, when createLinkType is mapped", async () => {
    const { fake, jira, ctx } = setup({ createIn: ["ENG"] });
    fake.addProject("ENG");
    fake.add({ key: "ENG-9", summary: "Filed for the ticket" });
    const item = fake.add();
    // createIn sends the item as the new issue's `outwardIssue`.
    link(fake, "Relates", "ENG-9", item.key);
    for (const [, g] of await both(jira, ctx, item.key)) {
      expect(g.relationships).toContainEqual({ from: item.key, to: "ENG-9", type: "relates" });
    }
  });

  it("says an item's links were not all read when a mapped link's type does not say how it reads each way", async () => {
    const { fake, ctx } = setup();
    const a = fake.add();
    const item = fake.add();
    link(fake, "Duplicate", item.key, a.key);
    const strip = (async (input: string | URL, init?: RequestInit) => {
      const res = await fake.fetchImpl(input, init);
      const text = await res.text();
      return new Response(text === "" ? null : text.replaceAll('"inward":"is duplicated by",', ""), {
        status: res.status, headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const blind = new Jira({ project: "KEY", fetchImpl: strip, relations: MAPPED });
    for (const [, g] of await both(blind, ctx, item.key)) {
      expect(nodeOf(g, item.key)?.state.relatedUnreadable).toBe(true);
      expect(g.relationships.filter((r) => r.type === "duplicates" && (r.from === item.key || r.to === item.key))).toEqual([]);
    }
  });
});

describe("the item's status", () => {
  it("is on node.state, by name and by category, read in the list's own request", async () => {
    const { fake, jira, ctx } = setup();
    const item = fake.add({ status: "Pending R&D Fix" });
    const fresh = fake.add();
    for (const [, g] of await both(jira, ctx, item.key)) {
      expect(nodeOf(g, item.key)?.state).toMatchObject({ status: "Pending R&D Fix", statusCategory: "indeterminate" });
    }
    expect(nodeOf(await hooksOf(jira).source.list(ctx), fresh.key)?.state).toMatchObject({ status: "To Do", statusCategory: "new" });
    expect(fake.calls.filter((c) => c.path.startsWith(`/rest/api/3/issue/${item.key}?fields=status`))).toEqual([]);
  });

  it("is a path validate accepts in a condition", () => {
    const hooks = hooksOf(new Jira({ project: "KEY" }));
    const w: Workflow = { version: 1, name: "t", description: "t", stages: [
      { id: "a", entry: true, triggers: [{ when: { "node.state.status": { $ne: "PENDING R&D FIX" }, "node.state.statusCategory": "new" } }] },
    ] };
    expect(validateSemantics(w, new Map(), snapshotProvides([hooks.pre], hooks.source) ?? undefined)
      .filter((p) => p.rule === "path-coverage")).toEqual([]);
  });
});

describe("{brief.project.related} over Jira", () => {
  it("is the item's status, then each related issue: relationship, direction, key, title and status", async () => {
    const { fake, jira, ctx } = setup();
    fake.add({ key: "ENG-5", summary: "Fix the login bug", status: "In Progress" });
    const blocker = fake.add({ summary: "Schema" });
    const item = fake.add({ status: "Pending R&D Fix" });
    link(fake, "Relates", item.key, "ENG-5");
    link(fake, "Blocks", blocker.key, item.key);
    const hooks = hooksOf(jira);
    const graph = await hooks.source.read(item.key, ctx);
    const snapshot: Snapshot = { graph, node: nodeOf(graph, item.key) };
    expect((await hooks.source.brief?.({ ...ctx, item: item.key, snapshot }, new Set(["related"])))?.related).toBe([
      "Status: Pending R&D Fix (indeterminate)",
      "",
      `- blocked-by, out: ${blocker.key} "Schema" — To Do`,
      '- relates, out: ENG-5 "Fix the login bug" — In Progress',
    ].join("\n"));
  });
});

describe("validate, over the relationships a tracker declares", () => {
  const reading = (path: string): Workflow => ({ version: 1, name: "t", description: "t", stages: [
    { id: "a", entry: true, triggers: [{ when: { [path]: { $gt: 0 } } }] },
  ] });
  const coverage = (jira: Jira, path: string): string[] => {
    const hooks = hooksOf(jira);
    return validateSemantics(reading(path), new Map(), snapshotProvides([hooks.pre], hooks.source) ?? undefined)
      .filter((p) => p.rule === "path-coverage").map((p) => p.message);
  };

  it("accepts rel.relates.out.total and rel.duplicates.in.total only when relations maps them", () => {
    expect(coverage(new Jira({ project: "KEY", relations: MAPPED }), "rel.relates.out.total")).toEqual([]);
    expect(coverage(new Jira({ project: "KEY", relations: MAPPED }), "rel.duplicates.in.total")).toEqual([]);
    expect(coverage(new Jira({ project: "KEY" }), "rel.relates.out.total")).toEqual([expect.stringContaining("rel.relates.out.total")]);
  });
});

describe("start", () => {
  it("refuses a mapped link type the site lacks, naming the option and the types it has", async () => {
    const { fake, jira, ctx } = setup({ relations: { relates: "Relates", follows: "Follows" } });
    await expect(jira.check?.(ctx)).rejects.toThrow(
      /no issue link type "Follows" \(relations\.follows\)[\s\S]*it has "Blocks", "Cloners", "Duplicate", "Relates"/,
    );
    expect(fake.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("passes every mapped type the site has", async () => {
    const { jira, ctx } = setup();
    await expect(jira.check?.(ctx)).resolves.toBeUndefined();
  });
});
