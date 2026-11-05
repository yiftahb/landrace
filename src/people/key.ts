import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { processAlive } from "#people/sealed.js";
import type { CredentialKey, CredentialKeyOptions, KeyHelper, KeyLocator } from "#namespace.js";

/** Where the key is kept in the Keychain and the Secret Service: service and account. */
export const KEY_SERVICE = "landrace";
export const KEY_ACCOUNT = "credentials-key";
/** The systemd credential's name, under `$CREDENTIALS_DIRECTORY`: `LoadCredentialEncrypted=landrace-credentials-key:…`. */
export const KEY_CREDENTIAL = "landrace-credentials-key";
const KEY_BYTES = 32;
const LOCK = ".key.lock";
/** The page that says how to give an instance a key. */
export const KEY_DOCS = "docs/security.md#stored-credentials";

/**
 * Each helper as a process with no shell, the secret on stdin: what argv
 * holds, any process of this user can read from the process table.
 */
const execHelper: KeyHelper = (command, args, opts) => new Promise((done, fail) => {
  const child = execFile(command, [...args], { env: opts.env ?? process.env, timeout: 30_000 }, (error, stdout, stderr) => {
    const code = (error as { code?: unknown } | null)?.code;
    // Started and exited: its code is its answer. Never started — not
    // installed — is a rejection, which the caller reads as no source.
    if (error && typeof code !== "number") return fail(error);
    done({ code: typeof code === "number" ? code : 0, stdout: String(stdout), stderr: String(stderr) });
  });
  child.stdin?.end(opts.input ?? "");
});

const notInstalled = (e: unknown): boolean => (e as { code?: unknown } | null)?.code === "ENOENT";

const sourceName = (locator: KeyLocator): string => ({
  keychain: "the macOS Keychain", "secret-service": "the Secret Service", systemd: "the systemd credential", none: "no secret store",
})[locator.source];

/** 32 bytes, from 64 hex digits — or, for a systemd credential, the raw bytes too. */
function parseKey(bytes: Buffer, raw: boolean, where: string): Uint8Array {
  if (raw && bytes.length === KEY_BYTES) return new Uint8Array(bytes);
  const text = bytes.toString("utf8").trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) return new Uint8Array(Buffer.from(text, "hex"));
  // Never what it held: it is meant to be a secret, whatever it is.
  throw new Error(`${where} holds something that is not a credentials key: ${KEY_BYTES} bytes, as 64 hex digits${raw ? " or raw" : ""}`);
}

interface Source {
  locator: KeyLocator;
  /** The key, null when the source says plainly it holds none; throws for any other failure. */
  lookup(): Promise<Uint8Array | null>;
  store(hex: string): Promise<void>;
}

