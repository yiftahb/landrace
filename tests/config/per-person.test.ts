import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "#config/load.js";

async function fixture(extra: string, env = ""): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), "landrace-pp-")), ".landrace");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "landrace.yaml"), `version: 1\nagent: { adapter: claude }\n${extra}`);
  await writeFile(join(dir, ".env"), env);
  return dir;
}

const PER_PERSON = "vars: { assignee: { perPerson: true, env: LP_ASSIGNEE_UNSET_X, connection: github.login } }\n";

describe("a per-person key in landrace.yaml", () => {
  it("leaves the string form exactly as it was", async () => {
    const loaded = await loadConfig(await fixture("vars: { who: $LP_WHO }\nsecrets: { tok: $LP_TOK }\n", "LP_WHO=dev\nLP_TOK=abcdefghij\n"));
    expect(loaded.vars).toEqual(new Map([["who", "dev"]]));
    expect(loaded.secretValues).toEqual(new Map([["tok", "abcdefghij"]]));
    expect(loaded.missing).toEqual([]);
    expect(loaded.missingVars).toEqual([]);
    expect(loaded.config.vars).toEqual({ who: "$LP_WHO" });
  });

  it("takes the value of its env variable when it is set", async () => {
    const loaded = await loadConfig(await fixture(
      "vars: { assignee: { perPerson: true, env: LP_ASSIGNEE, connection: github.login } }\n" +
      "secrets: { token: { perPerson: true, env: LP_TOKEN, connection: github.token } }\n",
      "LP_ASSIGNEE=dev1\nLP_TOKEN=tok-123456789\n",
    ));
    expect(loaded.vars.get("assignee")).toBe("dev1");
    expect(loaded.secretValues.get("token")).toBe("tok-123456789");
  });

  it("is never missing in loadConfig: the store, not the env, answers an unset one", async () => {
    const loaded = await loadConfig(await fixture(
      PER_PERSON + "secrets: { token: { perPerson: true, connection: github.token } }\n",
      "LP_ASSIGNEE_UNSET_X=\n",
    ));
    expect(loaded.vars.has("assignee")).toBe(false);
    expect(loaded.secretValues.has("token")).toBe(false);
    expect(loaded.missing).toEqual([]);
    expect(loaded.missingVars).toEqual([]);
  });

  it("refuses an env written as a reference, a literal or anything but a bare variable name", async () => {
    for (const env of ["$LP_X", "${LP_X}", "dev 1", "1ABC"]) {
      await expect(loadConfig(await fixture(`vars: { a: { perPerson: true, env: "${env}", connection: github.login } }\n`)))
        .rejects.toThrow(/vars\.a/);
    }
  });

  it("refuses a connection that is not <id>.<field>, a false perPerson, and an unknown key", async () => {
    for (const value of [
      "{ perPerson: true, connection: github }",
      "{ perPerson: true, connection: github.login.x }",
      "{ perPerson: false, connection: github.login }",
      "{ perPerson: true, connection: github.login, value: dev1 }",
      "{ connection: github.login }",
    ]) {
      await expect(loadConfig(await fixture(`vars: { a: ${value} }\n`))).rejects.toThrow(/vars\.a/);
    }
  });
});
