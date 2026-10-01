import { createHash } from "node:crypto";
import { createClient, Notion } from "landrace/integrations/notion";
import { createFakeNotion, type FakeNotion, type FakeRequest } from "#tests/integrations/notion/fake-notion.js";
import type { Effect, EffectHandler, HookContext, RuntimeConfig, RuntimeContext } from "#namespace.js";

/**
 * Notion as a project's docs, over the in-memory Notion: a ticket's spec is a
 * row of the `Landrace specs` database in a page the operator shared — its
 * `Ticket` the ticket, its body the spec as blocks, its `Source` the markdown
 * itself, written last.
 */
const ctx: RuntimeContext = { config: {} as RuntimeConfig, secrets: new Map(), signal: new AbortController().signal, log: () => {} };
const at = (ticket: string): HookContext => ({ ...ctx, ticket, snapshot: {} });

const world = (fake: FakeNotion = createFakeNotion()) => ({
  fake,
  notion: new Notion({ parent: fake.parent, client: createClient({ token: fake.token, fetchImpl: fake.fetchImpl }) }),
});

const effect = (body: string): Effect => ({ type: "artifact.publish", artifact: "spec", body });
const handler = (notion: Notion): EffectHandler => {
  const publish = notion.effects()["artifact.publish"];
  if (!publish) throw new Error("Notion publishes nothing");
  return publish;
};
const apply = (notion: Notion, body: string, ticket = "12") => handler(notion).apply(effect(body), at(ticket));

/** Everything but a read: a query is a POST that changes nothing. */
const writes = (fake: FakeNotion): FakeRequest[] => fake.requests.filter((r) => r.method !== "GET" && !r.path.endsWith("/query"));
const sourceOf = (body: FakeRequest["body"]): unknown => (body?.properties as { Source?: unknown } | undefined)?.Source;
const appends = (fake: FakeNotion): number[] =>
  fake.requests.filter((r) => r.method === "PATCH" && r.path.endsWith("/children")).map((r) => (r.body?.children as unknown[]).length);
const textOf = (items: Array<Record<string, unknown>>): string => items.map((i) => (i.text as { content: string }).content).join("");
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

describe("check, before landrace start pays for anything", () => {
  it("creates the Landrace specs database in the parent page", async () => {
    const { fake, notion } = world();
    await notion.check(ctx);
    expect(fake.databases().map((d) => d.title)).toEqual(["Landrace specs"]);
    expect(writes(fake).map((r) => `${r.method} ${r.path}`)).toEqual(["POST /databases"]);
  });

  it("finds the database already there and rewrites its title unchanged, which proves the token can write", async () => {
    const { fake, notion } = world();
    const id = fake.seedDatabase();
    await notion.check(ctx);
    expect(fake.databases()).toEqual([{ id, title: "Landrace specs" }]);
    expect(writes(fake).map((r) => `${r.method} ${r.path} ${textOf(r.body?.title as [])}`)).toEqual([
      `PATCH /databases/${id} Landrace specs`,
    ]);
  });

  it("says the parent page is not shared with the integration", async () => {
    const { fake, notion } = world();
    fake.unshare();
    await expect(notion.check(ctx)).rejects.toThrow(new RegExp(`parent page ${fake.parent} is not shared with the integration`));
  });

  it("says the token was rejected, and never what it was", async () => {
    const fake = createFakeNotion();
    const notion = new Notion({ parent: fake.parent, client: createClient({ token: "secret_wrong-token", fetchImpl: fake.fetchImpl }) });
    const failure = await notion.check(ctx).then(() => null, (e: unknown) => String(e));
    expect(failure).toMatch(/token was rejected by Notion \(401\)/);
    expect(failure).not.toContain("secret_wrong-token");
  });

  it("names the notionToken secret when it is not set", async () => {
    const notion = new Notion({ parent: createFakeNotion().parent });
    await expect(notion.check(ctx)).rejects.toThrow(/"notionToken" secret/);
  });

  it("halts when the parent holds two databases of that title, rather than pick one", async () => {
    const { fake, notion } = world();
    fake.seedDatabase();
    fake.seedDatabase();
    await expect(notion.check(ctx)).rejects.toThrow(/2 databases titled "Landrace specs"/);
  });

  it("refuses a parent that is not a page's 32-hex id", () => {
    expect(() => new Notion({ parent: "https://www.notion.so/Specs-0123" })).toThrow(/32-hex id/);
  });
});

