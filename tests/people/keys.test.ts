import { runtimeConfigSchema } from "#config/schema.js";
import { perPersonKeys } from "#people/keys.js";

const config = (extra: Record<string, unknown>) => runtimeConfigSchema.parse({ version: 1, agent: { adapter: "claude" }, ...extra });

describe("perPersonKeys", () => {
  it("is none for string-form secrets and vars", () => {
    expect(perPersonKeys(config({ vars: { a: "$A" }, secrets: { b: "$B" } }))).toEqual([]);
  });

  it("is each object-form key, in which map, with its env and its connection split into id and field", () => {
    expect(perPersonKeys(config({
      vars: { plain: "x", assignee: { perPerson: true, env: "LANDRACE_ASSIGNEE", connection: "forge.login" } },
      secrets: { token: { perPerson: true, connection: "forge.token" } },
    }))).toEqual([
      { section: "secrets", name: "token", connection: "forge", field: "token" },
      { section: "vars", name: "assignee", env: "LANDRACE_ASSIGNEE", connection: "forge", field: "login" },
    ]);
  });
});
