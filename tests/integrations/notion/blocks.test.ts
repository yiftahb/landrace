import { createClient, Notion } from "landrace/integrations/notion";
import { createFakeNotion, type FakeRow } from "#tests/integrations/notion/fake-notion.js";
import type { RuntimeConfig, RuntimeContext } from "#namespace.js";

/**
 * Markdown as Notion blocks: the body a person reads on a ticket's row, as
 * the in-memory Notion stored it — which refuses whatever the real one would.
 * The text itself round-trips through `Source`, so the body is only how it
 * looks; anything the converter does not know is shown verbatim, never
 * dropped.
 */
const ctx: RuntimeContext = { config: {} as RuntimeConfig, secrets: new Map(), signal: new AbortController().signal, log: () => {} };

async function published(markdown: string): Promise<FakeRow> {
  const fake = createFakeNotion();
  const notion = new Notion({ parent: fake.parent, client: createClient({ token: fake.token, fetchImpl: fake.fetchImpl }) });
  await notion.publish("7", markdown, ctx);
  const [row] = fake.rows();
  if (!row) throw new Error("the publish made no row");
  return row;
}
const bodyOf = async (markdown: string) => (await published(markdown)).blocks;

const text = (content: string) => ({ type: "text", text: { content } });
const code = (content: string) => ({ type: "text", text: { content }, annotations: { code: true } });
const link = (content: string, url: string) => ({ type: "text", text: { content, link: { url } } });
const block = (type: string, rich_text: unknown[], extra: Record<string, unknown> = {}) =>
  ({ object: "block", type, [type]: { rich_text, ...extra } });

describe("Source, a piece at a time", () => {
  const sourceOf = async (markdown: string) => (await published(markdown)).source.map((i) => (i.text as { content: string }).content);

  it("is cut into pieces of at most 2,000 UTF-16 units that join back exactly", async () => {
    const long = "a".repeat(4_001);
    const source = await sourceOf(long);
    expect(source.map((p) => p.length)).toEqual([2_000, 2_000, 1]);
    expect(source.join("")).toBe(long);
  });

  it("never cuts an emoji in half: a surrogate pair astride the boundary goes whole into the next piece", async () => {
    const astride = `${"a".repeat(1_999)}😀${"b".repeat(10)}`;
    const source = await sourceOf(astride);
    expect(source.map((p) => p.length)).toEqual([1_999, 12]);
    expect(source[1]?.startsWith("😀")).toBe(true);
    expect(source.join("")).toBe(astride);
  });
});

describe("the body", () => {
  it.each([
    ["# One", "heading_1"],
    ["## Two", "heading_2"],
    ["### Three", "heading_3"],
    ["#### Four", "heading_3"],
    ["###### Six", "heading_3"],
  ])("makes %s a %s, deeper than three a heading_3", async (markdown, type) => {
    expect(await bodyOf(markdown)).toEqual([block(type, [text(markdown.replace(/^#+ /, ""))])]);
  });

  it("makes each paragraph one block, its wrapped lines one line", async () => {
    expect(await bodyOf("one\nstill one\n\ntwo")).toEqual([
      block("paragraph", [text("one still one")]),
      block("paragraph", [text("two")]),
    ]);
  });

  it("makes bulleted and numbered items, and an indented item — however deep — a child of the one above", async () => {
    expect(await bodyOf("- a\n  - a.1\n    - a.1.1\n* b\n\n1. first\n2) second")).toEqual([
      block("bulleted_list_item", [text("a")], {
        children: [block("bulleted_list_item", [text("a.1")]), block("bulleted_list_item", [text("a.1.1")])],
      }),
      block("bulleted_list_item", [text("b")]),
      block("numbered_list_item", [text("first")]),
      block("numbered_list_item", [text("second")]),
    ]);
  });

  it("keeps an item's wrapped line in the item", async () => {
    expect(await bodyOf("- one\n  more of one\n- two")).toEqual([
      block("bulleted_list_item", [text("one more of one")]),
      block("bulleted_list_item", [text("two")]),
    ]);
  });

  it.each([
    ["typescript", "typescript"],
    ["Python", "python"],
    ["ts", "plain text"],
    ["", "plain text"],
  ])("makes a fence tagged %p a code block in %p", async (tag, language) => {
    expect(await bodyOf(`\`\`\`${tag}\nconst a = 1;\n\n  b();\n\`\`\``)).toEqual([
      block("code", [text("const a = 1;\n\n  b();")], { language }),
    ]);
  });

  it("makes quoted lines one quote", async () => {
    expect(await bodyOf("> first\n> second")).toEqual([block("quote", [text("first\nsecond")])]);
  });

  it("marks inline code as code", async () => {
    expect(await bodyOf("run `pnpm test` now")).toEqual([
      block("paragraph", [text("run "), code("pnpm test"), text(" now")]),
    ]);
  });

  it("links an absolute http(s) link, and leaves any other link as the text it was", async () => {
    expect(await bodyOf("see [the docs](https://example.com/a?b=1) or [here](./local.md) or [x](mailto:a@b.c)")).toEqual([
      block("paragraph", [
        text("see "), link("the docs", "https://example.com/a?b=1"), text(" or [here](./local.md) or [x](mailto:a@b.c)"),
      ]),
    ]);
  });

  it.each([
    ["a table", "| a | b |\n|---|---|\n| 1 | 2 |"],
    ["a rule", "---"],
    ["html", "<details>\n<summary>more</summary>\n</details>"],
  ])("shows %s verbatim, as markdown code", async (_, markdown) => {
    expect(await bodyOf(`before\n\n${markdown}\n\nafter`)).toEqual([
      block("paragraph", [text("before")]),
      block("code", [text(markdown)], { language: "markdown" }),
      block("paragraph", [text("after")]),
    ]);
  });

  /*
   * Notion takes at most 100 rich text objects a block. A paragraph of sixty
   * code spans is 120 of them, refused on every tick — and a republish has
   * already cleared the old Source by then — so it is shown as written.
   */
  it("shows a line with more inline pieces than a block takes as the text it was", async () => {
    const line = Array.from({ length: 60 }, (_, i) => `touch \`src/f${i}.ts\``).join(" ");
    expect(await bodyOf(line)).toEqual([block("paragraph", [text(line)])]);
  });

  it("leaves a link Notion would refuse for its length as the text it was", async () => {
    const markdown = `[long](https://example.com/${"a".repeat(2_000)})`;
    expect(await bodyOf(markdown)).toEqual([block("paragraph", [text(markdown.slice(0, 2_000)), text(markdown.slice(2_000))])]);
  });

  it("splits text longer than one rich text object holds", async () => {
    expect(await bodyOf("x".repeat(4_500))).toEqual([
      block("paragraph", [text("x".repeat(2_000)), text("x".repeat(2_000)), text("x".repeat(500))]),
    ]);
  });
});
