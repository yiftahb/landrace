import { durationMs, workDurationMs } from "#conventions.js";

/*
 * One spelling of a duration for every file an operator writes — tick.interval,
 * budget.stepTimeout and a step's own timeout — so a value that reads right in
 * one place cannot mean something else in another.
 */
describe("durationMs", () => {
  it("reads seconds, minutes and hours", () => {
    expect([durationMs("30s"), durationMs("2m"), durationMs("120m"), durationMs("1h")])
      .toEqual([30_000, 120_000, 7_200_000, 3_600_000]);
  });

  /*
   * Every one of these ends up in a setTimeout, which holds at most 2^31-1 ms
   * (about 24.8 days) and fires almost at once for anything longer: a stray
   * digit would kill every agent the moment it started.
   */
  it("reads nothing a timer cannot hold", () => {
    expect(durationMs("596h")).toBe(2_145_600_000);
    for (const long of ["597h", "999999h", "99999999999s"]) expect(durationMs(long)).toBeNull();
  });

  it("reads nothing else, rather than guessing a unit", () => {
    for (const bad of ["60", "", "2 m", "0.5m", "2d", "-1s", "s"]) expect(durationMs(bad)).toBeNull();
  });
});

/*
 * Time a step says it spent, as a worklog takes it: hours and minutes, the
 * way a person types it into Jira's own "Log work" box.
 */
describe("workDurationMs", () => {
  it("reads hours, minutes, and both", () => {
    expect([workDurationMs("45m"), workDurationMs("2h"), workDurationMs("1h30m"), workDurationMs(" 1h 30m ")])
      .toEqual([2_700_000, 7_200_000, 5_400_000, 5_400_000]);
  });

  it("reads zero as zero, for the caller to refuse in its own words", () => {
    expect(workDurationMs("0m")).toBe(0);
  });

  it("reads nothing else, rather than guessing", () => {
    for (const bad of ["soon", "", "90", "1.5h", "30s", "1d", "-1h", "m", "1h1h", "30m1h"]) expect(workDurationMs(bad)).toBeNull();
  });
});
