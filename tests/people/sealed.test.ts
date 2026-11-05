import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createSealedFiles, sealAll } from "#people/sealed.js";

const root = async (): Promise<string> => join(await mkdtemp(join(tmpdir(), "landrace-sealed-")), "credentials");
// A throwaway key, made for this test alone.
const key = (): Uint8Array => new Uint8Array(randomBytes(32));
const TOKEN = "ghp_SEALEDTOKEN0123456789";
const text = JSON.stringify({ person: { id: "alice" }, connections: { github: { fields: { token: TOKEN } } } });

describe("sealed files", () => {
  it("writes an envelope holding none of the text's bytes, and reads it back", async () => {
    const dir = await root();
    const files = createSealedFiles(dir, key());
    await files.write("alice.json", text);
    const disk = await readFile(join(dir, "alice.json"), "utf8");
    const envelope = JSON.parse(disk) as Record<string, unknown>;
    expect(Object.keys(envelope).sort()).toEqual(["data", "iv", "landrace", "tag", "v"]);
    expect(envelope["landrace"]).toBe("sealed");
    expect(envelope["v"]).toBe(1);
    expect(disk).not.toContain(TOKEN);
    expect(disk).not.toContain("alice\"");
    expect(await files.read("alice.json")).toBe(text);
    expect(await files.encrypted()).toBe(true);
    expect((await stat(join(dir, "alice.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("seals each write under its own IV", async () => {
    const dir = await root();
    const files = createSealedFiles(dir, key());
    await files.write("alice.json", text);
    const first = JSON.parse(await readFile(join(dir, "alice.json"), "utf8")) as { iv: string; data: string };
    await files.write("alice.json", text);
    const second = JSON.parse(await readFile(join(dir, "alice.json"), "utf8")) as { iv: string; data: string };
    expect(second.iv).not.toBe(first.iv);
    expect(second.data).not.toBe(first.data);
  });

  it("answers null for a file that is not there", async () => {
    expect(await createSealedFiles(await root(), key()).read("nobody.json")).toBeNull();
  });

  it("refuses a file copied over another's, naming the file", async () => {
    const dir = await root();
    const files = createSealedFiles(dir, key());
    await files.write("alice.json", text);
    await writeFile(join(dir, "bob.json"), await readFile(join(dir, "alice.json")));
    await expect(files.read("bob.json")).rejects.toThrow(/bob\.json cannot be opened with the credentials key/);
  });

  it("refuses a file with one byte changed, naming the file and quoting none of it", async () => {
    const dir = await root();
    const files = createSealedFiles(dir, key());
    await files.write("alice.json", text);
    const envelope = JSON.parse(await readFile(join(dir, "alice.json"), "utf8")) as { data: string };
    const bytes = Buffer.from(envelope.data, "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    await writeFile(join(dir, "alice.json"), JSON.stringify({ ...envelope, data: bytes.toString("base64") }));
    const failure = await files.read("alice.json").then(() => "", (e: unknown) => (e as Error).message);
    expect(failure).toMatch(/alice\.json cannot be opened with the credentials key/);
    expect(failure).not.toContain(envelope.data.slice(0, 12));
  });

  it("refuses a file sealed under another key", async () => {
    const dir = await root();
    await createSealedFiles(dir, key()).write("alice.json", text);
    await expect(createSealedFiles(dir, key()).read("alice.json")).rejects.toThrow(/alice\.json cannot be opened/);
  });

  it("with a key, refuses a plain file rather than read what anyone could have put there", async () => {
    const dir = await root();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "alice.json"), text);
    await expect(createSealedFiles(dir, key()).read("alice.json")).rejects.toThrow(/alice\.json is not sealed/);
  });

  it("with no key, writes and reads plain text, and refuses a sealed file", async () => {
    const dir = await root();
    const plain = createSealedFiles(dir, null);
    expect(await plain.encrypted()).toBe(false);
    await plain.write("alice.json", text);
    expect(await readFile(join(dir, "alice.json"), "utf8")).toBe(text);
    expect(await plain.read("alice.json")).toBe(text);
    await createSealedFiles(dir, key()).write("bob.json", text);
    await expect(plain.read("bob.json")).rejects.toThrow(/bob\.json is sealed, and no credentials key was found/);
  });

  it("asks a lazily given key's source once, and only when a file is touched", async () => {
    const dir = await root();
    let asked = 0;
    const k = key();
    const files = createSealedFiles(dir, () => { asked += 1; return Promise.resolve(k); });
    expect(asked).toBe(0);
    await files.write("alice.json", text);
    expect(await files.read("alice.json")).toBe(text);
    expect(asked).toBe(1);
  });

  it("writes under a folder of the root, the path under the root its additional data", async () => {
    const dir = await root();
    const files = createSealedFiles(dir, key());
    await files.write("mcp/mcp-tokens.json", "{}");
    expect((await stat(join(dir, "mcp"))).mode & 0o777).toBe(0o700);
    await mkdir(join(dir, "other"), { recursive: true });
    await writeFile(join(dir, "other", "mcp-tokens.json"), await readFile(join(dir, "mcp", "mcp-tokens.json")));
    await expect(files.read("other/mcp-tokens.json")).rejects.toThrow(/cannot be opened/);
  });
});

describe("sealAll", () => {
  it("seals every person's file and both of the door's, in place, and leaves a sealed one as it was", async () => {
    const dir = await root();
    await mkdir(join(dir, "mcp"), { recursive: true });
    await writeFile(join(dir, "alice.json"), text);
    await writeFile(join(dir, "mcp", "mcp-clients.json"), "{\"c1\":{}}");
    await writeFile(join(dir, "mcp", "mcp-tokens.json"), `{"h":"${TOKEN}"}`);
    const files = createSealedFiles(dir, key());
    await files.write("bob.json", text);
    const bob = await readFile(join(dir, "bob.json"), "utf8");
    await sealAll(files);
    for (const name of ["alice.json", "mcp/mcp-clients.json", "mcp/mcp-tokens.json"]) {
      const disk = await readFile(join(dir, name), "utf8");
      expect(disk).toContain("\"sealed\"");
      expect(disk).not.toContain(TOKEN);
    }
    expect(await files.read("alice.json")).toBe(text);
    expect(await files.read("mcp/mcp-tokens.json")).toBe(`{"h":"${TOKEN}"}`);
    expect(await readFile(join(dir, "bob.json"), "utf8")).toBe(bob);
  });

  it("deletes a temporary file a dead process left, and keeps a live one's", async () => {
    const dir = await root();
    await mkdir(join(dir, "mcp"), { recursive: true });
    await writeFile(join(dir, "alice.json.999999.1.tmp"), text);
    await writeFile(join(dir, "mcp", "mcp-tokens.json.999999.2.tmp"), text);
    await writeFile(join(dir, `bob.json.${process.pid}.1.tmp`), text);
    await sealAll(createSealedFiles(dir, key()), { alive: (pid) => pid === process.pid });
    expect((await readdir(dir)).sort()).toEqual([`bob.json.${process.pid}.1.tmp`, "mcp"]);
    expect(await readdir(join(dir, "mcp"))).toEqual([]);
  });

  it("with no key, seals nothing", async () => {
    const dir = await root();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "alice.json"), text);
    await sealAll(createSealedFiles(dir, null));
    expect(await readFile(join(dir, "alice.json"), "utf8")).toBe(text);
  });

  it("is nothing to do with no root yet", async () => {
    await expect(sealAll(createSealedFiles(await root(), key()))).resolves.toBeUndefined();
  });
});
