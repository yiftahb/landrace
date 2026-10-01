import { randomUUID } from "node:crypto";

/**
 * Notion's API, in memory, as its documentation describes it at
 * `Notion-Version: 2025-09-03`: the endpoints the integration calls, the
 * answers in their documented shapes, and the limits that make a real call
 * fail — 2,000 characters a rich text object, 100 objects an array, 100
 * blocks a request with nested ones counted, page sizes of at most 100, and
 * a page's rich text cut to 25 objects wherever it is answered whole. Every
 * request is logged, and any can be made to fail.
 *
 * One workspace: a parent page the integration is shared on (or, after
 * `unshare`, is not), and what is created under it.
 */
const VERSION = "2025-09-03";
const MAX_TEXT = 2000;
const MAX_ARRAY = 100;
/** How much of a page's rich text Notion answers inline; the rest is the property item endpoint's. */
const INLINE_ITEMS = 25;

/** Every language a code block takes. */
const LANGUAGES = new Set([
  "abap", "abc", "agda", "arduino", "ascii art", "assembly", "bash", "basic", "bnf", "c", "c#", "c++", "clojure",
  "coffeescript", "coq", "css", "dart", "dhall", "diff", "docker", "ebnf", "elixir", "elm", "erlang", "f#", "flow",
  "fortran", "gherkin", "glsl", "go", "graphql", "groovy", "haskell", "hcl", "html", "idris", "java", "javascript",
  "json", "julia", "kotlin", "latex", "less", "lisp", "livescript", "llvm ir", "lua", "makefile", "markdown", "markup",
  "matlab", "mathematica", "mermaid", "nix", "notion formula", "objective-c", "ocaml", "pascal", "perl", "php",
  "plain text", "powershell", "prolog", "protobuf", "purescript", "python", "r", "racket", "reason", "ruby", "rust",
  "sass", "scala", "scheme", "scss", "shell", "smalltalk", "solidity", "sql", "swift", "toml", "typescript", "vb.net",
  "verilog", "vhdl", "visual basic", "webassembly", "xml", "yaml", "java/c/c++/c#",
]);

const TEXT_BLOCKS = new Set([
  "paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "quote", "code",
]);

type Json = Record<string, unknown>;
type Rich = Json;

interface Block { id: string; type: string; body: Json; children: string[]; trashed: boolean }
interface Row { id: string; dataSource: string; values: Record<string, Rich[]>; children: string[]; trashed: boolean }
interface Database { id: string; title: Rich[]; dataSource: string; schema: Record<string, { id: string; type: string }> }

export interface FakeRequest { method: string; path: string; body: Json | undefined }

export interface FakeRow {
  id: string;
  url: string;
  ticket: string;
  /** `Source` as stored, a rich text object at a time. */
  source: Rich[];
  /** The row's body, in the form it was written. */
  blocks: Json[];
}

export interface FakeNotion {
  fetchImpl: typeof fetch;
  token: string;
  /** The shared parent page, as the 32-hex id an operator copies out of its link. */
  parent: string;
  requests: FakeRequest[];
  /** Every row of every database, oldest first, as a person would find it. */
  rows(): FakeRow[];
  /** Each database under the parent, by title. */
  databases(): Array<{ id: string; title: string }>;
  /** A `Landrace specs` database already there, as a previous start left it. */
  seedDatabase(title?: string): string;
  /** A row already in the (one) database, its `Source` the given rich text contents. */
  seedRow(ticket: string, source: string[]): string;
  /** Answer requests that match with this status instead; a 429 says to retry after `retryAfter` seconds. */
  failOn(match: (r: FakeRequest) => boolean, status: number, opts?: { times?: number; retryAfter?: string }): void;
  /** The operator removes the integration from the parent page's connections. */
  unshare(): void;
}

class NotionError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

