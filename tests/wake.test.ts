import { existsSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { touchWake, watchWake } from "#wake.js";

/** Poll for `cond`, failing after `ms`: the watcher runs on a real clock. */
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Back-date a file, so a touch in the same millisecond as its creation still reads as newer. */
const age = (path: string) => utimesSync(path, new Date(1_000_000), new Date(1_000_000));

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "lr-wake-")); });

describe("touchWake", () => {
  it("creates the root and the file when neither exists yet", () => {
    const path = join(dir, "landrace", "repo-0123", "wake");
    touchWake(path);
    expect(existsSync(path)).toBe(true);
  });

  it("bumps the file's mtime when it is touched again", () => {
    const path = join(dir, "wake");
    touchWake(path);
    age(path);
    const before = statSync(path).mtimeMs;
    touchWake(path);
    expect(statSync(path).mtimeMs).toBeGreaterThan(before);
  });
});

describe("watchWake", () => {
  it("wakes when the file is touched", async () => {
    const path = join(dir, "wake");
    writeFileSync(path, "");
    age(path);
    const wake = jest.fn();
    const unwatch = watchWake(path, wake, 20);
    try {
      await sleep(60);
      expect(wake).not.toHaveBeenCalled();
      touchWake(path);
      await until(() => wake.mock.calls.length > 0);
    } finally {
      unwatch();
    }
  });

  it("wakes when the file is created after the watch started", async () => {
    const path = join(dir, "later", "wake");
    const wake = jest.fn();
    const unwatch = watchWake(path, wake, 20);
    try {
      await sleep(60);
      touchWake(path);
      await until(() => wake.mock.calls.length > 0);
    } finally {
      unwatch();
    }
  });

  it("does not wake once unwatched", async () => {
    const path = join(dir, "wake");
    const wake = jest.fn();
    const unwatch = watchWake(path, wake, 20);
    await sleep(60);
    unwatch();
    touchWake(path);
    await sleep(150);
    expect(wake).not.toHaveBeenCalled();
  });
});
