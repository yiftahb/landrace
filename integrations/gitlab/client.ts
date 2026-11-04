/*
 * GitLab's REST v4 client: one per configuration and project, so one
 * `GET /user` resolves the login the forge posts as.
 *
 * The token goes in an `Authorization` header to `gitlabBaseUrl` and nowhere
 * else, so that URL is held to one shape — `https://host[:port]` — before any
 * request is built: no cleartext, and no path, userinfo or query a parser
 * could read differently from how it reads here.
 */
import type { RuntimeContext } from "landrace/hooks";
import { httpError, httpLimit } from "landrace/kit";
import type { HttpLimit } from "landrace/kit";

export const DEFAULT_BASE_URL = "https://gitlab.com";

/** GitLab's largest page. */
export const PER_PAGE = 100;

export interface GitLabClientOptions {
  /** The project's full path, "group/app" or "group/subgroup/app". */
  project: string;
  /** The token, or where to read it on each request: one connected with GitLab is renewed every two hours under a client that is kept. */
  token: string | (() => string);
  /** `https://host[:port]`; gitlab.com when absent. */
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  /** Told of each response refused for a limit, with the path below the API it was refused on. */
  onLimit?: ((where: string, limit: HttpLimit) => void) | undefined;
}

/** `https://host[:port]` and nothing more: the token never crosses cleartext, nor a path or credentials the base could smuggle in. */
export const BASE_URL = /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?\/?$/;

/** Segments that never start with a dot, so no ".." can retarget a request after URL normalisation. */
const PROJECT_PATH = /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)+$/;

/** A 401: GitLab rejected the token itself, before any scope or project entered into it. */
export function tokenRejected(e: unknown): Error | null {
  return (e as { status?: unknown } | null)?.status === 401
    ? new Error("token was rejected by GitLab (401) — check that it is valid and not expired")
    : null;
}

export const statusOf = (e: unknown): unknown => (e as { status?: unknown } | null)?.status;