const bad = (message: string): never => {
  throw new NotionError(400, "validation_error", message);
};
const notFound = (id: string): never => {
  throw new NotionError(404, "object_not_found",
    `Could not find object with ID: ${id}. Make sure the relevant pages and databases are shared with your integration.`);
};

const flat = (id: string): string => id.replace(/-/g, "").toLowerCase();
const dashed = (hex: string): string => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
const newId = (): string => flat(randomUUID());
const urlOf = (id: string): string => `https://www.notion.so/${id}`;

/**
 * A rich text array, refused as Notion refuses one — and stored as Notion
 * stores it, as UTF-8, where half a surrogate pair is U+FFFD.
 */
function checkRich(value: unknown, where: string): Rich[] {
  if (!Array.isArray(value)) return bad(`${where} should be an array.`);
  if (value.length > MAX_ARRAY) return bad(`${where}.length should be ≤ \`${MAX_ARRAY}\`, instead was \`${value.length}\`.`);
  value.forEach((item: Json, i) => {
    const text = item?.text as Json | undefined;
    if (typeof text?.content !== "string") bad(`${where}[${i}].text.content should be a string.`);
    const content = text?.content as string;
    if (content.length > MAX_TEXT) bad(`${where}[${i}].text.content.length should be ≤ \`${MAX_TEXT}\`, instead was \`${content.length}\`.`);
    const link = text?.link as Json | null | undefined;
    if (link != null) {
      const url = link.url;
      if (typeof url !== "string" || !/^https?:\/\//i.test(url) || !URL.canParse(url)) bad(`Invalid URL for link.`);
    }
  });
  return (value as Rich[]).map((item) => {
    const text = item.text as Json;
    return { ...item, text: { ...text, content: Buffer.from(text.content as string, "utf8").toString("utf8") } };
  });
}

/** A rich text object as Notion answers it, rather than as it was written. */
const answered = (item: Rich): Json => {
  const text = item.text as { content: string; link?: { url: string } | null };
  const annotations = (item.annotations ?? {}) as Json;
  return {
    type: "text",
    text: { content: text.content, link: text.link ?? null },
    annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: annotations.code === true, color: "default" },
    plain_text: text.content,
    href: text.link?.url ?? null,
  };
};

const plain = (items: Rich[]): string => items.map((i) => (i.text as { content: string }).content).join("");

