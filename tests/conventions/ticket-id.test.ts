import { compareIds, isTicketId, ticketIdProblem } from "#conventions.js";

describe("ticket ids", () => {
  it.each(["1", "42", "PROJ-7", "abc_def", "a.b", "A1-b2_c3.d4"])("accepts %s", (id) => {
    expect(isTicketId(id)).toBe(true);
    expect(ticketIdProblem(id)).toBeNull();
  });

  it.each([
    ["", "empty"],
    ["../etc", "path"],
    ["a/b", "path"],
    [".hidden", "leading dot"],
    ["-flag", "leading dash"],
    ["x y", "space"],
    ["a&b", "url metacharacter"],
    ["__proto__", "reserved"],
    ["x".repeat(65), "too long"],
  ])("refuses %j (%s)", (id) => {
    expect(isTicketId(id)).toBe(false);
    expect(ticketIdProblem(id)).toMatch(/ticket id/);
  });

  it("refuses non-strings, naming the type", () => {
    expect(isTicketId(42)).toBe(false);
    expect(ticketIdProblem(42)).toMatch(/number/);
    expect(ticketIdProblem(undefined)).toMatch(/undefined/);
  });

  it("orders numeric ids by value, not by character", () => {
    expect(["10", "9", "100", "1"].sort(compareIds)).toEqual(["1", "9", "10", "100"]);
  });

  it("orders mixed ids totally and deterministically", () => {
    expect(["PROJ-10", "PROJ-9", "ABC-1"].sort(compareIds)).toEqual(["ABC-1", "PROJ-9", "PROJ-10"]);
    expect(compareIds("7", "7")).toBe(0);
  });
});
