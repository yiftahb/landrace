import { mkdir, mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { credentialKey, keyArgs, KEY_ACCOUNT, KEY_CREDENTIAL, KEY_SERVICE } from "#people/key.js";
import type { KeyHelper } from "#namespace.js";

const root = async (): Promise<string> => join(await mkdtemp(join(tmpdir(), "landrace-key-")), "credentials");
const hex = (b: Uint8Array | null): string => Buffer.from(b ?? []).toString("hex");

interface Call { command: string; args: readonly string[]; input?: string | undefined; env?: Record<string, string | undefined> | undefined }

/**
 * A fake of each helper, holding one throwaway key in memory: `security`'s
 * find (44 when absent) and its `-i` add read from stdin, `secret-tool`'s
 * lookup (1 and no stderr when absent) and store read from stdin.
 */
function fakeStore(opts: { held?: string; lookupFails?: { code: number; stderr: string } } = {}) {
  let held = opts.held;
  const calls: Call[] = [];
  let made = 0;
  const run: KeyHelper = async (command, args, o) => {
    calls.push({ command, args, input: o.input, env: o.env });
    // Each call takes a turn, so two creates interleave as two processes would.
    await new Promise((r) => setTimeout(r, 5));
    if (command === "security" && args[0] === "find-generic-password") {
      if (opts.lookupFails) return { code: opts.lookupFails.code, stdout: "", stderr: opts.lookupFails.stderr };
      return held === undefined ? { code: 44, stdout: "", stderr: "security: The specified item could not be found in the keychain.\n" } : { code: 0, stdout: `${held}\n`, stderr: "" };
    }
    if (command === "security" && args[0] === "-i") {
      const m = /-w ([0-9a-f]+)\n$/.exec(o.input ?? "");
      if (held !== undefined) return { code: 0, stdout: "", stderr: "security: The specified item already exists in the keychain.\n" };
      held = m?.[1];
      made += 1;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command === "secret-tool" && args[0] === "lookup") {
      if (opts.lookupFails) return { code: opts.lookupFails.code, stdout: "", stderr: opts.lookupFails.stderr };
      return held === undefined ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: held, stderr: "" };
    }
    if (command === "secret-tool" && args[0] === "store") {
      held = o.input;
      made += 1;
      return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected helper ${command} ${args.join(" ")}`);
  };
  return { run, calls, made: () => made, held: () => held };
}

const missing: KeyHelper = () => Promise.reject(Object.assign(new Error("spawn secret-tool ENOENT"), { code: "ENOENT" }));
const BUS = "unix:path=/run/user/1000/bus";

describe("credentialKey: the macOS Keychain", () => {
  it("makes an absent key at start, under service landrace and account credentials-key, never on argv", async () => {
    const f = fakeStore();
    const k = await credentialKey({ create: true, root: await root(), platform: "darwin", env: {}, run: f.run });
    expect(k.locator).toEqual({ source: "keychain" });
    expect(k.key?.length).toBe(32);
    expect(f.made()).toBe(1);
    expect(f.held()).toBe(hex(k.key));
    expect(KEY_SERVICE).toBe("landrace");
    expect(KEY_ACCOUNT).toBe("credentials-key");
    const find = f.calls.find((c) => c.args[0] === "find-generic-password");
    expect(find?.args).toEqual(["find-generic-password", "-s", "landrace", "-a", "credentials-key", "-w"]);
    for (const c of f.calls) expect(c.args.join(" ")).not.toContain(hex(k.key));
    expect(f.calls.find((c) => c.args[0] === "-i")?.input).toContain(hex(k.key));
  });

  it("reads a key already there, and makes none", async () => {
    const held = hex(new Uint8Array(randomBytes(32)));
    const f = fakeStore({ held });
    const k = await credentialKey({ create: true, root: await root(), platform: "darwin", env: {}, run: f.run });
    expect(hex(k.key)).toBe(held);
    expect(f.made()).toBe(0);
  });

  it("makes nothing when the lookup fails for any reason but absence", async () => {
    const f = fakeStore({ lookupFails: { code: 51, stderr: "security: User interaction is not allowed.\n" } });
    await expect(credentialKey({ create: true, root: await root(), platform: "darwin", env: {}, run: f.run }))
      .rejects.toThrow(/macOS Keychain.*exited 51: security: User interaction is not allowed/);
    expect(f.made()).toBe(0);
    expect(f.calls.every((c) => c.args[0] !== "-i")).toBe(true);
  });

  it("refuses a key that is not 32 bytes of hex", async () => {
    const f = fakeStore({ held: "short" });
    await expect(credentialKey({ create: true, root: await root(), platform: "darwin", env: {}, run: f.run })).rejects.toThrow(/not a credentials key/);
    expect(f.made()).toBe(0);
  });

  it("makes one key for two starts at once", async () => {
    const f = fakeStore();
    const dir = await root();
    const [a, b] = await Promise.all([
      credentialKey({ create: true, root: dir, platform: "darwin", env: {}, run: f.run }),
      credentialKey({ create: true, root: dir, platform: "darwin", env: {}, run: f.run }),
    ]);
    expect(f.made()).toBe(1);
    expect(hex(a.key)).toBe(hex(b.key));
    expect(await readdir(dir)).toEqual([]);
  });

  it("removes a lock a dead start left, and makes the key", async () => {
    const f = fakeStore();
    const dir = await root();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".key.lock"), "999999\n");
    const k = await credentialKey({ create: true, root: dir, platform: "darwin", env: {}, run: f.run, alive: (pid) => pid !== 999999 });
    expect(k.key?.length).toBe(32);
    expect(f.made()).toBe(1);
    expect(await readdir(dir)).toEqual([]);
  });

  it("keeps a live start's lock, and refuses once it has waited", async () => {
    const f = fakeStore();
    const dir = await root();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".key.lock"), "4242\n");
    await expect(credentialKey({ create: true, root: dir, platform: "darwin", env: {}, run: f.run, alive: () => true, lockWaitMs: 50 }))
      .rejects.toThrow(/\(pid 4242\) holds .*\.key\.lock/);
    expect(await readFile(join(dir, ".key.lock"), "utf8")).toBe("4242\n");
    expect(f.made()).toBe(0);
  });

  it("refuses, naming the lock, once it has waited on a lock it cannot read, a folder", async () => {
    const f = fakeStore();
    const dir = await root();
    await mkdir(join(dir, ".key.lock"), { recursive: true });
    const started = Date.now();
    await expect(credentialKey({ create: true, root: dir, platform: "darwin", env: {}, run: f.run, alive: () => false, lockWaitMs: 50 }))
      .rejects.toThrow(/cannot read .*\.key\.lock/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(f.made()).toBe(0);
  });

  it("refuses, naming the lock, once it has waited on a lock file it may not read", async () => {
    const f = fakeStore();
    const dir = await root();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".key.lock"), "4242\n", { mode: 0o000 });
    await expect(credentialKey({ create: true, root: dir, platform: "darwin", env: {}, run: f.run, alive: () => false, lockWaitMs: 50 }))
      .rejects.toThrow(/cannot read .*\.key\.lock/);
    expect(f.made()).toBe(0);
  });

  it("asked without create, answers no key for an absent one, naming the source it asked, and makes none", async () => {
    const f = fakeStore();
    expect(await credentialKey({ create: false, platform: "darwin", env: {}, run: f.run })).toEqual({ key: null, locator: { source: "keychain" } });
    expect(f.made()).toBe(0);
  });
});

describe("credentialKey: the Secret Service", () => {
  it("makes an absent key on stdin, on the session's bus", async () => {
    const f = fakeStore();
    const k = await credentialKey({ create: true, root: await root(), platform: "linux", env: { DBUS_SESSION_BUS_ADDRESS: BUS }, run: f.run });
    expect(k.locator).toEqual({ source: "secret-service", bus: BUS });
    expect(f.made()).toBe(1);
    expect(f.calls.map((c) => c.args.slice(0, 1)[0])).toEqual(["lookup", "lookup", "store", "lookup"]);
    expect(f.calls.find((c) => c.args[0] === "store")?.args).toEqual(["store", "--label=Landrace credentials key", "service", "landrace", "account", "credentials-key"]);
    for (const c of f.calls) {
      expect(c.args.join(" ")).not.toContain(hex(k.key));
      expect(c.env?.["DBUS_SESSION_BUS_ADDRESS"]).toBe(BUS);
    }
  });

  it("makes nothing on an exit 1 that says why", async () => {
    const f = fakeStore({ lookupFails: { code: 1, stderr: "Cannot autolaunch D-Bus without X11 $DISPLAY\n" } });
    await expect(credentialKey({ create: true, root: await root(), platform: "linux", env: { DBUS_SESSION_BUS_ADDRESS: BUS }, run: f.run }))
      .rejects.toThrow(/Secret Service.*exited 1: Cannot autolaunch/);
    expect(f.made()).toBe(0);
  });

  it("is no source with no session bus, or no secret-tool", async () => {
    const f = fakeStore();
    expect(await credentialKey({ create: true, root: await root(), platform: "linux", env: {}, run: f.run })).toEqual({ key: null, locator: { source: "none" } });
    expect(f.calls).toEqual([]);
    expect(await credentialKey({ create: true, root: await root(), platform: "linux", env: { DBUS_SESSION_BUS_ADDRESS: BUS }, run: missing }))
      .toEqual({ key: null, locator: { source: "none" } });
  });
});

describe("credentialKey: a systemd credential", () => {
  it("reads landrace-credentials-key from $CREDENTIALS_DIRECTORY, raw or hex, and asks no helper", async () => {
    const dir = await mkdtemp(join(tmpdir(), "landrace-creds-dir-"));
    const raw = new Uint8Array(randomBytes(32));
    await writeFile(join(dir, KEY_CREDENTIAL), raw);
    const f = fakeStore();
    const k = await credentialKey({ create: true, root: await root(), platform: "linux", env: { CREDENTIALS_DIRECTORY: dir }, run: f.run });
    expect(k).toEqual({ key: raw, locator: { source: "systemd", dir } });
    expect(f.calls).toEqual([]);
    await writeFile(join(dir, KEY_CREDENTIAL), `${hex(raw)}\n`);
    expect(hex((await credentialKey({ create: false, platform: "darwin", env: { CREDENTIALS_DIRECTORY: dir }, run: f.run })).key)).toBe(hex(raw));
  });

  it("refuses a directory that holds no key, naming the file and the setting, and makes none", async () => {
    const dir = await mkdtemp(join(tmpdir(), "landrace-creds-dir-"));
    await expect(credentialKey({ create: true, root: await root(), platform: "linux", env: { CREDENTIALS_DIRECTORY: dir } }))
      .rejects.toThrow(new RegExp(`${KEY_CREDENTIAL}.*LoadCredentialEncrypted=`));
  });
});

describe("credentialKey: elsewhere, and pinned", () => {
  it("is no source on Windows", async () => {
    expect(await credentialKey({ create: true, root: await root(), platform: "win32", env: {}, run: fakeStore().run })).toEqual({ key: null, locator: { source: "none" } });
  });

  it("asks the pinned source alone, never makes a key, and refuses naming it when absent", async () => {
    const f = fakeStore();
    await expect(credentialKey({ create: false, locator: { source: "keychain" }, platform: "linux", env: { DBUS_SESSION_BUS_ADDRESS: BUS }, run: f.run }))
      .rejects.toThrow(/no credentials key is in the macOS Keychain/);
    await expect(credentialKey({ create: false, locator: { source: "secret-service", bus: BUS }, platform: "darwin", env: {}, run: f.run }))
      .rejects.toThrow(/no credentials key is in the Secret Service/);
    expect(f.made()).toBe(0);
    const dir = await mkdtemp(join(tmpdir(), "landrace-creds-dir-"));
    await expect(credentialKey({ create: false, locator: { source: "systemd", dir }, env: {} })).rejects.toThrow(/systemd credential/);
  });

  it("asks a pinned Secret Service on the bus it was handed, whatever the environment says", async () => {
    const held = hex(new Uint8Array(randomBytes(32)));
    const f = fakeStore({ held });
    const k = await credentialKey({ create: false, locator: { source: "secret-service", bus: BUS }, env: {}, run: f.run });
    expect(hex(k.key)).toBe(held);
    expect(f.calls[0]?.env?.["DBUS_SESSION_BUS_ADDRESS"]).toBe(BUS);
  });

  it("answers a pinned none with no key", async () => {
    expect(await credentialKey({ create: false, locator: { source: "none" }, run: fakeStore().run })).toEqual({ key: null, locator: { source: "none" } });
  });
});

describe("keyArgs", () => {
  it("pins each source on a server's command line, never the key", () => {
    expect(keyArgs({ source: "keychain" })).toEqual(["--key-source=keychain"]);
    expect(keyArgs({ source: "secret-service", bus: BUS })).toEqual(["--key-source=secret-service", `--key-bus=${BUS}`]);
    expect(keyArgs({ source: "secret-service" })).toEqual(["--key-source=secret-service"]);
    expect(keyArgs({ source: "systemd", dir: "/run/credentials/landrace.service" })).toEqual(["--key-source=systemd", "--key-dir=/run/credentials/landrace.service"]);
    expect(keyArgs({ source: "none" })).toEqual(["--key-source=none"]);
  });
});
