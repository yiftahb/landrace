import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "#config/load.js";
import { admits, allowProblems } from "#people/allow.js";

/* #204: who a remote instance admits, by `people.allow`. */
describe("admits", () => {
  it("admits an exact email, whatever its case", () => {
    expect(admits(["ann@example.com"], "ANN@Example.com")).toBe(true);
    expect(admits(["ANN@example.com"], "ann@example.com")).toBe(true);
    expect(admits(["ann@example.com"], "bob@example.com")).toBe(false);
  });

  it("admits @domain by the text after the email's last @, never a subdomain", () => {
    expect(admits(["@example.com"], "ANN@Example.com")).toBe(true);
    expect(admits(["@example.com"], "a@sub.example.com")).toBe(false);
    expect(admits(["@example.com"], "a@notexample.com")).toBe(false);
    expect(admits(["@example.com"], '"a@b"@example.org')).toBe(false);
    expect(admits(["@example.org"], '"a@b"@example.org')).toBe(true);
  });

  it("denies by default: no list, an empty list, no email", () => {
    expect(admits(undefined, "ann@example.com")).toBe(false);
    expect(admits([], "ann@example.com")).toBe(false);
    expect(admits(["@example.com"], undefined)).toBe(false);
    expect(admits(["ann@example.com"], "")).toBe(false);
  });

  it("never admits an email by the local part an entry would match only without its domain", () => {
    expect(admits(["ann@example.com"], "ann@example.com.evil.example")).toBe(false);
  });
});

describe("allowProblems", () => {
  const OIDC = { issuer: "https://id.example.com", clientId: "c", clientSecret: "s" };

  it.each([
    ["absent", undefined],
    ["empty", [] as string[]],
  ])("refuses a remote instance whose people.allow is %s, naming people.allow", (_, allow) => {
    const problems = allowProblems({ oidc: OIDC, ...(allow === undefined ? {} : { allow }) });
    expect(problems).toEqual([{ rule: "people.allow", message: expect.stringContaining("people.allow") }]);
  });

  it("passes a remote instance that lists someone, and any local one", () => {
    expect(allowProblems({ oidc: OIDC, allow: ["@example.com"] })).toEqual([]);
    expect(allowProblems(undefined)).toEqual([]);
    expect(allowProblems({})).toEqual([]);
  });
});

describe("people.allow in landrace.yaml", () => {
  const load = async (allow: string) => {
    const dir = join(await mkdtemp(join(tmpdir(), "landrace-allow-")), ".landrace");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "landrace.yaml"), `version: 1\nagent: { adapter: claude }\npeople: { allow: ${allow} }\n`);
    return loadConfig(dir);
  };

  it.each(['["*"]', '["@"]', '["example.com"]', '["ann@"]', '["a@b@example.com"]', '[" ann@example.com"]'])("refuses %s", async (allow) => {
    await expect(load(allow)).rejects.toThrow(/people\.allow/);
  });

  it("reads emails and @domains as written", async () => {
    expect((await load('["ann@example.com", "@example.com"]')).config.people?.allow).toEqual(["ann@example.com", "@example.com"]);
  });
});