export function createFakeNotion({ token = "secret_test-token" }: { token?: string } = {}): FakeNotion {
  const parent = newId();
  let shared = true;
  const requests: FakeRequest[] = [];
  const blocks = new Map<string, Block>();
  const rows = new Map<string, Row>();
  const databases = new Map<string, Database>();
  /** The parent page's own children: the databases created in it, in order. */
  const parentChildren: string[] = [];
  let failure: { match: (r: FakeRequest) => boolean; status: number; times: number; retryAfter: string } | null = null;

  const databaseOf = (dataSource: string): Database | undefined => [...databases.values()].find((d) => d.dataSource === dataSource);
  const rowsOf = (dataSource: string): Row[] => [...rows.values()].filter((r) => r.dataSource === dataSource && !r.trashed);
  const titleName = (db: Database): string => Object.entries(db.schema).find(([, p]) => p.type === "title")?.[0] ?? "";

  const createDatabase = (title: Rich[], properties: Json): Database => {
    const schema: Database["schema"] = {};
    for (const [name, spec] of Object.entries(properties)) {
      const type = Object.keys(spec as Json)[0];
      if (type !== "title" && type !== "rich_text") bad(`${name} has an unsupported property type.`);
      schema[name] = { id: type === "title" ? "title" : encodeURIComponent(`=${name.slice(0, 3)}`), type: type as string };
    }
    if (Object.values(schema).filter((p) => p.type === "title").length !== 1) bad("A database must have exactly one title property.");
    const db: Database = { id: newId(), title, dataSource: newId(), schema };
    databases.set(db.id, db);
    parentChildren.push(db.id);
    return db;
  };

  const databaseJson = (db: Database): Json => ({
    object: "database",
    id: dashed(db.id),
    title: db.title.map(answered),
    parent: { type: "page_id", page_id: dashed(parent) },
    data_sources: [{ id: dashed(db.dataSource), name: plain(db.title) }],
    url: urlOf(db.id),
    in_trash: false,
  });

  const rowJson = (row: Row): Json => {
    const db = databaseOf(row.dataSource);
    const properties: Json = {};
    for (const [name, prop] of Object.entries(db?.schema ?? {})) {
      properties[name] = { id: prop.id, type: prop.type, [prop.type]: (row.values[name] ?? []).slice(0, INLINE_ITEMS).map(answered) };
    }
    return {
      object: "page",
      id: dashed(row.id),
      url: urlOf(row.id),
      parent: { type: "data_source_id", data_source_id: dashed(row.dataSource) },
      in_trash: row.trashed,
      properties,
    };
  };

  const blockJson = (block: Block): Json => ({
    object: "block", id: dashed(block.id), type: block.type, [block.type]: block.body, has_children: block.children.length > 0, in_trash: block.trashed,
  });

  const childrenOf = (id: string): string[] => {
    if (id === parent) return parentChildren;
    const owner = rows.get(id) ?? blocks.get(id);
    if (!owner || owner.trashed) return notFound(dashed(id));
    return owner.children;
  };

  /** Blocks counted the way the request limit counts them: each one, and each nested one. */
  const count = (list: Json[]): number =>
    list.reduce((n, b) => n + 1 + count(((b[b.type as string] as Json | undefined)?.children as Json[] | undefined) ?? []), 0);

  const store = (list: unknown, depth: number): string[] => {
    if (!Array.isArray(list)) return bad("body.children should be an array.");
    if (depth > 2) bad("body.children nests more than two levels deep in one request.");
    return (list as Json[]).map((b, i) => {
      const type = b.type as string;
      if (!TEXT_BLOCKS.has(type)) bad(`body.children[${i}].type \`${String(type)}\` is not one this fake knows.`);
      const { children, ...body } = (b[type] ?? {}) as Json;
      checkRich(body.rich_text, `body.children[${i}].${type}.rich_text`);
      if (type === "code" && !LANGUAGES.has(body.language as string)) bad(`body.children[${i}].code.language should be a known language.`);
      const id = newId();
      blocks.set(id, { id, type, body, children: children === undefined ? [] : store(children, depth + 1), trashed: false });
      return id;
    });
  };

  const written = (block: Block): Json => ({
    object: "block",
    type: block.type,
    [block.type]: {
      ...block.body,
      ...(block.children.length ? { children: block.children.map((id) => written(blocks.get(id) as Block)) } : {}),
    },
  });

  const writeValues = (row: Row, properties: unknown): void => {
    const db = databaseOf(row.dataSource) as Database;
    for (const [name, value] of Object.entries((properties ?? {}) as Json)) {
      const prop = db.schema[name];
      if (!prop) bad(`${name} is not a property that exists.`);
      const type = (prop as { type: string }).type;
      row.values[name] = checkRich((value as Json)[type], `body.properties.${name}.${type}`);
    }
  };

  /** One page of a list, by the cursor the last page handed out. */
  const paged = <T>(all: T[], size: number, cursor: string | null): Json => {
    if (!Number.isInteger(size) || size < 1 || size > MAX_ARRAY) bad(`page_size should be ≤ \`${MAX_ARRAY}\`.`);
    const start = cursor === null ? 0 : Number(cursor);
    const results = all.slice(start, start + size);
    const more = start + size < all.length;
    return { object: "list", results, has_more: more, next_cursor: more ? String(start + size) : null };
  };

  const route = (method: string, url: URL, body: Json | undefined): Json => {
    const parts = url.pathname.replace(/^\/v1\//, "").split("/").map(decodeURIComponent);
    const [kind, rawId = "", sub, prop] = parts;
    const id = flat(rawId);
    const size = Number(url.searchParams.get("page_size") ?? 100);
    const cursor = url.searchParams.get("start_cursor");
    if (!shared && !(kind === "pages" && method === "POST")) notFound(rawId);

    if (kind === "pages" && method === "GET" && sub === undefined) {
      if (id === parent) return { object: "page", id: dashed(parent), url: urlOf(parent), parent: { type: "workspace", workspace: true }, properties: {} };
      const row = rows.get(id);
      if (!row || row.trashed) return notFound(rawId);
      return rowJson(row);
    }
    if (kind === "pages" && method === "GET" && sub === "properties") {
      const row = rows.get(id);
      if (!row || row.trashed) return notFound(rawId);
      const db = databaseOf(row.dataSource) as Database;
      const entry = Object.entries(db.schema).find(([, p]) => decodeURIComponent(p.id) === prop);
      if (!entry) return notFound(prop ?? "");
      const [name, { id: pid, type }] = entry;
      const items = (row.values[name] ?? []).map((item) => ({ object: "property_item", id: pid, type, [type]: answered(item) }));
      return { ...paged(items, size, cursor), type: "property_item", property_item: { id: pid, next_url: null, type, [type]: {} } };
    }
    if (kind === "pages" && method === "POST") {
      const target = (body?.parent as Json | undefined)?.data_source_id;
      const db = typeof target === "string" ? databaseOf(flat(target)) : undefined;
      if (!shared || !db) return notFound(String(target));
      const row: Row = { id: newId(), dataSource: db.dataSource, values: {}, children: [], trashed: false };
      writeValues(row, body?.properties);
      if (body?.children !== undefined) row.children = store(body.children, 1);
      rows.set(row.id, row);
      return rowJson(row);
    }
    if (kind === "pages" && method === "PATCH") {
      const row = rows.get(id);
      if (!row || row.trashed) return notFound(rawId);
      writeValues(row, body?.properties);
      if (body?.in_trash === true) row.trashed = true;
      return rowJson(row);
    }
    if (kind === "blocks" && sub === "children" && method === "GET") {
      const live = childrenOf(id).flatMap((c) => {
        const db = databases.get(c);
        if (db) return [{ object: "block", id: dashed(db.id), type: "child_database", child_database: { title: plain(db.title) }, has_children: false }];
        const block = blocks.get(c);
        return block && !block.trashed ? [blockJson(block)] : [];
      });
      return paged(live, size, cursor);
    }
    if (kind === "blocks" && sub === "children" && method === "PATCH") {
      const list = body?.children;
      if (!Array.isArray(list)) return bad("body.children should be an array.");
      const n = count(list as Json[]);
      if (n > MAX_ARRAY) bad(`body.children.length should be ≤ \`${MAX_ARRAY}\`, instead was \`${n}\`.`);
      const target = childrenOf(id);
      const added = store(list, 1);
      target.push(...added);
      return { object: "list", results: added.map((a) => blockJson(blocks.get(a) as Block)), has_more: false, next_cursor: null };
    }
    if (kind === "blocks" && method === "DELETE" && sub === undefined) {
      const block = blocks.get(id);
      if (!block || block.trashed) return notFound(rawId);
      block.trashed = true;
      return { ...blockJson(block), in_trash: true };
    }
    if (kind === "databases" && method === "POST") {
      const page = (body?.parent as Json | undefined)?.page_id;
      if (typeof page !== "string" || flat(page) !== parent) return notFound(String(page));
      const title = checkRich(body?.title ?? [], "body.title");
      const initial = (body?.initial_data_source as Json | undefined)?.properties;
      if (initial === undefined || initial === null) return bad("body.initial_data_source.properties should be defined.");
      return databaseJson(createDatabase(title, initial as Json));
    }
    if (kind === "databases" && sub === undefined) {
      const db = databases.get(id);
      if (!db) return notFound(rawId);
      if (method === "PATCH" && body?.title !== undefined) db.title = checkRich(body.title, "body.title");
      return databaseJson(db);
    }
    if (kind === "data_sources" && sub === "query" && method === "POST") {
      const db = databaseOf(id);
      if (!db) return notFound(rawId);
      const filter = body?.filter as { property?: string; title?: { equals?: string } } | undefined;
      if (filter && filter.property !== titleName(db)) bad(`Could not find property with name or id: ${String(filter.property)}`);
      const wanted = filter?.title?.equals;
      const found = rowsOf(db.dataSource).filter((r) => wanted === undefined || plain(r.values[titleName(db)] ?? []) === wanted);
      return paged(found.map(rowJson), Number(body?.page_size ?? 100), (body?.start_cursor as string | undefined) ?? null);
    }
    return bad(`${method} ${url.pathname} is not an endpoint this fake knows.`);
  };

  const fetchImpl = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Json) : undefined;
    const request: FakeRequest = { method, path: `${url.pathname.replace(/^\/v1/, "")}${url.search}`, body };
    requests.push(request);
    const headers = new Headers(init?.headers);
    const answer = (status: number, json: Json, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json", ...extra } });
    const error = (status: number, code: string, message: string, extra: Record<string, string> = {}) =>
      answer(status, { object: "error", status, code, message }, extra);

    if (url.origin !== "https://api.notion.com" || !url.pathname.startsWith("/v1/")) return error(404, "invalid_request_url", "Invalid request URL.");
    if (headers.get("authorization") !== `Bearer ${token}`) return error(401, "unauthorized", "API token is invalid.");
    if (headers.get("notion-version") !== VERSION) return error(400, "missing_version", `Notion-Version should be ${VERSION}.`);
    if (failure?.match(request) && failure.times > 0) {
      failure.times--;
      return failure.status === 429
        ? error(429, "rate_limited", "You have been rate limited. Please try again in a few minutes.", { "retry-after": failure.retryAfter })
        : error(failure.status, "internal_server_error", "Unexpected error occurred.");
    }
    try {
      return answer(200, route(method, url, body));
    } catch (e) {
      if (e instanceof NotionError) return error(e.status, e.code, e.message);
      throw e;
    }
  }) as typeof fetch;

  return {
    fetchImpl,
    token,
    parent,
    requests,
    rows: () => [...rows.values()].filter((r) => !r.trashed).map((r) => {
      const db = databaseOf(r.dataSource) as Database;
      return {
        id: dashed(r.id),
        url: urlOf(r.id),
        ticket: plain(r.values[titleName(db)] ?? []),
        source: r.values.Source ?? [],
        blocks: r.children.flatMap((c) => {
          const block = blocks.get(c);
          return block && !block.trashed ? [written(block)] : [];
        }),
      };
    }),
    databases: () => parentChildren.flatMap((c) => {
      const db = databases.get(c);
      return db ? [{ id: dashed(db.id), title: plain(db.title) }] : [];
    }),
    seedDatabase: (title = "Landrace specs") =>
      dashed(createDatabase([{ type: "text", text: { content: title } }], { Ticket: { title: {} }, Source: { rich_text: {} } }).id),
    seedRow: (ticket, source) => {
      const db = [...databases.values()][0];
      if (!db) throw new Error("seed a database before its rows");
      const row: Row = {
        id: newId(), dataSource: db.dataSource, children: [], trashed: false,
        values: {
          [titleName(db)]: [{ type: "text", text: { content: ticket } }],
          Source: source.map((content) => ({ type: "text", text: { content } })),
        },
      };
      rows.set(row.id, row);
      return dashed(row.id);
    },
    failOn: (match, status, { times = Infinity, retryAfter = "0" } = {}) => {
      failure = { match, status, times, retryAfter };
    },
    unshare: () => {
      shared = false;
    },
  };
}
