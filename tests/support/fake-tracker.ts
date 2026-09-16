import { buildRegistry, type Registry } from "../../src/hooks/load.js";
import { entriesFromComments } from "../../src/conventions.js";
import type { Entry } from "../../src/namespace.js";
import type { RuntimeConfig } from "../../src/config/schema.js";
import type { RuntimeContext } from "../../src/hooks/types.js";
import { githubHooks } from "../../.landrace/hooks/github.js";

/**
 * The shipped GitHub integration, over an in-memory GitHub.
 *
 * The fake is the HTTP boundary, not the hooks: `fetch` is what is replaced,
 * and everything above it — the client, both hooks, the source, the operator,
 * and the loader's own classification of them — is the real code a ticket runs
 * through. A second, hand-written imitation of the hooks would be free to
 * disagree with them, and the place it disagreed would be exactly the place a
 * leak across the boundary stopped being visible.
 */
const REPO = "acme/widgets";
const BOT = "yiftahb";

export interface FakeIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  html_url: string;
  labels: string[];
}

export interface FakeComment {
  id: number;
  body: string;
  created_at: string;
  user: { login: string };
}

export interface FakeTracker {
  registry: Registry;
  /** A context the hooks ignore: they were built with explicit options, not read out of config. */
  ctx: RuntimeContext;
  issues: Map<number, FakeIssue>;
  comments: Map<number, FakeComment[]>;
  /** The login the fake posts under, so what it writes reads back as ours — the relationship the real client has with its token. */
  bot: string;
  labelsOf(ticket: number): string[];
  /** Post as the bot, the way an effect would. */
  say(ticket: number, body: string): FakeComment;
  /** Post as somebody else, the way a person would. */
  sayAs(login: string, ticket: number, body: string, at?: string): FakeComment;
  entriesOf(ticket: number): Entry[];
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

export function createFakeTracker(seed: Array<Partial<FakeIssue>> = []): FakeTracker {
  const issues = new Map<number, FakeIssue>();
  const comments = new Map<number, FakeComment[]>();
  let nextIssue = 1;
  let nextComment = 1000;
  let clock = 0;

  /**
   * Monotonic per issue, the way a real tracker's timestamps are: a comment
   * posted now is never dated before one already on the issue. A bare counter
   * is not enough — a test that seeds a human reply dated later than the
   * counter (the natural way to write "and then a person spoke") would have
   * every comment we posted afterwards sort *before* it, so
   * run.lastEvent.actor stayed "human" for the rest of the run and every
   * human-handback trigger kept firing. That is the fake disagreeing with
   * GitHub, not the engine.
   */
  const at = (issue: number): string => {
    const next = new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString();
    const latest = (comments.get(issue) ?? []).reduce((max, c) => (c.created_at > max ? c.created_at : max), "");
    return latest >= next ? new Date(Date.parse(latest) + 1000).toISOString() : next;
  };

  for (const s of seed) {
    const n = s.number ?? nextIssue++;
    issues.set(n, {
      number: n,
      title: s.title ?? `issue ${n}`,
      body: s.body ?? "",
      state: s.state ?? "open",
      html_url: `https://github.com/${REPO}/issues/${n}`,
      labels: s.labels ?? [],
    });
    nextIssue = Math.max(nextIssue, n + 1);
  }

  const post = (ticket: number, login: string, body: string, when?: string): FakeComment => {
    const comment: FakeComment = { id: nextComment++, body, created_at: when ?? at(ticket), user: { login } };
    comments.set(ticket, [...(comments.get(ticket) ?? []), comment]);
    return comment;
  };

  /** Only the endpoints the hooks actually call, answering the way GitHub does. */
  const fetchImpl = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>);

    if (url.pathname === "/user") return json({ login: BOT });

    const path = url.pathname.replace(`/repos/${REPO}`, "");
    const issueOf = (n: number): FakeIssue | null => issues.get(n) ?? null;

    if (path === "/issues" && method === "GET") {
      const wanted = (url.searchParams.get("labels") ?? "").split(",").filter(Boolean);
      const state = url.searchParams.get("state") ?? "open";
      return json([...issues.values()].filter(
        (i) => i.state === state && wanted.every((l) => i.labels.includes(l)),
      ));
    }

    if (path === "/issues" && method === "POST") {
      const issue: FakeIssue = {
        number: nextIssue,
        title: String(body.title ?? ""),
        body: String(body.body ?? ""),
        state: "open",
        html_url: `https://github.com/${REPO}/issues/${nextIssue}`,
        labels: (body.labels as string[] | undefined) ?? [],
      };
      issues.set(nextIssue++, issue);
      return json(issue);
    }

    const single = /^\/issues\/(\d+)$/.exec(path);
    if (single) {
      const issue = issueOf(Number(single[1]));
      if (!issue) return new Response("Not Found", { status: 404 });
      if (method === "PATCH") Object.assign(issue, body);
      return json(issue);
    }

    const onComments = /^\/issues\/(\d+)\/comments$/.exec(path);
    if (onComments) {
      const n = Number(onComments[1]);
      if (!issueOf(n)) return new Response("Not Found", { status: 404 });
      if (method === "POST") return json(post(n, BOT, String(body.body ?? "")));
      return json(comments.get(n) ?? []);
    }

    const onLabels = /^\/issues\/(\d+)\/labels$/.exec(path);
    if (onLabels && method === "POST") {
      const issue = issueOf(Number(onLabels[1]));
      if (!issue) return new Response("Not Found", { status: 404 });
      issue.labels = [...new Set([...issue.labels, ...((body.labels as string[] | undefined) ?? [])])];
      return json(issue.labels);
    }

    const oneLabel = /^\/issues\/(\d+)\/labels\/(.+)$/.exec(path);
    if (oneLabel && method === "DELETE") {
      const issue = issueOf(Number(oneLabel[1]));
      if (!issue) return new Response("Not Found", { status: 404 });
      const name = decodeURIComponent(oneLabel[2] as string);
      if (!issue.labels.includes(name)) return new Response("Not Found", { status: 404 });
      issue.labels = issue.labels.filter((l) => l !== name);
      return json(issue.labels);
    }

    return new Response(`no route for ${method} ${url.pathname}`, { status: 404 });
  }) as unknown as typeof fetch;

  const hooks = githubHooks({ repo: REPO, token: "test-token", fetchImpl });

  return {
    // Through the real loader, so the brands and the ambiguity rules are
    // exercised on the way in rather than assumed.
    registry: buildRegistry([{ specifier: "hooks/github.ts", exports: hooks as unknown as Record<string, unknown> }]),
    ctx: {
      config: {} as RuntimeConfig,
      secrets: new Map<string, string>(),
      signal: new AbortController().signal,
      log: () => {},
    },
    issues,
    comments,
    bot: BOT,
    labelsOf: (ticket) => issues.get(ticket)?.labels ?? [],
    say: (ticket, body) => post(ticket, BOT, body),
    sayAs: (login, ticket, body, when) => post(ticket, login, body, when),
    entriesOf: (ticket) => entriesFromComments(comments.get(ticket) ?? [], BOT),
  };
}