function sourceOf(locator: KeyLocator, run: KeyHelper, env: Record<string, string | undefined>): Source | null {
  if (locator.source === "none") return null;
  if (locator.source === "systemd") {
    const file = join(locator.dir, KEY_CREDENTIAL);
    return {
      locator,
      lookup: async () => {
        const bytes = await readFile(file).catch((e: unknown) => {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw new Error(`${file} cannot be read: ${(e as Error).message}`);
        });
        return bytes === null ? null : parseKey(bytes, true, file);
      },
      store: () => Promise.reject(new Error(
        `$CREDENTIALS_DIRECTORY is ${locator.dir}, which holds no ${KEY_CREDENTIAL}: load one into the unit with ` +
        `LoadCredentialEncrypted=${KEY_CREDENTIAL}:… (or mount it there, in a container); see ${KEY_DOCS}`,
      )),
    };
  }
  const where = sourceName(locator);
  const failed = (r: { code: number; stderr: string }): Error => new Error(`${where} could not be asked for the credentials key: it exited ${r.code}: ${r.stderr.trim()}`);
  if (locator.source === "keychain") {
    return {
      locator,
      lookup: async () => {
        const r = await run("security", ["find-generic-password", "-s", KEY_SERVICE, "-a", KEY_ACCOUNT, "-w"], { env });
        // 44 is errSecItemNotFound: the one answer that means absent.
        if (r.code === 44) return null;
        if (r.code !== 0) throw failed(r);
        return parseKey(Buffer.from(r.stdout), false, `${where} (service ${KEY_SERVICE}, account ${KEY_ACCOUNT})`);
      },
      // `-i` reads its commands from stdin, so the key is never on argv;
      // whether the add took is the lookup after it, not its exit code.
      store: async (hex) => {
        await run("security", ["-i"], { env, input: `add-generic-password -s ${KEY_SERVICE} -a ${KEY_ACCOUNT} -l "Landrace credentials key" -w ${hex}\n` });
      },
    };
  }
  // The Secret Service is reached over the session bus; a server is handed
  // the one `start` used, since its agent's environment carries none.
  const busEnv = { ...env, ...(locator.bus === undefined ? {} : { DBUS_SESSION_BUS_ADDRESS: locator.bus }) };
  return {
    locator,
    lookup: async () => {
      const r = await run("secret-tool", ["lookup", "service", KEY_SERVICE, "account", KEY_ACCOUNT], { env: busEnv });
      // Absent is exit 1 with nothing said; exit 1 saying why is a failure.
      if (r.code === 1 && r.stderr.trim() === "") return null;
      if (r.code !== 0) throw failed(r);
      return parseKey(Buffer.from(r.stdout), false, `${where} (service ${KEY_SERVICE}, account ${KEY_ACCOUNT})`);
    },
    store: async (hex) => {
      const r = await run("secret-tool", ["store", "--label=Landrace credentials key", "service", KEY_SERVICE, "account", KEY_ACCOUNT], { env: busEnv, input: hex });
      if (r.code !== 0) throw failed(r);
    },
  };
}

