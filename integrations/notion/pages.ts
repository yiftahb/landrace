/*
 * Notion as a project's docs: each item's spec a row of the `Landrace
 * specs` database in a page the operator shared with the integration — a
 * database because only its rows carry properties of their own. The row's
 * `Ticket` is the item, its body the spec as blocks for a person to read,
 * and its `Source` the markdown itself, which is what a step is briefed and
 * what says the page is published. Everything else a docs integration does
 * is `BaseDocs`'s.
 */
import type { RuntimeContext } from "landrace/hooks";
import { BaseDocs } from "landrace/kit";
import { type Block, MAX_TEXT, pieces, toBlocks } from "./blocks.js";
import { type Client, clientFor, tokenRejected } from "./client.js";

const TITLE = "Landrace specs";
/**
 * The row's title column, named before the rename of ticket to item and left
 * so: every database made before it has this column, and a query naming
 * another is refused.
 */
const ITEM_COLUMN = "Ticket";
const SOURCE = "Source";

/** Notion's longest array: a rich text property's pieces, and the blocks one request appends, nested ones counted. */
const MAX_ITEMS = 100;

const text = (content: string) => ({ type: "text", text: { content } });
const titled = [text(TITLE)];

const statusOf = (e: unknown): unknown => (e as { status?: unknown } | null)?.status;

/** A row of the database, as a query or a create answers it. */
interface Row {
  id: string;
  url: string;
  itemId: string;
  source: { id: string; empty: boolean };
}

interface Database {
  id: string;
  dataSource: string;
}

/** What a client has learned: the database, and each looked-up item's row link (null for no row). */
interface State {
  database?: Promise<Database> | undefined;
  urls: Map<string, string | null>;
}

const plainOf = (items: unknown): string =>
  Array.isArray(items) ? items.map((i: { plain_text?: unknown } | null) => (typeof i?.plain_text === "string" ? i.plain_text : "")).join("") : "";

function rowOf(page: unknown): Row {
  type Property = { id?: unknown; type?: unknown; title?: unknown; rich_text?: unknown };
  const p = page as { id?: unknown; url?: unknown; properties?: Record<string, Property | undefined> } | null;
  const source = p?.properties?.[SOURCE];
  if (typeof p?.id !== "string" || typeof p.url !== "string" || source?.type !== "rich_text" || typeof source.id !== "string") {
    throw new Error(`Notion answered with a row of "${TITLE}" that has no id, link or "${SOURCE}" text property`);
  }
  return {
    id: p.id,
    url: p.url,
    itemId: plainOf(p.properties?.[ITEM_COLUMN]?.title),
    // Only emptiness is read here: a query answers 25 rich text objects at most.
    source: { id: source.id, empty: !Array.isArray(source.rich_text) || source.rich_text.length === 0 },
  };
}

/**
 * A database as Notion answers it. Since 2025-09-03 a database holds data
 * sources, and the rows are one's. Ours is made with one; a person who added
 * a second has made "which one" a guess.
 */
function databaseOf(answer: unknown): Database {
  const db = answer as { id?: unknown; data_sources?: unknown } | null;
  const sources = Array.isArray(db?.data_sources) ? (db.data_sources as Array<{ id?: unknown } | null>) : [];
  const [source] = sources;
  if (typeof db?.id !== "string" || sources.length !== 1 || typeof source?.id !== "string") {
    throw new Error(`"${TITLE}" has ${sources.length} data sources; landrace keeps specs in a database with exactly one`);
  }
  return { id: db.id, dataSource: source.id };
}

const duplicate = (item: string, rows: Row[]): Error =>
  new Error(`${rows.length} rows are item ${item} in "${TITLE}" (${rows.map((r) => r.url).join(", ")}); remove all but one`);

const childrenOf = (block: Block): Block[] => (block[block.type] as { children?: Block[] }).children ?? [];

/** A block as the request limit counts it: itself, and each block nested in it. */
const counted = (block: Block): number => childrenOf(block).reduce((n, child) => n + counted(child), 1);

/** `blocks` under `parent`, at most a hundred to a request with nested ones counted. */
async function append(notion: Client, parent: string, blocks: Block[]): Promise<void> {
  let batch: Block[] = [];
  let size = 0;
  const flush = async (): Promise<void> => {
    if (batch.length) await notion.call("PATCH", `/blocks/${parent}/children`, { children: batch });
    batch = [];
    size = 0;
  };
  for (const block of blocks) {
    const n = counted(block);
    if (n > MAX_ITEMS) {
      // More children than one request holds: the block alone, then its children under it.
      await flush();
      const { children, ...bare } = block[block.type] as { children: Block[] };
      const added = await notion.call<{ results?: Array<{ id?: unknown }> }>(
        "PATCH", `/blocks/${parent}/children`, { children: [{ ...block, [block.type]: bare }] },
      );
      const id = added.results?.[0]?.id;
      if (typeof id !== "string") throw new Error("Notion answered an append with no id for the block it added");
      await append(notion, id, children);
      continue;
    }
    if (size + n > MAX_ITEMS) await flush();
    batch.push(block);
    size += n;
  }
  await flush();
}

