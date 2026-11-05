import { chmod, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CREDENTIALS_ROOT } from "#conventions.js";
import { messageOf } from "#runner/errors.js";
import type { CredentialStore, Person, PersonCredentials } from "#namespace.js";

const time = z.string().refine((t) => !Number.isNaN(Date.parse(t)), { message: "must be an ISO 8601 time" });

const fileSchema = z
  .object({
    person: z.object({ id: z.string(), email: z.string().optional(), name: z.string().optional() }).strict(),
    connections: z.record(
      z
        .object({
          fields: z.record(z.string()),
          source: z.enum(["paste", "oauth", "lookup", "override"]),
          connectedAt: time,
          expiresAt: time.optional(),
          failedAt: time.optional(),
          failure: z.string().optional(),
          refresh: z.object({ token: z.string() }).strict().optional(),
        })
        .strict(),
    ),
  })
  .strict();

const fileName = ".json";

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
  // Encoded, a separator cannot survive into the name, and the suffix keeps
  // `.` and `..` from naming a directory; an empty id would name `.json`,
  // which is nobody's.
  const fileOf = (personId: string): string => {
    if (personId === "") throw new Error("an empty person id cannot name a credentials file");
    return join(root, `${encodeURIComponent(personId)}${fileName}`);
  };

  const read = async (personId: string): Promise<PersonCredentials> => {
    const file = fileOf(personId);
    const failed = (problem: string): PersonCredentials => ({ person: { id: personId }, connections: {}, problem });
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code === "ENOENT") return { person: { id: personId }, connections: {} };
      return failed(`${file} cannot be read: ${messageOf(e)}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return failed(`${file} is not JSON: ${messageOf(e)}`);
    }
    const parsed = fileSchema.safeParse(json);
    if (!parsed.success) {
      return failed(`${file} is not a credentials file: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
    }
    if (parsed.data.person.id !== personId) return failed(`${file} names person "${parsed.data.person.id}", not "${personId}"`);
    // Parsed from JSON, an optional key is absent or a string, never `undefined`.
    return parsed.data as PersonCredentials;
  };

  // One write at a time: each reads the file, edits it and writes it whole,
  // so two at once — two forms submitted together on the Integrations tab —
  // would each write over the other's connection. Each temporary file is its
  // own, so two writes never rename one path out from under each other.
  let queue: Promise<void> = Promise.resolve();
  let written = 0;
  const change = (personId: string, edit: (c: PersonCredentials) => void): Promise<void> => {
    const next = queue.then(async () => {
      const current = await read(personId);
      if (current.problem !== undefined) throw new Error(`refusing to write over a credentials file that does not read: ${current.problem}`);
      edit(current);
      await mkdir(root, { recursive: true, mode: 0o700 });
      // `mode` applies only to a directory mkdir made; one already there keeps its own.
      await chmod(root, 0o700);
      const file = fileOf(personId);
      written += 1;
      const temporary = `${file}.${process.pid}.${written}.tmp`;
      await writeFile(temporary, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, file);
    });
    // The queue itself never rejects, so one refused write does not refuse every later one.
    queue = next.catch(() => {});
    return next;
  };

  return {
    root,
    read,
    put: (personId, person, connId, value) => {
      if (person.id !== personId) return Promise.reject(new Error(`person "${person.id}" cannot be stored as "${personId}"`));
      return change(personId, (c) => { c.person = person; c.connections[connId] = value; });
    },
    // The person as they signed in, their connections untouched: a file with none is still someone the runner runs for.
    remember: (person) => change(person.id, (c) => { c.person = person; }),
    remove: (personId, connId) => change(personId, (c) => { delete c.connections[connId]; }),
    list: async () => {
      const names = await readdir(root).catch((e: unknown) => {
        if ((e as { code?: unknown } | null)?.code === "ENOENT") return [] as string[];
        throw e;
      });
      const ids = names.filter((n) => n.endsWith(fileName) && n !== fileName).flatMap((n) => {
        try {
          return [decodeURIComponent(n.slice(0, -fileName.length))];
        } catch {
          return [];
        }
      }).sort();
      const people: Person[] = [];
      for (const id of ids) {
        const c = await read(id);
        people.push(c.problem === undefined ? c.person : { id });
      }
      return people;
    },
  };
}

/** Every value a person's file holds, for the log to redact; none from a file that did not read, or was never read. */
export function credentialValues(credentials: PersonCredentials | null): string[] {
  if (credentials === null) return [];
  return Object.values(credentials.connections).flatMap((c) => [
    ...Object.values(c.fields),
    ...(c.refresh === undefined ? [] : [c.refresh.token]),
  ]);
}
