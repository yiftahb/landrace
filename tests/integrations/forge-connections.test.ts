import { githubConnection } from "landrace/integrations/github";
import { gitlabConnection } from "landrace/integrations/gitlab";
import type { ConnectionValue, RuntimeConfig, RuntimeContext } from "#namespace.js";

/*
 * #183: a person's own forge token, checked before it is stored by asking
 * the forge who it is — `GET /user` — with it.
 */
const TOKEN = "glpat-or-ghp-person-token-0123";
const value: ConnectionValue = { fields: { token: TOKEN }, source: "paste", connectedAt: "2026-11-04T00:00:00.000Z" };
const ctx = (secrets: Record<string, string> = {}): RuntimeContext => ({
  config: {} as RuntimeConfig, secrets: new Map(Object.entries(secrets)), signal: new AbortController().signal, log: () => {},
});

function forge(status: number, body = "{}") {
  const sent: Array<{ url: string; auth: string | null }> = [];
  jest.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    sent.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  });
  return sent;
}

afterEach(() => jest.restoreAllMocks());

describe.each([
  ["GitHub", githubConnection, "https://api.github.com/user", {}],
  ["GitLab", gitlabConnection, "https://gitlab.com/api/v4/user", {}],
  ["GitLab, self-managed", gitlabConnection, "https://git.acme.example/api/v4/user", { gitlabBaseUrl: "https://git.acme.example" }],
])("%s's connection", (_name, connection, url, secrets) => {
  it("is a pasted credential holding a token", () => {
    expect(connection).toMatchObject({ kind: "credential", fields: ["token"], paste: { hint: expect.any(String) } });
  });

  it("works when the forge answers GET /user with 200", async () => {
    const sent = forge(200, JSON.stringify({ id: 1, login: "dev1", username: "dev1" }));
    await expect(connection.check?.(value, ctx(secrets))).resolves.toBeNull();
    expect(sent).toEqual([{ url, auth: `Bearer ${TOKEN}` }]);
  });

  it("says why when the forge answers 401", async () => {
    forge(401, JSON.stringify({ message: "401 Unauthorized" }));
    await expect(connection.check?.(value, ctx(secrets))).resolves.toMatch(/401/);
  });
});
