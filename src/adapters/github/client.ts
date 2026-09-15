import type { Comment, Issue, TrackerPort } from "../types.js";

export function createGitHubTracker(opts: {
  repo: string;
  token: string;
  fetchImpl?: typeof fetch;
}): TrackerPort {
  const { repo, token } = opts;
  const doFetch = opts.fetchImpl ?? fetch;
  if (!/^[^/]+\/[^/]+$/.test(repo)) throw new Error(`repo must be "owner/name", got "${repo}"`);

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`https://api.github.com/repos/${repo}${path}`, {
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
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
    return res.status === 204 ? (null as T) : ((await res.json()) as T);
  }

  return {
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
