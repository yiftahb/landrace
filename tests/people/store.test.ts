import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CREDENTIALS_DENY } from "#kit/executor.js";
import { randomBytes } from "node:crypto";
import { createCredentialStore, credentialValues } from "#people/store.js";
import { createSealedFiles } from "#people/sealed.js";
import type { ConnectionValue, Person } from "#namespace.js";

const root = async (): Promise<string> => join(await mkdtemp(join(tmpdir(), "landrace-creds-")), "credentials");
const ME: Person = { id: "local", email: "dev1@example.invalid" };
const github: ConnectionValue = { fields: { login: "dev1", token: "ghp_abcdefghijkl" }, source: "paste", connectedAt: "2026-11-01T00:00:00.000Z" };
const jira: ConnectionValue = {
  fields: { account: "a1" }, source: "oauth", connectedAt: github.connectedAt,
  expiresAt: "2027-11-01T00:00:00.000Z", failedAt: "2026-11-02T00:00:00.000Z", failure: "revoked", refresh: { token: "refresh_abcdefgh" },
};

describe("the credential store", () => {
  it("keeps its default root where every run is denied reading", () => {
    expect(createCredentialStore().root).toBe(join(homedir(), CREDENTIALS_DENY.slice(2)));
  });

  it("reads a person with no file as having connected nothing", async () => {
    const store = createCredentialStore(await root());
    expect(await store.read("local")).toEqual({ person: { id: "local" }, connections: {} });
    expect(await store.list()).toEqual([]);
  });

  it("round-trips a connection with every key it may hold, in a 0600 file under a 0700 directory", async () => {
    const dir = await root();
    const store = createCredentialStore(dir);
    await store.put("local", ME, "github", github);
    expect(await store.read("local")).toEqual({ person: ME, connections: { github } });
    expect((await stat(join(dir, "local.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    await store.put("local", ME, "jira", jira);
    await store.remove("local", "github");
    expect(await store.read("local")).toEqual({ person: ME, connections: { jira } });
    expect(await store.list()).toEqual([ME]);
  });

  // #187: a person who signed in is in the store, connected or not, so the next start runs for them.
  it("remembers a person who has connected nothing, and their new name, keeping what they connected", async () => {
    const dir = await root();
    const store = createCredentialStore(dir);
    const alice: Person = { id: "sub-alice", email: "alice@example.invalid" };
    await store.remember(alice);
    expect(await store.list()).toEqual([alice]);
    expect((await stat(join(dir, "sub-alice.json"))).mode & 0o777).toBe(0o600);
    await store.put(alice.id, alice, "github", github);
    await store.remember({ ...alice, name: "Alice" });
    expect(await store.read(alice.id)).toEqual({ person: { ...alice, name: "Alice" }, connections: { github } });
  });

  it("keeps a pause beside the person's connections, from a fresh store too, and clears it", async () => {
    const dir = await root();
    const store = createCredentialStore(dir);
    await store.put("local", ME, "github", github);

    await store.pause(ME, "2026-11-08T10:00:00.000Z");

    // Another store over the same root: what a restart reads.
    const again = createCredentialStore(dir);
    expect(await again.read("local")).toEqual({ person: ME, connections: { github }, paused: { at: "2026-11-08T10:00:00.000Z" } });
    await again.pause(ME, null);
    expect(await store.read("local")).toEqual({ person: ME, connections: { github } });
  });

  it("pauses a person who has no file yet, making one with no connections", async () => {
    const store = createCredentialStore(await root());
    await store.pause(ME, "2026-11-08T10:00:00.000Z");
    expect(await store.read("local")).toEqual({ person: ME, connections: {}, paused: { at: "2026-11-08T10:00:00.000Z" } });
  });

  it("reads a pause whose time is not one as a problem", async () => {
    const dir = await root();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "local.json"), JSON.stringify({ person: { id: "local" }, connections: {}, paused: { at: "soon" } }));
    expect((await createCredentialStore(dir).read("local")).problem).toMatch(/paused\.at: must be an ISO 8601 time/);
  });

  it("refuses to store one person under another's id", async () => {
    await expect(createCredentialStore(await root()).put("other", ME, "github", github)).rejects.toThrow(/"local".*"other"/);
  });

  it("tightens a directory that already exists wider than 0700", async () => {
    const dir = await root();
    await mkdir(dir, { mode: 0o755 });
    await createCredentialStore(dir).put("local", ME, "github", github);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("reads a corrupt file as no connections and a problem, lists its person by id, and will not write over it", async () => {
    const dir = await root();
    await mkdir(dir, { recursive: true });
    const bad = [
      ["broken", "{ not json"],
      ["shaped", JSON.stringify({ person: { id: "shaped" }, connections: { github: { fields: { login: 7 }, source: "paste", connectedAt: github.connectedAt } } })],
      ["old", JSON.stringify({ person: { id: "old" }, connections: { github: { values: { login: "x" }, connectedAt: github.connectedAt } } })],
      ["source", JSON.stringify({ person: { id: "source" }, connections: { github: { ...github, source: "guess" } } })],
    ] as const;
    for (const [person, text] of bad) {
      await writeFile(join(dir, `${person}.json`), text);
      const read = await createCredentialStore(dir).read(person);
      expect(read).toEqual({ person: { id: person }, connections: {}, problem: expect.stringMatching(new RegExp(`${person}\\.json`)) });
    }
    const store = createCredentialStore(dir);
    expect(await store.list()).toEqual([{ id: "broken" }, { id: "old" }, { id: "shaped" }, { id: "source" }]);
    await expect(store.put("broken", { id: "broken" }, "github", github)).rejects.toThrow(/broken\.json/);
    await expect(store.remove("broken", "github")).rejects.toThrow(/broken\.json/);
    expect(await readFile(join(dir, "broken.json"), "utf8")).toBe("{ not json");
  });

  /*
   * #209: Node's JSON.parse message quotes the text around the fault, and a
   * zod enum issue quotes the value it received — either can be part of a
   * token, and the problem is shown on the board and printed at start.
   */
  it("names the file and says it is not JSON, or which keys are wrong, never quoting what the file holds", async () => {
    const dir = await root();
    await mkdir(dir, { recursive: true });
    const token = "ghp_TOKENLIKE0123456789abcdef";
    const cases = [
      ["broken", `{"person":{"id":"broken"},"connections":{"github":{"fields":{"token":"${token}" oops}}}}`, /broken\.json is not JSON$/],
      ["enum", JSON.stringify({ person: { id: "enum" }, connections: { github: { ...github, source: token } } }), /enum\.json is not a credentials file: connections\.github\.source/],
      ["typed", JSON.stringify({ person: { id: "typed" }, connections: { github: { ...github, connectedAt: token } } }), /typed\.json is not a credentials file: connections\.github\.connectedAt/],
      ["other", JSON.stringify({ person: { id: token }, connections: {} }), /other\.json names another person, not "other"$/],
    ] as const;
    for (const [person, text, said] of cases) {
      await writeFile(join(dir, `${person}.json`), text);
      const { problem } = await createCredentialStore(dir).read(person);
      expect(problem).toMatch(said);
      expect(problem).not.toContain(token.slice(4, 14));
      expect(problem).not.toContain("oops");
    }
  });

  it("keeps any person id inside the root, encoded, and refuses an empty one", async () => {
    const dir = await root();
    const store = createCredentialStore(dir);
    for (const id of ["../x", "a/b", "..", "dev@example.com"]) await store.put(id, { id }, "github", github);
    expect((await readdir(dir)).sort()).toEqual(["..%2Fx.json", "...json", "a%2Fb.json", "dev%40example.com.json"]);
    expect((await store.list()).map((p) => p.id)).toEqual(["..", "../x", "a/b", "dev@example.com"]);
    expect(await store.read("a/b")).toEqual({ person: { id: "a/b" }, connections: { github } });
    await expect(store.read("")).rejects.toThrow(/person id/);
  });
});

describe("the credential store, sealed", () => {
  // A throwaway key, made for this test alone.
  const key = (): Uint8Array => new Uint8Array(randomBytes(32));

  it("keeps no token byte on disk, and round-trips every connection", async () => {
    const dir = await root();
    const store = createCredentialStore(dir, key());
    await store.put("local", ME, "jira", jira);
    await store.put("local", ME, "github", github);
    const disk = await readFile(join(dir, "local.json"), "utf8");
    for (const secret of ["ghp_abcdefghijkl", "refresh_abcdefgh", "dev1"]) expect(disk).not.toContain(secret);
    expect((JSON.parse(disk) as { landrace: string }).landrace).toBe("sealed");
    expect(await store.read("local")).toEqual({ person: ME, connections: { github, jira } });
    expect(await store.list()).toEqual([ME]);
  });

  it("reads a file copied over another person's, or changed, as a problem naming it, and will not write over it", async () => {
    const dir = await root();
    const k = key();
    const store = createCredentialStore(dir, k);
    await store.put("alice", { id: "alice" }, "github", github);
    await store.put("bob", { id: "bob" }, "github", github);
    const copied = await readFile(join(dir, "alice.json"));
    await writeFile(join(dir, "bob.json"), copied);
    expect((await store.read("bob")).problem).toMatch(/bob\.json cannot be opened with the credentials key/);
    await expect(store.put("bob", { id: "bob" }, "jira", jira)).rejects.toThrow(/bob\.json/);
    expect(await readFile(join(dir, "bob.json"))).toEqual(copied);
    expect(await store.list()).toEqual([{ id: "alice" }, { id: "bob" }]);
  });

  it("names a sealed file that opens to something not JSON, quoting none of it", async () => {
    const dir = await root();
    const k = key();
    const token = "ghp_TOKENLIKE0123456789abcdef";
    await createSealedFiles(dir, k).write("local.json", `{"person":{"id":"local"},"token":"${token}" oops`);
    const { problem } = await createCredentialStore(dir, k).read("local");
    expect(problem).toMatch(/local\.json is not JSON$/);
    expect(problem).not.toContain(token.slice(4, 14));
  });
});

describe("credentialValues", () => {
  it("is every stored value and refresh token, for the log to redact", () => {
    expect(credentialValues({ person: ME, connections: { github, jira } }).sort()).toEqual(["a1", "dev1", "ghp_abcdefghijkl", "refresh_abcdefgh"]);
    expect(credentialValues({ person: ME, connections: {}, problem: "x" })).toEqual([]);
    expect(credentialValues(null)).toEqual([]);
  });
});
