import { createClient as githubClient } from "landrace/integrations/github";
import { createClient as gitlabClient } from "landrace/integrations/gitlab";
import { createClient as jiraClient } from "landrace/integrations/jira";
import { createClient as notionClient } from "landrace/integrations/notion";
import { gatewayPage } from "#tests/support/http-pages.js";

/*
 * A gateway's error page once reached `landrace start`'s output whole — 40 KB
 * of markup and base64 for one fact, a 504. Each client is driven through its
 * own request, past whatever it asks first (its login, its account), to the
 * call that fails.
 */

type Answer = { status: number; body: string; type: string };
const html = (status: number): Answer => ({ status, body: gatewayPage, type: "text/html" });
const json = (status: number, value: unknown): Answer => ({ status, body: JSON.stringify(value), type: "application/json" });

/** A fetch that answers `first` for the URLs it names and `failure` for everything else. */
function stub(failure: Answer, first: Record<string, unknown> = {}): typeof fetch {
  return (async (input: string | URL): Promise<Response> => {
    const url = String(input);
    for (const [part, value] of Object.entries(first)) {
      if (url.includes(part)) return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(failure.body, { status: failure.status, headers: { "content-type": failure.type } });
  }) as typeof fetch;
}

const clients: Array<[string, (failure: Answer) => Promise<unknown>]> = [
  ["github", (failure) =>
    githubClient({ repo: "o/r", token: "t", fetchImpl: stub(failure, { "/user": { login: "bot" } }) }).graphql("query { viewer { login } }", {})],
  ["gitlab", (failure) =>
    gitlabClient({ project: "group/app", token: "t", fetchImpl: stub(failure) }).get("/merge_requests/1")],
  ["jira", (failure) =>
    jiraClient({ baseUrl: "https://site.atlassian.net", email: "a@b.test", token: "t", fetchImpl: stub(failure, { "/myself": { accountId: "acc" } }) })
      .call("GET", "/rest/api/3/issue/X-1")],
  ["notion", (failure) =>
    notionClient({ token: "t", fetchImpl: stub(failure) }).call("GET", "/pages/p")],
];

const caught = async (p: Promise<unknown>): Promise<Error & { status?: unknown; body?: unknown }> => {
  try {
    await p;
  } catch (e) {
    return e as Error & { status?: unknown; body?: unknown };
  }
  throw new Error("the request did not fail");
};

describe.each(clients)("the %s client's HTTP errors", (_name, run) => {
  it("names a 504 gateway page in a short message, and keeps the page whole on the error", async () => {
    const e = await caught(run(html(504)));
    expect(e.message).toContain("504");
    expect(e.message).not.toMatch(/<|base64/);
    expect(e.message.length).toBeLessThanOrEqual(300);
    expect(e.status).toBe(504);
    expect(e.body).toBe(gatewayPage);
  });

  it("gives a JSON refusal's own message", async () => {
    const e = await caught(run(json(422, { message: "Validation Failed" })));
    expect(e.message).toContain("Validation Failed");
    expect(e.message).not.toContain("{");
    expect(e.status).toBe(422);
  });
});

it("keeps Jira's own words for a 401", async () => {
  const e = await caught(
    jiraClient({ baseUrl: "https://site.atlassian.net", email: "a@b.test", token: "t", fetchImpl: stub(html(401)) }).call("GET", "/rest/api/3/issue/X-1"),
  );
  expect(e.message).toContain("Jira rejected jiraEmail and jiraToken (401)");
});
