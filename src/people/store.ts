import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CREDENTIALS_ROOT } from "#conventions.js";
import { messageOf } from "#runner/errors.js";
import { credentialKey } from "#people/key.js";
import { createSealedFiles } from "#people/sealed.js";
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
    paused: z.object({ at: time }).strict().optional(),
  })
  .strict();

const fileName = ".json";

/** What is wrong at one path, in words that name types and keys but never a value the file holds. */
function issueOf(issue: z.ZodIssue): string {
  if (issue.code === "invalid_type") return `expected ${issue.expected}, got ${issue.received}`;
  if (issue.code === "unrecognized_keys") return `unknown ${issue.keys.length === 1 ? "key" : "keys"} ${issue.keys.map((k) => `"${k}"`).join(", ")}`;
  // Our own refinement's message, which is fixed text.
  if (issue.code === "custom") return issue.message;
  return "not an allowed value";
}

/** The directory every run is denied reading (the kit's `CREDENTIALS_DENY`, `CREDENTIALS_ROOT` here): one is the other, so the two cannot drift apart. */
export const defaultCredentialsRoot = (): string => join(homedir(), CREDENTIALS_ROOT.slice(2));

/**
 * The store at `root`, each file sealed under `key`; with none, plain JSON
 * (see `createSealedFiles`).
 *
 * Written whole to a temporary file beside the real one and renamed over it,
 * so a crash mid-write leaves the old file rather than half of a new one —
 * and a file it cannot read, or open, is refused rather than replaced, since
 * writing one connection over a file it could not parse would drop every other.
 */
export function createCredentialStore(
  root: string = defaultCredentialsRoot(), key: Uint8Array | null | (() => Promise<Uint8Array | null>) = null,
): CredentialStore {
  const files = createSealedFiles(root, key);
  // Encoded, a separator cannot survive into the name, and the suffix keeps
  // `.` and `..` from naming a directory; an empty id would name `.json`,
  // which is nobody's.
  const nameOf = (personId: string): string => {
    if (personId === "") throw new Error("an empty person id cannot name a credentials file");
    return `${encodeURIComponent(personId)}${fileName}`;
  };

  const read = async (personId: string): Promise<PersonCredentials> => {
    const name = nameOf(personId);
    const file = join(root, name);
    const failed = (problem: string): PersonCredentials => ({ person: { id: personId }, connections: {}, problem });
    let text: string | null;
    try {
      text = await files.read(name);
    } catch (e) {
      // Its own words name the file, and quote none of it.
      return failed(messageOf(e));
    }
    if (text === null) return { person: { id: personId }, connections: {} };
    // No problem quotes the file: JSON.parse's message echoes the text
    // around the fault, and a zod enum issue the value it got, and either can
    // be part of a token. The path and the kind of fault are enough to fix it.
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return failed(`${file} is not JSON`);
    }
    const parsed = fileSchema.safeParse(json);
    if (!parsed.success) {
      return failed(`${file} is not a credentials file: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${issueOf(i)}`).join("; ")}`);
    }
    // The id the file names is its own text too, and a hand-edited file could
    // hold anything there; the id asked for is ours, from the file's name.
    if (parsed.data.person.id !== personId) return failed(`${file} names another person, not "${personId}"`);
    // Parsed from JSON, an optional key is absent or a string, never `undefined`.
    return parsed.data as PersonCredentials;
  };

  // One write at a time: each reads the file, edits it and writes it whole,
  // so two at once — two forms submitted together on the Integrations tab —
  // would each write over the other's connection. Each temporary file is its
  // own, so two writes never rename one path out from under each other.
  let queue: Promise<void> = Promise.resolve();
  const change = (personId: string, edit: (c: PersonCredentials) => void): Promise<void> => {
    const next = queue.then(async () => {
      const current = await read(personId);
      if (current.problem !== undefined) throw new Error(`refusing to write over a credentials file that does not read: ${current.problem}`);
      edit(current);
      await files.write(nameOf(personId), `${JSON.stringify(current, null, 2)}\n`);
    });
    // The queue itself never rejects, so one refused write does not refuse every later one.
    queue = next.catch(() => {});
    return next;
  };

  return {
    root,
    files,
    read,
    put: (personId, person, connId, value) => {
      if (person.id !== personId) return Promise.reject(new Error(`person "${person.id}" cannot be stored as "${personId}"`));
      return change(personId, (c) => { c.person = person; c.connections[connId] = value; });
    },
    // The person as they signed in, their connections untouched: a file with none is still someone the runner runs for.
    remember: (person) => change(person.id, (c) => { c.person = person; }),
    remove: (personId, connId) => change(personId, (c) => { delete c.connections[connId]; }),
    pause: (person, at) => change(person.id, (c) => {
      c.person = person;
      if (at === null) delete c.paused;
      else c.paused = { at };
    }),
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

/**
 * The store as a command that only reads opens it — `validate`, `status`,
 * `next`, and a server handed none: under the key already there, asked only
 * once a file is touched, and never made.
 */
export function readingStore(root: string = defaultCredentialsRoot()): CredentialStore {
  return createCredentialStore(root, async () => (await credentialKey({ create: false })).key);
}

/** Every value a person's file holds, for the log to redact; none from a file that did not read, or was never read. */
export function credentialValues(credentials: PersonCredentials | null): string[] {
  if (credentials === null) return [];
  return Object.values(credentials.connections).flatMap((c) => [
    ...Object.values(c.fields),
    ...(c.refresh === undefined ? [] : [c.refresh.token]),
  ]);
}