export function createClient(opts: GitLabClientOptions) {
  const { project } = opts;
  const given = opts.token;
  const tokenNow = typeof given === "string" ? (): string => given : given;
  const raw = opts.baseUrl ?? DEFAULT_BASE_URL;
  if (!BASE_URL.test(raw)) throw new Error(`gitlabBaseUrl must be https://host[:port] and nothing more, got "${raw}"`);
  if (!PROJECT_PATH.test(project)) throw new Error(`the GitLab project must be its full path, "group/app", got "${project}"`);
  const baseUrl = raw.replace(/\/$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const here = `/projects/${encodeURIComponent(project)}`;

  // The status rides on the error, so a caller asks "is this a 404?" of a
  // number rather than of text that may quote a path. The message names the
  // path below the API and GitLab's answer, never a header.
  async function request<T>(method: string, path: string, body?: unknown, as: "json" | "text" = "json", root = `${baseUrl}/api/v4`): Promise<T> {
    const res = await doFetch(`${root}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${tokenNow()}`,
        Accept: as === "text" ? "text/plain" : "application/json",
        "User-Agent": "landrace",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const limit = httpLimit(res.status, res.headers);
    if (limit !== null) opts.onLimit?.(path, limit);
    // The body rides too, for a caller that wants GitLab's own `message`.
    if (!res.ok) throw httpError(method, path, res.status, await res.text());
    if (as === "text") return (await res.text()) as T;
    return res.status === 204 ? (null as T) : ((await res.json()) as T);
  }

  const get = <T>(path: string): Promise<T> => request<T>("GET", `${here}${path}`);

  const text = (path: string): Promise<string> => request<string>("GET", `${here}${path}`, undefined, "text");

  // Which account we post as is what tells our markers from a stranger's, so
  // it is asked once and kept: it cannot change under a fixed token.
  let me: { id: number; username: string; admin: boolean } | undefined;
  const user = async (): Promise<{ id: number; username: string; admin: boolean }> => {
    if (me) return me;
    const answer = await request<{ id?: unknown; username?: unknown; is_admin?: unknown } | null>("GET", "/user");
    if (typeof answer?.username !== "string" || answer.username.trim() === "" || typeof answer.id !== "number") {
      throw new Error("GitLab's /user answered with no user");
    }
    me = { id: answer.id, username: answer.username.trim(), admin: answer.is_admin === true };
    return me;
  };

  return {
    project,
    baseUrl,
    /** For the one place it goes besides a request: the push's own header, and scrubbing it from what git says. The one held now. */
    get token(): string {
      return tokenNow();
    },

    /** The token's own user: its id, the login we post as, and whether it administers the instance. */
    user,
    login: async (): Promise<string> => (await user()).username,

    /**
     * The scopes the token itself holds — a personal, project or group access
     * token's. One connected with GitLab is an OAuth token, which that
     * endpoint knows nothing of: its scopes are GitLab's token info instead.
     */
    scopes: async (): Promise<string[]> => {
      const strings = (list: unknown): string[] => (Array.isArray(list) ? list.filter((s): s is string => typeof s === "string") : []);
      let refused: unknown;
      try {
        const self = await request<{ scopes?: unknown } | null>("GET", "/personal_access_tokens/self");
        return strings(self?.scopes);
      } catch (e) {
        if (statusOf(e) !== 404 && statusOf(e) !== 403) throw e;
        refused = e;
      }
      // Not an OAuth token either: what GitLab said of it first is the reason.
      const info = await request<{ scope?: unknown; scopes?: unknown } | null>("GET", "/token/info", undefined, "json", `${baseUrl}/oauth`)
        .catch(() => { throw refused; });
      return strings(info?.scopes ?? info?.scope);
    },

    /** Below the project: `get("/merge_requests/3")`. */
    get,
    /** A read whose answer is text, not JSON: a job's trace. */
    text,
    post: <T>(path: string, body: unknown): Promise<T> => request<T>("POST", `${here}${path}`, body),
    put: <T>(path: string, body: unknown): Promise<T> => request<T>("PUT", `${here}${path}`, body),

    /**
     * Every page of a list below the project, up to `max` of them; `more`
     * says the last one read was full, and a caller that counts refuses then
     * rather than answer a number known to be short.
     *
     * ponytail: a list of exactly `max` full pages reads as `more`; GitLab's
     * `x-next-page` header would tell the two apart if that bound ever bites.
     */
    pages: async <T>(path: string, max: number): Promise<{ items: T[]; more: boolean }> => {
      const items: T[] = [];
      const join = path.includes("?") ? "&" : "?";
      for (let page = 1; page <= max; page++) {
        const batch = await get<unknown>(`${path}${join}per_page=${PER_PAGE}&page=${page}`);
        if (!Array.isArray(batch)) throw new Error(`GitLab answered ${path.split("?")[0]} with no list`);
        items.push(...(batch as T[]));
        if (batch.length < PER_PAGE) return { items, more: false };
      }
      return { items, more: true };
    },
  };
}

export type Client = ReturnType<typeof createClient>;

/**
 * A hook is handed its secrets rather than constructed with them, so the
 * client cannot exist until the first call. One per configuration object —
 * a process loads one — and project.
 */
const clients = new WeakMap<object, Map<string, Client>>();

export function clientFor(ctx: RuntimeContext, project: string, fetchImpl?: typeof fetch): Client {
  const byProject = clients.get(ctx.config) ?? new Map<string, Client>();
  clients.set(ctx.config, byProject);
  const existing = byProject.get(project);
  if (existing) return existing;

  const token = ctx.secrets.get("gitlabToken");
  if (!token) throw new Error('the GitLab integration needs a "gitlabToken" secret declared in landrace.yaml');
  // An empty value is an unset one: the variable it names was blank.
  // Read again on every request: a renewed token is written into the live secrets, and this client outlives it.
  const client = createClient({
    project, token: () => ctx.secrets.get("gitlabToken") || token, baseUrl: ctx.secrets.get("gitlabBaseUrl") || undefined, fetchImpl,
    onLimit: (where, limit) => ctx.log("integration.limited", { integration: "gitlab", where, ...limit }),
  });
  byProject.set(project, client);
  return client;
}
