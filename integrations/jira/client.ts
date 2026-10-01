/*
 * Jira Cloud's REST client: one per configuration, basic auth with the
 * account's email and API token, and `GET /myself` before anything else.
 *
 * A marker counts as control state only because *we* wrote it, so no request
 * goes out until the account it is written as is known.
 */
import type { RuntimeContext } from "landrace/hooks";

export interface ClientOptions {
  baseUrl: string;
  email: string;
  token: string;
  fetchImpl?: typeof fetch | undefined;
}

/**
 * A Jira Cloud site and nothing else. Basic auth carries the account's own
 * API token — every project it can see, not one — so it goes only to an
 * Atlassian host over TLS: a typo'd or pasted URL is refused, not sent the
 * token. No path either, since every request's path is ours.
 */
const SITE = /^https:\/\/[a-z0-9][a-z0-9-]*\.atlassian\.net$/i;

const SECRETS = ["jiraBaseUrl", "jiraEmail", "jiraToken"] as const;

/** A 404 from Jira, told apart from every other failure by its status rather than by its text. */
export const isMissing = (e: unknown): boolean => (e as { status?: unknown } | null)?.status === 404;

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createClient(opts: ClientOptions) {
  const baseUrl = opts.baseUrl.trim().replace(/\/$/, "");
  if (!SITE.test(baseUrl)) throw new Error(`jiraBaseUrl must be https://<site>.atlassian.net, got "${baseUrl}"`);
  const doFetch = opts.fetchImpl ?? fetch;
  const authorization = `Basic ${Buffer.from(`${opts.email}:${opts.token}`).toString("base64")}`;

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: authorization,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    // The status rides on the error, so "is this a 404?" is never a search of the message.
    if (!res.ok) {
      throw Object.assign(
        new Error(res.status === 401
          ? "Jira rejected jiraEmail and jiraToken (401): check both, and that the token has not expired"
          : `${method} ${path} → ${res.status} ${text}`),
        { status: res.status },
      );
    }
    // 204 for an edit or a transition: nothing to read.
    return (text === "" ? null : JSON.parse(text)) as T;
  }

  /*
   * Which account we post as is what separates our markers from a stranger's,
   * so it is resolved once and cached: it cannot change under a fixed token.
   * Its `accountId` — unique and stable, where a display name is neither.
   */
  let accountId = "";

  async function myself(): Promise<string> {
    if (accountId) return accountId;
    let me: { accountId?: unknown } | null;
    try {
      me = await request<{ accountId?: unknown } | null>("GET", "/rest/api/3/myself");
    } catch (e) {
      throw new Error(`cannot resolve the account landrace posts as: ${messageOf(e)}`);
    }
    // Fail closed: a fallback that read every marker as someone else's would
    // make the engine believe no step had ever run, and pay for each again.
    if (typeof me?.accountId !== "string" || me.accountId === "") {
      throw new Error("cannot resolve the account landrace posts as: /myself answered no accountId");
    }
    accountId = me.accountId;
    return accountId;
  }

  return {
    baseUrl,
    myself,
    /** A request to the site, after the account it is made as is known. */
    call: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      await myself();
      return request<T>(method, path, body);
    },
  };
}

export type Client = ReturnType<typeof createClient>;

/**
 * A hook is handed its secrets rather than constructed with them — that is
 * what lets the log redact them — so the client cannot exist until the first
 * call. One per configuration object, which a process loads once, so the
 * account is resolved once.
 */
const clients = new WeakMap<object, Client>();

export function clientFor(ctx: RuntimeContext, fetchImpl?: typeof fetch): Client {
  const existing = clients.get(ctx.config);
  if (existing) return existing;
  const missing = SECRETS.filter((name) => !ctx.secrets.get(name)?.trim());
  if (missing.length > 0) {
    throw new Error(`the Jira integration needs ${missing.map((n) => `"${n}"`).join(", ")} declared under secrets in landrace.yaml`);
  }
  const secret = (name: (typeof SECRETS)[number]): string => (ctx.secrets.get(name) ?? "").trim();
  const client = createClient({ baseUrl: secret("jiraBaseUrl"), email: secret("jiraEmail"), token: secret("jiraToken"), fetchImpl });
  clients.set(ctx.config, client);
  return client;
}
