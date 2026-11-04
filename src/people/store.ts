import { chmod, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CREDENTIALS_ROOT } from "#conventions.js";
import { messageOf } from "#runner/errors.js";
import type { CredentialStore, PersonCredentials, PersonCredentialsRead } from "#namespace.js";

const fileSchema = z
  .object({
    person: z.string(),
    connections: z.record(
      z
        .object({
          values: z.record(z.string()),
          connectedAt: z.string().refine((t) => !Number.isNaN(Date.parse(t)), { message: "must be an ISO 8601 time" }),
        })
        .strict(),
    ),
  })
  .strict();

/** A person id as a file name: no separator, no leading dot, nothing a path could climb out by. */
const PERSON = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/**
 * The store at `root`, by default the directory every run is denied reading
 * (the kit's `CREDENTIALS_DENY`, `CREDENTIALS_ROOT` here): one is the other, so the two cannot drift apart.
 *
 * Written whole to a temporary file beside the real one and renamed over it,
 * so a crash mid-write leaves the old file rather than half of a new one —
 * and a file it cannot read is refused rather than replaced, since writing
 * one connection over a file it could not parse would drop every other.
 */
export function createCredentialStore(root: string = join(homedir(), CREDENTIALS_ROOT.slice(2))): CredentialStore {
  const fileOf = (person: string): string => {
    if (!PERSON.test(person)) throw new Error(`person id ${JSON.stringify(person)} cannot name a credentials file`);
    return join(root, `${person}.json`);
  };

  const read = async (person: string): Promise<PersonCredentialsRead> => {
    const file = fileOf(person);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code === "ENOENT") return { ok: true, credentials: { person, connections: {} } };
      return { ok: false, reason: `${file} cannot be read: ${messageOf(e)}` };
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return { ok: false, reason: `${file} is not JSON: ${messageOf(e)}` };
    }
    const parsed = fileSchema.safeParse(json);
    if (!parsed.success) {
      return { ok: false, reason: `${file} is not a credentials file: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}` };
    }
    if (parsed.data.person !== person) return { ok: false, reason: `${file} names person "${parsed.data.person}", not "${person}"` };
    return { ok: true, credentials: parsed.data };
  };

  const change = async (person: string, edit: (c: PersonCredentials) => void): Promise<void> => {
    const current = await read(person);
    if (!current.ok) throw new Error(`refusing to write over a credentials file that does not read: ${current.reason}`);
    edit(current.credentials);
    await mkdir(root, { recursive: true, mode: 0o700 });
    // `mode` applies only to a directory mkdir made; one already there keeps its own.
    await chmod(root, 0o700);
    const file = fileOf(person);
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(current.credentials, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  };

  return {
    root,
    read,
    put: (person, connection, value) => change(person, (c) => { c.connections[connection] = value; }),
    remove: (person, connection) => change(person, (c) => { delete c.connections[connection]; }),
    list: async () => {
      const names = await readdir(root).catch((e: unknown) => {
        if ((e as { code?: unknown } | null)?.code === "ENOENT") return [] as string[];
        throw e;
      });
      return names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -".json".length)).filter((p) => PERSON.test(p)).sort();
    },
  };
}

/** Every value a person's file holds, for the log to redact; none from a file that did not read, or was never read. */
export function credentialValues(read: PersonCredentialsRead | null): string[] {
  if (read === null || !read.ok) return [];
  return Object.values(read.credentials.connections).flatMap((c) => Object.values(c.values));
}
