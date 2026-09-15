import { messageOf } from "../../src/runner/errors.js";

describe("messageOf", () => {
  it("returns an Error's own message", () => {
    expect(messageOf(new Error("no quota"))) .toBe("no quota");
  });

  // N1: `(e as Error).message` on a non-Error rejection does not evaluate to
  // undefined, it throws — from inside the catch block meant to describe the
  // failure. This is the exact case that must not crash: an outage is
  // precisely when a library is likely to reject with something odd.
  it("does not throw on null, and says so", () => {
    expect(() => messageOf(null)).not.toThrow();
    expect(messageOf(null)).toBe("null");
  });

  it("does not throw on a bare string rejection", () => {
    expect(messageOf("socket hang up")).toBe("socket hang up");
  });

  it("does not throw on a plain object with no message", () => {
    expect(() => messageOf({ code: "ECONNRESET" })).not.toThrow();
  });

  it("does not throw on undefined", () => {
    expect(messageOf(undefined)).toBe("undefined");
  });
});
