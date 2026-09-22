import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import type { Gated, Held, LockKind, LockOptions } from "#namespace.js";
import { sandboxRoot } from "#sandbox.js";

/**
 * How long a lock may go *unrefreshed* before somebody else may take it.
 *
 * It bounds silence, not work, and the difference is the whole design. This
 * was 15 minutes of work, and nothing in the engine ever refreshed it — while
 * one converge of the shipped workflow legitimately makes eight paid
 * invocations at `budget.stepTimeout` (10m) each, so from minute 15 the next
 * tick stole the lock and a second converge drove the same ticket: the same
 * rounds paid for twice, both `--resume`-ing one agent session, and one
 * deterministic per-ticket worktree that whichever converge unwound first
 * deleted out from under the other.
 *
 * Deriving the number from the work instead — `stepTimeout × maxPasses` — is
 * the same mistake with a bigger number: five hours is not a recovery
 * mechanism, and the next workflow to raise either value silently moves it
 * again. So `withLock` says it is still working while it works (see `beat`),
 * and this is how long a record may go untouched before its holder counts as
 * gone. The purpose the deadline was written for survives intact: a crashed
 * process does not hold a ticket for longer than this, and usually not at all
 * — a dead pid is stealable at once.
 */
const DEFAULT_DEADLINE_MS = 5 * 60_000;

/**
 * A holder refreshes at a quarter of its own deadline, so three consecutive
 * missed beats — a loaded machine, a GC pause, a busy event loop — still hold
 * the lock. Derived rather than fixed so the property is the same at every
 * size: a caller that asks for a one-second deadline gets a 250ms beat and
 * behaves exactly like the five-minute default does, which is what makes this
 * testable in a second rather than in a quarter of an hour.
 */
const beatEvery = (deadlineMs: number): number => Math.max(5, Math.floor(deadlineMs / 4));

// The gate's own critical section (below) does only a handful of local fs
// calls with no other awaits in between, so a live holder always clears it in
// milliseconds. Nothing refreshes a gate record, and nothing should: unlike a
// lock, a gate that has been held for seconds is by construction one whose
// holder died mid-steal. This bounds how long that can block stealing — the
// same "recoverable without waiting out the TTL" property the main lock has,
// applied to the gate itself.
const GATE_DEADLINE_MS = 5_000;

// §7: `$TMPDIR/landrace/<repo>/locks/`. What `<repo>` is — and why it cannot
// be a directory name — is src/sandbox.ts, which the agent's worktrees share.
const dirOf = (o?: LockOptions) => join(o?.root ?? sandboxRoot(process.cwd()), "locks");
const fileOf = (ticket: number, o?: LockOptions) => join(dirOf(o), `${ticket}.lock`);

/**
 * The lock root, made on demand by *every* path into this module rather than
 * by the acquiring one alone.
 *
 * The gate below is opened with "wx", and a missing parent directory is an
 * ENOENT rather than the EEXIST that means "somebody else holds it" — so with
 * the mkdir in `tryOnce` alone, anything that took the gate without first
 * taking a lock threw `ENOENT … locks/<ticket>.lock.steal` from inside the
 * `finally` that was giving the lock back. It reads as a flake because the
 * root survives between runs: it needs a machine that has never run a tick for
 * this repository, or a `$TMPDIR` the OS has swept — and, with a converge
 * holding its lock for minutes, the sweep can land mid-hold.
 */
