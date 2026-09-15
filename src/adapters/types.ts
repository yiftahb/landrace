/**
 * What the engine and the operator tools need from a tracker. GitHub is one
 * implementation; nothing outside `src/adapters/` may depend on which one.
 */
export interface Issue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  labels: Array<string | { name?: string }>;
  pull_request?: unknown;
}

export interface Comment {
  id: number;
  body: string;
  created_at: string;
  user?: { login?: string } | null;
}

export interface TrackerPort {
  listIssues(query: { labels?: string[]; state?: string }): Promise<Issue[]>;
  getIssue(n: number): Promise<Issue>;
  createIssue(fields: { title: string; body?: string; labels?: string[] }): Promise<Issue>;
  updateIssue(n: number, fields: { title?: string; body?: string; state?: string }): Promise<Issue>;
  listComments(n: number): Promise<Comment[]>;
  createComment(n: number, body: string): Promise<Comment>;
  addLabels(n: number, labels: string[]): Promise<void>;
  removeLabel(n: number, label: string): Promise<void>;
}

export const labelNames = (issue: Issue): string[] =>
  (issue.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean);
