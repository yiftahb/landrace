import { GRAPHQL_QUERIES } from "#landrace/hooks/github.js";

/**
 * GitHub refuses a query before running it when the nodes it *could* return
 * pass 500,000 — "requests up to 617,100 possible nodes", which is what the
 * issue list once asked for. Nothing in the in-memory GitHub enforces that, so
 * every query the hook sends is costed here with GitHub's own formula: each
 * connection's `first:` times the `first:` of every connection above it,
 * summed over all of them.
 */
const GITHUB_NODE_LIMIT = 500_000;

function worstCaseNodes(query: string): number {
  const stack: number[] = [];
  let pending: number | null = null;
  let total = 0;
  for (let i = 0; i < query.length; i++) {
    const c = query[i];
    if (c === "(") {
      const close = query.indexOf(")", i);
      const first = /\bfirst:\s*(\d+)/.exec(query.slice(i, close));
      pending = first?.[1] === undefined ? null : Number(first[1]);
      i = close;
    } else if (c === "{") {
      const multiplier = pending ?? 1;
      if (pending !== null) total += stack.reduce((a, b) => a * b, 1) * pending;
      stack.push(multiplier);
      pending = null;
    } else if (c === "}") {
      stack.pop();
    } else if (c !== undefined && /[A-Za-z_]/.test(c)) {
      // A field between an argument list and a brace means the arguments
      // belonged to a scalar, not to the selection that follows.
      pending = null;
    }
  }
  return total;
}

describe("GitHub query cost", () => {
  it("costs a query the way GitHub does", () => {
    // issues 100 + labels 100·100 + assignees 100·20 + subIssues 100·50
    // + their labels 100·50·100 + their assignees 100·50·20: the query
    // GitHub refused, and the figure it refused it with.
    const refused = `query { repository(owner: "o", name: "n") {
      issues(states: OPEN, first: 100) { nodes {
        labels(first: 100) { nodes { name } }
        assignees(first: 20) { nodes { login } }
        subIssues(first: 50) { nodes {
          labels(first: 100) { nodes { name } }
          assignees(first: 20) { nodes { login } } } } } } } }`;
    expect(worstCaseNodes(refused)).toBe(617_100);
  });

  it.each(Object.entries(GRAPHQL_QUERIES))("%s stays under GitHub's node limit", (_name, query) => {
    expect(worstCaseNodes(query)).toBeLessThan(GITHUB_NODE_LIMIT);
  });

  it("costs every query the hook sends", () => {
    expect(Object.keys(GRAPHQL_QUERIES).sort()).toEqual(
      ["BRIEF_QUERY", "CLOSED_PULLS_QUERY", "CLOSED_QUERY", "ISSUES_QUERY", "ISSUE_QUERY", "PREFLIGHT_PR_QUERY", "PULLS_QUERY", "RESOLVE_THREAD", "THREADS_QUERY", "TICKET_QUERY"]);
  });
});
