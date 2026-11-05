import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { messageOf } from "#runner/errors.js";
import type { SealedFiles } from "#namespace.js";

/** The door's two files, under the credentials root, beside every person's. */
export const MCP_FOLDER = "mcp";

const IV_BYTES = 12;

interface Envelope {
  landrace: "sealed";
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

/** Whether `text` is one of our envelopes. Anything else — a person's JSON, a corrupt file — is plain. */
function envelopeOf(text: string): Envelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const e = parsed as Record<string, unknown>;
  if (e["landrace"] !== "sealed") return null;
  return e["v"] === 1 && typeof e["iv"] === "string" && typeof e["tag"] === "string" && typeof e["data"] === "string"
    ? (e as unknown as Envelope)
    : null;
}

/** Whether `pid` runs: a signal it would refuse for permission still proves it is there. */
export const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * The files under `root`, sealed under `key` when there is one. A function
 * for `key` is asked once, the first time a file is touched: `validate` and
 * `status` read the store only for a configuration that needs it, and asking
 * a secret store for nothing could stop them on a machine with none.
 *
 * With a key, a plain file is refused rather than read — anyone who can put
 * a file in the folder could otherwise stand their own connections in for a
 * person's. Without one, a sealed file is refused: it is somebody's, and
 * nothing here can open it. Neither is ever written over.
 */
export function createSealedFiles(root: string, key: Uint8Array | null | (() => Promise<Uint8Array | null>)): SealedFiles {
  let known: Promise<Uint8Array | null> | null = typeof key === "function" ? null : Promise.resolve(key);
  const keyOf = (): Promise<Uint8Array | null> => {
    if (known === null) known = (key as () => Promise<Uint8Array | null>)();
    return known;
  };
  let written = 0;

  const seal = (k: Uint8Array, name: string, text: string): string => {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", k, iv);
    cipher.setAAD(Buffer.from(name, "utf8"));
    const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    const envelope: Envelope = { landrace: "sealed", v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
    return `${JSON.stringify(envelope)}\n`;
  };

  return {
    root,
    encrypted: async () => (await keyOf()) !== null,
    read: async (name) => {
      const file = join(root, name);
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch (e) {
        if ((e as { code?: unknown } | null)?.code === "ENOENT") return null;
        throw new Error(`${file} cannot be read: ${messageOf(e)}`);
      }
      const k = await keyOf();
      const envelope = envelopeOf(text);
      if (k === null) {
        if (envelope !== null) throw new Error(`${file} is sealed, and no credentials key was found to open it`);
        return text;
      }
      if (envelope === null) throw new Error(`${file} is not sealed, though the credentials are; a restart of landrace start seals it`);
      // Never the cipher's own words, nor any of the file: a person fixes this
      // by knowing which file, and that its key or its place is not this one.
      try {
        const decipher = createDecipheriv("aes-256-gcm", k, Buffer.from(envelope.iv, "base64"));
        decipher.setAAD(Buffer.from(name, "utf8"));
        decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
        return Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8");
      } catch {
        throw new Error(`${file} cannot be opened with the credentials key: it was sealed under another key, or for another file, or changed since`);
      }
    },
    write: async (name, text) => {
      const k = await keyOf();
      const file = join(root, name);
      // Every folder from the root down, each 0700: `mode` applies only to a
      // directory mkdir made, and one already there keeps its own.
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      for (let at = dirname(file); at.startsWith(root); at = dirname(at)) {
        await chmod(at, 0o700);
        if (at === root) break;
      }
      written += 1;
      const temporary = `${file}.${process.pid}.${written}.tmp`;
      await writeFile(temporary, k === null ? text : seal(k, name, text), { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, file);
    },
  };
}

const TEMPORARY = /\.(\d+)\.\d+\.tmp$/;

/** Each entry of a folder, none for a folder not there. */
const entries = (dir: string): Promise<string[]> => readdir(dir).catch((e: unknown) => {
  if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
  throw e;
});

/**
 * Every plain file under the root sealed in place — each person's, and the
 * door's two — and each temporary file a process that has since died left
 * there deleted: it holds what that write was writing, in whatever form,
 * and no rename will ever take it now. A live process's is its own write,
 * still under way. With no key there is nothing to seal.
 */
export async function sealAll(files: SealedFiles, opts: { alive?: (pid: number) => boolean } = {}): Promise<void> {
  const alive = opts.alive ?? processAlive;
  const sealing = await files.encrypted();
  for (const folder of ["", MCP_FOLDER]) {
    const dir = folder === "" ? files.root : join(files.root, folder);
    for (const entry of await entries(dir)) {
      const name = folder === "" ? entry : `${folder}/${entry}`;
      const tmp = TEMPORARY.exec(entry);
      if (tmp) {
        if (!alive(Number(tmp[1]))) await unlink(join(dir, entry)).catch(() => {});
        continue;
      }
      if (!sealing || !entry.endsWith(".json")) continue;
      const text = await readFile(join(dir, entry), "utf8");
      if (envelopeOf(text) !== null) continue;
      await files.write(name, text);
    }
  }
}
