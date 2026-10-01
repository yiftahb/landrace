/*
 * Notion's REST client: the token, the API version, waiting out a rate limit,
 * and following a cursor to the end of a list. Which endpoints a docs role
 * calls is `pages.ts`'s.
 */
import type { RuntimeContext } from "landrace/hooks";

export interface NotionOptions {
  /** An internal integration's secret, which the parent page is shared with. */
  token: string;
  fetchImpl?: typeof fetch | undefined;
}

const API = "https://api.notion.com/v1";

/**
 * The version every request names. Pinned, never "latest": 2025-09-03 is the
 * one where a database holds data sources and rows belong to one of those,
 * and every shape `pages.ts` reads is that version's.
 */
const VERSION = "2025-09-03";

/**
 * Notion allows about three requests a second and answers a burst with a 429.
 * Replacing a page's body deletes it a block at a time, so a burst is the
 * ordinary case, not an outage: it is waited out, as long as Notion says, up
 * to five tries in all.
 */
const TRIES = 5;

/** A list as every paginated endpoint answers it. */
interface Listing<T> {
  results?: T[];
  has_more?: boolean;
  next_cursor?: string | null;
}

/** A 401 is Notion refusing the token itself, before any page or capability enters into it. */
export function tokenRejected(e: unknown): Error | null {
  return (e as { status?: unknown } | null)?.status === 401
    ? new Error("token was rejected by Notion (401) — check that it is the integration's secret and has not been revoked")
    : null;
}

export function createClient(opts: NotionOptions) {
  const doFetch = opts.fetchImpl ?? fetch;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const res = await doFetch(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${opts.token}`,
          "Notion-Version": VERSION,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (res.status === 429 && attempt < TRIES) {
        // Seconds, per the header; a missing or unreadable one waits one.
        const seconds = Number(res.headers.get("retry-after") ?? NaN);
        await new Promise((resolve) => setTimeout(resolve, (Number.isFinite(seconds) && seconds >= 0 ? seconds : 1) * 1000));
        continue;
      }
      // The status rides on the error, so a 404 is told from the rest by
      // its status rather than by searching text that holds a path.
      if (!res.ok) throw Object.assign(new Error(`${method} ${path} → ${res.status} ${await res.text()}`), { status: res.status });
      return (await res.json()) as T;
    }
  }

  /**
   * Every result of a paginated list, a hundred at a time — a GET pages by
   * query string, a POST by body. A list Notion says has more but gives no
   * cursor for is refused rather than read as the whole of it.
   */
  async function all<T>(method: "GET" | "POST", path: string, body: Record<string, unknown> = {}): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | null = null;
    do {
      const after: string = cursor === null ? "" : `&start_cursor=${encodeURIComponent(cursor)}`;
      const page: Listing<T> = method === "GET"
        ? await call<Listing<T>>("GET", `${path}?page_size=100${after}`)
        : await call<Listing<T>>("POST", path, { ...body, page_size: 100, ...(cursor === null ? {} : { start_cursor: cursor }) });
      if (!Array.isArray(page.results)) throw new Error(`${method} ${path} answered with no list of results`);
      out.push(...page.results);
      if (page.has_more && typeof page.next_cursor !== "string") {
        throw new Error(`${method} ${path} said there was more and gave no cursor to it, so none of it is read as the whole`);
      }
      cursor = page.has_more ? (page.next_cursor as string) : null;
    } while (cursor !== null);
    return out;
  }

  return { call, all };
}

export type Client = ReturnType<typeof createClient>;

/**
 * One client per configuration, built from the `notionToken` secret when a
 * hook first needs it — a hook is handed its secrets, never constructed with
 * them, which is what lets redaction know the value.
 */
const clients = new WeakMap<object, Client>();

export function clientFor(ctx: RuntimeContext): Client {
  const existing = clients.get(ctx.config);
  if (existing) return existing;
  const token = ctx.secrets.get("notionToken");
  if (!token) throw new Error('the Notion integration needs a "notionToken" secret declared in landrace.yaml');
  const client = createClient({ token });
  clients.set(ctx.config, client);
  return client;
}