/** Where this machine keeps a key, by its platform and environment; none where it has no store we use. */
function detected(platform: NodeJS.Platform, env: Record<string, string | undefined>): KeyLocator {
  const dir = env["CREDENTIALS_DIRECTORY"];
  if (dir !== undefined && dir !== "") return { source: "systemd", dir };
  if (platform === "darwin") return { source: "keychain" };
  if (platform === "win32") return { source: "none" };
  const bus = env["DBUS_SESSION_BUS_ADDRESS"];
  return bus === undefined || bus === "" ? { source: "none" } : { source: "secret-service", bus };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let locks = 0;

/**
 * Held while a key is made: linked into place from a file already holding
 * this pid, so it is never there empty, and two starts cannot both hold it.
 * A holder that has died is removed — the very file judged, by its inode, so
 * a live start's fresh lock is never taken for it — and taken again. A live
 * one is waited on, then refused.
 */
async function withLock<T>(root: string, alive: (pid: number) => boolean, waitMs: number, work: () => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = join(root, LOCK);
  locks += 1;
  const mine = join(root, `${LOCK}.${process.pid}.${locks}`);
  await writeFile(mine, `${process.pid}\n`, { mode: 0o600 });
  const deadline = Date.now() + waitMs;
  try {
    for (;;) {
      try {
        await link(mine, lock);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const held = await Promise.all([stat(lock), readFile(lock, "utf8")]).catch(() => null);
      if (held === null) continue;
      const pid = Number(held[1].trim());
      if (Number.isInteger(pid) && pid > 0 && !alive(pid)) {
        const again = await stat(lock).catch(() => null);
        if (again?.ino === held[0].ino) await unlink(lock).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`another landrace start (pid ${held[1].trim()}) holds ${lock} while it makes the credentials key; try again once it has started`);
      await sleep(25);
    }
  } finally {
    await unlink(mine).catch(() => {});
  }
  const ours = await stat(lock);
  try {
    return await work();
  } finally {
    const now = await stat(lock).catch(() => null);
    if (now?.ino === ours.ino) await unlink(lock).catch(() => {});
  }
}

async function find(opts: CredentialKeyOptions): Promise<CredentialKey> {
  const env = opts.env ?? process.env;
  const run = opts.run ?? execHelper;
  const locator = opts.locator ?? detected(opts.platform ?? process.platform, env);
  const source = sourceOf(locator, run, env);
  if (source === null) return { key: null, locator: { source: "none" } };
  let key: Uint8Array | null;
  try {
    key = await source.lookup();
  } catch (e) {
    // Not installed, unasked: a machine with no store of ours. A pinned one
    // must be there — the server's parent found it.
    if (opts.locator === undefined && notInstalled(e)) return { key: null, locator: { source: "none" } };
    throw e;
  }
  if (key !== null) return { key, locator };
  if (opts.locator !== undefined) {
    throw new Error(`no credentials key is in ${sourceName(locator)}, where landrace start found one; restart it, or see ${KEY_DOCS}`);
  }
  // Asked without making one: the source is there, and holds none yet.
  if (!opts.create) return { key: null, locator };
  if (locator.source === "systemd") {
    // Never made here: systemd's files are read-only, and the unit says what is in them.
    await source.store("");
  }
  const root = opts.root;
  if (root === undefined) throw new Error("a credentials key is made only beside the credentials, and no root was given");
  return withLock(root, opts.alive ?? processAlive, opts.lockWaitMs ?? 30_000, async () => {
    // Again, under the lock: another start may have made it meanwhile, and a
    // second key would leave every file the first sealed unopenable.
    const meanwhile = await source.lookup();
    if (meanwhile !== null) return { key: meanwhile, locator };
    await source.store(randomBytes(KEY_BYTES).toString("hex"));
    const made = await source.lookup();
    if (made === null) throw new Error(`${sourceName(locator)} did not keep the credentials key just stored in it`);
    return { key: made, locator };
  });
}

const memo = new Map<string, Promise<CredentialKey>>();

/**
 * The key the credentials are sealed under, from the source this machine
 * has — or, with `locator`, from that source alone. Made only with `create`,
 * and only when the source says plainly it holds none: any other failure is
 * thrown, since a key made over one that is there but unreadable orphans
 * every file sealed under it. Once per process for the same question, unless
 * a helper is handed in.
 */
export function credentialKey(opts: CredentialKeyOptions): Promise<CredentialKey> {
  const injected = opts.run !== undefined || opts.env !== undefined || opts.platform !== undefined || opts.alive !== undefined;
  if (injected) return find(opts);
  const id = JSON.stringify([opts.create, opts.locator ?? null, opts.root ?? null]);
  const known = memo.get(id);
  if (known) return known;
  const made = find(opts);
  memo.set(id, made);
  // A failure is not remembered: the next ask asks again.
  made.catch(() => memo.delete(id));
  return made;
}

/** The flags that pin `locator` on a server's command line — where the key is, never the key. */
export function keyArgs(locator: KeyLocator): string[] {
  const source = `--key-source=${locator.source}`;
  if (locator.source === "systemd") return [source, `--key-dir=${locator.dir}`];
  if (locator.source === "secret-service" && locator.bus !== undefined) return [source, `--key-bus=${locator.bus}`];
  return [source];
}

/** `keyArgs` read back, from `landrace mcp`'s options; absent, the server refuses: it would not know which store to ask. */
export function keyLocatorOf(opts: { keySource?: string | undefined; keyDir?: string | undefined; keyBus?: string | undefined }): KeyLocator {
  switch (opts.keySource) {
    case "keychain":
      return { source: "keychain" };
    case "secret-service":
      return opts.keyBus === undefined ? { source: "secret-service" } : { source: "secret-service", bus: opts.keyBus };
    case "systemd":
      if (opts.keyDir === undefined) throw new Error("--key-source=systemd needs --key-dir");
      return { source: "systemd", dir: opts.keyDir };
    case "none":
      return { source: "none" };
    case undefined:
      throw new Error("needs --key-source, the secret store landrace start found the credentials key in");
    default:
      throw new Error(`--key-source must be keychain, secret-service, systemd or none, not "${opts.keySource}"`);
  }
}