async function ensureRoot(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

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

/**
 * Whether this record may be taken from whoever wrote it.
 *
 * Two independent answers, and both are load-bearing. A holder whose pid is
 * gone crashed: its ticket is free immediately, which is the ordinary case and
 * the one a Ctrl-C leaves behind. A holder that has stopped refreshing is gone
 * in the way pid liveness cannot see — a crashed process whose pid the OS has
 * since handed to something unrelated, or a process wedged so hard it is no
 * longer doing the work it is holding the ticket for.
 *
 * The `||` used to defeat the liveness check, because the second clause asked
 * "has this taken too long" and a long converge answers yes while running
 * perfectly. It now asks "has this gone quiet", which a running converge
 * answers no to for as long as it runs.
 */
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
    // Per acquisition, not per process: two converges of one ticket in one
    // process — the loop deliberately lets ticks overlap — share a pid and a
    // holder string, so neither of those can tell "my lock" from "the lock
    // that replaced mine". `release` and `beat` both turn on exactly that
    // question.
    token: randomUUID(),
  };
}

/** Plain atomic create. Succeeds only when `path` does not currently exist. */
async function createFresh(path: string, ticket: number, kind: LockKind, opts?: LockOptions): Promise<Held | null> {
  const record = makeRecord(ticket, kind, opts);
  try {
    const fh = await open(path, "wx");
    await fh.writeFile(JSON.stringify(record));
    await fh.close();
    return record;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw e;
  }
}

/**
 * Judging a lock stale and replacing it are two separate steps, and "check
 * stale, then write" lets several racers each believe they judged the same
 * lock stale — including, wrongly, a lock that another racer already
 * replaced with a fresh one in between. This gate makes the whole
 * read-judge-write sequence a single-writer critical section: only the racer
 * holding the gate may re-read the record and act on what it says, so no
 * chain of "steal a lock that was actually just recreated" can happen.
 *
 * Every writer of a lock record goes through here, not only `steal`. A
 * heartbeat that read the record, lost a race to a stealer, and then renamed
 * its own copy over the top would resurrect an ownership the stealer had
 * already taken; a release that read and then unlinked would delete the
 * stealer's lock. Both are the same check-then-write, so both take the same
 * gate.
 *
 * Reports whether it ran at all, rather than folding "the gate was busy" into
 * the body's own answer: a caller that must not write blind has to be able to
 * tell the two apart, and `release` retries on it.
 */
