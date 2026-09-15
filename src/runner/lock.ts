import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export type LockKind = "tick" | "conversation" | "execution";

export interface Held {
  ticket: number;
  holder: string;
  kind: LockKind;
  pid: number;
  at: number;
  deadlineMs: number;
}

export interface LockOptions {
  holder?: string;
  /** How long this work may reasonably take before the lock is stealable. */
  deadlineMs?: number;
  /** Wait this long for a holder to finish before giving up. */
  waitMs?: number;
  root?: string;
}

const DEFAULT_DEADLINE_MS = 15 * 60_000;

// Resolved up front: git and the OS report /var as /private/var on macOS, and a
// path comparison against an unresolved tmpdir silently never matches.
const defaultRoot = (): string => join(realpathSync(tmpdir()), "landrace", basename(process.cwd()));

const dirOf = (o?: LockOptions) => join(o?.root ?? defaultRoot(), "locks");
const fileOf = (ticket: number, o?: LockOptions) => join(dirOf(o), `${ticket}.lock`);

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function read(path: string): Promise<Held | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Held;
  } catch {
    return null;
  }
}

const stale = (h: Held | null): boolean =>
  !h || Date.now() - h.at > h.deadlineMs || (h.pid !== process.pid && !alive(h.pid));

/** The live holder, or null when the lock is free or stealable. */
export async function held(ticket: number, opts?: LockOptions): Promise<Held | null> {
  const h = await read(fileOf(ticket, opts));
  return stale(h) ? null : h;
}

async function tryOnce(ticket: number, kind: LockKind, opts?: LockOptions): Promise<boolean> {
  const path = fileOf(ticket, opts);
  await mkdir(dirOf(opts), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(path, "wx");
      const record: Held = {
        ticket,
        holder: opts?.holder ?? `${kind}:${process.pid}`,
        kind,
        pid: process.pid,
        at: Date.now(),
        deadlineMs: opts?.deadlineMs ?? DEFAULT_DEADLINE_MS,
      };
      await fh.writeFile(JSON.stringify(record));
      await fh.close();
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (!stale(await read(path))) return false;
      await unlink(path).catch(() => {});
    }
  }
  return false;
}

/**
 * The loop passes no waitMs and skips a busy ticket — it will still be there
 * next tick. An interactive caller waits a moment, because losing a race to a
 * 200ms label write should not fail a person's request.
 */
export async function acquire(ticket: number, kind: LockKind, opts?: LockOptions): Promise<boolean> {
  const deadline = Date.now() + (opts?.waitMs ?? 0);
  for (;;) {
    if (await tryOnce(ticket, kind, opts)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

export const release = (ticket: number, opts?: LockOptions): Promise<void> =>
  unlink(fileOf(ticket, opts)).then(
    () => undefined,
    () => undefined,
  );

export async function withLock<T>(
  ticket: number,
  kind: LockKind,
  fn: () => Promise<T>,
  opts?: LockOptions,
): Promise<T> {
  if (!(await acquire(ticket, kind, opts))) {
    const by = await held(ticket, opts);
    const err = new Error(`#${ticket} is locked by ${by?.holder ?? "another process"}`) as Error & { code: string };
    err.code = "ELOCKED";
    throw err;
  }
  try {
    return await fn();
  } finally {
    await release(ticket, opts);
  }
}
