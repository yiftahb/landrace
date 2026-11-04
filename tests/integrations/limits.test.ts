import { GitHubIssues } from "landrace/integrations/github";
import { GitLab } from "landrace/integrations/gitlab";
import { Jira } from "landrace/integrations/jira";
import { Notion } from "landrace/integrations/notion";
import { slack } from "landrace/integrations/slack";
import type { NotifyEvent, RuntimeConfig, RuntimeContext } from "#namespace.js";

/*
 * #179: every integration says when a vendor refused it for a limit, through
 * the ctx.log it is handed — each built the way a project's hook file builds
 * it, with no client of its own, so the one its `clientFor(ctx)` makes is the
 * one under test.
 */

type Logged = Array<[string, Record<string, unknown> | undefined]>;

/** A fresh config each time: a client is cached per configuration object. */
function context(secrets: Record<string, string>, tracker: Record<string, unknown> = {}): { ctx: RuntimeContext; logged: Logged } {
  const logged: Logged = [];
  return {
    logged,
    ctx: {
      config: { tracker } as unknown as RuntimeConfig,
      secrets: new Map(Object.entries(secrets)),
      signal: new AbortController().signal,
      log: (name, data) => { logged.push([name, data]); },
    },
  };
}

const limited = (logged: Logged): Logged => logged.filter(([name]) => name === "integration.limited");

const answer = (status: number, headers: Record<string, string> = {}, body = "{}"): Response => new Response(body, { status, headers });

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("integration.limited", () => {
  describe("GitHub", () => {
    const github = () => context({ githubToken: "ghp_test_token_value" }, { repo: "acme/widgets" });

    it("logs a 429 with its Retry-After", async () => {
      jest.spyOn(globalThis, "fetch").mockResolvedValue(answer(429, { "Retry-After": "30" }));
      const { ctx, logged } = github();
      await expect(new GitHubIssues().login(ctx)).rejects.toThrow(/429/);
      expect(limited(logged)).toEqual([
        ["integration.limited", { integration: "github", status: 429, where: "/user", retryAfter: "30" }],
      ]);
    });

    it("logs a 403 that says no requests remain, and not a plain 403", async () => {
      const fetch = jest.spyOn(globalThis, "fetch").mockResolvedValue(answer(403, { "x-ratelimit-remaining": "0" }));
      const spent = github();
      await expect(new GitHubIssues().login(spent.ctx)).rejects.toThrow(/403/);
      expect(limited(spent.logged)).toEqual([["integration.limited", { integration: "github", status: 403, where: "/user" }]]);

      fetch.mockResolvedValue(answer(403, { "x-ratelimit-remaining": "4999" }));
      const plain = github();
      await expect(new GitHubIssues().login(plain.ctx)).rejects.toThrow(/403/);
      expect(limited(plain.logged)).toEqual([]);
    });

    it("logs nothing for an answer that is not a limit", async () => {
      jest.spyOn(globalThis, "fetch").mockResolvedValue(answer(500, { "Retry-After": "30" }));
      const { ctx, logged } = github();
      await expect(new GitHubIssues().login(ctx)).rejects.toThrow(/500/);
      expect(limited(logged)).toEqual([]);
    });
  });

  it("GitLab logs a 429 with its Retry-After", async () => {
    const fetchImpl = (async () => answer(429, { "Retry-After": "30" })) as typeof fetch;
    const { ctx, logged } = context({ gitlabToken: "glpat-test-token" });
    await expect(new GitLab({ project: "group/app", fetchImpl, git: async () => "" }).login(ctx)).rejects.toThrow(/429/);
    expect(limited(logged)).toEqual([
      ["integration.limited", { integration: "gitlab", status: 429, where: "/user", retryAfter: "30" }],
    ]);
  });

  it("Jira logs a 429 with its Retry-After", async () => {
    const fetchImpl = (async () => answer(429, { "Retry-After": "30" })) as typeof fetch;
    const { ctx, logged } = context({ jiraBaseUrl: "https://acme.atlassian.net", jiraEmail: "bot@acme.invalid", jiraToken: "jira-test-token" });
    await expect(new Jira({ project: "KEY", fetchImpl }).login(ctx)).rejects.toThrow(/429/);
    expect(limited(logged)).toEqual([
      ["integration.limited", { integration: "jira", status: 429, where: "/rest/api/3/myself", retryAfter: "30" }],
    ]);
  });

  describe("Notion", () => {
    const PARENT = "0123456789abcdef0123456789abcdef";

    it("logs every 429 it waits out, each with its Retry-After", async () => {
      jest.useFakeTimers();
      const answers = [answer(429, { "Retry-After": "30" }), answer(429, { "Retry-After": "30" })];
      jest.spyOn(globalThis, "fetch").mockImplementation(async () => answers.shift() ?? answer(200, {}, JSON.stringify({ results: [], has_more: false })));
      const { ctx, logged } = context({ notionToken: "secret_notion_test" });

      const done = new Notion({ parent: PARENT }).published(ctx).catch((e: unknown) => e);
      await jest.advanceTimersByTimeAsync(60_000);
      await done;

      const entries = limited(logged);
      expect(entries).toHaveLength(2);
      for (const [, data] of entries) {
        expect(data).toEqual({ integration: "notion", status: 429, where: expect.stringMatching(/^\//), retryAfter: "30" });
      }
    });

    it("logs the last 429 too, the one it gives up on", async () => {
      jest.useFakeTimers();
      jest.spyOn(globalThis, "fetch").mockImplementation(async () => answer(429, { "Retry-After": "1" }));
      const { ctx, logged } = context({ notionToken: "secret_notion_test" });

      const done = new Notion({ parent: PARENT }).published(ctx).catch((e: unknown) => e);
      await jest.advanceTimersByTimeAsync(10_000);
      expect(String(await done)).toMatch(/429/);
      expect(limited(logged)).toHaveLength(5);
    });
  });

  describe("Slack", () => {
    const WEBHOOK = "https://hooks.slack.com/services/T000/B000/secretpart";
    const event: NotifyEvent = {
      event: "needs-you", item: "29", workflow: "fast", workflowName: "Fastlane", title: "Add export",
      link: "https://example.invalid/29", stage: "screened", why: "blocked", board: null,
    };

    it("logs a 429 with its Retry-After, where the webhook is, never its URL", async () => {
      jest.spyOn(globalThis, "fetch").mockResolvedValue(answer(429, { "Retry-After": "30" }, "rate_limited"));
      const { ctx, logged } = context({ slackWebhookUrl: WEBHOOK });
      await expect(slack.send(event, ctx)).rejects.toThrow(/429/);
      expect(limited(logged)).toEqual([
        ["integration.limited", { integration: "slack", status: 429, where: "webhook", retryAfter: "30" }],
      ]);
      expect(JSON.stringify(logged)).not.toContain("secretpart");
    });

    it("logs nothing for another refusal", async () => {
      jest.spyOn(globalThis, "fetch").mockResolvedValue(answer(404, {}, "no_service"));
      const { ctx, logged } = context({ slackWebhookUrl: WEBHOOK });
      await expect(slack.send(event, ctx)).rejects.toThrow(/404/);
      expect(limited(logged)).toEqual([]);
    });
  });
});
