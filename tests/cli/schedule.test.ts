import { createSchedule } from "#cli/start.js";

/** A run() whose resolution the test controls, to pin manual-tick overlap. */
function deferredRun(): { run: () => Promise<void>; calls: number; resolve: () => void } {
  let resolveFn: () => void = () => {};
  let calls = 0;
  const state = {
    calls: 0,
    resolve: () => resolveFn(),
    run: (): Promise<void> => {
      calls += 1;
      state.calls = calls;
      return new Promise<void>((resolve) => {
        resolveFn = resolve;
      });
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

  it("trigger() runs immediately and moves nextAt() to triggerTime + intervalMs", () => {
    let now = 0;
    const run = jest.fn(async () => {});
    const schedule = createSchedule({ intervalMs: 1000, run, now: () => now });
    schedule.start();
    now = 300;
    const ok = schedule.trigger();
    expect(ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    expect(schedule.nextAt()).toBe(1300);
  });

  it("a second trigger() while the first manual tick is unresolved returns false and runs nothing", async () => {
    const deferred = deferredRun();
    const schedule = createSchedule({ intervalMs: 1000, run: deferred.run });
    schedule.start();
    expect(deferred.calls).toBe(1);

    const first = schedule.trigger();
    expect(first).toBe(true);
    expect(deferred.calls).toBe(2);

    const second = schedule.trigger();
    expect(second).toBe(false);
    expect(deferred.calls).toBe(2);
  });

  it("after the manual tick resolves, trigger() works again", async () => {
    const deferred = deferredRun();
    const schedule = createSchedule({ intervalMs: 1000, run: deferred.run });
    schedule.start();
    schedule.trigger();
    expect(deferred.calls).toBe(2);

    deferred.resolve();
    // Let the trigger's promise settle before asking again.
    await Promise.resolve();
    await Promise.resolve();

    const third = schedule.trigger();
    expect(third).toBe(true);
    expect(deferred.calls).toBe(3);
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

  it("a scheduled tick still fires while a manual one is in flight", async () => {
    const deferred = deferredRun();
    const schedule = createSchedule({ intervalMs: 1000, run: deferred.run });
    schedule.start();
    schedule.trigger();
    expect(deferred.calls).toBe(2);

    // The manual tick moved nextAt to 1000 (triggerTime 0 + interval); advance
    // to it while the manual run is still unresolved.
    jest.advanceTimersByTime(1000);
    expect(deferred.calls).toBe(3);
  });

  /**
   * The bug a review caught: trigger() never checked whether stop() had
   * already run, so a click on the page during shutdown re-armed a schedule
   * the daemon believed it had already torn down — a stray setTimeout that
   * held the process open until a second Ctrl-C.
   */
  it("trigger() after stop() runs nothing, returns false, and nextAt stays null", () => {
    const run = jest.fn(async () => {});
    const schedule = createSchedule({ intervalMs: 1000, run });
    schedule.start();
    schedule.stop();
    run.mockClear();

    expect(schedule.trigger()).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(schedule.nextAt()).toBeNull();
  });

  it("no timer is left pending after stop(), even when trigger() is called afterwards", () => {
    const schedule = createSchedule({ intervalMs: 1000, run: async () => {} });
    schedule.start();
    schedule.stop();
    schedule.trigger();
    expect(jest.getTimerCount()).toBe(0);
  });
});
