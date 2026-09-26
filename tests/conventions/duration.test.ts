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

  it("reads nothing else, rather than guessing a unit", () => {
    for (const bad of ["60", "", "2 m", "0.5m", "2d", "-1s", "s"]) expect(durationMs(bad)).toBeNull();
  });
});
