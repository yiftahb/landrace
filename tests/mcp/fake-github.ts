import type { Comment, Issue, TrackerAdapter, TrackerPort } from "../../src/adapters/index.js";
import { entriesFromComments } from "../../src/adapters/github/index.js";

/** An in-memory tracker implementing the same interface the real client does. */
function createFakeTracker(seed: Array<Partial<Issue>> = []): TrackerPort & {
  issues: Map<number, Issue>;
  comments: Map<number, Comment[]>;
} {
  const issues = new Map<number, Issue>();
  const comments = new Map<number, Comment[]>();
  let nextIssue = 1;
  let nextComment = 1000;
  let clock = 0;
  const at = () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString();

  for (const s of seed) {
    const n = s.number ?? nextIssue++;
    issues.set(n, {
      number: n, title: s.title ?? `issue ${n}`, body: s.body ?? "", state: s.state ?? "open",
      html_url: `https://github.com/acme/widgets/issues/${n}`, labels: s.labels ?? [],
    });
    nextIssue = Math.max(nextIssue, n + 1);
  }

  const must = (n: number): Issue => {
    const i = issues.get(n);
    if (!i) throw new Error(`GET /issues/${n} → 404`);
    return i;
  };
  const names = (i: Issue): string[] =>
    i.labels.map((l) => (typeof l === "string" ? l : (l.name ?? "")));

  return {
    issues,
    comments,
    async listIssues({ labels = [], state = "open" }) {
      return [...issues.values()].filter(
        (i) => i.state === state && labels.every((l) => names(i).includes(l)),
      );
    },
    async getIssue(n) { return must(n); },
    async createIssue({ title, body = "", labels = [] }) {
      const n = nextIssue++;
      const issue: Issue = { number: n, title, body, state: "open", html_url: `https://github.com/acme/widgets/issues/${n}`, labels };
      issues.set(n, issue);
      return issue;
    },
    async updateIssue(n, fields) {
      const issue = { ...must(n), ...fields } as Issue;
      issues.set(n, issue);
      return issue;
    },
    async listComments(n) { must(n); return comments.get(n) ?? []; },
    async createComment(n, body) {
      must(n);
      const c: Comment = { id: nextComment++, body, created_at: at(), user: { login: "yiftahb" } };
      comments.set(n, [...(comments.get(n) ?? []), c]);
      return c;
    },
    async addLabels(n, labels) {
      const issue = must(n);
      issue.labels = [...new Set([...names(issue), ...labels])];
    },
    async removeLabel(n, label) {
      const issue = must(n);
      issue.labels = names(issue).filter((l) => l !== label);
    },
  };
}

/**
 * The same adapter shape the operator tools consume, backed by memory. Using the
 * real adapter interface is the point: a fake that implements something narrower
 * would let a leak through the boundary go unnoticed.
 */
export function createFakeGitHub(
  seed: Array<Partial<Issue>> = [],
): TrackerAdapter & TrackerPort & { issues: Map<number, Issue>; comments: Map<number, Comment[]> } {
  const tracker = createFakeTracker(seed);
  return {
    ...tracker,
    id: "fake",
    tracker,
    pre: { id: "fake", run: () => ({}) },
    post: { id: "fake", handles: [], satisfied: () => false, apply: async () => {} },
    entriesOf: async (n) => entriesFromComments(await tracker.listComments(n)),
  };
}