/**
 * An item's spec, kept in Notion over one client — the one handed in, or the
 * one `ctx.config` builds from the `notionToken` secret.
 */
export class Notion extends BaseDocs {
  private readonly parent: string;
  private readonly client: Client | undefined;
  private readonly states = new WeakMap<Client, State>();

  /** `parent`: the shared page's id, the 32 hex digits its link ends in. */
  constructor({ parent, client }: { parent: string; client?: Client }) {
    super();
    if (!/^[0-9a-f]{32}$/i.test(parent)) {
      throw new Error(`Notion's parent must be the page's 32-hex id, the end of its link — got "${parent}"`);
    }
    this.parent = parent.toLowerCase();
    this.client = client;
  }

  private notion(ctx: RuntimeContext): Client {
    return this.client ?? clientFor(ctx);
  }

  private state(notion: Client): State {
    let state = this.states.get(notion);
    if (!state) this.states.set(notion, (state = { urls: new Map() }));
    return state;
  }

  /**
   * The specs database, or null while the parent holds none. A read never
   * makes one: `landrace status` only reads, and a database that is not there
   * holds no page.
   */
  private async found(notion: Client): Promise<Database | null> {
    const state = this.state(notion);
    if (state.database) return state.database;
    const db = await this.lookup(notion);
    if (db) state.database ??= Promise.resolve(db);
    return db;
  }

  /**
   * The specs database, made in the parent when it holds none: once per
   * client, and shared by every caller asking meanwhile, so the check and a
   * publish side by side never make two. A failure is not kept.
   */
  // ponytail: kept for the process's lifetime — a database deleted or replaced under a running landrace shows after a restart.
  private made(notion: Client): Promise<Database> {
    const state = this.state(notion);
    state.database ??= this.lookup(notion)
      .then(async (db) => db ?? databaseOf(await notion.call("POST", "/databases", {
        parent: { type: "page_id", page_id: this.parent },
        title: titled,
        initial_data_source: { properties: { [ITEM_COLUMN]: { title: {} }, [SOURCE]: { rich_text: {} } } },
      })))
      .catch((e: unknown) => {
        state.database = undefined;
        throw e;
      });
    return state.database;
  }

  private async lookup(notion: Client): Promise<Database | null> {
    type Child = { id?: unknown; type?: unknown; child_database?: { title?: unknown } };
    const found = (await notion.all<Child>("GET", `/blocks/${this.parent}/children`))
      .filter((b) => b.type === "child_database" && b.child_database?.title === TITLE);
    if (found.length > 1) {
      throw new Error(`the parent page holds ${found.length} databases titled "${TITLE}"; landrace writes to one, so rename or remove the others`);
    }
    const [existing] = found;
    return existing ? databaseOf(await notion.call("GET", `/databases/${String(existing.id)}`)) : null;
  }

  private async rows(notion: Client, item?: string): Promise<Row[]> {
    const db = await this.found(notion);
    if (db === null) return [];
    const filter = item === undefined ? {} : { filter: { property: ITEM_COLUMN, title: { equals: item } } };
    return (await notion.all<unknown>("POST", `/data_sources/${db.dataSource}/query`, filter)).map(rowOf);
  }

  /** The item's row, or null. Two halt: which of them is the spec is not a guess. */
  private async row(notion: Client, item: string): Promise<Row | null> {
    const rows = (await this.rows(notion, item)).filter((r) => r.itemId === item);
    if (rows.length > 1) throw duplicate(item, rows);
    const [row = null] = rows;
    this.state(notion).urls.set(item, row?.url ?? null);
    return row;
  }

  /**
   * `Source`, read whole through the property item endpoint — a page as a
   * query answers it carries 25 rich text objects at most. An empty one is a
   * row whose first publish never finished: no page.
   */
  async page(item: string, ctx: RuntimeContext): Promise<string | null> {
    const notion = this.notion(ctx);
    const row = await this.row(notion, item);
    if (row === null || row.source.empty) return null;
    const property = encodeURIComponent(decodeURIComponent(row.source.id));
    const propertyItems = await notion.all<{ rich_text?: { plain_text?: unknown } }>("GET", `/pages/${row.id}/properties/${property}`);
    const content = propertyItems.map((entry) => {
      const piece = entry.rich_text?.plain_text;
      // A piece read as "" would hash as different text and republish on every tick.
      if (typeof piece !== "string") throw new Error(`Notion answered ${SOURCE} of item ${item} with a piece that is not text`);
      return piece;
    }).join("");
    return content === "" ? null : content;
  }

