import { durationMs } from "#conventions.js";

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