describe("publishing a ticket's spec", () => {
  it("makes one row: Ticket the ticket, the body the spec as blocks, Source the markdown", async () => {
    const { fake, notion } = world();
    await apply(notion, "# Spec\n\nthe plan");

    const [row, ...more] = fake.rows();
    expect(more).toEqual([]);
    expect(row?.ticket).toBe("12");
    expect(textOf(row?.source ?? [])).toBe("# Spec\n\nthe plan");
    expect(row?.blocks.map((b) => b.type)).toEqual(["heading_1", "paragraph"]);
  });

  it("reads back what it published, hashed, and links the row — the parent page until there is one", async () => {
    const { fake, notion } = world();
    expect(await notion.observe(at("12"))).toEqual({ exists: false, hash: null, url: `https://www.notion.so/${fake.parent}` });

    await apply(notion, "# Spec");

    expect(await notion.observe(at("12"))).toEqual({ exists: true, hash: sha256("# Spec"), url: fake.rows()[0]?.url });
  });

  it("is satisfied by the same text, and applying it again writes nothing", async () => {
    const { fake, notion } = world();
    await apply(notion, "# Spec");
    const snapshot = { artifacts: { spec: await notion.observe(at("12")) } };
    const before = writes(fake).length;

    expect(handler(notion).satisfied(snapshot, effect("# Spec"))).toBe(true);
    expect(handler(notion).satisfied(snapshot, effect("# Spec, revised"))).toBe(false);
    await apply(notion, "# Spec");

    expect(writes(fake).length).toBe(before);
  });

  it("replaces the body of the same row when the text changed, and writes Source last", async () => {
    const { fake, notion } = world();
    await apply(notion, "# Old\n\nold plan\n\n- gone");
    const id = fake.rows()[0]?.id;

    await apply(notion, "# New\n\nnew plan");

    const [row, ...more] = fake.rows();
    expect(more).toEqual([]);
    expect(row?.id).toBe(id);
    expect(row?.blocks.map((b) => [b.type, textOf((b[b.type as string] as { rich_text: [] }).rich_text)])).toEqual([
      ["heading_1", "New"], ["paragraph", "new plan"],
    ]);
    const last = writes(fake).at(-1);
    expect([last?.method, last?.path, textOf((sourceOf(last?.body) as { rich_text: [] }).rich_text)])
      .toEqual(["PATCH", `/pages/${id}`, "# New\n\nnew plan"]);
  });

  it("leaves a first publish cut off before Source unpublished, and finishes it on the same row next time", async () => {
    const { fake, notion } = world();
    fake.failOn((r) => r.method === "PATCH" && r.path.startsWith("/pages/") && sourceOf(r.body) !== undefined, 500, { times: 1 });

    await expect(apply(notion, "# Spec\n\nthe plan")).rejects.toThrow(/500/);
    expect(await notion.page("12", ctx)).toBeNull();
    const id = fake.rows()[0]?.id;

    await apply(notion, "# Spec\n\nthe plan");
    expect(fake.rows().map((r) => [r.id, r.blocks.length])).toEqual([[id, 2]]);
    expect(await notion.page("12", ctx)).toBe("# Spec\n\nthe plan");
  });

  it("leaves a republish cut off partway through the body unpublished, and redoes it on the same row next time", async () => {
    const { fake, notion } = world();
    await apply(notion, "# Old\n\nold plan");
    const id = fake.rows()[0]?.id;
    fake.failOn((r) => r.method === "PATCH" && r.path.endsWith("/children"), 500, { times: 1 });

    await expect(apply(notion, "# New\n\nnew plan\n\nmore")).rejects.toThrow(/500/);
    // Never the old text over a body that is no longer it.
    expect(await notion.page("12", ctx)).toBeNull();

    await apply(notion, "# New\n\nnew plan\n\nmore");
    expect(fake.rows().map((r) => [r.id, r.blocks.length])).toEqual([[id, 3]]);
    expect(await notion.page("12", ctx)).toBe("# New\n\nnew plan\n\nmore");
  });

  it("reads 60,000 characters back exactly, an emoji astride a piece boundary", async () => {
    const { notion } = world();
    const spec = `${"a".repeat(1_999)}😀${"b".repeat(57_999)}`;
    expect(spec.length).toBe(60_000);

    await apply(notion, spec);

    expect(await notion.page("12", ctx)).toBe(spec);
  });

  it("refuses a spec longer than Source holds before writing anything", async () => {
    const { fake, notion } = world();
    fake.seedDatabase();
    await expect(apply(notion, "x".repeat(200_001))).rejects.toThrow(/200,000/);
    expect(writes(fake)).toEqual([]);
    expect(fake.rows()).toEqual([]);
  });

  it("appends 250 blocks in requests of 100, 100 and 50", async () => {
    const { fake, notion } = world();
    await apply(notion, Array.from({ length: 250 }, (_, i) => `paragraph ${i}`).join("\n\n"));
    expect(appends(fake)).toEqual([100, 100, 50]);
    expect(fake.rows()[0]?.blocks).toHaveLength(250);
  });

  it("counts an item's children toward a request's 100", async () => {
    const { fake, notion } = world();
    await apply(notion, Array.from({ length: 60 }, (_, i) => `- item ${i}\n  - under ${i}`).join("\n"));
    expect(appends(fake)).toEqual([50, 10]);
  });

  it("gives an item with more children than one request holds as many requests as they need", async () => {
    const { fake, notion } = world();
    await apply(notion, ["- parent", ...Array.from({ length: 150 }, (_, i) => `  - child ${i}`)].join("\n"));
    expect(appends(fake)).toEqual([1, 100, 50]);
    const [item] = fake.rows()[0]?.blocks ?? [];
    expect((item?.bulleted_list_item as { children: unknown[] }).children).toHaveLength(150);
  });

  it("waits out a 429 for as long as Notion says, and carries on", async () => {
    const { fake, notion } = world();
    fake.failOn(() => true, 429, { times: 4 });
    await apply(notion, "# Spec");
    expect(await notion.page("12", ctx)).toBe("# Spec");
  });

  it("gives up after five tries", async () => {
    const { fake, notion } = world();
    fake.failOn(() => true, 429, { times: 5 });
    await expect(apply(notion, "# Spec")).rejects.toThrow(/429/);
    expect(fake.requests).toHaveLength(5);
  });
});

