import type { Comment, Issue, TrackerPort } from "../types.js";

export function createGitHubTracker(opts: {
  repo: string;
  token: string;
  /** Overrides the login resolved from the token, for a GitHub App posting under a bot name. */
  bot?: string;
  fetchImpl?: typeof fetch;
}): TrackerPort {
  const { repo, token } = opts;
  const doFetch = opts.fetchImpl ?? fetch;
  if (!/^[^/]+\/[^/]+$/.test(repo)) throw new Error(`repo must be "owner/name", got "${repo}"`);

  async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await doFetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "landrace",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${await res.text()}`);
    return res.status === 204 ? (null as T) : ((await res.json()) as T);
  }

  const call = <T>(method: string, path: string, body?: unknown): Promise<T> =>
    request<T>(method, `https://api.github.com/repos/${repo}${path}`, body);

  /*
   * Which account we post as is what separates our control markers from a
   * stranger's, so it is resolved once from the token and cached: it cannot
   * change under a fixed token, and every tick reads markers.
   */
  let login = opts.bot?.trim() ?? "";
  async function botLogin(): Promise<string> {
    if (login) return login;
    let user: { login?: string };
    try {
      user = await request<{ login?: string }>("GET", "https://api.github.com/user");
    } catch (e) {
      // Fail closed. A fallback that treated every marker as someone else's
      // would make the engine believe no step had ever run and re-invoke
      // every paid step, forever.
      throw new Error(
        `cannot resolve the account landrace posts as: ${String(e)}. ` +
        `Check the token, or set tracker.bot in landrace.yaml if it is a GitHub App.`,
      );
    }
    const resolved = user?.login?.trim() ?? "";
    if (!resolved) {
      throw new Error(
        "cannot resolve the account landrace posts as: GET /user returned no login. " +
        "Set tracker.bot in landrace.yaml to the name comments are posted under.",
      );
    }
    login = resolved;
    return login;
  }

  return {
    botLogin,
    async listIssues({ labels = [], state = "open" }) {
      const q = new URLSearchParams({ state, per_page: "100" });
      if (labels.length) q.set("labels", labels.join(","));
      const items = await call<Issue[]>("GET", `/issues?${q}`);
      // The issues endpoint returns pull requests too.
      return items.filter((i) => !i.pull_request);
    },
    getIssue: (n) => call<Issue>("GET", `/issues/${n}`),
    createIssue: (fields) => call<Issue>("POST", `/issues`, fields),
    updateIssue: (n, fields) => call<Issue>("PATCH", `/issues/${n}`, fields),
    listComments: (n) => call<Comment[]>("GET", `/issues/${n}/comments?per_page=100`),
    createComment: (n, body) => call<Comment>("POST", `/issues/${n}/comments`, { body }),
    addLabels: async (n, labels) => {
      if (labels.length) await call("POST", `/issues/${n}/labels`, { labels });
    },
    removeLabel: async (n, label) => {
      try {
        await call("DELETE", `/issues/${n}/labels/${encodeURIComponent(label)}`);
      } catch (e) {
        if (!String(e).includes("404")) throw e; // already gone is success
      }
    },
  };
}