async function withGate<T>(ticket: number, kind: LockKind, path: string, fn: () => Promise<T>): Promise<Gated<T>> {
  const gate = `${path}.steal`;
  await ensureRoot(gate);

  let fh;
  try {
    fh = await open(gate, "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    // A gate stuck past its own short deadline means its holder crashed
    // mid-steal; clear it so this ticket doesn't stay unstealable forever.
    if (stale(await read(gate))) await unlink(gate).catch(() => {});
    return { ran: false };
  }

  try {
    const gateRecord: Held = {
      ticket,
      holder: "steal-gate",
      kind,
      pid: process.pid,
      at: Date.now(),
      deadlineMs: GATE_DEADLINE_MS,
      token: randomUUID(),
    };
    await fh.writeFile(JSON.stringify(gateRecord));
    return { ran: true, value: await fn() };
  } finally {
    await fh.close();
    await unlink(gate).catch(() => {});
  }
}

/**
 * A single atomic rename, never unlink-then-create, so `path` is never
 * observably absent in between — which would otherwise let an unrelated
 * ordinary `createFresh` slip into the gap and manufacture a second winner.
 */
async function replace(path: string, record: Held): Promise<Held> {
  const staging = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(staging, JSON.stringify(record));
  await rename(staging, path);
  return record;
}

async function steal(ticket: number, kind: LockKind, opts?: LockOptions): Promise<Held | null> {
  const path = fileOf(ticket, opts);
  const gated = await withGate(ticket, kind, path, async () => {
    // Fresh re-read, now that we are the only racer allowed to act: another
    // gate-holder may already have replaced the lock while we waited.
    if (!stale(await read(path))) return null;
    return replace(path, makeRecord(ticket, kind, opts));
  });
  return gated.ran ? gated.value : null;
}

/**
 * Say that this lease's holder is still working.
 *
 * Only ever refreshes a record this lease still owns: a holder that has
 * already been taken from must not write itself back in, or the steal it lost
 * would silently undo itself. A beat that finds the gate busy just skips —
 * three more are due before the deadline, which is what the quarter in
 * `beatEvery` buys.
 */
async function beat(ticket: number, lease: Held, opts?: LockOptions): Promise<void> {
  const path = fileOf(ticket, opts);
  await withGate(ticket, lease.kind, path, async () => {
    const current = await read(path);
    if (current?.token !== lease.token) return;
    await replace(path, { ...lease, at: Date.now() });
  });
}

async function tryOnce(ticket: number, kind: LockKind, opts?: LockOptions): Promise<Held | null> {
  const path = fileOf(ticket, opts);
  await ensureRoot(path);

  const fresh = await createFresh(path, ticket, kind, opts);
  if (fresh) return fresh;
  if (!stale(await read(path))) return null;
  return steal(ticket, kind, opts);
}

/**
 * The lock as this caller holds it, or null. The token on the record is the
 * caller's proof that the lock on disk is still the one it took, which is
 * what `release` refuses to unlink without.
 */
async function take(ticket: number, kind: LockKind, opts?: LockOptions): Promise<Held | null> {
  const deadline = Date.now() + (opts?.waitMs ?? 0);
  for (;;) {
    const lease = await tryOnce(ticket, kind, opts);
    if (lease) return lease;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * The loop passes no waitMs and skips a busy ticket — it will still be there
 * next tick. An interactive caller waits a moment, because losing a race to a
 * 200ms label write should not fail a person's request.
 *
 * Takes the lock and does not refresh it: a bare `acquire` is a caller that
 * holds its own bookkeeping, and this is the primitive `withLock` is built
 * from rather than a second way to run work under a lock.
 */
export const acquire = async (ticket: number, kind: LockKind, opts?: LockOptions): Promise<boolean> =>
  (await take(ticket, kind, opts)) !== null;

/**
 * Give the lock up — but only if it is still ours.
 *
 * This used to unlink whatever was at the path, with no check at all, so a
 * holder that had already lost its lock deleted its successor's on the way
 * out and the ticket ended up held by nobody while two converges ran. With a
 * `lease` the question is exact: the token on disk is either the one we wrote
 * or somebody else's. Without one — the direct `acquire`/`release` pairing
 * tests use — the pid is the best available answer, and it is still strictly
 * better than none: another process's lock is never removed.
 */
export async function release(ticket: number, opts?: LockOptions, lease?: Held): Promise<void> {
  const path = fileOf(ticket, opts);
  const kind = lease?.kind ?? "tick";
  // Retried, because the gate being busy means some other writer is mid-steal
  // and giving up silently would leave our own record behind to be waited out.
  for (let attempt = 0; attempt < 5; attempt++) {
    const gated = await withGate(ticket, kind, path, async () => {
      const current = await read(path);
      if (!current) return;
      const ours = lease ? current.token === lease.token : current.pid === process.pid;
      if (ours) await unlink(path).catch(() => undefined);
    });
    if (gated.ran) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

export async function withLock<T>(
  ticket: number,
  kind: LockKind,
  fn: () => Promise<T>,
  opts?: LockOptions,
): Promise<T> {
  const lease = await take(ticket, kind, opts);
  if (!lease) {
    const by = await held(ticket, opts);
    const err = new Error(`#${ticket} is locked by ${by?.holder ?? "another process"}`) as Error & { code: string };
    err.code = "ELOCKED";
    throw err;
  }

  // Serialised rather than fired in parallel, and awaited before the release
  // below: a beat still inside the gate when release asks for it would make
  // release retry, or at worst leave a released lock on disk to be waited out.
  let beating: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    beating = beating.then(() => beat(ticket, lease, opts)).catch(() => undefined);
  }, beatEvery(lease.deadlineMs));
  // A lock never keeps the process alive. The work does.
  timer.unref();

  try {
    return await fn();
  } finally {
    clearInterval(timer);
    await beating;
    await release(ticket, opts, lease);
  }
}
