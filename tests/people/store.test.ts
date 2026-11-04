import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CREDENTIALS_DENY } from "#kit/executor.js";
import { createCredentialStore, credentialValues } from "#people/store.js";

const root = async (): Promise<string> => join(await mkdtemp(join(tmpdir(), "landrace-creds-")), "credentials");
const github = { values: { login: "dev1", token: "ghp_abcdefghijkl" }, connectedAt: "2026-11-01T00:00:00.000Z" };

describe("the credential store", () => {
  it("keeps its default root where every run is denied reading", () => {
    expect(createCredentialStore().root).toBe(join(homedir(), CREDENTIALS_DENY.slice(2)));
  });

  it("reads a person with no file as having connected nothing", async () => {
    const store = createCredentialStore(await root());
    expect(await store.read("local")).toEqual({ ok: true, credentials: { person: "local", connections: {} } });
    expect(await store.list()).toEqual([]);
  });

  it("round-trips a connection, in a 0600 file under a 0700 directory", async () => {
    const dir = await root();
    const store = createCredentialStore(dir);
    await store.put("local", "github", github);
    expect(await store.read("local")).toEqual({ ok: true, credentials: { person: "local", connections: { github } } });
    expect((await stat(join(dir, "local.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    await store.put("local", "jira", { values: { account: "a1" }, connectedAt: github.connectedAt });
    await store.remove("local", "github");
    expect(await store.read("local")).toEqual({
      ok: true, credentials: { person: "local", connections: { jira: { values: { account: "a1" }, connectedAt: github.connectedAt } } },
    });
    expect(await store.list()).toEqual(["local"]);
  });

  it("tightens a directory that already exists wider than 0700", async () => {
    const dir = await root();
    await mkdir(dir, { mode: 0o755 });
    await createCredentialStore(dir).put("local", "github", github);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("reads a corrupt file as failed with the reason, lists its person, and will not write over it", async () => {
    const dir = await root();
    await mkdir(dir, { recursive: true });
    for (const [person, text] of [["broken", "{ not json"], ["shaped", JSON.stringify({ person: "shaped", connections: { github: { values: { login: 7 } } } })]] as const) {
      await writeFile(join(dir, `${person}.json`), text);
      const read = await createCredentialStore(dir).read(person);
      expect(read.ok).toBe(false);
      expect(read.ok ? "" : read.reason).toMatch(new RegExp(`${person}\\.json`));
    }
    const store = createCredentialStore(dir);
    expect(await store.list()).toEqual(["broken", "shaped"]);
    await expect(store.put("broken", "github", github)).rejects.toThrow(/broken\.json/);
    await expect(store.remove("broken", "github")).rejects.toThrow(/broken\.json/);
    expect(await readFile(join(dir, "broken.json"), "utf8")).toBe("{ not json");
  });

  it("refuses a person id that is not a plain file name", async () => {
    const store = createCredentialStore(await root());
    for (const person of ["../x", ".hidden", "a/b", ""]) {
      await expect(store.read(person)).rejects.toThrow(/person/);
      await expect(store.put(person, "github", github)).rejects.toThrow(/person/);
    }
  });
});

describe("credentialValues", () => {
  it("is every stored value, for the log to redact", () => {
    expect(credentialValues({ ok: true, credentials: { person: "local", connections: { github } } }).sort()).toEqual(["dev1", "ghp_abcdefghijkl"]);
    expect(credentialValues({ ok: false, reason: "x" })).toEqual([]);
    expect(credentialValues(null)).toEqual([]);
  });
});
