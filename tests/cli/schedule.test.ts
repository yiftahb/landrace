import { createSchedule } from "#cli/start.js";

/** Let the schedule see a run that just settled. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/**
 * A run() whose resolution the test controls, counting how many are in
 * flight at once, to pin that a wake never starts a tick beside another.
 */
function deferredRun(): { run: () => Promise<void>; calls: number; maxActive: number; settle: () => Promise<void> } {
  const open: Array<() => void> = [];
  let active = 0;
  const state = {
    calls: 0,
    maxActive: 0,
    run: (): Promise<void> => {
      state.calls += 1;
      active += 1;
      state.maxActive = Math.max(state.maxActive, active);
      return new Promise<void>((resolve) => open.push(() => {
        active -= 1;
        resolve();
      }));
    },
    /** Settle the oldest run still in flight. */
    settle: async (): Promise<void> => {
      open.shift()?.();
      await flush();
    },
  };
  return state;
}

describe("createSchedule", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("runs once on start", () => {
    const run = jest.fn(async () => {});
    createSchedule({ intervalMs: 1000, run }).start();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("fires again at intervalMs", () => {
    const run = jest.fn(async () => {});
    createSchedule({ intervalMs: 1000, run }).start();
    jest.advanceTimersByTime(1000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("nextAt() equals start + intervalMs and advances", () => {
    let now = 5000;
    const schedule = createSchedule({ intervalMs: 1000, run: async () => {}, now: () => now });
    schedule.start();
    expect(schedule.nextAt()).toBe(6000);
    now = 6000;
    jest.advanceTimersByTime(1000);
    expect(schedule.nextAt()).toBe(7000);
  });

  it("an idle wake runs at once, answers started, and restarts the countdown from now", async () => {
    let now = 0;
    const run = jest.fn(async () => {});
    const schedule = createSchedule({ intervalMs: 1000, run, now: () => now });
    schedule.start();
    await flush();

    now = 300;
    jest.advanceTimersByTime(300);
    expect(schedule.wake()).toBe("started");
    expect(run).toHaveBeenCalledTimes(2);
    expect(schedule.nextAt()).toBe(1300);

    // The countdown armed at start is gone, not left to fire beside the new one.
    jest.advanceTimersByTime(700);
    expect(run).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(300);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("wakes during a woken run queue, and give one follow-up once it settles, never beside it", async () => {
    let now = 0;
    const deferred = deferredRun();
    const schedule = createSchedule({ intervalMs: 1000, run: deferred.run, now: () => now });
    schedule.start();
    await deferred.settle();
    expect(schedule.wake()).toBe("started");
    expect(deferred.calls).toBe(2);

    expect([schedule.wake(), schedule.wake(), schedule.wake()]).toEqual(["queued", "queued", "queued"]);
    expect(deferred.calls).toBe(2);

    now = 400;
    await deferred.settle();
    expect(deferred.calls).toBe(3);
    expect(schedule.nextAt()).toBe(1400);

    await deferred.settle();
    expect(deferred.calls).toBe(3);
    expect(deferred.maxActive).toBe(1);
  });

  it("a wake during a scheduled tick queues rather than overlapping it", async () => {
    const deferred = deferredRun();
    const schedule = createSchedule({ intervalMs: 1000, run: deferred.run });
    schedule.start();
    await deferred.settle();
    jest.advanceTimersByTime(1000);
    expect(deferred.calls).toBe(2);

    expect(schedule.wake()).toBe("queued");
    expect(deferred.calls).toBe(2);

    await deferred.settle();
    expect(deferred.calls).toBe(3);
    expect(deferred.maxActive).toBe(1);
  });

  it("a queued follow-up does not run when stop() comes before the run settles", async () => {
    const deferred = deferredRun();
    const schedule = createSchedule({ intervalMs: 1000, run: deferred.run });
    schedule.start();
    expect(schedule.wake()).toBe("queued");
    schedule.stop();

    await deferred.settle();
    expect(deferred.calls).toBe(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("stop() makes nextAt() null and no further tick fires", () => {
    const run = jest.fn(async () => {});
    const schedule = createSchedule({ intervalMs: 1000, run });
    schedule.start();
    schedule.stop();
    expect(schedule.nextAt()).toBeNull();
    jest.advanceTimersByTime(5000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("a scheduled tick still fires while a woken one is in flight", async () => {
    const deferred = deferredRun();
    const schedule = createSchedule({ intervalMs: 1000, run: deferred.run });
    schedule.start();
    await deferred.settle();
    expect(schedule.wake()).toBe("started");
    expect(deferred.calls).toBe(2);

    // The wake moved nextAt to 1000 (wake time 0 + interval); advance to it
    // while the woken run is still unresolved.
    jest.advanceTimersByTime(1000);
    expect(deferred.calls).toBe(3);
  });

  /**
   * The bug a review caught: the manual tick never checked whether stop() had
   * already run, so a click on the page during shutdown re-armed a schedule
   * the daemon believed it had already torn down — a stray setTimeout that
   * held the process open until a second Ctrl-C.
   */
  it("a wake after stop() answers stopped, runs nothing, and arms no timer", () => {
    const run = jest.fn(async () => {});
    const schedule = createSchedule({ intervalMs: 1000, run });
    schedule.start();
    schedule.stop();
    run.mockClear();

    expect(schedule.wake()).toBe("stopped");
    expect(run).not.toHaveBeenCalled();
    expect(schedule.nextAt()).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });
});