describe("reading which tickets have a page", () => {
  it("has no page, and links the parent, for a ticket with no row", async () => {
    const { fake, notion } = world();
    fake.seedDatabase();
    expect(await notion.page("99", ctx)).toBeNull();
    expect(await notion.link("99", ctx)).toBe(`https://www.notion.so/${fake.parent}`);
  });

  it("reads a row whose Source is empty as never published, and links the row", async () => {
    const { fake, notion } = world();
    fake.seedDatabase();
    fake.seedRow("12", []);
    expect(await notion.page("12", ctx)).toBeNull();
    expect(await notion.published(ctx)).toEqual(new Set());
    expect(await notion.link("12", ctx)).toBe(fake.rows()[0]?.url);
  });

  it("halts on two rows for one ticket rather than pick one", async () => {
    const { fake, notion } = world();
    fake.seedDatabase();
    fake.seedRow("12", ["one"]);
    fake.seedRow("12", ["two"]);
    await expect(notion.page("12", ctx)).rejects.toThrow(/2 rows are ticket 12/);
    await expect(notion.published(ctx)).rejects.toThrow(/2 rows are ticket 12/);
  });

  it("lists the pages from one query, each linked to its row, with no query per ticket", async () => {
    const { fake, notion } = world();
    fake.seedDatabase();
    const twelve = fake.seedRow("12", ["# Twelve"]);
    const thirteen = fake.seedRow("13", ["# Thirteen"]);
    fake.seedRow("14", []);

    const graph = await notion.list(new Set(["12", "13", "14", "15"]), ctx);

    expect(graph.nodes.map((n) => [n.id, n.link])).toEqual([
      ["spec-12", `https://www.notion.so/${twelve.replace(/-/g, "")}`],
      ["spec-13", `https://www.notion.so/${thirteen.replace(/-/g, "")}`],
    ]);
    expect(fake.requests.filter((r) => r.path.endsWith("/query"))).toHaveLength(1);
  });
});
