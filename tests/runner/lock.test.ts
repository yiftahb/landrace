import { mkdtemp, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquire, held, release, withLock } from "../../src/runner/lock.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "lr-lock-")); });
const opts = () => ({ root });

describe("lock", () => {
  it("lets one holder in at a time", async () => {
    expect(await acquire(1, "tick", { ...opts(), holder: "tick:1" })).toBe(true);
    expect(await acquire(1, "conversation", { ...opts(), holder: "mcp:1" })).toBe(false);
    expect((await held(1, opts()))?.holder).toBe("tick:1");
  });

  it("frees the ticket on release", async () => {
    await acquire(2, "tick", opts());
    await release(2, opts());
    expect(await held(2, opts())).toBeNull();
    expect(await acquire(2, "conversation", opts())).toBe(true);
  });

  it("locks each ticket independently", async () => {
    await acquire(3, "tick", opts());
    expect(await acquire(4, "tick", opts())).toBe(true);
  });

  it("reports who holds it, so a tool can say more than 'locked'", async () => {
    await acquire(5, "execution", { ...opts(), holder: "tick:code-review" });
    expect(await held(5, opts())).toMatchObject({ holder: "tick:code-review", kind: "execution" });
  });

  it("steals a lock whose holder is gone", async () => {
    await mkdir(join(root, "locks"), { recursive: true });
    // 2^22 is above the maximum pid on macOS and Linux, so it cannot be running.
    await writeFile(
      join(root, "locks", "6.lock"),
      JSON.stringify({ ticket: 6, holder: "ghost", kind: "tick", pid: 4194304, at: Date.now(), deadlineMs: 60000 }),
    );
    expect(await held(6, opts())).toBeNull();
    expect(await acquire(6, "tick", opts())).toBe(true);
  });

  it("steals a lock past its deadline", async () => {
    await acquire(7, "tick", { ...opts(), deadlineMs: 1 });
    await new Promise((r) => setTimeout(r, 5));
    expect(await acquire(7, "conversation", opts())).toBe(true);
  });

  it("waits briefly rather than failing a short race", async () => {
    await acquire(8, "tick", { ...opts(), deadlineMs: 60_000 });
    setTimeout(() => void release(8, opts()), 30);
    expect(await acquire(8, "conversation", { ...opts(), waitMs: 500 })).toBe(true);
  });

  it("withLock refuses with ELOCKED and does not run the body", async () => {
    await acquire(9, "conversation", opts());
    let ran = false;
    await expect(
      withLock(9, "tick", async () => { ran = true; }, opts()),
    ).rejects.toMatchObject({ code: "ELOCKED" });
    expect(ran).toBe(false);
  });

  it("withLock releases even when the body throws", async () => {
    await expect(
      withLock(10, "tick", async () => { throw new Error("boom"); }, opts()),
    ).rejects.toThrow("boom");
    expect(await held(10, opts())).toBeNull();
  });
});

// The steal path is check-then-write (read → judge stale → unlink → recreate).
// A sequential test can't see two racers interleave between the read and the
// unlink; only concurrent acquires reproduce the corruption where several
// racers all judge the same lock stale and all believe they won it.
describe("concurrent racers", () => {
  it("lets exactly one of many concurrent acquires win an unheld lock", async () => {
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => acquire(50, "tick", { ...opts(), holder: `r${i}` })),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("lets exactly one of many concurrent acquires win a lock past its deadline", async () => {
    await mkdir(join(root, "locks"), { recursive: true });
    await writeFile(
      join(root, "locks", "51.lock"),
      JSON.stringify({
        ticket: 51,
        holder: "stale-holder",
        kind: "tick",
        pid: process.pid,
        at: Date.now() - 100_000,
        deadlineMs: 1,
      }),
    );
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => acquire(51, "tick", { ...opts(), holder: `r${i}` })),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("lets exactly one of many concurrent acquires win a lock held by a dead pid", async () => {
    await mkdir(join(root, "locks"), { recursive: true });
    // 2^22 is above the maximum pid on macOS and Linux, so it cannot be running.
    await writeFile(
      join(root, "locks", "52.lock"),
      JSON.stringify({ ticket: 52, holder: "ghost", kind: "tick", pid: 4194304, at: Date.now(), deadlineMs: 60_000 }),
    );
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => acquire(52, "tick", { ...opts(), holder: `r${i}` })),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("leaves exactly one lock file behind after a stale-lock race, and held() names the winner", async () => {
    await mkdir(join(root, "locks"), { recursive: true });
    await writeFile(
      join(root, "locks", "53.lock"),
      JSON.stringify({
        ticket: 53,
        holder: "stale-holder",
        kind: "tick",
        pid: process.pid,
        at: Date.now() - 100_000,
        deadlineMs: 1,
      }),
    );
    const holders = Array.from({ length: 30 }, (_, i) => `r${i}`);
    const results = await Promise.all(holders.map((holder) => acquire(53, "tick", { ...opts(), holder })));
    expect(results.filter(Boolean)).toHaveLength(1);

    const winnerIdx = results.findIndex(Boolean);
    const files = (await readdir(join(root, "locks"))).filter((f) => f.startsWith("53"));
    expect(files).toEqual(["53.lock"]);

    const winner = holders[winnerIdx];
    expect((await held(53, opts()))?.holder).toBe(winner);
  });
});
