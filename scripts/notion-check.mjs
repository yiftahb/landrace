/*
 * The Notion integration against a real workspace, the way a ticket's spec
 * goes through it:
 *
 *   pnpm build && NOTION_TOKEN=… NOTION_PARENT=<the shared page's 32-hex id> node scripts/notion-check.mjs
 *
 * Imports `landrace/integrations/notion` by package self-reference, which
 * resolves to dist/ — hence the build. In order: `check`; a first publish,
 * read back; the same text again, which must be satisfied and write nothing;
 * changed text — over a hundred blocks, an emoji astride a piece boundary,
 * 60,000 characters, a fence, a table, an item with 120 children — and that
 * read back exactly, its body counted and its ticket listed. Each step prints `ok` or why not; exits 1 when one failed or
 * nothing was checked.
 *
 * ponytail: each run publishes a fresh `check-<time>` row and leaves it, so
 * a person can look at it; delete the rows by hand.
 */
import { createClient, Notion } from "landrace/integrations/notion";

const token = process.env.NOTION_TOKEN;
const parent = process.env.NOTION_PARENT;
if (!token || !parent) {
  console.error("notion-check: set NOTION_TOKEN to the integration's secret and NOTION_PARENT to the shared page's 32-hex id");
  process.exit(2);
}

const requests = [];
const fetchImpl = (url, init) => {
  requests.push({ method: init?.method ?? "GET", url: String(url) });
  return fetch(url, init);
};
/** Everything but a read: a query is a POST that changes nothing. */
const writes = () => requests.filter((r) => r.method !== "GET" && !r.url.endsWith("/query")).length;

const client = createClient({ token, fetchImpl });
let notion;
try {
  notion = new Notion({ parent, client });
} catch (e) {
  console.error(`notion-check: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}

const ctx = {
  config: {},
  secrets: new Map([["notionToken", token]]),
  signal: new AbortController().signal,
  log: (event, data) => console.error(`${event} ${JSON.stringify(data ?? {})}`),
};
const ticket = `check-${Date.now()}`;
const at = { ...ctx, ticket, snapshot: {} };
const publish = notion.effects()["artifact.publish"];
const effect = (body) => ({ type: "artifact.publish", artifact: "spec", body });

const first = "# Notion check\n\nA first publish, with `inline code` and [a link](https://example.com).\n\n- one\n  - one, nested\n- two\n";
// Over 25 pieces of Source, which only the property item endpoint reads
// whole; an item with more children than one append takes; and 125
// top-level blocks in all. The emoji's paragraph comes first, so it sits
// astride the first cut of Source and of the paragraph's own text alike.
const changed = [
  `${"a".repeat(1_999)}😀 sits astride the first piece boundary of Source. ${"b".repeat(58_000)}`,
  "# Notion check, changed",
  "```typescript\nconst spec: string = \"fenced\";\n```",
  "| a table | stays |\n|---|---|\n| as | written |",
  ["- an item with 120 children", ...Array.from({ length: 120 }, (_, i) => `  - child ${i + 1}`)].join("\n"),
  ...Array.from({ length: 120 }, (_, i) => `Paragraph ${i + 1}.`),
].join("\n\n");
if (changed.indexOf("😀") !== 1_999) throw new Error("notion-check: the emoji is no longer astride Source's first piece boundary");
const BLOCKS = 125;

async function readsBack(text) {
  const page = await notion.page(ticket, ctx);
  if (page === text) return;
  if (page === null) throw new Error("no page read back");
  let i = 0;
  while (page[i] === text[i]) i++;
  throw new Error(`read back ${page.length} characters for the ${text.length} published, first differing at ${i}`);
}

const steps = [
  ["check", () => notion.check(ctx)],
  ["publish", async () => {
    await publish.apply(effect(first), at);
    await readsBack(first);
  }],
  ["same text", async () => {
    const snapshot = { artifacts: { spec: await notion.observe(at) } };
    if (!publish.satisfied(snapshot, effect(first))) throw new Error("not satisfied by the text the row already holds");
    const before = writes();
    await publish.apply(effect(first), at);
    if (writes() !== before) throw new Error(`wrote ${writes() - before} times for text already there`);
  }],
  ["changed text", () => publish.apply(effect(changed), at)],
  ["read back", async () => {
    await readsBack(changed);
    // The row's id is the 32 hex digits its link ends in.
    const row = /([0-9a-f]{32})$/.exec(await notion.link(ticket, ctx))?.[1];
    if (!row) throw new Error("the link is not to a row");
    const blocks = await client.all("GET", `/blocks/${row}/children`);
    if (blocks.length !== BLOCKS) throw new Error(`the body has ${blocks.length} top-level blocks, not ${BLOCKS}`);
    if (!(await notion.published(ctx)).has(ticket)) throw new Error("the ticket is not listed as published");
  }],
];

let passed = 0;
let failed = 0;
for (const [name, run] of steps) {
  try {
    await run();
    passed++;
    console.log(`${name}: ok`);
  } catch (e) {
    failed++;
    console.log(`${name}: FAILED — ${e instanceof Error ? e.message : String(e)}`);
    // Nothing after a failed check can mean anything.
    if (name === "check") break;
  }
}
if (passed > 0) console.log(`row: ${await notion.link(ticket, ctx).catch((e) => `unknown (${e instanceof Error ? e.message : String(e)})`)}`);
process.exitCode = failed === 0 && passed > 0 ? 0 : 1;
