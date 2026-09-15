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
  // [^/] also admitted "?", "#", "%2F" and "@": `repo: "o/n#x"` silently
  // retargeted every request at /repos/o/n. The host is pinned, so this was
  // never cross-host, but a request should go where the config says.
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    throw new Error(`repo must be "owner/name", got "${repo}"`);
  }

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
  const configured = opts.bot?.trim() ?? "";
  let login = "";

  async function botLogin(): Promise<string> {
    if (login) return login;

    // Asked even when tracker.bot is set. A GitHub App's installation token
    // resolves to that app's own bot user, so a legitimate override matches
    // and only a typo differs — and an unverified typo switched the whole
    // authorship guard off: our own output stopped counting as ours and every
    // paid step was re-invoked, forever.
    let resolved = "";
    let failure = "";
    try {
      const user = await request<unknown>("GET", "https://api.github.com/user");
      const candidate = (user as { login?: unknown } | null)?.login;
      // Shape-checked inside the guarded path: a non-string login used to
      // throw a TypeError past this handler, so the operator saw
      // "login.trim is not a function" instead of what to do about it.
      if (typeof candidate === "string" && candidate.trim()) resolved = candidate.trim();
      else failure = "GET /user returned no login";
    } catch (e) {
      failure = String(e);
    }

    if (configured) {
      if (resolved && resolved.toLowerCase() !== configured.toLowerCase()) {
        throw new Error(
          `tracker.bot is "${configured}" but this token posts as "${resolved}". ` +
          "One of the two is wrong, and a login that is not the one we post under makes " +
          "our own comments read as a stranger's — every step would be re-invoked forever.",
        );
      }
      // Matched, or /user could not answer at all: the second is the case the
      // override exists for.
      login = configured;
      return login;
    }

    if (!resolved) {
      // Fail closed. A fallback that treated every marker as someone else's
      // would make the engine believe no step had ever run.
      throw new Error(
        `cannot resolve the account landrace posts as: ${failure}. ` +
        "Check the token, or set tracker.bot in landrace.yaml if it is a GitHub App.",
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