  /**
   * The item's row — found, or made — with its body replaced and `Source`
   * written last. `Source` is what says a page is published, so a publish cut
   * off anywhere before it is redone, on the same row, by the next apply; and
   * a changed page's old `Source` is cleared first, so it never vouches for a
   * body that is no longer it.
   */
  async publish(item: string, content: string, ctx: RuntimeContext): Promise<void> {
    const source = pieces(content);
    if (source.length > MAX_ITEMS) {
      throw new Error(
        `the spec is ${content.length.toLocaleString("en")} characters, ${source.length} pieces of at most ` +
        `${MAX_TEXT.toLocaleString("en")}, and a Notion text property holds ${MAX_ITEMS} — about ` +
        `${(MAX_ITEMS * MAX_TEXT).toLocaleString("en")} characters`,
      );
    }
    const notion = this.notion(ctx);
    const { dataSource } = await this.made(notion);
    let row = await this.row(notion, item);
    if (row === null) {
      row = rowOf(await notion.call("POST", "/pages", {
        parent: { type: "data_source_id", data_source_id: dataSource },
        properties: { [ITEM_COLUMN]: { title: [text(item)] } },
      }));
      this.state(notion).urls.set(item, row.url);
    } else if (!row.source.empty) {
      await notion.call("PATCH", `/pages/${row.id}`, { properties: { [SOURCE]: { rich_text: [] } } });
    }
    // A block at a time: Notion has no call that empties a page.
    for (const child of await notion.all<{ id: string }>("GET", `/blocks/${row.id}/children`)) {
      await notion.call("DELETE", `/blocks/${child.id}`);
    }
    await append(notion, row.id, toBlocks(content));
    await notion.call("PATCH", `/pages/${row.id}`, { properties: { [SOURCE]: { rich_text: source.map(text) } } });
  }

  /**
   * The row, or the parent page while there is none. From the link the last
   * lookup of the item found — the listing's, or the page read's — so a
   * board of items costs no query each.
   */
  async link(item: string, ctx: RuntimeContext): Promise<string> {
    const notion = this.notion(ctx);
    const urls = this.state(notion).urls;
    const url = urls.has(item) ? urls.get(item) : (await this.row(notion, item))?.url;
    return url ?? `https://www.notion.so/${this.parent}`;
  }

  /** Which items have a page, from one query of every row. */
  async published(ctx: RuntimeContext): Promise<Set<string>> {
    const notion = this.notion(ctx);
    const byItem = new Map<string, Row[]>();
    for (const row of await this.rows(notion)) {
      // A row a person added and left blank is nobody's spec.
      if (row.itemId !== "") byItem.set(row.itemId, [...(byItem.get(row.itemId) ?? []), row]);
    }
    const urls = this.state(notion).urls;
    urls.clear();
    const paged = new Set<string>();
    for (const [item, rows] of byItem) {
      const [row] = rows;
      if (!row || rows.length > 1) throw duplicate(item, rows);
      urls.set(item, row.url);
      if (!row.source.empty) paged.add(item);
    }
    return paged;
  }

  /**
   * The parent is shared, and the integration can write in it: the database
   * is made there when missing, and its title rewritten unchanged either way.
   * An integration's capabilities cannot be asked, only tried — the rewrite
   * tries "Update content" on every start, and a token without it would
   * otherwise fail its first publish after the spec step was paid for.
   * "Insert content" is tried only when the database is made: once it
   * exists, a token without it still starts, and its publishes fail on 403.
   */
  async check(ctx: RuntimeContext): Promise<void> {
    const notion = this.notion(ctx);
    try {
      await notion.call("GET", `/pages/${this.parent}`);
    } catch (e) {
      throw tokenRejected(e) ?? (statusOf(e) === 404
        ? new Error(`the parent page ${this.parent} is not shared with the integration — open it in Notion, then ••• → Connections, and add it`)
        : e);
    }
    try {
      const { id } = await this.made(notion);
      await notion.call("PATCH", `/databases/${id}`, { title: titled });
    } catch (e) {
      if (statusOf(e) === 403) {
        throw new Error(`the integration cannot write in the parent page ${this.parent} — give it the "Insert content" and "Update content" capabilities`);
      }
      throw e;
    }
  }
}
