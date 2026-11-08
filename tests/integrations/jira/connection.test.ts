import { jiraConnection } from "landrace/integrations/jira";
import type { RuntimeContext } from "#namespace.js";
import { createFakeJira, EMAIL, PERSON, SITE, TOKEN } from "#tests/integrations/jira/fake-jira.js";

/*
 * #183: who a person is on Jira, looked up by their email through
 * `accountFor`, as `jiraAssignee` is — over the fake Jira Cloud, which the
 * global fetch is pointed at, since a connection builds its client from
 * the context alone.
 */
const SECRETS = { jiraBaseUrl: SITE, jiraEmail: EMAIL, jiraToken: TOKEN };

function world() {
  const fake = createFakeJira();
  jest.spyOn(globalThis, "fetch").mockImplementation(fake.fetchImpl as typeof fetch);
  // A fresh configuration each time: the client is one per configuration.
  const ctx: RuntimeContext = { config: {} as never, secrets: new Map(Object.entries(SECRETS)), signal: new AbortController().signal, log: () => {} };
  return { fake, ctx };
}

afterEach(() => jest.restoreAllMocks());

describe("jiraConnection", () => {
  it("is an identity whose accountId is the one account with the person's email", async () => {
    const { ctx } = world();
    expect(jiraConnection).toMatchObject({ id: "jira", kind: "identity", fields: ["accountId"] });
    await expect(jiraConnection.resolve?.(PERSON.emailAddress ?? "", ctx)).resolves.toEqual({ accountId: PERSON.accountId });
  });

  // #226: Jira Cloud answers a hidden email as "", never by leaving it out; read as another email, the one person the search found was dropped.
  it.each([["empty", ""], ["blank", "  "]])("finds the one account whose email Jira hides as %s", async (_, shown) => {
    const { fake, ctx } = world();
    const hidden = { accountId: "557058:hidden", displayName: "Hila Dor", emailAddress: "hila@acme.example", hidden: shown };
    fake.users.push(hidden);
    const auth = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64")}`;
    const searched = await fake.fetchImpl(`${SITE}/rest/api/3/user/search?query=hila%40acme.example`, { headers: { authorization: auth } });
    expect(await searched.json()).toEqual([expect.objectContaining({ accountId: hidden.accountId, emailAddress: shown })]);
    await expect(jiraConnection.resolve?.(hidden.emailAddress, ctx)).resolves.toEqual({ accountId: hidden.accountId });
  });

  // The filter still drops a shown email other than the one asked for, though the search matched it as a prefix.
  it("keeps the hidden account, not one whose shown email only starts with the query", async () => {
    const { fake, ctx } = world();
    fake.users.push(
      { accountId: "557058:hidden", displayName: "Hila Dor", emailAddress: "hila@acme.example", hidden: "" },
      { accountId: "557058:longer", displayName: "Hila Two", emailAddress: "hila@acme.example.org" },
    );
    await expect(jiraConnection.resolve?.("hila@acme.example", ctx)).resolves.toEqual({ accountId: "557058:hidden" });
  });

  it("refuses two accounts whose emails Jira hides, rather than take the first", async () => {
    const { fake, ctx } = world();
    fake.users.push(
      { accountId: "557058:h1", displayName: "Hila One", emailAddress: "hila@acme.example", hidden: "" },
      { accountId: "557058:h2", displayName: "Hila Two", emailAddress: "hila@acme.example", hidden: "" },
    );
    await expect(jiraConnection.resolve?.("hila@acme.example", ctx)).rejects.toThrow(/matches 2 Jira users: Hila One, Hila Two/);
  });

  it("finds nobody for an email no account has", async () => {
    const { ctx } = world();
    await expect(jiraConnection.resolve?.("nobody@acme.example", ctx)).resolves.toBeNull();
  });

  it("throws Jira's reason when it cannot look anyone up", async () => {
    const { fake, ctx } = world();
    fake.permissions.USER_PICKER = false;
    await expect(jiraConnection.resolve?.(PERSON.emailAddress ?? "", ctx)).rejects.toThrow(/Browse users and groups/);
  });
});
