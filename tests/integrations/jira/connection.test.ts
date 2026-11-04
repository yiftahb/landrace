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
