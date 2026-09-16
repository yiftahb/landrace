import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { Held, LockKind, LockOptions } from "../namespace.js";

const DEFAULT_DEADLINE_MS = 15 * 60_000;

// The steal gate's own critical section (below) does only a handful of local
// fs calls with no other awaits in between, so a live holder always clears it
// in milliseconds. This bounds how long a holder that crashed mid-steal can
// block stealing — the same "recoverable without waiting out the TTL"
// property the main lock has, applied to the gate itself.
const GATE_DEADLINE_MS = 5_000;

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

function makeRecord(ticket: number, kind: LockKind, opts?: LockOptions): Held {
  return {
    ticket,
    holder: opts?.holder ?? `${kind}:${process.pid}`,
    kind,
    pid: process.pid,
    at: Date.now(),
    deadlineMs: opts?.deadlineMs ?? DEFAULT_DEADLINE_MS,
  };
}

/** Plain atomic create. Succeeds only when `path` does not currently exist. */
async function createFresh(path: string, ticket: number, kind: LockKind, opts?: LockOptions): Promise<boolean> {
  try {
    const fh = await open(path, "wx");
    await fh.writeFile(JSON.stringify(makeRecord(ticket, kind, opts)));
    await fh.close();
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

/**
 * Judging a lock stale and replacing it are two separate steps, and "check
 * stale, then write" lets several racers each believe they judged the same
 * lock stale — including, wrongly, a lock that another racer already
 * replaced with a fresh one in between. This gate makes the whole
 * read-judge-replace sequence a single-writer critical section: only the
 * racer holding the gate may re-check `path` and replace it, so no chain of
 * "steal a lock that was actually just recreated" can happen. The replace
 * itself is a single atomic rename (not unlink-then-create), so `path` is
 * never observably absent in between — which would otherwise let an
 * unrelated ordinary `createFresh` slip into that gap and manufacture a
 * second winner.
 */
async function steal(ticket: number, kind: LockKind, opts?: LockOptions): Promise<boolean> {
  const path = fileOf(ticket, opts);
  const gate = `${path}.steal`;

  let fh;
  try {
    fh = await open(gate, "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    // A gate stuck past its own short deadline means its holder crashed
    // mid-steal; clear it so this ticket doesn't stay unstealable forever.
    if (stale(await read(gate))) await unlink(gate).catch(() => {});
    return false;
  }

  try {
    const gateRecord: Held = {
      ticket,
      holder: "steal-gate",
      kind,
      pid: process.pid,
      at: Date.now(),
      deadlineMs: GATE_DEADLINE_MS,
    };
    await fh.writeFile(JSON.stringify(gateRecord));

    // Fresh re-check, now that we are the only racer allowed to act: another
    // gate-holder may already have replaced the lock while we waited.
    if (!stale(await read(path))) return false;

    const staging = `${path}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(staging, JSON.stringify(makeRecord(ticket, kind, opts)));
    await rename(staging, path);
    return true;
  } finally {
    await fh.close();
    await unlink(gate).catch(() => {});
  }
}

async function tryOnce(ticket: number, kind: LockKind, opts?: LockOptions): Promise<boolean> {
  const path = fileOf(ticket, opts);
  await mkdir(dirOf(opts), { recursive: true });

  if (await createFresh(path, ticket, kind, opts)) return true;
  if (!stale(await read(path))) return false;
  return steal(ticket, kind, opts);
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
